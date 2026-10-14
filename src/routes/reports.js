const express = require('express');
const { HttpError, date, today } = require('../util');
const { ACTIVE_KINDS, DELIVERY_METHODS } = require('../constants');

const ACTIVE_IN = ACTIVE_KINDS.map((k) => `'${k}'`).join(',');
// งานพร้อมประเภทสถานะ (st.kind): open / delivered / done / cancelled
const JOBS = 'jobs j JOIN job_statuses st ON st.id = j.status_id';

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
  return { from, to };
}
// เวลาเก็บเป็น timestamptz; แปลงเป็นวันที่ตามเวลาไทยก่อนเทียบช่วงวันที่
const LOCAL_DATE = (col) => `(${col} AT TIME ZONE 'Asia/Bangkok')::date`;
const LOCAL_MONTH = (col) => `to_char(${col} AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = function reportRoutes(db) {
  const r = express.Router();

  // ภาพรวมสำหรับหน้าแดชบอร์ด
  r.get('/reports/dashboard', async (req, res) => {
    const t = req.user.tenant_id;
    const d = today();
    const monthStart = `${d.slice(0, 8)}01`;

    const [statusCounts, jobs, collected, outstanding, customers, upcoming] = await Promise.all([
      // ทุกสถานะที่เปิดใช้งาน + สถานะที่ปิดแล้วแต่ยังมีงานอยู่
      db.query(
        `SELECT s.id, s.name, s.color, s.kind, COUNT(j.id) AS n
         FROM job_statuses s LEFT JOIN jobs j ON j.status_id = s.id
         WHERE s.tenant_id = ? GROUP BY s.id HAVING s.active OR COUNT(j.id) > 0
         ORDER BY s.sort_order, s.id`,
        [t],
      ),
      db.one(
        `SELECT
           COUNT(*) FILTER (WHERE st.kind IN (${ACTIVE_IN})) AS open_jobs,
           COUNT(*) FILTER (WHERE st.kind = 'open' AND j.due_date < ?) AS overdue,
           COUNT(*) FILTER (WHERE st.kind = 'open' AND j.due_date BETWEEN ? AND ?) AS due_7_days,
           COALESCE(SUM(j.price) FILTER (WHERE st.kind != 'cancelled' AND ${LOCAL_DATE('j.created_at')} >= ?), 0) AS month_sales
         FROM ${JOBS} WHERE j.tenant_id = ?`,
        [d, d, addDays(d, 7), monthStart, t],
      ),
      db.one('SELECT COALESCE(SUM(amount), 0) v FROM payments WHERE tenant_id = ? AND paid_at >= ?', [t, monthStart]),
      db.one(
        `SELECT COALESCE(SUM(j.price - (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id)), 0) v
         FROM ${JOBS} WHERE j.tenant_id = ? AND st.kind != 'cancelled'`,
        [t],
      ),
      db.one('SELECT COUNT(*) n FROM customers WHERE tenant_id = ?', [t]),
      db.query(
        `SELECT j.id, j.job_no, j.title, j.status_id, st.name AS status_name, st.color AS status_color,
           j.due_date, j.priority, c.name AS customer_name
         FROM ${JOBS} JOIN customers c ON c.id = j.customer_id
         WHERE j.tenant_id = ? AND st.kind = 'open' AND j.due_date IS NOT NULL
         ORDER BY j.due_date LIMIT 10`,
        [t],
      ),
    ]);
    res.json({
      status_counts: statusCounts,
      ...jobs,
      month_collected: collected.v,
      outstanding: outstanding.v,
      customers: customers.n,
      upcoming,
    });
  });

  // รายงานสรุปตามช่วงวันที่
  r.get('/reports/summary', async (req, res) => {
    const t = req.user.tenant_id;
    const { from, to } = range(req.query);
    const created = `${LOCAL_DATE('j.created_at')} BETWEEN ? AND ?`;
    const p = [t, from, to];

    const [totals, collected, newCustomers, ontime, byStatus, bySignType, topCustomers, byStaff, salesByMonth, collectedByMonth] = await Promise.all([
      db.one(
        `SELECT COUNT(*) AS jobs,
           COALESCE(SUM(j.price) FILTER (WHERE st.kind != 'cancelled'), 0) AS sales,
           COUNT(*) FILTER (WHERE st.kind = 'done') AS completed,
           COUNT(*) FILTER (WHERE st.kind = 'cancelled') AS cancelled
         FROM ${JOBS} WHERE j.tenant_id = ? AND ${created}`,
        p,
      ),
      db.one('SELECT COALESCE(SUM(amount), 0) v FROM payments WHERE tenant_id = ? AND paid_at BETWEEN ? AND ?', p),
      db.one(`SELECT COUNT(*) n FROM customers WHERE tenant_id = ? AND ${LOCAL_DATE('created_at')} BETWEEN ? AND ?`, p),
      // ส่งตรงเวลา: วันที่ส่งมอบ (delivered_at) ไม่เกินกำหนดส่ง
      db.one(
        `SELECT COUNT(*) n, COUNT(*) FILTER (WHERE j.due_date IS NULL OR ${LOCAL_DATE('j.delivered_at')} <= j.due_date) ok
         FROM ${JOBS} WHERE j.tenant_id = ? AND st.kind IN ('delivered', 'done') AND ${LOCAL_DATE('j.delivered_at')} BETWEEN ? AND ?`,
        p,
      ),
      db.query(
        `SELECT st.id AS status_id, st.name, st.color, COUNT(*) AS jobs, COALESCE(SUM(j.price), 0) AS value
         FROM ${JOBS} WHERE j.tenant_id = ? AND ${created} GROUP BY st.id ORDER BY st.sort_order, st.id`,
        p,
      ),
      db.query(
        `SELECT COALESCE(j.sign_type, 'ไม่ระบุ') AS sign_type, COUNT(*) AS jobs, COALESCE(SUM(j.price), 0) AS value
         FROM ${JOBS} WHERE j.tenant_id = ? AND st.kind != 'cancelled' AND ${created}
         GROUP BY 1 ORDER BY value DESC`,
        p,
      ),
      db.query(
        `SELECT c.id, c.name, c.company, COUNT(*) AS jobs, COALESCE(SUM(j.price), 0) AS value
         FROM ${JOBS} JOIN customers c ON c.id = j.customer_id
         WHERE j.tenant_id = ? AND st.kind != 'cancelled' AND ${created}
         GROUP BY c.id ORDER BY value DESC LIMIT 10`,
        p,
      ),
      db.query(
        `SELECT COALESCE(u.name, 'ยังไม่มอบหมาย') AS name, COUNT(*) AS jobs,
           COUNT(*) FILTER (WHERE st.kind = 'done') AS completed,
           COUNT(*) FILTER (WHERE st.kind IN (${ACTIVE_IN})) AS open,
           COALESCE(SUM(j.price) FILTER (WHERE st.kind != 'cancelled'), 0) AS value
         FROM ${JOBS} LEFT JOIN users u ON u.id = j.assigned_to
         WHERE j.tenant_id = ? AND ${created}
         GROUP BY j.assigned_to, u.name ORDER BY jobs DESC`,
        p,
      ),
      // ยอดรายเดือน (ยอดขายตามวันรับงาน, ยอดเก็บเงินตามวันชำระ)
      db.query(
        `SELECT ${LOCAL_MONTH('j.created_at')} AS month, COUNT(*) AS jobs, COALESCE(SUM(j.price), 0) AS sales
         FROM ${JOBS} WHERE j.tenant_id = ? AND st.kind != 'cancelled' AND ${created} GROUP BY 1`,
        p,
      ),
      db.query(
        `SELECT to_char(paid_at, 'YYYY-MM') AS month, SUM(amount) AS collected FROM payments
         WHERE tenant_id = ? AND paid_at BETWEEN ? AND ? GROUP BY 1`,
        p,
      ),
    ]);
    totals.collected = collected.v;
    totals.new_customers = newCustomers.n;
    totals.completed_in_range = ontime.n;
    totals.on_time_rate = ontime.n ? Math.round((ontime.ok / ontime.n) * 100) : null;

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
  r.get('/reports/jobs.csv', async (req, res) => {
    const t = req.user.tenant_id;
    const { from, to } = range(req.query);
    const deliveryLabels = Object.fromEntries(DELIVERY_METHODS.map((m) => [m.key, m.label]));
    const rows = await db.query(
      `SELECT j.job_no, to_char(j.created_at AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD') AS created, c.name AS customer, c.phone,
         j.title, j.sign_type, j.material, j.width_cm, j.height_cm, j.quantity, j.price,
         (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid,
         st.name AS status_name, j.due_date, u.name AS assigned, j.delivery_method, j.install_address, j.location_url
       FROM ${JOBS} JOIN customers c ON c.id = j.customer_id LEFT JOIN users u ON u.id = j.assigned_to
       WHERE j.tenant_id = ? AND ${LOCAL_DATE('j.created_at')} BETWEEN ? AND ? ORDER BY j.id`,
      [t, from, to],
    );
    const header = ['เลขที่งาน', 'วันที่รับงาน', 'ลูกค้า', 'โทร', 'ชื่องาน', 'ประเภทงาน', 'วัสดุ', 'กว้าง(ซม.)', 'สูง(ซม.)', 'จำนวน', 'ราคา', 'ชำระแล้ว', 'คงค้าง', 'สถานะ', 'กำหนดส่ง', 'ผู้รับผิดชอบ', 'วิธีส่งมอบ', 'ที่อยู่จัดส่ง/ติดตั้ง', 'Google Maps'];
    const lines = [header.join(',')];
    for (const x of rows) {
      lines.push(
        [x.job_no, x.created, x.customer, x.phone, x.title, x.sign_type, x.material, x.width_cm, x.height_cm, x.quantity, x.price, x.paid,
          x.price - x.paid, x.status_name, x.due_date, x.assigned, deliveryLabels[x.delivery_method] || '', x.install_address, x.location_url]
          .map(csvCell).join(','),
      );
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="jobs_${from}_${to}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  });

  return r;
};
