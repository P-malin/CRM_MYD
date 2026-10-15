// ที่เก็บไฟล์แนบ: Supabase Storage (production) หรือดิสก์ในเครื่อง (รันบนเครื่องตัวเอง/เทสต์)
// เบราว์เซอร์อัปโหลด/ดาวน์โหลดผ่าน URL ที่เซ็นชั่วคราว — ไฟล์ไม่วิ่งผ่าน serverless function
// env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORAGE_BUCKET (ค่าเริ่มต้น job-files), FILES_DIR (ดิสก์ในเครื่อง)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bucket = () => process.env.STORAGE_BUCKET || 'job-files';
const supabaseConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

class StorageError extends Error {}

// ---------- Supabase Storage ----------
const sbBase = () => `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1`;
let bucketReady = false;

async function sb(method, p, body) {
  let res;
  try {
    res = await fetch(`${sbBase()}${p}`, {
      method,
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        // คีย์แบบเก่า (service_role JWT) ส่งใน Authorization ด้วย; คีย์แบบใหม่ (sb_secret_...) ใช้ apikey อย่างเดียว
        ...(process.env.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_') ? {} : { authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }),
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new StorageError(`เชื่อมต่อที่เก็บไฟล์ไม่ได้ (${err.message})`);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // ignore
  }
  if (!res.ok) {
    const err = new StorageError(`ที่เก็บไฟล์ตอบกลับ ${res.status}: ${data.message || data.error || text}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function ensureBucket() {
  if (bucketReady) return;
  try {
    await sb('POST', '/bucket', { id: bucket(), name: bucket(), public: false });
  } catch (err) {
    // มีอยู่แล้ว = ใช้ได้
    if (!(err.status === 409 || err.status === 400 || /exist/i.test(err.message))) throw err;
  }
  bucketReady = true;
}

const supabaseDriver = {
  name: 'supabase',
  async uploadUrl(objectPath) {
    await ensureBucket();
    const d = await sb('POST', `/object/upload/sign/${bucket()}/${encPath(objectPath)}`, {});
    return { url: `${sbBase()}${d.url}`, method: 'PUT' };
  },
  // ลิงก์ดู/ดาวน์โหลดหลายไฟล์ในคำขอเดียว: files = [{ path, filename }] → [{ view, download }]
  async links(files, { expiresIn = 3600 } = {}) {
    if (!files.length) return [];
    const signed = await sb('POST', `/object/sign/${bucket()}`, { expiresIn, paths: files.map((f) => f.path) });
    const byPath = new Map(signed.map((s) => [s.path, s.signedURL || s.signedUrl]));
    return files.map((f) => {
      const u = byPath.get(f.path);
      if (!u) return { view: null, download: null };
      const view = `${sbBase()}${u}`;
      return { view, download: `${view}&download=${encodeURIComponent(f.filename)}` };
    });
  },
  async exists(objectPath) {
    const dir = objectPath.split('/').slice(0, -1).join('/');
    const name = objectPath.split('/').pop();
    const list = await sb('POST', `/object/list/${bucket()}`, { prefix: dir, search: name, limit: 5 });
    return Array.isArray(list) && list.some((o) => o.name === name);
  },
  async remove(paths) {
    if (!paths.length) return;
    await sb('DELETE', `/object/${bucket()}`, { prefixes: paths });
  },
};

// ---------- ดิสก์ในเครื่อง (อัปโหลด/ดาวน์โหลดผ่าน /api/files/local/:token) ----------
const localKey = crypto.createHash('sha256').update(process.env.APP_SECRET || crypto.randomBytes(32)).digest();
const filesDir = () => path.resolve(process.env.FILES_DIR || 'data/files');

function signLocal(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', localKey).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyLocal(token) {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', localKey).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() ? payload : null;
}
const localFile = (objectPath) => {
  const full = path.join(filesDir(), objectPath);
  if (!full.startsWith(filesDir() + path.sep)) throw new StorageError('path ไม่ถูกต้อง');
  return full;
};

const localDriver = {
  name: 'local',
  async uploadUrl(objectPath, { maxBytes }) {
    return { url: `/api/files/local/${signLocal({ op: 'put', p: objectPath, max: maxBytes, exp: Date.now() + 15 * 60_000 })}`, method: 'PUT' };
  },
  async links(files, { expiresIn = 3600 } = {}) {
    const exp = Date.now() + expiresIn * 1000;
    return files.map((f) => ({
      view: `/api/files/local/${signLocal({ op: 'get', p: f.path, ct: f.contentType, exp })}`,
      download: `/api/files/local/${signLocal({ op: 'get', p: f.path, d: f.filename, ct: f.contentType, exp })}`,
    }));
  },
  async exists(objectPath) {
    return fs.existsSync(localFile(objectPath));
  },
  async remove(paths) {
    for (const p of paths) fs.rmSync(localFile(p), { force: true });
  },
  verifyLocal,
  localFile,
};

// production บน Vercel ต้องใช้ Supabase (ดิสก์ของ serverless ไม่ถาวร)
function driver() {
  if (supabaseConfigured()) return supabaseDriver;
  if (process.env.VERCEL) return null;
  return localDriver;
}

module.exports = { driver, localDriver, StorageError };
