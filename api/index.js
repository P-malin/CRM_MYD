// จุดเข้าใช้งานบน Vercel (serverless function) — ทุก request /api/* และ /healthz ถูกส่งมาที่นี่ (ดู vercel.json)
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let appPromise;

module.exports = async (req, res) => {
  // เปิดการเชื่อมต่อครั้งเดียวต่อ instance แล้วใช้ซ้ำ
  appPromise ??= openDb().then(createApp);
  let app;
  try {
    app = await appPromise;
  } catch (err) {
    appPromise = undefined;
    console.error(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ' }));
    return;
  }
  return app(req, res);
};
