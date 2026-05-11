// emporia.js — Emporia Vue power monitoring via PyEmVue Python sidecar
// Falls back to schedule-based wattage estimate if credentials not set or unavailable

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_SCRIPT = path.join(__dirname, '..', 'scripts', 'read_emporia.py');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

let cachedWatts = null;
let lastFetchAt = null;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

let isFetching = false;

// Run an independent background polling loop so Emporia never blocks the main PID controller
setInterval(async () => {
  if (isFetching || !isConfigured()) return;
  isFetching = true;
  await fetchEmporiaWatts();
  isFetching = false;
}, CACHE_TTL_MS);

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function fetchEmporiaWatts() {
  const settings = loadSettings();

  if (!settings.emporiaEmail || !settings.emporiaPassword) {
    return null;
  }

  return new Promise((resolve) => {
    let resolved = false;
    let output = '';

    const env = {
      ...process.env,
      EMPORIA_EMAIL: settings.emporiaEmail,
      EMPORIA_PASSWORD: settings.emporiaPassword,
      EMPORIA_DEVICE_GID: settings.emporiaDeviceGid ? String(settings.emporiaDeviceGid) : '',
      EMPORIA_CHANNEL: settings.emporiaChannelNum != null ? String(settings.emporiaChannelNum) : '1'
    };

    // Use detached:true so we can kill the entire process group on timeout,
    // preventing zombie processes from holding network sockets open.
    const child = spawn(PYTHON_CMD, [PYTHON_SCRIPT], { detached: true, env });

    child.stdout.on('data', (data) => { output += data.toString(); });

    child.on('close', () => {
      if (resolved) return;
      resolved = true;
      try {
        const data = JSON.parse(output.trim());
        const watts = data.watts != null ? Math.round(data.watts) : null;
        if (watts !== null) {
          cachedWatts = watts;
          lastFetchAt = Date.now();
          console.log(`[Emporia] Current draw: ${watts}W`);
        }
        resolve(watts);
      } catch {
        console.warn('[Emporia] Failed to parse output:', output.trim().slice(0, 100));
        resolve(null);
      }
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      console.warn('[Emporia] Fetch failed:', err.message);
      resolve(null);
    });

    // Kill the entire process group after 25s to prevent zombie accumulation.
    // Must be less than the 30s watchdog timeout.
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch(e) {}
      console.warn('[Emporia] Fetch timed out — killed process group.');
      resolve(null);
    }, 25000);
  });
}

async function testConnection() {
  const settings = loadSettings();

  if (!settings.emporiaEmail || !settings.emporiaPassword) {
    return { success: false, error: 'No Emporia credentials configured.' };
  }

  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const env = {
      ...process.env,
      EMPORIA_EMAIL: settings.emporiaEmail,
      EMPORIA_PASSWORD: settings.emporiaPassword,
      EMPORIA_DEVICE_GID: settings.emporiaDeviceGid ? String(settings.emporiaDeviceGid) : '',
      EMPORIA_CHANNEL: settings.emporiaChannelNum != null ? String(settings.emporiaChannelNum) : '1'
    };

    exec(`${PYTHON_CMD} "${PYTHON_SCRIPT}"`, { timeout: 6000, killSignal: 'SIGKILL', env }, (err, stdout) => {
      if (err) {
        resolve({ success: false, error: err.message });
      } else {
        try {
          const data = JSON.parse(stdout.trim());
          if (data.error) {
            resolve({ success: false, error: data.error });
          } else {
            resolve({ success: true, watts: data.watts, deviceName: data.device || 'Unknown Device' });
          }
        } catch {
          resolve({ success: false, error: 'Failed to parse python output: ' + stdout });
        }
      }
    });
  });
}

async function getCurrentWatts(fallbackWatts) {
  // If this is the very first boot tick, fire off a background fetch and instantly return fallback
  if (!lastFetchAt && !isFetching && isConfigured()) {
    isFetching = true;
    fetchEmporiaWatts().finally(() => isFetching = false);
  }
  
  // IMMEDIATELY return what we've got. Zero blocking allowed!
  return cachedWatts != null ? cachedWatts : (fallbackWatts || null);
}

function getLastFetchTime() {
  return lastFetchAt;
}

function isConfigured() {
  const s = loadSettings();
  return !!(s.emporiaEmail && s.emporiaPassword);
}

module.exports = { getCurrentWatts, getLastFetchTime, isConfigured, testConnection };
