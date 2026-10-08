// TradePro Academy — Express server
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { db, getSettings } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DEMO_PURCHASE = process.env.DEMO_PURCHASE === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
if (!process.env.SESSION_SECRET) console.log('[warn] SESSION_SECRET not set — sessions reset on restart.');
if (!process.env.STRIPE_SECRET_KEY) console.log('[info] STRIPE_SECRET_KEY not set — live Checkout is disabled.');

app.set('trust proxy', 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 7 * 24 * 3600 * 1000 },
}));

// ---------- helpers ----------
const getUser = (id) => db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(id);
const isEnrolled = (userId) => !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ?').get(userId);
const normalizeEmail = (email) => String(email || '').trim().toLowerCase().slice(0, 160);
const validEmail = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
const reqOrigin = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login_required' });
  next();
};
const requireAdmin = (req, res, next) => {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  req.user = u;
  next();
};
const me = (req) => {
  if (!req.session.userId) return null;
  const u = getUser(req.session.userId);
  if (!u) return null;
  u.enrolled = isEnrolled(u.id);
  return u;
};

// Small in-memory guard for auth endpoints. Use a shared limiter such as Redis at scale.
const attempts = new Map();
function authRateLimit(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const item = attempts.get(key) || { count: 0, reset: now + 15 * 60e3 };
  if (now > item.reset) { item.count = 0; item.reset = now + 15 * 60e3; }
  item.count += 1;
  attempts.set(key, item);
  if (item.count > 30) return res.status(429).json({ error: 'too_many_attempts' });
  next();
}

function ensureUserForPurchase(email) {
  email = normalizeEmail(email);
  let u = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE email = ?').get(email);
  if (!u) {
    const temporaryPassword = crypto.randomBytes(32).toString('hex');
    const displayName = email.split('@')[0].slice(0, 80) || 'متعلم جديد';
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(displayName, email, bcrypt.hashSync(temporaryPassword, 12), 'student');
    u = getUser(r.lastInsertRowid);
  }
  return u;
}

function enrollByEmail(email, source) {
  if (!validEmail(email)) return null;
  const u = ensureUserForPurchase(email);
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, source) VALUES (?, ?)').run(u.id, source);
  return u;
}

function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!payload || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  const signatures = String(signatureHeader).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !signatures.length) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some((sig) => {
    try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
  });
}

async function stripeRequest(endpoint, options = {}) {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('stripe_not_configured');
  const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'stripe_request_failed');
  return data;
}

async function claimPaidCheckout(sessionId, req) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(String(sessionId || ''))) throw new Error('invalid_checkout_session');
  const checkout = await stripeRequest(encodeURIComponent(sessionId));
  if (checkout.payment_status !== 'paid' || checkout.mode !== 'payment') throw new Error('payment_not_confirmed');
  const email = checkout.customer_details?.email || checkout.customer_email || checkout.metadata?.email;
  const u = enrollByEmail(email, 'stripe-checkout');
  if (!u) throw new Error('missing_customer_email');
  req.session.userId = u.id;
  return me(req);
}

// ---------- Stripe webhook (raw body MUST be parsed before express.json) ----------
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!secret) return res.status(503).json({ error: 'stripe_webhook_not_configured' });
  if (!verifyStripeSignature(raw.toString('utf8'), req.get('stripe-signature'), secret)) {
    return res.status(400).json({ error: 'invalid_stripe_signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const object = event.data?.object || {};
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const email = object.customer_details?.email || object.customer_email || object.metadata?.email;
    if (email) enrollByEmail(email, `stripe:${event.type}`);
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));

// ---------- runtime / public config ----------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'tradepro-academy' }));
app.get('/js/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({ api: '/api', demo: false, demoPurchase: DEMO_PURCHASE })};`);
});

// ---------- public API ----------
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.get('/api/curriculum', (req, res) => {
  const u = me(req);
  const privileged = u && (u.role === 'admin' || u.enrolled);
  const modules = db.prepare('SELECT * FROM modules WHERE is_visible = 1 ORDER BY sort_order, id').all();
  const out = modules.map((m) => {
    const lessons = db.prepare(
      'SELECT id, title, thumbnail, duration, provider, is_free_preview, sort_order, video_url FROM lessons WHERE module_id = ? AND is_visible = 1 ORDER BY sort_order, id'
    ).all(m.id).map((l) => {
      const canSee = privileged || l.is_free_preview;
      const result = {
        id: l.id, title: l.title, thumbnail: l.thumbnail, duration: l.duration,
        provider: l.provider, is_free_preview: !!l.is_free_preview,
        has_video: canSee && !!l.video_url,
      };
      // Never expose private source URLs in the public curriculum response.
      if (canSee) result.video_url = l.video_url;
      return result;
    });
    return { ...m, lessons };
  });
  res.json(out);
});

app.get('/api/lesson/:id', (req, res) => {
  const u = me(req);
  const l = db.prepare('SELECT * FROM lessons WHERE id = ? AND is_visible = 1').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  const privileged = u && (u.role === 'admin' || u.enrolled);
  if (!privileged && !l.is_free_preview) return res.status(403).json({ error: 'enrollment_required' });
  const resources = db.prepare('SELECT * FROM resources WHERE lesson_id = ?').all(l.id);
  const mod = db.prepare('SELECT id, title FROM modules WHERE id = ?').get(l.module_id);
  res.json({ ...l, module: mod, resources });
});

app.get('/api/public-content', (req, res) => {
  res.json({
    faqs: db.prepare('SELECT id, question, answer FROM faqs WHERE is_visible = 1 ORDER BY sort_order, id').all(),
    bonuses: db.prepare('SELECT id, title, description FROM bonuses WHERE is_visible = 1 ORDER BY sort_order, id').all(),
    testimonials: db.prepare('SELECT id, name, role, text FROM testimonials WHERE is_visible = 1 ORDER BY sort_order, id').all(),
  });
});

app.get('/api/coupon/:code', (req, res) => {
  const c = db.prepare('SELECT code, percent_off FROM coupons WHERE code = ? COLLATE NOCASE AND is_active = 1')
    .get(req.params.code.trim());
  if (!c) return res.status(404).json({ error: 'invalid_coupon' });
  res.json(c);
});

// ---------- Checkout ----------
app.post('/api/checkout/session', authRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email || me(req)?.email);
  if (!validEmail(email)) return res.status(400).json({ error: 'valid_email_required' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  const s = getSettings();
  const amount = Math.round(Number.parseFloat(s.COURSE_PRICE || '0') * 100);
  const currency = String(s.CURRENCY || 'usd').toLowerCase();
  if (!Number.isFinite(amount) || amount < 50) return res.status(400).json({ error: 'invalid_course_price' });
  try {
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': String(amount),
      'line_items[0][price_data][product_data][name]': s.COURSE_NAME || 'Trading Course',
      'line_items[0][price_data][product_data][description]': s.COURSE_DESCRIPTION || 'Online trading education',
      customer_email: email,
      'metadata[email]': email,
      'metadata[product]': 'tradepro-course',
      'metadata[utm_source]': String(req.body?.utm_source || '').slice(0, 100),
      success_url: `${reqOrigin(req)}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${reqOrigin(req)}/offer?checkout=cancelled`,
    });
    const checkout = await stripeRequest('checkout/sessions', { method: 'POST', body });
    res.json({ url: checkout.url, id: checkout.id });
  } catch (e) {
    console.error('[stripe checkout]', e.message);
    res.status(502).json({ error: 'checkout_unavailable' });
  }
});

app.post('/api/checkout/claim', authRateLimit, async (req, res) => {
  try {
    const user = await claimPaidCheckout(req.body?.session_id, req);
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message === 'payment_not_confirmed' ? 'payment_not_confirmed' : 'claim_failed' });
  }
});

// ---------- auth ----------
app.post('/api/auth/register', authRateLimit, (req, res) => {
  const { name, password } = req.body || {};
  const email = normalizeEmail(req.body?.email);
  if (!name || !email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password_too_short' });
  if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  try {
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(String(name).slice(0, 80), email, bcrypt.hashSync(password, 12), 'student');
    req.session.userId = r.lastInsertRowid;
    res.json(me(req));
  } catch { res.status(409).json({ error: 'email_exists' }); }
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(String(req.body?.password || ''), row.password_hash))
    return res.status(401).json({ error: 'invalid_credentials' });
  req.session.userId = row.id;
  res.json(me(req));
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/auth/me', (req, res) => res.json(me(req)));

app.post('/api/auth/forgot', authRateLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (row) {
    const token = crypto.randomBytes(32).toString('hex');
    const exp = new Date(Date.now() + 3600e3).toISOString();
    db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)').run(row.id, token, exp);
    console.log(`[password-reset] request received for ${email}; SMTP delivery is required in production.`);
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', authRateLimit, (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 8) return res.status(400).json({ error: 'invalid_request' });
  const r = db.prepare('SELECT * FROM password_resets WHERE token = ? AND expires_at > datetime(\'now\')').get(token);
  if (!r) return res.status(400).json({ error: 'invalid_token' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), r.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  res.json({ ok: true });
});

// ---------- enrollment (review-only simulation) ----------
app.post('/api/enroll/self', requireAuth, (req, res) => {
  if (!DEMO_PURCHASE) return res.status(403).json({ error: 'disabled' });
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, source) VALUES (?, ?)').run(req.session.userId, 'demo');
  res.json({ ok: true, user: me(req) });
});

// ---------- student API ----------
app.get('/api/progress', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT lesson_id, completed_at FROM progress WHERE user_id = ? ORDER BY completed_at DESC').all(req.session.userId);
  res.json({ completed: rows.map((r) => r.lesson_id), last: rows[0] || null });
});
app.post('/api/progress/complete', requireAuth, (req, res) => {
  const u = me(req);
  if (!u.enrolled && u.role !== 'admin') return res.status(403).json({ error: 'enrollment_required' });
  const { lesson_id } = req.body || {};
  const l = db.prepare('SELECT id FROM lessons WHERE id = ? AND is_visible = 1').get(lesson_id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  db.prepare('INSERT OR IGNORE INTO progress (user_id, lesson_id) VALUES (?, ?)').run(req.session.userId, lesson_id);
  res.json({ ok: true });
});
app.get('/api/notes/:lesson_id', requireAuth, (req, res) => {
  const n = db.prepare('SELECT content, updated_at FROM notes WHERE user_id = ? AND lesson_id = ?').get(req.session.userId, req.params.lesson_id);
  res.json(n || { content: '' });
});
app.put('/api/notes/:lesson_id', requireAuth, (req, res) => {
  const { content } = req.body || {};
  db.prepare(`INSERT INTO notes (user_id, lesson_id, content, updated_at) VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(user_id, lesson_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`)
    .run(req.session.userId, req.params.lesson_id, String(content || '').slice(0, 20000));
  res.json({ ok: true });
});

// ---------- admin API ----------
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const q = (s) => db.prepare(s).get().c;
  res.json({
    students: q('SELECT COUNT(*) c FROM users WHERE role = \'student\''),
    enrolled: q('SELECT COUNT(*) c FROM enrollments'),
    modules: q('SELECT COUNT(*) c FROM modules'),
    lessons: q('SELECT COUNT(*) c FROM lessons'),
    recent: db.prepare('SELECT id, name, email, created_at FROM users WHERE role = \'student\' ORDER BY id DESC LIMIT 8').all(),
  });
});
function crud(base, table, fields) {
  app.get(`/api/admin/${base}`, requireAdmin, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY sort_order, id`).all()));
  app.post(`/api/admin/${base}`, requireAdmin, (req, res) => {
    const vals = fields.map((f) => req.body[f] ?? null);
    const r = db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...vals);
    res.json({ id: r.lastInsertRowid });
  });
  app.put(`/api/admin/${base}/:id`, requireAdmin, (req, res) => {
    const sets = fields.filter((f) => f in req.body);
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE ${table} SET ${sets.map((f) => `${f} = ?`).join(',')} WHERE id = ?`).run(...sets.map((f) => req.body[f]), req.params.id);
    res.json({ ok: true });
  });
  app.delete(`/api/admin/${base}/:id`, requireAdmin, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}
crud('modules', 'modules', ['title', 'description', 'sort_order', 'is_visible']);
crud('lessons', 'lessons', ['module_id', 'title', 'video_url', 'thumbnail', 'description', 'duration', 'provider', 'sort_order', 'is_visible', 'is_free_preview']);
crud('resources', 'resources', ['lesson_id', 'title', 'file_url', 'file_type']);
crud('bonuses', 'bonuses', ['title', 'description', 'sort_order', 'is_visible']);
crud('faqs', 'faqs', ['question', 'answer', 'sort_order', 'is_visible']);
crud('testimonials', 'testimonials', ['name', 'role', 'text', 'sort_order', 'is_visible']);
crud('coupons', 'coupons', ['code', 'percent_off', 'is_active']);
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(req.body || {})) stmt.run(k, String(v ?? ''));
  res.json({ ok: true });
});
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.prepare(`SELECT u.id, u.name, u.email, u.role, u.created_at,
  CASE WHEN e.user_id IS NULL THEN 0 ELSE 1 END AS enrolled
  FROM users u LEFT JOIN enrollments e ON e.user_id = u.id ORDER BY u.id DESC`).all()));
app.post('/api/admin/users/:id/enroll', requireAdmin, (req, res) => { db.prepare('INSERT OR IGNORE INTO enrollments (user_id, source) VALUES (?, ?)').run(req.params.id, 'admin'); res.json({ ok: true }); });
app.post('/api/admin/users/:id/unenroll', requireAdmin, (req, res) => { db.prepare('DELETE FROM enrollments WHERE user_id = ?').run(req.params.id); res.json({ ok: true }); });
app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  if (!['admin', 'student'].includes(req.body.role)) return res.status(400).json({ error: 'invalid_role' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.params.id); res.json({ ok: true });
});

// ---------- page routes ----------
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', page('index.html'));
app.get('/offer', page('offer.html'));
app.get('/checkout-success', page('checkout-success.html'));
app.get('/podcast', page('podcast.html'));
app.get('/course', page('course.html'));
app.get('/login', page('login.html'));
app.get('/register', page('register.html'));
app.get('/forgot', page('forgot.html'));
app.get('/reset', page('reset.html'));
app.get('/student', page('student.html'));
app.get('/admin', page('admin.html'));
app.get('/lesson/:id', page('lesson.html'));

app.listen(PORT, () => console.log(`[tradepro] http://localhost:${PORT} (DEMO_PURCHASE=${DEMO_PURCHASE})`));
