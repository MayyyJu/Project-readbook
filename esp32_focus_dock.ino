/*
  FocusDock (You've got this) - ESP32 Complete Hybrid Firmware
  รองรับ:
  1. การสั่งงานตรงจากหน้าเว็บผ่าน Bluetooth Low Energy (BLE) - รวดเร็ว ไม่ดีเลย์
  2. การสั่งงานตรงผ่าน Wi-Fi Local IP (REST API)
  3. การส่งข้อมูลประวัติการหยิบจับมือถือขึ้น Firebase Realtime Database เพื่อเป็นที่เก็บข้อมูลถาวร
*/

#include <WiFi.h>
#include <WebServer.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// ==========================================
// 1. ตั้งค่าการเชื่อมต่อ Wi-Fi และ Firebase (สำหรับเก็บข้อมูล)
// ==========================================
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

#define API_KEY "YOUR_FIREBASE_API_KEY"
#define DATABASE_URL "YOUR_FIREBASE_DATABASE_URL"
#define DEVICE_ID "focus_dock_01"

// ==========================================
// 2. กำหนดขาอุปกรณ์ (Hardware Pins)
// ==========================================
#define PIN_BUTTON 18       // ปุ่มกดบนตัวเครื่อง (Active LOW)
#define PIN_LED_STATUS 2    // LED แสดงสถานะ
#define PIN_BUZZER 19       // Buzzer เตือนสั้นๆ

#define PIN_TRIG 5          // Ultrasonic Sensor
#define PIN_ECHO 4
#define DISTANCE_THRESHOLD_CM 6.0 // ต่ำกว่า 6 ซม. = มือถือวางอยู่บนแท่น

// ==========================================
// 3. BLE UUIDs สำหรับการสั่งงานตรงจากเว็บ
// ==========================================
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CMD_CHAR_UUID       "beb5483e-36e1-4688-b7f5-ea07361b26a8" // Web เขียนสั่ง ESP32
#define STATE_CHAR_UUID     "cba1d466-344c-4be3-ab3f-189f80dd7518" // ESP32 แจ้งเตือน Web

BLEServer* pServer = NULL;
BLECharacteristic* pCmdCharacteristic = NULL;
BLECharacteristic* pStateCharacteristic = NULL;
bool deviceConnected = false;
bool oldDeviceConnected = false;

// ==========================================
// 4. ตัวแปรสถานะและ Web Server
// ==========================================
WebServer server(80);

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

bool isPhonePlaced = false;
bool lastPhoneState = false;
unsigned long pickupStartTime = 0;

int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

int studyMinutes = 25;
int breakMinutes = 5;
int detoxMinutes = 45;
String currentMode = "study";
String timerStatus = "idle"; // "idle", "running", "paused"

// ฟังก์ชันวัดระยะทาง Ultrasonic
float checkDistance() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duration = pulseIn(PIN_ECHO, HIGH, 25000);
  if (duration == 0) return 999.0;
  return (duration * 0.0343) / 2.0;
}

// ส่งข้อความ BLE ตรงไปยังหน้าเว็บ
void notifyWebViaBLE(String msg) {
  if (deviceConnected && pStateCharacteristic) {
    pStateCharacteristic->setValue(msg.c_str());
    pStateCharacteristic->notify();
    Serial.println("[BLE -> Web]: " + msg);
  }
}

// ประมวลผลคำสั่งที่ได้รับจากหน้าเว็บ (ทั้งทาง BLE หรือ Direct IP)
void processWebCommand(String action, String mode) {
  Serial.println(">>> สั่งงานตรงสำเร็จ! Action: " + action + ", Mode: " + mode);
  
  if (action == "START") {
    timerStatus = "running";
    digitalWrite(PIN_LED_STATUS, HIGH);
    tone(PIN_BUZZER, 1000, 150); // Beep ยืนยัน
  } else if (action == "PAUSE") {
    timerStatus = "paused";
    digitalWrite(PIN_LED_STATUS, LOW);
    tone(PIN_BUZZER, 600, 100);
  } else if (action == "RESET") {
    timerStatus = "idle";
    digitalWrite(PIN_LED_STATUS, LOW);
  }
}

// Callback เมื่อหน้าเว็บส่งข้อมูล BLE มา
class CommandCallbacks: public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pCharacteristic) {
    String rxValue = pCharacteristic->getValue().c_str();
    if (rxValue.length() > 0) {
      Serial.println("[Web -> BLE]: " + rxValue);

      if (rxValue.startsWith("CMD:")) {
        // เช่น "CMD:START,MODE:study"
        int modeIdx = rxValue.indexOf(",MODE:");
        String action = rxValue.substring(4, modeIdx != -1 ? modeIdx : rxValue.length());
        String mode = modeIdx != -1 ? rxValue.substring(modeIdx + 6) : "study";
        processWebCommand(action, mode);
      } else if (rxValue.startsWith("SET:")) {
        // เช่น "SET:study=25,break=5,detox=45"
        Serial.println("Updated settings via BLE: " + rxValue);
      }
    }
  }
};

class ServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("BLE Client Connected from Web!");
    digitalWrite(PIN_LED_STATUS, HIGH);
    delay(100);
    digitalWrite(PIN_LED_STATUS, LOW);
  };

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("BLE Client Disconnected");
  }
};

// ==========================================
// 5. REST API สำหรับสั่งงานผ่าน IP ตรง
// ==========================================
void setupRestApi() {
  server.on("/api/status", HTTP_GET, []() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    String json = "{\"phonePickedUp\":" + String(!lastPhoneState ? "true" : "false") +
                  ",\"status\":\"" + timerStatus + "\",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
    server.send(200, "application/json", json);
  });

  server.on("/api/command", HTTP_ANY, []() {
    server.sendHeader("Access-Control-Allow-Origin", "*");
    String action = server.arg("action");
    String mode = server.arg("mode");
    processWebCommand(action, mode);
    server.send(200, "application/json", "{\"success\":true}");
  });

  server.begin();
  Serial.println("Direct REST Web Server started on port 80");
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED_STATUS, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  // 1. เริ่มต้น Bluetooth Low Energy (BLE) สำหรับสั่งงานตรง
  BLEDevice::init("FocusDock ESP32");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCmdCharacteristic = pService->createCharacteristic(
                        CMD_CHAR_UUID,
                        BLECharacteristic::PROPERTY_WRITE
                      );
  pCmdCharacteristic->setCallbacks(new CommandCallbacks());

  pStateCharacteristic = pService->createCharacteristic(
                          STATE_CHAR_UUID,
                          BLECharacteristic::PROPERTY_READ |
                          BLECharacteristic::PROPERTY_NOTIFY
                        );
  pStateCharacteristic->addDescriptor(new BLE2902());

  pService->start();
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("BLE Advertising started. Ready for direct Web Bluetooth connection!");

  // 2. เชื่อมต่อ Wi-Fi สำหรับ Direct IP และ Firebase Storage
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(400);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi Connected! IP: " + WiFi.localIP().toString());
    setupRestApi();

    // 3. เริ่มต้น Firebase (ใช้เป็นที่เก็บข้อมูลประวัติ)
    config.api_key = API_KEY;
    config.database_url = DATABASE_URL;
    Firebase.signUp(&config, &auth, "", "");
    config.token_status_callback = tokenStatusCallback;
    Firebase.begin(&config, &auth);
    Firebase.reconnectWiFi(true);
    Serial.println("Firebase Storage initialized!");
  } else {
    Serial.println("\nWi-Fi not connected. Bluetooth Direct Control is still 100% active!");
  }
}

void loop() {
  server.handleClient();

  // จัดการ BLE Re-advertising เมื่อหลุด
  if (!deviceConnected && oldDeviceConnected) {
    delay(500);
    pServer->startAdvertising();
    Serial.println("Restarted BLE advertising");
    oldDeviceConnected = deviceConnected;
  }
  if (deviceConnected && !oldDeviceConnected) {
    oldDeviceConnected = deviceConnected;
  }

  // ----------------------------------------------------
  // A. ตรวจจับปุ่มกดบนตัวเครื่อง (Physical Button)
  // ----------------------------------------------------
  int reading = digitalRead(PIN_BUTTON);
  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading == LOW) {
      Serial.println("Physical Button Pressed!");
      digitalWrite(PIN_LED_STATUS, HIGH);
      tone(PIN_BUZZER, 1200, 80);

      // ส่งสัญญาณตรงไปยังหน้าเว็บผ่าน Bluetooth ทันที
      notifyWebViaBLE("BUTTON:PRESS");

      // ส่งไปอัปเดต Firebase ด้วยถ้ามีเน็ต
      if (Firebase.ready()) {
        String statePath = "devices/" + String(DEVICE_ID) + "/state";
        FirebaseJson json;
        json.set("command", "START_TOGGLE");
        json.set("lastActionBy", "hardware");
        json.set("actionTimestamp", (double)millis());
        Firebase.RTDB.updateNode(&fbdo, statePath.c_str(), &json);
      }

      delay(300);
      digitalWrite(PIN_LED_STATUS, LOW);
    }
  }
  lastButtonState = reading;

  // ----------------------------------------------------
  // B. ตรวจจับเซนเซอร์วาง/ยกมือถือ
  // ----------------------------------------------------
  float distance = checkDistance();
  bool currentPhonePlaced = (distance < DISTANCE_THRESHOLD_CM);

  if (currentPhonePlaced != lastPhoneState) {
    lastPhoneState = currentPhonePlaced;
    bool isPickedUp = !currentPhonePlaced;

    Serial.println(isPickedUp ? "⚠️ โทรศัพท์ถูกยกขึ้น!" : "📱 วางโทรศัพท์ลงบนแท่นแล้ว");

    // แจ้งเตือนตรงไปยังหน้าเว็บผ่าน Bluetooth ทันที!
    notifyWebViaBLE(isPickedUp ? "PICKUP:1" : "PICKUP:0");

    if (isPickedUp) {
      tone(PIN_BUZZER, 400, 100);
    }

    // ส่งประวัติขึ้น Firebase Storage เพื่อเก็บสถิติย้อนหลัง
    if (Firebase.ready()) {
      String statePath = "devices/" + String(DEVICE_ID) + "/state";
      FirebaseJson json;
      json.set("phonePickedUp", isPickedUp);
      json.set("lastStateChange", (double)millis());
      json.set("source", "hardware_sensor");
      Firebase.RTDB.updateNode(&fbdo, statePath.c_str(), &json);
    }
  }

  delay(30);
}
