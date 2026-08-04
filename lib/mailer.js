// Sends the "your gift code is ready" email right after an order is
// created. Best-effort only - a failed/unconfigured send never blocks order
// creation, since the invoice (shown on-screen and downloadable) is already
// the primary, guaranteed delivery path. This is purely an extra notification.
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

// Placeholder accounts (auto-created for phone-only signups or partner
// customers with no email on file) use these fake domains - never real
// inboxes, so never worth trying to email.
function isRealEmail(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  return !email.endsWith('@phone.giftmint.local') && !email.endsWith('@partner.giftmint.local');
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildOrderEmailHtml(order) {
  const rows = order.items.map(i =>
    `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #F1F2F6;">${esc(i.platformName)} Gift Card</td>
      <td style="padding:10px 8px;border-bottom:1px solid #F1F2F6;">Rs. ${i.denomination.toLocaleString('en-IN')}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #F1F2F6;font-family:'Courier New',monospace;font-weight:700;background:#EEF2FF;color:#3730A3;border-radius:4px;">${esc(i.code)}</td>
    </tr>`
  ).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0F172A;">
    <div style="background:#4F46E5;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;">
      <div style="font-size:19px;font-weight:800;">Gift<span style="color:#6EE7B7;">Mint</span></div>
      <div style="font-size:13px;color:#C7D2FE;margin-top:4px;">Your gift card${order.items.length > 1 ? 's are' : ' is'} ready - Order ${esc(order.orderId)}</div>
    </div>
    <div style="border:1px solid #E5E7EB;border-top:none;padding:20px 24px;border-radius:0 0 10px 10px;">
      <p style="font-size:14px;">Hi ${esc(order.customerName)},</p>
      <p style="font-size:14px;">Thanks for your order! Here ${order.items.length > 1 ? 'are your codes' : 'is your code'}:</p>
      <table style="width:100%;border-collapse:collapse;font-size:13.5px;margin:12px 0 18px;">
        <thead><tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #E5E7EB;font-size:11px;text-transform:uppercase;color:#64748B;">Gift Card</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #E5E7EB;font-size:11px;text-transform:uppercase;color:#64748B;">Value</th>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #E5E7EB;font-size:11px;text-transform:uppercase;color:#64748B;">Code</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:16px;font-weight:800;color:#3730A3;">Grand Total: Rs. ${order.grandTotal.toLocaleString('en-IN')}</p>
      <p style="font-size:12px;color:#9CA3AF;margin-top:20px;border-top:1px solid #E5E7EB;padding-top:14px;">Mock invoice generated for a college demo / academic project. No real transaction occurred.</p>
    </div>
  </div>`;
}

async function sendOrderEmail(order) {
  if (!transporter) return; // SMTP not configured - silently skip
  if (!isRealEmail(order.customerEmail)) return;
  await transporter.sendMail({
    from: `"GiftMint" <${SMTP_FROM}>`,
    to: order.customerEmail,
    subject: `Your GiftMint gift card${order.items.length > 1 ? 's are' : ' is'} ready - Order ${order.orderId}`,
    html: buildOrderEmailHtml(order)
  });
}

module.exports = { sendOrderEmail, isRealEmail };
