const express = require('express');
const { hashPassword, verifyPassword, createSession, destroySession, requireAuth, requireRole } = require('../auth');
const { HttpError, str, requireStr } = require('../util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_COLS = 'id, name, phone, email, address, tax_id';

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
}

const emailTaken = async (db, email) => Boolean(await db.one('SELECT 1 FROM users WHERE lower(email) = lower(?)', [email]));

module.exports = function authRoutes(db) {
  const r = express.Router();
  const auth = requireAuth(db);

  // สมัครใช้งาน = สร้างร้านใหม่ (tenant) + ผู้ใช้เจ้าของร้าน
  r.post('/auth/register', async (req, res) => {
    const shopName = requireStr(req.body.shop_name, 'ชื่อร้าน');
    const name = requireStr(req.body.name, 'ชื่อผู้ใช้');
    const email = requireStr(req.body.email, 'อีเมล').toLowerCase();
    const { password } = req.body;
    validateCredentials(email, password);
    if (await emailTaken(db, email)) throw new HttpError(409, 'อีเมลนี้ถูกใช้แล้ว');

    const userId = await db.tx(async (t) => {
      const tenant = await t.one('INSERT INTO tenants (name, phone) VALUES (?, ?) RETURNING id', [shopName, str(req.body.phone)]);
      const user = await t.one(
        "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner') RETURNING id",
        [tenant.id, name, email, hashPassword(password)],
      );
      return user.id;
    });
    res.status(201).json({ token: await createSession(db, userId) });
  });

  r.post('/auth/login', async (req, res) => {
    const email = String(req.body.email || '').trim();
    const user = await db.one('SELECT id, password_hash, active FROM users WHERE lower(email) = lower(?)', [email]);
    if (!user || !user.active || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
      throw new HttpError(401, 'อีเมลหรือรหัสผ่านไม่ถูกต้อง');
    }
    res.json({ token: await createSession(db, user.id) });
  });

  r.post('/auth/logout', auth, async (req, res) => {
    await destroySession(db, req.token);
    res.json({ ok: true });
  });

  r.get('/auth/me', auth, async (req, res) => {
    const tenant = await db.one(`SELECT ${TENANT_COLS} FROM tenants WHERE id = ?`, [req.user.tenant_id]);
    res.json({ user: req.user, tenant });
  });

  r.put('/auth/password', auth, async (req, res) => {
    const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!verifyPassword(String(req.body.current_password || ''), row.password_hash)) throw new HttpError(400, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    validateCredentials(req.user.email, req.body.new_password);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.new_password), req.user.id]);
    res.json({ ok: true });
  });

  // ข้อมูลร้าน
  r.put('/tenant', auth, requireRole('owner', 'admin'), async (req, res) => {
    const b = req.body;
    const tenant = await db.one(
      `UPDATE tenants SET name = ?, phone = ?, email = ?, address = ?, tax_id = ? WHERE id = ? RETURNING ${TENANT_COLS}`,
      [requireStr(b.name, 'ชื่อร้าน'), str(b.phone), str(b.email), str(b.address), str(b.tax_id), req.user.tenant_id],
    );
    res.json(tenant);
  });

  return r;
};

module.exports.validateCredentials = validateCredentials;
module.exports.emailTaken = emailTaken;
