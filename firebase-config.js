// firebase-config.js - Firebase Realtime Database Manager for ESP32 & Web Sync
class FirebaseSyncManager {
  constructor() {
    this.db = null;
    this.auth = null;
    this.app = null;
    this.isConnected = false;
    this.isDemoMode = false;
    this.connectionListeners = [];
    this.config = this.loadConfig();
  }

  // Load saved credentials from localStorage or fallback to default ESP32 credentials
  loadConfig() {
    try {
      const saved = localStorage.getItem('focusdock_firebase_config');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not load saved Firebase config:', e);
    }
    return {
      apiKey: 'AIzaSyBgYBkuAVq-PdwWJxo4gmyyB-O4Xilsar8',
      databaseURL: 'https://readbook-may-default-rtdb.asia-southeast1.firebasedatabase.app/',
      projectId: 'readbook-may',
      userEmail: 'test0readbook@timer.com',
      userPassword: 'Mayyynarakkk83'
    };
  }

  // Save credentials to localStorage
  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    localStorage.setItem('focusdock_firebase_config', JSON.stringify(this.config));
  }

  // Initialize live Firebase connection with Email/Password Auth
  async initializeFirebase(onStatusCallback, onLogsCallback, onSessionsCallback) {
    if (!this.config.databaseURL || !this.config.apiKey) {
      console.warn('Firebase config missing databaseURL or apiKey');
      this.isDemoMode = true;
      this.isConnected = false;
      this.notifyConnectionState(false);
      return false;
    }

    try {
      if (typeof firebase === 'undefined') {
        console.warn('Firebase SDK not loaded.');
        this.isDemoMode = true;
        this.isConnected = false;
        this.notifyConnectionState(false);
        return false;
      }

      // Initialize App
      if (!firebase.apps.length) {
        this.app = firebase.initializeApp({
          apiKey: this.config.apiKey,
          databaseURL: this.config.databaseURL,
          projectId: this.config.projectId
        });
      } else {
        this.app = firebase.app();
      }

      this.db = firebase.database();

      // Sign in if auth SDK is present and credentials exist
      if (typeof firebase.auth === 'function' && this.config.userEmail && this.config.userPassword) {
        try {
          await firebase.auth().signInWithEmailAndPassword(this.config.userEmail, this.config.userPassword);
          console.log('Firebase Authenticated with user:', this.config.userEmail);
        } catch (authErr) {
          console.warn('Firebase Auth notice (will attempt anonymous or direct access):', authErr.message);
        }
      }

      this.isDemoMode = false;
      this.isConnected = true;
      console.log('Firebase Realtime Database initialized successfully!');
      this.notifyConnectionState(true);

      // 1. Real-time listener for /status from ESP32
      const statusRef = this.db.ref('status');
      statusRef.on('value', (snapshot) => {
        const val = snapshot.val();
        if (val && typeof onStatusCallback === 'function') {
          onStatusCallback(val);
        }
      }, (err) => {
        console.warn('Error reading /status:', err);
      });

      // 2. Real-time listener for /logs (Distractions / Pickups)
      const logsRef = this.db.ref('logs');
      logsRef.limitToLast(50).on('value', (snapshot) => {
        const val = snapshot.val();
        if (val && typeof onLogsCallback === 'function') {
          onLogsCallback(val);
        }
      }, (err) => {
        console.warn('Error reading /logs:', err);
      });

      // 3. Real-time listener for /sessions (Completed focus intervals)
      const sessionsRef = this.db.ref('sessions');
      sessionsRef.limitToLast(50).on('value', (snapshot) => {
        const val = snapshot.val();
        if (val && typeof onSessionsCallback === 'function') {
          onSessionsCallback(val);
        }
      }, (err) => {
        console.warn('Error reading /sessions:', err);
      });

      // 4. Track connectivity state
      const connectedRef = this.db.ref('.info/connected');
      connectedRef.on('value', (snap) => {
        this.isConnected = snap.val() === true;
        this.notifyConnectionState(this.isConnected);
      });

      return true;
    } catch (err) {
      console.error('Firebase initialization error:', err);
      this.isConnected = false;
      this.isDemoMode = true;
      this.notifyConnectionState(false);
      return false;
    }
  }

  onConnectionChange(callback) {
    this.connectionListeners.push(callback);
  }

  notifyConnectionState(status) {
    this.connectionListeners.forEach((cb) => {
      try {
        cb(status);
      } catch (e) {
        console.error(e);
      }
    });
  }

  // Trigger START from Web to ESP32 via /config
  async triggerStart(modeNum, durationSec) {
    if (!this.db) {
      console.warn('Firebase Database not ready yet for triggerStart');
      return false;
    }

    try {
      await this.db.ref('config').update({
        mode: Number(modeNum),
        durationSec: Number(durationSec),
        trigger: true,
        cancel: false,
        triggeredBy: 'web',
        updatedAt: Date.now()
      });
      console.log('Dispatched /config/trigger = true to ESP32');
      return true;
    } catch (err) {
      console.error('Failed to trigger start on Firebase:', err);
      return false;
    }
  }

  // Trigger CANCEL/RESET from Web to ESP32 via /config
  async triggerCancel() {
    if (!this.db) {
      console.warn('Firebase Database not ready yet for triggerCancel');
      return false;
    }

    try {
      await this.db.ref('config').update({
        cancel: true,
        trigger: false,
        triggeredBy: 'web',
        updatedAt: Date.now()
      });
      console.log('Dispatched /config/cancel = true to ESP32');
      return true;
    } catch (err) {
      console.error('Failed to trigger cancel on Firebase:', err);
      return false;
    }
  }

  // Update mode & duration configuration on ESP32
  async updateConfig(modeNum, durationSec) {
    if (!this.db) return false;

    try {
      await this.db.ref('config').update({
        mode: Number(modeNum),
        durationSec: Number(durationSec),
        updatedAt: Date.now()
      });
      console.log('Updated /config mode & durationSec on ESP32');
      return true;
    } catch (err) {
      console.error('Failed to update config on Firebase:', err);
      return false;
    }
  }

  // Update complete settings schema to Firebase for persistence
  async updateSettings(settings) {
    if (!settings || !this.db) return false;
    const modeNum = 1;
    const durationSec = (settings.studyMinutes || 25) * 60;
    try {
      await this.db.ref('config').update({
        mode: modeNum,
        durationSec: durationSec,
        studyMinutes: Number(settings.studyMinutes || 25),
        breakMinutes: Number(settings.breakMinutes || 5),
        detoxMinutes: Number(settings.detoxMinutes || 45),
        updatedAt: Date.now()
      });
      return true;
    } catch (err) {
      console.warn('Failed to update settings in Firebase:', err);
      return false;
    }
  }

  // Record pickup/distraction event to Firebase /logs
  async recordPickupEvent(pickup) {
    if (!this.db || !pickup) return false;
    try {
      const epochMs = pickup.timestamp || Date.now();
      const key = String(Math.floor(epochMs / 1000));
      await this.db.ref(`logs/${key}`).set({
        event: pickup.type || 'phone_removed',
        mode: pickup.mode === 'detox' ? 2 : 1,
        durationSec: pickup.durationSeconds || 15,
        remainingSec: 0,
        timestamp: epochMs
      });
      return true;
    } catch (e) {
      console.warn('Could not record pickup event to Firebase:', e);
      return false;
    }
  }

  // Unified sendCommand compatible with direct controller dispatcher
  async sendCommand(action, mode, settings) {
    if (action === 'START' || action === 'START_TOGGLE') {
      const modeNum = (mode === 'detox' || mode === 2) ? 2 : 1;
      const durationSec = ((modeNum === 2 ? settings?.detoxMinutes : settings?.studyMinutes) || 25) * 60;
      return this.triggerStart(modeNum, durationSec);
    } else if (action === 'CANCEL' || action === 'RESET') {
      return this.triggerCancel();
    }
    return false;
  }
}

// Global instance
window.focusDockFirebase = new FirebaseSyncManager();
