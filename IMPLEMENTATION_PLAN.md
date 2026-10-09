# IMPLEMENTATION_PLAN.md — TradePro Academy: من MVP إلى إطلاق تجاري آمن

## الوضع الحالي (من فحص الكود)
- Express + node:sqlite + sessions في الذاكرة + bcryptjs. Stripe موجود جزئياً (checkout + webhook بلا idempotency ولا تحقق من المبلغ).
- الكوبون يُحسب في المتصفح فقط. `/offer` بلا كوبون. لا SMTP. استرجاع كلمة السر يطبع التوكن في Console.
- كلمة Admin الافتراضية `admin123`. لا CSRF. لا security headers. الجلسات في الذاكرة.
- صلاحيات الدروس والتسلسل في الواجهة فقط. لا جداول orders/payments/refunds. لا اختبارات.

## خطة التنفيذ (13 مرحلة)

### المرحلة 2 — قاعدة البيانات
- نظام migrations مرقّم وidempotent في `db.js` (جدول `schema_migrations`).
- جداول جديدة: `orders`, `payments`, `refunds`, `stripe_events` (PK = event_id), `audit_log`, `sessions` (لجلسات SQLite).
- أعمدة جديدة: `coupons.expires_at`, `users.must_change_password`, `password_resets.token_hash/purpose/used_at`.
- سكربت `scripts/backup-db.js` + أمر `npm run backup`.

### المرحلة 3 — Stripe
- `lib/pricing.js`: السعر والخصم والعملة تُحسب من الخادم فقط (حد أدنى 50 سنتاً).
- `POST /api/checkout/session` يقبل `{email, coupon_code}` → ينشئ `orders` بحالة pending → ينشئ Checkout Session مع metadata (order_id).
- Webhook: تحقق التوقيع + idempotency عبر `stripe_events` + تحقق المبلغ/العملة/المنتج مقابل الـ order + معالجة 5 أحداث.
- `POST /api/checkout/claim` يحدّث order/payment ويسجّل الدخول.
- صفحة checkout-success تعرض: paid / pending / failed / cancelled.

### المرحلة 4 — الكوبونات
- `GET /api/coupon/validate?code=` يعيد التفصيل محسوباً من الخادم (قبل/خصم/بعد).
- `/offer` تحصل على نفس واجهة الكوبون مثل `/`.
- تخزين `coupon_code` + `discount_amount` في الـ order.

### المرحلة 5 — SMTP
- `lib/mailer.js` (nodemailer): رسالة ترحيب + رابط تعيين كلمة السر بعد الدفع، forgot/reset حقيقي.
- التوكن يُخزّن hashed (SHA-256)، صلاحية 1h، استعمال واحد.
- بدون SMTP: تحذير واضح عند الإقلاع، ولا رسائل وهمية.

### المرحلة 6 — الأمان
- Production guards: إيقاف الإقلاع إذا (SESSION_SECRET / admin123 / live بلا webhook secret / COOKIE_SECURE مع HTTPS).
- إجبار تغيير كلمة سر الـ Admin عند أول دخول.
- CSRF بنمط double-submit لكل POST/PUT/PATCH/DELETE (عدا webhook).
- Security headers يدوياً + CSP مدروس.
- Rate limiting محسّن لكل endpoint حساس. `TRUST_PROXY` عبر env فقط.
- `lib/validate.js` + whitelist لإعدادات الإدارة + منع `javascript:` URLs.

### المرحلة 7 — صلاحيات الدروس
- التسلسل يُفرض من الخادم: `/api/lesson/:id` و`/api/progress/complete` يرفضان الدرس المقفل (`lesson_locked`).
- الملاحظات والتقدم مرتبطة بصاحب الجلسة فقط.

### المرحلة 8 — الفيديو والموارد
- Validation حسب provider في CRUD الإدارة.
- Placeholder واضح عند غياب الفيديو (موجود).
- Signed URLs للـ MP4 الخاص: `/api/media/lesson/:id?token=` (HMAC + انتهاء) يعيد توجيهاً بعد التحقق.

### المرحلة 9 — لوحة الإدارة
- تبويب "المدفوعات": إحصائيات + جدول + بحث/تصفية + Export CSV.
- تبويب "سجل النشاط" (audit log).
- منع حذف/تنزيل آخر Admin. تأكيد قبل الحذف (موجود) + تسجيل.

### المرحلة 10 — SEO والقانون
- صفحات `/refund` و`/contact` + روابط قانونية في الفوتر.
- إصلاح JSON-LD (workload من إعداد `COURSE_HOURS` أو يُحذف).
- WhatsApp بصيغة E.164 عبر `SUPPORT_WHATSAPP` + `SUPPORT_WHATSAPP_COUNTRY_CODE`.
- GA4 + Meta Pixel من env فقط، مع بانر موافقة.

### المرحلة 11 — المحتوى
- `SHOW_TESTIMONIALS` (افتراضي 0) — الشهادات الديمو مخفية حتى تُستبدل بحقيقية.
- `GUARANTEE_DAYS` إعداد قابل للتعديل.

### المرحلة 12 — الاختبارات
- `tests/run.js` بـ node:test: 24 حالة (auth, coupons, stripe sig, idempotency, CSRF, ownership, sequential, last-admin...).
- `npm test`. Stripe mock عبر hook في وضع test فقط.

### المرحلة 13 — التوثيق
- README موسّع + `.env.example` + `SECURITY.md` + `PRODUCTION_CHECKLIST.md`.

## مبادئ
- لا كسر للـ API الحالية إلا للضرورة (مع توثيق).
- لا أسرار في الكود. رسائل عربية للمستخدم + logs تقنية.
- التصميم والـ RTL كما هما.
