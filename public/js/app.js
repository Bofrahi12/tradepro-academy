// TradePro Academy — shared UI helpers
(function () {
  'use strict';

  // Toast (accessible: role="status" for polite announcements)
  let toastEl;
  function toast(msg, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.setAttribute('role', isError ? 'alert' : 'status');
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  // Skip link (injected once for keyboard users)
  function initSkipLink() {
    if (document.getElementById('skip-link')) return;
    // ensure main content landmark exists
    let main = document.getElementById('main-content');
    if (!main) {
      main = document.querySelector('main') || document.querySelector('.container');
      if (main && !main.id) main.id = 'main-content';
    }
    const a = document.createElement('a');
    a.id = 'skip-link';
    a.href = '#main-content';
    a.textContent = 'تخطي إلى المحتوى الرئيسي';
    document.body.prepend(a);
  }

  // Reveal on scroll
  function initReveal() {
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  }

  // Accordion (event delegation, accessible: aria-expanded + keyboard)
  let accordionBound = false;
  function initAccordion() {
    if (accordionBound) return;
    accordionBound = true;
    // initialize aria attributes on existing accordions
    document.querySelectorAll('.acc-item').forEach((item, i) => {
      const head = item.querySelector('.acc-head');
      const body = item.querySelector('.acc-body');
      if (head && body) {
        const bodyId = body.id || `acc-body-${i}`;
        body.id = bodyId;
        head.setAttribute('aria-expanded', item.classList.contains('open') ? 'true' : 'false');
        head.setAttribute('aria-controls', bodyId);
      }
    });
    const toggle = (head) => {
      const item = head.closest('.acc-item');
      if (!item) return;
      const body = item.querySelector('.acc-body');
      const open = item.classList.toggle('open');
      head.setAttribute('aria-expanded', String(open));
      if (body) body.style.maxHeight = open ? body.scrollHeight + 'px' : '0';
    };
    document.addEventListener('click', (e) => {
      const head = e.target.closest('.acc-head');
      if (head) toggle(head);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('acc-head')) {
        e.preventDefault();
        toggle(e.target);
      }
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
        <a class="logo" href="/"><img class="logo-mark" src="/images/logo.svg" alt="TradePro Academy"><span data-s="COURSE_NAME">TradePro Academy</span></a>
        <button class="menu-toggle" id="menu-toggle" aria-label="فتح القائمة" aria-expanded="false">☰</button>
        <nav class="nav-links" id="main-nav">${links.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}
          ${user && user.role === 'admin' ? '<a href="/admin">لوحة الإدارة</a>' : ''}
          ${user && user.enrolled ? '<a href="/student">منصتي</a>' : ''}
        </nav>
        <div class="header-actions">
          ${user
            ? `${user.role !== 'admin' && !user.enrolled ? '<a class="btn btn-primary btn-sm" href="/#pricing">أكمل الشراء</a>' : ''}
               <span style="color:var(--muted);font-size:.9rem">مرحباً، ${esc(user.name.split(' ')[0])}</span>
               <button class="btn btn-ghost btn-sm" id="logout-btn">خروج</button>`
            : `<a class="btn btn-ghost btn-sm" href="/login">دخول</a>
               <a class="btn btn-primary btn-sm" href="/register">ابدأ الآن</a>`}
        </div>
      </div>`;
    const menu = document.getElementById('menu-toggle');
    const nav = document.getElementById('main-nav');
    if (menu && nav) {
      const setMenu = (open) => {
        nav.classList.toggle('open', open);
        menu.setAttribute('aria-expanded', String(open));
        menu.setAttribute('aria-label', open ? 'إغلاق القائمة' : 'فتح القائمة');
      };
      menu.onclick = (e) => {
        e.stopPropagation();
        setMenu(!nav.classList.contains('open'));
      };
      // close on link click (mobile)
      nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)));
      // close on outside click
      document.addEventListener('click', (e) => {
        if (nav.classList.contains('open') && !nav.contains(e.target) && e.target !== menu && !menu.contains(e.target)) {
          setMenu(false);
        }
      });
      // close on Escape
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && nav.classList.contains('open')) setMenu(false);
      });
    }
    const lo = document.getElementById('logout-btn');
    if (lo) lo.onclick = async () => { await Store.logout(); location.href = '/'; };
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
  // Click-to-play placeholder for external videos: shows local poster first,
  // loads the external iframe only after the user clicks play.
  function videoPlaceholder(embedSrc, allow, poster) {
    return `<div class="video-placeholder" data-embed-src="${esc(embedSrc)}" data-embed-allow="${esc(allow)}">` +
      `<img src="${esc(poster)}" alt="معاينة فيديو الدرس" width="1280" height="720" loading="eager" ` +
      `onerror="this.closest('.video-placeholder').classList.add('poster-failed')">` +
      `<button type="button" class="video-play-button" data-play aria-label="تشغيل الفيديو">▶ تشغيل الفيديو</button>` +
      `<p class="poster-fallback-msg">تعذر تحميل صورة المعاينة، لكن يمكنك تشغيل الفيديو مباشرة.</p></div>`;
  }

  function videoEmbed(provider, url, poster) {
    if (!url) return `<div class="video-empty"><div><div style="font-size:2.4rem;margin-bottom:10px">🎬</div><p>سيتم إضافة فيديو هذا الدرس قريباً.</p></div></div>`;
    const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
    const vm = url.match(/vimeo\.com\/(\d+)/);
    let embedSrc = null, allow = '';
    if (provider === 'youtube' || yt) {
      const id = yt ? yt[1] : url;
      embedSrc = `https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&autoplay=1`;
      allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    } else if (provider === 'vimeo' || vm) {
      const id = vm ? vm[1] : url;
      embedSrc = `https://player.vimeo.com/video/${id}?autoplay=1`;
      allow = 'autoplay; fullscreen; picture-in-picture';
    } else if (provider === 'cloudflare') {
      const sep = url.includes('?') ? '&' : '?';
      embedSrc = `${url}${sep}autoplay=true`;
      allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture';
    }
    if (embedSrc) {
      if (poster) return videoPlaceholder(embedSrc, allow, poster);
      const lazySrc = embedSrc.replace('&autoplay=1', '').replace('?autoplay=1', '').replace('?autoplay=true', '').replace('&autoplay=true', '');
      return `<iframe src="${esc(lazySrc)}" allow="${esc(allow)}" allowfullscreen loading="lazy" title="فيديو الدرس"></iframe>`;
    }
    return `<video controls preload="metadata"${poster ? ` poster="${esc(poster)}"` : ''} src="${esc(url)}" playsinline style="width:100%">` +
      `متصفحك لا يدعم تشغيل الفيديو.</video>`;
  }

  // Delegated click-to-play: swap placeholder for the external iframe (user gesture allows autoplay).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (!btn) return;
    const ph = btn.closest('.video-placeholder');
    if (!ph || ph.dataset.playing) return;
    const src = ph.getAttribute('data-embed-src');
    if (!src || !src.startsWith('https://')) return;
    ph.dataset.playing = '1';
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.setAttribute('allow', ph.getAttribute('data-embed-allow') || 'autoplay; encrypted-media; picture-in-picture');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('title', 'فيديو الدرس');
    ph.innerHTML = '';
    ph.appendChild(iframe);
  });

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

  // Password visibility toggle (call with input id)
  function initPasswordToggle(inputId, btnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!input || !btn) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁️';
      btn.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    });
  }

  // Button loading state (prevents double-submit)
  function btnLoading(btn, loading, text) {
    if (!btn) return;
    if (loading) {
      if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> ' + esc(text || 'جارٍ التحميل...');
    } else {
      btn.disabled = false;
      if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    }
  }

  window.App = { toast, initReveal, initAccordion, initSkipLink, initPasswordToggle, btnLoading, renderHeader, applySettings, videoEmbed, esc, fmtPrice, courseSchema, initConsentAnalytics, requireLoginRedirect };
  document.addEventListener('DOMContentLoaded', () => { initSkipLink(); initReveal(); initAccordion(); });
})();
