# SECURITY.md — TradePro Academy

## Threat model
A paid Arabic course platform: user accounts, Stripe payments, admin content management.
Attackers: credential stuffing, coupon/price tampering, webhook spoofing, XSS via admin content,
CSRF on state-changing endpoints, session theft.

## Controls implemented

### Authentication & sessions
- bcrypt (12 rounds) password hashing. Minimum 8 characters.
- Sessions stored in SQLite (`sessions` table), not in memory; httpOnly, SameSite=Lax, Secure when `COOKIE_SECURE=true`.
- **No default admin password**: on first seed a random password is generated and printed once; `ADMIN_PASSWORD=admin123` refuses to boot.
- Admins must change password on first login (`must_change_password` enforced in `requireAdmin`).
- Production guards refuse to boot when: `SESSION_SECRET` missing, live Stripe key without webhook secret, `COOKIE_SECURE=false` with an https `PUBLIC_URL`.

### Payments (Stripe)
- Price, discount, currency computed **server-side only** (`lib/pricing.js`). Browser values are never trusted.
- Orders created `pending` before redirect; fulfillment happens only in the signed webhook or the server-verified claim endpoint — never from the success page alone.
- Webhook: HMAC signature verification (5-min timestamp tolerance, timing-safe compare) + **idempotency** via `stripe_events(event_id PK)` — duplicate deliveries are ignored.
- Amount/currency/product (`metadata.product === 'tradepro-course'`) verified against the order before enrollment; mismatches fail the event (Stripe retries).
- Handled events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `payment_intent.payment_failed`, `charge.refunded` (revokes enrollment on full refund), `charge.dispute.created`.

### Coupons
- Validated server-side: active, not expired, 0 < percent ≤ 100. Floor price $0.50.
- `GET /api/coupon/validate` returns the breakdown; checkout re-validates and stores `coupon_code` + `discount_amount` on the order.

### Email / password reset
- SMTP via nodemailer; if not configured the server logs a warning and sends nothing (no fake mail).
- Reset tokens: 32 random bytes, **only SHA-256 stored**, 1-hour expiry, single use, purpose-tagged (`reset`/`setup`).
- Forgot endpoint always returns `{ok:true}` (no email enumeration). Tokens/links never logged.

### CSRF / headers / rate limits
- Double-submit cookie CSRF on all POST/PUT/PATCH/DELETE (Stripe webhook exempt — signature-verified).
- Headers: CSP (YouTube/Vimeo/Cloudflare frames, Google Fonts, Umami/GA4/Pixel when enabled), `frame-ancestors 'self'`, nosniff, SAMEORIGIN, strict referrer, restrictive permissions policy.
- Rate limits: login 10/15min, register 10/h, forgot 5/h, checkout 20/h, admin 120/min (in-memory; use Redis at scale).
- `trust proxy` only when `TRUST_PROXY=true` — `X-Forwarded-For` is not trusted otherwise.

### Input validation & XSS
- `lib/validate.js`: email, safe URLs (`javascript:`/`data:`/`vbscript:` blocked), per-provider video URL checks, file-type allowlist, percent/price/currency/role/id checks.
- Admin CRUD and settings are validated; settings accept a **whitelist of keys only**.
- Admin UI escapes all rendered content (`App.esc`); settings applied via `textContent`.

### Authorization
- Lesson access + sequential unlock enforced **server-side** (`/api/lesson/:id`, `/api/progress/complete`).
- Notes/progress keyed to the session user. Private MP4s optionally served via HMAC-signed expiring URLs (`PROTECT_MEDIA=true`).
- Admin cannot demote self or remove the last admin. All sensitive admin actions are audit-logged.

## Operational security
- `npm run backup` → timestamped SQLite copies (WAL checkpoint first), keeps 30.
- Never commit `.env`, `*.db`, or secrets. See `PRODUCTION_CHECKLIST.md`.
- Dependencies: express, express-session, bcryptjs, nodemailer (audited via `npm audit` before release).

## Known limitations
- Rate limiting is in-memory (per process). CSRF uses double-submit (no server token store).
- Refund/dispute handling records events; manual review in Stripe Dashboard is still recommended.
