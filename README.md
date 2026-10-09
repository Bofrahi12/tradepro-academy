# TradePro Academy — منصة عربية لبيع وتقديم دورة تداول

منصة عربية RTL لبيع دورة التداول وتقديمها: Landing + صفحة عرض `/offer` + Stripe Checkout + منصة طالب + لوحة إدارة.

> **الحالة:** نسخة مُصلَّبة للإطلاق التجاري — مدفوعات Stripe من جهة الخادم، CSRF، تحقق من Webhook، SMTP، اختبارات آلية (`npm test` → 17/17).

## Funnel البيع

```text
/ (أو /offer للإعلانات)
        ↓  POST /api/checkout/session (السعر والكوبون يُحسبان في الخادم)
Stripe Checkout
        ↓  Webhook موقّع + idempotency → order=paid → enrollment تلقائي → بريد ترحيب
/checkout-success?session_id=... (تحقق server-side) → /student
```

## 1. التثبيت

```bash
npm install
cp .env.example .env   # ثم املأ القيم (لا ترسل .env إلى git أبداً)
```

## 2. التشغيل المحلي

```bash
# تطوير
node server.js
# أو
npm run dev
```

للمراجعة فقط (تفعيل اشتراك وهمي بدون دفع):

```bash
DEMO_PURCHASE=true node server.js
```

> ⚠️ **لا تستعمل `DEMO_PURCHASE=true` في الإنتاج أبداً** — يتيح تفعيل اشتراك بدون دفع.

## 3. متغيرات البيئة

راجع `.env.example` للقائمة الكاملة. الأساسية:

| المتغير | الوصف |
|---|---|
| `SESSION_SECRET` | **مطلوب** في الإنتاج — سر الجلسات |
| `PUBLIC_URL` | رابط الموقع بدون `/` في النهاية (لروابط Stripe والبريد) |
| `COOKIE_SECURE` | `true` مع HTTPS |
| `TRUST_PROXY` | `true` فقط خلف proxy موثوق |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | حساب الإدارة الأول (كلمة عشوائية تُطبع مرة واحدة إذا لم تحددها) |
| `STRIPE_SECRET_KEY` | `sk_test_...` / `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (**مطلوب** مع المفتاح الحي) |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM` | البريد (الترحيب + استعادة كلمة المرور) |
| `PROTECT_MEDIA` | `true` لحماية روابط MP4 الخاصة بتوقيع مؤقت |
| `GA4_MEASUREMENT_ID` / `META_PIXEL_ID` | تحليلات اختيارية (تُفعَّل بعد موافقة الزائر) |
| `DB_PATH` | مسار ملف SQLite (افتراضي `./tradepro.db`) |

## 4. اختبار Stripe (وضع Test)

1. من [Stripe Dashboard](https://dashboard.stripe.com/test/apikeys) انسخ `sk_test_...` إلى `STRIPE_SECRET_KEY`.
2. أنشئ Webhook على `https://your-domain.com/api/webhooks/stripe` من [صفحة Webhooks](https://dashboard.stripe.com/test/webhooks).
3. اشترك في: `checkout.session.completed` و`checkout.session.async_payment_succeeded`.
4. انسخ `whsec_...` إلى `STRIPE_WEBHOOK_SECRET`.
5. للتطوير المحلي استعمل [Stripe CLI](https://stripe.com/docs/stripe-cli): `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
6. ادفع ببطاقة الاختبار `4242 4242 4242 4242` — تحقق من: الطلب `paid` في لوحة الإدارة ← الطلبات، إنشاء الاشتراك، وصول بريد الترحيب.

## 5. إعداد Webhook (إنتاج)

- الرابط: `https://your-domain.com/api/webhooks/stripe`
- الأحداث: `checkout.session.completed`، `checkout.session.async_payment_succeeded` (يُنصح أيضاً بـ `payment_intent.payment_failed` و`charge.refunded` و`charge.dispute.created` — كلها مدعومة).
- الخادم يتحقق من التوقيع، يتجاهل الأحداث المكررة (`stripe_events`)، ويطابق المبلغ والعملة والمنتج مع الطلب قبل التفعيل.

## 6. إعداد SMTP

املأ `SMTP_HOST` و`SMTP_PORT` (غالباً 587) و`SMTP_USER` و`SMTP_PASSWORD` و`SMTP_FROM`.
بدونها يطبع الخادم تحذيراً واضحاً عند الإقلاع **ولا** يرسل رسائل وهمية — استعادة كلمة المرور لن تعمل حتى تُهيأ.

## 7. تغيير بيانات Admin

1. سجّل الدخول بأول حساب — سيُطلب منك تغيير كلمة المرور فوراً (إجباري).
2. للإدارة من لوحة التحكم: الطلاب ← زر الدور.
3. لا يمكنك تنزيل نفسك، ولا إزالة آخر Admin — النظام يمنع ذلك.

## 8. النسخ الاحتياطي والاستعادة

```bash
npm run backup                 # نسخة مؤرخة في ./backups (يحتفظ بآخر 30)
node scripts/backup-db.js --dir /path/to/backups
```

**الاستعادة:** أوقف الخادم، انسخ ملف النسخة مكان `tradepro.db` (احذف `tradepro.db-wal` و`tradepro.db-shm` إن وُجدا)، أعد التشغيل.

**Migrations:** تعمل تلقائياً عند إقلاع الخادم، أو يدوياً: `npm run migrate`.

## 9. إضافة فيديو وملف (Resource)

- `/admin` ← المحتوى ← اختر الـ Module ← `+ درس جديد` (أو ✏️ تعديل).
- الحقول: العنوان، رابط الفيديو، المزود (YouTube/Vimeo/Cloudflare/MP4)، المدة، معاينة مجانية، الظهور.
- الروابط تُتحقق حسب المزود؛ روابط `javascript:` مرفوضة.
- درس بلا فيديو يعرض Placeholder واضحاً: «سيتم إضافة فيديو هذا الدرس قريباً».
- الموارد: من زر 📎 بجانب الدرس — النوع من قائمة (`pdf/checklist/excel/csv/other`) والرابط يجب أن يكون `https://`.
- ملفات MP4 الخاصة: فعّل `PROTECT_MEDIA=true` لتُقدَّم عبر روابط موقعة مؤقتة بدل الرابط المباشر.

## 10. النشر (إنتاج)

راجع `PRODUCTION_CHECKLIST.md` بنداً بنداً قبل قبول مدفوعات حقيقية. الخلاصة:

```bash
NODE_ENV=production SESSION_SECRET="..." COOKIE_SECURE=true \
PUBLIC_URL="https://your-domain.com" TRUST_PROXY=true \
STRIPE_SECRET_KEY="sk_live_..." STRIPE_WEBHOOK_SECRET="whsec_..." \
node server.js
```

## 11. الاختبارات

```bash
npm test   # 17 اختباراً (تغطي 24 حالة مطلوبة) — node:test بدون مكتبات خارجية
```

## 12. بنية المشروع

```text
server.js            # Express: auth, checkout, webhook, admin API, pages
db.js                # SQLite + migrations + seed
lib/                 # validate, pricing, mailer, session-store, csrf, security, audit, whatsapp
public/              # الواجهة (RTL)
scripts/backup-db.js # نسخ احتياطي
scripts/migrate.js   # ترحيلات يدوية
tests/run.js         # الاختبارات الآلية
```

## ملاحظات أمنية

- الجلسات في SQLite (ليست في الذاكرة). CSRF مفعّل. Headers أمنية + CSP.
- Rate limiting للمسارات الحساسة. Audit log لكل إجراء إداري حساس.
- التفاصيل في `SECURITY.md`.
