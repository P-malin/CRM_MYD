const path = require('node:path');
const express = require('express');
const { requireAuth } = require('./auth');
const { HttpError } = require('./util');
const constants = require('./constants');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // อยู่หลัง proxy ของ Vercel: ใช้ https จาก x-forwarded-proto
  // เก็บ raw body ไว้ตรวจลายเซ็น webhook ของ LINE
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => (req.rawBody = buf) }));
  app.use((req, res, next) => {
    req.body ??= {};
    next();
  });

  // ใช้ตรวจสุขภาพระบบ (เปิด /healthz เพื่อเช็กว่าแอปต่อฐานข้อมูลได้)
  app.get('/healthz', async (req, res) => {
    await db.one('SELECT 1');
    res.json({ ok: true });
  });

  const api = express.Router();
  api.get('/meta', (req, res) => res.json(constants));
  api.use(require('./routes/auth')(db));
  const { lineWebhookRoutes, lineSettingsRoutes } = require('./routes/line');
  api.use(lineWebhookRoutes(db));
  const { fileRoutes, localFileRoutes } = require('./routes/files');
  api.use(localFileRoutes());
  api.use(requireAuth(db));
  api.use(require('./routes/users')(db));
  api.use(require('./routes/customers')(db));
  api.use(require('./routes/jobTypes')(db));
  api.use(require('./routes/jobStatuses')(db));
  api.use(lineSettingsRoutes(db));
  api.use(require('./routes/jobs')(db));
  api.use(require('./routes/quotations')(db));
  api.use(require('./routes/receipts')(db));
  api.use(fileRoutes(db));
  api.use(require('./routes/reports')(db));
  api.use((req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    // ข้อผิดพลาดที่ตั้งใจแจ้งผู้ใช้ (HttpError) แสดงข้อความจริง; ข้อผิดพลาดอื่นซ่อนรายละเอียด
    const expose = err instanceof HttpError || status < 500;
    if (!expose) console.error(err);
    res.status(status).json({ error: expose ? err.message : 'เกิดข้อผิดพลาดในระบบ' });
  });
  return app;
}

module.exports = { createApp };
