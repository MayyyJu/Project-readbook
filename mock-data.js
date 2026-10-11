// mock-data.js - Initial sample data for 1-week pickup statistics and timeline
// Automatically creates realistic history for current week

function generatePastWeekData() {
  const today = new Date();
  const dayNamesThai = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const dayShortThai = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  
  const weeklySummary = [];
  const allPickups = [];
  const allSessions = [];

  // Generate 7 days ending today
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayOfWeek = d.getDay();
    const isToday = i === 0;

    // Realistic variation of pickups per day: 4 to 9 times per day
    const pickupCount = isToday ? 5 : (3 + (i * 3 + dayOfWeek * 2) % 6);
    let dayTotalSeconds = 0;
    const dayPickups = [];

    // Hour slots throughout the day (morning, afternoon, evening)
    const hourSlots = [
      { h: 9, m: 15 },
      { h: 10, m: 42 },
      { h: 11, m: 30 },
      { h: 13, m: 18 },
      { h: 14, m: 45 },
      { h: 16, m: 20 },
      { h: 19, m: 10 },
      { h: 21, m: 05 }
    ];

    for (let p = 0; p < pickupCount; p++) {
      const slot = hourSlots[p % hourSlots.length];
      const startH = String(slot.h).padStart(2, '0');
      const startM = String((slot.m + (p * 7) % 30)).padStart(2, '0');
      const startS = String(10 + (p * 11) % 45).padStart(2, '0');

      // Duration: between 45 seconds to 6.5 minutes (45 to 390 seconds)
      const durationSeconds = 60 + ((p * 73 + dayOfWeek * 47) % 320);
      dayTotalSeconds += durationSeconds;

      const pickupStartTime = `${startH}:${startM}:${startS}`;
      
      // Calculate end time
      const endDate = new Date(d);
      endDate.setHours(slot.h, parseInt(startM, 10), parseInt(startS, 10) + durationSeconds);
      const endH = String(endDate.getHours()).padStart(2, '0');
      const endM = String(endDate.getMinutes()).padStart(2, '0');
      const endS = String(endDate.getSeconds()).padStart(2, '0');
      const pickupEndTime = `${endH}:${endM}:${endS}`;

      const modes = ['study', 'detox', 'idle'];
      const sessionMode = modes[p % 3];

      const pickupItem = {
        id: `pk_${dateStr}_${p + 1}`,
        date: dateStr,
        dayName: dayNamesThai[dayOfWeek],
        startTime: pickupStartTime,
        endTime: pickupEndTime,
        durationSeconds: durationSeconds,
        durationFormatted: formatSecondsToMinSec(durationSeconds),
        mode: sessionMode,
        note: sessionMode === 'study' ? 'หยิบขณะอ่านหนังสือ' : (sessionMode === 'detox' ? 'หยิบขณะโหมดพักมือถือ' : 'หยิบนอกเวลาโหมด')
      };

      dayPickups.push(pickupItem);
      allPickups.unshift(pickupItem); // newest first
    }

    const avgMinutesPerPickup = Number(((dayTotalSeconds / pickupCount) / 60).toFixed(1));
    const totalMinutes = Math.round(dayTotalSeconds / 60);

    weeklySummary.push({
      date: dateStr,
      dayShort: dayShortThai[dayOfWeek],
      dayFull: dayNamesThai[dayOfWeek],
      isToday: isToday,
      pickupsCount: pickupCount,
      totalSeconds: dayTotalSeconds,
      totalMinutes: totalMinutes,
      avgMinutesPerPickup: avgMinutesPerPickup
    });

    // Generate mock study/detox sessions
    allSessions.unshift({
      id: `sess_${dateStr}_1`,
      date: dateStr,
      type: 'study',
      targetMinutes: 25,
      actualMinutes: 25,
      completed: true,
      pickupsDuringSession: Math.min(2, Math.floor(pickupCount / 2)),
      timeRange: '10:00 - 10:25'
    });
    if (!isToday || new Date().getHours() > 14) {
      allSessions.unshift({
        id: `sess_${dateStr}_2`,
        date: dateStr,
        type: 'detox',
        targetMinutes: 45,
        actualMinutes: 45,
        completed: true,
        pickupsDuringSession: 0,
        timeRange: '14:00 - 14:45'
      });
    }
  }

  return {
    weeklySummary,
    allPickups,
    allSessions
  };
}

function formatSecondsToMinSec(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s} วินาที`;
  if (s === 0) return `${m} นาที`;
  return `${m} นาที ${s} วินาที`;
}

// Initial default settings
const DEFAULT_APP_STATE = {
  // Device & Timer state
  device: {
    connected: false,
    isDemoMode: true,
    phonePickedUp: false,         // true = phone in hand, false = on dock
    pickupStartedAt: null,        // timestamp when pickup began
    currentPickupDuration: 0,     // live seconds
    todayPickupsCount: 5,         // count for today
    todayTotalPickupSeconds: 780, // total seconds held today
    lastActionBy: 'hardware',     // 'hardware' or 'web'
    lastActionTimestamp: Date.now()
  },
  // Active Timer state
  timer: {
    mode: 'study',               // 'study' or 'detox'
    status: 'idle',              // 'idle', 'running', 'paused', 'break'
    currentPhase: 'study',       // 'study' or 'break'
    pomodoroCycle: 1,
    remainingSeconds: 25 * 60,   // seconds left
    totalPhaseSeconds: 25 * 60,
    elapsedSeconds: 0,
    startTime: null
  },
  // Configurable presets (can be changed via Web or Device)
  settings: {
    studyMinutes: 25,
    breakMinutes: 5,
    detoxMinutes: 45,
    soundAlert: true,
    vibrationAlert: true,
    firebase: {
      apiKey: '',
      authDomain: '',
      databaseURL: '',
      projectId: '',
      storageBucket: '',
      messagingSenderId: '',
      appId: '',
      deviceNodeId: 'focus_dock_01'
    }
  }
};
