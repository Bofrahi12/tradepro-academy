// Security headers + configurable in-memory rate limiting (no extra deps).
'use strict';

function securityHeaders({ ga4, metaPixel } = {}) {
  const scriptSrc = ["'self'", "'unsafe-inline'", 'https://cloud.umami.is'];
  const connectSrc = ["'self'", 'https://cloud.umami.is'];
  if (ga4) { scriptSrc.push('https://www.googletagmanager.com'); connectSrc.push('https://www.google-analytics.com'); }
  if (metaPixel) { scriptSrc.push('https://connect.facebook.net'); connectSrc.push('https://www.facebook.com'); }
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'https://fonts.gstatic.com',
    "img-src 'self' data: https:",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://iframe.videodelivery.net https://*.cloudflarestream.com",
    `connect-src ${connectSrc.join(' ')}`,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Content-Security-Policy', csp);
    next();
  };
}

// Simple sliding-window limiter keyed by IP (+ optional route suffix).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  if (t.unref) t.unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let item = hits.get(key);
    if (!item || item.reset < now) item = { count: 0, reset: now + windowMs };
    item.count += 1;
    hits.set(key, item);
    if (item.count > max) return res.status(429).json({ error: 'too_many_attempts' });
    next();
  };
}

module.exports = { securityHeaders, rateLimit };
