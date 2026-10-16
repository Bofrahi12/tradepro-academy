/* TradePro Academy — hero 3D candlestick scene + card tilt.
   Pure enhancement: if WebGL or the Three.js CDN is unavailable, the page
   keeps its original 2D golden-particles hero untouched. */
(function () {
  'use strict';
  var hero = document.querySelector('.hero');
  var canvas = document.getElementById('hero-3d');
  if (!hero || !canvas) return;

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function webglOK() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  if (!webglOK()) return;

  function boot() {
    if (!window.THREE) return; // CDN failed too — leave 2D particles hero as-is
    try { start(window.THREE); } catch (e) { /* never break the page */ }
  }

  if (window.THREE) boot();
  else {
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/three@0.149.0/build/three.min.js';
    s.onload = boot;
    document.head.appendChild(s);
  }

  function start(THREE) {
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a1626, 16, 34);

    var camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 3.6, 13.5);

    scene.add(new THREE.AmbientLight(0x8899bb, 0.7));
    var key = new THREE.DirectionalLight(0xfff2cc, 1.15);
    key.position.set(5, 10, 7);
    scene.add(key);
    var rim = new THREE.PointLight(0xf5c518, 1.1, 40);
    rim.position.set(-7, 5, 4);
    scene.add(rim);

    var chart = new THREE.Group();
    scene.add(chart);

    // Floor grid — subtle trading-desk feel
    var grid = new THREE.GridHelper(46, 46, 0x2a4a73, 0x16324f);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    grid.position.y = -0.25;
    chart.add(grid);

    // Candlesticks trending upward (deterministic pseudo-random walk)
    var GOLD = 0xf5c518, RED = 0xe5484d;
    var matGold = new THREE.MeshStandardMaterial({ color: GOLD, emissive: 0x8a6d00, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.55 });
    var matRed = new THREE.MeshStandardMaterial({ color: RED, emissive: 0x5c0f12, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.4 });
    var candles = [];
    var seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    var N = 16, price = 0.6, tops = [];
    for (var i = 0; i < N; i++) {
      var up = rnd() > 0.3;
      var bodyH = 0.7 + rnd() * 1.5;
      var open = price;
      var close = up ? open + bodyH : Math.max(0.35, open - bodyH * 0.55);
      price = close + 0.16 + rnd() * 0.2; // drift upward
      var g = new THREE.Group();
      var mat = up ? matGold : matRed;
      var body = new THREE.Mesh(new THREE.BoxGeometry(0.62, bodyH, 0.62), mat);
      body.position.y = (open + close) / 2;
      var wickH = bodyH + 0.55;
      var wick = new THREE.Mesh(new THREE.BoxGeometry(0.09, wickH, 0.09), mat);
      wick.position.y = (open + close) / 2;
      g.add(wick); g.add(body);
      g.position.x = (i - (N - 1) / 2) * 1.18;
      g.userData.phase = rnd() * 6.28;
      chart.add(g);
      candles.push(g);
      tops.push(new THREE.Vector3(g.position.x, Math.max(open, close) + 0.42, 0));
    }

    // Glowing trend line through the candle tops
    var lineGeo = new THREE.BufferGeometry().setFromPoints(tops);
    var line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffd94d, transparent: true, opacity: 0.9 }));
    chart.add(line);
    var dotGeo = new THREE.SphereGeometry(0.11, 12, 12);
    var dotMat = new THREE.MeshBasicMaterial({ color: 0xffe27a });
    tops.forEach(function (p) { var d = new THREE.Mesh(dotGeo, dotMat); d.position.copy(p); chart.add(d); });

    // Floating gold dust for depth
    var pCount = 130, pPos = new Float32Array(pCount * 3);
    for (var j = 0; j < pCount; j++) {
      pPos[j * 3] = (rnd() - 0.5) * 30;
      pPos[j * 3 + 1] = rnd() * 9;
      pPos[j * 3 + 2] = (rnd() - 0.5) * 10 - 1;
    }
    var pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    var points = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xf5c518, size: 0.09, transparent: true, opacity: 0.65 }));
    scene.add(points);

    chart.position.y = 0.4;
    chart.rotation.y = -0.12;

    // Parallax target from pointer
    var tx = 0, ty = 0, px = 0, py = 0;
    if (!reduced && window.matchMedia('(pointer: fine)').matches) {
      hero.addEventListener('pointermove', function (e) {
        var r = hero.getBoundingClientRect();
        tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
        ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
      });
      hero.addEventListener('pointerleave', function () { tx = 0; ty = 0; });
    }

    function resize() {
      var w = hero.clientWidth, h = hero.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener('resize', resize);

    var visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) { visible = en[0].isIntersecting; }, { threshold: 0.02 }).observe(hero);
    }

    var swapped = false;
    var clock = new THREE.Clock();
    function frame() {
      requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      var t = clock.getElapsedTime();
      px += (tx - px) * 0.045;
      py += (ty - py) * 0.045;
      if (!reduced) {
        chart.rotation.y = -0.12 + Math.sin(t * 0.12) * 0.07 + px * 0.22;
        chart.rotation.x = py * 0.06;
        for (var k = 0; k < candles.length; k++) {
          candles[k].position.y = Math.sin(t * 0.7 + candles[k].userData.phase) * 0.07;
        }
        points.rotation.y = t * 0.012;
        camera.position.x = px * 1.1;
        camera.position.y = 3.6 - py * 0.6;
      }
      camera.lookAt(0, 2.1, 0);
      renderer.render(scene, camera);
      if (!swapped) {
        swapped = true;
        var old = document.getElementById('hero-particles');
        if (old) old.style.display = 'none'; // 3D is live — retire the 2D particles
        canvas.style.opacity = '1';
      }
    }
    frame();
  }

  /* ---- Showcase films: play only while on screen (saves data & battery) ---- */
  var vids = document.querySelectorAll('video[data-autoplay]');
  if (vids.length && 'IntersectionObserver' in window) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.intersectionRatio >= 0.3) { en.target.play().catch(function () {}); }
        else en.target.pause();
      });
    }, { threshold: [0, 0.3] });
    vids.forEach(function (v) { vio.observe(v); });
  }

  /* ---- 3D tilt for the pricing card & hero video (desktop pointers) ---- */
  if (reduced || !window.matchMedia('(pointer: fine)').matches) return;
  function addTilt(el, maxDeg) {
    if (!el) return;
    var raf = null, rx = 0, ry = 0, cx = 0, cy = 0;
    function apply() {
      cx += (rx - cx) * 0.16; cy += (ry - cy) * 0.16;
      el.style.transform = 'perspective(950px) rotateX(' + cx.toFixed(2) + 'deg) rotateY(' + cy.toFixed(2) + 'deg)';
      if (Math.abs(rx - cx) > 0.02 || Math.abs(ry - cy) > 0.02) raf = requestAnimationFrame(apply);
      else raf = null;
    }
    function kick() { if (!raf) raf = requestAnimationFrame(apply); }
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      ry = ((e.clientX - r.left) / r.width - 0.5) * 2 * maxDeg;
      rx = -((e.clientY - r.top) / r.height - 0.5) * 2 * maxDeg;
      kick();
    });
    el.addEventListener('pointerleave', function () { rx = 0; ry = 0; kick(); });
  }
  addTilt(document.querySelector('.pricing-card'), 5);
  addTilt(document.querySelector('.hero-video'), 4);
  document.querySelectorAll('.cine-frame').forEach(function (el) { addTilt(el, 6); });
})();
