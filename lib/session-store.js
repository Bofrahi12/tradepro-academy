// SQLite-backed session store for express-session (no in-memory sessions).
'use strict';
const session = require('express-session');

class SQLiteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.getStmt = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
  }
  get(sid, cb) {
    try {
      const r = this.getStmt.get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 7 * 24 * 3600 * 1000;
      this.setStmt.run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

function startSessionCleanup(db, intervalMs = 3600e3) {
  const t = setInterval(() => {
    try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); }
    catch (e) { console.error('[sessions] cleanup failed:', e.message); }
  }, intervalMs);
  if (t.unref) t.unref();
}

module.exports = { SQLiteStore, startSessionCleanup };
