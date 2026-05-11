// thermocouple.js — MAX31855 thermocouple reader
// On Raspberry Pi: uses Python/Adafruit sidecar (read_max31855.py)
// In dev/simulation mode: returns a realistic simulated temperature ramp

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_SCRIPT = path.join(__dirname, '..', 'scripts', 'read_max31855.py');

// Check if we're actually on a Pi with the script available
const IS_PI = fs.existsSync('/dev/spidev0.0') || process.env.USE_REAL_SENSOR === 'true';
let lastReading = 72; // ambient ~72°F at rest

// Simulation state
let simTargetTemp = 72;
let simCurrentTemp = 72;

function updateSimulation(kilnState, schedule, stepIndex) {
  if (!kilnState || kilnState === 'IDLE' || kilnState === 'COMPLETE') {
    // Cool down slowly
    simCurrentTemp = Math.max(72, simCurrentTemp - 0.3);
    simTargetTemp = 72;
  } else if (schedule && schedule.steps && schedule.steps[stepIndex] != null) {
    const step = schedule.steps[stepIndex];
    if (step.type === 'ramp') {
      simTargetTemp = step.targetTempF;
      const rate = (step.ratePerHour || 100) / 3600; // per second
      if (simCurrentTemp < simTargetTemp) {
        simCurrentTemp = Math.min(simTargetTemp, simCurrentTemp + rate * 2);
      } else {
        simCurrentTemp = Math.max(simTargetTemp, simCurrentTemp - rate * 2);
      }
    } else if (step.type === 'hold') {
      simTargetTemp = step.tempF;
      simCurrentTemp += (Math.random() - 0.5) * 2; // ±1°F noise during hold
      simCurrentTemp = Math.max(simTargetTemp - 10, Math.min(simTargetTemp + 10, simCurrentTemp));
    }
  }
  return Math.round(simCurrentTemp * 10) / 10;
}

async function readTempF(kilnState, schedule, stepIndex) {
  if (IS_PI) {
    const { spawn } = require('child_process');

    const execPromise = new Promise((resolve) => {
      let resolved = false;
      let output = '';

      // Use detached:true so we can kill the entire process group on timeout,
      // preventing zombie processes from holding the SPI device open.
      const child = spawn('python3', [PYTHON_SCRIPT], { detached: true });

      child.stdout.on('data', (data) => { output += data.toString(); });

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        const val = parseFloat(output.trim());
        if (!isNaN(val)) {
          lastReading = Math.round(val * 10) / 10;
        }
        resolve(lastReading);
      });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        console.warn('[Thermocouple] Python spawn error:', err.message);
        resolve(lastReading);
      });

      // Kill the entire process group after 4s to free the SPI device
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try { process.kill(-child.pid, 'SIGKILL'); } catch(e) {}
        console.warn('[Thermocouple] Python read timed out — killed process group, using last reading.');
        resolve(lastReading);
      }, 4000);
    });

    return execPromise;
  } else {
    // Simulation mode
    const temp = updateSimulation(kilnState, schedule, stepIndex);
    return temp;
  }
}

function getMode() {
  return IS_PI ? 'hardware' : 'simulation';
}

module.exports = { readTempF, getMode };
