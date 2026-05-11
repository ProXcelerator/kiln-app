#!/usr/bin/env node
/**
 * impulse_tune.js — Kiln Thermal Impulse Response Calibration
 *
 * How it works:
 *   1. Fires the SSR for a precise duration (e.g. 1 second, 5 seconds, 20 seconds)
 *   2. Cuts power and watches the temperature peak and coast
 *   3. Waits for the temp to return close to starting baseline
 *   4. Repeats for each pulse duration
 *   5. Saves the learned thermal map to server/data/thermal_profile.json
 *
 * Run from inside the kiln-app folder on the Raspberry Pi:
 *   node scripts/impulse_tune.js
 *
 * GPIO 17 = relay pin (same as main kiln app)
 * Thermocouple readings via Python sidecar (same as main app)
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const RELAY_GPIO_PIN       = 17;
const PULSE_DURATIONS_SEC  = [1, 2, 3, 4, 5, 10, 20]; // seconds to test
const BASELINE_MARGIN_F    = 3;   // how close to starting temp before next test
const COAST_POLL_MS        = 2000; // how often to sample during coast (ms)
const COAST_TIMEOUT_MS     = 45 * 60 * 1000; // max 45 min wait per pulse
const PYTHON_SCRIPT        = path.join(__dirname, 'read_max31855.py');
const OUTPUT_FILE          = path.join(__dirname, '..', 'server', 'data', 'thermal_profile.json');

// Results accumulate here
const results = [];

// ─────────────────────────────────────────────
// GPIO Helpers (onoff library)
// ─────────────────────────────────────────────
let relay;
try {
  const { Gpio } = require('onoff');
  relay = new Gpio(RELAY_GPIO_PIN, 'out');
  relay.writeSync(0); // Start with relay OFF
  console.log('[Tune] GPIO relay initialized on pin', RELAY_GPIO_PIN);
} catch (err) {
  console.error('[Tune] ERROR: Could not open GPIO relay. Is onoff installed? Is this running on a Pi?');
  console.error(err.message);
  process.exit(1);
}

function relayOn()  { relay.writeSync(1); }
function relayOff() { relay.writeSync(0); }

// ─────────────────────────────────────────────
// Thermocouple Read Helper
// ─────────────────────────────────────────────
function readTempF() {
  try {
    const out = execSync(`python3 "${PYTHON_SCRIPT}"`, { timeout: 10000 }).toString().trim();
    // The script outputs a plain float like "82.4"
    const val = parseFloat(out);
    if (!isNaN(val)) return val;
    console.warn('[Tune] Unexpected thermocouple output:', out);
    return null;
  } catch (err) {
    console.warn('[Tune] Could not read thermocouple:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Sleep Helper
// ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// Wait for temp to drop back near baseline
// ─────────────────────────────────────────────
async function waitForCooldown(baselineF, label) {
  console.log(`\n[Tune] Waiting for kiln to cool back to ~${baselineF.toFixed(1)}°F before next test...`);
  const startWait = Date.now();
  while (Date.now() - startWait < COAST_TIMEOUT_MS) {
    const temp = readTempF();
    if (temp === null) { await sleep(COAST_POLL_MS); continue; }
    const diff = temp - baselineF;
    process.stdout.write(`\r  Current: ${temp.toFixed(1)}°F | Target baseline: ${baselineF.toFixed(1)}°F | Diff: +${diff.toFixed(1)}°F   `);
    if (diff <= BASELINE_MARGIN_F) {
      console.log(`\n[Tune] Temperature close enough to baseline. Starting next pulse.`);
      return temp;
    }
    await sleep(COAST_POLL_MS);
  }
  console.warn('\n[Tune] WARNING: Cooldown timeout reached. Proceeding anyway.');
  return readTempF();
}

// ─────────────────────────────────────────────
// Run a single impulse test
// ─────────────────────────────────────────────
async function runImpulse(durationSec) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Tune] Pulse Test: ${durationSec} second(s)`);

  // Capture baseline JUST before the pulse
  const baselineF = readTempF();
  if (baselineF === null) { console.error('[Tune] Cannot read baseline. Skipping.'); return null; }
  console.log(`[Tune] Baseline temperature: ${baselineF.toFixed(1)}°F`);

  // Fire the relay
  console.log(`[Tune] Firing relay for exactly ${durationSec}s...`);
  const pulsedAt = Date.now();
  relayOn();
  await sleep(durationSec * 1000);
  relayOff();
  console.log(`[Tune] Relay OFF. Monitoring coast...`);

  // Monitor peak temperature during coast
  let peakF = baselineF;
  let peakReachedAt = null;
  const coastStart = Date.now();
  const coastReadings = [];
  const MIN_DETECTABLE_RISE_F = 0.5; // If temp never rises this much, skip coast wait

  // Poll for up to 10 minutes to capture full coast
  while (Date.now() - coastStart < 10 * 60 * 1000) {
    const temp = readTempF();
    if (temp !== null) {
      const elapsedSec = (Date.now() - pulsedAt) / 1000;
      coastReadings.push({ elapsedSec: Math.round(elapsedSec * 10) / 10, tempF: Math.round(temp * 10) / 10 });
      process.stdout.write(`\r  Coast: ${temp.toFixed(1)}°F | Peak: ${peakF.toFixed(1)}°F | Time: ${Math.round(elapsedSec)}s`);
      if (temp > peakF) {
        peakF = temp;
        peakReachedAt = Date.now();
      }
      // If 2 minutes have passed and temp never rose measurably — pulse too short, skip waiting
      const elapsed = (Date.now() - coastStart) / 1000;
      if (elapsed > 120 && peakF - baselineF < MIN_DETECTABLE_RISE_F) {
        console.log(`\n[Tune] No measurable rise after ${durationSec}s pulse. Skipping coast wait.`);
        break;
      }
      // Stop early: temp has clearly peaked and has been falling for 2+ minutes
      const timeSincePeak = peakReachedAt ? (Date.now() - peakReachedAt) / 1000 : 0;
      if (peakReachedAt && timeSincePeak > 120 && temp < peakF - 2) break;
    }
    await sleep(COAST_POLL_MS);
  }

  const coastTime = peakReachedAt ? (peakReachedAt - pulsedAt) / 1000 : null;
  const deltaTempF = peakF - baselineF;

  console.log(`\n[Tune] ✅ Pulse done!`);
  console.log(`  ▸ Pulse Duration    : ${durationSec}s`);
  console.log(`  ▸ Baseline Temp     : ${baselineF.toFixed(1)}°F`);
  console.log(`  ▸ Peak Temp         : ${peakF.toFixed(1)}°F`);
  console.log(`  ▸ Delta (coast gain): +${deltaTempF.toFixed(1)}°F`);
  console.log(`  ▸ Time to Peak      : ${coastTime ? coastTime.toFixed(0) + 's' : 'N/A'}`);

  return {
    pulseSeconds: durationSec,
    baselineTempF: Math.round(baselineF * 10) / 10,
    peakTempF: Math.round(peakF * 10) / 10,
    deltaTempF: Math.round(deltaTempF * 10) / 10,
    timeTopeakSec: coastTime ? Math.round(coastTime) : null,
    coastReadings
  };
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('\n🔥 KilnForge Impulse Response Calibration');
  console.log('─'.repeat(60));
  console.log('This script will fire the SSR in isolated bursts and record');
  console.log('exactly how much temperature rise each pulse produces.\n');
  console.log(`Pulse sequence: ${PULSE_DURATIONS_SEC.join('s, ')}s`);
  console.log(`Between each pulse: waiting for kiln to cool back to baseline ±${BASELINE_MARGIN_F}°F`);
  console.log('\nWARNING: Make sure kiln is empty! Starting in 10 seconds...');
  await sleep(10000);

  const startTempF = readTempF();
  if (!startTempF) { console.error('[Tune] Cannot read start temperature. Aborting!'); process.exit(1); }
  console.log(`[Tune] Starting temperature: ${startTempF.toFixed(1)}°F`);

  for (const duration of PULSE_DURATIONS_SEC) {
    const result = await runImpulse(duration);
    if (result) results.push(result);

    // Wait for cooldown before next pulse (except after last)
    if (duration !== PULSE_DURATIONS_SEC[PULSE_DURATIONS_SEC.length - 1]) {
      const baseline = result ? result.baselineTempF : startTempF;
      await waitForCooldown(baseline, `after ${duration}s pulse`);
    }
  }

  // Build and save the thermal profile
  const profile = {
    generatedAt: new Date().toISOString(),
    startTempF,
    relayGpioPin: RELAY_GPIO_PIN,
    pulses: results,
    // Build a quick lookup table: { "5": { deltaTempF: 12.3, timeTopeakSec: 180 } }
    lookup: Object.fromEntries(
      results.map(r => [String(r.pulseSeconds), {
        deltaTempF: r.deltaTempF,
        timeTopeakSec: r.timeTopeakSec
      }])
    )
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(profile, null, 2));

  console.log('\n');
  console.log('='.repeat(60));
  console.log('✅ CALIBRATION COMPLETE');
  console.log(`Thermal profile saved to: ${OUTPUT_FILE}`);
  console.log('\nSummary Table:');
  console.log('  Pulse  | Delta°F | Time to Peak');
  console.log('  -------|---------|-------------');
  results.forEach(r => {
    const pulse = `${r.pulseSeconds}s`.padEnd(6);
    const delta = `+${r.deltaTempF.toFixed(1)}°F`.padEnd(8);
    const peak  = r.timeTopeakSec ? `${r.timeTopeakSec}s` : 'N/A';
    console.log(`  ${pulse} | ${delta}| ${peak}`);
  });

  // Clean up GPIO
  relay.writeSync(0);
  relay.unexport();
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n[Tune] Interrupted! Turning relay OFF for safety.');
  try { relay.writeSync(0); relay.unexport(); } catch (_) {}
  process.exit(1);
});

main().catch(err => {
  console.error('[Tune] Fatal error:', err);
  try { relay.writeSync(0); relay.unexport(); } catch (_) {}
  process.exit(1);
});
