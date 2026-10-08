# TradePro Academy — منصة عربية لبيع وتقديم دورة تداول

منصة عربية RTL لبيع دورة التداول وتقديمها عبر فيديوهات وPodcast خاص بالمشتركين.

> **الحالة:** نسخة MVP قابلة للتشغيل. الدفع الحي يحتاج إعداد Stripe الآمن قبل استقبال العملاء.

## Funnel البيع

```text
Instagram / Facebook
        ↓
/offer (صفحة عرض Mobile-first)
        ↓
Stripe Checkout (Visa / Mastercard / PayPal حسب تفعيل الحساب)
        ↓
Stripe Webhook موقّع
        ↓
إنشاء/تفعيل المستخدم تلقائياً
        ↓
/checkout-success ثم /student و/podcast
```

## التشغيل

```bash
npm install
SESSION_SECRET="ضع-سراً-طويلاً" \
COOKIE_SECURE=false \
PORT=3000 \
node server.js
```

للمعاينة فقط:

```bash
DEMO_PURCHASE=true node server.js
```

## إعداد الدفع الحقيقي

لا تضع المفاتيح داخل الكود أو Git. استخدم متغيرات البيئة:

```bash
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
PUBLIC_URL="https://your-domain.com"
COOKIE_SECURE=true
```

1. فعّل Visa/Mastercard وPayPal من إعدادات Stripe إذا كان PayPal متاحاً في حسابك وبلدك.
2. استخدم صفحة `/offer` كوجهة إعلانات Instagram/Facebook.
3. أنشئ Webhook إلى:
   `https://your-domain.com/api/webhooks/stripe`
4. أرسل أحداث `checkout.session.completed` و`checkout.session.async_payment_succeeded`.
5. النظام لا يفتح المحتوى اعتماداً على صفحة النجاح وحدها؛ يتحقق من Stripe Server-side ويعتمد على توقيع Webhook.
6. بعد الدفع يذهب العميل إلى `/checkout-success?session_id=...` ثم يدخل إلى `/student` و`/podcast`.

> ملاحظة: رسالة الترحيب وتعيين كلمة مرور دائمة تحتاج ربط SMTP أو مزود بريد. حالياً ينشئ النظام الحساب تلقائياً ويبدأ Session للمشتري بعد تحقق Stripe.

## محتوى الدورة وPodcast

- إضافة فيديو: `/admin` ← المحتوى ← إضافة/تعديل درس.
- إضافة Module: `/admin` ← المحتوى ← إضافة Module.
- إضافة Podcast: من `/admin` ← الإعدادات، أضف القيم:
  - `PODCAST_TITLE`
  - `PODCAST_DESCRIPTION`
  - `PODCAST_EMBED_URL`
  - `PODCAST_PROVIDER` (`youtube`, `vimeo`, `cloudflare`, أو `mp4`)
- فيديو الإعلان في `/offer` من الإعدادات:
  - `PROMO_VIDEO_URL`
  - `PROMO_VIDEO_PROVIDER`

## مسارات أساسية

- `/` الصفحة الرئيسية.
- `/offer` صفحة مخصصة لزوار الإعلانات.
- `/checkout-success` تأكيد الدفع والتفعيل.
- `/student` منصة الطالب.
- `/lesson/:id` مشاهدة الدرس.
- `/podcast` Podcast خاص بالمشتركين.
- `/admin` لوحة الإدارة.
- `/api/health` فحص الجاهزية.

## تحذيرات قبل الإنتاج

- غيّر بيانات Admin الافتراضية فوراً.
- استخدم HTTPS و`COOKIE_SECURE=true`.
- لا تشغّل Webhook بدون `STRIPE_WEBHOOK_SECRET`.
- استخدم Store دائم للجلسات مثل Redis أو SQLite Store عند التوسع.
- أضف SMTP لإرسال رابط الترحيب واستعادة كلمة المرور.
- راجع المتطلبات القانونية والضريبية الخاصة بالدفع والتعليم المالي في بلدك.
