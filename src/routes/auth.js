const express = require('express');
const { transaction } = require('../db');
const { hashPassword, verifyPassword, createSession, destroySession, requireAuth, requireRole } = require('../auth');
const { HttpError, str, requireStr } = require('../util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
}

module.exports = function authRoutes(db) {
  const r = express.Router();
  const auth = requireAuth(db);

  // สมัครใช้งาน = สร้างร้านใหม่ (tenant) + ผู้ใช้เจ้าของร้าน
  r.post('/auth/register', (req, res) => {
    const shopName = requireStr(req.body.shop_name, 'ชื่อร้าน');
    const name = requireStr(req.body.name, 'ชื่อผู้ใช้');
    const email = requireStr(req.body.email, 'อีเมล').toLowerCase();
    const { password } = req.body;
    validateCredentials(email, password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้แล้ว');

    const userId = transaction(db, () => {
      const t = db.prepare('INSERT INTO tenants (name, phone) VALUES (?, ?)').run(shopName, str(req.body.phone));
      const u = db
        .prepare("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')")
        .run(t.lastInsertRowid, name, email, hashPassword(password));
      return u.lastInsertRowid;
    });
    res.status(201).json({ token: createSession(db, userId) });
  });

  r.post('/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = db.prepare('SELECT id, password_hash, active FROM users WHERE email = ?').get(email);
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    res.json({ token: createSession(db, user.id) });
  });

  r.post('/auth/logout', auth, (req, res) => {
    destroySession(db, req.token);
    res.json({ ok: true });
  });

  r.get('/auth/me', auth, (req, res) => {
    const tenant = db.prepare('SELECT id, name, phone, email, address, tax_id FROM tenants WHERE id = ?').get(req.user.tenant_id);
    res.json({ user: req.user, tenant });
  });

  r.put('/auth/password', auth, (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.current_password || ''), row.password_hash)) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    validateCredentials(req.user.email, req.body.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.new_password), req.user.id);
    res.json({ ok: true });
  });

  // ข้อมูลร้าน
  r.put('/tenant', auth, requireRole('owner', 'admin'), (req, res) => {
    const b = req.body;
    db.prepare('UPDATE tenants SET name = ?, phone = ?, email = ?, address = ?, tax_id = ? WHERE id = ?').run(
      requireStr(b.name, 'ชื่อร้าน'), str(b.phone), str(b.email), str(b.address), str(b.tax_id), req.user.tenant_id,
    );
    res.json(db.prepare('SELECT id, name, phone, email, address, tax_id FROM tenants WHERE id = ?').get(req.user.tenant_id));
  });

  return r;
};

module.exports.validateCredentials = validateCredentials;
