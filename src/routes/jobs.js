const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, num, oneOf, date, mapsUrl, appUrl, intId, today, pagination } = require('../util');
const { notifyStatus } = require('../notify');
const { ACTIVE_KINDS, PRIORITIES, PAYMENT_KINDS, PAYMENT_METHODS, DELIVERY_METHODS } = require('../constants');

const PRIORITY_KEYS = PRIORITIES.map((p) => p.key);
const METHOD_KEYS = PAYMENT_METHODS.map((m) => m.key);
const DELIVERY_KEYS = DELIVERY_METHODS.map((m) => m.key);
const ACTIVE_IN = ACTIVE_KINDS.map((k) => `'${k}'`).join(',');

const JOB_SELECT = `
  SELECT j.*, c.name AS customer_name, c.company AS customer_company, c.phone AS customer_phone,
    u.name AS assigned_name,
    st.name AS status_name, st.color AS status_color, st.kind AS status_kind,
    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid
  FROM jobs j
  JOIN customers c ON c.id = j.customer_id
  JOIN job_statuses st ON st.id = j.status_id
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
      job_type_id: num(pick('job_type_id'), 'ประเภทงาน', { min: 1 }),
      sign_type: null,
      material: str(pick('material')),
      width_cm: num(pick('width_cm'), 'ความกว้าง', { min: 0 }),
      height_cm: num(pick('height_cm'), 'ความสูง', { min: 0 }),
      quantity: num(pick('quantity'), 'จำนวน', { min: 1, def: 1 }),
      description: str(pick('description')),
      price: num(pick('price'), 'ราคา', { min: 0, def: 0 }),
      priority: oneOf(pick('priority'), PRIORITY_KEYS, 'ความเร่งด่วน', 'normal'),
      assigned_to: num(pick('assigned_to'), 'ผู้รับผิดชอบ', { min: 1 }),
      due_date: date(pick('due_date'), 'กำหนดส่ง'),
      delivery_method: oneOf(pick('delivery_method'), DELIVERY_KEYS, 'วิธีส่งมอบ', null),
      install_required: false,
      install_address: str(pick('install_address')), // ที่อยู่จัดส่ง/ติดตั้ง
      location_url: mapsUrl(pick('location_url')), // ลิงก์ Google Maps หน้างาน
    };
    if (!d.customer_id) throw new HttpError(400, 'กรุณาเลือกลูกค้า');
    if (!Number.isInteger(d.quantity) || !Number.isInteger(d.customer_id)) throw new HttpError(400, 'จำนวนต้องเป็นจำนวนเต็ม');
    if (d.assigned_to !== null && !Number.isInteger(d.assigned_to)) throw new HttpError(400, 'ผู้รับผิดชอบไม่ถูกต้อง');
    if (d.job_type_id === null && !current.id) throw new HttpError(400, 'กรุณาเลือกประเภทงาน');
    if (d.delivery_method === null && !current.id) throw new HttpError(400, 'กรุณาเลือกวิธีส่งมอบ');
    const delivery = DELIVERY_METHODS.find((m) => m.key === d.delivery_method);
    if (delivery?.needs_address && !d.install_address) throw new HttpError(400, `"${delivery.label}" ต้องระบุที่อยู่จัดส่ง/ติดตั้ง`);
    d.install_required = d.delivery_method === 'shop_install';
    if (d.job_type_id !== null) {
      // ประเภทที่ปิดใช้งานแล้ว เลือกใหม่ไม่ได้ แต่งานเดิมที่ใช้อยู่ยังบันทึกต่อได้
      const type = await db.one('SELECT name, requires_detail, active FROM job_types WHERE id = ? AND tenant_id = ?', [d.job_type_id, tenantId]);
      if (!type || (!type.active && d.job_type_id !== current.job_type_id)) throw new HttpError(400, 'ไม่พบประเภทงาน');
      if (type.requires_detail && !d.description) throw new HttpError(400, `ประเภท "${type.name}" ต้องระบุรายละเอียดงาน`);
      d.sign_type = type.name;
    } else if (current.job_type_id === null && current.sign_type) {
      d.sign_type = current.sign_type; // งานเก่าก่อนมี master ประเภทงาน
    }
    await ensureCustomer(tenantId, d.customer_id);
    await ensureUser(tenantId, d.assigned_to);
    return d;
  }

  r.get('/jobs', async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const conds = ['j.tenant_id = ?'];
    const params = [req.user.tenant_id];
    if (req.query.status_id) {
      const ids = String(req.query.status_id).split(',').map(Number).filter(Number.isInteger);
      if (ids.length) {
        conds.push(`j.status_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
    }
    // open=1 : งานที่ยังไม่ปิด (ระหว่างดำเนินการ + ส่งมอบแล้วรอปิด)
    if (req.query.open === '1') conds.push(`st.kind IN (${ACTIVE_IN})`);
    if (Number.isInteger(Number(req.query.customer_id)) && req.query.customer_id) {
      conds.push('j.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (DELIVERY_KEYS.includes(req.query.delivery_method)) {
      conds.push('j.delivery_method = ?');
      params.push(req.query.delivery_method);
    }
    if (Number.isInteger(Number(req.query.job_type_id)) && req.query.job_type_id) {
      conds.push('j.job_type_id = ?');
      params.push(Number(req.query.job_type_id));
    }
    if (Number.isInteger(Number(req.query.assigned_to)) && req.query.assigned_to) {
      conds.push('j.assigned_to = ?');
      params.push(Number(req.query.assigned_to));
    }
    if (req.query.overdue === '1') {
      conds.push("st.kind = 'open' AND j.due_date < ?");
      params.push(today());
    }
    const q = str(req.query.q);
    if (q) {
      conds.push('(j.job_no ILIKE ? OR j.title ILIKE ? OR c.name ILIKE ? OR c.company ILIKE ? OR j.sign_type ILIKE ?)');
      params.push(...Array(5).fill(`%${q}%`));
    }
    const where = conds.join(' AND ');
    const { n: total } = await db.one(
      `SELECT COUNT(*) n FROM jobs j JOIN customers c ON c.id = j.customer_id JOIN job_statuses st ON st.id = j.status_id WHERE ${where}`,
      params,
    );
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
      `SELECT l.id, l.note, l.created_at, u.name AS user_name,
         l.from_status_id, fs.name AS from_name, fs.color AS from_color,
         l.to_status_id, ts.name AS to_name, ts.color AS to_color
       FROM job_status_logs l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN job_statuses fs ON fs.id = l.from_status_id
       LEFT JOIN job_statuses ts ON ts.id = l.to_status_id
       WHERE l.job_id = ? AND l.tenant_id = ? ORDER BY l.id`,
      [job.id, t],
    );
    job.payments = await db.query(
      `SELECT p.*, u.name AS user_name FROM payments p LEFT JOIN users u ON u.id = p.user_id
       WHERE p.job_id = ? AND p.tenant_id = ? ORDER BY p.paid_at, p.id`,
      [job.id, t],
    );
    job.notifications = await db.query(
      `SELECT id, channel, status, error, created_at FROM notification_logs
       WHERE job_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 20`,
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
      // สถานะเริ่มต้น = สถานะ "ระหว่างดำเนินการ" ลำดับแรกที่เปิดใช้งาน
      const start = await tx.one("SELECT id FROM job_statuses WHERE tenant_id = ? AND kind = 'open' AND active ORDER BY sort_order, id LIMIT 1", [t]);
      if (!start) throw new HttpError(400, 'ยังไม่มีสถานะงานเริ่มต้น — ตั้งค่าที่ ตั้งค่า → สถานะงาน');
      const { job_seq: seq } = await tx.one('UPDATE tenants SET job_seq = job_seq + 1 WHERE id = ? RETURNING job_seq', [t]);
      const jobNo = `J${today().slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const cols = Object.keys(d);
      const { id } = await tx.one(
        `INSERT INTO jobs (tenant_id, job_no, created_by, status_id, ${cols.join(', ')}) VALUES (?, ?, ?, ?, ${cols.map(() => '?').join(', ')}) RETURNING id`,
        [t, jobNo, req.user.id, start.id, ...cols.map((c) => d[c])],
      );
      await tx.run('INSERT INTO job_status_logs (tenant_id, job_id, to_status_id, note, user_id) VALUES (?, ?, ?, ?, ?)', [
        t, id, start.id, 'รับงาน', req.user.id,
      ]);
      if (deposit > 0) {
        await tx.run("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', ?, ?, ?)", [
          t, id, deposit, depositMethod, today(), req.user.id,
        ]);
      }
      return getJob(t, id, tx);
    });
    // แจ้งเตือนหลังบันทึกสำเร็จแล้ว — ส่งไม่สำเร็จก็ไม่กระทบงาน
    job.notification = await notifyStatus(db, {
      tenantId: t, job, fromStatusId: null, toStatusId: job.status_id, userName: req.user.name, appUrl: appUrl(req),
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
    const statusId = num(req.body.status_id, 'สถานะ', { min: 1 });
    if (!statusId) throw new HttpError(400, 'กรุณาเลือกสถานะ');
    const next = await db.one('SELECT id, kind, active FROM job_statuses WHERE id = ? AND tenant_id = ?', [statusId, t]);
    if (!next || !next.active) throw new HttpError(400, 'ไม่พบสถานะ');
    if (next.id === job.status_id) throw new HttpError(400, 'งานอยู่ในสถานะนี้แล้ว');
    const updated = await db.tx(async (tx) => {
      // delivered_at = เวลาส่งมอบครั้งแรก (ใช้คำนวณส่งตรงเวลา), completed_at = เวลาปิดงาน
      await tx.run(
        `UPDATE jobs SET status_id = ?, updated_at = now(),
           delivered_at = CASE WHEN ? IN ('delivered', 'done') THEN COALESCE(delivered_at, now()) ELSE NULL END,
           completed_at = CASE WHEN ? = 'done' THEN now() ELSE NULL END
         WHERE id = ?`,
        [next.id, next.kind, next.kind, job.id],
      );
      await tx.run('INSERT INTO job_status_logs (tenant_id, job_id, from_status_id, to_status_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?)', [
        t, job.id, job.status_id, next.id, str(req.body.note), req.user.id,
      ]);
      return getJob(t, job.id, tx);
    });
    updated.notification = await notifyStatus(db, {
      tenantId: t, job: updated, fromStatusId: job.status_id, toStatusId: next.id, note: str(req.body.note), userName: req.user.name, appUrl: appUrl(req),
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
