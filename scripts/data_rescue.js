const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Determine paths based on where the user runs it
const inScriptDir = path.basename(__dirname) === 'scripts';
const dbPath = path.join(__dirname, inScriptDir ? '..' : '', 'server', 'data', 'kilnforge.db');
const jsonPath = path.join(__dirname, inScriptDir ? '..' : '', 'rescued_firing.json');

console.log('--- KilnForge Data Rescue Utility ---');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.log('Error: Could not load better-sqlite3. Are you running this on the Pi inside the kiln-app folder?');
  process.exit(1);
}

if (!fs.existsSync(jsonPath)) {
  console.log(`Error: Could not find rescued_firing.json at ${jsonPath}`);
  console.log('Make sure you copied it into the kiln-app folder!');
  process.exit(1);
}

const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
if (!Array.isArray(rawData) || rawData.length === 0) {
  console.log('Error: rescued_firing.json is empty or invalid.');
  process.exit(1);
}

const db = new Database(dbPath);

// April 14, 2026 @ 2:30 PM (Local Time)
const baseStartTimeMs = new Date("2026-04-14T14:30:00").getTime();
const firingId = crypto.randomUUID();

let peakTempF = 0;
let sumTempF = 0;

// Map simple [x, y] to full database rows
const readingsToInsert = rawData.map(point => {
  const elapsedMinutes = parseFloat(point.x);
  const tempF = parseFloat(point.y);
  
  if (tempF > peakTempF) peakTempF = tempF;
  sumTempF += tempF;
  
  const timestampMs = baseStartTimeMs + Math.round(elapsedMinutes * 60 * 1000);
  
  return {
    firingId,
    timestamp: timestampMs,
    kilnTempF: tempF,
    relayOn: 0,
    stepIndex: 0
  };
});

const avgTempF = sumTempF / rawData.length;
const endTimeMs = baseStartTimeMs + Math.round(rawData[rawData.length - 1].x * 60 * 1000);

const startTimeStr = new Date(baseStartTimeMs).toISOString();
const endTimeStr = new Date(endTimeMs).toISOString();

console.log(`Discovered ${readingsToInsert.length} data points.`);
console.log(`Generating fake timestamps starting from: ${startTimeStr}`);

// Insert parent firing row
db.prepare(`
  INSERT INTO firings (id, scheduleId, scheduleName, startTime, endTime, peakTempF, avgTempF, totalKWh, kilnWatts) 
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  firingId, null, 'Rescued Watchdog Firing', startTimeStr, endTimeStr, 
  Math.round(peakTempF), Math.round(avgTempF), 0, 0
);

// Batch insert thick point data
const insertReading = db.prepare(`
  INSERT INTO readings (firingId, timestamp, kilnTempF, relayOn, stepIndex)
  VALUES (?, ?, ?, ?, ?)
`);

const transaction = db.transaction((rows) => {
  for (const row of rows) {
    insertReading.run(row.firingId, row.timestamp, row.kilnTempF, row.relayOn, row.stepIndex);
  }
});

transaction(readingsToInsert);

console.log('\n✅ SUCCESS: Firing curves physically injected into the SQLite database!');
console.log('To link it to the UI, run this final command: node repair.js');
