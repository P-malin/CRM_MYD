const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, intId, pagination } = require('../util');

const FIELDS = ['name', 'company', 'phone', 'email', 'line_id', 'address', 'tax_id', 'note'];

function readBody(b) {
  const out = {};
  for (const f of FIELDS) out[f] = str(b[f]);
  out.name = requireStr(b.name, 'ชื่อลูกค้า');
  return out;
}

module.exports = function customerRoutes(db) {
  const r = express.Router();

  const getCustomer = (tenantId, id) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    if (!c) throw new HttpError(404, 'ไม่พบลูกค้า');
    return c;
  };

  r.get('/customers', (req, res) => {
    const { limit, offset } = pagination(req.query);
    const params = [req.user.tenant_id];
    let where = 'c.tenant_id = ?';
    const q = str(req.query.q);
    if (q) {
      where += ' AND (c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.line_id LIKE ?)';
      params.push(...Array(5).fill(`%${q}%`));
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM customers c WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM jobs j WHERE j.customer_id = c.id AND j.status != 'cancelled') AS job_count,
           (SELECT COALESCE(SUM(j.price), 0) FROM jobs j WHERE j.customer_id = c.id AND j.status != 'cancelled') AS total_value,
           (SELECT MAX(j.created_at) FROM jobs j WHERE j.customer_id = c.id) AS last_job_at
         FROM customers c WHERE ${where}
         ORDER BY c.name LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    res.json({ total, rows });
  });

  r.get('/customers/:id', (req, res) => {
    const c = getCustomer(req.user.tenant_id, intId(req.params.id));
    c.jobs = db
      .prepare(
        `SELECT j.id, j.job_no, j.title, j.status, j.price, j.due_date, j.created_at,
           (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.job_id = j.id) AS paid
         FROM jobs j WHERE j.customer_id = ? AND j.tenant_id = ? ORDER BY j.created_at DESC`,
      )
      .all(c.id, req.user.tenant_id);
    res.json(c);
  });

  r.post('/customers', (req, res) => {
    const d = readBody(req.body);
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO customers (tenant_id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`)
      .run(req.user.tenant_id, ...FIELDS.map((f) => d[f]));
    res.status(201).json(getCustomer(req.user.tenant_id, lastInsertRowid));
  });

  r.put('/customers/:id', (req, res) => {
    const c = getCustomer(req.user.tenant_id, intId(req.params.id));
    const d = readBody(req.body);
    db.prepare(`UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
      ...FIELDS.map((f) => d[f]),
      c.id,
    );
    res.json(getCustomer(req.user.tenant_id, c.id));
  });

  r.delete('/customers/:id', requireRole('owner', 'admin'), (req, res) => {
    const c = getCustomer(req.user.tenant_id, intId(req.params.id));
    if (db.prepare('SELECT 1 FROM jobs WHERE customer_id = ?').get(c.id)) throw new HttpError(409, 'ลูกค้ารายนี้มีงานอยู่ ไม่สามารถลบได้');
    db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
    res.json({ ok: true });
  });

  return r;
};
