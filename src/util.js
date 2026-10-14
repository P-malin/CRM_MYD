class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

function requireStr(v, field) {
  const s = str(v);
  if (!s) throw new HttpError(400, `กรุณากรอก ${field}`);
  return s;
}

function num(v, field, { min = -Infinity, def = null } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return n;
}

function oneOf(v, keys, field, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!keys.includes(v)) throw new HttpError(400, `${field} ไม่ถูกต้อง`);
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function date(v, field) {
  const s = str(v);
  if (s === null) return null;
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${field} ต้องเป็นวันที่รูปแบบ YYYY-MM-DD`);
  return s;
}

function intId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'ไม่พบข้อมูล');
  return n;
}

// วันที่ปัจจุบันตามเวลาไทย (YYYY-MM-DD)
function today() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function pagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

module.exports = { HttpError, str, requireStr, num, oneOf, date, intId, today, pagination };
