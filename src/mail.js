// ส่งอีเมลผ่าน SMTP (ใช้ได้กับ Gmail, Resend, ผู้ให้บริการอื่น)
// ตั้งค่า env: SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM
// MAIL_CAPTURE=1 → ไม่ส่งจริง เก็บไว้ใน outbox (ใช้ตอนทดสอบ)
const outbox = [];
let transporter;

const configured = () => Boolean(process.env.MAIL_CAPTURE === '1' || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS));

function getTransporter() {
  if (!transporter) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || `MYD Easy <${process.env.SMTP_USER}>`;
  if (process.env.MAIL_CAPTURE === '1') {
    outbox.push({ from, to, subject, text, html });
    return;
  }
  await getTransporter().sendMail({ from, to, subject, text, html });
}

module.exports = { sendMail, configured, outbox };
