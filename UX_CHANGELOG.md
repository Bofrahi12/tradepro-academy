# UX Changelog — TradePro Academy

**التاريخ:** 2026-10-09
**النطاق:** تحسينات UI/UX فعلية (بدون تغيير منطق الدفع/الصلاحيات/الأمان)

---

## 1. Accessibility

### Skip Link
- **المشكلة:** مستخدمو لوحة المفاتيح لا يستطيعون تخطي الـ Header
- **الحل:** رابط "تخطي إلى المحتوى الرئيسي" يظهر عند التركيز
- **الملفات:** `public/js/app.js` (initSkipLink)، `public/css/style.css`
- **التأثير:** تحسين التنقل بلوحة المفاتيح | **Backend:** لا

### Accordion Accessible
- **المشكلة:** الأكورديون بدون `aria-expanded`/`aria-controls` ولا يعمل بلوحة المفاتيح
- **الحل:** إضافة السمات + دعم Enter/Space
- **الملفات:** `public/js/app.js` (initAccordion)
- **التأثير:** قارئات الشاشة تعلن حالة الفتح/الإغلاق | **Backend:** لا

### إغلاق قائمة الهاتف
- **المشكلة:** القائمة تبقى مفتوحة عند الضغط خارجها
- **الحل:** إغلاق بالضغط خارجها + Escape + بعد اختيار رابط
- **الملفات:** `public/js/app.js` (renderHeader)
- **التأثير:** تجربة هاتف أنظف | **Backend:** لا

### Toast Accessible
- **المشكلة:** رسائل Toast لا تُعلن لقارئات الشاشة
- **الحل:** `role="status"` للرسائل العادية، `role="alert"` للأخطاء
- **الملفات:** `public/js/app.js` (toast)
- **التأثير:** إعلانات صوتية للمكفوفين | **Backend:** لا

### Modal Focus Trap
- **المشكلة:** الـ Modal بدون حصر تركيز ولا إغلاق بـ Escape
- **الحل:** focus trap + Escape + إرجاع التركيز للزر السابق + `role="dialog"`
- **الملفات:** `public/admin.html` (openModal/closeModal)
- **التأثير:** تنقل آمن بلوحة المفاتيح | **Backend:** لا

### Focus Visible
- **المشكلة:** لا توجد حالة تركيز واضحة
- **الحل:** `:focus-visible` بإطار أخضر
- **الملفات:** `public/css/style.css`
- **التأثير:** وضوح التنقل | **Backend:** لا

---

## 2. صفحات الدخول والتسجيل

### زر إظهار كلمة المرور
- **المشكلة:** لا يمكن التحقق من كلمة المرور أثناء الكتابة
- **الحل:** زر 👁️/🙈 مع `aria-label`
- **الملفات:** `public/login.html`، `public/register.html`، `public/js/app.js`، `public/css/style.css`
- **التأثير:** تقليل أخطاء الإدخال | **Backend:** لا

### منع الإرسال المزدوج
- **المشكلة:** إمكانية الضغط مرتين وإرسال طلبين
- **الحل:** `App.btnLoading()` — تعطيل الزر + spinner
- **الملفات:** `public/login.html`، `public/register.html`، `public/js/app.js`
- **التأثير:** منع طلبات مكررة | **Backend:** لا

### مؤشر قوة كلمة المرور
- **المشكلة:** المستخدم لا يعرف قوة كلمته
- **الحل:** شريط ملون (5 مستويات)
- **الملفات:** `public/register.html`، `public/css/style.css`
- **التأثير:** تشجيع كلمات أقوى | **Backend:** لا

### Labels مرتبطة + dir=ltr
- **المشكلة:** labels بدون `for`، حقل كلمة المرور بدون اتجاه
- **الحل:** `for` لكل label + `dir="ltr"` لكلمات المرور
- **الملفات:** `public/login.html`، `public/register.html`
- **التأثير:** accessibility أفضل | **Backend:** لا

---

## 3. صفحة الدرس

### Breadcrumb
- **المشكلة:** لا يوجد مسار تنقل (منصتي › Module › الدرس)
- **الحل:** breadcrumb مع `aria-label` و`aria-current`
- **الملفات:** `public/lesson.html`، `public/css/style.css`
- **التأثير:** تنقل أوضح | **Backend:** لا

---

## 4. منصة الطالب

### رسائل التقدم
- **المشكلة:** لا توجد رسالة تحفيزية للبداية أو الإكمال
- **الحل:** "ابدأ من الدرس الأول" + "مبروك! أكملت الدورة"
- **الملفات:** `public/student.html`
- **التأثير:** تجربة تعلم أفضل | **Backend:** لا

---

## ملخص الملفات المتغيرة

| الملف | التغييرات |
|-------|-----------|
| `public/js/app.js` | toast roles، skip link، accordion aria، menu close، password toggle، btnLoading |
| `public/css/style.css` | skip link، focus-visible، pass-wrap، spinner، strength bar، breadcrumb |
| `public/login.html` | password toggle، loading، labels، dir=ltr |
| `public/register.html` | password toggle، strength، loading، labels، dir=ltr |
| `public/lesson.html` | breadcrumb |
| `public/student.html` | رسائل البداية/الإكمال |
| `public/admin.html` | modal focus trap + Escape |
| `UX_AUDIT.md` | جديد — تقرير الفحص |
| `UX_CHANGELOG.md` | جديد — هذا الملف |

## نتائج الاختبارات

- `node --check`: سليم لجميع الملفات ✓
- `npm test`: 22/22 ناجحة ✓
- **تغييرات Backend:** صفر — كلها Frontend فقط
