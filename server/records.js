// records.js — Firing session history
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const DATA_FILE = path.join(__dirname, 'data', 'records.json');

// --- AUTOMATIC ONE-TIME MIGRATION ---
function migrateOldData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldData = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(oldData);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.log('[Records] Found old records.json, migrating to SQLite...');
        parsed.forEach(r => db.insertFiring(r));
      }
      fs.renameSync(DATA_FILE, DATA_FILE + '.migrated');
      console.log('[Records] Successfully migrated and backed up records.json');
    } catch (err) {
      console.error('[Records] Failed to migrate records.json:', err.message);
    }
  }
}
// Run migration on startup
migrateOldData();

function getAll() {
  return db.getAllFirings();
}

function getById(id) {
  const firings = db.getAllFirings();
  return firings.find(r => r.id === id) || null;
}

function append(record) {
  const entry = {
    ...record,
    id: record.id || uuidv4(),
    savedAt: new Date().toISOString()
  };
  db.insertFiring(entry);
  return entry;
}

function remove(id) {
  return db.deleteFiring(id);
}

module.exports = { getAll, getById, append, remove };
