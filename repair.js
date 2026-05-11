const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'server', 'data', 'kilnforge.db');
const JSON_PATH = path.join(__dirname, 'server', 'data', 'records.json');

console.log('--- KilnForge Database Repair Utility ---');
try {
  const db = new Database(DB_PATH);
  let records = [];
  try {
    records = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  } catch (err) {
    console.error("Could not read records.json. Are you in the kiln-app directory?");
    process.exit(1);
  }

  const sqliteFirings = db.prepare('SELECT id, startTime FROM firings').all();
  console.log(`Found ${records.length} records in records.json`);
  console.log(`Found ${sqliteFirings.length} firings in SQLite database`);

  let fixCount = 0;

  for (const record of records) {
    // Find the SQLite entry that shares the exact same start time
    const match = sqliteFirings.find(f => {
      // Treat null/undefined gracefully
      if (!f.startTime || !record.startTime) return false;
      // Compare ignoring milliseconds just in case
      return new Date(f.startTime).getTime() === new Date(record.startTime).getTime();
    });

    if (match) {
      if (match.id !== record.id) {
        console.log(`Mismatch detected for firing started at ${record.startTime}!`);
        console.log(`  - Changing SQLite ID: ${match.id} -> ${record.id}`);
        
        // Update both the firing summary and all associated telemetry dots
        db.prepare('UPDATE firings SET id = ? WHERE id = ?').run(record.id, match.id);
        db.prepare('UPDATE readings SET firingId = ? WHERE firingId = ?').run(record.id, match.id);
        
        fixCount++;
      }
    }
  }

  console.log(`\nRepair complete! Successfully relinked ${fixCount} broken firing curves.`);
  console.log(`You can now view them perfectly in the KilnForge Replay tab!`);
} catch (e) {
  console.error("Error repairing databases:", e.message);
}
