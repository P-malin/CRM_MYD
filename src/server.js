const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || 'data/crm.db';

const db = openDb(DB_FILE);
createApp(db).listen(PORT, () => {
  console.log(`CRM ร้านป้าย พร้อมใช้งานที่ http://localhost:${PORT} (db: ${DB_FILE})`);
});
