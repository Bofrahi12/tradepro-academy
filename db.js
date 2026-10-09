// TradePro Academy — SQLite layer (node:sqlite, built into Node >= 22)
// Includes an idempotent, versioned migration system. Safe to run on existing DBs.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function hasColumn(table, col) {
  try {
    return !!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, col);
  } catch { return false; }
}

const MIGRATIONS = [
  {
    v: 1,
    name: 'orders / payments / refunds / stripe_events / audit_log / sessions tables',
    run() {
      db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        email TEXT NOT NULL,
        stripe_checkout_session_id TEXT UNIQUE,
        stripe_payment_intent_id TEXT,
        base_amount INTEGER NOT NULL,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        coupon_code TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','refunded','disputed')),
        source TEXT NOT NULL DEFAULT 'checkout',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        stripe_payment_intent_id TEXT,
        stripe_charge_id TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded','disputed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
      CREATE TABLE IF NOT EXISTS refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        stripe_refund_id TEXT UNIQUE,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'usd',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'processed',
        error TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
      `);
    },
  },
  {
    v: 2,
    name: 'coupons.expires_at',
    run() { if (!hasColumn('coupons', 'expires_at')) db.exec('ALTER TABLE coupons ADD COLUMN expires_at TEXT'); },
  },
  {
    v: 3,
    name: 'users.must_change_password',
    run() {
      if (!hasColumn('users', 'must_change_password')) db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
      // Existing admins must change password on next login (kills any lingering default-password risk).
      db.prepare("UPDATE users SET must_change_password = 1 WHERE role = 'admin'").run();
    },
  },
  {
    v: 4,
    name: 'password_resets hardening columns',
    run() {
      if (!hasColumn('password_resets', 'token_hash')) db.exec('ALTER TABLE password_resets ADD COLUMN token_hash TEXT');
      if (!hasColumn('password_resets', 'purpose')) db.exec("ALTER TABLE password_resets ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reset'");
      if (!hasColumn('password_resets', 'used_at')) db.exec('ALTER TABLE password_resets ADD COLUMN used_at TEXT');
    },
  },
  {
    v: 5,
    name: 'new default settings keys',
    run() {
      const defaults = {
        GUARANTEE_DAYS: '7',
        SHOW_TESTIMONIALS: '0',
        CURRENCY_ISO: 'usd',
        SUPPORT_WHATSAPP_COUNTRY_CODE: '212',
        COURSE_HOURS: '',
        CONTACT_EMAIL: '',
      };
      const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
      for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
    },
  },
];

for (const m of MIGRATIONS) {
  const done = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.v);
  if (!done) {
    m.run();
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.v);
    console.log(`[db] migration v${m.v} applied: ${m.name}`);
  }
}

function seed() {
  const modCount = db.prepare('SELECT COUNT(*) c FROM modules').get().c;
  if (modCount === 0) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(seed.settings)) setStmt.run(k, String(v));
    const modStmt = db.prepare('INSERT INTO modules (title, description, sort_order, is_visible) VALUES (?, ?, ?, 1)');
    const lesStmt = db.prepare(`INSERT INTO lessons (module_id, title, sort_order, is_visible, provider) VALUES (?, ?, ?, 1, 'youtube')`);
    seed.modules.forEach((m, i) => {
      const r = modStmt.run(m.title, m.description, i);
      m.lessons.forEach((t, j) => lesStmt.run(r.lastInsertRowid, t, j));
    });
    const faqStmt = db.prepare('INSERT INTO faqs (question, answer, sort_order, is_visible) VALUES (?, ?, ?, 1)');
    seed.faqs.forEach((f, i) => faqStmt.run(f.q, f.a, i));
    const bonStmt = db.prepare('INSERT INTO bonuses (title, description, sort_order, is_visible) VALUES (?, ?, ?, 1)');
    seed.bonuses.forEach((b, i) => bonStmt.run(b.title, b.description, i));
    const tesStmt = db.prepare('INSERT INTO testimonials (name, role, text, sort_order, is_visible) VALUES (?, ?, ?, ?, 1)');
    (seed.testimonials || []).forEach((t, i) => tesStmt.run(t.name, t.role, t.text, i));
    const couStmt = db.prepare('INSERT INTO coupons (code, percent_off, is_active) VALUES (?, ?, 1)');
    seed.coupons.forEach((c) => couStmt.run(c.code, c.percent_off));
  }

  // Admin account: NEVER use a default password. Generate a random one on first
  // seed unless ADMIN_PASSWORD is provided via env. Force change on first login.
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@tradepro.local';
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!exists) {
    let adminPass = process.env.ADMIN_PASSWORD;
    const generated = !adminPass;
    if (generated) adminPass = crypto.randomBytes(12).toString('base64url');
    db.prepare('INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 1)')
      .run('Admin', adminEmail, bcrypt.hashSync(adminPass, 12), 'admin');
    if (generated) {
      console.log('================================================================');
      console.log(`[db] ADMIN SEEDED — email: ${adminEmail}`);
      console.log(`[db] ADMIN TEMPORARY PASSWORD: ${adminPass}`);
      console.log('[db] ⚠️  Save it now — it is shown only once. You must change it on first login.');
      console.log('================================================================');
    } else {
      console.log(`[db] seeded admin account: ${adminEmail} (password change required on first login)`);
    }
  }
}
seed();

// Free-preview migration: make sure at least one lesson is a public free preview.
try {
  const fp = db.prepare('SELECT COUNT(*) c FROM lessons WHERE is_free_preview = 1').get().c;
  if (fp === 0) {
    const first = db.prepare('SELECT id FROM lessons ORDER BY id LIMIT 1').get();
    if (first) db.prepare('UPDATE lessons SET is_free_preview = 1 WHERE id = ?').run(first.id);
  }
} catch { /* lessons table may not exist yet in odd states */ }

// Free-preview video: wire the public YouTube video so fresh DB seeds keep it.
try {
  const row = db.prepare('SELECT id, video_url FROM lessons WHERE is_free_preview = 1 ORDER BY id LIMIT 1').get();
  if (row && !row.video_url) {
    db.prepare("UPDATE lessons SET video_url = ?, provider = 'youtube' WHERE id = ?")
      .run('https://youtu.be/jKvKN9rj6Q0', row.id);
  }
  // Course lesson videos (YouTube Unlisted), wired by lesson order.
  const vids = {
    2: 'https://youtu.be/DSjaVvo4sRM',
    3: 'https://youtu.be/K7-HgMW_H_U',
    4: 'https://youtu.be/lUGMR9Qyjmw',
  };
  for (const [lid, url] of Object.entries(vids)) {
    const r = db.prepare('SELECT id, video_url FROM lessons WHERE id = ?').get(lid);
    if (r && !r.video_url) {
      db.prepare("UPDATE lessons SET video_url = ?, provider = 'youtube' WHERE id = ?").run(url, lid);
    }
  }
} catch { /* ignore */ }

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const o = {};
  rows.forEach((r) => (o[r.key] = r.value));
  return o;
}

module.exports = { db, getSettings, DB_PATH };
