#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <Firebase_ESP_Client.h>
#include <WiFi.h>
#include <Wire.h>
#include <hp_BH1750.h>
#include <time.h>

// --- Configuration Wi-Fi & Firebase ---
#define WIFI_SSID "1272_2.4GHz"
#define WIFI_PASSWORD "meijimamrom"
#define DATABASE_URL                                                           \
  "https://readbook-may-default-rtdb.asia-southeast1.firebasedatabase.app/"

#define API_KEY "AIzaSyBgYBkuAVq-PdwWJxo4gmyyB-O4Xilsar8"
#define USER_EMAIL "test0readbook@timer.com"
#define USER_PASSWORD "Mayyynarakkk83"

// --- Pin Definitions ---
#define DHTPIN 4 // D4
#define DHTTYPE DHT11
#define IR_PIN 19 // D19

// ปุ่มกดตามที่คุณเมกำหนด
#define BTN_RED_PIN 17    // TX2 (Power / Cancel)
#define BTN_YELLOW_PIN 15 // D15 (Mode)
#define BTN_BLUE_PIN 5    // D5  (Time Adjust)
#define BTN_GREEN_PIN 16  // RX2 (Start / Repeat)

// --- OLED Settings (แยก Bus I2C) ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT_MAIN 64
#define SCREEN_HEIGHT_SUB 32

// สร้างวัตถุ I2C สองบัสแยกกันโดยเด็ดขาด
TwoWire I2C_Main =
    TwoWire(0); // บัสหลัก: D21 (SDA), D22 (SCL) -> จอหลัก + BH1750 x2
TwoWire I2C_Sub = TwoWire(1); // บัสรอง:  D23 (SDA), D18 (SCL) -> จอรอง 0.91"

Adafruit_SSD1306 displayMain(SCREEN_WIDTH, SCREEN_HEIGHT_MAIN, &I2C_Main, -1);
Adafruit_SSD1306 displaySub(SCREEN_WIDTH, SCREEN_HEIGHT_SUB, &I2C_Sub, -1);

// --- Objects ---
DHT dht(DHTPIN, DHTTYPE);
hp_BH1750 bh1750_room;  // ต่ออยู่กับ I2C_Main (Address 0x23)
hp_BH1750 bh1750_phone; // ต่ออยู่กับ I2C_Main (Address 0x5C)

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

enum SystemState {
  STATE_IDLE,
  STATE_COUNTDOWN_PREPARE,
  STATE_RUNNING,
  STATE_CONFIRM_CANCEL,
  STATE_FINISHED
};

SystemState currentState = STATE_IDLE;

// --- Variables ---
int currentMode = 1;
int durationSec = 600; // 10 นาทีเริ่มต้น
int remainingSec = 0;
int prepareSec = 0;
bool isWebStart = false;

bool phonePlaced = false;
bool handDetected = false;
float roomLux = 0, phoneLux = 0;
float temp = 0, hum = 0;

// Button Debounce & Timing Management
unsigned long redPressTime = 0;
bool redHandled = false;

unsigned long bluePressTime = 0;
bool blueLongBeepPlayed = false;

unsigned long cancelConfirmStart = 0;
unsigned long lastTimerMillis = 0;
unsigned long firebaseSyncMillis = 0;

unsigned long lastDistractionAlertMillis = 0;
const unsigned long DISTRACTION_COOLDOWN = 3000;

const char *ntpServer = "pool.ntp.org";

unsigned long long getEpochTimeMs() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return ((unsigned long long)tv.tv_sec * 1000ULL) + (tv.tv_usec / 1000ULL);
}

void playBuzzerBeep(int freq, int durationMs) {
  // เนื่องจาก D18 ถูกย้ายไปใช้เป็น SCL ของจอรองแล้ว จึงขอย้าย Buzzer ไปพินสำรองอิสระ (เช่น
  // D2) หรือถ้ายังอยากใช้ขาเดิม สามารถใช้ tone ปกติได้หากไม่มีการชนขาลำโพง
  tone(2, freq, durationMs); // ใช้พิน D2 สำหรับ Buzzer แทนเพื่อความปลอดภัยไม่ชนบัสจอรอง
}

void playAlertSound() { tone(2, 2000, 300); }

void enterDeepSleep() {
  displayMain.clearDisplay();
  displayMain.setCursor(10, 25);
  displayMain.setTextSize(2);
  displayMain.setTextColor(WHITE);
  displayMain.println("POWER OFF");
  displayMain.display();

  displaySub.clearDisplay();
  displaySub.display();
  delay(1000);

  esp_sleep_enable_ext0_wakeup((gpio_num_t)BTN_RED_PIN, 0);
  esp_deep_sleep_start();
}

void updateFirebaseLiveStatus() {
  String base = "/status";
  Firebase.RTDB.setFloat(&fbdo, base + "/temp", isnan(temp) ? 0 : temp);
  Firebase.RTDB.setFloat(&fbdo, base + "/hum", isnan(hum) ? 0 : hum);
  Firebase.RTDB.setFloat(&fbdo, base + "/roomLux", roomLux);
  Firebase.RTDB.setFloat(&fbdo, base + "/phoneLux", phoneLux);
  Firebase.RTDB.setBool(&fbdo, base + "/phonePlaced", phonePlaced);
  Firebase.RTDB.setBool(&fbdo, base + "/handDetected", handDetected);
  Firebase.RTDB.setInt(
      &fbdo, base + "/remainingSec",
      (currentState == STATE_COUNTDOWN_PREPARE) ? prepareSec : remainingSec);
  Firebase.RTDB.setInt(&fbdo, base + "/prepareSec", prepareSec);
  Firebase.RTDB.setInt(&fbdo, base + "/currentMode", currentMode);
  Firebase.RTDB.setInt(&fbdo, base + "/durationSec", durationSec);

  String stateStr = "IDLE";
  if (currentState == STATE_COUNTDOWN_PREPARE)
    stateStr = "PREPARE";
  else if (currentState == STATE_RUNNING)
    stateStr = "RUNNING";
  else if (currentState == STATE_CONFIRM_CANCEL)
    stateStr = "CONFIRM_CANCEL";
  else if (currentState == STATE_FINISHED)
    stateStr = "FINISHED";

  Firebase.RTDB.setString(&fbdo, base + "/state", stateStr);
}

void logDistractionEvent(String reason) {
  unsigned long long epochMs = getEpochTimeMs();
  if (epochMs < 1000000000ULL) {
    epochMs = 1728663000000ULL + millis();
  }
  String path = "/logs/" + String((unsigned long)(epochMs / 1000));

  Firebase.RTDB.setString(&fbdo, path + "/event", reason);
  Firebase.RTDB.setInt(&fbdo, path + "/mode", currentMode);
  Firebase.RTDB.setInt(&fbdo, path + "/remainingSec", remainingSec);
  Firebase.RTDB.setDouble(&fbdo, path + "/timestamp", (double)epochMs);
}

void logSessionCompleted() {
  unsigned long long epochMs = getEpochTimeMs();
  if (epochMs < 1000000000ULL) {
    epochMs = 1728663000000ULL + millis();
  }
  String path = "/sessions/" + String((unsigned long)(epochMs / 1000));

  Firebase.RTDB.setInt(&fbdo, path + "/mode", currentMode);
  Firebase.RTDB.setInt(&fbdo, path + "/durationSec", durationSec);
  Firebase.RTDB.setBool(&fbdo, path + "/completed", true);
  Firebase.RTDB.setDouble(&fbdo, path + "/timestamp", (double)epochMs);
}

void setup() {
  Serial.begin(115200);

  pinMode(BTN_RED_PIN, INPUT_PULLUP);
  pinMode(BTN_YELLOW_PIN, INPUT_PULLUP);
  pinMode(BTN_BLUE_PIN, INPUT_PULLUP);
  pinMode(BTN_GREEN_PIN, INPUT_PULLUP);
  pinMode(IR_PIN, INPUT);
  pinMode(2, OUTPUT); // พิน Buzzer (ย้ายมาใช้พิน D2 เพื่อไม่ให้ชนกับ SCL จอรอง D18)

  // เริ่มต้น I2C สองบัสแยกกันอย่างอิสระ
  I2C_Main.begin(21, 22); // SDA=D21, SCL=D22 (จอหลัก + เซนเซอร์ BH1750 ทั้งสองตัว)
  I2C_Sub.begin(23, 18);  // SDA=D23, SCL=D18 (จอรอง 0.91" แยกเด็ดขาด)

  dht.begin();

  bh1750_room.begin(BH1750_TO_GROUND, &I2C_Main);
  bh1750_phone.begin(BH1750_TO_VCC, &I2C_Main);

  // เปิดใช้งานหน้าจอบนบัสของตัวเอง (รับประกันแสดงผลคนละจอแน่นอน 100%)
  displayMain.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  displaySub.begin(SSD1306_SWITCHCAPVCC, 0x3C);

  displayMain.clearDisplay();
  displayMain.setTextColor(WHITE);
  displayMain.setTextSize(1);
  displayMain.setCursor(0, 0);
  displayMain.println("Connecting WiFi...");
  displayMain.println(WIFI_SSID);
  displayMain.display();

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retryCount = 0;
  while (WiFi.status() != WL_CONNECTED && retryCount < 20) {
    delay(500);
    Serial.print(".");
    retryCount++;
  }

  if (WiFi.status() != WL_CONNECTED) {
    displayMain.clearDisplay();
    displayMain.setCursor(0, 0);
    displayMain.println("WiFi Conn Failed!");
    displayMain.display();
    while (1)
      ;
  }

  configTime(7 * 3600, 0, ntpServer);

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  auth.user.email = USER_EMAIL;
  auth.user.password = USER_PASSWORD;
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  displayMain.clearDisplay();
  displayMain.setCursor(0, 10);
  displayMain.println("System Ready!");
  displayMain.display();

  playBuzzerBeep(1000, 200);
  delay(1000);
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. อ่านค่าเซนเซอร์
  bh1750_room.start();
  bh1750_phone.start();
  roomLux = bh1750_room.getLux();
  phoneLux = bh1750_phone.getLux();

  temp = dht.readTemperature();
  hum = dht.readHumidity();
  handDetected = (digitalRead(IR_PIN) == LOW);
  phonePlaced = (phoneLux < 15.0);

  // 2. แจ้งเตือน Instant Alert
  if (currentState == STATE_RUNNING) {
    if (handDetected || !phonePlaced) {
      if (currentMillis - lastDistractionAlertMillis >= DISTRACTION_COOLDOWN) {
        lastDistractionAlertMillis = currentMillis;
        playAlertSound();
        logDistractionEvent(handDetected ? "hand_detected" : "phone_removed");
      }
    }
  }

  // 3. ระบบจัดการปุ่มกด

  // 🔴 ปุ่มสีแดง (Power / Cancel) - [TX2 / GPIO17]
  if (digitalRead(BTN_RED_PIN) == LOW) {
    if (redPressTime == 0) {
      redPressTime = currentMillis;
      redHandled = false;
    }
    if (!redHandled && (currentMillis - redPressTime >= 2000)) {
      redHandled = true;
      enterDeepSleep();
    }
  } else if (redPressTime > 0) {
    if (!redHandled && (currentMillis - redPressTime < 2000)) {
      if (currentState == STATE_RUNNING) {
        currentState = STATE_CONFIRM_CANCEL;
        cancelConfirmStart = currentMillis;
        playBuzzerBeep(800, 100);
      } else if (currentState == STATE_CONFIRM_CANCEL) {
        currentState = STATE_IDLE;
        playBuzzerBeep(500, 300);
      }
    }
    redPressTime = 0;
    redHandled = false;
  }

  // 🟡 ปุ่มสีเหลือง (Mode Switch) - [D15]
  static bool lastYellow = HIGH;
  bool currentYellow = digitalRead(BTN_YELLOW_PIN);
  if (lastYellow == HIGH && currentYellow == LOW) {
    if (currentState == STATE_IDLE) {
      currentMode = (currentMode == 1) ? 2 : 1;
      playBuzzerBeep(1200, 100);
    }
  }
  lastYellow = currentYellow;

  // 🔵 ปุ่มสีฟ้า (Time Adjust) - [D5] (กดสั้น +5 นาที / กดค้าง 1.5 วินาที -5 นาที)
  if (digitalRead(BTN_BLUE_PIN) == LOW) {
    if (bluePressTime == 0) {
      bluePressTime = currentMillis;
      blueLongBeepPlayed = false;
    }
    if (!blueLongBeepPlayed && (currentMillis - bluePressTime >= 1500)) {
      blueLongBeepPlayed = true;
      if (currentState == STATE_IDLE) {
        if (durationSec > 600) {
          durationSec -= 300;
        } else {
          durationSec = 600;
        }
        playBuzzerBeep(600, 200);
      }
    }
  } else if (bluePressTime > 0) {
    if (!blueLongBeepPlayed && (currentMillis - bluePressTime < 1500)) {
      if (currentState == STATE_IDLE) {
        durationSec += 300;
        if (durationSec > 5400)
          durationSec = 600;
        playBuzzerBeep(1500, 100);
      }
    }
    bluePressTime = 0;
    blueLongBeepPlayed = false;
  }

  // 🟢 ปุ่มสีเขียว (Start / Repeat) - [RX2 / GPIO16]
  // กฎ: ต้องเอามือถือเก็บก่อนแล้วกด เครื่องจะทำการนับถอยหลัง 3 วิ แล้วเริ่มจับเวลาจริง
  static bool lastGreen = HIGH;
  bool currentGreen = digitalRead(BTN_GREEN_PIN);
  if (lastGreen == HIGH && currentGreen == LOW) {
    if (currentState == STATE_IDLE || currentState == STATE_FINISHED) {
      if (phonePlaced) {
        prepareSec = 3;
        isWebStart = false;
        currentState = STATE_COUNTDOWN_PREPARE;
        playBuzzerBeep(1800, 150);
        Serial.println("[BUTTON] Start: Phone placed, counting down 3s...");
      } else {
        // ยังไม่วางมือถือบนแท่น -> แจ้งเตือนและไม่อนุญาตให้เริ่ม
        playAlertSound();
        Serial.println("[BUTTON] Warning: Must place phone on dock first!");
      }
    }
  }
  lastGreen = currentGreen;

  // 4. ซิงก์ข้อมูล Firebase (ทุก 2 วิ)
  if (currentMillis - firebaseSyncMillis >= 2000) {
    firebaseSyncMillis = currentMillis;
    updateFirebaseLiveStatus();

    // 4.1 ซิงก์โหมดและเวลาที่ตั้งจากเว็บ
    if (currentState == STATE_IDLE || currentState == STATE_FINISHED) {
      if (Firebase.RTDB.getInt(&fbdo, "/config/mode")) {
        int webMode = fbdo.intData();
        if (webMode == 1 || webMode == 2)
          currentMode = webMode;
      }
      if (Firebase.RTDB.getInt(&fbdo, "/config/durationSec")) {
        int webDuration = fbdo.intData();
        if (webDuration >= 60 && webDuration <= 14400)
          durationSec = webDuration;
      }
    }

    // 4.2 กดเริ่มผ่านเว็บ: เครื่องจะนับถอยหลัง 15 วิ เพื่อให้มีเวลาเก็บมือถือ
    if (Firebase.RTDB.getBool(&fbdo, "/config/trigger")) {
      bool webTrigger = fbdo.boolData();
      if (webTrigger &&
          (currentState == STATE_IDLE || currentState == STATE_FINISHED)) {
        Firebase.RTDB.setBool(&fbdo, "/config/trigger", false);
        prepareSec = 15;
        isWebStart = true;
        currentState = STATE_COUNTDOWN_PREPARE;
        playBuzzerBeep(1500, 150);
        Serial.println("[FIREBASE] Web Start: 15s Countdown initiated.");
      }
    }

    // 4.3 สั่งยกเลิก / รีเซ็ตเวลาผ่านเว็บ
    if (Firebase.RTDB.getBool(&fbdo, "/config/cancel")) {
      bool webCancel = fbdo.boolData();
      if (webCancel) {
        Firebase.RTDB.setBool(&fbdo, "/config/cancel", false);
        if (currentState != STATE_IDLE) {
          currentState = STATE_IDLE;
          prepareSec = 0;
          playBuzzerBeep(600, 300);
          Serial.println("[FIREBASE] Web Cancel: Reset to IDLE.");
        }
      }
    }
  }

  // 5. Timer Loop (1 วินาที)
  if (currentMillis - lastTimerMillis >= 1000) {
    lastTimerMillis = currentMillis;

    if (currentState == STATE_COUNTDOWN_PREPARE) {
      if (prepareSec > 0) {
        // ส่งเสียงปี๊บจังหวะนับถอยหลัง (3 วินาทีสุดท้ายจะส่งเสียงถี่ขึ้น)
        if (prepareSec <= 3) {
          playBuzzerBeep(1600, 70);
        } else {
          playBuzzerBeep(1000, 35);
        }
        prepareSec--;
      } else {
        // ครบเวลานับถอยหลัง -> เริ่มจับเวลาจริง
        remainingSec = durationSec;
        currentState = STATE_RUNNING;
        playBuzzerBeep(2000, 300);
        Serial.println("[TIMER] Prepare finished. Focus timer RUNNING!");

        // ตรวจสอบหากเริ่มจากเว็บแล้วหมด 15 วิแต่ยังไม่วางมือถือ
        if (isWebStart && !phonePlaced) {
          playAlertSound();
          logDistractionEvent("phone_not_placed");
        }
      }
    } else if (currentState == STATE_RUNNING) {
      if (remainingSec > 0) {
        remainingSec--;
      } else {
        currentState = STATE_FINISHED;
        playAlertSound();
        logSessionCompleted();
        Serial.println("[TIMER] Session Completed!");
      }
    } else if (currentState == STATE_CONFIRM_CANCEL) {
      if (currentMillis - cancelConfirmStart >= 5000) {
        currentState = STATE_RUNNING;
      }
    }
  }

  // 6. อัปเดตการแสดงผลจอ OLED แยกบัสอิสระ

  // จอหลัก 0.96" (บัส I2C_Main: D21, D22)
  displayMain.clearDisplay();
  displayMain.setTextColor(WHITE);

  if (currentState == STATE_IDLE) {
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.printf("MODE: %s\n", (currentMode == 1 ? "STUDY" : "DETOX"));
    displayMain.setTextSize(2);
    displayMain.setCursor(15, 20);
    displayMain.printf("%02d:00 MIN", durationSec / 60);
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 50);
    displayMain.print(phonePlaced ? "Status: Phone Ready"
                                  : "WARN: Place Phone!");
  } else if (currentState == STATE_COUNTDOWN_PREPARE) {
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.print(isWebStart ? "WEB START (15s)" : "BUTTON START (3s)");
    displayMain.setTextSize(3);
    displayMain.setCursor(45, 18);
    displayMain.printf("%02d", prepareSec);
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 50);
    if (!phonePlaced) {
      displayMain.print(isWebStart ? ">> PLACE PHONE NOW <<"
                                   : "WARN: PLACE PHONE!");
    } else {
      displayMain.print("Phone Ready. Focus!");
    }
  } else if (currentState == STATE_RUNNING) {
    int m = remainingSec / 60;
    int s = remainingSec % 60;
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 0);
    displayMain.printf("RUNNING [%s]\n",
                       (currentMode == 1 ? "STUDY" : "DETOX"));
    displayMain.setTextSize(3);
    displayMain.setCursor(18, 20);
    displayMain.printf("%02d:%02d", m, s);
  } else if (currentState == STATE_CONFIRM_CANCEL) {
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 10);
    displayMain.println("CANCEL TIMER?");
    displayMain.println("Press RED to Confirm");
    displayMain.printf("Auto Resume in %ds...",
                       5 - (int)((currentMillis - cancelConfirmStart) / 1000));
  } else if (currentState == STATE_FINISHED) {
    displayMain.setTextSize(2);
    displayMain.setCursor(10, 15);
    displayMain.println("TIME'S UP!");
    displayMain.setTextSize(1);
    displayMain.setCursor(0, 45);
    displayMain.println("Press GREEN to Repeat");
  }
  displayMain.display();

  // จอรอง 0.91" (บัส I2C_Sub: D23, D18)
  displaySub.clearDisplay();
  displaySub.setTextSize(1);
  displaySub.setTextColor(WHITE);
  displaySub.setCursor(0, 0);

  displaySub.printf("Temp:%.1fC  Hum:%.0f%%\n", isnan(temp) ? 0 : temp,
                    isnan(hum) ? 0 : hum);
  displaySub.printf("Room Lux: %.0f lx\n", roomLux);

  if (roomLux >= 300) {
    displaySub.println("Light: GOOD (Ready)");
  } else if (roomLux >= 100) {
    displaySub.println("Light: MODERATE");
  } else {
    displaySub.println("Light: TOO DARK!");
  }

  displaySub.display();
}