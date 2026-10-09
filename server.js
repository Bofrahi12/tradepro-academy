// TradePro Academy — Express server (production-hardened)
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSettings } = require('./db');
const V = require('./lib/validate');
const { getPricing } = require('./lib/pricing');
const mailer = require('./lib/mailer');
const { SQLiteStore, startSessionCleanup } = require('./lib/session-store');
const { csrfIssue, csrfProtect } = require('./lib/csrf');
const { securityHeaders, rateLimit } = require('./lib/security');
const { audit } = require('./lib/audit');
const { waLink } = require('./lib/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';
const DEMO_PURCHASE = process.env.DEMO_PURCHASE === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const GA4_ID = process.env.GA4_MEASUREMENT_ID || '';
const META_PIXEL_ID = process.env.META_PIXEL_ID || '';
const PROTECT_MEDIA = process.env.PROTECT_MEDIA === 'true';
const MEDIA_SECRET = process.env.MEDIA_SIGNING_SECRET || SESSION_SECRET || 'media-dev-secret';

// ---------- production guards ----------
(function productionGuards() {
  const problems = [];
  if (!SESSION_SECRET) problems.push('SESSION_SECRET غير مضبوط — الجلسات ستضيع عند إعادة التشغيل');
  if ((process.env.ADMIN_PASSWORD || '') === 'admin123') problems.push('ADMIN_PASSWORD ما زال القيمة الافتراضية الخطيرة admin123');
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if (sk.startsWith('sk_live') && !process.env.STRIPE_WEBHOOK_SECRET) problems.push('STRIPE_WEBHOOK_SECRET مفقود مع مفتاح Stripe الحي (sk_live)');
  if (!COOKIE_SECURE && PUBLIC_URL.startsWith('https://')) problems.push('COOKIE_SECURE يجب أن يكون true عند العمل عبر HTTPS');
  if (!problems.length) return;
  console.error('[FATAL] Production guards:\n - ' + problems.join('\n - '));
  if (isProd) process.exit(1);
})();
if (!SESSION_SECRET) console.log('[warn] SESSION_SECRET not set — using an ephemeral secret (sessions reset on restart).');
if (!process.env.STRIPE_SECRET_KEY) console.log('[info] STRIPE_SECRET_KEY not set — live Checkout is disabled.');
if (!mailer.mailerReady()) console.log('[warn] SMTP غير مهيأ — إرسال البريد (الترحيب/استعادة كلمة المرور) معطّل.');

// Test hooks (only in test env)
const testHooks = {};
if (NODE_ENV === 'test') app.locals.testHooks = testHooks;

// ---------- middleware ----------
app.set('trust proxy', TRUST_PROXY ? 1 : 0); // never trust X-Forwarded-For unless behind a known proxy
app.use(securityHeaders({ ga4: !!GA4_ID, metaPixel: !!META_PIXEL_ID }));
app.use(session({
  secret: SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  store: new SQLiteStore(db),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, maxAge: 7 * 24 * 3600 * 1000 },
}));
startSessionCleanup(db);
app.use(csrfIssue(COOKIE_SECURE));

// ---------- helpers ----------
const getUser = (id) => db.prepare('SELECT id, name, email, role, must_change_password, created_at FROM users WHERE id = ?').get(id);
const isEnrolled = (userId) => !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ?').get(userId);
const normalizeEmail = (email) => String(email || '').trim().toLowerCase().slice(0, 160);
const reqOrigin = (req) => PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'login_required' });
  next();
};
const requireAdmin = (req, res, next) => {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  if (u.must_change_password && !req.path.endsWith('/change-password')) {
    return res.status(403).json({ error: 'password_change_required' });
  }
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
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function timingSafeEq(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); }
  catch { return false; }
}

// Ordered visible lessons (single source of truth for sequential unlock)
function orderedLessons() {
  return db.prepare(
    `SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id
     WHERE l.is_visible = 1 AND m.is_visible = 1
     ORDER BY m.sort_order, m.id, l.sort_order, l.id`
  ).all().map((r) => r.id);
}
function isLessonUnlocked(userId, lessonId) {
  const flat = orderedLessons();
  const idx = flat.indexOf(Number(lessonId));
  if (idx === -1) return false;
  if (idx === 0) return true;
  return !!db.prepare('SELECT 1 FROM progress WHERE user_id = ? AND lesson_id = ?').get(userId, flat[idx - 1]);
}

// ---------- Stripe helpers ----------
function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!payload || !signatureHeader || !secret) return false;
  const parts = Object.fromEntries(String(signatureHeader).split(',').map((part) => part.split('=')));
  const timestamp = Number(parts.t);
  const signatures = String(signatureHeader).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300 || !signatures.length) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return signatures.some((sig) => timingSafeEq(sig, expected));
}

async function stripeRequest(endpoint, options = {}) {
  if (NODE_ENV === 'test' && global.__stripeMock) return global.__stripeMock(endpoint, options);
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('stripe_not_configured');
  const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'stripe_request_failed');
  return data;
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

function setOrderStatus(id, status) {
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

async function sendWelcomeEmailFor(user) {
  if (!mailer.mailerReady() || !PUBLIC_URL) return;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  db.prepare(`INSERT INTO password_resets (user_id, token, token_hash, purpose, expires_at)
              VALUES (?, ?, ?, 'setup', datetime('now', '+48 hours'))`).run(user.id, tokenHash, tokenHash);
  const s = getSettings();
  try {
    await mailer.sendWelcomeEmail({
      name: user.name, email: user.email,
      courseName: s.COURSE_NAME || 'TradePro Academy',
      setupUrl: `${PUBLIC_URL}/reset?token=${token}`,
      loginUrl: `${PUBLIC_URL}/login`,
    });
  } catch (e) { console.error('[mail] welcome failed:', e.message); }
}

function fulfillCheckoutSession(cs) {
  // Idempotent fulfillment: safe to call twice for the same order.
  let order = null;
  const oid = Number(cs.metadata?.order_id);
  if (oid) order = db.prepare('SELECT * FROM orders WHERE id = ?').get(oid);
  if (!order && cs.id) order = db.prepare('SELECT * FROM orders WHERE stripe_checkout_session_id = ?').get(cs.id);
  if (order) {
    if (Number(cs.amount_total) !== order.amount || String(cs.currency || '').toLowerCase() !== order.currency) {
      throw new Error(`amount_mismatch: order ${order.id} expects ${order.amount} ${order.currency}, got ${cs.amount_total} ${cs.currency}`);
    }
    if (String(cs.metadata?.product || '') !== 'tradepro-course') throw new Error('unknown_product');
  }
  const email = normalizeEmail(cs.customer_details?.email || cs.customer_email || cs.metadata?.email);
  if (!V.validEmail(email)) throw new Error('missing_customer_email');
  const user = ensureUserForPurchase(email);
  if (!order) {
    const p = getPricing(cs.metadata?.coupon_code);
    const r = db.prepare(
      `INSERT INTO orders (user_id, email, stripe_checkout_session_id, stripe_payment_intent_id,
        base_amount, discount_amount, amount, currency, coupon_code, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'stripe')`
    ).run(user.id, email, cs.id || null, cs.payment_intent || null, p.base, p.discount, p.amount, p.currency, p.couponCode);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.lastInsertRowid);
  } else if (order.status !== 'paid') {
    db.prepare(`UPDATE orders SET status = 'paid', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, ?),
      user_id = COALESCE(user_id, ?), updated_at = datetime('now') WHERE id = ?`)
      .run(cs.payment_intent || null, user.id, order.id);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  } else {
    return order; // already fulfilled
  }
  db.prepare(`INSERT INTO payments (order_id, stripe_payment_intent_id, amount, currency, status)
              VALUES (?, ?, ?, ?, 'succeeded')`)
    .run(order.id, cs.payment_intent || null, order.amount, order.currency);
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, source) VALUES (?, ?)').run(user.id, 'stripe');
  audit(user.id, 'order_paid', 'order', order.id, `${order.amount} ${order.currency}${order.coupon_code ? ' coupon:' + order.coupon_code : ''}`);
  sendWelcomeEmailFor(user);
  return order;
}

function handleStripeEvent(event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.payment_status !== 'paid') return; // wait for the async success event
      fulfillCheckoutSession(o);
      break;
    }
    case 'payment_intent.payment_failed': {
      const order = o.id && db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id = ?').get(o.id);
      if (order && order.status === 'pending') {
        setOrderStatus(order.id, 'failed');
        db.prepare(`INSERT INTO payments (order_id, stripe_payment_intent_id, amount, currency, status)
                    VALUES (?, ?, ?, ?, 'failed')`).run(order.id, o.id, order.amount, order.currency);
        audit(null, 'payment_failed', 'order', order.id, String(o.last_payment_error?.message || '').slice(0, 200));
      }
      break;
    }
    case 'charge.refunded': {
      const pi = o.payment_intent;
      const order = pi && db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id = ?').get(typeof pi === 'string' ? pi : pi.id);
      if (!order) return;
      const refundId = o.refunds?.data?.[0]?.id || null;
      db.prepare('INSERT OR IGNORE INTO refunds (order_id, stripe_refund_id, amount, currency, reason) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, refundId, o.amount_refunded || 0, String(o.currency || 'usd').toLowerCase(), 'charge_refunded');
      db.prepare(`INSERT INTO payments (order_id, stripe_payment_intent_id, stripe_charge_id, amount, currency, status)
                  VALUES (?, ?, ?, ?, ?, 'refunded')`)
        .run(order.id, typeof pi === 'string' ? pi : pi?.id || null, o.id || null, o.amount_refunded || 0, String(o.currency || 'usd').toLowerCase());
      if ((o.amount_refunded || 0) >= order.amount) {
        setOrderStatus(order.id, 'refunded');
        if (order.user_id) db.prepare('DELETE FROM enrollments WHERE user_id = ?').run(order.user_id);
      }
      audit(null, 'stripe_refund', 'order', order.id, `refunded ${o.amount_refunded}`);
      break;
    }
    case 'charge.dispute.created': {
      const pi = o.payment_intent;
      const order = pi && db.prepare('SELECT * FROM orders WHERE stripe_payment_intent_id = ?').get(typeof pi === 'string' ? pi : pi.id);
      if (order) {
        setOrderStatus(order.id, 'disputed');
        audit(null, 'stripe_dispute', 'order', order.id, '');
      }
      break;
    }
    default:
      break;
  }
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
  if (!event.id || !event.type) return res.status(400).json({ error: 'invalid_event' });
  // Idempotency: never process the same Stripe event twice.
  const ins = db.prepare('INSERT OR IGNORE INTO stripe_events (event_id, type) VALUES (?, ?)').run(event.id, event.type);
  if (ins.changes === 0) return res.json({ received: true, duplicate: true });
  try {
    handleStripeEvent(event);
    db.prepare("UPDATE stripe_events SET status = 'processed' WHERE event_id = ?").run(event.id);
    res.json({ received: true });
  } catch (e) {
    console.error('[stripe webhook]', event.type, e.message);
    db.prepare("UPDATE stripe_events SET status = 'failed', error = ? WHERE event_id = ?")
      .run(String(e.message).slice(0, 500), event.id);
    res.status(500).json({ error: 'event_failed' });
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(csrfProtect);

// ---------- rate limiters ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, max: 10 });
const registerLimiter = rateLimit({ windowMs: 60 * 60e3, max: 10 });
const forgotLimiter = rateLimit({ windowMs: 60 * 60e3, max: 5 });
const checkoutLimiter = rateLimit({ windowMs: 60 * 60e3, max: 20 });
const claimLimiter = rateLimit({ windowMs: 60 * 60e3, max: 30 });
const adminLimiter = rateLimit({ windowMs: 60e3, max: 120 });

// ---------- runtime / public config ----------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'tradepro-academy' }));
app.get('/js/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify({
    api: '/api', demo: false, demoPurchase: DEMO_PURCHASE,
    stripe: !!process.env.STRIPE_SECRET_KEY,
    ga4: GA4_ID || null, metaPixel: META_PIXEL_ID || null,
  })};`);
});
app.get('/api/contact-info', (req, res) => {
  const s = getSettings();
  res.json({ whatsapp: waLink(s, `مرحباً، عندي سؤال حول دورة ${s.COURSE_NAME || ''}`), email: s.CONTACT_EMAIL || '' });
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
      if (canSee) result.video_url = protectMediaUrl(l, u);
      return result;
    });
    return { ...m, lessons };
  });
  res.json(out);
});

// Signed media URLs for private MP4s (optional, enabled via PROTECT_MEDIA=true)
function mediaToken(lessonId, ttlSec = 7200) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const token = crypto.createHmac('sha256', MEDIA_SECRET).update(`${lessonId}.${exp}`).digest('hex');
  return { token, exp };
}
function protectMediaUrl(l, u) {
  if (!PROTECT_MEDIA || l.provider !== 'mp4' || !l.video_url) return l.video_url;
  if (u && u.role === 'admin') return l.video_url;
  const { token, exp } = mediaToken(l.id);
  return `/api/media/lesson/${l.id}?token=${token}&exp=${exp}`;
}
app.get('/api/media/lesson/:id', requireAuth, (req, res) => {
  const l = db.prepare('SELECT * FROM lessons WHERE id = ? AND is_visible = 1').get(req.params.id);
  if (!l || l.provider !== 'mp4' || !l.video_url) return res.status(404).json({ error: 'not_found' });
  const u = me(req);
  const privileged = u && (u.role === 'admin' || u.enrolled);
  if (!privileged && !l.is_free_preview) return res.status(403).json({ error: 'enrollment_required' });
  const { token, exp } = req.query;
  const expected = crypto.createHmac('sha256', MEDIA_SECRET).update(`${l.id}.${exp}`).digest('hex');
  if (!exp || Number(exp) < Date.now() / 1000 || !token || !timingSafeEq(token, expected)) {
    return res.status(403).json({ error: 'invalid_media_token' });
  }
  res.redirect(302, l.video_url);
});

app.get('/api/lesson/:id', (req, res) => {
  if (!V.isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const u = me(req);
  const l = db.prepare('SELECT * FROM lessons WHERE id = ? AND is_visible = 1').get(req.params.id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  const privileged = u && (u.role === 'admin' || u.enrolled);
  if (!privileged && !l.is_free_preview) return res.status(403).json({ error: 'enrollment_required' });
  // Server-side sequential unlock (admins bypass; free preview always open)
  if (privileged && u.role !== 'admin' && !l.is_free_preview && !isLessonUnlocked(u.id, l.id)) {
    return res.status(403).json({ error: 'lesson_locked' });
  }
  const resources = db.prepare('SELECT id, title, file_type FROM resources WHERE lesson_id = ?').all(l.id);
  const mod = db.prepare('SELECT id, title FROM modules WHERE id = ?').get(l.module_id);
  const out = { ...l, module: mod, resources };
  out.video_url = protectMediaUrl(l, u);
  res.json(out);
});

app.get('/api/public-content', (req, res) => {
  res.json({
    faqs: db.prepare('SELECT id, question, answer FROM faqs WHERE is_visible = 1 ORDER BY sort_order, id').all(),
    bonuses: db.prepare('SELECT id, title, description FROM bonuses WHERE is_visible = 1 ORDER BY sort_order, id').all(),
    testimonials: db.prepare('SELECT id, name, role, text FROM testimonials WHERE is_visible = 1 ORDER BY sort_order, id').all(),
  });
});

// Server-side coupon validation + price breakdown (single source of truth)
app.get('/api/coupon/validate', (req, res) => {
  const p = getPricing(req.query.code);
  if (!p.couponCode) return res.status(404).json({ error: 'invalid_coupon' });
  res.json({
    code: p.couponCode, percent_off: p.percentOff,
    before: p.base, discount: p.discount, final: p.amount,
    currency: p.currency, display: p.display,
  });
});
// Legacy alias (kept for compatibility)
app.get('/api/coupon/:code', (req, res) => {
  const p = getPricing(req.params.code);
  if (!p.couponCode) return res.status(404).json({ error: 'invalid_coupon' });
  res.json({ code: p.couponCode, percent_off: p.percentOff });
});

// ---------- Checkout (server-side only pricing) ----------
app.post('/api/checkout/session', checkoutLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!V.validEmail(email)) return res.status(400).json({ error: 'valid_email_required' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'stripe_not_configured' });
  const p = getPricing(req.body?.coupon_code);
  if (p.base < 50) return res.status(400).json({ error: 'invalid_course_price' });
  const s = getSettings();
  const user = ensureUserForPurchase(email);
  const r = db.prepare(
    `INSERT INTO orders (user_id, email, base_amount, discount_amount, amount, currency, coupon_code, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'checkout')`
  ).run(user.id, email, p.base, p.discount, p.amount, p.currency, p.couponCode);
  const orderId = r.lastInsertRowid;
  try {
    const params = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': p.currency,
      'line_items[0][price_data][unit_amount]': String(p.amount),
      'line_items[0][price_data][product_data][name]': s.COURSE_NAME || 'Trading Course',
      'line_items[0][price_data][product_data][description]': s.COURSE_DESCRIPTION || 'Online trading education',
      customer_email: email,
      'metadata[email]': email,
      'metadata[order_id]': String(orderId),
      'metadata[product]': 'tradepro-course',
      'metadata[utm_source]': String(req.body?.utm_source || '').slice(0, 100),
      success_url: `${reqOrigin(req)}/checkout-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${reqOrigin(req)}/offer?checkout=cancelled`,
    });
    if (p.couponCode) params.set('metadata[coupon_code]', p.couponCode);
    const checkout = await stripeRequest('checkout/sessions', { method: 'POST', body: params });
    db.prepare("UPDATE orders SET stripe_checkout_session_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(checkout.id, orderId);
    res.json({ url: checkout.url, id: checkout.id, order_id: orderId });
  } catch (e) {
    console.error('[stripe checkout]', e.message);
    setOrderStatus(orderId, 'failed');
    res.status(502).json({ error: 'checkout_unavailable' });
  }
});

app.post('/api/checkout/claim', claimLimiter, async (req, res) => {
  const sessionId = String(req.body?.session_id || '');
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) return res.status(400).json({ error: 'invalid_checkout_session' });
  try {
    const cs = await stripeRequest(encodeURIComponent(sessionId));
    const status = cs.payment_status === 'paid' && cs.mode === 'payment' ? 'paid'
      : cs.status === 'expired' ? 'cancelled'
      : cs.payment_status === 'unpaid' && cs.status === 'open' ? 'pending' : 'failed';
    if (status === 'paid') {
      const order = fulfillCheckoutSession(cs);
      const user = getUser(order.user_id);
      req.session.userId = user.id;
      return res.json({ ok: true, status: 'paid', user: me(req) });
    }
    return res.json({ ok: false, status });
  } catch (e) {
    console.error('[stripe claim]', e.message);
    res.status(400).json({ error: 'claim_failed' });
  }
});

// ---------- auth ----------
app.post('/api/auth/register', registerLimiter, (req, res) => {
  const name = V.cleanText(req.body?.name, 80);
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!name || !email || !password) return res.status(400).json({ error: 'missing_fields' });
  if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
  if (!V.validEmail(email)) return res.status(400).json({ error: 'invalid_email' });
  try {
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name, email, bcrypt.hashSync(password, 12), 'student');
    req.session.userId = r.lastInsertRowid;
    audit(r.lastInsertRowid, 'user_registered', 'user', r.lastInsertRowid, '');
    res.json(me(req));
  } catch { res.status(409).json({ error: 'email_exists' }); }
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!V.validEmail(email)) return res.status(401).json({ error: 'invalid_credentials' });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(String(req.body?.password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  req.session.userId = row.id;
  const u = me(req);
  res.json({ ...u, must_change_password: !!row.must_change_password });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
app.get('/api/auth/me', (req, res) => res.json(me(req)));

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!row) return res.status(401).json({ error: 'login_required' });
  const mustChange = row.must_change_password === 1;
  const { current_password, new_password } = req.body || {};
  if (!mustChange && !bcrypt.compareSync(String(current_password || ''), row.password_hash)) {
    return res.status(401).json({ error: 'invalid_current_password' });
  }
  if (!new_password || String(new_password).length < 8) return res.status(400).json({ error: 'password_too_short' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(String(new_password), 12), row.id);
  audit(row.id, 'password_changed', 'user', row.id, mustChange ? 'forced_first_login' : 'self_service');
  res.json({ ok: true });
});

app.post('/api/auth/forgot', forgotLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  // Never reveal whether the email exists.
  const row = V.validEmail(email) ? db.prepare('SELECT id, name FROM users WHERE email = ?').get(email) : null;
  if (row) {
    // Always mint a single-use token (sending is best-effort and needs SMTP).
    // The raw token is NEVER stored: only its SHA-256 hash (token column kept for legacy rows).
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    db.prepare(`INSERT INTO password_resets (user_id, token, token_hash, purpose, expires_at)
                VALUES (?, ?, ?, 'reset', datetime('now', '+1 hour'))`).run(row.id, tokenHash, tokenHash);
    if (NODE_ENV === 'test') testHooks.lastResetToken = token;
    if (mailer.mailerReady() && PUBLIC_URL) {
      try {
        const s = getSettings();
        await mailer.sendPasswordResetEmail({
          name: row.name, email, courseName: s.COURSE_NAME || 'TradePro Academy',
          resetUrl: `${PUBLIC_URL}/reset?token=${token}`,
        });
      } catch (e) { console.error('[mail] reset failed:', e.message); }
    } else {
      // No SMTP: log that a request happened, NEVER the token or a reset link.
      console.log('[password-reset] request received; SMTP not configured — no email sent.');
    }
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset', loginLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 8) return res.status(400).json({ error: 'invalid_request' });
  const r = db.prepare(
    `SELECT * FROM password_resets WHERE token_hash = ? AND purpose IN ('reset','setup')
     AND used_at IS NULL AND expires_at > datetime('now')`
  ).get(sha256(String(token)));
  if (!r) return res.status(400).json({ error: 'invalid_token' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(String(password), 12), r.user_id);
  const th = sha256(String(token));
  db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(th);
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND token_hash != ?').run(r.user_id, th);
  audit(r.user_id, 'password_reset', 'user', r.user_id, `purpose:${r.purpose}`);
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
  if (!V.isId(lesson_id)) return res.status(404).json({ error: 'not_found' });
  const l = db.prepare(
    `SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id
     WHERE l.id = ? AND l.is_visible = 1 AND m.is_visible = 1`
  ).get(lesson_id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  if (u.role !== 'admin' && !isLessonUnlocked(req.session.userId, lesson_id)) {
    return res.status(403).json({ error: 'lesson_locked' });
  }
  db.prepare('INSERT OR IGNORE INTO progress (user_id, lesson_id) VALUES (?, ?)').run(req.session.userId, lesson_id);
  res.json({ ok: true });
});
app.get('/api/notes/:lesson_id', requireAuth, (req, res) => {
  if (!V.isId(req.params.lesson_id)) return res.status(404).json({ error: 'not_found' });
  const n = db.prepare('SELECT content, updated_at FROM notes WHERE user_id = ? AND lesson_id = ?').get(req.session.userId, req.params.lesson_id);
  res.json(n || { content: '' });
});
app.put('/api/notes/:lesson_id', requireAuth, (req, res) => {
  if (!V.isId(req.params.lesson_id)) return res.status(404).json({ error: 'not_found' });
  const l = db.prepare('SELECT id FROM lessons WHERE id = ? AND is_visible = 1').get(req.params.lesson_id);
  if (!l) return res.status(404).json({ error: 'not_found' });
  const { content } = req.body || {};
  db.prepare(`INSERT INTO notes (user_id, lesson_id, content, updated_at) VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(user_id, lesson_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`)
    .run(req.session.userId, req.params.lesson_id, V.cleanText(content, 20000));
  res.json({ ok: true });
});

// ---------- admin API ----------
app.use('/api/admin', adminLimiter);

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const q = (s) => db.prepare(s).get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status = 'paid'").get().s;
  res.json({
    students: q("SELECT COUNT(*) c FROM users WHERE role = 'student'"),
    enrolled: q('SELECT COUNT(*) c FROM enrollments'),
    modules: q('SELECT COUNT(*) c FROM modules'),
    lessons: q('SELECT COUNT(*) c FROM lessons'),
    orders: q('SELECT COUNT(*) c FROM orders'),
    paidOrders: q("SELECT COUNT(*) c FROM orders WHERE status = 'paid'"),
    pendingOrders: q("SELECT COUNT(*) c FROM orders WHERE status = 'pending'"),
    refunds: q('SELECT COUNT(*) c FROM refunds'),
    revenueCents: revenue,
    recent: db.prepare("SELECT id, name, email, created_at FROM users WHERE role = 'student' ORDER BY id DESC LIMIT 8").all(),
  });
});

// ---- orders & payments ----
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const { q: search, status } = req.query;
  let sql = `SELECT o.*, u.name AS user_name FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE 1=1`;
  const params = [];
  if (status && ['pending', 'paid', 'failed', 'cancelled', 'refunded', 'disputed'].includes(status)) {
    sql += ' AND o.status = ?'; params.push(status);
  }
  if (search) {
    sql += ' AND (o.email LIKE ? OR u.name LIKE ? OR o.stripe_checkout_session_id LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY o.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  res.json(db.prepare(
    `SELECT p.*, o.email FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.id DESC LIMIT 200`
  ).all());
});
function csvDownload(res, filename, headers, rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + headers.join(',') + '\n' + rows.map((r) => r.map(q).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
app.get('/api/admin/orders/export', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT o.id, o.email, u.name, o.amount, o.currency, o.discount_amount, o.coupon_code, o.status,
            o.stripe_checkout_session_id, o.source, o.created_at
     FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC`
  ).all();
  csvDownload(res, 'orders.csv',
    ['id', 'email', 'name', 'amount_cents', 'currency', 'discount_cents', 'coupon', 'status', 'stripe_session', 'source', 'created_at'],
    rows.map((o) => [o.id, o.email, o.user_name, o.amount, o.currency, o.discount_amount, o.coupon_code, o.status, o.stripe_checkout_session_id, o.source, o.created_at]));
});
app.get('/api/admin/users/export', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.created_at,
       CASE WHEN e.user_id IS NULL THEN 0 ELSE 1 END AS enrolled
     FROM users u LEFT JOIN enrollments e ON e.user_id = u.id ORDER BY u.id DESC`
  ).all();
  csvDownload(res, 'users.csv',
    ['id', 'name', 'email', 'role', 'enrolled', 'created_at'],
    rows.map((u) => [u.id, u.name, u.email, u.role, u.enrolled, u.created_at]));
});
app.get('/api/admin/audit-log', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json(db.prepare(
    `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.id DESC LIMIT ?`
  ).all(limit));
});

// ---- validated CRUD ----
const CRUD_SCHEMAS = {
  modules: { table: 'modules', fields: ['title', 'description', 'sort_order', 'is_visible'] },
  lessons: { table: 'lessons', fields: ['module_id', 'title', 'video_url', 'thumbnail', 'description', 'duration', 'provider', 'sort_order', 'is_visible', 'is_free_preview'] },
  resources: { table: 'resources', fields: ['lesson_id', 'title', 'file_url', 'file_type'] },
  bonuses: { table: 'bonuses', fields: ['title', 'description', 'sort_order', 'is_visible'] },
  faqs: { table: 'faqs', fields: ['question', 'answer', 'sort_order', 'is_visible'] },
  testimonials: { table: 'testimonials', fields: ['name', 'role', 'text', 'sort_order', 'is_visible'] },
  coupons: { table: 'coupons', fields: ['code', 'percent_off', 'is_active', 'expires_at'] },
};
function validateCrud(base, body, partial = false) {
  const errors = [];
  const out = {};
  const b = body || {};
  const need = (f) => !partial || f in b;
  if (base === 'modules' || base === 'bonuses' || base === 'faqs' || base === 'testimonials') {
    const titleKey = base === 'faqs' ? 'question' : base === 'testimonials' ? 'name' : 'title';
    if (need(titleKey)) {
      const t = V.cleanText(b[titleKey], 300);
      if (!t) errors.push('title_required'); else out[titleKey] = t;
    }
    const descKey = base === 'faqs' ? 'answer' : base === 'testimonials' ? 'text' : 'description';
    if (base !== 'testimonials' && need(descKey)) out[descKey] = V.cleanText(b[descKey], base === 'faqs' ? 5000 : 2000);
    if (base === 'testimonials' && need('text')) {
      const t = V.cleanText(b.text, 2000);
      if (!t) errors.push('text_required'); else out.text = t;
    }
    if (base === 'testimonials' && need('role')) out.role = V.cleanText(b.role, 120);
    if (need('sort_order')) out.sort_order = Math.max(0, parseInt(b.sort_order, 10) || 0);
    if (need('is_visible')) out.is_visible = b.is_visible ? 1 : 0;
  }
  if (base === 'lessons') {
    if (need('title')) {
      const t = V.cleanText(b.title, 300);
      if (!t) errors.push('title_required'); else out.title = t;
    }
    if (need('module_id')) {
      if (!V.isId(b.module_id)) errors.push('invalid_module'); else out.module_id = Number(b.module_id);
    }
    if (need('provider')) {
      if (!V.isProvider(b.provider)) errors.push('invalid_provider'); else out.provider = b.provider;
    }
    const provider = out.provider || (partial ? undefined : 'youtube');
    if (need('video_url')) {
      const v = V.validateVideoUrl(provider || b.provider || 'youtube', b.video_url);
      if (!v.ok) errors.push(v.error); else out.video_url = v.url;
    }
    if (need('thumbnail')) {
      const t = String(b.thumbnail || '').trim();
      if (t && !V.isSafeUrl(t)) errors.push('unsafe_thumbnail_url'); else out.thumbnail = t.slice(0, 500);
    }
    if (need('description')) out.description = V.cleanText(b.description, 5000);
    if (need('duration')) out.duration = V.cleanText(b.duration, 20);
    if (need('sort_order')) out.sort_order = Math.max(0, parseInt(b.sort_order, 10) || 0);
    if (need('is_visible')) out.is_visible = b.is_visible ? 1 : 0;
    if (need('is_free_preview')) out.is_free_preview = b.is_free_preview ? 1 : 0;
  }
  if (base === 'resources') {
    if (need('title')) {
      const t = V.cleanText(b.title, 300);
      if (!t) errors.push('title_required'); else out.title = t;
    }
    if (need('lesson_id')) {
      if (!V.isId(b.lesson_id)) errors.push('invalid_lesson'); else out.lesson_id = Number(b.lesson_id);
    }
    if (need('file_url')) {
      const u = String(b.file_url || '').trim();
      if (!V.isSafeUrl(u, { allowRelative: false })) errors.push('unsafe_file_url'); else out.file_url = u.slice(0, 1000);
    }
    if (need('file_type')) {
      if (!V.isFileType(b.file_type)) errors.push('invalid_file_type'); else out.file_type = b.file_type;
    }
  }
  if (base === 'coupons') {
    if (need('code')) {
      const c = String(b.code || '').trim().toUpperCase().slice(0, 40);
      if (!/^[A-Z0-9_-]{2,40}$/.test(c)) errors.push('invalid_coupon_code'); else out.code = c;
    }
    if (need('percent_off')) {
      const n = parseInt(b.percent_off, 10);
      if (!V.isPercent(n) || n < 1) errors.push('invalid_percent'); else out.percent_off = n;
    }
    if (need('is_active')) out.is_active = b.is_active ? 1 : 0;
    if (need('expires_at')) {
      const e = String(b.expires_at || '').trim();
      out.expires_at = e && !Number.isNaN(Date.parse(e)) ? new Date(e).toISOString() : null;
    }
  }
  return { errors, out };
}
function registerCrud(base) {
  const { table, fields } = CRUD_SCHEMAS[base];
  const orderBy = fields.includes('sort_order') ? 'ORDER BY sort_order, id' : 'ORDER BY id DESC';
  app.get(`/api/admin/${base}`, requireAdmin, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ${orderBy}`).all()));
  app.post(`/api/admin/${base}`, requireAdmin, (req, res) => {
    const { errors, out } = validateCrud(base, req.body);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    const keys = Object.keys(out).filter((k) => fields.includes(k));
    if (!keys.length) return res.status(400).json({ error: 'nothing_to_save' });
    const r = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...keys.map((k) => out[k]));
    audit(req.user.id, `${base}_created`, base, r.lastInsertRowid, '');
    res.json({ id: r.lastInsertRowid });
  });
  app.put(`/api/admin/${base}/:id`, requireAdmin, (req, res) => {
    if (!V.isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const { errors, out } = validateCrud(base, req.body, true);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    const keys = Object.keys(out).filter((k) => fields.includes(k));
    if (!keys.length) return res.json({ ok: true });
    db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`)
      .run(...keys.map((k) => out[k]), req.params.id);
    audit(req.user.id, `${base}_updated`, base, req.params.id, keys.join(','));
    res.json({ ok: true });
  });
  app.delete(`/api/admin/${base}/:id`, requireAdmin, (req, res) => {
    if (!V.isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    audit(req.user.id, `${base}_deleted`, base, req.params.id, '');
    res.json({ ok: true });
  });
}
Object.keys(CRUD_SCHEMAS).forEach(registerCrud);

// ---- settings (whitelisted keys only) ----
const SETTING_KEYS = {
  COURSE_NAME: (v) => V.cleanText(v, 120),
  COURSE_DESCRIPTION: (v) => V.cleanText(v, 2000),
  COURSE_PRICE: (v) => { const n = parseFloat(v); return V.isPrice(n) ? String(n) : null; },
  ORIGINAL_PRICE: (v) => { const n = parseFloat(v); return V.isPrice(n) ? String(n) : null; },
  CURRENCY: (v) => V.cleanText(v, 8),
  CURRENCY_ISO: (v) => V.isCurrencyIso(v) ? String(v).toLowerCase() : null,
  PAYMENT_URL: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s, { allowRelative: false }) ? s : null; },
  LOGO_URL: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s) ? s : null; },
  VIDEO_PROVIDER: (v) => (V.isProvider(v) ? v : null),
  SEO_TITLE: (v) => V.cleanText(v, 160),
  META_DESCRIPTION: (v) => V.cleanText(v, 300),
  HERO_TITLE: (v) => V.cleanText(v, 200),
  HERO_SUBTITLE: (v) => V.cleanText(v, 500),
  CTA_TEXT: (v) => V.cleanText(v, 80),
  TRUST_LINE: (v) => V.cleanText(v, 200),
  DISCLAIMER: (v) => V.cleanText(v, 2000),
  INSTRUCTOR_NAME: (v) => V.cleanText(v, 120),
  INSTRUCTOR_BIO: (v) => V.cleanText(v, 3000),
  INSTRUCTOR_IMAGE: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s) ? s : null; },
  INSTRUCTOR_IMAGE_2: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s) ? s : null; },
  INSTRUCTOR_EXPERIENCE: (v) => V.cleanText(v, 2000),
  INSTRUCTOR_STYLE: (v) => V.cleanText(v, 2000),
  PROMO_VIDEO_URL: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s, { allowRelative: false }) ? s : null; },
  PROMO_VIDEO_PROVIDER: (v) => (V.isProvider(v) ? v : null),
  PODCAST_TITLE: (v) => V.cleanText(v, 160),
  PODCAST_DESCRIPTION: (v) => V.cleanText(v, 1000),
  PODCAST_EMBED_URL: (v) => { const s = String(v || '').trim(); return !s || V.isSafeUrl(s, { allowRelative: false }) ? s : null; },
  PODCAST_PROVIDER: (v) => (V.isProvider(v) ? v : null),
  SUPPORT_WHATSAPP: (v) => { const s = String(v || '').replace(/[()\s-]/g, ''); return !s || /^[+0-9][0-9]{5,18}$/.test(s) ? s : null; },
  SUPPORT_WHATSAPP_COUNTRY_CODE: (v) => { const s = String(v || '').replace(/\D/g, ''); return !s || /^\d{1,4}$/.test(s) ? s : null; },
  UMAMI_WEBSITE_ID: (v) => V.cleanText(v, 80),
  GUARANTEE_DAYS: (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 && n <= 60 ? String(n) : null; },
  SHOW_TESTIMONIALS: (v) => (v === '1' || v === 1 || v === true ? '1' : '0'),
  COURSE_HOURS: (v) => { const s = String(v || '').trim(); return !s || /^\d{1,4}$/.test(s) ? s : null; },
  CONTACT_EMAIL: (v) => { const s = String(v || '').trim(); return !s || V.validEmail(s) ? s : null; },
};
app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  const bad = [];
  const clean = {};
  for (const [k, v] of Object.entries(body)) {
    const validator = SETTING_KEYS[k];
    if (!validator) { bad.push(k); continue; }
    const cv = validator(v);
    if (cv === null || cv === undefined) { bad.push(k); continue; }
    clean[k] = String(cv);
  }
  if (bad.length) return res.status(400).json({ error: 'invalid_setting', keys: bad });
  const before = getSettings();
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(clean)) stmt.run(k, v);
  const changed = Object.keys(clean);
  if (changed.includes('COURSE_PRICE') && before.COURSE_PRICE !== clean.COURSE_PRICE) {
    audit(req.user.id, 'price_changed', 'settings', 'COURSE_PRICE', `${before.COURSE_PRICE} -> ${clean.COURSE_PRICE}`);
  }
  audit(req.user.id, 'settings_updated', 'settings', '', changed.join(','));
  res.json({ ok: true });
});

// ---- users ----
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.prepare(
  `SELECT u.id, u.name, u.email, u.role, u.created_at,
   CASE WHEN e.user_id IS NULL THEN 0 ELSE 1 END AS enrolled
   FROM users u LEFT JOIN enrollments e ON e.user_id = u.id ORDER BY u.id DESC`).all()));
app.post('/api/admin/users/:id/enroll', requireAdmin, (req, res) => {
  if (!V.isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  db.prepare('INSERT OR IGNORE INTO enrollments (user_id, source) VALUES (?, ?)').run(req.params.id, 'admin');
  audit(req.user.id, 'enrollment_granted', 'user', req.params.id, 'admin manual');
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/unenroll', requireAdmin, (req, res) => {
  if (!V.isId(req.params.id)) return res.status(404).json({ error: 'not_found' });
  db.prepare('DELETE FROM enrollments WHERE user_id = ?').run(req.params.id);
  audit(req.user.id, 'enrollment_revoked', 'user', req.params.id, 'admin manual');
  res.json({ ok: true });
});
app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const target = Number(req.params.id);
  const role = req.body?.role;
  if (!V.isId(target) || !V.isRole(role)) return res.status(400).json({ error: 'invalid_role' });
  if (target === req.user.id && role !== 'admin') return res.status(400).json({ error: 'cannot_demote_self' });
  const t = db.prepare('SELECT role FROM users WHERE id = ?').get(target);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (t.role === 'admin' && role !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: 'cannot_remove_last_admin' });
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target);
  audit(req.user.id, 'role_changed', 'user', target, `${t.role} -> ${role}`);
  res.json({ ok: true });
});

// ---------- global error handler (never leave a request hanging) ----------
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err && err.message);
  if (!res.headersSent) res.status(500).json({ error: 'server_error' });
});

// ---------- page routes ----------
const page = (f) => (req, res) => {
  // Inject the real SEO title server-side so crawlers and the tab never see {{SEO_TITLE}}.
  fs.readFile(path.join(__dirname, 'public', f), 'utf8', (err, html) => {
    if (err) return res.status(404).send('Not found');
    try {
      const s = getSettings();
      html = html.split('{{SEO_TITLE}}').join(String(s.SEO_TITLE || s.COURSE_NAME || 'TradePro Academy'));
    } catch {}
    res.type('html').send(html);
  });
};
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
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/refund', page('refund.html'));
app.get('/contact', page('contact.html'));
app.get('/lesson/:id', page('lesson.html'));

if (require.main === module) {
  app.listen(PORT, () => console.log(`[tradepro] http://localhost:${PORT} (DEMO_PURCHASE=${DEMO_PURCHASE}, env=${NODE_ENV})`));
}

module.exports = { app, db, getSettings, getPricing, orderedLessons, isLessonUnlocked };
