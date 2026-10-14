const path = require('node:path');
const express = require('express');
const { requireAuth } = require('./auth');
const constants = require('./constants');

function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
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
  api.use(requireAuth(db));
  api.use(require('./routes/users')(db));
  api.use(require('./routes/customers')(db));
  api.use(require('./routes/jobTypes')(db));
  api.use(require('./routes/jobs')(db));
  api.use(require('./routes/reports')(db));
  api.use((req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'เกิดข้อผิดพลาดในระบบ' : err.message });
  });
  return app;
}

module.exports = { createApp };
