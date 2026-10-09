// SMTP email service (nodemailer). If SMTP env vars are missing, the mailer is
// disabled: the server logs a clear warning at startup and never sends fake mail.
'use strict';
const nodemailer = require('nodemailer');

function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASSWORD) return null;
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    from: SMTP_FROM || SMTP_USER,
  };
}

const mailerReady = () => !!smtpConfig();
let transporter = null;
function getTransporter() {
  const c = smtpConfig();
  if (!c) return null;
  if (!transporter) transporter = nodemailer.createTransport(c);
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) throw new Error('smtp_not_configured');
  await t.sendMail({ from: smtpConfig().from, to, subject, html });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, body) {
  return `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:0 auto;background:#0a1128;color:#f4f7fb;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#00e5a0,#3b82f6);padding:22px;text-align:center;color:#04120c;font-weight:900;font-size:20px">TradePro Academy</div>
    <div style="padding:28px"><h2 style="margin-top:0">${title}</h2>${body}
    <p style="color:#9aa7bd;font-size:12px;margin-top:28px">هذه رسالة تلقائية من منصة TradePro Academy. هذا المحتوى تعليمي فقط وليس نصيحة مالية.</p></div></div>`;
}
const btn = (url, label) =>
  `<p style="text-align:center;margin:26px 0"><a href="${esc(url)}" style="display:inline-block;background:#00e5a0;color:#04120c;font-weight:800;padding:14px 34px;border-radius:12px;text-decoration:none">${label}</a></p>`;

async function sendWelcomeEmail({ name, email, courseName, setupUrl, loginUrl }) {
  await sendMail({
    to: email,
    subject: `مرحباً بك في ${courseName} 🎉`,
    html: shell(`أهلاً ${esc(name)}!`, `
      <p>تم تفعيل اشتراكك في <b>${esc(courseName)}</b> بنجاح.</p>
      <p>الخطوة الأولى: عيّن كلمة مرور لحسابك عبر الرابط التالي (صالح لمرة واحدة):</p>
      ${btn(setupUrl, 'تعيين كلمة المرور')}
      <p>بعدها يمكنك الدخول إلى منصتك في أي وقت من: <a href="${esc(loginUrl)}" style="color:#00e5a0">${esc(loginUrl)}</a></p>`),
  });
}

async function sendPasswordResetEmail({ name, email, courseName, resetUrl }) {
  await sendMail({
    to: email,
    subject: 'رابط استعادة كلمة المرور',
    html: shell('استعادة كلمة المرور', `
      <p>مرحباً ${esc(name)}،</p>
      <p>طلبتَ رابطاً لتعيين كلمة مرور جديدة لحسابك في ${esc(courseName)}.</p>
      ${btn(resetUrl, 'تعيين كلمة مرور جديدة')}
      <p style="color:#9aa7bd;font-size:13px">الرابط صالح لمدة ساعة واحدة ولاستعمال واحد فقط. إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p>`),
  });
}

module.exports = { mailerReady, sendMail, sendWelcomeEmail, sendPasswordResetEmail };
