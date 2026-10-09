// Backup the SQLite database (WAL checkpoint + file copy).
// Usage: node scripts/backup-db.js [--dir backups]
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'tradepro.db');
const dirArg = process.argv.indexOf('--dir');
const backupDir = dirArg > -1 ? process.argv[dirArg + 1] : path.join(__dirname, '..', 'backups');

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] database not found: ${DB_PATH}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });

// Checkpoint WAL so the main file is self-contained, then copy.
const db = new DatabaseSync(DB_PATH);
try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) { console.error('[backup] checkpoint warning:', e.message); }
db.close();

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dest = path.join(backupDir, `tradepro-${stamp}.db`);
fs.copyFileSync(DB_PATH, dest);
const size = fs.statSync(dest).size;
console.log(`[backup] saved ${dest} (${(size / 1024).toFixed(1)} KB)`);

// Keep only the newest 30 backups.
const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('tradepro-') && f.endsWith('.db')).sort();
while (files.length > 30) {
  const old = files.shift();
  fs.unlinkSync(path.join(backupDir, old));
  console.log(`[backup] pruned old backup ${old}`);
}
