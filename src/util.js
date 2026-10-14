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

// ลิงก์ตำแหน่งหน้างาน: รับเฉพาะลิงก์ Google Maps หรือพิกัด "lat, lng" (แปลงเป็นลิงก์ให้)
const MAPS_ERROR = 'ลิงก์ Google Maps ไม่ถูกต้อง — วางลิงก์จากปุ่ม "แชร์" ใน Google Maps หรือพิกัด เช่น 13.7563, 100.5018';
function mapsUrl(v) {
  const s = str(v);
  if (s === null) return null;
  const coords = s.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coords) {
    const [lat, lng] = [Number(coords[1]), Number(coords[2])];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, MAPS_ERROR);
    return `https://www.google.com/maps?q=${lat},${lng}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(400, MAPS_ERROR);
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const isMaps =
    host === 'maps.app.goo.gl' ||
    (host === 'goo.gl' && path.startsWith('/maps')) ||
    /^maps\.google\.[a-z.]+$/.test(host) ||
    (/^(www\.)?google\.[a-z.]+$/.test(host) && path.startsWith('/maps'));
  if (!['https:', 'http:'].includes(url.protocol) || !isMaps || s.length > 2000) throw new HttpError(400, MAPS_ERROR);
  url.protocol = 'https:';
  return url.href;
}

// URL ของแอป (ใช้สร้างลิงก์ในข้อความแจ้งเตือน / webhook) — ตั้ง APP_URL เพื่อกำหนดเองได้
function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
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

module.exports = { HttpError, str, requireStr, num, oneOf, date, mapsUrl, appUrl, intId, today, pagination };
