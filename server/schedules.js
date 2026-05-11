// schedules.js — CRUD for firing schedules
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data', 'schedules.json');

const PRESETS = [
  {
    "id": "schedule-med-bisque-06",
    "name": "Medium Bisque (Cone 06)",
    "kilnWatts": 2400,
    "description": "Standard bisque firing for dry greenware",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "steps": [
      { "id": "s1", "type": "ramp", "label": "Candling / Water Smoking", "targetTempF": 200, "ratePerHour": 80 },
      { "id": "s2", "type": "hold", "label": "Water Smoking Hold", "tempF": 200, "durationMinutes": 60 },
      { "id": "s3", "type": "ramp", "label": "Pre-Quartz", "targetTempF": 1000, "ratePerHour": 200 },
      { "id": "s4", "type": "ramp", "label": "Quartz Inversion", "targetTempF": 1150, "ratePerHour": 100 },
      { "id": "s5", "type": "ramp", "label": "Final Climb", "targetTempF": 1828, "ratePerHour": 250 },
      { "id": "s6", "type": "hold", "label": "Cone 06 Target Hold", "tempF": 1828, "durationMinutes": 10 }
    ]
  },
  {
    "id": "schedule-slow-bisque-04",
    "name": "Slow Bisque (Cone 04)",
    "kilnWatts": 2400,
    "description": "Very slow bisque for thick, large, or slightly damp pieces",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "steps": [
      { "id": "s1", "type": "ramp", "label": "Ultra Slow Candling", "targetTempF": 200, "ratePerHour": 30 },
      { "id": "s2", "type": "hold", "label": "Overnight Candling Hold", "tempF": 180, "durationMinutes": 180 },
      { "id": "s3", "type": "ramp", "label": "Carbon Burnout", "targetTempF": 1000, "ratePerHour": 150 },
      { "id": "s4", "type": "ramp", "label": "Quartz Inversion", "targetTempF": 1150, "ratePerHour": 90 },
      { "id": "s5", "type": "ramp", "label": "Climb", "targetTempF": 1600, "ratePerHour": 200 },
      { "id": "s6", "type": "ramp", "label": "Final to Cone 04", "targetTempF": 1945, "ratePerHour": 108 },
      { "id": "s7", "type": "hold", "label": "Cone 04 Hold", "tempF": 1945, "durationMinutes": 15 }
    ]
  },
  {
    "id": "schedule-fast-glaze-6",
    "name": "Fast Glaze (Cone 6)",
    "kilnWatts": 2400,
    "description": "Quick mid-fire glaze (good for commercial and low-defect glazes)",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "steps": [
      { "id": "s1", "type": "ramp", "label": "Initial Fast Climb", "targetTempF": 2050, "ratePerHour": 450 },
      { "id": "s2", "type": "ramp", "label": "Controlled Final Climb", "targetTempF": 2232, "ratePerHour": 150 },
      { "id": "s3", "type": "hold", "label": "Soak Cone 6", "tempF": 2232, "durationMinutes": 15 },
      { "id": "s4", "type": "ramp", "label": "Crash Cool Drop", "targetTempF": 1900, "ratePerHour": 9999 },
      { "id": "s5", "type": "hold", "label": "Drop & Hold (Heal pinholes)", "tempF": 1900, "durationMinutes": 15 }
    ]
  },
  {
    "id": "schedule-med-glaze-6",
    "name": "Medium Glaze (Cone 6)",
    "kilnWatts": 2400,
    "description": "Standard Cone 6 glaze firing with controlled cooling",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "steps": [
      { "id": "s1", "type": "ramp", "label": "Safe Climb", "targetTempF": 250, "ratePerHour": 150 },
      { "id": "s2", "type": "ramp", "label": "Body Climb", "targetTempF": 2050, "ratePerHour": 350 },
      { "id": "s3", "type": "ramp", "label": "Final Climb", "targetTempF": 2232, "ratePerHour": 130 },
      { "id": "s4", "type": "hold", "label": "Soak", "tempF": 2232, "durationMinutes": 12 },
      { "id": "s5", "type": "ramp", "label": "Controlled Cool (Matte)", "targetTempF": 1900, "ratePerHour": 150 }
    ]
  },
  {
    "id": "schedule-low-glaze-04",
    "name": "Low-Fire Glaze (Cone 04)",
    "kilnWatts": 2400,
    "description": "Standard low-fire glaze (commercial earthenware glazes)",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "steps": [
      { "id": "s1", "type": "ramp", "label": "Warm Up", "targetTempF": 250, "ratePerHour": 200 },
      { "id": "s2", "type": "ramp", "label": "Main Climb", "targetTempF": 1700, "ratePerHour": 400 },
      { "id": "s3", "type": "ramp", "label": "Final Slow Climb", "targetTempF": 1945, "ratePerHour": 120 },
      { "id": "s4", "type": "hold", "label": "Cone 04 Soak", "tempF": 1945, "durationMinutes": 15 }
    ]
  }
];

const db = require('./db');

// --- AUTOMATIC ONE-TIME MIGRATION ---
function migrateOldData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldData = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(oldData);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log('[Schedules] Found old schedules.json, migrating to SQLite...');
        parsed.forEach(s => db.insertSchedule(s));
      }
      fs.renameSync(DATA_FILE, DATA_FILE + '.migrated');
      console.log('[Schedules] Successfully migrated and backed up schedules.json');
    } catch (err) {
      console.error('[Schedules] Failed to migrate schedules.json:', err.message);
    }
  }
}
// Run migration on startup
migrateOldData();

// --- CRUD OPERATIONS USING SQLITE ---

function getAll() {
  const schedules = db.getAllSchedules();
  // If the database is completely empty (no presets), insert presets
  if (schedules.length === 0) {
    PRESETS.forEach(p => db.insertSchedule(p));
    return PRESETS;
  }
  return schedules;
}

function getById(id) {
  return getAll().find(s => s.id === id) || null;
}

function create(data) {
  const schedule = {
    id: uuidv4(),
    name: data.name || 'Untitled Schedule',
    kilnWatts: data.kilnWatts || 2400,
    description: data.description || '',
    createdAt: new Date().toISOString(),
    steps: (data.steps || []).map(step => ({ ...step, id: uuidv4() }))
  };
  db.insertSchedule(schedule);
  return schedule;
}

function update(id, data) {
  const schedules = getAll();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return null;
  const updatedSchedule = {
    ...schedules[idx],
    ...data,
    id, // preserve id
    updatedAt: new Date().toISOString(),
    steps: (data.steps || schedules[idx].steps).map(step => ({
      ...step,
      id: step.id || uuidv4()
    }))
  };
  db.insertSchedule(updatedSchedule);
  return updatedSchedule;
}

function remove(id) {
  return db.deleteSchedule(id);
}

function restorePreset(id) {
  const preset = PRESETS.find(p => p.id === id);
  if (!preset) return null;
  db.insertSchedule(preset);
  return preset;
}

module.exports = { getAll, getById, create, update, remove, restorePreset };
