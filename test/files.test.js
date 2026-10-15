const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

// เซิร์ฟเวอร์จำลอง Supabase Storage
const fake = { objects: new Map(), calls: [], buckets: new Set() };
const sbServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const raw = Buffer.concat(chunks);
    const body = req.headers['content-type'] === 'application/json' && raw.length ? JSON.parse(raw) : null;
    fake.calls.push(`${req.method} ${url.pathname}`);
    const send = (st, d) => res.writeHead(st, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    const p = url.pathname.replace('/storage/v1', '');
    const signed = p.startsWith('/object/upload/sign/') || (p.startsWith('/object/sign/') && req.method === 'GET');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!signed && req.headers.apikey !== key) return send(401, { message: 'unauthorized' });
    if (!signed && key.startsWith('sb_') ? 'authorization' in req.headers : !signed && req.headers.authorization !== `Bearer ${key}`) return send(401, { message: 'bad auth header' });
    let m;
    if (req.method === 'POST' && p === '/bucket') {
      if (fake.buckets.has(body.id)) return send(409, { message: 'The resource already exists' });
      fake.buckets.add(body.id);
      return send(200, { name: body.id });
    }
    if (req.method === 'POST' && (m = p.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/))) {
      return send(200, { url: `/object/upload/sign/${m[1]}/${m[2]}?token=up-${m[2]}` });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/))) {
      if (url.searchParams.get('token') !== `up-${m[2]}`) return send(400, { message: 'bad token' });
      fake.objects.set(decodeURIComponent(m[2]), { data: raw, type: req.headers['content-type'] });
      return send(200, { Key: m[2] });
    }
    if (req.method === 'POST' && (m = p.match(/^\/object\/list\/([^/]+)$/))) {
      const names = [...fake.objects.keys()].filter((k) => k.startsWith(`${body.prefix}/`)).map((k) => k.slice(body.prefix.length + 1));
      return send(200, names.filter((n) => n.includes(body.search || '')).map((name) => ({ name })));
    }
    if (req.method === 'POST' && (m = p.match(/^\/object\/sign\/([^/]+)$/))) {
      return send(200, body.paths.map((x) => ({ path: x, signedURL: `/object/sign/${m[1]}/${x}?token=dl` })));
    }
    if (req.method === 'GET' && (m = p.match(/^\/object\/sign\/([^/]+)\/(.+)$/))) {
      const o = fake.objects.get(decodeURIComponent(m[2]));
      return o ? res.writeHead(200, { 'content-type': o.type }).end(o.data) : send(404, { message: 'not found' });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/object\/([^/]+)$/))) {
      for (const k of body.prefixes) fake.objects.delete(k);
      return send(200, []);
    }
    send(404, { message: `no route ${req.method} ${p}` });
  });
});

let server;
let base;
let db;
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myd-files-'));
test.before(async () => {
  process.env.FILES_DIR = filesDir;
  await new Promise((r) => sbServer.listen(0, r));
  db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
  await new Promise((r) => {
    server = createApp(db).listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  sbServer.close();
  await db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const register = async (shop, email) =>
  (await call('POST', '/api/auth/register', { body: { shop_name: shop, name: 'เจ้าของ', email, password: 'password123' } })).data.token;
async function makeJob(token) {
  const c = (await call('POST', '/api/customers', { token, body: { name: 'ลูกค้า' } })).data;
  const typeId = (await call('GET', '/api/job-types', { token })).data[0].id;
  return (await call('POST', '/api/jobs', { token, body: { customer_id: c.id, title: 'ป้าย', job_type_id: typeId, delivery_method: 'customer_pickup' } })).data;
}
// อัปโหลดแบบที่เบราว์เซอร์ทำ: ขอ URL → PUT ไฟล์ → ยืนยัน
async function upload(token, jobId, { name, type, data, category = 'design' }) {
  const r = await call('POST', `/api/jobs/${jobId}/files`, { token, body: { category, filename: name, content_type: type, size: data.length } });
  if (r.status !== 201) return r;
  const u = r.data.upload;
  const put = await fetch(u.url.startsWith('http') ? u.url : base + u.url, { method: u.method, headers: u.headers, body: data });
  const done = await call('POST', `/api/files/${r.data.file.id}/complete`, { token });
  return { status: done.status, put: put.status, file: r.data.file, data: done.data };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('แนบไฟล์ — เก็บบนดิสก์ในเครื่อง', async () => {
  delete process.env.SUPABASE_URL;
  const owner = await register('ร้านไฟล์', 'files@shop.test');
  const other = await register('ร้านอื่น', 'files-other@shop.test');
  const job = await makeJob(owner);

  // ตรวจชนิด/ขนาด/หมวด
  const ask = (body) => call('POST', `/api/jobs/${job.id}/files`, { token: owner, body: { category: 'design', filename: 'a.pdf', size: 10, ...body } });
  assert.equal((await ask({ filename: 'virus.exe' })).status, 400);
  assert.equal((await ask({ filename: 'page.html' })).status, 400);
  assert.equal((await ask({ size: 21 * 1024 * 1024 })).status, 400);
  assert.equal((await ask({ size: 0 })).status, 400);
  assert.equal((await ask({ category: 'secret' })).status, 400);

  // อัปโหลดรูป + ไฟล์แบบ
  const img = await upload(owner, job.id, { name: 'หน้างาน.png', type: 'image/png', data: PNG, category: 'before' });
  assert.equal(img.put, 200);
  assert.equal(img.status, 200);
  const pdf = await upload(owner, job.id, { name: 'แบบป้าย v2.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 test'), category: 'design' });
  assert.equal(pdf.status, 200);
  const svg = await upload(owner, job.id, { name: 'logo.svg', type: 'image/svg+xml', data: Buffer.from('<svg onload="alert(1)"/>') });
  assert.equal(svg.status, 200);

  const list = (await call('GET', `/api/jobs/${job.id}/files`, { token: owner })).data;
  assert.equal(list.length, 3);
  const pic = list.find((f) => f.filename === 'หน้างาน.png');
  assert.equal(pic.category, 'before');
  assert.equal(pic.is_image, true);
  assert.ok(!('storage_path' in pic));
  // ดูรูปได้ตรงไบต์, ดาวน์โหลดได้ชื่อไฟล์เดิม
  const view = await fetch(base + pic.url);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await view.arrayBuffer()), PNG);
  const dl = await fetch(base + pic.download_url);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename\*=UTF-8''%E0%B8%AB/);
  // SVG / ไฟล์ที่ไม่ใช่รูป: ไม่มีลิงก์แสดงในหน้า และบังคับดาวน์โหลด
  const s = list.find((f) => f.filename === 'logo.svg');
  assert.equal(s.url, null);
  assert.match((await fetch(base + s.download_url)).headers.get('content-disposition'), /attachment/);

  // ลิงก์ปลอม/แก้ไข → 403; อัปโหลดเกินขนาดที่ขอ → 413
  assert.equal((await fetch(`${base + pic.url}x`)).status, 403);
  const big = await call('POST', `/api/jobs/${job.id}/files`, { token: owner, body: { category: 'other', filename: 'b.zip', size: 4 } });
  assert.equal((await fetch(base + big.data.upload.url, { method: 'PUT', body: Buffer.alloc(100) })).status, 413);
  // ยืนยันทั้งที่ยังไม่ได้อัปโหลด → 400 และไม่แสดงในรายการ
  const ghost = await call('POST', `/api/jobs/${job.id}/files`, { token: owner, body: { category: 'other', filename: 'c.zip', size: 4 } });
  assert.equal((await call('POST', `/api/files/${ghost.data.file.id}/complete`, { token: owner })).status, 400);
  assert.equal((await call('GET', `/api/jobs/${job.id}/files`, { token: owner })).data.length, 3);

  // ร้านอื่นเข้าถึงไม่ได้
  assert.equal((await call('GET', `/api/jobs/${job.id}/files`, { token: other })).status, 404);
  assert.equal((await call('POST', `/api/jobs/${job.id}/files`, { token: other, body: { category: 'design', filename: 'x.pdf', size: 1 } })).status, 404);
  assert.equal((await call('DELETE', `/api/files/${pic.id}`, { token: other })).status, 404);

  // พนักงานลบไฟล์คนอื่นไม่ได้ แต่ลบไฟล์ตัวเองได้
  await call('POST', '/api/users', { token: owner, body: { name: 'ช่าง', email: 'files-staff@shop.test', password: 'password123' } });
  const staff = (await call('POST', '/api/auth/login', { body: { email: 'files-staff@shop.test', password: 'password123' } })).data.token;
  assert.equal((await call('DELETE', `/api/files/${pic.id}`, { token: staff })).status, 403);
  const mine = await upload(staff, job.id, { name: 'after.jpg', type: 'image/jpeg', data: PNG, category: 'after' });
  assert.equal((await call('DELETE', `/api/files/${mine.file.id}`, { token: staff })).status, 200);

  // เจ้าของลบได้ และไฟล์หายจากดิสก์
  const countFiles = () => fs.readdirSync(filesDir, { recursive: true }).filter((f) => fs.statSync(path.join(filesDir, f)).isFile()).length;
  const before = countFiles();
  assert.equal((await call('DELETE', `/api/files/${pdf.file.id}`, { token: owner })).status, 200);
  assert.equal(countFiles(), before - 1);
  // ลบงาน → ไฟล์ของงานถูกลบจากดิสก์ด้วย
  assert.equal((await call('DELETE', `/api/jobs/${job.id}`, { token: owner })).status, 200);
  assert.equal(countFiles(), 0);
});

test('แนบไฟล์ — Supabase Storage', async () => {
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  try {
    const owner = await register('ร้าน Supabase', 'files-sb@shop.test');
    const job = await makeJob(owner);
    const img = await upload(owner, job.id, { name: 'site.png', type: 'image/png', data: PNG, category: 'before' });
    assert.equal(img.put, 200);
    assert.equal(img.status, 200);
    assert.ok(fake.calls.includes('POST /storage/v1/bucket'));
    const key = [...fake.objects.keys()][0];
    assert.match(key, new RegExp(`^\\d+/${job.id}/[0-9a-f-]{36}\\.png$`));
    assert.equal(fake.objects.get(key).type, 'image/png');

    const list = (await call('GET', `/api/jobs/${job.id}/files`, { token: owner })).data;
    assert.equal(list.length, 1);
    assert.ok(list[0].url.startsWith(process.env.SUPABASE_URL));
    assert.match(list[0].download_url, /&download=site\.png$/);
    assert.deepEqual(Buffer.from(await (await fetch(list[0].url)).arrayBuffer()), PNG);
    // ลงชื่อลิงก์ทุกไฟล์ในคำขอเดียว
    assert.equal(fake.calls.filter((c) => c === `POST /storage/v1/object/sign/job-files`).length, 1);

    // อัปโหลดเพิ่ม: bucket มีแล้วไม่สร้างซ้ำ
    await upload(owner, job.id, { name: 'b.pdf', type: 'application/pdf', data: Buffer.from('%PDF') });
    assert.equal(fake.objects.size, 2);
    assert.equal((await call('DELETE', `/api/files/${img.file.id}`, { token: owner })).status, 200);
    assert.equal(fake.objects.size, 1);
    await call('DELETE', `/api/jobs/${job.id}`, { token: owner });
    assert.equal(fake.objects.size, 0);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('แนบไฟล์ — Supabase คีย์แบบใหม่ (sb_secret_)', async () => {
  process.env.SUPABASE_URL = `http://127.0.0.1:${sbServer.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_abc123';
  try {
    const owner = await register('ร้านคีย์ใหม่', 'files-newkey@shop.test');
    const job = await makeJob(owner);
    const r = await upload(owner, job.id, { name: 'x.png', type: 'image/png', data: PNG });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', `/api/jobs/${job.id}/files`, { token: owner })).data.length, 1);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('แนบไฟล์ — บน Vercel ต้องตั้งค่า Supabase', async () => {
  process.env.VERCEL = '1';
  try {
    const owner = await register('ร้าน Vercel', 'files-vercel@shop.test');
    const job = await makeJob(owner);
    const r = await call('POST', `/api/jobs/${job.id}/files`, { token: owner, body: { category: 'design', filename: 'a.pdf', size: 10 } });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /SUPABASE_URL/);
  } finally {
    delete process.env.VERCEL;
  }
});
