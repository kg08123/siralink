// Email sending via Gmail SMTP. Credentials come ONLY from env:
//   GMAIL_USER      - the Gmail address sending the mail
//   GMAIL_APP_PASS  - a Google "App password" (NOT the account password)
// When either is missing, mailerEnabled() is false and every send is
// skipped with a console log — the app keeps working without email.
const nodemailer = require('nodemailer');

const BASE_URL = process.env.BASE_URL || 'https://siralink.onrender.com';

function mailerEnabled() {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASS);
}

let _transporter = null;
function transporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS },
    });
  }
  return _transporter;
}

async function sendVerificationEmail(to, link) {
  if (!mailerEnabled()) {
    console.log('[mailer] skipped: GMAIL_USER/GMAIL_APP_PASS not set (to=%s)', to);
    return false;
  }
  const from = `"SiraLink" <${process.env.GMAIL_USER}>`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0b6b3f;padding:24px;text-align:center">
      <div style="display:inline-block;background:#ffffff;color:#0b6b3f;font-weight:900;font-size:28px;width:52px;height:52px;line-height:52px;border-radius:12px">S</div>
      <div style="color:#ffffff;font-weight:800;font-size:20px;margin-top:8px">SiraLink</div>
    </div>
    <div style="padding:28px 24px;color:#222">
      <h2 style="margin:0 0 12px">Verify your email</h2>
      <p style="margin:0 0 8px">Tap the button below to verify your email address and get your verified badge on SiraLink.</p>
      <p style="margin:0 0 20px;color:#666">ኢሜይልዎን ለማረጋገጥ ከታች ያለውን ቁልፍ ይጫኑ።</p>
      <div style="text-align:center;margin:8px 0 20px">
        <a href="${link}" style="display:inline-block;background:#0b6b3f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:10px">Verify email</a>
      </div>
      <p style="color:#888;font-size:12px;margin:0">If the button does not work, open this link:<br><a href="${link}" style="color:#0b6b3f">${link}</a></p>
    </div>
    <div style="background:#f5f5f5;padding:14px;text-align:center;color:#999;font-size:12px">SiraLink — የኢትዮጵያ የፍሪላንስ መድረክ</div>
  </div>`;
  await transporter().sendMail({
    from,
    to,
    subject: 'Verify your SiraLink email',
    html,
    text: `Verify your SiraLink email by opening this link: ${link}\n\nኢሜይልዎን ለማረጋገጥ ይህን ሊንክ ይክፈቱ: ${link}`,
  });
  console.log('[mailer] verification email sent to %s', to);
  return true;
}

module.exports = { mailerEnabled, sendVerificationEmail, BASE_URL };
