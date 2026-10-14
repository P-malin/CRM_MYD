const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, num, oneOf, date, intId, today, pagination } = require('../util');
const { STATUS_KEYS, OPEN_STATUSES, PRIORITIES, PAYMENT_KINDS, PAYMENT_METHODS } = require('../constants');

const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
const METHOD_KEYS = PAYMENT_METHODS.map((m) => m.key);
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

  const getJob = async (tenantId, id, q = db) => {
    const j = await q.one(`${JOB_SELECT} WHERE j.id = ? AND j.tenant_id = ?`, [id, tenantId]);
    if (!j) throw new HttpError(404, 'ไม่พบงาน');
    return j;
  };

  // ตรวจว่า id อ้างอิงอยู่ในร้านเดียวกัน (กันการอ้างข้อมูลข้ามร้าน)
  const ensureCustomer = async (tenantId, id) => {
    if (!(await db.one('SELECT 1 FROM customers WHERE id = ? AND tenant_id = ?', [id, tenantId]))) throw new HttpError(400, 'ไม่พบลูกค้า');
  };
  const ensureUser = async (tenantId, id) => {
    if (id !== null && !(await db.one('SELECT 1 FROM users WHERE id = ? AND tenant_id = ?', [id, tenantId]))) {
      throw new HttpError(400, 'ไม่พบพนักงานที่มอบหมาย');
    }
  };

  async function readBody(b, tenantId, current = {}) {
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
      install_required: Boolean(pick('install_required')),
      install_address: str(pick('install_address')),
    };
    if (!d.customer_id) throw new HttpError(400, 'กรุณาเลือกลูกค้า');
    if (!Number.isInteger(d.quantity) || !Number.isInteger(d.customer_id)) throw new HttpError(400, 'จำนวนต้องเป็นจำนวนเต็ม');
    if (d.assigned_to !== null && !Number.isInteger(d.assigned_to)) throw new HttpError(400, 'ผู้รับผิดชอบไม่ถูกต้อง');
    await ensureCustomer(tenantId, d.customer_id);
    await ensureUser(tenantId, d.assigned_to);
    return d;
  }

  r.get('/jobs', async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const conds = ['j.tenant_id = ?'];
    const params = [req.user.tenant_id];
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').filter((s) => STATUS_KEYS.includes(s));
      if (statuses.length) {
        conds.push(`j.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (req.query.open === '1') conds.push(`j.status IN (${OPEN_IN})`);
    if (Number.isInteger(Number(req.query.customer_id)) && req.query.customer_id) {
      conds.push('j.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (Number.isInteger(Number(req.query.assigned_to)) && req.query.assigned_to) {
      conds.push('j.assigned_to = ?');
      params.push(Number(req.query.assigned_to));
    }
    if (req.query.overdue === '1') {
      conds.push(`j.status IN (${OPEN_IN}) AND j.due_date < ?`);
      params.push(today());
    }
    const q = str(req.query.q);
    if (q) {
      conds.push('(j.job_no ILIKE ? OR j.title ILIKE ? OR c.name ILIKE ? OR c.company ILIKE ? OR j.sign_type ILIKE ?)');
      params.push(...Array(5).fill(`%${q}%`));
    }
    const where = conds.join(' AND ');
    const { n: total } = await db.one(`SELECT COUNT(*) n FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE ${where}`, params);
    const rows = await db.query(`${JOB_SELECT} WHERE ${where} ORDER BY j.due_date NULLS LAST, j.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    res.json({ total, rows });
  });

  r.get('/jobs/:id', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    job.logs = await db.query(
      `SELECT l.*, u.name AS user_name FROM job_status_logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.job_id = ? AND l.tenant_id = ? ORDER BY l.id`,
      [job.id, t],
    );
    job.payments = await db.query(
      `SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
       WHERE p.job_id = ? AND p.tenant_id = ? ORDER BY p.paid_at, p.id`,
      [job.id, t],
    );
    res.json(job);
  });

  r.post('/jobs', async (req, res) => {
    const t = req.user.tenant_id;
    const d = await readBody(req.body, t);
    const deposit = num(req.body.deposit, 'มัดจำ', { min: 0, def: 0 });
    const depositMethod = oneOf(req.body.deposit_method, METHOD_KEYS, 'ช่องทางชำระ', 'cash');
    const job = await db.tx(async (tx) => {
      // UPDATE ... RETURNING ล็อกแถวร้านไว้ ทำให้เลขที่งานไม่ซ้ำแม้รับงานพร้อมกัน
      const { job_seq: seq } = await tx.one('UPDATE tenants SET job_seq = job_seq + 1 WHERE id = ? RETURNING job_seq', [t]);
      const jobNo = `J${today().slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const cols = Object.keys(d);
      const { id } = await tx.one(
        `INSERT INTO jobs (tenant_id, job_no, created_by, ${cols.join(', ')}) VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')}) RETURNING id`,
        [t, jobNo, req.user.id, ...cols.map((c) => d[c])],
      );
      await tx.run("INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id) VALUES (?, ?, NULL, 'new', ?, ?)", [
        t, id, 'รับงาน', req.user.id,
      ]);
      if (deposit > 0) {
        await tx.run("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', ?, ?, ?)", [
          t, id, deposit, depositMethod, today(), req.user.id,
        ]);
      }
      return getJob(t, id, tx);
    });
    res.status(201).json(job);
  });

  r.put('/jobs/:id', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const d = await readBody(req.body, t, job);
    const cols = Object.keys(d);
    await db.run(`UPDATE jobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, [...cols.map((c) => d[c]), job.id]);
    res.json(await getJob(t, job.id));
  });

  r.post('/jobs/:id/status', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const status = oneOf(req.body.status, STATUS_KEYS, 'สถานะ', null);
    if (!status) throw new HttpError(400, 'กรุณาเลือกสถานะ');
    if (status === job.status) throw new HttpError(400, 'งานอยู่ในสถานะนี้แล้ว');
    const updated = await db.tx(async (tx) => {
      await tx.run(
        `UPDATE jobs SET status = ?, updated_at = now(),
           completed_at = CASE WHEN ? = 'completed' THEN now() ELSE NULL END
         WHERE id = ?`,
        [status, status, job.id],
      );
      await tx.run('INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id) VALUES (?, ?, ?, ?, ?, ?)', [
        t, job.id, job.status, status, str(req.body.note), req.user.id,
      ]);
      return getJob(t, job.id, tx);
    });
    res.json(updated);
  });

  r.post('/jobs/:id/payments', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const amount = num(req.body.amount, 'จำนวนเงิน', { min: 0.01 });
    if (!amount) throw new HttpError(400, 'กรุณากรอกจำนวนเงิน');
    await db.run('INSERT INTO payments (tenant_id, job_id, amount, kind, method, note, paid_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      t,
      job.id,
      amount,
      oneOf(req.body.kind, PAYMENT_KINDS.map((k) => k.key), 'ประเภทการชำระ', 'installment'),
      oneOf(req.body.method, METHOD_KEYS, 'ช่องทางชำระ', 'cash'),
      str(req.body.note),
      date(req.body.paid_at, 'วันที่ชำระ') || today(),
      req.user.id,
    ]);
    res.status(201).json(await getJob(t, job.id));
  });

  r.delete('/jobs/:id/payments/:pid', requireRole('owner', 'admin'), async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const { rowCount } = await db.run('DELETE FROM payments WHERE id = ? AND job_id = ? AND tenant_id = ?', [intId(req.params.pid), job.id, t]);
    if (!rowCount) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
    res.json(await getJob(t, job.id));
  });

  r.delete('/jobs/:id', requireRole('owner', 'admin'), async (req, res) => {
    const job = await getJob(req.user.tenant_id, intId(req.params.id));
    await db.run('DELETE FROM jobs WHERE id = ?', [job.id]);
    res.json({ ok: true });
  });

  return r;
};
