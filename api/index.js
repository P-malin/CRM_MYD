// จุดเข้าใช้งานบน Vercel (serverless function) — ทุก request /api/* และ /healthz ถูกส่งมาที่นี่ (ดู vercel.json)
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { dbErrorHint } = require('../src/db-errors');

let appPromise;

module.exports = async (req, res) => {
  // เปิดการเชื่อมต่อครั้งเดียวต่อ instance แล้วใช้ซ้ำ
  appPromise ??= openDb().then(createApp);
  let app;
  try {
    app = await appPromise;
  } catch (err) {
    appPromise = undefined;
    console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', err.code || '', err.message);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ', hint: dbErrorHint(err), code: err.code || null }));
    return;
  }
  return app(req, res);
};
