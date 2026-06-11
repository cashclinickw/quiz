# دليل تشغيل كويز الوفرة المالية — كاش كلينك

نظام كامل: كويز ← نتيجة ← دفع عبر Tap ← توصيل الكتاب على الإيميل تلقائياً.

```
index.html        ← الكويز (GitHub Pages)
success.html      ← صفحة بعد الدفع
firestore.rules   ← قواعد أمان قاعدة البيانات
storage.rules     ← قواعد أمان الكتاب (خاص)
firebase.json     ← ربط الإعدادات
functions/
  index.js        ← السيرفر: إنشاء الدفعة + التحقق + إيميل الكتاب
  package.json
  .env.example    ← انسخه باسم .env وعبّيه
```

البنية الآمنة باختصار: **مفتاح Tap السري وكلمة سر الإيميل ما يطلعون أبداً للمتصفح** — كلهم بالسيرفر (Cloud Functions). السعر محسوب بالسيرفر مو من الصفحة، والكتاب خاص ويوصل عبر رابط موقّع ينتهي خلال ٧ أيام.

---

## قبل ما تبدأ تحتاج
- مشروع Firebase على خطة **Blaze** (الفنكشنز + إرسال طلبات لـ Tap تحتاج Blaze، تبقى شبه مجانية للاستخدام الخفيف).
- حساب **Tap Payments** (مفتاح سري `sk_test_...` للتجربة، `sk_live_...` للتشغيل).
- إيميل لإرسال الكتاب (Gmail أو إيميل دومينك `cashclinic.net`).
- ملف الكتاب PDF.

---

## ١) إعداد الملفات
١. حمّل المجلد كامل عندك على الكمبيوتر.
٢. في **`index.html`** و **`success.html`** بدّل قيم `CONFIG.firebase` بقيم مشروعك
   (Firebase Console ← ⚙️ Project settings ← Your apps ← Web app → config).
٣. في `functions/` انسخ `.env.example` باسم **`.env`** وعبّي القيم (السعر، الإيميل، رابط النجاح…).

---

## ٢) رفع الكتاب (خاص)
```
firebase storage:objects:upload ./dalil-alwafra.pdf gs://YOUR_BUCKET/books/dalil-alwafra.pdf
```
أو من Firebase Console ← Storage ← أنشئ مجلد `books` وارفع الملف فيه.
خله بنفس المسار اللي في `BOOK_STORAGE_PATH` داخل `.env`.

---

## ٣) المفاتيح السرية (مرة وحدة)
من التيرمنال داخل مجلد المشروع:
```
firebase functions:secrets:set TAP_SECRET_KEY     # الصق sk_test_... ثم Enter
firebase functions:secrets:set SMTP_PASS          # كلمة سر الإيميل / App Password
```
> **Gmail:** فعّل التحقق بخطوتين ثم أنشئ **App Password** واستخدمه هنا (مو كلمة سرك العادية).

---

## ٤) النشر (Deploy)
```
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules,storage
```
بعد النشر بتطلع لك روابط الفنكشنز. **انسخ رابط `tapWebhook`** — شكله:
`https://us-central1-PROJECT.cloudfunctions.net/tapWebhook`

---

## ٥) ربط Tap بالـ Webhook
في لوحة Tap → **Developers / Webhooks** → الصق رابط `tapWebhook`.
هذا اللي يخلي الكتاب يطلع تلقائياً بعد نجاح الدفع (حتى لو العميل سكّر الصفحة).
تأكد إن المفتاح السري في الخطوة ٣ من نفس بيئة Tap (test أو live).

---

## ٦) نشر الواجهة على GitHub Pages
١. ارفع **`index.html`** و **`success.html`** مع ملفات الشعار **`logo-wordmark.png`** و **`favicon.png`** في نفس المجلد (نفس طريقة مواقعك السابقة).
٢. Settings ← Pages ← فعّل النشر من `main`.
٣. خذ رابط الموقع، وتأكد إن **`SUCCESS_URL`** في `.env` يشير لـ `…/success.html`
   (لو عدّلته، أعد `firebase deploy --only functions`).

---

## ٧) جرّب
- افتح رابط الكويز، جاوب ١١ سؤال، اضغط «شوف نتيجتي».
- اضغط «احصل على دليل الوفرة المالية» ← عبّي البيانات ← ادفع ببطاقة Tap التجريبية.
- المفروض: صفحة النجاح تأكد الطلب + يوصلك الكتاب على الإيميل خلال دقائق.

**بطاقة تجربة Tap:** `5123 4500 0000 0008` — تاريخ مستقبلي — CVV `100`.

---

## التحويل للتشغيل الفعلي (Live)
١. بدّل المفتاح السري لـ `sk_live_...`:
   ```
   firebase functions:secrets:set TAP_SECRET_KEY
   firebase deploy --only functions
   ```
٢. حدّث رابط الـ webhook في لوحة Tap لو اختلف بين البيئتين.

---

## وين أشوف الأرقام؟
- **`leads`** في Firestore = كل من خلّص الكويز (مع درجاته وإجاباته) — حتى لو ما اشترى.
- **`orders`** = الطلبات والمشتريات (`status: paid` يعني دفع ووصله الكتاب).

## نقاط أمان مهمة
- السعر محسوب بالسيرفر؛ تغييره من المتصفح ما يأثر، والسيرفر يرفض أي مبلغ مختلف.
- الكتاب ما يتسلّم إلا بعد ما السيرفر يتأكد من Tap إن الحالة `CAPTURED`.
- ما يتأرسل الكتاب مرتين لنفس الطلب (`emailSent`).
- لو تبين إيصال Tap الجاهز يوصل العميل بعد، غيّري `receipt.email` لـ `true` في `functions/index.js`.

محتاجة أضبط أي شي (السعر، نص الإيميل، تصميم النتيجة) قوليلي. 🟧
