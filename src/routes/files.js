const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { HttpError, oneOf, intId } = require('../util');
const { FILE_CATEGORIES, FILE_EXTENSIONS, MAX_FILE_MB } = require('../constants');
const storage = require('../storage');

const CATEGORY_KEYS = FILE_CATEGORIES.map((c) => c.key);
const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_FILES_PER_JOB = 200;
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
// ชื่อไฟล์สำหรับแสดง/ดาวน์โหลด: ตัดตัวอักษรที่อาจเป็นปัญหา
const cleanName = (name) => String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f"<>|*?:]/g, '_').trim().slice(-120) || 'file';

function getDriver() {
  const d = storage.driver();
  if (!d) throw new HttpError(503, 'ยังไม่ได้ตั้งค่าที่เก็บไฟล์ (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — กรุณาติดต่อผู้ดูแลระบบ');
  return d;
}
const storageError = (err) => (err instanceof storage.StorageError ? new HttpError(502, err.message) : err);

// อัปโหลด/ดาวน์โหลดไฟล์ในโหมดดิสก์ในเครื่อง — URL มีลายเซ็นในตัว จึงไม่ต้องล็อกอิน
function localFileRoutes() {
  const r = express.Router();
  const local = storage.localDriver;
  r.put('/files/local/:token', (req, res, next) => {
    const t = local.verifyLocal(req.params.token);
    if (!t || t.op !== 'put') return next(new HttpError(403, 'ลิงก์อัปโหลดไม่ถูกต้องหรือหมดอายุ'));
    const tooBig = new HttpError(413, 'ไฟล์ใหญ่กว่าขนาดที่แจ้งไว้');
    if (Number(req.get('content-length')) > t.max) {
      req.resume(); // อ่านทิ้งให้หมดก่อนตอบ ไม่ตัดการเชื่อมต่อ
      return req.on('end', () => next(tooBig));
    }
    const file = local.localFile(t.p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = fs.createWriteStream(file);
    let bytes = 0;
    let over = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > t.max && !over) {
        over = true;
        req.unpipe(out);
        out.destroy();
        fs.rmSync(file, { force: true });
        req.resume();
      }
    });
    req.on('end', () => over && next(tooBig));
    req.pipe(out);
    out.on('finish', () => !over && res.json({ ok: true }));
    out.on('error', (err) => !over && next(err));
  });
  r.get('/files/local/:token', (req, res, next) => {
    const t = local.verifyLocal(req.params.token);
    if (!t || t.op !== 'get') return next(new HttpError(403, 'ลิงก์ไม่ถูกต้องหรือหมดอายุ'));
    const file = local.localFile(t.p);
    if (!fs.existsSync(file)) return next(new HttpError(404, 'ไม่พบไฟล์'));
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', t.ct || 'application/octet-stream');
    // ไฟล์ที่ไม่ใช่รูปภาพ (รวม SVG) ให้ดาวน์โหลด ไม่เปิดในเบราว์เซอร์
    const isImage = IMAGE_EXT.includes(extOf(t.p));
    if (t.d || !isImage) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.d || path.basename(file))}`);
    fs.createReadStream(file).pipe(res);
  });
  return r;
}

function fileRoutes(db) {
  const r = express.Router();

  const getJob = async (tenantId, id) => {
    const j = await db.one('SELECT id FROM jobs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!j) throw new HttpError(404, 'ไม่พบงาน');
    return j;
  };
  const getFile = async (tenantId, id) => {
    const f = await db.one('SELECT * FROM job_files WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!f) throw new HttpError(404, 'ไม่พบไฟล์');
    return f;
  };

  // ขอ URL สำหรับอัปโหลด (ไฟล์ส่งตรงจากเบราว์เซอร์ไปที่เก็บไฟล์)
  r.post('/jobs/:id/files', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const category = oneOf(req.body.category, CATEGORY_KEYS, 'หมวดไฟล์', null);
    if (!category) throw new HttpError(400, 'กรุณาเลือกหมวดไฟล์');
    const filename = cleanName(req.body.filename || '');
    const ext = extOf(filename);
    if (!FILE_EXTENSIONS.includes(ext)) throw new HttpError(400, `ไม่รองรับไฟล์ .${ext || '?'} — รองรับ ${FILE_EXTENSIONS.join(', ')}`);
    const size = Number(req.body.size);
    if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'ขนาดไฟล์ไม่ถูกต้อง');
    if (size > MAX_BYTES) throw new HttpError(400, `ไฟล์ใหญ่เกิน ${MAX_FILE_MB} MB`);
    const { n } = await db.one('SELECT COUNT(*) n FROM job_files WHERE job_id = ?', [job.id]);
    if (n >= MAX_FILES_PER_JOB) throw new HttpError(400, `แนบไฟล์ได้ไม่เกิน ${MAX_FILES_PER_JOB} ไฟล์ต่องาน`);

    const d = getDriver();
    const storagePath = `${t}/${job.id}/${crypto.randomUUID()}.${ext}`;
    const contentType = String(req.body.content_type || '').slice(0, 100) || 'application/octet-stream';
    const upload = await d.uploadUrl(storagePath, { maxBytes: size }).catch((err) => {
      throw storageError(err);
    });
    const file = await db.one(
      `INSERT INTO job_files (tenant_id, job_id, category, filename, content_type, size, storage_path, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, category, filename, size, status`,
      [t, job.id, category, filename, contentType, size, storagePath, req.user.id],
    );
    res.status(201).json({ file, upload: { ...upload, headers: { 'content-type': contentType } } });
  });

  // ยืนยันว่าอัปโหลดเสร็จ (ตรวจว่ามีไฟล์จริงในที่เก็บ)
  r.post('/files/:id/complete', async (req, res) => {
    const f = await getFile(req.user.tenant_id, intId(req.params.id));
    if (f.status !== 'ready') {
      const ok = await getDriver().exists(f.storage_path).catch((err) => {
        throw storageError(err);
      });
      if (!ok) throw new HttpError(400, 'ยังไม่พบไฟล์ในที่เก็บ — อัปโหลดไม่สำเร็จ กรุณาลองใหม่');
      await db.run("UPDATE job_files SET status = 'ready' WHERE id = ?", [f.id]);
    }
    res.json({ ok: true });
  });

  // รายการไฟล์ของงาน พร้อมลิงก์ดู/ดาวน์โหลดชั่วคราว (1 ชม.)
  r.get('/jobs/:id/files', async (req, res) => {
    const t = req.user.tenant_id;
    const job = await getJob(t, intId(req.params.id));
    const rows = await db.query(
      `SELECT f.id, f.category, f.filename, f.content_type, f.size, f.storage_path, f.uploaded_by, f.created_at, u.name AS uploaded_by_name
       FROM job_files f LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.job_id = ? AND f.tenant_id = ? AND f.status = 'ready' ORDER BY f.id`,
      [job.id, t],
    );
    const links = rows.length
      ? await getDriver()
          .links(rows.map((f) => ({ path: f.storage_path, filename: f.filename, contentType: f.content_type })))
          .catch((err) => {
            throw storageError(err);
          })
      : [];
    res.json(
      rows.map(({ storage_path: _p, ...f }, i) => {
        const isImage = IMAGE_EXT.includes(extOf(f.filename));
        return { ...f, is_image: isImage, url: isImage ? links[i].view : null, download_url: links[i].download };
      }),
    );
  });

  // ลบไฟล์: คนที่อัปโหลด หรือเจ้าของร้าน/ผู้ดูแล
  r.delete('/files/:id', async (req, res) => {
    const f = await getFile(req.user.tenant_id, intId(req.params.id));
    if (f.uploaded_by !== req.user.id && !['owner', 'admin'].includes(req.user.role)) throw new HttpError(403, 'ลบได้เฉพาะไฟล์ที่ตัวเองอัปโหลด');
    await getDriver()
      .remove([f.storage_path])
      .catch((err) => {
        throw storageError(err);
      });
    await db.run('DELETE FROM job_files WHERE id = ?', [f.id]);
    res.json({ ok: true });
  });

  return r;
}

// ลบไฟล์ในที่เก็บของงาน (ใช้ตอนลบงาน) — ล้มเหลวไม่เป็นไร
async function removeJobFiles(db, jobId) {
  const rows = await db.query('SELECT storage_path FROM job_files WHERE job_id = ?', [jobId]);
  const d = storage.driver();
  if (d && rows.length) await d.remove(rows.map((r) => r.storage_path)).catch((err) => console.error('ลบไฟล์ของงานไม่สำเร็จ:', err.message));
}

module.exports = { fileRoutes, localFileRoutes, removeJobFiles };
