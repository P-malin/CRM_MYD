const express = require('express');
const { HttpError, date, today } = require('../util');
const { JOB_STATUSES, OPEN_STATUSES } = require('../constants');

const OPEN_IN = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ช่วงวันที่ของรายงาน: ค่าเริ่มต้น = ต้นเดือนนี้ ถึง วันนี้
function range(query) {
  const t = today();
  const from = date(query.from, 'วันที่เริ่ม') || `${t.slice(0, 8)}01`;
  const to = date(query.to, 'วันที่สิ้นสุด') || t;
  if (from > to) throw new HttpError(400, 'ช่วงวันที่ไม่ถูกต้อง');
  // created_at เก็บเป็น UTC; แปลงเป็นเวลาไทยก่อนเทียบวันที่
  return { from, to };
}
const LOCAL_DATE = (col) => `date(${col}, '+7 hours')`;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function reportRoutes(db) {
  const r = express.Router();

  // ภาพรวมสำหรับหน้าแดชบอร์ด
  r.get('/reports/dashboard', (req, res) => {
    const t = req.user.tenant_id;
    const d = today();
    const monthStart = `${d.slice(0, 8)}01`;
    const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, 0]));
    for (const row of db.prepare('SELECT status, COUNT(*) n FROM jobs WHERE tenant_id = ? GROUP BY status').all(t)) counts[row.status] = row.n;

    const one = (sql, ...p) => db.prepare(sql).get(t, ...p);
    res.json({
      status_counts: counts,
      open_jobs: one(`SELECT COUNT(*) n FROM jobs WHERE tenant_id = ? AND status IN (${OPEN_IN})`).n,
      overdue: one(`SELECT COUNT(*) n FROM jobs WHERE tenant_id = ? AND status IN (${OPEN_IN}) AND due_date < ?`, d).n,
      due_7_days: one(`SELECT COUNT(*) n FROM jobs WHERE tenant_id = ? AND status IN (${OPEN_IN}) AND due_date BETWEEN ? AND ?`, d, addDays(d, 7)).n,
      month_sales: one(
        `SELECT COALESCE(SUM(price), 0) v FROM jobs WHERE tenant_id = ? AND status != 'cancelled' AND ${LOCAL_DATE('created_at')} >= ?`,
        monthStart,
      ).v,
      month_collected: one('SELECT COALESCE(SUM(amount), 0) v FROM payments WHERE tenant_id = ? AND paid_at >= ?', monthStart).v,
      outstanding: one(
        `SELECT COALESCE(SUM(j.price - (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id)), 0) v
         FROM jobs j WHERE j.tenant_id = ? AND j.status != 'cancelled'`,
      ).v,
      customers: one('SELECT COUNT(*) n FROM customers WHERE tenant_id = ?').n,
      upcoming: db
        .prepare(
          `SELECT j.id, j.job_no, j.title, j.status, j.due_date, j.priority, c.name AS customer_name
           FROM jobs j JOIN customers c ON c.id = j.customer_id
           WHERE j.tenant_id = ? AND j.status IN (${OPEN_IN}) AND j.due_date IS NOT NULL
           ORDER BY j.due_date LIMIT 10`,
        )
        .all(t),
    });
  });

  // รายงานสรุปตามช่วงวันที่
  r.get('/reports/summary', (req, res) => {
    const t = req.user.tenant_id;
    const { from, to } = range(req.query);
    const created = `${LOCAL_DATE('j.created_at')} BETWEEN ? AND ?`;

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS jobs,
           COALESCE(SUM(CASE WHEN status != 'cancelled' THEN price END), 0) AS sales,
           SUM(status = 'completed') AS completed,
           SUM(status = 'cancelled') AS cancelled
         FROM jobs j WHERE tenant_id = ? AND ${created}`,
      )
      .get(t, from, to);
    totals.collected = db.prepare('SELECT COALESCE(SUM(amount), 0) v FROM payments WHERE tenant_id = ? AND paid_at BETWEEN ? AND ?').get(t, from, to).v;
    totals.new_customers = db.prepare(`SELECT COUNT(*) n FROM customers WHERE tenant_id = ? AND ${LOCAL_DATE('created_at')} BETWEEN ? AND ?`).get(t, from, to).n;
    const ontime = db
      .prepare(
        `SELECT COUNT(*) n, SUM(due_date IS NULL OR ${LOCAL_DATE('completed_at')} <= due_date) ok
         FROM jobs WHERE tenant_id = ? AND status = 'completed' AND ${LOCAL_DATE('completed_at')} BETWEEN ? AND ?`,
      )
      .get(t, from, to);
    totals.completed_in_range = ontime.n;
    totals.on_time_rate = ontime.n ? Math.round(((ontime.ok || 0) / ontime.n) * 100) : null;

    const byStatus = db
      .prepare(`SELECT status, COUNT(*) AS jobs, COALESCE(SUM(price), 0) AS value FROM jobs j WHERE tenant_id = ? AND ${created} GROUP BY status`)
      .all(t, from, to);

    const bySignType = db
      .prepare(
        `SELECT COALESCE(sign_type, 'ไม่ระบุ') AS sign_type, COUNT(*) AS jobs, COALESCE(SUM(price), 0) AS value
         FROM jobs j WHERE tenant_id = ? AND status != 'cancelled' AND ${created}
         GROUP BY 1 ORDER BY value DESC`,
      )
      .all(t, from, to);

    const topCustomers = db
      .prepare(
        `SELECT c.id, c.name, c.company, COUNT(*) AS jobs, COALESCE(SUM(j.price), 0) AS value
         FROM jobs j JOIN customers c ON c.id = j.customer_id
         WHERE j.tenant_id = ? AND j.status != 'cancelled' AND ${created}
         GROUP BY c.id ORDER BY value DESC LIMIT 10`,
      )
      .all(t, from, to);

    const byStaff = db
      .prepare(
        `SELECT COALESCE(u.name, 'ยังไม่มอบหมาย') AS name, COUNT(*) AS jobs,
           SUM(j.status = 'completed') AS completed, SUM(j.status IN (${OPEN_IN})) AS open,
           COALESCE(SUM(CASE WHEN j.status != 'cancelled' THEN j.price END), 0) AS value
         FROM jobs j LEFT JOIN users u ON u.id = j.assigned_to
         WHERE j.tenant_id = ? AND ${created}
         GROUP BY j.assigned_to ORDER BY jobs DESC`,
      )
      .all(t, from, to);

    // ยอดรายเดือน (ยอดขายตามวันรับงาน, ยอดเก็บเงินตามวันชำระ)
    const salesByMonth = db
      .prepare(
        `SELECT strftime('%Y-%m', j.created_at, '+7 hours') AS month, COUNT(*) AS jobs, COALESCE(SUM(price), 0) AS sales
         FROM jobs j WHERE tenant_id = ? AND status != 'cancelled' AND ${created} GROUP BY 1`,
      )
      .all(t, from, to);
    const collectedByMonth = db
      .prepare(
        `SELECT substr(paid_at, 1, 7) AS month, SUM(amount) AS collected FROM payments
         WHERE tenant_id = ? AND paid_at BETWEEN ? AND ? GROUP BY 1`,
      )
      .all(t, from, to);
    const months = new Map();
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
      months.set(m, { month: m, jobs: 0, sales: 0, collected: 0 });
      const [y, mo] = m.split('-').map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    }
    for (const row of salesByMonth) Object.assign(months.get(row.month) || {}, { jobs: row.jobs, sales: row.sales });
    for (const row of collectedByMonth) Object.assign(months.get(row.month) || {}, { collected: row.collected });

    res.json({
      from,
      to,
      totals,
      by_status: byStatus,
      by_sign_type: bySignType,
      top_customers: topCustomers,
      by_staff: byStaff,
      monthly: [...months.values()],
    });
  });

  // ส่งออกรายการงานเป็น CSV (มี BOM เพื่อให้ Excel อ่านภาษาไทยได้)
  r.get('/reports/jobs.csv', (req, res) => {
    const t = req.user.tenant_id;
    const { from, to } = range(req.query);
    const labels = Object.fromEntries(JOB_STATUSES.map((s) => [s.key, s.label]));
    const rows = db
      .prepare(
        `SELECT j.job_no, ${LOCAL_DATE('j.created_at')} AS created, c.name AS customer, c.phone, j.title, j.sign_type, j.material,
           j.width_cm, j.height_cm, j.quantity, j.price,
           (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid,
           j.status, j.due_date, u.name AS assigned
         FROM jobs j JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.assigned_to
         WHERE j.tenant_id = ? AND ${LOCAL_DATE('j.created_at')} BETWEEN ? AND ? ORDER BY j.id`,
      )
      .all(t, from, to);
    const header = ['เลขที่งาน', 'วันที่รับงาน', 'ลูกค้า', 'โทร', 'ชื่องาน', 'ประเภทป้าย', 'วัสดุ', 'กว้าง(ซม.)', 'สูง(ซม.)', 'จำนวน', 'ราคา', 'ชำระแล้ว', 'คงค้าง', 'สถานะ', 'กำหนดส่ง', 'ผู้รับผิดชอบ'];
    const lines = [header.join(',')];
    for (const x of rows) {
      lines.push(
        [x.job_no, x.created, x.customer, x.phone, x.title, x.sign_type, x.material, x.width_cm, x.height_cm, x.quantity, x.price, x.paid,
          x.price - x.paid, labels[x.status] || x.status, x.due_date, x.assigned].map(csvCell).join(','),
      );
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="jobs_${from}_${to}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  });

  return r;
};
