# 🔥 KilnForge — Ceramic Kiln Firing & Monitoring System

A full-stack local web application for monitoring and controlling a ceramics kiln via Raspberry Pi.

## Features

- **Live Temperature Gauge** — SVG arc gauge showing kiln temp in real-time (°F)
- **Firing Schedule Editor** — Create ramp/hold steps, pre-loaded with Cone 06, Cone 6, Cone 10 programs
- **Start/Stop Kiln** — REST API control, hooks to GPIO relay on Pi
- **Real Weather Data** — Outdoor temp & humidity via Open-Meteo (free, no API key)
- **Emporia Vue Integration** — Real-time power draw from your Emporia circuit monitor
- **Firing Cost Tracking** — Live kWh accumulation × electricity rate = exact cost
- **Firing Records** — Full history: peak temp, duration, total cost, humidity, outdoor temp
- **Live Chart** — Chart.js real-time dual-axis temperature timeline
- **WebSocket streaming** — 2-second live updates to all connected browser clients

---

## Quick Start

```bash
cd kiln-app
npm install
npm start
```

Open: **http://localhost:3000** (or `http://<pi-ip>:3000` from any device on your LAN)

---

## Raspberry Pi Setup

### 1. Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Python + MAX31855 library
```bash
pip3 install adafruit-circuitpython-max31855
```

Enable SPI: `sudo raspi-config` → Interface Options → SPI → Enable → Reboot

### 3. Emporia Vue (optional)
```bash
pip3 install pyemvue
```

### 4. Run on startup (systemd)
```bash
sudo nano /etc/systemd/system/kilnforge.service
```
```ini
[Unit]
Description=KilnForge Kiln App
After=network.target

[Service]
WorkingDirectory=/home/pi/kiln-app
ExecStart=/usr/bin/node server/index.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable kilnforge
sudo systemctl start kilnforge
```

---

## MAX31855 Wiring

| MAX31855 Pin | Raspberry Pi Pin  |
|---|---|
| VCC  | Pin 1 (3.3V) |
| GND  | Pin 6 (GND)  |
| SCK  | Pin 23 (BCM11 SCLK) |
| CS   | Pin 29 (BCM5  GPIO5) |
| MISO | Pin 21 (BCM9  MISO)  |

> Change `board.D5` in `scripts/read_max31855.py` if you use a different CS pin.

---

## GPIO Relay (Kiln Power)

Uncomment the `onoff` block in `server/kiln.js` and install:
```bash
npm install onoff
```
Default relay GPIO: **BCM17** (Pin 11). Change as needed.

---

## Configuration

All settings are in the **Settings tab** of the web UI:
- Location → latitude/longitude for weather
- Electricity rate ($/kWh) for cost calculation
- Emporia Vue credentials
- Default kiln wattage

Settings are saved to `server/data/settings.json`.

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/kiln/status` | Full live status + telemetry |
| POST | `/api/kiln/start` | `{ scheduleId }` — start firing |
| POST | `/api/kiln/stop` | Stop firing |
| GET | `/api/schedules` | List all schedules |
| POST | `/api/schedules` | Create schedule |
| PUT | `/api/schedules/:id` | Update schedule |
| DELETE | `/api/schedules/:id` | Delete schedule |
| GET | `/api/records` | All firing records |
| DELETE | `/api/records/:id` | Delete a record |
| GET | `/api/settings` | Current settings |
| PUT | `/api/settings` | Update settings |

WebSocket: `ws://<host>:3000` — receives `telemetry`, `firingComplete`, `stepChange` events

---

## Simulation Mode

When not running on a Pi (no `/dev/spidev0.0`), the app automatically runs in **simulation mode** — the kiln temperature realistically ramps and holds according to the selected schedule. Perfect for development and testing.

Force hardware mode: `USE_REAL_SENSOR=true node server/index.js`
