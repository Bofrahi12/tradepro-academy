// TradePro Academy — SQLite layer (node:sqlite, built into Node >= 22)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tradepro.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin','student')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS password_resets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  duration TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'youtube' CHECK (provider IN ('youtube','vimeo','cloudflare','mp4')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  is_free_preview INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'other'
);
CREATE TABLE IF NOT EXISTS bonuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  percent_off INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS enrollments (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
`);

function seed() {
  const modCount = db.prepare('SELECT COUNT(*) c FROM modules').get().c;
  if (modCount > 0) return; // already seeded
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));

  const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(seed.settings)) setStmt.run(k, String(v));

  const modStmt = db.prepare('INSERT INTO modules (title, description, sort_order, is_visible) VALUES (?, ?, ?, 1)');
  const lesStmt = db.prepare(`INSERT INTO lessons (module_id, title, sort_order, is_visible, provider)
                              VALUES (?, ?, ?, 1, 'youtube')`);
  seed.modules.forEach((m, i) => {
    const r = modStmt.run(m.title, m.description, i);
    m.lessons.forEach((t, j) => lesStmt.run(r.lastInsertRowid, t, j));
  });

  const faqStmt = db.prepare('INSERT INTO faqs (question, answer, sort_order, is_visible) VALUES (?, ?, ?, 1)');
  seed.faqs.forEach((f, i) => faqStmt.run(f.q, f.a, i));

  const bonStmt = db.prepare('INSERT INTO bonuses (title, description, sort_order, is_visible) VALUES (?, ?, ?, 1)');
  seed.bonuses.forEach((b, i) => bonStmt.run(b.title, b.description, i));

  const couStmt = db.prepare('INSERT INTO coupons (code, percent_off, is_active) VALUES (?, ?, 1)');
  seed.coupons.forEach(c => couStmt.run(c.code, c.percent_off));

  // Default admin (change password after first login!)
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@tradepro.local';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('Admin', adminEmail, bcrypt.hashSync(adminPass, 10), 'admin');

  console.log(`[db] seeded admin account: ${adminEmail} (change the password after first login)`);
}
seed();

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = {};
  rows.forEach(r => (o[r.key] = r.value));
  return o;
}

module.exports = { db, getSettings };
