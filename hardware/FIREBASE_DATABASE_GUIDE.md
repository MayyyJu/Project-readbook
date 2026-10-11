# คู่มือการตั้งค่า Firebase Realtime Database และเชื่อมต่อตัวเครื่อง

ระบบ **FocusDock** ใช้ **Firebase Realtime Database** ในการรับส่งข้อมูลระหว่างแท่นวางมือถือ (ESP32) และเว็บแอปพลิเคชันบนมือถือแบบสองทาง (Two-Way Realtime Sync)

---

## 1. วิธีสร้างและตั้งค่า Firebase Project

1. เข้าเว็บไซต์ [Firebase Console](https://console.firebase.google.com/) แล้วล็อกอินด้วย Google Account
2. กด **"Add project"** (เพิ่มโปรเจกต์)
   - ตั้งชื่อโปรเจกต์ เช่น `focus-dock-app`
   - สามารถปิด Google Analytics ได้ แล้วกด **Create Project**
3. สร้าง **Realtime Database**:
   - ในเมนูด้านซ้าย เลือก **Build** > **Realtime Database**
   - กดปุ่ม **Create Database**
   - เลือก Location (เช่น `Singapore (asia-southeast1)` หรือ `United States`)
   - เลือก **Start in test mode** (โหมดทดสอบเพื่อให้บอร์ดและเว็บอ่านเขียนได้ทันที) แล้วกด **Enable**
4. คัดลอก **Database URL**:
   - URL จะแสดงอยู่ด้านบนของแท็บ Data เช่น:  
     `https://focus-dock-app-default-rtdb.firebaseio.com/`
5. นำ **Web API Key** และ **Project ID**:
   - ไปที่ไอคอนรูปเฟือง ⚙️ > **Project settings**
   - ในส่วนล่างหัวข้อ **Your apps** กดสร้าง Web App `</>`
   - คุณจะได้ `apiKey`, `projectId`, และ `databaseURL` เพื่อนำมากรอกในหน้าเว็บที่แท็บ **"ตั้งค่า"**

---

## 2. โครงสร้างข้อมูล JSON (Database Schema)

โครงสร้างฐานข้อมูลที่ตัวเครื่องและเว็บแอปใช้งานร่วมกัน:

```json
{
  "devices": {
    "focus_dock_01": {
      "state": {
        "phonePickedUp": false,
        "lastStateChange": 1728663200,
        "command": "START_TOGGLE",
        "lastActionBy": "hardware",
        "actionTimestamp": 1728663200
      },
      "settings": {
        "studyMinutes": 25,
        "breakMinutes": 5,
        "detoxMinutes": 45,
        "updatedAt": 1728663200
      },
      "command": {
        "action": "START",
        "mode": "study",
        "triggeredBy": "web",
        "timestamp": 1728663200
      },
      "pickups": {
        "-O9xyz123": {
          "id": "pk_1728663200",
          "date": "2026-10-11",
          "dayName": "อาทิตย์",
          "startTime": "14:20:15",
          "endTime": "14:23:45",
          "durationSeconds": 210,
          "durationFormatted": "3 นาที 30 วินาที",
          "mode": "study",
          "note": "หยิบขณะอ่านหนังสือ"
        }
      }
    }
  }
}
```

---

## 3. Firebase Security Rules (กฎความปลอดภัย)

ในแท็บ **Rules** ของ Realtime Database แนะนำให้ใช้กฎสำหรับทดสอบเบื้องต้น:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

---

## 4. แผนผังการต่อสายฮาร์ดแวร์ (ESP32 Pinout)

| อุปกรณ์ | ขาของอุปกรณ์ | ขาบน ESP32 | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| **Push Button** | ขาที่ 1 | GPIO 18 | สั่งเริ่ม/พักจับเวลา |
| | ขาที่ 2 | GND | ใช้โหมด `INPUT_PULLUP` |
| **Ultrasonic HC-SR04** | VCC | 5V / VIN | ตรวจจับการวางมือถือ |
| | GND | GND | |
| | TRIG | GPIO 5 | ส่งคลื่น |
| | ECHO | GPIO 4 | รับคลื่นสะท้อน |
| **LED แสดงสถานะ** | Anode (+) | GPIO 2 | ไฟแสดงสถานะ |
| | Cathode (-) | GND (ผ่านตัวต้านทาน 220Ω) | |
| **Buzzer** | ขั้วบวก (+) | GPIO 19 | ส่งเสียงเตือนสั้นๆ เมื่อหยิบมือถือ |
| | ขั้วลบ (-) | GND | |

---

## 5. การทดสอบการทำงาน
- หากยังไม่มีบอร์ด ESP32 หรือยังไม่ได้ต่อสาย สามารถเปิดหน้าเว็บไปที่แท็บ **"ตั้งค่า"** แล้วใช้ **"แผงจำลองเครื่องจริง (Hardware Test)"** เพื่อทดสอบยกมือถือขึ้น/วางลง หรือกดปุ่มได้ทันที!
