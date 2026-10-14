const express = require('express');
const { hashPassword } = require('../auth');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, oneOf, intId } = require('../util');
const { ROLES } = require('../constants');
const { validateCredentials } = require('./auth');

const ROLE_KEYS = ROLES.map((r) => r.key);
const COLS = 'id, name, email, role, active, created_at';

module.exports = function userRoutes(db) {
  const r = express.Router();
  const admin = requireRole('owner', 'admin');

  // ทุกคนดูรายชื่อพนักงานได้ (ใช้มอบหมายงาน)
  r.get('/users', (req, res) => {
    res.json(db.prepare(`SELECT ${COLS} FROM users WHERE tenant_id = ? ORDER BY active DESC, name`).all(req.user.tenant_id));
  });

  r.post('/users', admin, (req, res) => {
    const b = req.body;
    const email = requireStr(b.email, 'อีเมล').toLowerCase();
    validateCredentials(email, b.password);
    const role = oneOf(b.role, ROLE_KEYS, 'สิทธิ์', 'staff');
    if (role === 'owner' && req.user.role !== 'owner') throw new HttpError(403, 'เฉพาะเจ้าของร้านเท่านั้นที่เพิ่มเจ้าของร้านได้');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้แล้ว');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.tenant_id, requireStr(b.name, 'ชื่อ'), email, hashPassword(b.password), role);
    res.status(201).json(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(lastInsertRowid));
  });

  r.put('/users/:id', admin, (req, res) => {
    const id = intId(req.params.id);
    const target = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(id, req.user.tenant_id);
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const b = req.body;
    const role = oneOf(b.role, ROLE_KEYS, 'สิทธิ์', target.role);
    const active = b.active === undefined ? target.active : b.active ? 1 : 0;
    if ((target.role === 'owner' || role === 'owner') && req.user.role !== 'owner') {
      throw new HttpError(403, 'เฉพาะเจ้าของร้านเท่านั้นที่แก้ไขสิทธิ์เจ้าของร้านได้');
    }
    if (id === req.user.id && (!active || role !== target.role)) throw new HttpError(400, 'ไม่สามารถปิดใช้งานหรือเปลี่ยนสิทธิ์ของตัวเองได้');
    db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(str(b.name) || target.name, role, active, id);
    if (b.password) {
      validateCredentials(target.email, b.password);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
    }
    if (!active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    res.json(db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id));
  });

  return r;
};
