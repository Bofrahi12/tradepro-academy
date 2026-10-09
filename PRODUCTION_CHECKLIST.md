# PRODUCTION_CHECKLIST.md — TradePro Academy

Complete every item before taking real payments.

## 1. Secrets & environment
- [ ] `SESSION_SECRET` set to a long random value (guards refuse to boot without it)
- [ ] `ADMIN_PASSWORD` set (or save the generated one printed on first boot) — then change it on first login (forced)
- [ ] `.env` NOT committed to git; `tradepro.db` NOT committed
- [ ] `NODE_ENV=production`

## 2. HTTPS & cookies
- [ ] Site served over HTTPS
- [ ] `COOKIE_SECURE=true`
- [ ] `PUBLIC_URL=https://your-domain.com` (no trailing slash)
- [ ] `TRUST_PROXY=true` only if behind a trusted proxy (Render: yes)

## 3. Stripe
- [ ] `STRIPE_SECRET_KEY` set (`sk_live_...` for real charges)
- [ ] `STRIPE_WEBHOOK_SECRET` set (`whsec_...`) — required with live keys
- [ ] Webhook endpoint created in Stripe Dashboard: `https://your-domain.com/api/webhooks/stripe`
- [ ] Events subscribed: `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- [ ] Test purchase in **live** mode with a real small charge + refund it; verify: order `paid`, enrollment created, welcome email sent
- [ ] `CURRENCY_ISO` setting matches your Stripe account currency (default `usd`)
- [ ] `COURSE_PRICE` setting is the real price

## 4. Email
- [ ] SMTP variables set (`SMTP_HOST/PORT/USER/PASSWORD/FROM`)
- [ ] Test: forgot-password email arrives; welcome email after test purchase arrives
- [ ] If SMTP is skipped: confirm the startup warning is acceptable (no reset emails will be sent)

## 5. Content & legal
- [ ] Real lesson videos linked from Admin (empty video shows a clear placeholder — no fake content)
- [ ] `/terms`, `/privacy`, `/refund`, `/contact` reviewed
- [ ] `SHOW_TESTIMONIALS=1` only with real, consented testimonials; otherwise keep `0`
- [ ] `GUARANTEE_DAYS` matches the promise on the landing page
- [ ] Disclaimer visible on `/` and `/offer`

## 6. Data & ops
- [ ] `npm run backup` works; backups stored off-server (cron recommended: daily)
- [ ] `npm test` passes on the deploy artifact
- [ ] Admin users reviewed (no test accounts with admin role)

## 7. Demo flags — MUST be off
- [ ] `DEMO_PURCHASE` is NOT `true` (the server refuses fake self-enrollment otherwise — verify)

## 8. Post-launch
- [ ] Monitor `/api/admin/orders` for `failed`/`disputed` statuses
- [ ] Review `audit_log` weekly
- [ ] `npm audit` before each deploy
