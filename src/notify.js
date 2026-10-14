// ส่งแจ้งเตือนเข้ากลุ่ม LINE ของร้านเมื่อรับงานใหม่ / เปลี่ยนสถานะงาน
// ล้มเหลวได้โดยไม่กระทบการบันทึกงาน — ผลการส่งเก็บใน notification_logs
const line = require('./line');
const { openSecret } = require('./secrets');
const { DELIVERY_METHODS } = require('./constants');

const thDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '-');
const baht = (n) => `฿${Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`;

function buildMessage({ job, fromName, toName, note, userName, appUrl, isNew }) {
  const lines = [
    isNew ? '🆕 รับงานใหม่' : '🔔 อัปเดตสถานะงาน',
    `${job.job_no} ${job.title}`,
    `ลูกค้า: ${job.customer_name}${job.customer_phone ? ` (${job.customer_phone})` : ''}`,
    isNew ? `สถานะ: ${toName}` : `สถานะ: ${fromName} → ${toName}`,
  ];
  if (note) lines.push(`หมายเหตุ: ${note}`);
  if (job.sign_type) lines.push(`ประเภทงาน: ${job.sign_type}`);
  lines.push(`กำหนดส่ง: ${thDate(job.due_date)}`);
  const delivery = DELIVERY_METHODS.find((m) => m.key === job.delivery_method);
  if (delivery) lines.push(`ส่งมอบ: ${delivery.label}${job.install_address ? ` — ${job.install_address}` : ''}`);
  if (job.price) lines.push(`ราคา: ${baht(job.price)} · ค้างชำระ: ${baht(job.price - job.paid)}`);
  if (job.location_url) lines.push(`📍 ${job.location_url}`);
  lines.push(`โดย: ${userName}`);
  if (appUrl) lines.push(`🔗 ${appUrl}/#/jobs/${job.id}`);
  return lines.join('\n');
}

/**
 * แจ้งเตือนการเปลี่ยนสถานะ (หรือรับงานใหม่เมื่อ fromStatusId = null)
 * คืนค่า { status: 'sent' | 'failed' | 'skipped', error? }
 */
async function notifyStatus(db, { tenantId, job, fromStatusId, toStatusId, note, userName, appUrl }) {
  const t = await db.one('SELECT line_enabled, line_token, line_group_id FROM tenants WHERE id = ?', [tenantId]);
  if (!t?.line_enabled || !t.line_token || !t.line_group_id) return { status: 'skipped' };
  const to = await db.one('SELECT name, notify_line FROM job_statuses WHERE id = ? AND tenant_id = ?', [toStatusId, tenantId]);
  if (!to?.notify_line) return { status: 'skipped' };
  const from = fromStatusId ? await db.one('SELECT name FROM job_statuses WHERE id = ? AND tenant_id = ?', [fromStatusId, tenantId]) : null;

  const message = buildMessage({ job, fromName: from?.name, toName: to.name, note, userName, appUrl, isNew: !fromStatusId });
  let result;
  try {
    await line.push(openSecret(t.line_token), t.line_group_id, message);
    result = { status: 'sent' };
  } catch (err) {
    result = { status: 'failed', error: err.message };
  }
  await db
    .run('INSERT INTO notification_logs (tenant_id, job_id, channel, target, status, message, error) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      tenantId, job.id, 'line', t.line_group_id, result.status, message, result.error || null,
    ])
    .catch((err) => console.error('บันทึกประวัติแจ้งเตือนไม่สำเร็จ:', err.message));
  return result;
}

module.exports = { notifyStatus, buildMessage };
