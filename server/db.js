// db.js — SQLite database for full firing temperature curve storage
// Uses better-sqlite3 (synchronous, no async overhead, perfect for Pi)
//
// Install on the Pi before using:
//   npm install better-sqlite3
//
// Tables:
//   firings  — one row per completed firing (mirrors records.json but queryable)
//   readings — one row per 2s telemetry tick during a firing

const path = require('path');

let db = null;

function getDb() {
  if (db) return db;
  try {
    const Database = require('better-sqlite3');
    const DB_PATH = path.join(__dirname, 'data', 'kilnforge.db');
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL'); // faster concurrent reads

    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS firings (
        id            TEXT PRIMARY KEY,
        scheduleId    TEXT,
        scheduleName  TEXT,
        startTime     TEXT,
        endTime       TEXT,
        peakTempF     REAL,
        avgTempF      REAL,
        totalKWh      REAL,
        totalCost     REAL,
        ambientTempF  REAL,
        humidity      REAL,
        kilnWatts     INTEGER,
        savedAt       TEXT
      );

      CREATE TABLE IF NOT EXISTS readings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        firingId      TEXT    NOT NULL,
        timestamp     INTEGER NOT NULL,
        kilnTempF     REAL,
        relayOn       INTEGER,
        stepIndex     INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_readings_firingId ON readings(firingId);
    `);

    try {
      db.exec("ALTER TABLE readings ADD COLUMN dutyCycle REAL");
    } catch(e) {
      // Column likely already exists
    }

    console.log('[DB] SQLite database ready at', DB_PATH);
  } catch (err) {
    console.warn('[DB] SQLite not available (is better-sqlite3 installed?):', err.message);
    db = null;
  }
  return db;
}

// Save a single telemetry reading for the active firing
function insertReading(firingId, { kilnTempF, relayOn, stepIndex, dutyCycle }) {
  const database = getDb();
  if (!database) return;
  try {
    database.prepare(`
      INSERT INTO readings (firingId, timestamp, kilnTempF, relayOn, stepIndex, dutyCycle)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(firingId, Date.now(), kilnTempF ?? null, relayOn ? 1 : 0, stepIndex ?? null, dutyCycle ?? null);
  } catch (err) {
    console.warn('[DB] insertReading error:', err.message);
  }
}

// Save the completed firing summary
function insertFiring(record) {
  const database = getDb();
  if (!database) return;
  try {
    database.prepare(`
      INSERT OR REPLACE INTO firings
        (id, scheduleId, scheduleName, startTime, endTime, peakTempF, avgTempF,
         totalKWh, totalCost, ambientTempF, humidity, kilnWatts, savedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.scheduleId ?? null,
      record.scheduleName ?? null,
      record.startTime ?? null,
      record.endTime ?? null,
      record.peakTempF ?? null,
      record.avgTempF ?? null,
      record.totalKWh ?? null,
      record.totalCost ?? null,
      record.ambientTempF ?? null,
      record.humidity ?? null,
      record.kilnWatts ?? null,
      record.savedAt ?? new Date().toISOString()
    );
  } catch (err) {
    console.warn('[DB] insertFiring error:', err.message);
  }
}

// Get all readings for a firing — used to replay the full temperature chart
function getReadings(firingId) {
  const database = getDb();
  if (!database) return [];
  try {
    return database.prepare(
      'SELECT timestamp, kilnTempF, relayOn, stepIndex, dutyCycle FROM readings WHERE firingId = ? ORDER BY timestamp ASC'
    ).all(firingId);
  } catch (err) {
    console.warn('[DB] getReadings error:', err.message);
    return [];
  }
}

// Get all firing summaries (for Records tab)
function getAllFirings() {
  const database = getDb();
  if (!database) return [];
  try {
    return database.prepare('SELECT * FROM firings ORDER BY startTime DESC').all();
  } catch (err) {
    console.warn('[DB] getAllFirings error:', err.message);
    return [];
  }
}

// Automatically recover firings that were interrupted by power loss or crashes
function autoRecoverFirings() {
  const database = getDb();
  if (!database) return;
  try {
    const missingIds = database.prepare('SELECT DISTINCT firingId FROM readings WHERE firingId NOT IN (SELECT id FROM firings)').all();
    if (missingIds.length === 0) return;
    
    console.log(`[DB] Auto-recovering ${missingIds.length} orphaned firing session(s)...`);
    
    missingIds.forEach(row => {
      const firingId = row.firingId;
      const readings = database.prepare('SELECT * FROM readings WHERE firingId = ? ORDER BY timestamp ASC').all(firingId);
      if (readings.length === 0) return;

      const startTime = new Date(readings[0].timestamp).toISOString();
      const endTime = new Date(readings[readings.length - 1].timestamp).toISOString();
      let peakTempF = 0;
      let sumTemp = 0;
      let count = 0;

      readings.forEach(r => {
        if (r.kilnTempF != null) {
          if (r.kilnTempF > peakTempF) peakTempF = r.kilnTempF;
          sumTemp += r.kilnTempF;
          count++;
        }
      });

      const avgTempF = count > 0 ? sumTemp / count : 0;

      database.prepare(`
        INSERT INTO firings (id, scheduleName, startTime, endTime, peakTempF, avgTempF)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(firingId, 'Recovered Firing (Interrupted)', startTime, endTime, Math.round(peakTempF), Math.round(avgTempF));
      
      console.log(`[DB] Recovered firing: ${firingId}`);
    });
  } catch (err) {
    console.warn('[DB] autoRecoverFirings error:', err.message);
  }
}

// Delete a firing and all its readings
function deleteFiring(firingId) {
  const database = getDb();
  if (!database) return false;
  try {
    database.prepare('DELETE FROM readings WHERE firingId = ?').run(firingId);
    database.prepare('DELETE FROM firings WHERE id = ?').run(firingId);
    return true;
  } catch (err) {
    console.warn('[DB] deleteFiring error:', err.message);
    return false;
  }
}

// --- SCHEDULES CRUD ---
function insertSchedule(schedule) {
  const database = getDb();
  if (!database) return;
  try {
    database.prepare('INSERT OR REPLACE INTO schedules (id, data) VALUES (?, ?)').run(schedule.id, JSON.stringify(schedule));
  } catch (err) {
    console.warn('[DB] insertSchedule error:', err.message);
  }
}

function getAllSchedules() {
  const database = getDb();
  if (!database) return [];
  try {
    const rows = database.prepare('SELECT data FROM schedules').all();
    return rows.map(r => JSON.parse(r.data));
  } catch (err) {
    console.warn('[DB] getAllSchedules error:', err.message);
    return [];
  }
}

function deleteSchedule(id) {
  const database = getDb();
  if (!database) return false;
  try {
    database.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return true;
  } catch (err) {
    console.warn('[DB] deleteSchedule error:', err.message);
    return false;
  }
}

module.exports = { 
  insertReading, insertFiring, getReadings, getAllFirings, deleteFiring,
  insertSchedule, getAllSchedules, deleteSchedule, autoRecoverFirings
};
