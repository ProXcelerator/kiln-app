// index.js — Main Express + WebSocket server for kiln-app
// Runs on Raspberry Pi at http://0.0.0.0:3000

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const schedules = require('./schedules');
const records = require('./records');
const kiln = require('./kiln');
const thermocouple = require('./thermocouple');
const weather = require('./weather');
const emporia = require('./emporia');
const safety = require('./safety');
const vision = require('./vision');
const db = require('./db');

// Auto-recover any firings that were abruptly interrupted (e.g., power loss)
db.autoRecoverFirings();

// ID of the currently active firing — set when start is pressed, cleared on complete
let currentFiringId = null;
let currentFiringWeather = { maxTempF: null, minTempF: null };

// ============================================================
// GRACEFUL SHUTDOWN — relay OFF before process dies
// ============================================================
function emergencyShutdown(reason) {
  console.error(`\n[SHUTDOWN] ${reason} — turning off kiln relay...`);
  try {
    kiln.stop();
  } catch (e) {
    console.error('[SHUTDOWN] kiln.stop() failed:', e.message);
  }
  safety.disarm();
  // Give relay time to physically open before process exits
  setTimeout(() => process.exit(1), 500);
}

process.on('SIGTERM', () => emergencyShutdown('SIGTERM received'));
process.on('SIGINT',  () => emergencyShutdown('SIGINT received (Ctrl+C)'));

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  emergencyShutdown('Uncaught exception — ' + err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  // Log but don't kill — unhandled rejections are usually non-fatal (e.g. network timeout)
  // If a safety-critical rejection, escalate:
  // emergencyShutdown('Unhandled promise rejection');
});

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// Live state snapshot — updated every 2s
// ============================================================
let liveSnapshot = {
  kilnTempF: 72,
  ambientTempF: null,
  humidity: null,
  watts: null,
  estimatedKWhUsed: 0,
  estimatedCost: 0,
  kilnStatus: kiln.getStatus(),
  sensorMode: thermocouple.getMode(),
  emporiaConnected: emporia.isConfigured(),
  safetyStatus: safety.getStatus(),
  timestamp: Date.now()
};

// ---- Firing history buffer ----
// Stores {kilnTempF, timestamp} for every telemetry tick during an active firing.
// Cleared when firing completes. Replayed to reconnecting browser clients.
const MAX_HISTORY = 5400; // ~3 hours of 2s readings
let firingHistory = [];


function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { electricityRate: 0.12, defaultKilnWatts: 2400 }; }
}

// ---- Main telemetry loop (2s) ----
async function telemetryLoop() {
  try {
    const settings = loadSettings();
    const kilnStatus = kiln.getStatus();

    // 1. Prepare sensor read parameters
    const fallbackWatts = kilnStatus.state === 'FIRING' || kilnStatus.state === 'HOLD'
      ? (kiln.getSchedule()?.kilnWatts || settings.defaultKilnWatts)
      : 0;

    const emporiaTargetWatts = kilnStatus.state === 'IDLE' || kilnStatus.state === 'COMPLETE' ? 0 : fallbackWatts;

    // 2. Parallelize: Read sensors simultaneously instead of one-by-one
    // Use Settled so one network failure doesn't halt the whole system
    const results = await Promise.allSettled([
      thermocouple.readTempF(kilnStatus.state, kiln.getSchedule(), kiln.getStepIndex()),
      emporia.getCurrentWatts(emporiaTargetWatts)
    ]);

    const kilnTempF = results[0].status === 'fulfilled' ? results[0].value : null;
    const watts = results[1].status === 'fulfilled' ? results[1].value : null;
    
    // We no longer live-poll weather.
    const wx = { tempF: null, humidity: null };

  // 4. Safety checks (feeds software watchdog + validates limits)
  if (kilnStatus.state === 'FIRING' || kilnStatus.state === 'HOLD') {
    const safetyResult = safety.check(kilnTempF, kilnStatus.state, kilnStatus.startTime);
    if (!safetyResult.safe) {
      console.error('[Server] Safety trip — stopping kiln:', safetyResult.reason);
      kiln.stop();
      const tripMsg = JSON.stringify({ type: 'safetyTrip', reason: safetyResult.reason });
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(tripMsg); });
    }
  }

  // 5. Tick kiln state machine
  if (kilnStatus.state === 'FIRING' || kilnStatus.state === 'HOLD') {
    kiln.tick(kilnTempF, watts != null ? watts : fallbackWatts);
  }

  // Send hardware Watchdog heartbeat if enabled in settings
  kiln.updateWatchdog(kilnTempF, settings.watchdogEnabled, settings.watchdogPort);

  // 6. Calculate cost
  const kWh = kiln.getTotalKWhUsed();
  const rate = settings.electricityRate || 0.12;
  const cost = Math.round(kWh * rate * 100) / 100;

  liveSnapshot = {
    kilnTempF,
    ambientTempF: wx.tempF,
    humidity: wx.humidity,
    watts,
    estimatedKWhUsed: Math.round(kWh * 1000) / 1000,
    estimatedCost: cost,
    kilnStatus: kiln.getStatus(),
    sensorMode: thermocouple.getMode(),
    emporiaConnected: emporia.isConfigured(),
    safetyStatus: safety.getStatus(),
    timestamp: Date.now()
  };

  // 7. Store in firing history if actively firing
  const isActive = liveSnapshot.kilnStatus.state === 'FIRING' || liveSnapshot.kilnStatus.state === 'HOLD';
  if (isActive) {
    firingHistory.push({ kilnTempF, timestamp: Date.now() });
    if (firingHistory.length > MAX_HISTORY) firingHistory.shift();

    // Write to SQLite for permanent storage
    if (currentFiringId) {
      db.insertReading(currentFiringId, {
        kilnTempF,
        relayOn: liveSnapshot.kilnStatus.relayOn,
        stepIndex: liveSnapshot.kilnStatus.stepIndex,
        dutyCycle: liveSnapshot.kilnStatus.dutyCycle
      });

      // LIVE UPSERT: Constantly update the master firing record in the database.
      // This ensures that if the Raspberry Pi loses power or is unplugged mid-firing,
      // the firing is NEVER orphaned and will immediately show up in the Records tab without needing recovery.
      try {
        const liveRecord = kiln._buildRecord(kilnTempF);
        const fullRecord = {
          ...liveRecord,
          id: currentFiringId,
          ambientTempF: currentFiringWeather.maxTempF,
          humidity: currentFiringWeather.minTempF,
          totalCost: Math.round(liveRecord.totalKWh * (settings.electricityRate || 0.12) * 100) / 100,
          electricityRate: settings.electricityRate || 0.12,
          savedAt: new Date().toISOString()
        };
        db.insertFiring(fullRecord);
      } catch(e) {
        // fail silently for live upserts
      }
    }
  }

  // 8. Broadcast to all WS clients
  const payload = JSON.stringify({ type: 'telemetry', data: liveSnapshot });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
  } catch (err) {
    console.error('[Loop Error]', err);
  } finally {
    // 7. Recursive setTimeout (more stable than setInterval for async tasks)
    setTimeout(telemetryLoop, 2000);
  }
}

// Kick off first run
telemetryLoop();

// ============================================================
// WebSocket
// ============================================================
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  // Send the current live snapshot immediately
  ws.send(JSON.stringify({ type: 'telemetry', data: liveSnapshot }));

  // If a firing is in progress, replay full history so the reconnecting
  // browser can reconstruct the complete temperature chart
  if (firingHistory.length > 0) {
    ws.send(JSON.stringify({ type: 'firingHistory', data: firingHistory }));
  }

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ============================================================
// Kiln events → broadcast
// ============================================================
kiln.on('complete', async (record) => {
  console.log('[Kiln] Firing complete, saving record');

  // Clear the history buffer — the firing is done
  firingHistory = [];

  // Do NOT await the weather fetch here. Awaiting it can block the event loop during
  // an emergency shutdown, causing the process to die before the record is saved.
  // We already fetched daily weather at the start of the firing.

  const fullRecord = {
    ...record,
    id: currentFiringId,
    ambientTempF: currentFiringWeather.maxTempF,
    humidity: currentFiringWeather.minTempF, // Reusing humidity field for minTempF
    totalCost: Math.round(record.totalKWh * (settings.electricityRate || 0.12) * 100) / 100,
    electricityRate: settings.electricityRate || 0.12
  };
  const saved = records.append(fullRecord);

  // Also persist to SQLite with the same ID used for readings
  if (currentFiringId) {
    db.insertFiring(saved);
    currentFiringId = null;
  }

  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: 'firingComplete', data: saved }));
    }
  });
});

kiln.on('stepChange', ({ stepIndex, step }) => {
  const msg = JSON.stringify({ type: 'stepChange', stepIndex, step });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
});

// ============================================================
// REST API — Schedules
// ============================================================
app.get('/api/schedules', (req, res) => {
  res.json(schedules.getAll());
});

app.get('/api/schedules/:id', (req, res) => {
  const s = schedules.getById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.post('/api/schedules', (req, res) => {
  const s = schedules.create(req.body);
  res.status(201).json(s);
});

app.put('/api/schedules/:id', (req, res) => {
  const s = schedules.update(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

app.delete('/api/schedules/:id', (req, res) => {
  const ok = schedules.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

app.post('/api/schedules/:id/reset', (req, res) => {
  const preset = schedules.restorePreset(req.params.id);
  if (!preset) return res.status(400).json({ error: 'Not a pre-made preset schedule.' });
  res.json(preset);
});

// ============================================================
// REST API — Adaptive Tuning Hook
// ============================================================
const adaptiveEngine = require('./adaptive_learning');

app.post('/api/records/:id/calibrate', (req, res) => {
  const r = records.getById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Record not found' });
  
  if (!r.scheduleId) return res.status(400).json({ error: 'No schedule attached to this record.' });
  const sched = schedules.getById(r.scheduleId);
  if (!sched) return res.status(404).json({ error: 'Original schedule no longer exists.' });

  const resultStatus = req.body.result; // "Overfired" | "Underfired" | "Perfect"
  if (resultStatus === "Perfect") {
    return res.json({ success: true, message: "Perfect firing. No optimization needed." });
  }

  // Generate an isolated mathematical copy so the original master schedule isn't destroyed
  const optimizedClone = adaptiveEngine.generateOptimizedScheduleCopy(sched, resultStatus);
  const newSavedSchedule = schedules.create(optimizedClone);
  
  res.json({
    success: true,
    message: `Generated an optimized schedule clone: ${newSavedSchedule.name}`,
    schedule: newSavedSchedule
  });
});

// ============================================================
// REST API — Records
// ============================================================
app.get('/api/records', (req, res) => {
  res.json(records.getAll());
});

app.get('/api/records/:id', (req, res) => {
  const r = records.getById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Returns the full temperature curve for a past firing (from SQLite)
app.get('/api/records/:id/readings', (req, res) => {
  const readings = db.getReadings(req.params.id);
  res.json(readings);
});

app.delete('/api/records/:id', (req, res) => {
  try {
    // Delete directly from SQLite
    db.deleteFiring(req.params.id);
    
    // Also try to remove from records.js just in case it is still lingering in memory
    try { records.remove(req.params.id); } catch(e) {}
    
    res.json({ success: true });
  } catch (err) {
    console.error('[API] Failed to delete record:', err.message);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

// ============================================================
// REST API — Kiln control
// ============================================================
app.get('/api/kiln/status', (req, res) => {
  res.json({ ...kiln.getStatus(), ...liveSnapshot });
});

app.post('/api/kiln/start', (req, res) => {
  const { scheduleId, startStepIndex } = req.body;
  if (!scheduleId) return res.status(400).json({ error: 'scheduleId required' });

  const schedule = schedules.getById(scheduleId);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  try {
    safety.reloadConfig();
    safety.arm();
    const status = kiln.start(schedule, startStepIndex ? parseInt(startStepIndex, 10) : 0);

    // Generate a unique ID for this firing session — used to link all readings
    const { v4: uuidv4 } = require('uuid');
    currentFiringId = uuidv4();
    console.log('[DB] New firing started, ID:', currentFiringId);

    // Fetch the daily min/max weather ONCE at the start of the firing
    weather.getDailyForecast().then(forecast => {
      currentFiringWeather = forecast;
    }).catch(err => {
      console.warn('[Weather] Failed to get start-of-firing weather:', err.message);
      currentFiringWeather = { maxTempF: null, minTempF: null };
    });

    res.json({ ...status, safetyStatus: safety.getStatus() });
  } catch (err) {
    safety.disarm();
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/kiln/stop', (req, res) => {
  const status = kiln.stop();
  safety.disarm();
  res.json({ ...status, safetyStatus: safety.getStatus() });
});

// ============================================================
// REST API — Safety status
// ============================================================
app.get('/api/safety', (req, res) => {
  res.json(safety.getStatus());
});

// ============================================================
// REST API — Settings
// ============================================================
app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  // Never send credentials to client in plain text
  const safe = { ...s };
  if (safe.emporiaPassword) safe.emporiaPassword = '••••••••';
  res.json(safe);
});

app.put('/api/settings', (req, res) => {
  let current = loadSettings();
  const update = req.body;

  // Don't overwrite password with masked value
  if (update.emporiaPassword === '••••••••') {
    delete update.emporiaPassword;
  }

  const merged = { ...current, ...update };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));

  // Trigger fresh weather fetch if location changed (but no longer live-polls)
  if (update.locationQuery) {
    weather.getDailyForecast();
  }

  const safe = { ...merged };
  if (safe.emporiaPassword) safe.emporiaPassword = '••••••••';
  res.json(safe);
});

// ============================================================
// REST API — Emporia Test
// ============================================================
app.get('/api/emporia/test', async (req, res) => {
  const result = await emporia.testConnection();
  res.json(result);
});

// ============================================================
// REST API — AI Features
// ============================================================
app.post('/api/analyze-cone', async (req, res) => {
  try {
    const { base64Data, mimeType, targetCone } = req.body;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const result = await vision.analyzeConeImage(base64Data, mimeType, settings.aiVisionApiKey, targetCone);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auto-tune-schedule', (req, res) => {
  try {
    const { scheduleId, defects } = req.body;
    const SCHEDULES_FILE = path.join(__dirname, 'data', 'schedules.json');
    const s = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    const original = s.find(x => x.id === scheduleId);
    if (!original) throw new Error('Original schedule not found');

    const tuned = JSON.parse(JSON.stringify(original));
    tuned.id = `schedule-${Date.now()}`;
    tuned.name = `${original.name} (Tuned)`;
    tuned.description = `Auto-tuned due to: ${defects.join(', ')}`;
    tuned.createdAt = new Date().toISOString();
    tuned.isTemporary = true;

    if (defects.includes('underfired')) {
      const holdSteps = tuned.steps.filter(st => st.type === 'hold');
      if (holdSteps.length > 0) {
        const lastHold = holdSteps[holdSteps.length - 1];
        lastHold.durationMinutes = (lastHold.durationMinutes || 0) + 5;
      }
    }
    
    if (defects.includes('crazing')) {
      const ramps = tuned.steps.filter(st => st.type === 'ramp' && st.ratePerHour < 500);
      if (ramps.length > 0) {
        ramps[ramps.length - 1].ratePerHour = Math.max(50, ramps[ramps.length - 1].ratePerHour - 50);
      }
    }

    if (defects.includes('pinholing')) {
      // Append drop & hold cool schedule heuritic
      tuned.steps.push({
        id: `s-tuned-${Date.now()}-1`,
        type: 'ramp',
        label: 'Crash Cool (Tuned)',
        targetTempF: 1900,
        ratePerHour: 9999
      });
      tuned.steps.push({
        id: `s-tuned-${Date.now()}-2`,
        type: 'hold',
        label: 'Heal Pinholes (Tuned)',
        tempF: 1900,
        durationMinutes: 15
      });
    }

    s.push(tuned);
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(s, null, 2));

    broadastState();
    res.json({ success: true, newSchedule: tuned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// Start server
// ============================================================
// Safety trip events → broadcast + stop kiln
safety.on('trip', ({ reason }) => {
  console.error('[Safety Event] Trip received:', reason);
  try { kiln.stop(); } catch (e) {}
  const msg = JSON.stringify({ type: 'safetyTrip', reason });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔥 Kiln App running at http://0.0.0.0:${PORT}`);
  console.log(`   Sensor mode: ${thermocouple.getMode()}`);
  console.log(`   Emporia: ${emporia.isConfigured() ? 'configured' : 'not configured (using schedule wattage estimate)'}`);
  console.log(`   Safety limits: max ${safety.config.maxKilnTempF}°F, max ${safety.config.maxFiringHours}h, watchdog ${safety.config.watchdogTimeoutSec}s`);
  console.log(`   Open http://localhost:${PORT} in your browser\n`);
});
