const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || 'data/crm.db';

const db = openDb(DB_FILE);
const server = createApp(db).listen(PORT, () => {
  console.log(`CRM ร้านป้าย พร้อมใช้งานที่ http://localhost:${PORT} (db: ${DB_FILE})`);
});

// ปิดอย่างปลอดภัยเมื่อแพลตฟอร์มสั่งหยุด (เช่นตอน deploy ใหม่) เพื่อไม่ให้ไฟล์ฐานข้อมูลเสีย
function shutdown(signal) {
  console.log(`ได้รับ ${signal} กำลังปิดระบบ...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
