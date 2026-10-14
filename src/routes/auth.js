const crypto = require('node:crypto');
const express = require('express');
const mail = require('../mail');
const { hashPassword, verifyPassword, createSession, destroySession, requireAuth, requireRole, sha256 } = require('../auth');
const { HttpError, str, requireStr, num, appUrl } = require('../util');
const { DEFAULT_JOB_TYPES_VALUES, DEFAULT_JOB_STATUSES_VALUES } = require('../schema');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_COLS = 'id, name, phone, email, address, tax_id, quote_terms, quote_validity_days, quote_vat, vat_registered, branch_name';

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resetEmailHtml(user, link) {
  return `<div style="font-family:Tahoma,'Leelawadee UI',sans-serif;max-width:480px;margin:auto;color:#1e293b">
  <h2 style="color:#4f46e5;margin:0 0 4px">MYD Easy</h2>
  <p>สวัสดีคุณ ${escHtml(user.name)}</p>
  <p>มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ (${escHtml(user.shop)})</p>
  <p style="margin:24px 0"><a href="${escHtml(link)}" style="background:#4f46e5;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">ตั้งรหัสผ่านใหม่</a></p>
  <p style="color:#64748b;font-size:13px">ลิงก์นี้ใช้ได้ภายใน 30 นาที และใช้ได้ครั้งเดียว<br>ถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ</p>
</div>`;
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
      await t.run(
        `INSERT INTO job_types (tenant_id, name, description, requires_detail, sort_order)
         SELECT ?, v.* FROM (VALUES ${DEFAULT_JOB_TYPES_VALUES}) AS v(name, description, requires_detail, sort_order)`,
        [tenant.id],
      );
      await t.run(
        `INSERT INTO job_statuses (tenant_id, name, description, color, kind, sort_order)
         SELECT ?, v.* FROM (VALUES ${DEFAULT_JOB_STATUSES_VALUES}) AS v(name, description, color, kind, sort_order)`,
        [tenant.id],
      );
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

  // ลืมรหัสผ่าน: ตอบเหมือนกันทุกกรณี เพื่อไม่บอกว่าอีเมลนี้มีบัญชีหรือไม่
  r.post('/auth/forgot', async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'อีเมลไม่ถูกต้อง');
    if (!mail.configured()) throw new HttpError(503, 'ระบบส่งอีเมลยังไม่ได้ตั้งค่า กรุณาติดต่อผู้ดูแลระบบ');
    const done = () => res.json({ ok: true, message: 'ถ้ามีบัญชีที่ใช้อีเมลนี้ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปแล้ว กรุณาตรวจกล่องจดหมาย (และโฟลเดอร์สแปม)' });

    const user = await db.one(
      'SELECT u.id, u.name, u.email, t.name AS shop FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = lower(?) AND u.active',
      [email],
    );
    if (!user) return done();
    // กันส่งรัว: ไม่เกิน 3 ลิงก์ต่อ 15 นาทีต่อบัญชี
    const { n } = await db.one("SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > now() - interval '15 minutes'", [user.id]);
    if (n >= 3) return done();

    const token = crypto.randomBytes(32).toString('base64url');
    await db.run("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, now() + interval '30 minutes')", [sha256(token), user.id]);
    const link = `${appUrl(req)}/#/reset?token=${token}`;
    try {
      await mail.sendMail({
        to: user.email,
        subject: 'ตั้งรหัสผ่านใหม่ — MYD Easy',
        text: `สวัสดีคุณ ${user.name}\n\nมีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชี MYD Easy (${user.shop})\nกดลิงก์นี้ภายใน 30 นาที:\n${link}\n\nถ้าคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้ตามปกติ`,
        html: resetEmailHtml(user, link),
      });
    } catch (err) {
      console.error('ส่งอีเมลรีเซ็ตรหัสผ่านไม่สำเร็จ:', err.message);
      throw new HttpError(502, 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    }
    if (!process.env.VERCEL && process.env.NODE_ENV !== 'production' && process.env.MAIL_CAPTURE !== '1') console.log('ลิงก์รีเซ็ตรหัสผ่าน:', link);
    done();
  });

  // ตั้งรหัสผ่านใหม่จากลิงก์ → ออกจากระบบทุกอุปกรณ์ แล้วเข้าสู่ระบบให้
  r.post('/auth/reset', async (req, res) => {
    const token = String(req.body.token || '');
    const row = token && (await db.one('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > now()', [sha256(token)]));
    if (!row) throw new HttpError(400, 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว — กรุณาขอลิงก์ใหม่');
    const user = await db.one('SELECT id, email, active FROM users WHERE id = ?', [row.user_id]);
    if (!user.active) throw new HttpError(400, 'บัญชีนี้ถูกปิดใช้งาน');
    validateCredentials(user.email, req.body.password);
    await db.tx(async (t) => {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), user.id]);
      await t.run('UPDATE password_resets SET used_at = now() WHERE user_id = ? AND used_at IS NULL', [user.id]);
      await t.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    });
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
      `UPDATE tenants SET name = ?, phone = ?, email = ?, address = ?, tax_id = ?, quote_terms = ?, quote_validity_days = ?, quote_vat = ?,
         vat_registered = ?, branch_name = ?
       WHERE id = ? RETURNING ${TENANT_COLS}`,
      [
        requireStr(b.name, 'ชื่อร้าน'), str(b.phone), str(b.email), str(b.address), str(b.tax_id), str(b.quote_terms),
        Math.min(Math.round(num(b.quote_validity_days, 'จำนวนวันยืนราคา', { min: 0, def: 30 })), 365), b.quote_vat === undefined ? true : Boolean(b.quote_vat),
        Boolean(b.vat_registered), str(b.branch_name),
        req.user.tenant_id,
      ],
    );
    res.json(tenant);
  });

  return r;
};

module.exports.validateCredentials = validateCredentials;
module.exports.emailTaken = emailTaken;
