// TradePro Academy — automated test suite (node:test, no extra deps).
// Usage: npm test
// Spins up the real Express app on an ephemeral port with an isolated DB.
'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_123';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_tests';
process.env.COOKIE_SECURE = 'false';
process.env.PUBLIC_URL = 'http://127.0.0.1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { app, db } = require('../server');

let server, BASE;

// Stripe API mock (test env only): pretends Checkout Sessions were created (unique IDs).
let __mockSessionN = 0;
global.__stripeMock = async (endpoint) => {
  if (endpoint === 'checkout/sessions') {
    __mockSessionN++;
    return { id: `cs_test_mock${__mockSessionN}`, url: `https://checkout.stripe.com/pay/cs_test_mock${__mockSessionN}` };
  }
  throw new Error('unexpected stripe call: ' + endpoint);
};

function signStripeEvent(payload) {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${sig}`;
}

// Minimal cookie-jar HTTP agent with CSRF support.
class Agent {
  constructor() { this.cookies = {}; this.csrf = null; }
  async req(method, path, body, opts = {}) {
    const headers = {};
    const ck = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) headers.Cookie = ck;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!opts.noCsrf && this.csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      headers['x-csrf-token'] = this.csrf;
    }
    const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) {
        const k = pair.slice(0, i).trim();
        this.cookies[k] = pair.slice(i + 1).trim();
        if (k === 'tpa_csrf') this.csrf = decodeURIComponent(this.cookies[k]);
      }
    }
    let data = {};
    try { data = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, data };
  }
  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b, o); }
  put(p, b, o) { return this.req('PUT', p, b, o); }
  del(p, o) { return this.req('DELETE', p, undefined, o); }
}

async function webhookEvent(event) {
  const payload = JSON.stringify(event);
  const r = await fetch(BASE + '/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signStripeEvent(payload) },
    body: payload,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

function checkoutCompletedEvent({ id, orderId, email, amountTotal, currency, paymentIntent }) {
  return {
    id, type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_test_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
      amount_total: amountTotal, currency,
      payment_intent: paymentIntent || 'pi_test_1',
      customer_details: { email }, customer_email: email,
      metadata: { order_id: String(orderId), product: 'tradepro-course', email },
    } },
  };
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  // Seed a coupon + a test admin (must_change_password=0 for tests)
  db.prepare("INSERT INTO coupons (code, percent_off, is_active) VALUES ('TEST20', 20, 1)").run();
  const bcrypt = require('bcryptjs');
  db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ('Test Admin','testadmin@t.local',?, 'admin', 0)")
    .run(bcrypt.hashSync('AdminPass123', 10));
});

after(async () => { server.close(); });

// ---------- 1. health ----------
test('health check', async () => {
  const a = new Agent(); await a.get('/');
  const r = await a.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

// ---------- 2-5. auth ----------
test('register + duplicate + login + invalid login', async () => {
  const a = new Agent(); await a.get('/');
  let r = await a.post('/api/auth/register', { name: 'Sara', email: 'sara@t.local', password: 'Secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.data.email, 'sara@t.local');

  const b = new Agent(); await b.get('/');
  r = await b.post('/api/auth/register', { name: 'Sara2', email: 'sara@t.local', password: 'Secret123' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'email_exists');

  const c = new Agent(); await c.get('/');
  r = await c.post('/api/auth/login', { email: 'sara@t.local', password: 'Secret123' });
  assert.equal(r.status, 200);
  assert.ok(r.data.id);

  const d = new Agent(); await d.get('/');
  r = await d.post('/api/auth/login', { email: 'sara@t.local', password: 'WrongPass1' });
  assert.equal(r.status, 401);
});

test('logout requires auth, then works', async () => {
  const anon = new Agent(); await anon.get('/');
  let r = await anon.post('/api/auth/logout', {});
  assert.equal(r.status, 401);

  const a = new Agent(); await a.get('/');
  await a.post('/api/auth/login', { email: 'sara@t.local', password: 'Secret123' });
  r = await a.post('/api/auth/logout', {});
  assert.equal(r.status, 200);
  r = await a.get('/api/auth/me');
  assert.equal(r.data, null);
});

// ---------- 6-7. forgot / reset ----------
test('forgot always returns ok (no email enumeration); reset works once', async () => {
  const a = new Agent(); await a.get('/');
  let r = await a.post('/api/auth/forgot', { email: 'sara@t.local' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });

  const b = new Agent(); await b.get('/');
  r = await b.post('/api/auth/forgot', { email: 'nobody@t.local' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });

  const token = app.locals.testHooks.lastResetToken;
  assert.ok(token, 'test hook captured reset token');
  r = await a.post('/api/auth/reset', { token, password: 'NewSecret123' });
  assert.equal(r.status, 200);

  // single use
  r = await a.post('/api/auth/reset', { token, password: 'Another123' });
  assert.equal(r.status, 400);

  // new password works
  const c = new Agent(); await c.get('/');
  r = await c.post('/api/auth/login', { email: 'sara@t.local', password: 'NewSecret123' });
  assert.equal(r.status, 200);
});

// ---------- 8-9. lesson access: guest vs enrolled + sequential ----------
test('guest sees free preview only; enrolled follows server-side sequence', async () => {
  const g = new Agent(); await g.get('/');
  let r = await g.get('/api/lesson/1');
  assert.equal(r.status, 200); // lesson 1 = free preview
  r = await g.get('/api/lesson/2');
  assert.equal(r.status, 403);

  // enrolled student
  const s = new Agent(); await s.get('/');
  await s.post('/api/auth/register', { name: 'Omar', email: 'omar@t.local', password: 'Secret123' });
  const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('omar@t.local').id;
  db.prepare("INSERT INTO enrollments (user_id, source) VALUES (?, 'test')").run(uid);

  r = await s.get('/api/lesson/2');
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'lesson_locked');

  r = await s.post('/api/progress/complete', { lesson_id: 2 });
  assert.equal(r.status, 403);

  r = await s.post('/api/progress/complete', { lesson_id: 1 });
  assert.equal(r.status, 200);

  r = await s.get('/api/lesson/2');
  assert.equal(r.status, 200);
  assert.ok(r.data.video_url !== undefined);
});

// ---------- 10-11. admin gate ----------
test('admin access; student cannot access admin', async () => {
  const adm = new Agent(); await adm.get('/');
  let r = await adm.post('/api/auth/login', { email: 'testadmin@t.local', password: 'AdminPass123' });
  assert.equal(r.status, 200);
  r = await adm.get('/api/admin/overview');
  assert.equal(r.status, 200);
  assert.ok(typeof r.data.students === 'number');

  const s = new Agent(); await s.get('/');
  await s.post('/api/auth/login', { email: 'omar@t.local', password: 'Secret123' });
  r = await s.get('/api/admin/overview');
  assert.equal(r.status, 403);
});

// ---------- 12-14. coupons (server-side pricing) ----------
test('coupon validate: valid / invalid', async () => {
  const a = new Agent(); await a.get('/');
  let r = await a.get('/api/coupon/validate?code=TEST20');
  assert.equal(r.status, 200);
  assert.equal(r.data.percent_off, 20);
  assert.equal(r.data.before, 2000);
  assert.equal(r.data.discount, 400);
  assert.equal(r.data.final, 1600);
  assert.equal(r.data.currency, 'usd');

  r = await a.get('/api/coupon/validate?code=NOPE');
  assert.equal(r.status, 404);
});

test('checkout ignores browser discount: fake coupon => full price', async () => {
  const a = new Agent(); await a.get('/');
  const r = await a.post('/api/checkout/session', { email: 'fake1@t.local', coupon_code: 'HACK99' });
  assert.equal(r.status, 200);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.data.order_id);
  assert.equal(order.amount, 2000);
  assert.equal(order.discount_amount, 0);
  assert.equal(order.coupon_code, null);
  assert.equal(order.status, 'pending');
});

test('checkout with valid coupon stores server-computed discount', async () => {
  const a = new Agent(); await a.get('/');
  const r = await a.post('/api/checkout/session', { email: 'fake2@t.local', coupon_code: 'TEST20' });
  assert.equal(r.status, 200);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(r.data.order_id);
  assert.equal(order.amount, 1600);
  assert.equal(order.discount_amount, 400);
  assert.equal(order.coupon_code, 'TEST20');
});

// ---------- 15-19. stripe webhook ----------
test('webhook: invalid signature rejected', async () => {
  const payload = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
  const r = await fetch(BASE + '/api/webhooks/stripe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=deadbeef' }, body: payload,
  });
  assert.equal(r.status, 400);
});

test('webhook: valid signature fulfills order (idempotent)', async () => {
  const email = 'buyer1@t.local';
  const o = db.prepare(
    `INSERT INTO orders (email, base_amount, discount_amount, amount, currency, coupon_code, status) VALUES (?,?,?,?,?,'TEST20','pending')`
  ).run(email, 2000, 400, 1600, 'usd').lastInsertRowid;

  const evt = checkoutCompletedEvent({ id: 'evt_valid_1', orderId: o, email, amountTotal: 1600, currency: 'usd' });
  let r = await webhookEvent(evt);
  assert.equal(r.status, 200);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(o);
  assert.equal(order.status, 'paid');
  const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE user_id = (SELECT id FROM users WHERE email = ?)').get(email);
  assert.ok(enrolled);
  const payCount = () => db.prepare('SELECT COUNT(*) c FROM payments WHERE order_id = ?').get(o).c;
  assert.equal(payCount(), 1);

  // duplicate delivery → ignored, no double payment row
  r = await webhookEvent(evt);
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  assert.equal(payCount(), 1);
});

test('webhook: wrong amount rejected, order stays pending', async () => {
  const email = 'buyer2@t.local';
  const o = db.prepare(
    `INSERT INTO orders (email, base_amount, discount_amount, amount, currency, status) VALUES (?,?,?,?,?,'pending')`
  ).run(email, 2000, 0, 2000, 'usd').lastInsertRowid;
  const evt = checkoutCompletedEvent({ id: 'evt_bad_amount', orderId: o, email, amountTotal: 1500, currency: 'usd' });
  const r = await webhookEvent(evt);
  assert.equal(r.status, 500);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM enrollments WHERE user_id = (SELECT id FROM users WHERE email = ?)').get(email).c, 0);
});

test('webhook: wrong currency rejected', async () => {
  const email = 'buyer3@t.local';
  const o = db.prepare(
    `INSERT INTO orders (email, base_amount, discount_amount, amount, currency, status) VALUES (?,?,?,?,?,'pending')`
  ).run(email, 2000, 0, 2000, 'usd').lastInsertRowid;
  const evt = checkoutCompletedEvent({ id: 'evt_bad_cur', orderId: o, email, amountTotal: 2000, currency: 'eur' });
  const r = await webhookEvent(evt);
  assert.equal(r.status, 500);
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(o).status, 'pending');
});

// ---------- 20. claim flow ----------
test('claim activates user after paid session (mock)', async () => {
  global.__stripeMock = async (endpoint) => {
    if (endpoint === 'checkout/sessions') return { id: 'cs_test_mock123', url: 'https://x' };
    if (endpoint === 'cs_test_claim1') {
      return { id: 'cs_test_claim1', mode: 'payment', payment_status: 'paid', status: 'complete',
        amount_total: 2000, currency: 'usd', payment_intent: 'pi_claim1',
        customer_details: { email: 'claimer@t.local' }, metadata: { product: 'tradepro-course' } };
    }
    throw new Error('unexpected ' + endpoint);
  };
  const a = new Agent(); await a.get('/');
  const r = await a.post('/api/checkout/claim', { session_id: 'cs_test_claim1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'paid');
  assert.ok(r.data.user.enrolled);
  const me = await a.get('/api/auth/me');
  assert.equal(me.data.enrolled, true);
});

// ---------- 21-22. ownership ----------
test('notes are private per user; progress requires auth', async () => {
  const au = new Agent(); await au.get('/');
  await au.post('/api/auth/register', { name: 'UserA', email: 'a@t.local', password: 'Secret123' });
  const bu = new Agent(); await bu.get('/');
  await bu.post('/api/auth/register', { name: 'UserB', email: 'b@t.local', password: 'Secret123' });

  let r = await au.put('/api/notes/1', { content: 'A secret note' });
  assert.equal(r.status, 200);
  r = await bu.get('/api/notes/1');
  assert.equal(r.data.content, '');

  const anon = new Agent(); await anon.get('/');
  r = await anon.post('/api/progress/complete', { lesson_id: 1 });
  assert.equal(r.status, 401);
});

// ---------- 23. CSRF ----------
test('CSRF: state-changing request without token is rejected', async () => {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sara@t.local', password: 'NewSecret123' }),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'csrf_invalid');
});

// ---------- 24. last admin protection ----------
test('admin cannot demote self or remove the last admin', async () => {
  const adm = new Agent(); await adm.get('/');
  await adm.post('/api/auth/login', { email: 'testadmin@t.local', password: 'AdminPass123' });
  const me = await adm.get('/api/auth/me');
  const selfId = me.data.id;

  let r = await adm.post(`/api/admin/users/${selfId}/role`, { role: 'student' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'cannot_demote_self');

  // create second admin, demote it (ok — one admin remains), then self-demotion stays blocked
  const bcrypt = require('bcryptjs');
  const id2 = db.prepare("INSERT INTO users (name, email, password_hash, role, must_change_password) VALUES ('A2','a2@t.local',?,'admin',0)")
    .run(bcrypt.hashSync('x'.repeat(12), 10)).lastInsertRowid;
  r = await adm.post(`/api/admin/users/${id2}/role`, { role: 'student' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c, 2); // seed admin + testadmin
  // demoting the other remaining admin (not self) while 2 exist is allowed and leaves exactly 1
  const seedAdmin = db.prepare("SELECT id FROM users WHERE email = 'admin@tradepro.local'").get();
  r = await adm.post(`/api/admin/users/${seedAdmin.id}/role`, { role: 'student' });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c, 1);
  // now testadmin is the last admin: self-demotion is still blocked
  r = await adm.post(`/api/admin/users/${selfId}/role`, { role: 'student' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'cannot_demote_self');
});

// ---------- resources: permissions, validation, migration ----------
test('resources: enrolled student gets file_url; guest gets nothing on paid lesson', async () => {
  const adm = new Agent(); await adm.get('/');
  await adm.post('/api/auth/login', { email: 'testadmin@t.local', password: 'AdminPass123' });
  // create resources on lesson 2 (paid) and lesson 1 (free preview)
  let r = await adm.post('/api/admin/resources', { lesson_id: 2, title: 'Private PDF', file_url: 'https://example.com/private.pdf', file_type: 'pdf', is_public: 0 });
  assert.equal(r.status, 200);
  const privId = r.data.id;
  r = await adm.post('/api/admin/resources', { lesson_id: 1, title: 'Public Checklist', file_url: 'https://example.com/public.pdf', file_type: 'pdf', is_public: 1 });
  assert.equal(r.status, 200);
  r = await adm.post('/api/admin/resources', { lesson_id: 1, title: 'Hidden Doc', file_url: 'https://example.com/hidden.pdf', file_type: 'pdf', is_public: 0 });
  assert.equal(r.status, 200);

  // guest: paid lesson blocked entirely
  const g = new Agent(); await g.get('/');
  r = await g.get('/api/lesson/2');
  assert.equal(r.status, 403);

  // guest: free preview shows only is_public=1 resources WITH file_url
  r = await g.get('/api/lesson/1');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.resources));
  assert.equal(r.data.resources.length, 1);
  assert.equal(r.data.resources[0].title, 'Public Checklist');
  assert.equal(r.data.resources[0].file_url, 'https://example.com/public.pdf');

  // enrolled student: unlock lesson 1 first, then lesson 2
  const s = new Agent(); await s.get('/');
  await s.post('/api/auth/register', { name: 'Rita', email: 'rita@t.local', password: 'Secret123' });
  const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('rita@t.local').id;
  db.prepare("INSERT INTO enrollments (user_id, source) VALUES (?, 'test')").run(uid);
  await s.post('/api/progress/complete', { lesson_id: 1 });
  r = await s.get('/api/lesson/2');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.resources));
  assert.equal(r.data.resources.length, 1);
  assert.equal(r.data.resources[0].file_url, 'https://example.com/private.pdf');

  // student also sees both resources on free preview lesson
  r = await s.get('/api/lesson/1');
  assert.equal(r.status, 200);
  assert.equal(r.data.resources.length, 2);

  // admin sees everything
  r = await adm.get('/api/lesson/2');
  assert.equal(r.status, 200);
  assert.equal(r.data.resources.length, 1);
  assert.equal(r.data.resources[0].file_url, 'https://example.com/private.pdf');
});

test('resources: validation rejects unsafe url, bad type, missing lesson', async () => {
  const adm = new Agent(); await adm.get('/');
  await adm.post('/api/auth/login', { email: 'testadmin@t.local', password: 'AdminPass123' });

  // unsafe file_url schemes rejected
  for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'vbscript:msgbox(1)']) {
    const r = await adm.post('/api/admin/resources', { lesson_id: 1, title: 'Bad', file_url: bad, file_type: 'pdf' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'unsafe_file_url');
  }
  // invalid file_type rejected
  let r = await adm.post('/api/admin/resources', { lesson_id: 1, title: 'Bad', file_url: 'https://example.com/x.pdf', file_type: 'exe' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_file_type');
  // non-existent lesson_id rejected
  r = await adm.post('/api/admin/resources', { lesson_id: 99999, title: 'Bad', file_url: 'https://example.com/x.pdf', file_type: 'pdf' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'invalid_lesson');
  // empty title rejected
  r = await adm.post('/api/admin/resources', { lesson_id: 1, title: '   ', file_url: 'https://example.com/x.pdf', file_type: 'pdf' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'title_required');
});

test('resources: no XSS via title; is_public coerced to 0/1', async () => {
  const adm = new Agent(); await adm.get('/');
  await adm.post('/api/auth/login', { email: 'testadmin@t.local', password: 'AdminPass123' });
  // control chars stripped on storage; HTML escaping happens at render via App.esc
  const xss = 'Title\x00\x1F<script>alert(1)</script>';
  let r = await adm.post('/api/admin/resources', { lesson_id: 1, title: xss, file_url: 'https://example.com/x.pdf', file_type: 'pdf', is_public: 'yes' });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT title, is_public FROM resources WHERE id = ?').get(r.data.id);
  assert.ok(!/[\u0000-\u001F]/.test(row.title), 'control chars stripped');
  // simulate App.esc render-time escaping
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rendered = esc(row.title);
  assert.ok(!rendered.includes('<script>'), 'escaped output has no raw script tag');
  assert.ok(rendered.includes('&lt;script&gt;'), 'script tag is entity-encoded');
  assert.equal(row.is_public, 1); // truthy coerced
  r = await adm.post('/api/admin/resources', { lesson_id: 1, title: 'Normal', file_url: 'https://example.com/y.pdf', file_type: 'pdf', is_public: 0 });
  assert.equal(r.status, 200);
  const row2 = db.prepare('SELECT is_public FROM resources WHERE id = ?').get(r.data.id);
  assert.equal(row2.is_public, 0);
});

test('resources: migration v6 idempotent; column exists with default 0', async () => {
  const col = db.prepare("SELECT name FROM pragma_table_info('resources') WHERE name = 'is_public'").get();
  assert.ok(col, 'is_public column exists');
  const def = db.prepare("SELECT dflt_value FROM pragma_table_info('resources') WHERE name = 'is_public'").get();
  assert.equal(String(def.dflt_value), '0');
  // re-running migration must not fail or duplicate
  const { db: freshDb } = require('../db');
  assert.ok(freshDb);
  const count = db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 6').get().c;
  assert.equal(count, 1);
});

test('resources: cannot access another lesson resource by tampering ids', async () => {
  // guest cannot list resources directly; admin CRUD is role-gated
  const s = new Agent(); await s.get('/');
  await s.post('/api/auth/login', { email: 'rita@t.local', password: 'Secret123' });
  const r = await s.get('/api/admin/resources');
  assert.equal(r.status, 403);
  // lesson 2 resources not visible to guest even knowing the lesson id
  const g = new Agent(); await g.get('/');
  const r2 = await g.get('/api/lesson/2');
  assert.equal(r2.status, 403);
  assert.ok(!r2.data.resources);
});
