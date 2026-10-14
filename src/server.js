const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;

(async () => {
  const db = await openDb();
  const server = createApp(db).listen(PORT, () => {
    const where = process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : `PGlite (${process.env.PGLITE_DIR || 'data/pglite'})`;
    console.log(`CRM ร้านป้าย พร้อมใช้งานที่ http://localhost:${PORT} (db: ${where})`);
  });

  // ปิดอย่างปลอดภัยเมื่อแพลตฟอร์มสั่งหยุด เพื่อปิดการเชื่อมต่อฐานข้อมูลให้เรียบร้อย
  const shutdown = (signal) => {
    console.log(`ได้รับ ${signal} กำลังปิดระบบ...`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('เปิดฐานข้อมูลไม่สำเร็จ:', err.message);
  process.exit(1);
});
