// esp32-direct.js - Direct Hardware Controller for ESP32 (Web Bluetooth & Direct WiFi REST)
// รองรับการสั่งงานตรงไปยังบอร์ด ESP32 โดยไม่ต้องผ่านตัวกลาง และบันทึกข้อมูลประวัติลง Firebase

class ESP32DirectController {
  constructor() {
    // BLE UUIDs for FocusDock
    this.SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
    this.CMD_CHAR_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'; // Web -> ESP32 (Write)
    this.STATE_CHAR_UUID = 'cba1d466-344c-4be3-ab3f-189f80dd7518'; // ESP32 -> Web (Notify)

    this.bleDevice = null;
    this.bleServer = null;
    this.cmdCharacteristic = null;
    this.stateCharacteristic = null;

    this.isBleConnected = false;
    this.isIpConnected = false;
    this.esp32Ip = this.loadEsp32Ip();

    this.onHardwareStateChange = null;
    this.onConnectionStatusChange = null;
  }

  loadEsp32Ip() {
    return localStorage.getItem('focusdock_esp32_ip') || '';
  }

  saveEsp32Ip(ip) {
    this.esp32Ip = ip.trim();
    localStorage.setItem('focusdock_esp32_ip', this.esp32Ip);
  }

  // ==========================================
  // 1. Web Bluetooth (BLE) Direct Connection
  // ==========================================
  isBleSupported() {
    return 'bluetooth' in navigator;
  }

  async connectBLE() {
    if (!this.isBleSupported()) {
      throw new Error('เบราว์เซอร์นี้ยังไม่รองรับ Web Bluetooth (แนะนำให้ใช้ Chrome บน Android หรือคอมพิวเตอร์)');
    }

    try {
      console.log('Requesting Bluetooth Device...');
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: 'FocusDock' },
          { namePrefix: 'YouveGotThis' }
        ],
        optionalServices: [this.SERVICE_UUID]
      });

      this.bleDevice.addEventListener('gattserverdisconnected', () => {
        this.isBleConnected = false;
        console.warn('ESP32 Bluetooth Disconnected');
        if (this.onConnectionStatusChange) {
          this.onConnectionStatusChange('ble', false);
        }
      });

      console.log('Connecting to GATT Server...');
      this.bleServer = await this.bleDevice.gatt.connect();

      console.log('Getting Service...');
      const service = await this.bleServer.getPrimaryService(this.SERVICE_UUID);

      console.log('Getting Characteristics...');
      this.cmdCharacteristic = await service.getCharacteristic(this.CMD_CHAR_UUID);
      this.stateCharacteristic = await service.getCharacteristic(this.STATE_CHAR_UUID);

      // Start notifications from ESP32 to Web
      await this.stateCharacteristic.startNotifications();
      this.stateCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
        const value = new TextDecoder().decode(event.target.value);
        this.handleBleIncomingMessage(value);
      });

      this.isBleConnected = true;
      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange('ble', true);
      }

      console.log('BLE Successfully Connected to ESP32!');
      return true;
    } catch (err) {
      this.isBleConnected = false;
      console.error('BLE Connection Failed:', err);
      throw err;
    }
  }

  async disconnectBLE() {
    if (this.bleDevice && this.bleDevice.gatt.connected) {
      await this.bleDevice.gatt.disconnect();
    }
    this.isBleConnected = false;
    if (this.onConnectionStatusChange) {
      this.onConnectionStatusChange('ble', false);
    }
  }

  // Handle messages sent from ESP32 over Bluetooth
  handleBleIncomingMessage(message) {
    console.log('[ESP32 -> Web BLE]:', message);
    if (!this.onHardwareStateChange) return;

    try {
      // Examples: "PICKUP:1", "PICKUP:0", "BUTTON:PRESS"
      if (message.startsWith('PICKUP:')) {
        const isPickedUp = message.split(':')[1] === '1';
        this.onHardwareStateChange({ phonePickedUp: isPickedUp, source: 'esp32_ble' });
      } else if (message.startsWith('BUTTON:')) {
        this.onHardwareStateChange({ command: 'START_TOGGLE', source: 'esp32_ble' });
      } else if (message.startsWith('{')) {
        const json = JSON.parse(message);
        this.onHardwareStateChange(json);
      }
    } catch (e) {
      console.warn('Error parsing incoming BLE data:', e);
    }
  }

  // Send Command directly to ESP32 via Bluetooth
  async sendCommandBLE(action, mode, settings) {
    if (!this.cmdCharacteristic || !this.isBleConnected) return false;

    try {
      const payload = `CMD:${action},MODE:${mode || 'study'}`;
      const encoder = new TextEncoder();
      await this.cmdCharacteristic.writeValue(encoder.encode(payload));
      console.log('[Web -> ESP32 BLE sent]:', payload);
      return true;
    } catch (err) {
      console.error('Failed to send BLE command:', err);
      return false;
    }
  }

  // Send Setting Durations directly to ESP32 via Bluetooth
  async sendSettingsBLE(settings) {
    if (!this.cmdCharacteristic || !this.isBleConnected) return false;

    try {
      const payload = `SET:study=${settings.studyMinutes},break=${settings.breakMinutes},detox=${settings.detoxMinutes}`;
      const encoder = new TextEncoder();
      await this.cmdCharacteristic.writeValue(encoder.encode(payload));
      console.log('[Web -> ESP32 BLE Settings sent]:', payload);
      return true;
    } catch (err) {
      console.error('Failed to send BLE settings:', err);
      return false;
    }
  }

  // ==========================================
  // 2. Direct WiFi IP (REST API) Connection
  // ==========================================
  async testDirectIpConnection(ip) {
    const targetIp = (ip || this.esp32Ip).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!targetIp) throw new Error('กรุณากรอก IP Address ของ ESP32');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`http://${targetIp}/api/status`, {
        signal: controller.signal,
        mode: 'cors'
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        this.saveEsp32Ip(targetIp);
        this.isIpConnected = true;
        if (this.onConnectionStatusChange) {
          this.onConnectionStatusChange('ip', true);
        }
        return data;
      }
      throw new Error(`เชื่อมต่อไม่สำเร็จ (Status: ${res.status})`);
    } catch (err) {
      this.isIpConnected = false;
      if (this.onConnectionStatusChange) {
        this.onConnectionStatusChange('ip', false);
      }
      throw err;
    }
  }

  async sendCommandIp(action, mode, settings) {
    if (!this.esp32Ip) return false;

    try {
      const url = `http://${this.esp32Ip}/api/command?action=${action}&mode=${mode}`;
      await fetch(url, { method: 'POST', mode: 'no-cors' });
      console.log('[Web -> ESP32 IP sent]:', action);
      return true;
    } catch (e) {
      console.warn('IP command send error:', e);
      return false;
    }
  }

  async sendSettingsIp(settings) {
    if (!this.esp32Ip) return false;

    try {
      const url = `http://${this.esp32Ip}/api/settings?study=${settings.studyMinutes}&break=${settings.breakMinutes}&detox=${settings.detoxMinutes}`;
      await fetch(url, { method: 'POST', mode: 'no-cors' });
      console.log('[Web -> ESP32 IP settings sent]');
      return true;
    } catch (e) {
      console.warn('IP settings send error:', e);
      return false;
    }
  }

  // ==========================================
  // 3. Unified Dispatcher (Direct First)
  // ==========================================
  async dispatchDirectCommand(action, mode, settings) {
    let sent = false;

    // 1. Try BLE directly if connected
    if (this.isBleConnected) {
      sent = await this.sendCommandBLE(action, mode, settings);
    }

    // 2. Try Direct IP if configured
    if (!sent && this.isIpConnected && this.esp32Ip) {
      sent = await this.sendCommandIp(action, mode, settings);
    }

    // 3. Always dispatch to Firebase Realtime Database for persistent sync & storage
    if (window.focusDockFirebase) {
      window.focusDockFirebase.sendCommand(action, mode, settings);
    }

    return sent;
  }

  async dispatchDirectSettings(settings) {
    let sent = false;
    if (this.isBleConnected) {
      sent = await this.sendSettingsBLE(settings);
    }
    if (!sent && this.isIpConnected && this.esp32Ip) {
      sent = await this.sendSettingsIp(settings);
    }
    if (window.focusDockFirebase) {
      window.focusDockFirebase.updateSettings(settings);
    }
    return sent;
  }
}

// Global instance
window.esp32Direct = new ESP32DirectController();
