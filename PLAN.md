# TradePro Academy — خطة البناء (Sitemap / Wireframe / Components / DB / Permissions)

> اسم مؤقت: **TradePro Academy** — منصة عربية (RTL) لبيع دورة تداول وتقديمها عبر فيديوهات.
> التقنية: Node.js + Express + SQLite (مدمجة node:sqlite) + صفحات HTML/CSS/JS خفيفة بدون Framework ثقيل (سرعة + تحكم كامل بالـ RTL).

---

## 1. Sitemap (خريطة الصفحات)

| المسار | الصفحة | الوصول |
|---|---|---|
| `/` | Landing Page — صفحة البيع الرئيسية | عام |
| `/course` | المنهج الكامل (الـ Modules والدروس) + CTA للشراء | عام |
| `/login` | تسجيل الدخول | عام (زائر) |
| `/register` | إنشاء حساب | عام (زائر) |
| `/forgot` | نسيت كلمة المرور | عام (زائر) |
| `/reset?token=...` | تعيين كلمة مرور جديدة | عام (بتوكن) |
| `/student` | لوحة الطالب: التقدم + المتابعة + المنهج | طالب مشتري |
| `/lesson/:id` | مشغل الفيديو + الملاحظات + الموارد | طالب مشتري (أو درس Free Preview) |
| `/admin` | لوحة الإدارة (تبويبات: المحتوى / الطلاب / الإعدادات / الموقع) | Admin فقط |
| `/api/*` | واجهة البيانات (JSON) | حسب الصلاحية |

**قواعد الحماية:**
- زائر غير مسجل → يرى صفحات البيع فقط. أي محاولة لفتح `/student` أو `/lesson/:id` → تحويل إلى `/login?next=...`.
- طالب مسجل لكن **غير مشتري** (لا يوجد enrollment) → `/student` تعرض بطاقة "أكمل الشراء" بزر PAYMENT_URL بدل المحتوى.
- طالب مشتري → وصول كامل للدروس المرئية (`is_visible=1`) بالترتيب، مع تتبع التقدم.
- Admin → كل شيء + `/admin`.

---

## 2. Wireframe منطقي (هيكل كل صفحة)

### `/` Landing Page
```
[Header sticky: LOGO | روابط (المنهج، المميزات، الأسئلة) | زر "احصل على الدورة"]
[Hero: عنوان قوي + Subtitle + CTA + عبارة ثقة + بطاقة فيديو/صورة]
[شريط ثقة: تعلم خطوة بخطوة...]
[المشاكل: 5 بطاقات (بدون خطة / قرارات عاطفية / ضعف إدارة المخاطر / كثرة المؤشرات / لا Trading Plan)]
[الحل: كيف تحل الدورة كل مشكلة]
[المنهج: Accordion من 10 Modules]
[What You'll Learn: شبكة مهارات]
[المميزات: 6 بطاقات]
[المدرب: صورة + INSTRUCTOR_NAME + INSTRUCTOR_BIO + الخبرة + أسلوب التعليم]
[Pricing Card: ORIGINAL_PRICE مشطوب + COURSE_PRICE + Coupon + Bonus + Limited Offer + زر "اشتري الدورة الآن"]
[Testimonials: placeholders فارغة — تُملأ من الإدارة فقط بشهادات حقيقية]
[FAQ: 8-10 أسئلة Accordion]
[Final CTA]
[Disclaimer: تعليمي فقط...]
[Footer]
```

### `/student` — لوحة الطالب
```
[Header: LOGO | اسم الطالب | زر خروج]
[بطاقة التقدم: نسبة % + عدد الدروس المكتملة + آخر درس + زر "متابعة التعلم"]
[الشبكة: Sidebar (Modules + الدروس بحالات: مكتمل/حالي/مقفل) | منطقة ترحيب/إحصائيات]
```

### `/lesson/:id`
```
[Sidebar: Modules والدروس] [Video Player كبير + عنوان + وصف + مدة]
[أزرار: السابق | تم إكمال الدرس | التالي]
[ملاحظات الطالب (حفظ تلقائي)] [Resources: تحميل PDF/Checklists/Excel...]
```

### `/admin` — تبويبات
```
[المحتوى: Modules (إضافة/ترتيب) | Lessons (إضافة/تعديل/إخفاء/ترتيب) | Resources لكل درس]
[الموقع: نصوص Landing (hero, CTA...) | الأسعار | INSTRUCTOR_* | FAQ | Testimonials | Bonuses | Coupons]
[الطلاب: قائمة + تفعيل اشتراك يدوي + جعل Admin]
[الإعدادات: COURSE_NAME/DESCRIPTION/LOGO_URL/PAYMENT_URL/VIDEO_PROVIDER/SEO]
```

---

## 3. Components (مكونات الواجهة)

- `SiteHeader` — هيدر ثابت + حالة الدخول
- `Hero`, `ProblemCards`, `SolutionBlock`, `CurriculumAccordion`, `LearnGrid`, `FeaturesGrid`
- `InstructorCard` (placeholders قابلة للتعديل)
- `PricingCard` (سعر قديم/جديد/كوبون/بونص/عرض محدود)
- `TestimonialCards` (تُعرض فقط إذا أُضيفت من الإدارة — لا بيانات وهمية)
- `FaqAccordion`, `FinalCta`, `Disclaimer`
- `VideoPlayer` — يدعم YouTube / Vimeo / Cloudflare Stream / MP4 مباشر حسب `provider`
- `ModuleSidebar` — حالات الدرس (مكتمل/حالي/مقفل)
- `ProgressRing/Bar`, `NotesEditor`, `ResourceList`
- `AdminTable` + `ModalForm` (نماذج الإضافة/التعديل)

---

## 4. Database Structure (SQLite)

```sql
users(id, name, email UNIQUE, password_hash, role['admin','student'], created_at)
password_resets(user_id, token UNIQUE, expires_at)
settings(key PK, value)  -- كل النصوص: COURSE_NAME, COURSE_PRICE, ORIGINAL_PRICE,
                         -- PAYMENT_URL, LOGO_URL, INSTRUCTOR_NAME, INSTRUCTOR_BIO,
                         -- INSTRUCTOR_IMAGE, VIDEO_PROVIDER, COURSE_DESCRIPTION,
                         -- SEO_TITLE, META_DESCRIPTION, HERO_TITLE, HERO_SUBTITLE,
                         -- CTA_TEXT, TRUST_LINE, DISCLAIMER, ...
modules(id, title, description, sort_order, is_visible)
lessons(id, module_id FK, title, video_url, thumbnail, description, duration,
        provider['youtube','vimeo','cloudflare','mp4'], sort_order, is_visible,
        is_free_preview)
resources(id, lesson_id FK, title, file_url, file_type['pdf','checklist','excel','other'])
bonuses(id, title, description, sort_order, is_visible)
faqs(id, question, answer, sort_order, is_visible)
testimonials(id, name, role, text, sort_order, is_visible)  -- فارغة افتراضياً
coupons(id, code UNIQUE, percent_off, is_active)
enrollments(user_id PK, enrolled_at, source)   -- الشراء = صف هنا
progress(user_id, lesson_id, completed_at)      -- PK(user_id, lesson_id)
notes(user_id, lesson_id, content, updated_at) -- PK(user_id, lesson_id)
```

---

## 5. الصلاحيات (Permissions Matrix)

| الإجراء | زائر | طالب غير مشتري | طالب مشتري | Admin |
|---|---|---|---|---|
| مشاهدة Landing | ✅ | ✅ | ✅ | ✅ |
| التسجيل/الدخول | ✅ | — | — | — |
| `/student` (المحتوى) | ❌→login | بطاقة شراء | ✅ | ✅ |
| `/lesson/:id` | ❌→login | ❌ (Free Preview فقط) | ✅ | ✅ |
| إكمال درس/ملاحظات | — | — | ✅ (خاص به) | — |
| CRUD المحتوى | — | — | — | ✅ |
| تعديل الإعدادات/الأسعار | — | — | — | ✅ |
| إدارة الطلاب + تفعيل اشتراك | — | — | — | ✅ |

---

## 6. Placeholders (كلها في جدول `settings` — تُعدل من لوحة الإدارة بدون كود)

`COURSE_NAME` · `COURSE_DESCRIPTION` · `COURSE_PRICE` · `ORIGINAL_PRICE` ·
`PAYMENT_URL` · `LOGO_URL` · `INSTRUCTOR_NAME` · `INSTRUCTOR_BIO` ·
`INSTRUCTOR_IMAGE` · `VIDEO_PROVIDER` (+ `HERO_TITLE`, `HERO_SUBTITLE`, `CTA_TEXT`, `SEO_TITLE`, `META_DESCRIPTION`)

## 7. الدفع (جاهز للربط لاحقاً)

- زر الشراء يوجه إلى `PAYMENT_URL` (يُعدل من الإدارة).
- مسار الربط: Stripe Checkout → Webhook `POST /api/webhooks/stripe` ينشئ `enrollments` تلقائياً (موثق في README).
- وضع `DEMO_PURCHASE=true` يتيح زر "تفعيل تجريبي" للمراجعة فقط.

## 8. SEO

- `SEO_TITLE` + `META_DESCRIPTION` من الإعدادات، Open Graph كامل، `og:image` من LOGO_URL.
- عناوين هرمية صحيحة (h1 واحد)، لغة `ar` واتجاه `rtl`.
- JSON-LD من نوع `Course` على `/` و `/course`.
- CSS/JS خفيف بدون Framework — سرعة تحميل عالية، Mobile-first.
