const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, oneOf, intId } = require('../util');
const { STATUS_KINDS } = require('../constants');

const KIND_KEYS = STATUS_KINDS.map((k) => k.key);
const COLOR_RE = /^#[0-9a-f]{6}$/i; // สีถูกนำไปใส่ใน style จึงต้องตรวจเข้ม
const COLS = `s.id, s.name, s.description, s.color, s.kind, s.sort_order, s.active,
  (SELECT COUNT(*) FROM jobs j WHERE j.status_id = s.id) AS job_count`;

function color(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!COLOR_RE.test(String(v))) throw new HttpError(400, 'สีไม่ถูกต้อง (รูปแบบ #RRGGBB)');
  return String(v).toLowerCase();
}

module.exports = function jobStatusRoutes(db) {
  const r = express.Router();
  const admin = requireRole('owner', 'admin');

  const getStatus = async (tenantId, id) => {
    const s = await db.one(`SELECT ${COLS} FROM job_statuses s WHERE s.id = ? AND s.tenant_id = ?`, [id, tenantId]);
    if (!s) throw new HttpError(404, 'ไม่พบสถานะงาน');
    return s;
  };
  const ensureUniqueName = async (tenantId, name, exceptId = 0) => {
    if (await db.one('SELECT 1 FROM job_statuses WHERE tenant_id = ? AND lower(name) = lower(?) AND id != ?', [tenantId, name, exceptId])) {
      throw new HttpError(409, `มีสถานะ "${name}" อยู่แล้ว`);
    }
  };

  // ?all=1 รวมสถานะที่ปิดใช้งาน
  r.get('/job-statuses', async (req, res) => {
    const where = req.query.all === '1' ? '' : 'AND s.active';
    res.json(await db.query(`SELECT ${COLS} FROM job_statuses s WHERE s.tenant_id = ? ${where} ORDER BY s.sort_order, s.id`, [req.user.tenant_id]));
  });

  r.post('/job-statuses', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const name = requireStr(req.body.name, 'ชื่อสถานะ');
    await ensureUniqueName(t, name);
    const { id } = await db.one(
      `INSERT INTO job_statuses (tenant_id, name, description, color, kind, sort_order)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM job_statuses WHERE tenant_id = ?)) RETURNING id`,
      [t, name, str(req.body.description), color(req.body.color, '#64748b'), oneOf(req.body.kind, KIND_KEYS, 'ประเภทสถานะ', 'open'), t],
    );
    res.status(201).json(await getStatus(t, id));
  });

  // เรียงลำดับใหม่: { ids: [id ตามลำดับ] } ต้องครบทุกสถานะของร้าน
  r.put('/job-statuses/order', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    const existing = (await db.query('SELECT id FROM job_statuses WHERE tenant_id = ?', [t])).map((x) => x.id);
    if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))) {
      throw new HttpError(400, 'ลำดับสถานะไม่ครบหรือไม่ถูกต้อง');
    }
    await db.tx(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.run('UPDATE job_statuses SET sort_order = ? WHERE id = ? AND tenant_id = ?', [i + 1, id, t]);
    });
    res.json(await db.query(`SELECT ${COLS} FROM job_statuses s WHERE s.tenant_id = ? ORDER BY s.sort_order, s.id`, [t]));
  });

  r.put('/job-statuses/:id', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const cur = await getStatus(t, intId(req.params.id));
    const b = req.body;
    const next = {
      name: b.name === undefined ? cur.name : requireStr(b.name, 'ชื่อสถานะ'),
      description: b.description === undefined ? cur.description : str(b.description),
      color: color(b.color, cur.color),
      kind: oneOf(b.kind, KIND_KEYS, 'ประเภทสถานะ', cur.kind),
      active: b.active === undefined ? cur.active : Boolean(b.active),
    };
    await ensureUniqueName(t, next.name, cur.id);
    // ต้องเหลือสถานะ "ระหว่างดำเนินการ" ที่เปิดใช้งานอย่างน้อย 1 สถานะ (ใช้เป็นสถานะเริ่มต้นของงานใหม่)
    if (cur.kind === 'open' && cur.active && (next.kind !== 'open' || !next.active)) {
      const { n } = await db.one("SELECT COUNT(*) n FROM job_statuses WHERE tenant_id = ? AND kind = 'open' AND active AND id != ?", [t, cur.id]);
      if (!n) throw new HttpError(400, 'ต้องมีสถานะประเภท "ระหว่างดำเนินการ" ที่เปิดใช้งานอย่างน้อย 1 สถานะ');
    }
    await db.run('UPDATE job_statuses SET name = ?, description = ?, color = ?, kind = ?, active = ? WHERE id = ?', [
      next.name, next.description, next.color, next.kind, next.active, cur.id,
    ]);
    res.json(await getStatus(t, cur.id));
  });

  // ลบได้เฉพาะสถานะที่ไม่เคยถูกใช้ (ทั้งงานปัจจุบันและประวัติ) ไม่เช่นนั้นให้ปิดใช้งาน
  r.delete('/job-statuses/:id', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const s = await getStatus(t, intId(req.params.id));
    const used = s.job_count > 0 || (await db.one('SELECT 1 FROM job_status_logs WHERE from_status_id = ? OR to_status_id = ? LIMIT 1', [s.id, s.id]));
    if (used) throw new HttpError(409, 'สถานะนี้มีงานใช้อยู่หรือมีในประวัติงาน ลบไม่ได้ — ให้ปิดใช้งานแทน');
    if (s.kind === 'open' && s.active) {
      const { n } = await db.one("SELECT COUNT(*) n FROM job_statuses WHERE tenant_id = ? AND kind = 'open' AND active AND id != ?", [t, s.id]);
      if (!n) throw new HttpError(400, 'ต้องมีสถานะประเภท "ระหว่างดำเนินการ" ที่เปิดใช้งานอย่างน้อย 1 สถานะ');
    }
    await db.run('DELETE FROM job_statuses WHERE id = ?', [s.id]);
    res.json({ ok: true });
  });

  return r;
};
