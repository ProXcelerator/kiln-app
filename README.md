# 🔥 KilnForge

**The ultimate smart controller for your ceramics kiln.**

KilnForge is a full-stack local web application designed to turn an ordinary manual kiln into a state-of-the-art smart kiln. Powered by a Raspberry Pi, it completely automates your firing schedules, tracks your electricity costs in real-time, and gives you a beautiful live dashboard to monitor your ceramics from anywhere in your house.

---

## ✨ Features & How to Use Them

### 📊 The Dashboard (Live Telemetry)
The dashboard is your mission control. When a firing is active, it shows:
- **Live Temperature:** A beautiful, real-time sweeping arc gauge showing the exact temperature inside the kiln.
- **Dynamic Chart:** A constantly updating timeline graphing your temperature curve against your target schedule.
- **Live Cost Tracking:** If connected to an Emporia Vue energy monitor, it tracks the exact wattage your kiln is drawing and calculates the real-time cost of your firing down to the penny.
- **Active Step:** Tells you exactly what the kiln is trying to do right now (e.g., "Ramping to 200°F" or "Holding at 2200°F").

### 🕒 Schedules
No more turning dials manually! The Schedules tab allows you to:
- **Build Custom Programs:** Create complex multi-step firing schedules. Set your target temperature, your ramp rate (degrees per hour), and how long you want to hold at the peak.
- **Use Built-in Presets:** Comes pre-loaded with standard ceramic firing schedules including **Cone 06 (Bisque)**, **Cone 6 (Glaze)**, and **Cone 10**.

### 📖 Records
Every time your kiln finishes a firing, KilnForge saves a permanent record.
- Review past firings to see the peak temperature reached.
- Check the **total electricity cost** and **total kilowatt-hours (kWh)** used.
- See the weather conditions (temperature and humidity) from the day of the firing, which can be useful for diagnosing glazing defects!

### 🤖 AI Computer Vision (Calciforge)
If you place visual pyrometric cones in your kiln, you can take a picture of them after the firing and let our AI analyze them! 
- Upload a photo of your melted cones.
- The AI will evaluate the bend angle to tell you if you underfired, overfired, or achieved a perfect Cone.
- It can then **automatically tune your schedule** to fix defects like crazing or pinholing for your next firing.

### ⚙️ Settings
Customize your KilnForge experience:
- **Electricity Rate:** Enter your local utility rate (e.g., $0.12/kWh) to get accurate cost tracking.
- **Emporia Vue:** Enter your Emporia account credentials to unlock live wattage tracking.
- **Location:** Enter your latitude and longitude to fetch local weather data automatically.

---

## 🛠️ Raspberry Pi Installation Guide

*For the tech-savvy potters building their own controller hardware.*

### 1. Prerequisites
You will need a Raspberry Pi, a **MAX31855 Thermocouple Amplifier** (for reading high temps), and a solid-state relay capable of switching your kiln's amperage.

### 2. Node.js & Dependencies
Install Node.js 18.x or 20.x, then install the required Python libraries for the hardware:
```bash
# Install Adafruit MAX31855 Library (Add --break-system-packages if on Bookworm)
pip3 install adafruit-circuitpython-max31855

# Optional: Install Emporia library for power tracking
pip3 install pyemvue
```

**Important:** Enable SPI on your Raspberry Pi by running `sudo raspi-config` → Interface Options → SPI → Enable.

### 3. Application Setup
```bash
git clone https://github.com/YourUsername/kiln-app.git
cd kiln-app
npm install
```

To run the application manually:
```bash
npm start
```
*Open a web browser on any computer on your Wi-Fi network and go to `http://<YOUR_PI_IP_ADDRESS>:3000`*

### 4. Running Automatically on Boot (via PM2)
We recommend using PM2 to ensure the kiln app starts every time the Pi gets plugged in.
```bash
sudo npm install -g pm2
pm2 start server/index.js --name "kilnforge"
pm2 save
pm2 startup
```

---

## ⚡ Hardware Wiring Reference

### MAX31855 Wiring
| MAX31855 Pin | Raspberry Pi Pin  |
|---|---|
| **VCC**  | Pin 1 (3.3V) |
| **GND**  | Pin 6 (GND)  |
| **SCK**  | Pin 23 (BCM11 SCLK) |
| **CS**   | Pin 29 (BCM5 GPIO5) |
| **MISO** | Pin 21 (BCM9 MISO)  |

*Note: If you use a different CS (Chip Select) pin, update `board.D5` inside `scripts/read_max31855.py`.*

### GPIO Relay (Kiln Power)
The application defaults to triggering the kiln relay on **BCM17** (Physical Pin 11).
To enable hardware relay control, simply uncomment the `onoff` code block inside `server/kiln.js`.

---

## 💻 Simulation Mode
Don't have the hardware wired up yet? No problem. 
If KilnForge detects that it is running on a standard computer (or a Pi without SPI enabled), it automatically enters **Simulation Mode**. The software will realistically simulate temperature ramps and holds so you can test schedules and UI features before plugging in a real kiln!
