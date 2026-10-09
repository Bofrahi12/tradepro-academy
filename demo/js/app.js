// TradePro Academy — shared UI helpers
(function () {
  'use strict';

  // Toast
  let toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  // Reveal on scroll
  function initReveal() {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  }

  // Accordion (event delegation)
  function initAccordion() {
    document.addEventListener('click', (e) => {
      const head = e.target.closest('.acc-head');
      if (!head) return;
      const item = head.closest('.acc-item');
      const body = item.querySelector('.acc-body');
      const open = item.classList.toggle('open');
      body.style.maxHeight = open ? body.scrollHeight + 'px' : '0';
    });
  }

  // Site header with auth state
  async function renderHeader(active) {
    const mount = document.getElementById('site-header');
    if (!mount) return;
    let user = null;
    try { user = await Store.me(); } catch { /* guest */ }
    const links = [
      ['/', 'الرئيسية'], ['/course', 'المنهج'],
    ];
    mount.innerHTML = `
      <div class="container">
        <a class="logo" href="index.html"><img class="logo-mark" src="images/logo.svg" alt="TradePro Academy"><span data-s="COURSE_NAME">TradePro Academy</span></a>
        <button class="menu-toggle" id="menu-toggle" aria-label="فتح القائمة" aria-expanded="false">☰</button>
        <nav class="nav-links" id="main-nav">${links.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}
          ${user && user.role === 'admin' ? '<a href="admin.html">لوحة الإدارة</a>' : ''}
          ${user && user.enrolled ? '<a href="student.html">منصتي</a>' : ''}
        </nav>
        <div class="header-actions">
          ${user
            ? `${user.role !== 'admin' && !user.enrolled ? '<a class="btn btn-primary btn-sm" href="/#pricing">أكمل الشراء</a>' : ''}
               <span style="color:var(--muted);font-size:.9rem">مرحباً، ${esc(user.name.split(' ')[0])}</span>
               <button class="btn btn-ghost btn-sm" id="logout-btn">خروج</button>`
            : `<a class="btn btn-ghost btn-sm" href="login.html">دخول</a>
               <a class="btn btn-primary btn-sm" href="register.html">ابدأ الآن</a>`}
        </div>
      </div>`;
    const menu = document.getElementById('menu-toggle');
    const nav = document.getElementById('main-nav');
    if (menu && nav) menu.onclick = () => {
      const open = nav.classList.toggle('open');
      menu.setAttribute('aria-expanded', String(open));
    };
    const lo = document.getElementById('logout-btn');
    if (lo) lo.onclick = async () => { await Store.logout(); location.href = 'index.html'; };
    // apply course name from settings
    try {
      const s = await Store.settings();
      mount.querySelectorAll('[data-s="COURSE_NAME"]').forEach((el) => (el.textContent = s.COURSE_NAME || 'TradePro Academy'));
      document.title = document.title.replace('{{SEO_TITLE}}', s.SEO_TITLE || s.COURSE_NAME || '');
    } catch { /* ignore */ }
  }

  // Apply settings placeholders: elements with [data-s="KEY"]
  async function applySettings(extra) {
    try {
      const s = await Store.settings();
      document.querySelectorAll('[data-s]').forEach((el) => {
        const k = el.getAttribute('data-s');
        if (s[k] !== undefined && s[k] !== '') {
          if (el.tagName === 'IMG') el.src = s[k]; else el.textContent = s[k];
        }
      });
      // SEO
      if (s.SEO_TITLE) document.title = s.SEO_TITLE;
      const md = document.querySelector('meta[name="description"]');
      if (md && s.META_DESCRIPTION) md.setAttribute('content', s.META_DESCRIPTION);
      if (extra) extra(s);
      return s;
    } catch (e) { if (extra) extra({}); return {}; }
  }

  // Video embed by provider
  function videoEmbed(provider, url) {
    if (!url) return `<div class="video-empty"><div><div style="font-size:2.4rem;margin-bottom:10px">🎬</div><p>سيتم إضافة فيديو هذا الدرس قريباً.</p></div></div>`;
    const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    const vm = url.match(/vimeo\.com\/(\d+)/);
    if (provider === 'youtube' || yt) {
      const id = yt ? yt[1] : url;
      return `<iframe src="https://www.youtube.com/embed/${id}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    }
    if (provider === 'vimeo' || vm) {
      const id = vm ? vm[1] : url;
      return `<iframe src="https://player.vimeo.com/video/${id}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    }
    if (provider === 'cloudflare') {
      return `<iframe src="${esc(url)}" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
    }
    return `<video controls preload="metadata" src="${esc(url)}"></video>`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtPrice(s, key) {
    const cur = s.CURRENCY || '$';
    const v = s[key] || '0';
    return `${v} ${cur}`;
  }

  // Consent-aware analytics: GA4 + Meta Pixel load only after user consent.
  function initConsentAnalytics(cfg) {
    const KEY = 'tpa_consent';
    const ga4 = cfg.ga4, pixel = cfg.metaPixel;
    if (!ga4 && !pixel) return;
    const load = () => {
      if (ga4 && !document.querySelector('script[data-ga4]')) {
        const s1 = document.createElement('script'); s1.async = true; s1.setAttribute('data-ga4', '1');
        s1.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga4);
        document.head.appendChild(s1);
        const s2 = document.createElement('script'); s2.setAttribute('data-ga4', '1');
        s2.text = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${ga4}');`;
        document.head.appendChild(s2);
      }
      if (pixel && !document.querySelector('script[data-fbp]')) {
        const s = document.createElement('script'); s.setAttribute('data-fbp', '1');
        s.text = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');`;
        document.head.appendChild(s);
      }
    };
    let choice = null;
    try { choice = localStorage.getItem(KEY); } catch {}
    if (choice === 'accepted') { load(); return; }
    if (choice === 'declined') return;
    const bar = document.createElement('div');
    bar.id = 'consent-bar';
    bar.innerHTML = `<span>نستخدم ملفات تعريف الارتباط لتحسين تجربتك وقياس أداء الموقع.</span>
      <span style="display:flex;gap:8px"><button class="btn btn-primary btn-sm" id="consent-ok">موافق</button>
      <button class="btn btn-ghost btn-sm" id="consent-no">رفض</button></span>`;
    document.body.appendChild(bar);
    bar.querySelector('#consent-ok').onclick = () => { try { localStorage.setItem(KEY, 'accepted'); } catch {} bar.remove(); load(); };
    bar.querySelector('#consent-no').onclick = () => { try { localStorage.setItem(KEY, 'declined'); } catch {} bar.remove(); };
  }

  // JSON-LD Course schema — workload comes from COURSE_HOURS setting (never lessons=hours)
  function courseSchema(s, modules) {
    const data = {
      '@context': 'https://schema.org', '@type': 'Course',
      name: s.COURSE_NAME, description: s.COURSE_DESCRIPTION || s.META_DESCRIPTION,
      provider: { '@type': 'Organization', name: s.COURSE_NAME, sameAs: location.origin },
    };
    if (modules && modules.length) {
      const hours = parseInt(s.COURSE_HOURS, 10);
      if (Number.isInteger(hours) && hours > 0) {
        data.hasCourseInstance = { '@type': 'CourseInstance', courseMode: 'online', courseWorkload: `PT${hours}H` };
      }
    }
    const el = document.createElement('script');
    el.type = 'application/ld+json';
    el.textContent = JSON.stringify(data);
    document.head.appendChild(el);
  }

  function requireLoginRedirect() {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = '/login?next=' + next;
  }

  window.App = { toast, initReveal, initAccordion, renderHeader, applySettings, videoEmbed, esc, fmtPrice, courseSchema, initConsentAnalytics, requireLoginRedirect };
  document.addEventListener('DOMContentLoaded', () => { initReveal(); initAccordion(); });
})();

// ---- demo-only: resolve absolute app paths to relative demo pages ----
App.resolve = function (p) {
  if (!p) return null;
  if (/^(https?:|#|mailto:)/.test(p)) return p;
  const m = p.match(/^\/lesson\/(\d+)/); if (m) return 'lesson.html?id=' + m[1];
  const map = { '/': 'index.html', '/course': 'course.html', '/login': 'login.html',
    '/register': 'register.html', '/forgot': 'forgot.html', '/reset': 'reset.html',
    '/student': 'student.html', '/admin': 'admin.html' };
  const base = p.split('?')[0].split('#')[0];
  if (map[base]) return map[base] + p.slice(base.length);
  return p;
};
(function () {
  const _orig = App.requireLoginRedirect;
  App.requireLoginRedirect = function () {
    const next = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    location.href = 'login.html?next=' + next;
  };
})();
