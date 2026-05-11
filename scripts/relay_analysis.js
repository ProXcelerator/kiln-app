// relay_analysis.js
// Analyzes relay on/off cycling patterns from kilnforge.db
// Run from the kiln-app directory: node scripts/relay_analysis.js

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'server', 'data', 'kilnforge.db');
const BUCKET_SIZE = 100; // 100°F buckets

try {
  const db = new Database(DB_PATH, { readonly: true });

  // Get all firings, let user pick or auto-select most recent
  const firings = db.prepare('SELECT id, scheduleName, startTime FROM firings ORDER BY startTime DESC').all();
  if (firings.length === 0) {
    console.log('No completed firings found in database.');
    process.exit(0);
  }

  console.log('\n=== Available Firings ===');
  firings.forEach((f, i) => console.log(`[${i}] ${new Date(f.startTime).toLocaleString()} — ${f.scheduleName || 'Unknown'} (${f.id.slice(0,8)}...)`));

  // Default to most recent
  const targetIdx = parseInt(process.argv[2] ?? '0');
  const firing = firings[targetIdx];
  if (!firing) { console.error('Invalid index'); process.exit(1); }

  console.log(`\n📊 Analyzing: "${firing.scheduleName}" started ${new Date(firing.startTime).toLocaleString()}`);
  console.log(`   Firing ID: ${firing.id}\n`);

  const readings = db.prepare(
    'SELECT timestamp, kilnTempF, relayOn, dutyCycle FROM readings WHERE firingId = ? ORDER BY timestamp ASC'
  ).all(firing.id);

  if (readings.length === 0) {
    console.log('❌ No readings found for this firing (pre-fix orphaned data).');
    console.log('   Run the repair script first: node repair.js');
    process.exit(0);
  }

  console.log(`   Total readings: ${readings.length} (~${Math.round(readings.length * 2 / 60)} minutes of data)\n`);

  // ── Step 1: Detect relay ON cycles ──
  const onCycles = [];
  let cycleStart = null;
  let cycleStartTemp = null;

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const wasOn = cycleStart !== null;
    const isOn  = r.relayOn === 1;

    if (!wasOn && isOn) {
      // Transition 0→1: relay fires ON
      cycleStart     = r.timestamp;
      cycleStartTemp = r.kilnTempF;
    } else if (wasOn && !isOn) {
      // Transition 1→0: relay cuts OFF
      const durationMs  = r.timestamp - cycleStart;
      const midTemp      = (cycleStartTemp + r.kilnTempF) / 2;
      onCycles.push({ durationMs, durationSec: durationMs / 1000, fromTemp: cycleStartTemp, toTemp: r.kilnTempF, midTemp });
      cycleStart = null;
    }
  }
  // If firing ended while relay was still on
  if (cycleStart !== null) {
    const last = readings[readings.length - 1];
    const durationMs = last.timestamp - cycleStart;
    onCycles.push({ durationMs, durationSec: durationMs / 1000, fromTemp: cycleStartTemp, toTemp: last.kilnTempF, midTemp: (cycleStartTemp + last.kilnTempF) / 2 });
  }

  console.log(`   Total ON cycles detected: ${onCycles.length}`);
  const avgDuration = onCycles.reduce((s, c) => s + c.durationSec, 0) / onCycles.length;
  const maxDuration = Math.max(...onCycles.map(c => c.durationSec));
  console.log(`   Average cycle duration:   ${avgDuration.toFixed(1)}s`);
  console.log(`   Longest single ON cycle:  ${maxDuration.toFixed(1)}s\n`);

  // ── Step 2: Bucket by temperature range ──
  const temps = readings.map(r => r.kilnTempF).filter(Boolean);
  const minTemp = Math.floor(Math.min(...temps) / BUCKET_SIZE) * BUCKET_SIZE;
  const maxTemp = Math.ceil(Math.max(...temps) / BUCKET_SIZE) * BUCKET_SIZE;

  const buckets = {};
  for (let t = minTemp; t < maxTemp; t += BUCKET_SIZE) {
    buckets[t] = { cycles: [], totalOnMs: 0, totalWindowMs: 0 };
  }

  // Bucket each ON cycle by its midpoint temperature
  for (const cycle of onCycles) {
    const bucketKey = Math.floor(cycle.midTemp / BUCKET_SIZE) * BUCKET_SIZE;
    if (buckets[bucketKey]) {
      buckets[bucketKey].cycles.push(cycle);
    }
  }

  // Calculate duty cycle per bucket from raw readings
  const readingsByBucket = {};
  for (const r of readings) {
    if (r.kilnTempF == null) continue;
    const key = Math.floor(r.kilnTempF / BUCKET_SIZE) * BUCKET_SIZE;
    if (!readingsByBucket[key]) readingsByBucket[key] = { onCount: 0, total: 0 };
    readingsByBucket[key].total++;
    if (r.relayOn === 1) readingsByBucket[key].onCount++;
  }

  // ── Step 3: Print results ──
  console.log('─'.repeat(72));
  console.log(
    'Temp Range'.padEnd(16) +
    'Cycles'.padEnd(10) +
    'Avg ON Dur'.padEnd(14) +
    'Max ON Dur'.padEnd(14) +
    'Duty Cycle'.padEnd(14) +
    'Verdict'
  );
  console.log('─'.repeat(72));

  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  for (const key of keys) {
    const b = buckets[key];
    const rb = readingsByBucket[key];
    if (!rb || rb.total < 3) continue; // skip buckets with almost no data

    const nCycles  = b.cycles.length;
    const avgDur   = nCycles > 0 ? b.cycles.reduce((s, c) => s + c.durationSec, 0) / nCycles : 0;
    const maxDur   = nCycles > 0 ? Math.max(...b.cycles.map(c => c.durationSec)) : 0;
    const duty     = rb ? (rb.onCount / rb.total * 100).toFixed(0) : 'N/A';
    const label    = `${key}–${key + BUCKET_SIZE}°F`;

    // Flag the 1100°F zone specifically
    let verdict = '';
    if (nCycles === 0) verdict = '⬛ Off entirely / coasting';
    else if (parseFloat(duty) >= 95) verdict = '🔴 FULL BLAST — elements locked on';
    else if (avgDur > 30)            verdict = '🟡 Long pulses — struggling to keep up';
    else if (avgDur > 10)            verdict = '🟢 Healthy cycling';
    else                             verdict = '🔵 Short/rapid pulses — near setpoint';

    // Highlight the critical zone
    const highlight = (key >= 1000 && key < 1200) ? ' ◄◄ CRITICAL ZONE' : '';

    console.log(
      label.padEnd(16) +
      String(nCycles).padEnd(10) +
      `${avgDur.toFixed(1)}s`.padEnd(14) +
      `${maxDur.toFixed(1)}s`.padEnd(14) +
      `${duty}%`.padEnd(14) +
      verdict + highlight
    );
  }

  console.log('─'.repeat(72));
  console.log('\nKey insight: If elements near 1100°F show HIGH duty cycle (>90%) WITH long cycle');
  console.log('durations AND few cycles, the controller is NOT pulsing — it\'s just holding on');
  console.log('continuously, meaning the kiln is truly at its hardware thermal ceiling.\n');

} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
