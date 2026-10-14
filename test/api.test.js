const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;
let db;

test.before(async () => {
  // ตั้ง TEST_DATABASE_URL เพื่อทดสอบกับ Postgres จริง (ต้องเป็นฐานข้อมูลว่าง)
  db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => {
  server.close();
  await db.close();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function register(shop, email) {
  const r = await call('POST', '/auth/register', { body: { shop_name: shop, name: 'เจ้าของ', email, password: 'password123' } });
  assert.equal(r.status, 201);
  return r.data.token;
}

test('ต้องเข้าสู่ระบบก่อนใช้งาน API', async () => {
  assert.equal((await call('GET', '/customers')).status, 401);
});

test('ขั้นตอนหลัก: ลูกค้า → รับงาน → สถานะ → ชำระเงิน → รายงาน', async () => {
  const token = await register('ร้านป้ายเอ', 'a@shop.test');

  const me = await call('GET', '/auth/me', { token });
  assert.equal(me.data.tenant.name, 'ร้านป้ายเอ');
  assert.equal(me.data.user.role, 'owner');

  const cust = await call('POST', '/customers', { token, body: { name: 'คุณสมชาย', phone: '0812345678' } });
  assert.equal(cust.status, 201);

  const job = await call('POST', '/jobs', {
    token,
    body: { customer_id: cust.data.id, title: 'ป้ายหน้าร้าน', sign_type: 'ป้ายไวนิล', width_cm: 300, height_cm: 100, price: 5000, deposit: 2000 },
  });
  assert.equal(job.status, 201);
  assert.match(job.data.job_no, /^J\d{4}-0001$/);
  assert.equal(job.data.status, 'new');
  assert.equal(job.data.paid, 2000);

  const st = await call('POST', `/jobs/${job.data.id}/status`, { token, body: { status: 'producing', note: 'ลูกค้าอนุมัติแบบแล้ว' } });
  assert.equal(st.data.status, 'producing');

  const pay = await call('POST', `/jobs/${job.data.id}/payments`, { token, body: { amount: 3000, kind: 'final', method: 'transfer' } });
  assert.equal(pay.data.paid, 5000);

  await call('POST', `/jobs/${job.data.id}/status`, { token, body: { status: 'completed' } });
  const detail = await call('GET', `/jobs/${job.data.id}`, { token });
  assert.equal(detail.data.logs.length, 3);
  assert.ok(detail.data.completed_at);

  const dash = await call('GET', '/reports/dashboard', { token });
  assert.equal(dash.data.status_counts.completed, 1);
  assert.equal(dash.data.month_sales, 5000);
  assert.equal(dash.data.outstanding, 0);

  const sum = await call('GET', '/reports/summary', { token });
  assert.equal(sum.data.totals.sales, 5000);
  assert.equal(sum.data.totals.collected, 5000);
  assert.equal(sum.data.by_sign_type[0].sign_type, 'ป้ายไวนิล');

  const csv = await call('GET', '/reports/jobs.csv', { token });
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes('ป้ายหน้าร้าน'));
});

test('ข้อมูลแต่ละร้านแยกจากกัน (tenant isolation)', async () => {
  const t1 = await register('ร้าน 1', 'one@shop.test');
  const t2 = await register('ร้าน 2', 'two@shop.test');
  const c1 = (await call('POST', '/customers', { token: t1, body: { name: 'ลูกค้าร้าน 1' } })).data;
  const j1 = (await call('POST', '/jobs', { token: t1, body: { customer_id: c1.id, title: 'งานร้าน 1' } })).data;

  assert.equal((await call('GET', '/customers', { token: t2 })).data.total, 0);
  assert.equal((await call('GET', `/customers/${c1.id}`, { token: t2 })).status, 404);
  assert.equal((await call('GET', `/jobs/${j1.id}`, { token: t2 })).status, 404);
  assert.equal((await call('POST', `/jobs/${j1.id}/status`, { token: t2, body: { status: 'completed' } })).status, 404);
  assert.equal((await call('PUT', `/customers/${c1.id}`, { token: t2, body: { name: 'แฮ็ก' } })).status, 404);
  // อ้าง customer_id ของร้านอื่นตอนสร้างงานไม่ได้
  assert.equal((await call('POST', '/jobs', { token: t2, body: { customer_id: c1.id, title: 'x' } })).status, 400);
  // เลขที่งานนับแยกแต่ละร้าน
  const c2 = (await call('POST', '/customers', { token: t2, body: { name: 'ลูกค้าร้าน 2' } })).data;
  const j2 = (await call('POST', '/jobs', { token: t2, body: { customer_id: c2.id, title: 'งานร้าน 2' } })).data;
  assert.match(j2.job_no, /-0001$/);
});

test('สิทธิ์พนักงาน: ลบข้อมูลและจัดการผู้ใช้ไม่ได้', async () => {
  const owner = await register('ร้านสิทธิ์', 'owner@perm.test');
  const add = await call('POST', '/users', { token: owner, body: { name: 'พนักงาน', email: 'staff@perm.test', password: 'password123', role: 'staff' } });
  assert.equal(add.status, 201);
  const staff = (await call('POST', '/auth/login', { body: { email: 'staff@perm.test', password: 'password123' } })).data.token;

  const c = (await call('POST', '/customers', { token: staff, body: { name: 'ลูกค้า' } })).data;
  assert.equal((await call('DELETE', `/customers/${c.id}`, { token: staff })).status, 403);
  assert.equal((await call('POST', '/users', { token: staff, body: { name: 'x', email: 'x@perm.test', password: 'password123' } })).status, 403);

  // ปิดใช้งานแล้ว token เดิมใช้ไม่ได้
  await call('PUT', `/users/${add.data.id}`, { token: owner, body: { active: false } });
  assert.equal((await call('GET', '/customers', { token: staff })).status, 401);
});

test('ตรวจสอบข้อมูลที่ส่งมา', async () => {
  const token = await register('ร้านตรวจ', 'v@shop.test');
  assert.equal((await call('POST', '/customers', { token, body: {} })).status, 400);
  assert.equal((await call('POST', '/auth/register', { body: { shop_name: 'x', name: 'x', email: 'v@shop.test', password: 'password123' } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'v@shop.test', password: 'wrong-pass' } })).status, 401);
  const c = (await call('POST', '/customers', { token, body: { name: 'ลูกค้า' } })).data;
  assert.equal((await call('POST', '/jobs', { token, body: { customer_id: c.id, title: 'x', price: -1 } })).status, 400);
  assert.equal((await call('POST', '/jobs', { token, body: { customer_id: c.id, title: 'x', due_date: '14/10/2026' } })).status, 400);
});
