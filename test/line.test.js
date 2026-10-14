const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

// เซิร์ฟเวอร์จำลอง LINE Messaging API
const fake = { calls: [], failPush: false };
const lineServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const call = { method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    fake.calls.push(call);
    const send = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (call.auth !== 'Bearer good-token') return send(401, { message: 'Authentication failed' });
    if (req.url === '/v2/bot/info') return send(200, { displayName: 'บอทร้านทดสอบ', basicId: '@abc' });
    if (req.url.startsWith('/v2/bot/group/')) return send(200, { groupName: 'ทีมร้านป้าย' });
    if (req.url === '/v2/bot/message/push') return fake.failPush ? send(500, { message: 'boom' }) : send(200, {});
    if (req.url === '/v2/bot/message/reply') return send(200, {});
    send(404, { message: 'not found' });
  });
});

let server;
let base;
let db;
test.before(async () => {
  await new Promise((r) => lineServer.listen(0, r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${lineServer.address().port}`;
  process.env.APP_SECRET = 'test-app-secret';
  db = await openDb(process.env.TEST_DATABASE_URL || ':memory:');
  await new Promise((r) => {
    server = createApp(db).listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.close();
  lineServer.close();
  await db.close();
});

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const register = async (shop, email) =>
  (await call('POST', '/api/auth/register', { body: { shop_name: shop, name: 'เจ้าของ', email, password: 'password123' } })).data.token;
const sign = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

test('แจ้งเตือน LINE เข้ากลุ่มทีม', async () => {
  const token = await register('ร้าน LINE', 'line@shop.test');
  const other = await register('ร้านอื่น', 'line-other@shop.test');

  // ยังไม่ตั้งค่า → เปิดไม่ได้, token ผิดถูกปฏิเสธ
  assert.equal((await call('PUT', '/api/line/settings', { token, body: { enabled: true } })).status, 400);
  const bad = await call('PUT', '/api/line/settings', { token, body: { token: 'bad-token' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /token ไม่ถูกต้อง/);

  const saved = (await call('PUT', '/api/line/settings', { token, body: { token: 'good-token', secret: 'chan-secret', enabled: true } })).data;
  assert.equal(saved.bot_name, 'บอทร้านทดสอบ');
  assert.equal(saved.has_token, true);
  assert.equal(saved.enabled, true);
  assert.match(saved.webhook_url, /\/api\/line\/webhook\/[\w-]{20,}$/);
  assert.ok(!JSON.stringify(saved).includes('good-token') && !JSON.stringify(saved).includes('chan-secret'));
  // เก็บแบบเข้ารหัสในฐานข้อมูล
  const row = await db.one("SELECT line_token, line_secret FROM tenants WHERE name = 'ร้าน LINE'");
  assert.ok(row.line_token.startsWith('v1:') && !row.line_token.includes('good-token'));

  // ยังไม่มีกลุ่ม → ทดสอบส่งไม่ได้
  assert.match((await call('POST', '/api/line/test', { token })).data.error, /กลุ่ม/);

  // webhook: ลายเซ็นผิด → 401, key ผิด → 404
  const path = new URL(saved.webhook_url).pathname;
  const joinBody = JSON.stringify({ events: [{ type: 'join', replyToken: 'r1', source: { type: 'group', groupId: 'Cgroup123' } }] });
  assert.equal((await call('POST', path, { raw: joinBody, headers: { 'x-line-signature': sign('wrong', joinBody) } })).status, 401);
  assert.equal((await call('POST', '/api/line/webhook/nope', { raw: joinBody, headers: { 'x-line-signature': sign('chan-secret', joinBody) } })).status, 404);
  // LINE กด Verify (events ว่าง) → 200
  const empty = JSON.stringify({ events: [] });
  assert.equal((await call('POST', path, { raw: empty, headers: { 'x-line-signature': sign('chan-secret', empty) } })).status, 200);
  // บอทเข้ากลุ่ม → ผูกกลุ่ม + ตอบกลับในกลุ่ม
  fake.calls = [];
  assert.equal((await call('POST', path, { raw: joinBody, headers: { 'x-line-signature': sign('chan-secret', joinBody) } })).status, 200);
  const s2 = (await call('GET', '/api/line/settings', { token })).data;
  assert.equal(s2.group_id, 'Cgroup123');
  assert.equal(s2.group_name, 'ทีมร้านป้าย');
  assert.ok(fake.calls.some((c) => c.path === '/v2/bot/message/reply' && c.body.replyToken === 'r1'));

  // ส่งข้อความทดสอบ
  fake.calls = [];
  assert.equal((await call('POST', '/api/line/test', { token })).status, 200);
  assert.equal(fake.calls.at(-1).body.to, 'Cgroup123');

  // รับงานใหม่ → แจ้งเข้ากลุ่ม
  const c = (await call('POST', '/api/customers', { token, body: { name: 'คุณสมชาย', phone: '0811111111' } })).data;
  const typeId = (await call('GET', '/api/job-types', { token })).data[0].id;
  fake.calls = [];
  const job = (await call('POST', '/api/jobs', {
    token,
    body: { customer_id: c.id, title: 'ป้ายหน้าร้าน', job_type_id: typeId, delivery_method: 'shop_install', install_address: '1 ถ.สุขุมวิท', location_url: '13.7, 100.5', price: 5000 },
  })).data;
  assert.equal(job.notification.status, 'sent');
  let pushed = fake.calls.find((x) => x.path === '/v2/bot/message/push');
  assert.equal(pushed.auth, 'Bearer good-token');
  assert.equal(pushed.body.to, 'Cgroup123');
  const text = pushed.body.messages[0].text;
  for (const part of ['รับงานใหม่', job.job_no, 'ป้ายหน้าร้าน', 'คุณสมชาย', 'รับลูกค้าใหม่', 'ร้านเข้าติดตั้งหน้างาน', 'google.com/maps', `/#/jobs/${job.id}`]) {
    assert.ok(text.includes(part), part);
  }

  // เปลี่ยนสถานะ → แจ้ง "เดิม → ใหม่" พร้อมหมายเหตุ
  const S = Object.fromEntries((await call('GET', '/api/job-statuses', { token })).data.map((x) => [x.name, x]));
  fake.calls = [];
  const moved = (await call('POST', `/api/jobs/${job.id}/status`, { token, body: { status_id: S['เสนอราคา'].id, note: 'ส่งใบเสนอราคาทางไลน์' } })).data;
  assert.equal(moved.notification.status, 'sent');
  pushed = fake.calls.find((x) => x.path === '/v2/bot/message/push');
  assert.ok(pushed.body.messages[0].text.includes('รับลูกค้าใหม่ → เสนอราคา'));
  assert.ok(pushed.body.messages[0].text.includes('ส่งใบเสนอราคาทางไลน์'));

  // สถานะที่ปิด "แจ้ง LINE" → ไม่ส่ง
  await call('PUT', `/api/job-statuses/${S['รออนุมัติ'].id}`, { token, body: { notify_line: false } });
  fake.calls = [];
  const quiet = (await call('POST', `/api/jobs/${job.id}/status`, { token, body: { status_id: S['รออนุมัติ'].id } })).data;
  assert.equal(quiet.notification.status, 'skipped');
  assert.equal(fake.calls.length, 0);

  // LINE ล่ม → เปลี่ยนสถานะสำเร็จ แต่บันทึกว่าส่งไม่สำเร็จ
  fake.failPush = true;
  const failed = await call('POST', `/api/jobs/${job.id}/status`, { token, body: { status_id: S['ยืนยันงาน'].id } });
  fake.failPush = false;
  assert.equal(failed.status, 200);
  assert.equal(failed.data.status_name, 'ยืนยันงาน');
  assert.equal(failed.data.notification.status, 'failed');
  const detail = (await call('GET', `/api/jobs/${job.id}`, { token })).data;
  assert.deepEqual(detail.notifications.map((n) => n.status), ['failed', 'sent', 'sent']);

  // ปิดการแจ้งเตือน → ไม่ส่ง
  await call('PUT', '/api/line/settings', { token, body: { enabled: false } });
  fake.calls = [];
  assert.equal((await call('POST', `/api/jobs/${job.id}/status`, { token, body: { status_id: S['รอมัดจำ'].id } })).data.notification.status, 'skipped');
  assert.equal(fake.calls.length, 0);

  // บอทถูกเตะออกจากกลุ่ม → ล้างกลุ่ม
  const leave = JSON.stringify({ events: [{ type: 'leave', source: { type: 'group', groupId: 'Cgroup123' } }] });
  await call('POST', path, { raw: leave, headers: { 'x-line-signature': sign('chan-secret', leave) } });
  assert.equal((await call('GET', '/api/line/settings', { token })).data.group_id, null);

  // ร้านอื่นไม่เห็น/แก้การตั้งค่าของร้านนี้, พนักงานตั้งค่าไม่ได้
  assert.equal((await call('GET', '/api/line/settings', { token: other })).data.has_token, false);
  await call('POST', '/api/users', { token, body: { name: 'พนักงาน', email: 'line-staff@shop.test', password: 'password123' } });
  const staff = (await call('POST', '/api/auth/login', { body: { email: 'line-staff@shop.test', password: 'password123' } })).data.token;
  assert.equal((await call('GET', '/api/line/settings', { token: staff })).status, 403);
  assert.equal((await call('PUT', '/api/line/settings', { token: staff, body: { enabled: true } })).status, 403);
});
