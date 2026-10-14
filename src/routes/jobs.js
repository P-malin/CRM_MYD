const express = require('express');
const { transaction } = require('../db');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, num, oneOf, date, intId, today, pagination } = require('../util');
const { STATUS_KEYS, OPEN_STATUSES, PRIORITIES, PAYMENT_KINDS, PAYMENT_METHODS } = require('../constants');

const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
const OPEN_IN = OPEN_STATUSES.map((s) => `'${s}'`).join(',');

const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, c.company AS customer_company, c.phone AS customer_phone,
    u.name AS assigned_name,
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  LEFT JOIN users u ON u.id = j.assigned_to`;

module.exports = function jobRoutes(db) {
  const r = express.Router();

  const getJob = (tenantId, id) => {
    const j = db.prepare(`${JOB_SELECT} WHERE j.id = ? AND j.tenant_id = ?`).get(id, tenantId);
    if (!j) throw new HttpError(404, 'ไม่พบงาน');
    return j;
  };

  // ตรวจว่า id อ้างอิงอยู่ในร้านเดียวกัน (กันการอ้างข้อมูลข้ามร้าน)
  const ensureCustomer = (tenantId, id) => {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ? AND tenant_id = ?').get(id, tenantId)) throw new HttpError(400, 'ไม่พบลูกค้า');
  };
  const ensureUser = (tenantId, id) => {
    if (id !== null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?').get(id, tenantId)) {
      throw new HttpError(400, 'ไม่พบพนักงานที่มอบหมาย');
    }
  };

  function readBody(b, tenantId, current = {}) {
    const pick = (k) => (b[k] === undefined ? current[k] : b[k]);
    const d = {
      customer_id: num(pick('customer_id'), 'ลูกค้า', { min: 1 }),
      title: requireStr(pick('title'), 'ชื่องาน'),
      sign_type: str(pick('sign_type')),
      material: str(pick('material')),
      width_cm: num(pick('width_cm'), 'ความกว้าง', { min: 0 }),
      height_cm: num(pick('height_cm'), 'ความสูง', { min: 0 }),
      quantity: num(pick('quantity'), 'จำนวน', { min: 1, def: 1 }),
      description: str(pick('description')),
      price: num(pick('price'), 'ราคา', { min: 0, def: 0 }),
      priority: oneOf(pick('priority'), PRIORITY_KEYS, 'ความเร่งด่วน', 'normal'),
      assigned_to: num(pick('assigned_to'), 'ผู้รับผิดชอบ', { min: 1 }),
      due_date: date(pick('due_date'), 'กำหนดส่ง'),
      install_required: pick('install_required') ? 1 : 0,
      install_address: str(pick('install_address')),
    };
    if (!d.customer_id) throw new HttpError(400, 'กรุณาเลือกลูกค้า');
    if (!Number.isInteger(d.quantity)) throw new HttpError(400, 'จำนวนต้องเป็นจำนวนเต็ม');
    ensureCustomer(tenantId, d.customer_id);
    ensureUser(tenantId, d.assigned_to);
    return d;
  }

  r.get('/jobs', (req, res) => {
    const { limit, offset } = pagination(req.query);
    const t = req.user.tenant_id;
    const conds = ['j.tenant_id = ?'];
    const params = [t];
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').filter((s) => STATUS_KEYS.includes(s));
      if (statuses.length) {
        conds.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (req.query.open === '1') conds.push(`j.status IN (${OPEN_IN})`);
    if (req.query.customer_id) {
      conds.push('j.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (req.query.assigned_to) {
      conds.push('j.assigned_to = ?');
      params.push(Number(req.query.assigned_to));
    }
    if (req.query.overdue === '1') {
      conds.push(`j.status IN (${OPEN_IN}) AND j.due_date < ?`);
      params.push(today());
    }
    const q = str(req.query.q);
    if (q) {
      conds.push('(j.job_no LIKE ? OR j.title LIKE ? OR c.name LIKE ? OR c.company LIKE ? OR j.sign_type LIKE ?)');
      params.push(...Array(5).fill(`%${q}%`));
    }
    const where = conds.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) n FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(`${JOB_SELECT} WHERE ${where} ORDER BY (j.due_date IS NULL), j.due_date, j.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    res.json({ total, rows });
  });

  r.get('/jobs/:id', (req, res) => {
    const t = req.user.tenant_id;
    const job = getJob(t, intId(req.params.id));
    job.logs = db
      .prepare(
        `SELECT l.*, u.name AS user_name FROM job_status_logs l LEFT JOIN users u ON u.id = l.user_id
         WHERE l.job_id = ? AND l.tenant_id = ? ORDER BY l.id`,
      )
      .all(job.id, t);
    job.payments = db
      .prepare(
        `SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
         WHERE p.job_id = ? AND p.tenant_id = ? ORDER BY p.paid_at, p.id`,
      )
      .all(job.id, t);
    res.json(job);
  });

  r.post('/jobs', (req, res) => {
    const t = req.user.tenant_id;
    const d = readBody(req.body, t);
    const deposit = num(req.body.deposit, 'มัดจำ', { min: 0, def: 0 });
    const id = transaction(db, () => {
      db.prepare('UPDATE tenants SET job_seq = job_seq + 1 WHERE id = ?').run(t);
      const seq = db.prepare('SELECT job_seq FROM tenants WHERE id = ?').get(t).job_seq;
      const ym = today().slice(2, 7).replace('-', '');
      const jobNo = `J${ym}-${String(seq).padStart(4, '0')}`;
      const cols = Object.keys(d);
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO jobs (tenant_id, job_no, created_by, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(t, jobNo, req.user.id, ...cols.map((c) => d[c]));
      db.prepare("INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id) VALUES (?, ?, NULL, 'new', ?, ?)").run(
        t, lastInsertRowid, 'รับงาน', req.user.id,
      );
      if (deposit > 0) {
        db.prepare("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', ?, ?, ?)").run(
          t, lastInsertRowid, deposit, oneOf(req.body.deposit_method, PAYMENT_METHODS.map((m) => m.key), 'ช่องทางชำระ', 'cash'), today(), req.user.id,
        );
      }
      return lastInsertRowid;
    });
    res.status(201).json(getJob(t, id));
  });

  r.put('/jobs/:id', (req, res) => {
    const t = req.user.tenant_id;
    const job = getJob(t, intId(req.params.id));
    const d = readBody(req.body, t, job);
    const cols = Object.keys(d);
    db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
      ...cols.map((c) => d[c]),
      job.id,
    );
    res.json(getJob(t, job.id));
  });

  r.post('/jobs/:id/status', (req, res) => {
    const t = req.user.tenant_id;
    const job = getJob(t, intId(req.params.id));
    const status = oneOf(req.body.status, STATUS_KEYS, 'สถานะ', null);
    if (!status) throw new HttpError(400, 'กรุณาเลือกสถานะ');
    if (status === job.status) throw new HttpError(400, 'งานอยู่ในสถานะนี้แล้ว');
    transaction(db, () => {
      db.prepare(
        `UPDATE jobs SET status = ?, updated_at = datetime('now'),
           completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END
         WHERE id = ?`,
      ).run(status, status, job.id);
      db.prepare('INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(
        t, job.id, job.status, status, str(req.body.note), req.user.id,
      );
    });
    res.json(getJob(t, job.id));
  });

  r.post('/jobs/:id/payments', (req, res) => {
    const t = req.user.tenant_id;
    const job = getJob(t, intId(req.params.id));
    const amount = num(req.body.amount, 'จำนวนเงิน', { min: 0.01 });
    if (!amount) throw new HttpError(400, 'กรุณากรอกจำนวนเงิน');
    db.prepare('INSERT INTO payments (tenant_id, job_id, amount, kind, method, note, paid_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      t,
      job.id,
      amount,
      oneOf(req.body.kind, PAYMENT_KINDS.map((k) => k.key), 'ประเภทการชำระ', 'installment'),
      oneOf(req.body.method, PAYMENT_METHODS.map((m) => m.key), 'ช่องทางชำระ', 'cash'),
      str(req.body.note),
      date(req.body.paid_at, 'วันที่ชำระ') || today(),
      req.user.id,
    );
    res.status(201).json(getJob(t, job.id));
  });

  r.delete('/jobs/:id/payments/:pid', requireRole('owner', 'admin'), (req, res) => {
    const t = req.user.tenant_id;
    const job = getJob(t, intId(req.params.id));
    const { changes } = db.prepare('DELETE FROM payments WHERE id = ? AND job_id = ? AND tenant_id = ?').run(intId(req.params.pid), job.id, t);
    if (!changes) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
    res.json(getJob(t, job.id));
  });

  r.delete('/jobs/:id', requireRole('owner', 'admin'), (req, res) => {
    const job = getJob(req.user.tenant_id, intId(req.params.id));
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    res.json({ ok: true });
  });

  return r;
};
