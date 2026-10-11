// firebase-config.js - Firebase Realtime Database Manager with Offline Simulation Support
class FirebaseSyncManager {
  constructor() {
    this.db = null;
    this.app = null;
    this.isConnected = false;
    this.isDemoMode = true;
    this.listeners = [];
    this.config = this.loadConfig();
    this.deviceNode = this.config.deviceNodeId || 'focus_dock_01';
  }

  // Load saved credentials from localStorage
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
      apiKey: '',
      authDomain: '',
      databaseURL: '',
      projectId: '',
      storageBucket: '',
      messagingSenderId: '',
      appId: '',
      deviceNodeId: 'focus_dock_01'
    };
  }

  // Save credentials to localStorage
  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.deviceNode = this.config.deviceNodeId || 'focus_dock_01';
    localStorage.setItem('focusdock_firebase_config', JSON.stringify(this.config));
  }

  // Try initializing live Firebase connection
  async initializeFirebase(onStateChangeCallback) {
    if (!this.config.databaseURL && !this.config.apiKey) {
      console.log('No Firebase config provided. Operating in Demo/Local mode.');
      this.isDemoMode = true;
      this.isConnected = false;
      return false;
    }

    try {
      // Check if Firebase Compat SDK is loaded from CDN
      if (typeof firebase === 'undefined') {
        console.warn('Firebase SDK not loaded. Operating in Demo/Local mode.');
        this.isDemoMode = true;
        return false;
      }

      // Initialize App if not already initialized
      if (!firebase.apps.length) {
        this.app = firebase.initializeApp({
          apiKey: this.config.apiKey,
          authDomain: this.config.authDomain,
          databaseURL: this.config.databaseURL,
          projectId: this.config.projectId,
          storageBucket: this.config.storageBucket,
          messagingSenderId: this.config.messagingSenderId,
          appId: this.config.appId
        });
      } else {
        this.app = firebase.app();
      }

      this.db = firebase.database();
      this.isDemoMode = false;
      this.isConnected = true;
      console.log('Firebase successfully connected!');

      // Setup real-time listener for device state
      const stateRef = this.db.ref(`devices/${this.deviceNode}/state`);
      stateRef.on('value', (snapshot) => {
        const val = snapshot.val();
        if (val && typeof onStateChangeCallback === 'function') {
          onStateChangeCallback(val);
        }
      });

      // Track connectivity status
      const connectedRef = this.db.ref('.info/connected');
      connectedRef.on('value', (snap) => {
        this.isConnected = snap.val() === true;
        this.notifyConnectionState(this.isConnected);
      });

      return true;
    } catch (err) {
      console.error('Firebase initialization failed:', err);
      this.isConnected = false;
      this.isDemoMode = true;
      return false;
    }
  }

  onConnectionChange(callback) {
    this.listeners.push(callback);
  }

  notifyConnectionState(status) {
    this.listeners.forEach((cb) => {
      try {
        cb(status);
      } catch (e) {
        console.error(e);
      }
    });
  }

  // Send control command (Start / Pause / Reset) to Firebase
  async sendCommand(command, mode, settings) {
    const payload = {
      action: command, // 'START', 'PAUSE', 'RESET', 'CHANGE_MODE'
      mode: mode,
      settings: settings,
      triggeredBy: 'web',
      timestamp: Date.now()
    };

    if (this.db && !this.isDemoMode) {
      try {
        await this.db.ref(`devices/${this.deviceNode}/command`).set(payload);
        return true;
      } catch (err) {
        console.error('Failed to send command to Firebase:', err);
        return false;
      }
    } else {
      // In Demo Mode: simulate instant dispatch
      console.log('[Demo Mode] Command dispatched:', payload);
      return true;
    }
  }

  // Sync settings (Study duration, Break duration, Detox duration) to Firebase
  async updateSettings(settings) {
    if (this.db && !this.isDemoMode) {
      try {
        await this.db.ref(`devices/${this.deviceNode}/settings`).set({
          studyMinutes: Number(settings.studyMinutes),
          breakMinutes: Number(settings.breakMinutes),
          detoxMinutes: Number(settings.detoxMinutes),
          updatedAt: Date.now()
        });
        return true;
      } catch (err) {
        console.error('Failed to update settings in Firebase:', err);
        return false;
      }
    }
    return true;
  }

  // Push a new pickup record to Firebase Realtime Database
  async recordPickupEvent(pickupEvent) {
    if (this.db && !this.isDemoMode) {
      try {
        const newRef = this.db.ref(`devices/${this.deviceNode}/pickups`).push();
        await newRef.set(pickupEvent);
        return newRef.key;
      } catch (err) {
        console.error('Failed to record pickup event to Firebase:', err);
      }
    }
    return pickupEvent.id;
  }

  // Update hardware live status (used by hardware or simulator)
  async updateLiveHardwareState(stateUpdates) {
    if (this.db && !this.isDemoMode) {
      try {
        await this.db.ref(`devices/${this.deviceNode}/state`).update({
          ...stateUpdates,
          lastUpdated: Date.now()
        });
      } catch (err) {
        console.error('Failed to update hardware state:', err);
      }
    }
  }
}

// Global instance
window.focusDockFirebase = new FirebaseSyncManager();
