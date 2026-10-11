/*
  FocusDock - ESP32 Firmware for Smart Phone Focus Dock
  โค้ดสำหรับไมโครคอนโทรลเลอร์ ESP32 เชื่อมต่อกับ Firebase Realtime Database
  
  ฟังก์ชันการทำงาน:
  1. ตรวจจับการวาง / ยกมือถือขึ้นจากแท่นวาง (ใช้เซนเซอร์ เช่น Ultrasonic HC-SR04 หรือ IR / Limit Switch)
  2. รองรับปุ่มกดจริงที่ตัวเครื่อง (Push Button) เพื่อเริ่ม/พักการทำงาน และส่งสถานะไปที่ Firebase
  3. รับคำสั่งและการตั้งค่าเวลา (โหมดอ่านหนังสือ & โหมดพักมือถือ) จากหน้าเว็บผ่าน Firebase
  4. แสดงผลสถานะผ่าน LED หรือจอ OLED (ถ้ามี)
*/

#include <WiFi.h>
#include <Firebase_ESP_Client.h>
// Provide the token generation process info.
#include "addons/TokenHelper.h"
// Provide the RTDB payload printing info and other helper functions.
#include "addons/RTDBHelper.h"

// ==========================================
// 1. การตั้งค่า WiFi และ Firebase
// ==========================================
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// นำมาจาก Firebase Console > Project Settings
#define API_KEY "YOUR_FIREBASE_API_KEY"
// URL ของ Realtime Database เช่น https://your-project-id-default-rtdb.firebaseio.com/
#define DATABASE_URL "YOUR_FIREBASE_DATABASE_URL"

// Node ID ของอุปกรณ์นี้ใน Firebase
#define DEVICE_ID "focus_dock_01"

// ==========================================
// 2. กำหนดขาต่อฮาร์ดแวร์ (Hardware Pins)
// ==========================================
#define PIN_BUTTON 18       // ปุ่มกดบนตัวเครื่อง (Active LOW หรือใช้ PULLUP)
#define PIN_LED_STATUS 2    // ไฟ LED แสดงสถานะ
#define PIN_BUZZER 19       // บัซเซอร์ส่งเสียงเตือนเบาๆ เมื่อหยิบมือถือ

// เซนเซอร์ตรวจจับมือถือ (ตัวอย่าง: Ultrasonic HC-SR04)
#define PIN_TRIG 5
#define PIN_ECHO 4
#define DISTANCE_THRESHOLD_CM 5.0 // ถ้าระยะต่ำกว่า 5 ซม. = มือถือวางอยู่บนแท่น

// ==========================================
// 3. ตัวแปรสถานะระบบ
// ==========================================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

bool isPhonePlaced = false;
bool lastPhoneState = false;
unsigned long pickupStartMillis = 0;

// Button debounce
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

// Timer & settings synced from web
int studyMinutes = 25;
int breakMinutes = 5;
int detoxMinutes = 45;
String currentMode = "study"; // "study" หรือ "detox"
String timerStatus = "idle";  // "idle", "running", "paused", "break"

// ฟังก์ชันวัดระยะทางของเซนเซอร์ Ultrasonic
float checkDistance() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);

  long duration = pulseIn(PIN_ECHO, HIGH, 30000); // timeout 30ms
  if (duration == 0) return 999.0;
  return (duration * 0.0343) / 2.0;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUTTON, INPUT_PULLUP);
  pinMode(PIN_LED_STATUS, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);

  // 1. เชื่อมต่อ WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(300);
  }
  Serial.println("\nConnected to Wi-Fi! IP: " + WiFi.localIP().toString());

  // 2. ตั้งค่า Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  // Sign up anon or email
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase Auth OK");
  } else {
    Serial.printf("Firebase Auth Error: %s\n", config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.println("FocusDock Ready!");
}

void loop() {
  if (!Firebase.ready()) return;

  // ----------------------------------------------------
  // A. ตรวจจับการกดปุ่มที่ตัวเครื่อง (Physical Button)
  // ----------------------------------------------------
  int reading = digitalRead(PIN_BUTTON);
  if (reading != lastButtonState) {
    lastDebounceTime = millis();
  }

  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading == LOW) { // กดปุ่ม
      Serial.println("Physical button pressed on device!");
      digitalWrite(PIN_LED_STATUS, HIGH);

      // ส่งสัญญาณไปที่ Firebase เพื่อเริ่ม/สลับการทำงาน
      String statePath = "devices/" + String(DEVICE_ID) + "/state";
      FirebaseJson json;
      json.set("command", "START_TOGGLE");
      json.set("lastActionBy", "hardware");
      json.set("actionTimestamp", (double)millis());
      Firebase.RTDB.updateNode(&fbdo, statePath.c_str(), &json);

      delay(300); // ป้องกันการกดย้ำ
      digitalWrite(PIN_LED_STATUS, LOW);
    }
  }
  lastButtonState = reading;

  // ----------------------------------------------------
  // B. ตรวจจับเซนเซอร์วางมือถือ (Phone Sensor)
  // ----------------------------------------------------
  float distance = checkDistance();
  bool currentPhonePlaced = (distance < DISTANCE_THRESHOLD_CM);

  // ตรวจจับเมื่อสถานะเปลี่ยน (หยิบขึ้น หรือ วางลง)
  if (currentPhonePlaced != lastPhoneState) {
    lastPhoneState = currentPhonePlaced;
    bool isPickedUp = !currentPhonePlaced;

    Serial.println(isPickedUp ? "⚠️ โทรศัพท์ถูกยกขึ้น!" : "📱 วางโทรศัพท์ลงบนแท่นแล้ว");

    // แจ้งเตือนด้วยเสียงสั้นๆ
    if (isPickedUp) {
      digitalWrite(PIN_BUZZER, HIGH);
      delay(80);
      digitalWrite(PIN_BUZZER, LOW);
    }

    // อัปเดตสถานะไปที่ Firebase Realtime Database
    String statePath = "devices/" + String(DEVICE_ID) + "/state";
    FirebaseJson json;
    json.set("phonePickedUp", isPickedUp);
    json.set("lastStateChange", (double)millis());
    json.set("source", "hardware_sensor");
    Firebase.RTDB.updateNode(&fbdo, statePath.c_str(), &json);
  }

  // ----------------------------------------------------
  // C. เช็คคำสั่งจากหน้าเว็บ (Web Command Listener)
  // ----------------------------------------------------
  static unsigned long lastCheckWebTime = 0;
  if (millis() - lastCheckWebTime > 1500) { // ตรวจสอบทุกๆ 1.5 วินาที
    lastCheckWebTime = millis();

    String cmdPath = "devices/" + String(DEVICE_ID) + "/command";
    if (Firebase.RTDB.getJSON(&fbdo, cmdPath.c_str())) {
      FirebaseJson &cmdJson = fbdo.jsonObject();
      FirebaseJsonData actionData;
      cmdJson.get(actionData, "action");

      if (actionData.success) {
        String action = actionData.stringValue;
        Serial.println("Received Command from Web: " + action);
        // สามารถนำไปสั่งไฟ LED หรือเริ่มนับเวลาที่ตัวเครื่องได้
      }
    }

    // อ่านค่าการตั้งค่าเวลาจากหน้าเว็บ
    String settingsPath = "devices/" + String(DEVICE_ID) + "/settings";
    if (Firebase.RTDB.getJSON(&fbdo, settingsPath.c_str())) {
      FirebaseJson &setJson = fbdo.jsonObject();
      FirebaseJsonData sM, bM, dM;
      if (setJson.get(sM, "studyMinutes")) studyMinutes = sM.intValue;
      if (setJson.get(bM, "breakMinutes")) breakMinutes = bM.intValue;
      if (setJson.get(dM, "detoxMinutes")) detoxMinutes = dM.intValue;
    }
  }

  delay(50);
}
