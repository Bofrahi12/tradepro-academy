// CSRF protection via the double-submit cookie pattern.
// No extra dependency: the cookie is set on GET, the browser must echo it back
// in the `x-csrf-token` header on every state-changing request.
// The Stripe webhook is exempt (it is authenticated via Stripe signature).
'use strict';
const crypto = require('crypto');

const CSRF_COOKIE = 'tpa_csrf';

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function csrfIssue(secure) {
  return (req, res, next) => {
    if (req.method === 'GET' && !parseCookies(req)[CSRF_COOKIE]) {
      const token = crypto.randomBytes(24).toString('hex');
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false, // JS must read it to echo in the header
        sameSite: 'lax',
        secure: !!secure,
        maxAge: 7 * 24 * 3600 * 1000,
        path: '/',
      });
    }
    next();
  };
}

function csrfProtect(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path === '/api/webhooks/stripe') return next(); // Stripe-signature verified
  const cookies = parseCookies(req);
  const token = cookies[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (!token || !header || token.length < 16 || token !== header) {
    return res.status(403).json({ error: 'csrf_invalid' });
  }
  next();
}

module.exports = { csrfIssue, csrfProtect, CSRF_COOKIE };
