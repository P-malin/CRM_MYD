const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, intId } = require('../util');

const COLS = `jt.id, jt.name, jt.description, jt.requires_detail, jt.sort_order, jt.active,
  (SELECT COUNT(*) FROM jobs j WHERE j.job_type_id = jt.id) AS job_count`;

module.exports = function jobTypeRoutes(db) {
  const r = express.Router();
  const admin = requireRole('owner', 'admin');

  const getType = async (tenantId, id) => {
    const t = await db.one(`SELECT ${COLS} FROM job_types jt WHERE jt.id = ? AND jt.tenant_id = ?`, [id, tenantId]);
    if (!t) throw new HttpError(404, 'ไม่พบประเภทงาน');
    return t;
  };
  const ensureUniqueName = async (tenantId, name, exceptId = 0) => {
    if (await db.one('SELECT 1 FROM job_types WHERE tenant_id = ? AND lower(name) = lower(?) AND id != ?', [tenantId, name, exceptId])) {
      throw new HttpError(409, `มีประเภทงาน "${name}" อยู่แล้ว`);
    }
  };

  // ?all=1 รวมประเภทที่ปิดใช้งาน (หน้าตั้งค่า)
  r.get('/job-types', async (req, res) => {
    const where = req.query.all === '1' ? '' : 'AND jt.active';
    res.json(await db.query(`SELECT ${COLS} FROM job_types jt WHERE jt.tenant_id = ? ${where} ORDER BY jt.sort_order, jt.id`, [req.user.tenant_id]));
  });

  r.post('/job-types', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const name = requireStr(req.body.name, 'ชื่อประเภทงาน');
    await ensureUniqueName(t, name);
    const { id } = await db.one(
      `INSERT INTO job_types (tenant_id, name, description, requires_detail, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM job_types WHERE tenant_id = ?)) RETURNING id`,
      [t, name, str(req.body.description), Boolean(req.body.requires_detail), t],
    );
    res.status(201).json(await getType(t, id));
  });

  r.put('/job-types/:id', admin, async (req, res) => {
    const t = req.user.tenant_id;
    const cur = await getType(t, intId(req.params.id));
    const b = req.body;
    const name = b.name === undefined ? cur.name : requireStr(b.name, 'ชื่อประเภทงาน');
    await ensureUniqueName(t, name, cur.id);
    await db.tx(async (tx) => {
      await tx.run('UPDATE job_types SET name = ?, description = ?, requires_detail = ?, active = ? WHERE id = ?', [
        name,
        b.description === undefined ? cur.description : str(b.description),
        b.requires_detail === undefined ? cur.requires_detail : Boolean(b.requires_detail),
        b.active === undefined ? cur.active : Boolean(b.active),
        cur.id,
      ]);
      // เปลี่ยนชื่อแล้วให้งานเดิมแสดงชื่อใหม่ และรายงานรวมยอดถูกกลุ่ม
      if (name !== cur.name) await tx.run('UPDATE jobs SET sign_type = ? WHERE job_type_id = ?', [name, cur.id]);
    });
    res.json(await getType(t, cur.id));
  });

  // ลบได้เฉพาะประเภทที่ยังไม่มีงานใช้ ถ้ามีงานแล้วให้ปิดใช้งานแทน
  r.delete('/job-types/:id', admin, async (req, res) => {
    const type = await getType(req.user.tenant_id, intId(req.params.id));
    if (type.job_count > 0) throw new HttpError(409, `มีงาน ${type.job_count} งานใช้ประเภทนี้อยู่ ลบไม่ได้ — ให้ปิดใช้งานแทน`);
    await db.run('DELETE FROM job_types WHERE id = ?', [type.id]);
    res.json({ ok: true });
  });

  return r;
};
