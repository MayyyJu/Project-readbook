// app.js - Main Application Logic, State Machine, and UI Controller for FocusDock

function formatSecondsToMinSec(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s} วินาที`;
  if (s === 0) return `${m} นาที`;
  return `${m} นาที ${s} วินาที`;
}

class FocusDockApp {
  constructor() {
    // 1. Real Data Management (No Mock Data)
    this.pickups = this.loadStoredPickups() || [];
    this.weeklyData = [];
    this.sessions = [];
    this.calculateWeeklyStats();

    // 2. Settings
    this.settings = this.loadSettings();

    // 3. State
    this.activeTab = 'tabTimer';
    this.activeMode = 'study'; // 'study' | 'detox'
    this.timerStatus = 'idle'; // 'idle' | 'running' | 'paused' | 'break'
    this.currentPhase = 'study'; // 'study' | 'break'
    this.pomodoroCycle = 1;
    this.totalPhaseSeconds = this.settings.studyMinutes * 60;
    this.remainingSeconds = this.totalPhaseSeconds;
    this.timerInterval = null;

    // 4. Hardware Pickup State
    this.isPhonePickedUp = false;
    this.pickupStartTime = null;
    this.liveHoldingSeconds = 0;
    this.liveHoldingInterval = null;

    // 5. Analytics UI State
    this.selectedChartMetric = 'count'; // 'count' | 'minutes'
    this.selectedChartDayIndex = 6; // today (last item)

    // 6. Sound Synthesis using Web Audio API
    this.audioCtx = null;

    // Initialize
    this.initDOM();
    this.bindEvents();
    this.updateClock();
    this.setupFirebaseListener();
    this.renderPresets();
    this.renderHistory('all');
    this.renderWeeklyStats();
    this.updatePickupStatusUI();
    this.updateTimerDisplay();

    // Clock ticker
    setInterval(() => this.updateClock(), 1000);
  }

  // Audio effects synthesizer (zero external dependencies)
  playSound(type) {
    if (!this.settings.soundAlert) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const ctx = this.audioCtx;
      const now = ctx.currentTime;

      if (type === 'bell') {
        // Calming meditation singing bowl chime
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(528, now); // 528Hz Solfeggio frequency
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.8);
      } else if (type === 'alert') {
        // Gentle warm alert when phone is lifted
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(370, now + 0.12);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'click') {
        // Subtle haptic click
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      }
    } catch (e) {
      console.warn('Audio playback error:', e);
    }
  }

  // Load Settings from LocalStorage
  loadSettings() {
    try {
      const saved = localStorage.getItem('focusdock_settings');
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn(e);
    }
    return {
      studyMinutes: 25,
      breakMinutes: 5,
      detoxMinutes: 45,
      soundAlert: true,
      vibrationAlert: true
    };
  }

  saveSettings() {
    localStorage.setItem('focusdock_settings', JSON.stringify(this.settings));
    const modeNum = this.activeMode === 'study' ? 1 : 2;
    const durationSec = (this.activeMode === 'study' ? this.settings.studyMinutes : this.settings.detoxMinutes) * 60;
    if (window.focusDockFirebase) {
      window.focusDockFirebase.updateConfig(modeNum, durationSec);
      if (typeof window.focusDockFirebase.updateSettings === 'function') {
        window.focusDockFirebase.updateSettings(this.settings);
      }
    }
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectSettings(this.settings);
    }
  }

  loadStoredPickups() {
    try {
      const saved = localStorage.getItem('focusdock_pickups');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return null;
  }

  saveStoredPickups() {
    localStorage.setItem('focusdock_pickups', JSON.stringify(this.pickups));
  }

  // Calculate real 7-day statistics ending today (100% dynamic from real hardware logs)
  calculateWeeklyStats() {
    const today = new Date();
    const dayNamesThai = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const dayShortThai = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
    const days = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const dayPickups = (this.pickups || []).filter((p) => p.date === dateStr);
      const count = dayPickups.length;
      const totalSec = dayPickups.reduce((acc, curr) => acc + (Number(curr.durationSeconds) || Number(curr.durationSec) || 0), 0);
      const totalMin = Math.round(totalSec / 60);
      const avgMin = count > 0 ? Number(((totalSec / count) / 60).toFixed(1)) : 0;

      days.push({
        date: dateStr,
        dayFull: dayNamesThai[d.getDay()],
        dayShort: dayShortThai[d.getDay()],
        pickupsCount: count,
        totalSeconds: totalSec,
        totalMinutes: totalMin,
        avgMinutesPerPickup: avgMin,
        isToday: i === 0
      });
    }

    this.weeklyData = days;
  }

  // DOM Selection
  initDOM() {
    // Navigation
    this.navTabs = document.querySelectorAll('.nav-tab-item');
    this.tabScreens = document.querySelectorAll('.tab-screen');
    this.btnToggleFrame = document.getElementById('btnToggleFrame');
    this.appFrame = document.getElementById('appFrame');

    // Header Status
    this.statusBarClock = document.getElementById('statusBarClock');
    this.statusDot = document.getElementById('statusDot');
    this.statusLabel = document.getElementById('statusLabel');
    this.btnHeaderStatus = document.getElementById('btnHeaderStatus');

    // Mode Bar
    this.modeBtnStudy = document.getElementById('modeBtnStudy');
    this.modeBtnDetox = document.getElementById('modeBtnDetox');

    // Live Pickup Card
    this.pickupStatusCard = document.getElementById('pickupStatusCard');
    this.pickupBadge = document.getElementById('pickupBadge');
    this.pickupBadgeText = document.getElementById('pickupBadgeText');
    this.pickupStatusTitle = document.getElementById('pickupStatusTitle');
    this.pickupStatusDesc = document.getElementById('pickupStatusDesc');
    this.liveHoldingTimerWrap = document.getElementById('liveHoldingTimerWrap');
    this.liveHoldingTimer = document.getElementById('liveHoldingTimer');
    this.todayPickupsCount = document.getElementById('todayPickupsCount');
    this.todayPickupDuration = document.getElementById('todayPickupDuration');

    // Timer Card
    this.phaseChip = document.getElementById('phaseChip');
    this.phaseIcon = document.getElementById('phaseIcon');
    this.phaseLabel = document.getElementById('phaseLabel');
    this.circleProgressBar = document.getElementById('circleProgressBar');
    this.timerDisplay = document.getElementById('timerDisplay');
    this.timerCaption = document.getElementById('timerCaption');
    this.pomodoroDots = document.getElementById('pomodoroDots');

    // Control buttons
    this.btnMainAction = document.getElementById('btnMainAction');
    this.btnMainActionIcon = document.getElementById('btnMainActionIcon');
    this.btnMainActionText = document.getElementById('btnMainActionText');
    this.btnPauseAction = document.getElementById('btnPauseAction');
    this.btnResetAction = document.getElementById('btnResetAction');
    this.btnGoSettings = document.getElementById('btnGoSettings');

    // Presets
    this.presetPillsContainer = document.getElementById('presetPillsContainer');

    // History
    this.filterChips = document.querySelectorAll('.filter-chip');
    this.pickupTimelineContainer = document.getElementById('pickupTimelineContainer');

    // Stats
    this.kpiWeeklyTotalCount = document.getElementById('kpiWeeklyTotalCount');
    this.kpiWeeklyAvgDuration = document.getElementById('kpiWeeklyAvgDuration');
    this.kpiWeeklyTotalTime = document.getElementById('kpiWeeklyTotalTime');
    this.barChartContainer = document.getElementById('barChartContainer');
    this.btnMetricCount = document.getElementById('btnMetricCount');
    this.btnMetricMinutes = document.getElementById('btnMetricMinutes');
    this.detailDayTitle = document.getElementById('detailDayTitle');
    this.detailDayPickups = document.getElementById('detailDayPickups');
    this.detailDayAvg = document.getElementById('detailDayAvg');
    this.detailDayTotal = document.getElementById('detailDayTotal');

    // Settings inputs
    this.inputStudyMinutes = document.getElementById('inputStudyMinutes');
    this.inputBreakMinutes = document.getElementById('inputBreakMinutes');
    this.inputDetoxMinutes = document.getElementById('inputDetoxMinutes');
    this.btnSaveModeSettings = document.getElementById('btnSaveModeSettings');

    // Firebase inputs
    this.cfgDatabaseUrl = document.getElementById('cfgDatabaseUrl');
    this.cfgUserEmail = document.getElementById('cfgUserEmail');
    this.cfgApiKey = document.getElementById('cfgApiKey');
    this.cfgProjectId = document.getElementById('cfgProjectId');
    this.cfgDeviceNode = document.getElementById('cfgDeviceNode');
    this.btnSaveFirebaseConfig = document.getElementById('btnSaveFirebaseConfig');

    // Ambient Environment Sensors (from ESP32)
    this.envSensorCard = document.getElementById('envSensorCard');
    this.envStatusBadge = document.getElementById('envStatusBadge');
    this.envTemp = document.getElementById('envTemp');
    this.envHum = document.getElementById('envHum');
    this.envRoomLux = document.getElementById('envRoomLux');
    this.envHandStatus = document.getElementById('envHandStatus');

    // Direct ESP32 Connection elements
    this.btnConnectBle = document.getElementById('btnConnectBle');
    this.btnConnectBleIcon = document.getElementById('btnConnectBleIcon');
    this.btnConnectBleText = document.getElementById('btnConnectBleText');
    this.bleStatusBadge = document.getElementById('bleStatusBadge');

    this.cfgEsp32Ip = document.getElementById('cfgEsp32Ip');
    this.btnTestEsp32Ip = document.getElementById('btnTestEsp32Ip');
    this.ipStatusBadge = document.getElementById('ipStatusBadge');

    if (window.esp32Direct && this.cfgEsp32Ip) {
      this.cfgEsp32Ip.value = window.esp32Direct.esp32Ip || '';
    }

    // Toast
    this.toastNotice = document.getElementById('toastNotice');
    this.toastIcon = document.getElementById('toastIcon');
    this.toastMessage = document.getElementById('toastMessage');

    // Fill settings inputs with current values
    if (this.inputStudyMinutes) this.inputStudyMinutes.value = this.settings.studyMinutes;
    if (this.inputBreakMinutes) this.inputBreakMinutes.value = this.settings.breakMinutes;
    if (this.inputDetoxMinutes) this.inputDetoxMinutes.value = this.settings.detoxMinutes;

    // Fill Firebase credentials if saved
    if (window.focusDockFirebase && window.focusDockFirebase.config) {
      const fbCfg = window.focusDockFirebase.config;
      if (this.cfgDatabaseUrl && fbCfg.databaseURL) this.cfgDatabaseUrl.value = fbCfg.databaseURL;
      if (this.cfgUserEmail && fbCfg.userEmail) this.cfgUserEmail.value = fbCfg.userEmail;
      if (this.cfgApiKey && fbCfg.apiKey) this.cfgApiKey.value = fbCfg.apiKey;
      if (this.cfgProjectId && fbCfg.projectId) this.cfgProjectId.value = fbCfg.projectId;
      if (this.cfgDeviceNode && fbCfg.deviceNodeId) this.cfgDeviceNode.value = fbCfg.deviceNodeId;
    }
  }

  // Bind All Event Listeners
  bindEvents() {
    // Tab switching
    if (this.navTabs) {
      this.navTabs.forEach((tab) => {
        tab.addEventListener('click', (e) => {
          const btn = e.currentTarget || tab;
          const targetId = btn.getAttribute('data-target');
          if (targetId) this.switchTab(targetId);
        });
      });
    }

    // Header Status Pill
    if (this.btnHeaderStatus) {
      this.btnHeaderStatus.addEventListener('click', () => {
        this.switchTab('tabSettings');
        this.showToast('⚙️ การตั้งค่า & สถานะเชื่อมต่อ');
      });
    }

    // Frame preview toggle on desktop
    if (this.btnToggleFrame && this.appFrame) {
      this.btnToggleFrame.addEventListener('click', () => {
        this.appFrame.classList.toggle('desktop-fullscreen');
        const isFull = this.appFrame.classList.contains('desktop-fullscreen');
        this.btnToggleFrame.textContent = isFull ? '📱 มุมมองมือถือ' : '📱 สลับมุมมองมือถือ / เต็มจอ';
      });
    }

    // Mode Switching
    if (this.modeBtnStudy) this.modeBtnStudy.addEventListener('click', () => this.switchMode('study'));
    if (this.modeBtnDetox) this.modeBtnDetox.addEventListener('click', () => this.switchMode('detox'));

    // Timer Controls
    if (this.btnMainAction) this.btnMainAction.addEventListener('click', () => this.handleMainAction());
    if (this.btnPauseAction) this.btnPauseAction.addEventListener('click', () => this.togglePause());
    if (this.btnResetAction) this.btnResetAction.addEventListener('click', () => this.resetTimer());
    if (this.btnGoSettings) this.btnGoSettings.addEventListener('click', () => this.switchTab('tabSettings'));

    // Filter Chips for History
    if (this.filterChips) {
      this.filterChips.forEach((chip) => {
        chip.addEventListener('click', () => {
          this.filterChips.forEach((c) => c.classList.remove('active'));
          chip.classList.add('active');
          const filter = chip.getAttribute('data-filter');
          this.renderHistory(filter);
        });
      });
    }

    // Stats Metric Switcher
    if (this.btnMetricCount) {
      this.btnMetricCount.addEventListener('click', () => {
        this.selectedChartMetric = 'count';
        this.btnMetricCount.classList.add('active');
        if (this.btnMetricMinutes) this.btnMetricMinutes.classList.remove('active');
        this.renderWeeklyStats();
      });
    }

    if (this.btnMetricMinutes) {
      this.btnMetricMinutes.addEventListener('click', () => {
        this.selectedChartMetric = 'minutes';
        this.btnMetricMinutes.classList.add('active');
        if (this.btnMetricCount) this.btnMetricCount.classList.remove('active');
        this.renderWeeklyStats();
      });
    }

    // Save Mode Durations
    if (this.btnSaveModeSettings) {
      this.btnSaveModeSettings.addEventListener('click', () => {
        const studyM = parseInt(this.inputStudyMinutes?.value, 10) || 25;
        const breakM = parseInt(this.inputBreakMinutes?.value, 10) || 5;
        const detoxM = parseInt(this.inputDetoxMinutes?.value, 10) || 45;

        this.settings.studyMinutes = studyM;
        this.settings.breakMinutes = breakM;
        this.settings.detoxMinutes = detoxM;
        this.saveSettings();

        if (this.timerStatus === 'idle') {
          this.totalPhaseSeconds = (this.activeMode === 'study' ? studyM : detoxM) * 60;
          this.remainingSeconds = this.totalPhaseSeconds;
          this.updateTimerDisplay();
        }

        this.renderPresets();
        this.showToast('💾 บันทึกเวลาสำหรับ 2 โหมดเรียบร้อยแล้ว');
        this.playSound('click');
      });
    }

    // Reconnect Firebase Button
    if (this.btnSaveFirebaseConfig) {
      this.btnSaveFirebaseConfig.addEventListener('click', async () => {
        this.showToast('กำลังเชื่อมต่อ Firebase...');
        const success = await window.focusDockFirebase.initializeFirebase(
          (status) => this.onHardwareStatusReceived(status),
          (logs) => this.onHardwareLogsReceived(logs),
          (sessions) => this.onHardwareSessionsReceived(sessions)
        );
        if (success) {
          this.statusDot.className = 'status-dot online';
          this.statusLabel.textContent = 'ออนไลน์';
          this.showToast('🔥 เชื่อมต่อ Firebase สำเร็จแล้ว!');
        } else {
          this.statusDot.className = 'status-dot offline';
          this.statusLabel.textContent = 'ออฟไลน์';
          this.showToast('ไม่สามารถเชื่อมต่อได้ ตรวจสอบอินเทอร์เน็ต');
        }
      });
    }

    // Direct BLE Connect Button
    if (this.btnConnectBle) {
      this.btnConnectBle.addEventListener('click', async () => {
        try {
          if (window.esp32Direct.isBleConnected) {
            await window.esp32Direct.disconnectBLE();
            this.showToast('ตัดการเชื่อมต่อ Bluetooth แล้ว');
          } else {
            this.showToast('กำลังค้นหา ESP32 (FocusDock)...');
            await window.esp32Direct.connectBLE();
          }
        } catch (e) {
          this.showToast(e.message || 'ไม่สามารถเชื่อมต่อได้');
        }
      });
    }

    // Direct IP Connect Button
    if (this.btnTestEsp32Ip) {
      this.btnTestEsp32Ip.addEventListener('click', async () => {
        const ip = this.cfgEsp32Ip.value.trim();
        if (!ip) return this.showToast('กรุณากรอก IP Address ของ ESP32');
        this.showToast('กำลังทดสอบเชื่อมต่อ IP...');
        try {
          await window.esp32Direct.testDirectIpConnection(ip);
          this.showToast('🟢 เชื่อมต่อกับบอร์ดผ่าน IP สำเร็จ!');
        } catch (e) {
          this.showToast('เชื่อมต่อไม่สำเร็จ: ' + (e.message || 'ตรวจสอบว่าอยู่ใน Wi-Fi เดียวกัน'));
        }
      });
    }

    // Direct Hardware Callbacks
    if (window.esp32Direct) {
      window.esp32Direct.onHardwareStateChange = (state) => {
        this.onHardwareStateReceived(state);
      };

      window.esp32Direct.onConnectionStatusChange = (type, connected) => {
        if (type === 'ble') {
          if (connected) {
            if (this.bleStatusBadge) {
              this.bleStatusBadge.textContent = 'เชื่อมต่อแล้ว 🟢';
              this.bleStatusBadge.className = 'ble-status-pill connected';
            }
            if (this.btnConnectBleText) this.btnConnectBleText.textContent = 'ตัดการเชื่อมต่อ Bluetooth';
            if (this.btnConnectBle) this.btnConnectBle.classList.add('connected');
            this.statusDot.className = 'status-dot online';
            this.statusLabel.textContent = 'ESP32 (BLE)';
            this.showToast('📶 เชื่อมต่อตรงกับ ESP32 สำเร็จ!');
          } else {
            if (this.bleStatusBadge) {
              this.bleStatusBadge.textContent = 'ไม่ได้เชื่อมต่อ';
              this.bleStatusBadge.className = 'ble-status-pill';
            }
            if (this.btnConnectBleText) this.btnConnectBleText.textContent = 'ค้นหาและเชื่อมต่อกับ ESP32';
            if (this.btnConnectBle) this.btnConnectBle.classList.remove('connected');
            if (!window.focusDockFirebase.isConnected) {
              this.statusDot.className = 'status-dot offline';
              this.statusLabel.textContent = 'ออฟไลน์';
            }
          }
        } else if (type === 'ip') {
          if (connected) {
            if (this.ipStatusBadge) {
              this.ipStatusBadge.textContent = 'ออนไลน์ 🟢';
              this.ipStatusBadge.className = 'ble-status-pill connected';
            }
            this.statusDot.className = 'status-dot online';
            this.statusLabel.textContent = 'ESP32 (IP)';
          } else {
            if (this.ipStatusBadge) {
              this.ipStatusBadge.textContent = 'ไม่ได้เชื่อมต่อ';
              this.ipStatusBadge.className = 'ble-status-pill';
            }
          }
        }
      };
    }
  }

  // Setup Firebase Realtime Listener with ESP32
  setupFirebaseListener() {
    window.focusDockFirebase.onConnectionChange((connected) => {
      if (connected) {
        this.statusDot.className = 'status-dot online';
        this.statusLabel.textContent = 'ออนไลน์';
        if (this.envStatusBadge) {
          this.envStatusBadge.textContent = 'ออนไลน์ 🟢';
          this.envStatusBadge.style.color = 'var(--sage-main)';
        }
      } else {
        this.statusDot.className = 'status-dot offline';
        this.statusLabel.textContent = 'ออฟไลน์';
        if (this.envStatusBadge) {
          this.envStatusBadge.textContent = 'ออฟไลน์ 🔴';
          this.envStatusBadge.style.color = 'var(--alert-peach)';
        }
      }
    });

    // Auto-connect to Firebase with ESP32 handlers
    window.focusDockFirebase.initializeFirebase(
      (status) => this.onHardwareStatusReceived(status),
      (logs) => this.onHardwareLogsReceived(logs),
      (sessions) => this.onHardwareSessionsReceived(sessions)
    );
  }

  // Receive live sensor readings and state from ESP32 via /status
  onHardwareStatusReceived(remoteStatus) {
    if (!remoteStatus) return;

    // 1. Environmental Sensors (DHT11 & BH1750 Room Lux)
    if (this.envTemp && remoteStatus.temp !== undefined) {
      this.envTemp.textContent = `${Number(remoteStatus.temp).toFixed(1)} °C`;
    }
    if (this.envHum && remoteStatus.hum !== undefined) {
      this.envHum.textContent = `${Number(remoteStatus.hum).toFixed(0)} %`;
    }
    if (this.envRoomLux && remoteStatus.roomLux !== undefined) {
      this.envRoomLux.textContent = `${Math.round(remoteStatus.roomLux)} lx`;
    }
    if (this.envHandStatus && remoteStatus.handDetected !== undefined) {
      this.envHandStatus.textContent = remoteStatus.handDetected ? '⚠️ ตรวจพบมือ' : 'ปกติ';
      if (remoteStatus.handDetected && this.timerStatus === 'running') {
        this.showToast('✋ ตรวจพบมือใกล้แท่นวาง (เสียสมาธิ)');
      }
    }

    // 2. Phone Placement Sensor (BH1750 Phone Lux on Dock)
    if (typeof remoteStatus.phonePlaced === 'boolean') {
      const isPickedUp = !remoteStatus.phonePlaced;
      if (isPickedUp !== this.isPhonePickedUp) {
        this.handlePhonePickupStateChange(isPickedUp, 'hardware');
      }
    }

    // 3. Mode Sync from physical Yellow button (Mode 1 = Study, Mode 2 = Detox)
    if (remoteStatus.currentMode) {
      const modeName = remoteStatus.currentMode === 2 ? 'detox' : 'study';
      if (this.activeMode !== modeName && this.timerStatus === 'idle') {
        this.switchModeUI(modeName);
      }
    }

    // 4. Timer State Sync from ESP32 ("IDLE", "PREPARE", "RUNNING", "CONFIRM_CANCEL", "FINISHED")
    if (remoteStatus.state) {
      if (remoteStatus.state === 'RUNNING') {
        this.timerStatus = 'running';
        if (remoteStatus.remainingSec !== undefined) {
          this.remainingSeconds = remoteStatus.remainingSec;
        }
        if (remoteStatus.durationSec) {
          this.totalPhaseSeconds = remoteStatus.durationSec;
        }
        this.btnMainActionIcon.textContent = '⏹';
        this.btnMainActionText.textContent = 'ยกเลิก / รีเซ็ต';
        this.btnMainAction.classList.add('running');
        this.timerCaption.textContent = this.activeMode === 'study' ? 'กำลังอ่านหนังสือ มีสมาธิเต็มที่' : 'กำลังพักจากมือถือ ห้ามหยิบใช้งาน';
        this.updateTimerDisplay();
      } else if (remoteStatus.state === 'PREPARE') {
        this.timerStatus = 'prepare';
        this.btnMainActionIcon.textContent = '⏳';
        this.btnMainActionText.textContent = 'กำลังเตรียมตัว...';
        this.timerCaption.textContent = `เตรียมความพร้อม (${remoteStatus.remainingSec || 15} วิ) วางโทรศัพท์บนแท่น`;
        this.updateTimerDisplay();
      } else if (remoteStatus.state === 'CONFIRM_CANCEL') {
        this.showToast('⚠️ รอยืนยันยกเลิกบนเครื่อง (กดปุ่มแดงอีกครั้ง)');
      } else if (remoteStatus.state === 'FINISHED') {
        if (this.timerStatus !== 'finished') {
          this.timerStatus = 'finished';
          this.playSound('bell');
          this.showToast('🔔 ครบเวลาแล้ว! สุดยอดมาก');
          this.btnMainActionIcon.textContent = '▶';
          this.btnMainActionText.textContent = 'เริ่มใหม่อีกครั้ง';
          this.btnMainAction.classList.remove('running');
          this.timerCaption.textContent = 'ภารกิจสำเร็จ!';
        }
      } else if (remoteStatus.state === 'IDLE') {
        if (this.timerStatus !== 'idle') {
          this.resetTimerUI();
        } else {
          if (remoteStatus.durationSec && remoteStatus.durationSec !== this.totalPhaseSeconds) {
            this.totalPhaseSeconds = remoteStatus.durationSec;
            this.remainingSeconds = remoteStatus.durationSec;
            this.updateTimerDisplay();
          }
        }
      }
    }
  }

  // Receive logs from ESP32 via /logs
  onHardwareLogsReceived(logs) {
    if (!logs) return;
    const logList = Object.values(logs);
    if (!logList.length) return;

    const dayNames = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const newPickups = logList
      .filter((item) => item.event === 'phone_removed' || item.event === 'hand_detected')
      .map((item, idx) => {
        const timestamp = Number(item.timestamp) || Date.now();
        const dateObj = new Date(timestamp);
        const dateStr = dateObj.toISOString().split('T')[0];
        const timeStr = dateObj.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const durationSec = Number(item.durationSec) || 15;
        const durationMinutes = Math.max(1, Math.round(durationSec / 60));
        const mode = item.mode === 2 ? 'detox' : 'study';
        const eventName = item.event === 'hand_detected' ? 'ตรวจพบมือแตะแท่น' : 'ยกโทรศัพท์ออกจากแท่น';

        return {
          id: `log_${timestamp}_${idx}`,
          timestamp,
          date: dateStr,
          dayName: dayNames[dateObj.getDay()],
          startTime: timeStr,
          endTime: timeStr,
          time: timeStr,
          durationSeconds: durationSec,
          durationFormatted: `${durationSec} วินาที`,
          durationMinutes,
          mode,
          type: eventName,
          note: eventName
        };
      });

    if (newPickups.length > 0) {
      const existingIds = new Set(this.pickups.map(p => p.id));
      const additions = newPickups.filter(p => !existingIds.has(p.id));
      if (additions.length > 0) {
        this.pickups = [...additions, ...this.pickups].slice(0, 100);
        this.saveStoredPickups();
        this.calculateWeeklyStats();
        this.renderHistory('all');
        this.renderWeeklyStats();
        this.updatePickupStatusUI();
      }
    }
  }

  // Receive completed sessions from ESP32 via /sessions
  onHardwareSessionsReceived(sessions) {
    if (!sessions) return;
    const sessionList = Object.values(sessions);
    if (!sessionList.length) return;
    this.sessions = sessionList;
    this.renderWeeklyStats();
  }

  // Switch Active Navigation Tab
  switchTab(tabId) {
    this.activeTab = tabId;
    this.tabScreens.forEach((screen) => {
      screen.classList.toggle('active', screen.id === tabId);
    });

    this.navTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-target') === tabId);
    });

    if (tabId === 'tabHistory') this.renderHistory('all');
    if (tabId === 'tabStats') this.renderWeeklyStats();
  }

  // Switch Mode UI without triggering Firebase loop
  switchModeUI(mode) {
    this.activeMode = mode;
    if (mode === 'study') {
      this.modeBtnStudy.classList.add('active');
      this.modeBtnStudy.classList.remove('detox');
      this.modeBtnDetox.classList.remove('active', 'detox');
      this.totalPhaseSeconds = this.settings.studyMinutes * 60;
      this.currentPhase = 'study';
      this.circleProgressBar.className.baseVal = 'circle-progress';
      this.btnMainAction.className = 'btn-ctrl btn-ctrl-primary';
      this.phaseChip.className = 'phase-chip';
      this.phaseIcon.textContent = '📖';
      this.phaseLabel.textContent = 'กำลังอ่านหนังสือ';
    } else {
      this.modeBtnDetox.classList.add('active', 'detox');
      this.modeBtnStudy.classList.remove('active');
      this.totalPhaseSeconds = this.settings.detoxMinutes * 60;
      this.currentPhase = 'detox';
      this.circleProgressBar.className.baseVal = 'circle-progress detox';
      this.btnMainAction.className = 'btn-ctrl btn-ctrl-primary detox';
      this.phaseChip.className = 'phase-chip detox';
      this.phaseIcon.textContent = '📵';
      this.phaseLabel.textContent = 'โหมดพักจากมือถือ';
    }

    this.remainingSeconds = this.totalPhaseSeconds;
    this.updateTimerDisplay();
    this.renderPresets();
  }

  // Switch Mode from Web (dispatches to ESP32 /config)
  switchMode(mode) {
    if (this.timerStatus === 'running') {
      const confirmChange = confirm('กำลังจับเวลาอยู่ ต้องการเปลี่ยนโหมดและรีเซ็ตเวลาหรือไม่?');
      if (!confirmChange) return;
      this.resetTimer();
    }

    this.playSound('click');
    this.switchModeUI(mode);
    const modeNum = mode === 'study' ? 1 : 2;
    const durationSec = (mode === 'study' ? this.settings.studyMinutes : this.settings.detoxMinutes) * 60;
    window.focusDockFirebase.updateConfig(modeNum, durationSec);
  }

  // Main Timer Action (Start / Cancel)
  handleMainAction() {
    this.playSound('click');
    if (this.timerStatus === 'idle' || this.timerStatus === 'finished') {
      this.startTimer();
    } else {
      this.resetTimer();
    }
  }

  startTimer() {
    const modeNum = this.activeMode === 'study' ? 1 : 2;
    const durationSec = (this.activeMode === 'study' ? this.settings.studyMinutes : this.settings.detoxMinutes) * 60;
    
    // Clear any active timers
    clearInterval(this.timerInterval);

    // 1. Enter prepare state: 15-second countdown (gives user time to put phone on dock)
    this.timerStatus = 'prepare';
    this.remainingSeconds = 15;
    this.totalPhaseSeconds = 15;

    this.btnMainActionIcon.textContent = '⏹';
    this.btnMainActionText.textContent = 'ยกเลิก';
    this.btnMainAction.classList.add('running');
    this.timerCaption.textContent = '⏳ เตรียมความพร้อม (15 วิ) วางโทรศัพท์บนแท่น...';
    this.updateTimerDisplay();

    this.showToast('⏳ เริ่มนับถอยหลัง 15 วิ เพื่อให้มีเวลาเก็บมือถือบนแท่น');
    this.playSound('click');

    // 2. Dispatch start trigger to Firebase for ESP32
    if (window.focusDockFirebase) {
      window.focusDockFirebase.triggerStart(modeNum, durationSec);
    }
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectCommand('START', this.activeMode, this.settings);
    }

    // 3. Web ticker for 15s prepare countdown
    this.timerInterval = setInterval(() => {
      if (this.timerStatus !== 'prepare') {
        clearInterval(this.timerInterval);
        return;
      }
      if (this.remainingSeconds > 1) {
        this.remainingSeconds--;
        this.timerCaption.textContent = `⏳ เตรียมความพร้อม (${this.remainingSeconds} วิ) วางโทรศัพท์บนแท่น`;
        this.updateTimerDisplay();
        this.playSound('click');
      } else {
        // Prepare countdown finished -> Start real focus timer
        clearInterval(this.timerInterval);
        this.startActualFocusSession(durationSec);
      }
    }, 1000);
  }

  startActualFocusSession(durationSec) {
    this.timerStatus = 'running';
    this.totalPhaseSeconds = durationSec || ((this.activeMode === 'study' ? this.settings.studyMinutes : this.settings.detoxMinutes) * 60);
    this.remainingSeconds = this.totalPhaseSeconds;

    this.btnMainActionIcon.textContent = '⏹';
    this.btnMainActionText.textContent = 'ยกเลิก / รีเซ็ต';
    this.btnMainAction.classList.add('running');
    this.timerCaption.textContent = this.activeMode === 'study' ? 'กำลังอ่านหนังสือ มีสมาธิเต็มที่' : 'กำลังพักจากมือถือ ห้ามหยิบใช้งาน';
    this.updateTimerDisplay();

    this.playSound('bell');
    this.showToast('🚀 เริ่มต้นการจับเวลาจริงแล้ว!');

    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => this.tickTimer(), 1000);
  }

  togglePause() {
    this.resetTimer();
  }

  resetTimerUI() {
    clearInterval(this.timerInterval);
    this.timerStatus = 'idle';

    if (this.activeMode === 'study') {
      this.currentPhase = 'study';
      this.totalPhaseSeconds = this.settings.studyMinutes * 60;
      this.phaseChip.className = 'phase-chip';
      this.phaseIcon.textContent = '📖';
      this.phaseLabel.textContent = 'กำลังอ่านหนังสือ';
    } else {
      this.totalPhaseSeconds = this.settings.detoxMinutes * 60;
      this.phaseChip.className = 'phase-chip detox';
      this.phaseIcon.textContent = '📵';
      this.phaseLabel.textContent = 'โหมดพักจากมือถือ';
    }

    this.remainingSeconds = this.totalPhaseSeconds;
    this.btnMainActionIcon.textContent = '▶';
    this.btnMainActionText.textContent = 'เริ่มจับเวลา';
    this.btnMainAction.classList.remove('running');
    this.timerCaption.textContent = 'พร้อมเริ่มจับเวลา';

    this.updateTimerDisplay();
  }

  resetTimer() {
    this.playSound('click');
    this.showToast('⏹ ส่งคำสั่งยกเลิก/รีเซ็ตไปยังเครื่อง ESP32...');
    if (window.focusDockFirebase) {
      window.focusDockFirebase.triggerCancel();
    }
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectCommand('CANCEL', this.activeMode, this.settings);
    }
    this.resetTimerUI();
  }

  // Ticking function
  tickTimer() {
    if (this.remainingSeconds > 0) {
      this.remainingSeconds--;
      this.updateTimerDisplay();
    } else {
      // Timer finished!
      this.handlePhaseComplete();
    }
  }

  handlePhaseComplete() {
    clearInterval(this.timerInterval);
    this.playSound('bell');

    if (this.activeMode === 'study') {
      if (this.currentPhase === 'study') {
        // Study period ended -> switch to Break period
        this.currentPhase = 'break';
        this.totalPhaseSeconds = this.settings.breakMinutes * 60;
        this.remainingSeconds = this.totalPhaseSeconds;

        this.phaseChip.className = 'phase-chip break';
        this.phaseIcon.textContent = '☕';
        this.phaseLabel.textContent = `พักผ่อน ${this.settings.breakMinutes} นาที`;
        this.circleProgressBar.className.baseVal = 'circle-progress break';
        this.timerCaption.textContent = 'ถึงเวลาพักสายตาแล้ว!';
        this.showToast('🔔 ครบเวลาอ่านหนังสือแล้ว! พักสายตาสักครู่');
        this.startTimer();
      } else {
        // Break period ended -> switch back to Study period (Next cycle)
        this.pomodoroCycle = (this.pomodoroCycle % 4) + 1;
        this.currentPhase = 'study';
        this.totalPhaseSeconds = this.settings.studyMinutes * 60;
        this.remainingSeconds = this.totalPhaseSeconds;

        this.phaseChip.className = 'phase-chip';
        this.phaseIcon.textContent = '📖';
        this.phaseLabel.textContent = `อ่านหนังสือ รอบที่ ${this.pomodoroCycle}/4`;
        this.circleProgressBar.className.baseVal = 'circle-progress';
        this.timerCaption.textContent = 'เริ่มต้นรอบถัดไป!';
        this.showToast(`✨ เริ่มอ่านหนังสือ รอบที่ ${this.pomodoroCycle}/4`);
        this.updatePomodoroDots();
        this.startTimer();
      }
    } else {
      // Detox mode completed!
      this.timerStatus = 'idle';
      this.showToast('🎉 ยินดีด้วย! คุณสำเร็จโหมดพักจากมือถือแล้ว');
      this.btnMainActionIcon.textContent = '▶';
      this.btnMainActionText.textContent = 'เริ่มใหม่อีกครั้ง';
      this.btnMainAction.classList.remove('running');
      this.timerCaption.textContent = 'ภารกิจสำเร็จ!';
    }
  }

  updatePomodoroDots() {
    const dots = this.pomodoroDots.querySelectorAll('.cycle-dot');
    dots.forEach((dot, idx) => {
      dot.classList.toggle('filled', idx < this.pomodoroCycle);
    });
  }

  // Update SVG Ring and Numeric Clock
  updateTimerDisplay() {
    const min = Math.floor(this.remainingSeconds / 60);
    const sec = this.remainingSeconds % 60;
    this.timerDisplay.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    // SVG Circular progress
    // Circumference = 2 * PI * r = 2 * PI * 88 = 552.92
    const totalCircumference = 552.92;
    const progress = this.totalPhaseSeconds > 0 ? (this.remainingSeconds / this.totalPhaseSeconds) : 0;
    const offset = totalCircumference * (1 - progress);
    this.circleProgressBar.style.strokeDashoffset = offset;
  }

  // Real-time Phone Picked Up / Resting Handler
  handlePhonePickupStateChange(pickedUp, source) {
    if (this.isPhonePickedUp === pickedUp) return;
    this.isPhonePickedUp = pickedUp;

    if (pickedUp) {
      // Phone is lifted from dock
      this.pickupStartTime = new Date();
      this.liveHoldingSeconds = 0;
      this.playSound('alert');

      if (navigator.vibrate && this.settings.vibrationAlert) {
        navigator.vibrate([100, 50, 100]);
      }

      // Start live counter
      clearInterval(this.liveHoldingInterval);
      this.liveHoldingInterval = setInterval(() => {
        this.liveHoldingSeconds++;
        const m = Math.floor(this.liveHoldingSeconds / 60);
        const s = this.liveHoldingSeconds % 60;
        this.liveHoldingTimer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }, 1000);

      this.updatePickupStatusUI();
    } else {
      // Phone is returned to dock
      clearInterval(this.liveHoldingInterval);
      const endTime = new Date();
      const durationSec = Math.max(1, this.liveHoldingSeconds || Math.round((endTime - this.pickupStartTime) / 1000));

      if (this.pickupStartTime) {
        this.recordNewPickupEvent(this.pickupStartTime, endTime, durationSec);
      }

      this.pickupStartTime = null;
      this.liveHoldingSeconds = 0;
      this.updatePickupStatusUI();
    }

    // Sync to Firebase
    window.focusDockFirebase.updateLiveHardwareState({
      phonePickedUp: this.isPhonePickedUp,
      lastChangeSource: source
    });
  }

  // Record a complete pickup event
  recordNewPickupEvent(startDate, endDate, durationSeconds) {
    const todayStr = startDate.toISOString().split('T')[0];
    const dayNamesThai = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    
    const startH = String(startDate.getHours()).padStart(2, '0');
    const startM = String(startDate.getMinutes()).padStart(2, '0');
    const startS = String(startDate.getSeconds()).padStart(2, '0');

    const endH = String(endDate.getHours()).padStart(2, '0');
    const endM = String(endDate.getMinutes()).padStart(2, '0');
    const endS = String(endDate.getSeconds()).padStart(2, '0');

    const newPickup = {
      id: `pk_${Date.now()}`,
      date: todayStr,
      dayName: dayNamesThai[startDate.getDay()],
      startTime: `${startH}:${startM}:${startS}`,
      endTime: `${endH}:${endM}:${endS}`,
      durationSeconds: durationSeconds,
      durationFormatted: formatSecondsToMinSec(durationSeconds),
      mode: this.activeMode,
      note: this.activeMode === 'study' ? 'หยิบขณะอ่านหนังสือ' : 'หยิบขณะโหมดพักมือถือ'
    };

    // Add to list
    this.pickups.unshift(newPickup);
    this.saveStoredPickups();

    // Update today item in weekly stats
    const todaySummary = this.weeklyData[this.weeklyData.length - 1];
    if (todaySummary) {
      todaySummary.pickupsCount += 1;
      todaySummary.totalSeconds += durationSeconds;
      todaySummary.totalMinutes = Math.round(todaySummary.totalSeconds / 60);
      todaySummary.avgMinutesPerPickup = Number(((todaySummary.totalSeconds / todaySummary.pickupsCount) / 60).toFixed(1));
    }

    // Re-render UI
    this.renderHistory('all');
    this.renderWeeklyStats();
    this.updatePickupStatusUI();

    // Push to Firebase Realtime Database
    window.focusDockFirebase.recordPickupEvent(newPickup);
  }

  // Update Live Card Appearance
  updatePickupStatusUI() {
    const todayStr = new Date().toISOString().split('T')[0];
    const todayPickups = this.pickups.filter((p) => p.date === todayStr);
    const todayCount = todayPickups.length;
    const todayTotalSeconds = todayPickups.reduce((acc, curr) => acc + (curr.durationSeconds || 0), 0);
    const todayTotalMinutes = Math.round(todayTotalSeconds / 60);

    this.todayPickupsCount.textContent = todayCount;
    this.todayPickupDuration.textContent = `${todayTotalMinutes} นาที`;

    if (this.isPhonePickedUp) {
      this.pickupStatusCard.classList.add('phone-picked-up');
      this.pickupBadge.className = 'status-badge picked-up';
      this.pickupBadgeText.textContent = 'กำลังหยิบมือถือ!';
      this.pickupStatusTitle.textContent = 'ตรวจพบการหยิบใช้งาน';
      this.pickupStatusDesc.textContent = this.activeMode === 'study' ? 'กำลังอ่านหนังสืออยู่ วางมือถือเพื่อสมาธิที่ดี' : 'อยู่ในโหมดพักจากมือถือ วางมือถือกลับลงบนแท่น';
      this.liveHoldingTimerWrap.style.display = 'flex';
    } else {
      this.pickupStatusCard.classList.remove('phone-picked-up');
      this.pickupBadge.className = 'status-badge resting';
      this.pickupBadgeText.textContent = 'วางอยู่บนแท่นพัก';
      this.pickupStatusTitle.textContent = 'วางมือถือบนแท่นแล้ว';
      this.pickupStatusDesc.textContent = 'มีสมาธิกับการอ่านหนังสือได้อย่างเต็มที่';
      this.liveHoldingTimerWrap.style.display = 'none';
    }
  }

  // Render Presets
  renderPresets() {
    this.presetPillsContainer.innerHTML = '';
    const presets = this.activeMode === 'study'
      ? [
          { label: '25/5 นาที (มาตรฐาน)', study: 25, break: 5 },
          { label: '45/10 นาที (ขั้นสูง)', study: 45, break: 10 },
          { label: '50/10 นาที (มาราธอน)', study: 50, break: 10 },
          { label: '15/3 นาที (เน้นเร็ว)', study: 15, break: 3 }
        ]
      : [
          { label: '30 นาที', detox: 30 },
          { label: '45 นาที (มาตรฐาน)', detox: 45 },
          { label: '60 นาที (1 ชม.)', detox: 60 },
          { label: '120 นาที (2 ชม.)', detox: 120 }
        ];

    presets.forEach((preset, index) => {
      const btn = document.createElement('button');
      btn.className = `preset-chip-btn ${index === 0 ? 'active' : ''}`;
      btn.textContent = preset.label;
      btn.addEventListener('click', () => {
        this.presetPillsContainer.querySelectorAll('.preset-chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.playSound('click');

        if (this.activeMode === 'study') {
          this.settings.studyMinutes = preset.study;
          this.settings.breakMinutes = preset.break;
          this.inputStudyMinutes.value = preset.study;
          this.inputBreakMinutes.value = preset.break;
        } else {
          this.settings.detoxMinutes = preset.detox;
          this.inputDetoxMinutes.value = preset.detox;
        }

        this.saveSettings();
        if (this.timerStatus === 'idle') {
          this.totalPhaseSeconds = (this.activeMode === 'study' ? preset.study : preset.detox) * 60;
          this.remainingSeconds = this.totalPhaseSeconds;
          this.updateTimerDisplay();
        }
        this.showToast(`⏱ เลือกเวลา ${preset.label}`);
      });
      this.presetPillsContainer.appendChild(btn);
    });
  }

  // Render Pickup History Timeline
  renderHistory(filter) {
    if (!this.pickupTimelineContainer) return;
    this.pickupTimelineContainer.innerHTML = '';
    const todayStr = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let filtered = this.pickups || [];
    if (filter === 'today') {
      filtered = filtered.filter((p) => p.date === todayStr);
    } else if (filter === 'yesterday') {
      filtered = filtered.filter((p) => p.date === yesterdayStr);
    } else if (filter === 'study') {
      filtered = filtered.filter((p) => p.mode === 'study');
    } else if (filter === 'detox') {
      filtered = filtered.filter((p) => p.mode === 'detox');
    }

    if (!filtered || filtered.length === 0) {
      this.pickupTimelineContainer.innerHTML = `
        <div style="text-align: center; padding: 44px 16px; color: var(--text-muted); font-size: 13px;">
          <span style="font-size: 32px; display: block; margin-bottom: 8px;">📖</span>
          <p style="font-weight: 500; color: var(--text-secondary); margin-bottom: 4px;">ยังไม่มีประวัติการหยิบมือถือ</p>
          <p style="font-size: 11px;">ระบบจะบันทึกอัตโนมัติเมื่อตัวเครื่อง ESP32 ตรวจพบการหยิบมือถือหรือแตะแท่น</p>
        </div>
      `;
      return;
    }

    filtered.slice(0, 50).forEach((item) => {
      const el = document.createElement('div');
      el.className = 'pickup-log-item';

      const modeClass = item.mode === 'study' ? 'study' : (item.mode === 'detox' ? 'detox' : '');
      const modeText = item.mode === 'study' ? 'อ่านหนังสือ' : (item.mode === 'detox' ? 'พักมือถือ' : 'ปกติ');

      const isToday = item.date === todayStr;
      const isYesterday = item.date === yesterdayStr;
      const dateLabel = isToday ? 'วันนี้' : (isYesterday ? 'เมื่อวาน' : `${item.dayName || ''} (${item.date || ''})`);

      el.innerHTML = `
        <div class="log-left">
          <div class="log-time-row">
            <span class="log-clock">${item.startTime || item.time || '--:--'}</span>
            <span class="log-mode-tag ${modeClass}">${modeText}</span>
          </div>
          <span class="log-date-sub">${dateLabel} • ${item.note || item.type || ''}</span>
        </div>
        <div class="log-right">
          <span class="log-duration-badge">${item.durationFormatted || (item.durationSeconds ? `${item.durationSeconds} วินาที` : '15 วินาที')}</span>
        </div>
      `;
      this.pickupTimelineContainer.appendChild(el);
    });
  }

  // Render Weekly Analytics: "ใน 1 สัปดาห์เราจับไปแล้วกี่ครั้ง ครั้งละกี่นาที"
  renderWeeklyStats() {
    // 1. Calculate Weekly Aggregates
    let totalWeeklyPickups = 0;
    let totalWeeklySeconds = 0;

    this.weeklyData.forEach((day) => {
      totalWeeklyPickups += day.pickupsCount;
      totalWeeklySeconds += day.totalSeconds;
    });

    const totalWeeklyMinutes = Math.round(totalWeeklySeconds / 60);
    const avgMinutesPerPickup = totalWeeklyPickups > 0 ? Number(((totalWeeklySeconds / totalWeeklyPickups) / 60).toFixed(1)) : 0;

    // Update KPI Card values
    this.kpiWeeklyTotalCount.textContent = totalWeeklyPickups;
    this.kpiWeeklyAvgDuration.textContent = avgMinutesPerPickup;
    this.kpiWeeklyTotalTime.textContent = totalWeeklyMinutes;

    // 2. Render 7-Day Interactive Bar Chart
    this.barChartContainer.innerHTML = '';
    const maxVal = Math.max(
      ...this.weeklyData.map((d) => (this.selectedChartMetric === 'count' ? d.pickupsCount : d.totalMinutes)),
      1
    );

    this.weeklyData.forEach((day, index) => {
      const val = this.selectedChartMetric === 'count' ? day.pickupsCount : day.totalMinutes;
      const heightPercent = Math.max(12, Math.round((val / maxVal) * 100));

      const col = document.createElement('div');
      col.className = `chart-column ${day.isToday ? 'today' : ''} ${index === this.selectedChartDayIndex ? 'selected' : ''}`;
      col.title = `${day.dayFull}: ${day.pickupsCount} ครั้ง, รวม ${day.totalMinutes} นาที`;

      col.innerHTML = `
        <div class="bar-tooltip">${val}${this.selectedChartMetric === 'count' ? 'ค.' : 'น.'}</div>
        <div class="bar-pillar-wrap">
          <div class="bar-pillar" style="height: ${heightPercent}%;"></div>
        </div>
        <span class="bar-day-label">${day.dayShort}</span>
      `;

      col.addEventListener('click', () => {
        this.selectedChartDayIndex = index;
        this.barChartContainer.querySelectorAll('.chart-column').forEach((c) => c.classList.remove('selected'));
        col.classList.add('selected');
        this.updateSelectedDayCard(day);
      });

      this.barChartContainer.appendChild(col);
    });

    // Update Selected Day Card with the chosen day
    const activeDay = this.weeklyData[this.selectedChartDayIndex] || this.weeklyData[this.weeklyData.length - 1];
    this.updateSelectedDayCard(activeDay);
  }

  updateSelectedDayCard(day) {
    if (!day) return;
    if (this.detailDayTitle) this.detailDayTitle.textContent = `${day.dayFull || ''} (${day.date || ''})`;
    if (this.detailDayPickups) this.detailDayPickups.textContent = day.pickupsCount || 0;
    if (this.detailDayAvg) this.detailDayAvg.textContent = day.avgMinutesPerPickup || 0;
    if (this.detailDayTotal) this.detailDayTotal.textContent = day.totalMinutes || 0;
  }

  // Update top phone status bar clock
  updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    if (this.statusBarClock) {
      this.statusBarClock.textContent = `${h}:${m}`;
    }
  }

  // Toast banner
  showToast(msg) {
    this.toastMessage.textContent = msg;
    this.toastNotice.classList.add('show');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.toastNotice.classList.remove('show');
    }, 2800);
  }
}

// Instant & Reliable DOM Ready Initialization
function startFocusDockApp() {
  if (!window.focusDockApp) {
    try {
      window.focusDockApp = new FocusDockApp();
      console.log('FocusDock App initialized for real production use.');
    } catch (err) {
      console.error('FocusDock initialization error:', err);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startFocusDockApp);
} else {
  startFocusDockApp();
}
