const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'kilnforge.db'));

console.log('[Recovery] Scanning database for orphaned temperature readings...');

const missingIds = db.prepare('SELECT DISTINCT firingId FROM readings WHERE firingId NOT IN (SELECT id FROM firings)').all();

if (missingIds.length === 0) {
  console.log('[Recovery] No orphaned readings found. All firings are already recorded!');
  process.exit(0);
}

console.log(`[Recovery] Found ${missingIds.length} orphaned firing session(s). Reconstructing records...`);

missingIds.forEach(row => {
  const firingId = row.firingId;
  const readings = db.prepare('SELECT * FROM readings WHERE firingId = ? ORDER BY timestamp ASC').all(firingId);
  
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

  try {
    db.prepare(`
      INSERT INTO firings (id, scheduleName, startTime, endTime, peakTempF, avgTempF)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(firingId, 'Recovered Firing (Stopped)', startTime, endTime, Math.round(peakTempF), Math.round(avgTempF));
    
    console.log(`[Recovery] Successfully reconstructed record for firing ID: ${firingId}`);
  } catch (err) {
    console.error(`[Recovery] Error saving firing ${firingId}:`, err.message);
  }
});

console.log('[Recovery] Complete! You can now view the recovered data in the KilnForge Recordings tab.');
