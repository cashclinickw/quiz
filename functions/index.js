/**
 * Cash Clinic — Abundance Quiz backend
 * createTapCharge : create a secure Tap charge (price fixed server-side)
 * tapWebhook      : Tap calls this; we re-verify with Tap, then email the book
 * getOrderStatus  : success page polls this
 *
 * Secrets:  TAP_SECRET_KEY, SMTP_PASS
 * Params :  see defineString() below (set in functions/.env)
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const nodemailer = require("nodemailer");

setGlobalOptions({ region: "us-central1", maxInstances: 10 });
initializeApp();
const db = getFirestore();

/* ---- secrets ---- */
const TAP_SECRET_KEY = defineSecret("TAP_SECRET_KEY"); // sk_test_... / sk_live_...
const SMTP_PASS      = defineSecret("SMTP_PASS");

/* ---- config (functions/.env) ---- */
const BOOK_PRICE        = defineString("BOOK_PRICE",        { default: "9" });      // KWD, server-authoritative
const BOOK_CURRENCY     = defineString("BOOK_CURRENCY",     { default: "KWD" });
const BOOK_NAME         = defineString("BOOK_NAME",         { default: "دليل الوفرة المالية" });
const BOOK_STORAGE_PATH = defineString("BOOK_STORAGE_PATH", { default: "books/dalil-alwafra.pdf" });
const SUCCESS_URL       = defineString("SUCCESS_URL");      // https://USER.github.io/REPO/success.html
const SMTP_HOST         = defineString("SMTP_HOST");        // e.g. smtp.gmail.com  /  smtp.zoho.com
const SMTP_PORT         = defineString("SMTP_PORT",         { default: "465" });
const SMTP_USER         = defineString("SMTP_USER");
const MAIL_FROM         = defineString("MAIL_FROM");        // "كاش كلينك <info@cashclinic.net>"
const WA_NUMBER         = defineString("WA_NUMBER",         { default: "96522268020" });

const TAP_BASE = "https://api.tap.company/v2";

/* ============================================================
   createTapCharge — called from the quiz
   ============================================================ */
exports.createTapCharge = onCall({ secrets: [TAP_SECRET_KEY] }, async (req) => {
  const { leadId, name, email, phone } = req.data || {};
  if (!name || name.trim().length < 2) throw new HttpsError("invalid-argument", "الاسم مطلوب");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError("invalid-argument", "إيميل غير صحيح");

  const amount   = Number(BOOK_PRICE.value());
  const currency = BOOK_CURRENCY.value();

  // create pending order (server is the source of truth for price)
  const orderRef = db.collection("orders").doc();
  await orderRef.set({
    leadId: leadId || null,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone || null,
    amount, currency,
    product: BOOK_NAME.value(),
    status: "pending",
    emailSent: false,
    createdAt: FieldValue.serverTimestamp(),
  });

  const charge = {
    amount,
    currency,
    threeDSecure: true,
    save_card: false,
    description: BOOK_NAME.value(),
    metadata: { orderId: orderRef.id, leadId: leadId || "" },
    reference: { order: orderRef.id },
    receipt: { email: false, sms: false },
    customer: {
      first_name: name.trim(),
      email: email.trim().toLowerCase(),
      ...(phone ? { phone: parsePhone(phone) } : {}),
    },
    source: { id: "src_all" },
    redirect: { url: `${SUCCESS_URL.value()}?order=${orderRef.id}` },
  };

  const resp = await fetch(`${TAP_BASE}/charges`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TAP_SECRET_KEY.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(charge),
  });
  const data = await resp.json();

  if (!data || !data.transaction || !data.transaction.url) {
    console.error("Tap charge failed:", JSON.stringify(data));
    throw new HttpsError("internal", "تعذر إنشاء الدفعة");
  }
  await orderRef.update({ tapChargeId: data.id });
  return { url: data.transaction.url, orderId: orderRef.id };
});

/* ============================================================
   tapWebhook — Tap calls this on every charge update.
   Set this function's URL in Tap dashboard > Webhooks (and/or
   it is also hit via redirect). We re-fetch the charge from Tap
   to verify authenticity, then deliver the book once.
   ============================================================ */
exports.tapWebhook = onRequest({ secrets: [TAP_SECRET_KEY, SMTP_PASS] }, async (req, res) => {
  const chargeId = (req.body && req.body.id) || req.query.id;
  if (!chargeId) { res.status(400).send("missing id"); return; }

  let charge;
  try {
    const r = await fetch(`${TAP_BASE}/charges/${chargeId}`, {
      headers: { Authorization: `Bearer ${TAP_SECRET_KEY.value()}` },
    });
    charge = await r.json();
  } catch (e) {
    console.error("verify fetch failed", e);
    res.status(500).send("verify failed"); return; // let Tap retry
  }

  const orderId = (charge.metadata && charge.metadata.orderId) || (charge.reference && charge.reference.order);
  if (!orderId) { res.status(200).send("no order ref"); return; }

  const orderRef = db.collection("orders").doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) { res.status(200).send("order not found"); return; }
  const order = snap.data();

  if (charge.status !== "CAPTURED") {
    await orderRef.update({ status: String(charge.status).toLowerCase(), tapStatus: charge.status });
    res.status(200).send("ok"); return;
  }

  // amount sanity check (defends against tampering)
  if (Number(charge.amount) !== Number(order.amount)) {
    console.error("amount mismatch", charge.amount, order.amount);
    await orderRef.update({ status: "review", tapStatus: charge.status });
    res.status(200).send("amount mismatch"); return;
  }

  if (order.emailSent) { res.status(200).send("already delivered"); return; }

  try {
    await deliverBook(order, SMTP_PASS.value());
  } catch (e) {
    console.error("email send failed", e);
    res.status(500).send("delivery failed"); // Tap will retry → email gets resent
    return;
  }

  await orderRef.update({
    status: "paid",
    emailSent: true,
    paidAt: FieldValue.serverTimestamp(),
    tapStatus: charge.status,
  });
  if (order.leadId) {
    await db.collection("leads").doc(order.leadId)
      .set({ purchased: true, purchasedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  res.status(200).send("delivered");
});

/* ============================================================
   getOrderStatus — success page polls this
   ============================================================ */
exports.getOrderStatus = onCall(async (req) => {
  const { orderId } = req.data || {};
  if (!orderId) throw new HttpsError("invalid-argument", "orderId required");
  const snap = await db.collection("orders").doc(orderId).get();
  if (!snap.exists) return { status: "unknown" };
  const d = snap.data();
  return { status: d.status, emailSent: !!d.emailSent };
});

/* ============================================================
   helpers
   ============================================================ */
async function deliverBook(order, smtpPass) {
  // private file in Storage → time-limited signed link (7 days)
  const file = getStorage().bucket().file(BOOK_STORAGE_PATH.value());
  const [exists] = await file.exists();
  if (!exists) throw new Error("book file not found at " + BOOK_STORAGE_PATH.value());
  const [link] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port: Number(SMTP_PORT.value()),
    secure: Number(SMTP_PORT.value()) === 465,
    auth: { user: SMTP_USER.value(), pass: smtpPass },
  });

  await transporter.sendMail({
    from: MAIL_FROM.value(),
    to: order.email,
    subject: `${BOOK_NAME.value()} — كاش كلينك`,
    html: emailHtml(order, link),
  });
}

function emailHtml(order, link) {
  return `
  <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f6f7f9;padding:28px">
    <div style="max-width:520px;margin:auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #eee">
      <div style="background:#1b1814;color:#fff;padding:26px;text-align:center">
        <div style="font-size:24px;font-weight:bold;letter-spacing:.5px"><span style="color:#ffffff">Cash</span><span style="color:#F3AF2F">Clinic.</span></div>
      </div>
      <div style="padding:30px 26px;color:#222633">
        <h2 style="margin:0 0 12px;font-size:20px">هلا ${escapeHtml(order.name)} 👋</h2>
        <p style="color:#555;line-height:1.9;font-size:15px;margin:0 0 22px">
          شكراً لثقتك فينا. هذي نسختك من <b>${BOOK_NAME.value()}</b> — اضغط الزر تحت وتنزّل الكتاب مباشرة.
        </p>
        <div style="text-align:center;margin:26px 0">
          <a href="${link}" style="background:#F3AF2F;color:#1b1814;text-decoration:none;font-weight:bold;
             font-size:16px;padding:14px 38px;border-radius:12px;display:inline-block">تنزيل الكتاب</a>
        </div>
        <p style="color:#999;font-size:12.5px;line-height:1.8;margin:18px 0 0">
          الرابط صالح لمدة ٧ أيام. لو واجهت أي مشكلة بالتنزيل،
          <a href="https://wa.me/${WA_NUMBER.value()}" style="color:#2578C4">راسلنا واتساب</a> ونساعدك.
        </p>
      </div>
      <div style="background:#fafafa;padding:16px;text-align:center;color:#aaa;font-size:11px">
        © كاش كلينك — cashclinic.net
      </div>
    </div>
  </div>`;
}

function parsePhone(p) {
  let s = String(p).replace(/[^0-9]/g, "");
  let cc = "965";
  if (s.startsWith("965") && s.length > 8) s = s.slice(3);
  return { country_code: cc, number: s };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
