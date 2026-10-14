const crypto = require('node:crypto');
const { HttpError } = require('./util');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return token;
}

function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// ตรวจ token และผูก req.user (รวม tenant_id) — ทุก query ข้อมูลร้านต้องกรองด้วย req.user.tenant_id
function requireAuth(db) {
  const stmt = db.prepare(`
    SELECT u.id, u.tenant_id, u.name, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, res, next) => {
    const token = bearer(req);
    const user = token && stmt.get(sha256(token), new Date().toISOString());
    if (!user) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ'));
    req.user = { ...user };
    req.token = token;
    next();
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'ไม่มีสิทธิ์ทำรายการนี้'));
    next();
  };
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, requireAuth, requireRole };
