// Email sending. Credentials come ONLY from env.
//   BREVO_API_KEY - Brevo (free, 300/day) API key — PRIMARY. Brevo's API is
//                   plain HTTPS, so it works on Render free tier.
//   BREVO_SENDER  - verified Brevo sender email (default: GMAIL_USER)
//   GMAIL_USER / GMAIL_APP_PASS - Gmail SMTP fallback (does NOT work on Render
//                   free: SMTP ports 25/465/587 are blocked there since Sep 2025).
// When no provider is configured, mailerEnabled() is false and every send is
// skipped with a console log — the app keeps working without email.
const nodemailer = require('nodemailer');

const BASE_URL = process.env.BASE_URL || 'https://siralink.onrender.com';

function mailerEnabled() {
  return Boolean(process.env.BREVO_API_KEY || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASS));
}

// Send one email via Brevo HTTP API (preferred) or Gmail SMTP (fallback).
// Returns true on success, false on skip/failure (never throws).
async function sendMail({ to, subject, html, text }) {
  if (process.env.BREVO_API_KEY) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: { email: process.env.BREVO_SENDER || process.env.GMAIL_USER || 'noreply@siralink.onrender.com', name: 'SiraLink' },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      if (!res.ok) {
        console.log('[mailer] Brevo send failed: HTTP %s %s', res.status, (await res.text()).slice(0, 200));
        return false;
      }
      console.log('[mailer] email sent via Brevo to %s', to);
      return true;
    } catch (e) {
      console.log('[mailer] Brevo send failed:', e.message);
      return false;
    }
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS },
      });
      await transporter.sendMail({ from: `"SiraLink" <${process.env.GMAIL_USER}>`, to, subject, html, text });
      console.log('[mailer] email sent via Gmail to %s', to);
      return true;
    } catch (e) {
      console.log('[mailer] Gmail send failed:', e.message);
      return false;
    }
  }
  console.log('[mailer] skipped: no email provider configured (to=%s)', to);
  return false;
}

async function sendVerificationEmail(to, link) {
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
  return sendMail({
    to,
    subject: 'Verify your SiraLink email',
    html,
    text: `Verify your SiraLink email by opening this link: ${link}\n\nኢሜይልዎን ለማረጋገጥ ይህን ሊንክ ይክፈቱ: ${link}`,
  });
}

async function sendPasswordResetEmail(to, link) {
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0b6b3f;padding:24px;text-align:center">
      <div style="display:inline-block;background:#ffffff;color:#0b6b3f;font-weight:900;font-size:28px;width:52px;height:52px;line-height:52px;border-radius:12px">S</div>
      <div style="color:#ffffff;font-weight:800;font-size:20px;margin-top:8px">SiraLink</div>
    </div>
    <div style="padding:28px 24px;color:#222">
      <h2 style="margin:0 0 12px">Reset your password</h2>
      <p style="margin:0 0 8px">Tap the button below to set a new password. The link expires in 1 hour.</p>
      <p style="margin:0 0 20px;color:#666">አዲስ የይለፍ ቃል ለማዘጋጀት ከታች ያለውን ቁልፍ ይጫኑ። ሊንኩ በ1 ሰዓት ውስጥ ጊዜው ያልፋል።</p>
      <div style="text-align:center;margin:8px 0 20px">
        <a href="${link}" style="display:inline-block;background:#0b6b3f;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 32px;border-radius:10px">Reset password</a>
      </div>
      <p style="color:#888;font-size:12px;margin:0">If the button does not work, open this link:<br><a href="${link}" style="color:#0b6b3f">${link}</a></p>
      <p style="color:#888;font-size:12px;margin:12px 0 0">If you did not ask for this, ignore this email.</p>
    </div>
    <div style="background:#f5f5f5;padding:14px;text-align:center;color:#999;font-size:12px">SiraLink — የኢትዮጵያ የፍሪላንስ መድረክ</div>
  </div>`;
  return sendMail({
    to,
    subject: 'Reset your SiraLink password',
    html,
    text: `Reset your SiraLink password by opening this link (expires in 1 hour): ${link}`,
  });
}

module.exports = { mailerEnabled, sendVerificationEmail, sendPasswordResetEmail, BASE_URL };
