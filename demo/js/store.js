// TradePro Academy — unified data layer.
// API mode (real backend) when window.APP_CONFIG.demo === false,
// otherwise a full localStorage demo (for the static preview).
(function () {
  'use strict';
  const CFG = window.APP_CONFIG || { api: '/api', demo: true };
  const DEMO_KEY = 'tpa_demo_v1';

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)tpa_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function apiFetch(path, opts) {
    const r = await fetch(CFG.api + path, {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      ...(opts || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'request_failed'), { code: data.error, status: r.status });
    return data;
  }

  /* ---------------- DEMO STORE (localStorage) ---------------- */
  function demoLoad() {
    try { return JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { return null; }
  }
  function demoSave(s) { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); }
  async function demoSeed() {
    let s = demoLoad();
    if (s && s.v === 7) return s;
    const seed = await (await fetch('seed.json')).json();
    s = { v: 7, session: null, users: [], enrollments: [], progress: [], notes: [],
          settings: { ...seed.settings }, modules: [], lessons: [], faqs: [], bonuses: [],
          testimonials: [], coupons: seed.coupons.map(c => ({ id: c.code, ...c, is_active: 1 })) };
    let mid = 1, lid = 1;
    seed.modules.forEach((m, i) => {
      s.modules.push({ id: mid, title: m.title, description: m.description, sort_order: i, is_visible: 1 });
      m.lessons.forEach((t, j) => s.lessons.push({
        id: lid++, module_id: mid, title: t, video_url: '', thumbnail: '', description: '',
        duration: '', provider: 'youtube', sort_order: j, is_visible: 1, is_free_preview: j === 0 && i === 0 ? 1 : 0,
      }));
      mid++;
    });
    s.faqs = seed.faqs.map((f, i) => ({ id: i + 1, question: f.q, answer: f.a, sort_order: i, is_visible: 1 }));
    s.testimonials = (seed.testimonials || []).map((t, i) => ({ id: i + 1, ...t, sort_order: i, is_visible: 1 }));
    s.bonuses = seed.bonuses.map((b, i) => ({ id: i + 1, ...b, sort_order: i, is_visible: 1 }));
    s.resources = [];
    // demo admin (NOT secure — demo only)
    s.users.push({ id: 1, name: 'Admin', email: 'admin@tradepro.local', pw: 'demo:' + btoa('admin123'), role: 'admin', created_at: new Date().toISOString() });
    demoSave(s);
    return s;
  }
  const demoHash = (p) => 'demo:' + btoa(unescape(encodeURIComponent(p)));
  function demoMe(s) {
    const u = s.users.find(x => x.id === s.session);
    if (!u) return null;
    const { pw, ...rest } = u;
    rest.enrolled = s.enrollments.some(e => e.user_id === u.id);
    return rest;
  }

  const Demo = {
    async settings() { return (await demoSeed()).settings; },
    async curriculum() {
      const s = await demoSeed(); const u = demoMe(s);
      const priv = u && (u.role === 'admin' || u.enrolled);
      return s.modules.filter(m => m.is_visible).sort((a, b) => a.sort_order - b.sort_order).map(m => ({
        ...m,
        lessons: s.lessons.filter(l => l.module_id === m.id && l.is_visible)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(l => ({ id: l.id, title: l.title, thumbnail: l.thumbnail, duration: l.duration,
                       provider: l.provider, is_free_preview: !!l.is_free_preview,
                       has_video: (priv || l.is_free_preview) && !!l.video_url })),
      }));
    },
    async lesson(id) {
      const s = await demoSeed(); const u = demoMe(s);
      const l = s.lessons.find(x => x.id === +id && x.is_visible);
      if (!l) throw Object.assign(new Error('not_found'), { status: 404 });
      const priv = u && (u.role === 'admin' || u.enrolled);
      if (!priv && !l.is_free_preview) throw Object.assign(new Error('enrollment_required'), { status: 403 });
      return { ...l, module: s.modules.find(m => m.id === l.module_id), resources: (s.resources || []).filter(r => r.lesson_id === l.id) };
    },
    async me() { return demoMe(await demoSeed()); },
    async register(name, email, pw) {
      const s = await demoSeed();
      email = email.toLowerCase();
      if (s.users.some(u => u.email === email)) throw Object.assign(new Error('email_exists'), { status: 409 });
      const u = { id: Date.now(), name, email, pw: demoHash(pw), role: 'student', created_at: new Date().toISOString() };
      s.users.push(u); s.session = u.id; demoSave(s);
      return demoMe(s);
    },
    async login(email, pw) {
      const s = await demoSeed();
      const u = s.users.find(x => x.email === email.toLowerCase() && x.pw === demoHash(pw));
      if (!u) throw Object.assign(new Error('invalid_credentials'), { status: 401 });
      s.session = u.id; demoSave(s);
      return demoMe(s);
    },
    async logout() { const s = await demoSeed(); s.session = null; demoSave(s); },
    async forgot() { return { ok: true }; }, // demo: no email
    async reset() { return { ok: true }; },
    async enrollSelf() {
      const s = await demoSeed(); const u = demoMe(s);
      if (!u) throw Object.assign(new Error('login_required'), { status: 401 });
      if (!s.enrollments.some(e => e.user_id === u.id)) s.enrollments.push({ user_id: u.id, enrolled_at: new Date().toISOString(), source: 'demo' });
      demoSave(s); return { ok: true, user: demoMe(s) };
    },
    async coupon(code) {
      const s = await demoSeed();
      const c = s.coupons.find(x => x.code.toLowerCase() === code.toLowerCase() && x.is_active);
      if (!c) throw Object.assign(new Error('invalid_coupon'), { status: 404 });
      return { code: c.code, percent_off: c.percent_off };
    },
    async progress() {
      const s = await demoSeed(); const u = demoMe(s);
      if (!u) throw Object.assign(new Error('login_required'), { status: 401 });
      const rows = s.progress.filter(p => p.user_id === u.id);
      return { completed: rows.map(r => r.lesson_id), last: rows[rows.length - 1] || null };
    },
    async completeLesson(id) {
      const s = await demoSeed(); const u = demoMe(s);
      if (!u || (!u.enrolled && u.role !== 'admin')) throw Object.assign(new Error('enrollment_required'), { status: 403 });
      if (!s.progress.some(p => p.user_id === u.id && p.lesson_id === +id))
        s.progress.push({ user_id: u.id, lesson_id: +id, completed_at: new Date().toISOString() });
      demoSave(s); return { ok: true };
    },
    async getNote(id) {
      const s = await demoSeed(); const u = demoMe(s);
      const n = s.notes.find(x => x.user_id === (u && u.id) && x.lesson_id === +id);
      return n || { content: '' };
    },
    async setNote(id, content) {
      const s = await demoSeed(); const u = demoMe(s);
      let n = s.notes.find(x => x.user_id === u.id && x.lesson_id === +id);
      if (n) n.content = content; else s.notes.push({ user_id: u.id, lesson_id: +id, content });
      demoSave(s); return { ok: true };
    },
    // ---- admin ----
    _admin(s) { const u = demoMe(s); if (!u || u.role !== 'admin') throw Object.assign(new Error('admin_only'), { status: 403 }); },
    async adminOverview() {
      const s = await demoSeed(); Demo._admin(s);
      return { students: s.users.filter(u => u.role === 'student').length, enrolled: s.enrollments.length,
               modules: s.modules.length, lessons: s.lessons.length,
               recent: s.users.filter(u => u.role === 'student').slice(-8).reverse() };
    },
    async adminList(table) { const s = await demoSeed(); Demo._admin(s); return (s[table] || []).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); },
    async adminCreate(table, obj) {
      const s = await demoSeed(); Demo._admin(s);
      const arr = s[table] = s[table] || [];
      const id = arr.length ? Math.max(...arr.map(x => x.id)) + 1 : 1;
      arr.push({ id, ...obj }); demoSave(s); return { id };
    },
    async adminUpdate(table, id, obj) {
      const s = await demoSeed(); Demo._admin(s);
      Object.assign(s[table].find(x => x.id === +id), obj); demoSave(s); return { ok: true };
    },
    async adminDelete(table, id) {
      const s = await demoSeed(); Demo._admin(s);
      s[table] = s[table].filter(x => x.id !== +id); demoSave(s); return { ok: true };
    },
    async adminSaveSettings(obj) { const s = await demoSeed(); Demo._admin(s); Object.assign(s.settings, obj); demoSave(s); return { ok: true }; },
    async publicContent() {
      const s = await demoSeed();
      return {
        faqs: s.faqs.filter(f => f.is_visible).sort((a, b) => a.sort_order - b.sort_order),
        bonuses: s.bonuses.filter(b => b.is_visible).sort((a, b) => a.sort_order - b.sort_order),
        testimonials: s.testimonials.filter(t => t.is_visible).sort((a, b) => a.sort_order - b.sort_order),
      };
    },
    async adminUsers() {
      const s = await demoSeed(); Demo._admin(s);
      return s.users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
        enrolled: s.enrollments.some(e => e.user_id === u.id) ? 1 : 0 }));
    },
    async adminEnroll(id, on) {
      const s = await demoSeed(); Demo._admin(s);
      if (on && !s.enrollments.some(e => e.user_id === +id)) s.enrollments.push({ user_id: +id, enrolled_at: new Date().toISOString(), source: 'admin' });
      if (!on) s.enrollments = s.enrollments.filter(e => e.user_id !== +id);
      demoSave(s); return { ok: true };
    },
    async adminRole(id, role) { const s = await demoSeed(); Demo._admin(s); s.users.find(u => u.id === +id).role = role; demoSave(s); return { ok: true }; },
  };

  /* ---------------- public Store ---------------- */
  const Store = {
    demo: !!CFG.demo,
    settings: () => CFG.demo ? Demo.settings() : apiFetch('/settings'),
    curriculum: () => CFG.demo ? Demo.curriculum() : apiFetch('/curriculum'),
    lesson: (id) => CFG.demo ? Demo.lesson(id) : apiFetch('/lesson/' + id),
    me: () => CFG.demo ? Demo.me() : apiFetch('/auth/me'),
    register: (n, e, p) => CFG.demo ? Demo.register(n, e, p) : apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ name: n, email: e, password: p }) }),
    login: (e, p) => CFG.demo ? Demo.login(e, p) : apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email: e, password: p }) }),
    logout: () => CFG.demo ? Demo.logout() : apiFetch('/auth/logout', { method: 'POST' }),
    forgot: (e) => CFG.demo ? Demo.forgot(e) : apiFetch('/auth/forgot', { method: 'POST', body: JSON.stringify({ email: e }) }),
    reset: (t, p) => CFG.demo ? Demo.reset(t, p) : apiFetch('/auth/reset', { method: 'POST', body: JSON.stringify({ token: t, password: p }) }),
    enrollSelf: () => CFG.demo ? Demo.enrollSelf() : apiFetch('/enroll/self', { method: 'POST' }),
    coupon: (c) => CFG.demo ? Demo.coupon(c) : apiFetch('/coupon/validate?code=' + encodeURIComponent(c)),
    checkoutSession: (email, couponCode) => CFG.demo ? Promise.reject(Object.assign(new Error('demo'), { code: 'demo' })) : apiFetch('/checkout/session', { method: 'POST', body: JSON.stringify({ email, coupon_code: couponCode || '' }) }),
    claimCheckout: (sessionId) => CFG.demo ? Promise.reject(Object.assign(new Error('demo'), { code: 'demo' })) : apiFetch('/checkout/claim', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }),
    changePassword: (cur, next) => CFG.demo ? Promise.resolve({ ok: true }) : apiFetch('/auth/change-password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: next }) }),
    publicContent: () => CFG.demo ? Demo.publicContent() : apiFetch('/public-content'),
    progress: () => CFG.demo ? Demo.progress() : apiFetch('/progress'),
    completeLesson: (id) => CFG.demo ? Demo.completeLesson(id) : apiFetch('/progress/complete', { method: 'POST', body: JSON.stringify({ lesson_id: id }) }),
    getNote: (id) => CFG.demo ? Demo.getNote(id) : apiFetch('/notes/' + id),
    setNote: (id, c) => CFG.demo ? Demo.setNote(id, c) : apiFetch('/notes/' + id, { method: 'PUT', body: JSON.stringify({ content: c }) }),
    adminOverview: () => CFG.demo ? Demo.adminOverview() : apiFetch('/admin/overview'),
    adminList: (t) => CFG.demo ? Demo.adminList(t) : apiFetch('/admin/' + t),
    adminCreate: (t, o) => CFG.demo ? Demo.adminCreate(t, o) : apiFetch('/admin/' + t, { method: 'POST', body: JSON.stringify(o) }),
    adminUpdate: (t, id, o) => CFG.demo ? Demo.adminUpdate(t, id, o) : apiFetch(`/admin/${t}/${id}`, { method: 'PUT', body: JSON.stringify(o) }),
    adminDelete: (t, id) => CFG.demo ? Demo.adminDelete(t, id) : apiFetch(`/admin/${t}/${id}`, { method: 'DELETE' }),
    adminSaveSettings: (o) => CFG.demo ? Demo.adminSaveSettings(o) : apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(o) }),
    adminUsers: () => CFG.demo ? Demo.adminUsers() : apiFetch('/admin/users'),
    adminEnroll: (id, on) => CFG.demo ? Demo.adminEnroll(id, on) : apiFetch(`/admin/users/${id}/${on ? 'enroll' : 'unenroll'}`, { method: 'POST' }),
    adminRole: (id, r) => CFG.demo ? Demo.adminRole(id, r) : apiFetch(`/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role: r }) }),
    adminOrders: (params) => CFG.demo ? Promise.resolve([]) : apiFetch('/admin/orders?' + new URLSearchParams(params || {}).toString()),
    adminOrderStats: () => CFG.demo ? Demo.adminOverview() : apiFetch('/admin/overview'),
    adminAuditLog: (limit) => CFG.demo ? Promise.resolve([]) : apiFetch('/admin/audit-log?limit=' + (limit || 100)),
    exportOrdersCsv: () => '/api/admin/orders/export',
    exportUsersCsv: () => '/api/admin/users/export',
  };

  window.Store = Store;
})();
