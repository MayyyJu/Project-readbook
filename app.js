// app.js - Main Application Logic, State Machine, and UI Controller for FocusDock

class FocusDockApp {
  constructor() {
    // 1. Load or initialize data
    this.initialData = generatePastWeekData();
    this.pickups = this.loadStoredPickups() || this.initialData.allPickups;
    this.weeklyData = this.initialData.weeklySummary;
    this.sessions = this.initialData.allSessions;

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
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectSettings(this.settings);
    } else if (window.focusDockFirebase) {
      window.focusDockFirebase.updateSettings(this.settings);
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
    this.cfgApiKey = document.getElementById('cfgApiKey');
    this.cfgProjectId = document.getElementById('cfgProjectId');
    this.cfgDeviceNode = document.getElementById('cfgDeviceNode');
    this.btnSaveFirebaseConfig = document.getElementById('btnSaveFirebaseConfig');

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
    this.inputStudyMinutes.value = this.settings.studyMinutes;
    this.inputBreakMinutes.value = this.settings.breakMinutes;
    this.inputDetoxMinutes.value = this.settings.detoxMinutes;

    // Fill Firebase credentials if saved
    const fbCfg = window.focusDockFirebase.config;
    if (fbCfg.databaseURL) this.cfgDatabaseUrl.value = fbCfg.databaseURL;
    if (fbCfg.apiKey) this.cfgApiKey.value = fbCfg.apiKey;
    if (fbCfg.projectId) this.cfgProjectId.value = fbCfg.projectId;
    if (fbCfg.deviceNodeId) this.cfgDeviceNode.value = fbCfg.deviceNodeId;
  }

  // Bind All Event Listeners
  bindEvents() {
    // Tab switching
    this.navTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetId = tab.getAttribute('data-target');
        this.switchTab(targetId);
      });
    });

    // Frame preview toggle on desktop
    this.btnToggleFrame.addEventListener('click', () => {
      this.appFrame.classList.toggle('desktop-fullscreen');
      const isFull = this.appFrame.classList.contains('desktop-fullscreen');
      if (isFull) {
        this.appFrame.style.maxWidth = '100%';
        this.appFrame.style.borderRadius = '0';
        this.appFrame.style.border = 'none';
        this.appFrame.style.minHeight = '100vh';
      } else {
        this.appFrame.style.maxWidth = 'var(--app-max-width)';
        this.appFrame.style.borderRadius = '44px';
        this.appFrame.style.border = '8px solid rgba(28, 36, 33, 0.12)';
        this.appFrame.style.minHeight = '844px';
      }
    });

    // Mode Switching
    this.modeBtnStudy.addEventListener('click', () => this.switchMode('study'));
    this.modeBtnDetox.addEventListener('click', () => this.switchMode('detox'));

    // Timer Controls
    this.btnMainAction.addEventListener('click', () => this.handleMainAction());
    this.btnPauseAction.addEventListener('click', () => this.togglePause());
    this.btnResetAction.addEventListener('click', () => this.resetTimer());
    this.btnGoSettings.addEventListener('click', () => this.switchTab('tabSettings'));

    // Filter Chips for History
    this.filterChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        this.filterChips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const filter = chip.getAttribute('data-filter');
        this.renderHistory(filter);
      });
    });

    // Stats Metric Switcher
    this.btnMetricCount.addEventListener('click', () => {
      this.selectedChartMetric = 'count';
      this.btnMetricCount.classList.add('active');
      this.btnMetricMinutes.classList.remove('active');
      this.renderWeeklyStats();
    });

    this.btnMetricMinutes.addEventListener('click', () => {
      this.selectedChartMetric = 'minutes';
      this.btnMetricMinutes.classList.add('active');
      this.btnMetricCount.classList.remove('active');
      this.renderWeeklyStats();
    });

    // Save Mode Durations
    this.btnSaveModeSettings.addEventListener('click', () => {
      const studyM = parseInt(this.inputStudyMinutes.value, 10) || 25;
      const breakM = parseInt(this.inputBreakMinutes.value, 10) || 5;
      const detoxM = parseInt(this.inputDetoxMinutes.value, 10) || 45;

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

    // Save Firebase Credentials
    this.btnSaveFirebaseConfig.addEventListener('click', async () => {
      const config = {
        databaseURL: this.cfgDatabaseUrl.value.trim(),
        apiKey: this.cfgApiKey.value.trim(),
        projectId: this.cfgProjectId.value.trim(),
        deviceNodeId: this.cfgDeviceNode.value.trim() || 'focus_dock_01'
      };
      window.focusDockFirebase.saveConfig(config);
      this.showToast('กำลังเชื่อมต่อ Firebase...');

      const success = await window.focusDockFirebase.initializeFirebase((state) => {
        this.onHardwareStateReceived(state);
      });

      if (success) {
        this.statusDot.className = 'status-dot online';
        this.statusLabel.textContent = 'ออนไลน์';
        this.showToast('🔥 เชื่อมต่อ Firebase สำเร็จแล้ว!');
      } else {
        this.statusDot.className = 'status-dot demo';
        this.statusLabel.textContent = 'โหมดจำลอง';
        this.showToast('ไม่สามารถเชื่อมต่อได้ ทำงานในโหมดจำลอง');
      }
    });

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
              this.statusDot.className = 'status-dot demo';
              this.statusLabel.textContent = 'โหมดจำลอง';
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

  // Setup Firebase Realtime Listener
  setupFirebaseListener() {
    window.focusDockFirebase.onConnectionChange((connected) => {
      if (connected) {
        this.statusDot.className = 'status-dot online';
        this.statusLabel.textContent = 'ออนไลน์';
      } else if (!window.focusDockFirebase.isDemoMode) {
        this.statusDot.className = 'status-dot offline';
        this.statusLabel.textContent = 'หลุดการเชื่อมต่อ';
      }
    });

    // Try auto-connect if credentials exist
    if (window.focusDockFirebase.config.databaseURL) {
      window.focusDockFirebase.initializeFirebase((state) => {
        this.onHardwareStateReceived(state);
      });
    }
  }

  // State received from ESP32 / Arduino hardware via Firebase
  onHardwareStateReceived(remoteState) {
    if (!remoteState) return;

    // 1. Phone sensor status change
    if (typeof remoteState.phonePickedUp === 'boolean' && remoteState.phonePickedUp !== this.isPhonePickedUp) {
      this.handlePhonePickupStateChange(remoteState.phonePickedUp, 'hardware');
    }

    // 2. Physical Button press received from Hardware
    if (remoteState.lastActionBy === 'hardware' && remoteState.actionTimestamp) {
      const timeDiff = Date.now() - remoteState.actionTimestamp;
      if (timeDiff < 3000) {
        if (remoteState.command === 'START_TOGGLE') {
          this.handleHardwarePhysicalButtonPress();
        }
      }
    }
  }

  // Physical Button on Hardware Pressed (or simulated)
  handleHardwarePhysicalButtonPress() {
    this.showToast('🔘 ได้รับสัญญาณกดปุ่มจากตัวเครื่อง!');
    this.handleMainAction();
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

  // Switch Mode: Study vs Detox
  switchMode(mode) {
    if (this.timerStatus === 'running') {
      const confirmChange = confirm('กำลังจับเวลาอยู่ ต้องการเปลี่ยนโหมดและรีเซ็ตเวลาหรือไม่?');
      if (!confirmChange) return;
      this.resetTimer();
    }

    this.activeMode = mode;
    this.playSound('click');

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
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectCommand('CHANGE_MODE', mode, this.settings);
    } else if (window.focusDockFirebase) {
      window.focusDockFirebase.sendCommand('CHANGE_MODE', mode, this.settings);
    }
  }

  // Main Timer Action (Start / Resume)
  handleMainAction() {
    this.playSound('click');

    if (this.timerStatus === 'idle' || this.timerStatus === 'paused') {
      this.startTimer();
    } else if (this.timerStatus === 'running') {
      this.togglePause();
    }
  }

  startTimer() {
    this.timerStatus = 'running';
    this.btnMainActionIcon.textContent = '⏸';
    this.btnMainActionText.textContent = 'พักชั่วคราว';
    this.btnMainAction.classList.add('running');
    this.btnPauseAction.style.display = 'none';

    if (this.activeMode === 'study') {
      this.timerCaption.textContent = this.currentPhase === 'study' ? 'กำลังอ่านหนังสือ มีสมาธิเต็มที่' : 'เวลาพักสายตาและผ่อนคลาย';
    } else {
      this.timerCaption.textContent = 'กำลังพักจากมือถือ ห้ามหยิบใช้งาน';
    }

    clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.tickTimer();
    }, 1000);

    this.showToast('▶ เริ่มต้นการจับเวลาแล้ว');
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectCommand('START', this.activeMode, this.settings);
    } else if (window.focusDockFirebase) {
      window.focusDockFirebase.sendCommand('START', this.activeMode, this.settings);
    }
  }

  togglePause() {
    if (this.timerStatus === 'running') {
      this.timerStatus = 'paused';
      clearInterval(this.timerInterval);
      this.btnMainActionIcon.textContent = '▶';
      this.btnMainActionText.textContent = 'ทำต่อ (Resume)';
      this.btnMainAction.classList.remove('running');
      this.timerCaption.textContent = 'พักการจับเวลาชั่วคราว';
      this.showToast('⏸ หยุดพักชั่วคราว');
      if (window.esp32Direct) {
        window.esp32Direct.dispatchDirectCommand('PAUSE', this.activeMode, this.settings);
      } else if (window.focusDockFirebase) {
        window.focusDockFirebase.sendCommand('PAUSE', this.activeMode, this.settings);
      }
    } else if (this.timerStatus === 'paused') {
      this.startTimer();
    }
  }

  resetTimer() {
    this.playSound('click');
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
    this.showToast('⏹ รีเซ็ตเวลาเรียบร้อย');
    if (window.esp32Direct) {
      window.esp32Direct.dispatchDirectCommand('RESET', this.activeMode, this.settings);
    } else if (window.focusDockFirebase) {
      window.focusDockFirebase.sendCommand('RESET', this.activeMode, this.settings);
    }
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
    this.pickupTimelineContainer.innerHTML = '';
    const todayStr = new Date().toISOString().split('T')[0];
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let filtered = this.pickups;
    if (filter === 'today') {
      filtered = this.pickups.filter((p) => p.date === todayStr);
    } else if (filter === 'yesterday') {
      filtered = this.pickups.filter((p) => p.date === yesterdayStr);
    } else if (filter === 'study') {
      filtered = this.pickups.filter((p) => p.mode === 'study');
    } else if (filter === 'detox') {
      filtered = this.pickups.filter((p) => p.mode === 'detox');
    }

    if (filtered.length === 0) {
      this.pickupTimelineContainer.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px;">
          ยังไม่มีรายการหยิบมือถือในหมวดหมู่นี้
        </div>
      `;
      return;
    }

    filtered.slice(0, 30).forEach((item) => {
      const el = document.createElement('div');
      el.className = 'pickup-log-item';

      const modeClass = item.mode === 'study' ? 'study' : (item.mode === 'detox' ? 'detox' : '');
      const modeText = item.mode === 'study' ? 'อ่านหนังสือ' : (item.mode === 'detox' ? 'พักมือถือ' : 'ปกติ');

      const isToday = item.date === todayStr;
      const dateLabel = isToday ? 'วันนี้' : `${item.dayName || ''} (${item.date})`;

      el.innerHTML = `
        <div class="log-left">
          <div class="log-time-row">
            <span class="log-clock">${item.startTime} - ${item.endTime}</span>
            <span class="log-mode-tag ${modeClass}">${modeText}</span>
          </div>
          <span class="log-date-sub">${dateLabel} • ${item.note || ''}</span>
        </div>
        <div class="log-right">
          <span class="log-duration-badge">${item.durationFormatted}</span>
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
    this.detailDayTitle.textContent = `${day.dayFull} (${day.date})`;
    this.detailDayPickups.textContent = day.pickupsCount;
    this.detailDayAvg.textContent = day.avgMinutesPerPickup;
    this.detailDayTotal.textContent = day.totalMinutes;
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

// Instantiate on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.focusDockApp = new FocusDockApp();
});
