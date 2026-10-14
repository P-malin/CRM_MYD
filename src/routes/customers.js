const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, intId, pagination } = require('../util');

const FIELDS = ['name', 'company', 'phone', 'email', 'line_id', 'address', 'tax_id', 'branch', 'note'];

function readBody(b) {
  const out = {};
  for (const f of FIELDS) out[f] = str(b[f]);
  out.name = requireStr(b.name, 'ชื่อลูกค้า');
  return out;
}

module.exports = function customerRoutes(db) {
  const r = express.Router();

  const getCustomer = async (tenantId, id) => {
    const c = await db.one('SELECT * FROM customers WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!c) throw new HttpError(404, 'ไม่พบลูกค้า');
    return c;
  };

  r.get('/customers', async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const params = [req.user.tenant_id];
    let where = 'c.tenant_id = ?';
    const q = str(req.query.q);
    if (q) {
      where += ' AND (c.name ILIKE ? OR c.company ILIKE ? OR c.phone ILIKE ? OR c.email ILIKE ? OR c.line_id ILIKE ?)';
      params.push(...Array(5).fill(`%${q}%`));
    }
    const { n: total } = await db.one(`SELECT COUNT(*) n FROM customers c WHERE ${where}`, params);
    const rows = await db.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM jobs j JOIN job_statuses st ON st.id = j.status_id
            WHERE j.customer_id = c.id AND st.kind != 'cancelled') AS job_count,
         (SELECT COALESCE(SUM(j.price), 0) FROM jobs j JOIN job_statuses st ON st.id = j.status_id
            WHERE j.customer_id = c.id AND st.kind != 'cancelled') AS total_value,
         (SELECT MAX(j.created_at) FROM jobs j WHERE j.customer_id = c.id) AS last_job_at
       FROM customers c WHERE ${where}
       ORDER BY c.name LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ total, rows });
  });

  r.get('/customers/:id', async (req, res) => {
    const c = await getCustomer(req.user.tenant_id, intId(req.params.id));
    c.jobs = await db.query(
      `SELECT j.id, j.job_no, j.title, j.status_id, st.name AS status_name, st.color AS status_color, st.kind AS status_kind,
         j.price, j.due_date, j.created_at,
         (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid
       FROM jobs j JOIN job_statuses st ON st.id = j.status_id
       WHERE j.customer_id = ? AND j.tenant_id = ? ORDER BY j.created_at DESC`,
      [c.id, req.user.tenant_id],
    );
    res.json(c);
  });

  r.post('/customers', async (req, res) => {
    const d = readBody(req.body);
    const c = await db.one(
      `INSERT INTO customers (tenant_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')}) RETURNING *`,
      [req.user.tenant_id, ...FIELDS.map((f) => d[f])],
    );
    res.status(201).json(c);
  });

  r.put('/customers/:id', async (req, res) => {
    const c = await getCustomer(req.user.tenant_id, intId(req.params.id));
    const d = readBody(req.body);
    const updated = await db.one(
      `UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = now() WHERE id = ? RETURNING *`,
      [...FIELDS.map((f) => d[f]), c.id],
    );
    res.json(updated);
  });

  r.delete('/customers/:id', requireRole('owner', 'admin'), async (req, res) => {
    const c = await getCustomer(req.user.tenant_id, intId(req.params.id));
    if (await db.one('SELECT 1 FROM jobs WHERE customer_id = ? LIMIT 1', [c.id])) throw new HttpError(409, 'ลูกค้ารายนี้มีงานอยู่ ไม่สามารถลบได้');
    await db.run('DELETE FROM customers WHERE id = ?', [c.id]);
    res.json({ ok: true });
  });

  return r;
};
