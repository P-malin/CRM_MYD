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

  const types = (await call('GET', '/job-types', { token })).data;
  assert.equal(types.length, 8);
  const acrylic = types.find((t) => t.name === 'อักษรอะคริลิก');

  const job = await call('POST', '/jobs', {
    token,
    body: { customer_id: cust.data.id, title: 'ป้ายหน้าร้าน', job_type_id: acrylic.id, delivery_method: 'shop_install', install_address: '1 ถ.สุขุมวิท', width_cm: 300, height_cm: 100, price: 5000, deposit: 2000 },
  });
  assert.equal(job.status, 201);
  assert.match(job.data.job_no, /^J\d{4}-0001$/);
  const statuses = (await call('GET', '/job-statuses', { token })).data;
  const S = Object.fromEntries(statuses.map((x) => [x.name, x]));
  assert.equal(job.data.status_name, 'รับลูกค้าใหม่');
  assert.equal(job.data.paid, 2000);
  assert.equal(job.data.sign_type, 'อักษรอะคริลิก');
  assert.equal(job.data.delivery_method, 'shop_install');
  assert.equal(job.data.install_required, true);

  const st = await call('POST', `/jobs/${job.data.id}/status`, { token, body: { status_id: S['กำลังผลิต'].id, note: 'ลูกค้าอนุมัติแบบแล้ว' } });
  assert.equal(st.data.status_name, 'กำลังผลิต');
  assert.equal(st.data.status_kind, 'open');

  const pay = await call('POST', `/jobs/${job.data.id}/payments`, { token, body: { amount: 3000, kind: 'final', method: 'transfer' } });
  assert.equal(pay.data.paid, 5000);

  await call('POST', `/jobs/${job.data.id}/status`, { token, body: { status_id: S['ปิดงาน'].id } });
  const detail = await call('GET', `/jobs/${job.data.id}`, { token });
  assert.equal(detail.data.logs.length, 3);
  assert.deepEqual(detail.data.logs.map((l) => l.to_name), ['รับลูกค้าใหม่', 'กำลังผลิต', 'ปิดงาน']);
  assert.ok(detail.data.completed_at);
  assert.ok(detail.data.delivered_at);

  const dash = await call('GET', '/reports/dashboard', { token });
  assert.equal(dash.data.status_counts.find((x) => x.name === 'ปิดงาน').n, 1);
  assert.equal(dash.data.open_jobs, 0);
  assert.equal(dash.data.month_sales, 5000);
  assert.equal(dash.data.outstanding, 0);

  const sum = await call('GET', '/reports/summary', { token });
  assert.equal(sum.data.totals.sales, 5000);
  assert.equal(sum.data.totals.collected, 5000);
  assert.equal(sum.data.by_sign_type[0].sign_type, 'อักษรอะคริลิก');

  const csv = await call('GET', '/reports/jobs.csv', { token });
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes('ป้ายหน้าร้าน'));
});

test('ข้อมูลแต่ละร้านแยกจากกัน (tenant isolation)', async () => {
  const t1 = await register('ร้าน 1', 'one@shop.test');
  const t2 = await register('ร้าน 2', 'two@shop.test');
  const c1 = (await call('POST', '/customers', { token: t1, body: { name: 'ลูกค้าร้าน 1' } })).data;
  const j1 = (await call('POST', '/jobs', { token: t1, body: { delivery_method: 'customer_pickup', customer_id: c1.id, title: 'งานร้าน 1', job_type_id: (await call('GET', '/job-types', { token: t1 })).data[0].id } })).data;

  assert.equal((await call('GET', '/customers', { token: t2 })).data.total, 0);
  assert.equal((await call('GET', `/customers/${c1.id}`, { token: t2 })).status, 404);
  assert.equal((await call('GET', `/jobs/${j1.id}`, { token: t2 })).status, 404);
  assert.equal((await call('POST', `/jobs/${j1.id}/status`, { token: t2, body: { status_id: 1 } })).status, 404);
  assert.equal((await call('PUT', `/customers/${c1.id}`, { token: t2, body: { name: 'แฮ็ก' } })).status, 404);
  // อ้าง customer_id ของร้านอื่นตอนสร้างงานไม่ได้
  const t2Type = (await call('GET', '/job-types', { token: t2 })).data[0].id;
  const cross = await call('POST', '/jobs', { token: t2, body: { delivery_method: 'customer_pickup', customer_id: c1.id, title: 'x', job_type_id: t2Type } });
  assert.equal(cross.status, 400);
  assert.match(cross.data.error, /ลูกค้า/);
  // เลขที่งานนับแยกแต่ละร้าน
  const c2 = (await call('POST', '/customers', { token: t2, body: { name: 'ลูกค้าร้าน 2' } })).data;
  const j2 = (await call('POST', '/jobs', { token: t2, body: { delivery_method: 'customer_pickup', customer_id: c2.id, title: 'งานร้าน 2', job_type_id: (await call('GET', '/job-types', { token: t2 })).data[0].id } })).data;
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
  const typeId = (await call('GET', '/job-types', { token })).data[0].id;
  const ok = { customer_id: c.id, title: 'x', job_type_id: typeId, delivery_method: 'customer_pickup' };
  assert.equal((await call('POST', '/jobs', { token, body: ok })).status, 201);
  const bad1 = await call('POST', '/jobs', { token, body: { delivery_method: 'customer_pickup', ...ok, price: -1 } });
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error, /ราคา/);
  const bad2 = await call('POST', '/jobs', { token, body: { delivery_method: 'customer_pickup', ...ok, due_date: '14/10/2026' } });
  assert.equal(bad2.status, 400);
  assert.match(bad2.data.error, /กำหนดส่ง/);
});

test('master ประเภทงาน', async () => {
  const owner = await register('ร้านประเภทงาน', 'types@shop.test');
  const other = await register('ร้านอื่น', 'types-other@shop.test');
  const types = (await call('GET', '/job-types', { token: owner })).data;
  const otherTypes = (await call('GET', '/job-types', { token: other })).data;
  const misc = types.find((t) => t.requires_detail);
  assert.equal(misc.name, 'งานป้ายอื่น ๆ');
  const c = (await call('POST', '/customers', { token: owner, body: { name: 'ลูกค้า' } })).data;

  // ต้องเลือกประเภทงาน, ใช้ประเภทของร้านอื่นไม่ได้, "อื่น ๆ" ต้องมีรายละเอียด
  assert.equal((await call('POST', '/jobs', { token: owner, body: { delivery_method: 'customer_pickup', customer_id: c.id, title: 'x' } })).status, 400);
  assert.equal((await call('POST', '/jobs', { token: owner, body: { delivery_method: 'customer_pickup', customer_id: c.id, title: 'x', job_type_id: otherTypes[0].id } })).status, 400);
  assert.equal((await call('POST', '/jobs', { token: owner, body: { delivery_method: 'customer_pickup', customer_id: c.id, title: 'x', job_type_id: misc.id } })).status, 400);
  const job = (await call('POST', '/jobs', { token: owner, body: { delivery_method: 'customer_pickup', customer_id: c.id, title: 'x', job_type_id: misc.id, description: 'ป้ายไม้แกะสลัก' } })).data;
  assert.equal(job.sign_type, 'งานป้ายอื่น ๆ');

  // เพิ่ม / ชื่อซ้ำ / เปลี่ยนชื่อแล้วงานเดิมเปลี่ยนตาม
  const added = await call('POST', '/job-types', { token: owner, body: { name: 'ป้ายไวนิล', description: 'พิมพ์อิงค์เจ็ท' } });
  assert.equal(added.status, 201);
  assert.equal((await call('POST', '/job-types', { token: owner, body: { name: 'ป้ายไวนิล' } })).status, 409);
  await call('PUT', `/job-types/${misc.id}`, { token: owner, body: { name: 'งานอื่น ๆ' } });
  assert.equal((await call('GET', `/jobs/${job.id}`, { token: owner })).data.sign_type, 'งานอื่น ๆ');

  // ลบประเภทที่มีงานใช้ไม่ได้ ต้องปิดใช้งานแทน; ประเภทที่ปิดแล้วเลือกใหม่ไม่ได้แต่งานเดิมแก้ไขต่อได้
  assert.equal((await call('DELETE', `/job-types/${misc.id}`, { token: owner })).status, 409);
  await call('PUT', `/job-types/${misc.id}`, { token: owner, body: { active: false } });
  assert.ok(!(await call('GET', '/job-types', { token: owner })).data.some((t) => t.id === misc.id));
  assert.equal((await call('GET', '/job-types?all=1', { token: owner })).data.length, 9);
  assert.equal((await call('POST', '/jobs', { token: owner, body: { delivery_method: 'customer_pickup', customer_id: c.id, title: 'y', job_type_id: misc.id, description: 'd' } })).status, 400);
  assert.equal((await call('PUT', `/jobs/${job.id}`, { token: owner, body: { title: 'แก้ชื่องาน' } })).status, 200);
  assert.equal((await call('DELETE', `/job-types/${added.data.id}`, { token: owner })).status, 200);

  // แก้ไขประเภทงานของร้านอื่น / พนักงานแก้ master ไม่ได้
  assert.equal((await call('PUT', `/job-types/${otherTypes[0].id}`, { token: owner, body: { name: 'แฮ็ก' } })).status, 404);
  await call('POST', '/users', { token: owner, body: { name: 'พนักงาน', email: 'types-staff@shop.test', password: 'password123' } });
  const staff = (await call('POST', '/auth/login', { body: { email: 'types-staff@shop.test', password: 'password123' } })).data.token;
  assert.equal((await call('POST', '/job-types', { token: staff, body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', '/job-types', { token: staff })).status, 200);
});

test('วิธีส่งมอบงาน', async () => {
  const token = await register('ร้านส่งมอบ', 'delivery@shop.test');
  const c = (await call('POST', '/customers', { token, body: { name: 'ลูกค้า' } })).data;
  const typeId = (await call('GET', '/job-types', { token })).data[0].id;
  const base = { customer_id: c.id, title: 'ป้าย', job_type_id: typeId };
  const post = (body) => call('POST', '/jobs', { token, body: { ...base, ...body } });

  assert.match((await post({})).data.error, /วิธีส่งมอบ/);
  assert.equal((await post({ delivery_method: 'teleport' })).status, 400);
  // ร้านจัดส่ง / ร้านเข้าติดตั้ง ต้องมีที่อยู่
  assert.match((await post({ delivery_method: 'shop_delivery' })).data.error, /ที่อยู่/);
  assert.match((await post({ delivery_method: 'shop_install' })).data.error, /ที่อยู่/);
  const shipped = await post({ delivery_method: 'shop_delivery', install_address: '9 ถ.พระราม 4' });
  assert.equal(shipped.status, 201);
  assert.equal(shipped.data.install_required, false);
  // ลูกค้ารับเอง / ติดตั้งเอง ไม่ต้องมีที่อยู่
  assert.equal((await post({ delivery_method: 'customer_pickup' })).status, 201);
  const self = (await post({ delivery_method: 'customer_install' })).data;

  // เปลี่ยนเป็นร้านเข้าติดตั้ง ต้องเติมที่อยู่
  assert.equal((await call('PUT', `/jobs/${self.id}`, { token, body: { delivery_method: 'shop_install' } })).status, 400);
  const upd = await call('PUT', `/jobs/${self.id}`, { token, body: { delivery_method: 'shop_install', install_address: 'หน้างาน' } });
  assert.equal(upd.data.install_required, true);

  const list = (await call('GET', '/jobs?delivery_method=shop_install', { token })).data;
  assert.deepEqual(list.rows.map((j) => j.id), [self.id]);
  const csv = await call('GET', '/reports/jobs.csv', { token });
  assert.ok(csv.data.includes('ร้านเข้าติดตั้งหน้างาน') && csv.data.includes('ลูกค้ามารับสินค้าเอง'));
});

test('ลิงก์ Google Maps ตำแหน่งหน้างาน', async () => {
  const token = await register('ร้านแผนที่', 'maps@shop.test');
  const c = (await call('POST', '/customers', { token, body: { name: 'ลูกค้า' } })).data;
  const typeId = (await call('GET', '/job-types', { token })).data[0].id;
  const base = { customer_id: c.id, title: 'ป้าย', job_type_id: typeId, delivery_method: 'shop_install', install_address: 'หน้างาน' };
  const post = (location_url) => call('POST', '/jobs', { token, body: { ...base, location_url } });

  // ลิงก์ Google Maps แบบต่าง ๆ ที่ได้จากปุ่มแชร์
  for (const ok of [
    'https://maps.app.goo.gl/AbCdEf123',
    'https://goo.gl/maps/xyz',
    'https://www.google.com/maps/place/Bangkok/@13.75,100.5,15z',
    'https://www.google.co.th/maps?q=13.7,100.5',
    'https://maps.google.com/?q=13.7,100.5',
  ]) {
    const r = await post(ok);
    assert.equal(r.status, 201, ok);
    assert.ok(r.data.location_url.startsWith('https://'), ok);
  }
  // พิกัด → แปลงเป็นลิงก์
  assert.equal((await post('13.7563, 100.5018')).data.location_url, 'https://www.google.com/maps?q=13.7563,100.5018');
  // http → https
  assert.equal((await post('http://maps.app.goo.gl/x')).data.location_url, 'https://maps.app.goo.gl/x');

  // ลิงก์ที่ไม่ใช่ Google Maps / ลิงก์อันตราย / พิกัดเกินช่วง ต้องถูกปฏิเสธ
  for (const bad of [
    'javascript:alert(1)',
    'https://evil.example.com/maps',
    'https://www.google.com/search?q=x',
    'https://maps.app.goo.gl.evil.com/x',
    'data:text/html,hi',
    '99.1, 200.5',
    'ไม่ใช่ลิงก์',
  ]) {
    const r = await post(bad);
    assert.equal(r.status, 400, bad);
    assert.match(r.data.error, /Google Maps/);
  }

  // ลบลิงก์ได้ (ส่งค่าว่าง)
  const job = (await post('https://maps.app.goo.gl/AbC')).data;
  const cleared = await call('PUT', `/jobs/${job.id}`, { token, body: { location_url: '' } });
  assert.equal(cleared.data.location_url, null);
});

test('master สถานะงาน', async () => {
  const owner = await register('ร้านสถานะ', 'status@shop.test');
  const other = await register('ร้านสถานะอื่น', 'status-other@shop.test');
  const list = (await call('GET', '/job-statuses', { token: owner })).data;
  assert.deepEqual(list.map((x) => x.name), [
    'รับลูกค้าใหม่', 'รอรายละเอียด', 'เสนอราคา', 'รออนุมัติ', 'ยืนยันงาน', 'รอมัดจำ', 'รอผลิต',
    'กำลังผลิต', 'รอติดตั้ง/จัดส่ง', 'ติดตั้ง/จัดส่งแล้ว', 'รอชำระเงิน', 'ปิดงาน', 'ยกเลิก',
  ]);
  const S = Object.fromEntries(list.map((x) => [x.name, x]));
  const otherFirst = (await call('GET', '/job-statuses', { token: other })).data[0];

  const c = (await call('POST', '/customers', { token: owner, body: { name: 'ลูกค้า' } })).data;
  const typeId = (await call('GET', '/job-types', { token: owner })).data[0].id;
  const newJob = async (extra = {}) =>
    (await call('POST', '/jobs', { token: owner, body: { customer_id: c.id, title: 'ป้าย', job_type_id: typeId, delivery_method: 'customer_pickup', price: 1000, ...extra } })).data;
  const move = (id, statusId) => call('POST', `/jobs/${id}/status`, { token: owner, body: { status_id: statusId } });

  // งานเลยกำหนด: นับเฉพาะงานที่ยังไม่ส่งมอบ
  const late = await newJob({ due_date: '2020-01-01' });
  assert.equal((await call('GET', '/reports/dashboard', { token: owner })).data.overdue, 1);
  assert.equal((await move(late.id, S['ติดตั้ง/จัดส่งแล้ว'].id)).data.status_kind, 'delivered');
  let dash = (await call('GET', '/reports/dashboard', { token: owner })).data;
  assert.equal(dash.overdue, 0);
  assert.equal(dash.open_jobs, 1); // ส่งมอบแล้วแต่ยังไม่ปิด ยังนับเป็นงานที่ดำเนินการอยู่
  // เวลาส่งมอบคงเดิมเมื่อไป "รอชำระเงิน" → ปิดงาน; ย้อนกลับไปสถานะระหว่างทำจะล้าง
  const delivered = (await call('GET', `/jobs/${late.id}`, { token: owner })).data.delivered_at;
  await move(late.id, S['รอชำระเงิน'].id);
  const closed = (await move(late.id, S['ปิดงาน'].id)).data;
  assert.equal(closed.delivered_at, delivered);
  assert.ok(closed.completed_at);
  const reopened = (await move(late.id, S['กำลังผลิต'].id)).data;
  assert.equal(reopened.delivered_at, null);
  assert.equal(reopened.completed_at, null);

  // งานยกเลิกไม่นับยอดขาย
  const cancelled = await newJob({ price: 9999 });
  await move(cancelled.id, S['ยกเลิก'].id);
  dash = (await call('GET', '/reports/dashboard', { token: owner })).data;
  assert.equal(dash.month_sales, 1000);

  // ใช้สถานะของร้านอื่นไม่ได้ / ย้ายไปสถานะเดิมไม่ได้
  assert.equal((await move(late.id, otherFirst.id)).status, 400);
  assert.equal((await move(late.id, S['กำลังผลิต'].id)).status, 400);

  // เพิ่ม / แก้ไข (สี, ประเภท) / ชื่อซ้ำ / สีไม่ถูกต้อง
  const added = await call('POST', '/job-statuses', { token: owner, body: { name: 'รอตรวจงาน', color: '#123ABC', kind: 'open' } });
  assert.equal(added.status, 201);
  assert.equal(added.data.color, '#123abc');
  assert.equal(added.data.sort_order, 14);
  assert.equal((await call('POST', '/job-statuses', { token: owner, body: { name: 'รอตรวจงาน' } })).status, 409);
  for (const bad of ['red', '#12345', 'url(x)', '#12345g"']) {
    assert.equal((await call('POST', '/job-statuses', { token: owner, body: { name: `x${bad}`, color: bad } })).status, 400, bad);
  }
  assert.equal((await call('POST', '/job-statuses', { token: owner, body: { name: 'y', kind: 'weird' } })).status, 400);
  // เปลี่ยนชื่อแล้วงานแสดงชื่อใหม่
  await call('PUT', `/job-statuses/${S['กำลังผลิต'].id}`, { token: owner, body: { name: 'อยู่ระหว่างผลิต' } });
  assert.equal((await call('GET', `/jobs/${late.id}`, { token: owner })).data.status_name, 'อยู่ระหว่างผลิต');

  // เรียงลำดับ: สถานะแรกที่เป็น open = สถานะเริ่มต้นของงานใหม่
  const ids = (await call('GET', '/job-statuses?all=1', { token: owner })).data.map((x) => x.id);
  const reordered = [added.data.id, ...ids.filter((id) => id !== added.data.id)];
  assert.equal((await call('PUT', '/job-statuses/order', { token: owner, body: { ids: reordered } })).status, 200);
  assert.equal((await newJob()).status_name, 'รอตรวจงาน');
  assert.equal((await call('PUT', '/job-statuses/order', { token: owner, body: { ids: reordered.slice(1) } })).status, 400);
  assert.equal((await call('PUT', '/job-statuses/order', { token: owner, body: { ids: [...reordered.slice(1), otherFirst.id] } })).status, 400);

  // ลบ: สถานะที่มีงาน/ประวัติ ลบไม่ได้; ปิดใช้งานแล้วเลือกไม่ได้
  assert.equal((await call('DELETE', `/job-statuses/${S['ปิดงาน'].id}`, { token: owner })).status, 409);
  const unused = (await call('POST', '/job-statuses', { token: owner, body: { name: 'ไม่ได้ใช้' } })).data;
  assert.equal((await call('DELETE', `/job-statuses/${unused.id}`, { token: owner })).status, 200);
  await call('PUT', `/job-statuses/${S['เสนอราคา'].id}`, { token: owner, body: { active: false } });
  assert.equal((await move(late.id, S['เสนอราคา'].id)).status, 400);
  assert.ok(!(await call('GET', '/job-statuses', { token: owner })).data.some((x) => x.id === S['เสนอราคา'].id));

  // ต้องเหลือสถานะ open ที่เปิดใช้งานอย่างน้อย 1 อัน
  const opens = (await call('GET', '/job-statuses', { token: owner })).data.filter((x) => x.kind === 'open');
  for (const o of opens.slice(1)) await call('PUT', `/job-statuses/${o.id}`, { token: owner, body: { active: false } });
  const last = await call('PUT', `/job-statuses/${opens[0].id}`, { token: owner, body: { active: false } });
  assert.equal(last.status, 400);
  assert.match(last.data.error, /อย่างน้อย 1/);

  // ร้านอื่นแก้ไม่ได้ / พนักงานแก้ master ไม่ได้
  assert.equal((await call('PUT', `/job-statuses/${otherFirst.id}`, { token: owner, body: { name: 'แฮ็ก' } })).status, 404);
  await call('POST', '/users', { token: owner, body: { name: 'พนักงาน', email: 'status-staff@shop.test', password: 'password123' } });
  const staff = (await call('POST', '/auth/login', { body: { email: 'status-staff@shop.test', password: 'password123' } })).data.token;
  assert.equal((await call('POST', '/job-statuses', { token: staff, body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', '/job-statuses', { token: staff })).status, 200);
});
