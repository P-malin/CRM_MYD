const { SCHEMA, SCHEMA_VERSION } = require('./schema');

// แปลงชนิดข้อมูลจาก Postgres ให้เป็นค่าที่ใช้ง่ายใน JS
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 };
const toIso = (v) => new Date(v).toISOString();
const PARSERS = {
  [OID.INT8]: Number, // COUNT(*) / SUM(integer)
  [OID.NUMERIC]: Number, // เงิน, ขนาด
  [OID.DATE]: (v) => v, // เก็บเป็น 'YYYY-MM-DD' ไม่แปลงเป็น Date (กันเพี้ยนเพราะ timezone)
  [OID.TIMESTAMPTZ]: toIso,
  [OID.TIMESTAMP]: (v) => toIso(`${v}Z`),
};

// เขียน SQL ด้วย ? แล้วแปลงเป็น $1, $2, ... ให้อัตโนมัติ
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ตัวช่วย query ที่ใช้ทั่วทั้งแอป: rows / one / run / tx
function wrap(exec, txImpl) {
  const db = {
    async query(sql, params = []) {
      return (await exec(toPg(sql), params)).rows;
    },
    async one(sql, params = []) {
      return (await exec(toPg(sql), params)).rows[0];
    },
    async run(sql, params = []) {
      return exec(toPg(sql), params);
    },
    tx: txImpl,
  };
  return db;
}

// เชื่อม Postgres จริง (Supabase) ผ่าน DATABASE_URL
function openPg(url) {
  const pg = require('pg');
  for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    // Supabase บังคับ SSL; ใบรับรองของ pooler ไม่อยู่ใน CA มาตรฐานของ Node
    ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  const exec = async (sql, params) => {
    const r = await pool.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount };
  };
  const db = wrap(exec, async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(wrap(async (sql, params) => {
        const r = await client.query(sql, params);
        return { rows: r.rows, rowCount: r.rowCount };
      }));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
  db.close = () => pool.end();
  return db;
}

// Postgres แบบฝังในโปรเซส (PGlite) สำหรับรันบนเครื่องตัวเองและเทสต์ — ไม่ต้องติดตั้งฐานข้อมูล
function openPglite(dir) {
  const { PGlite } = require('@electric-sql/pglite');
  const lite = new PGlite(dir === ':memory:' ? undefined : dir, { parsers: PARSERS });
  const execOn = (target) => async (sql, params) => {
    const r = await target.query(sql, params, { parsers: PARSERS });
    return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
  };
  const db = wrap(execOn(lite), (fn) => lite.transaction((tx) => fn(wrap(execOn(tx)))));
  db.close = () => lite.close();
  return db;
}

async function isMigrated(q) {
  const { t } = await q.one("SELECT to_regclass('schema_version') AS t");
  return Boolean(t && (await q.one('SELECT 1 FROM schema_version WHERE version = ?', [SCHEMA_VERSION])));
}

// สร้าง/อัปเดตตารางอัตโนมัติ (ข้ามถ้าทำแล้ว เพื่อให้ cold start บน serverless เร็ว)
async function migrate(db) {
  if (await isMigrated(db)) return;
  await db.tx(async (t) => {
    // กันหลาย instance (serverless) สร้างตารางพร้อมกัน
    await t.run('SELECT pg_advisory_xact_lock(727274)');
    if (await isMigrated(t)) return;
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await t.run(stmt);
    await t.run('INSERT INTO schema_version (version) VALUES (?) ON CONFLICT DO NOTHING', [SCHEMA_VERSION]);
  });
}

/**
 * เปิดฐานข้อมูล: ถ้ามี DATABASE_URL ใช้ Postgres จริง ไม่เช่นนั้นใช้ PGlite เก็บไฟล์ที่ PGLITE_DIR (ค่าเริ่มต้น data/pglite)
 * ส่ง ':memory:' เพื่อใช้ฐานข้อมูลชั่วคราว (เทสต์)
 */
async function openDb(target = process.env.DATABASE_URL || process.env.PGLITE_DIR || 'data/pglite') {
  // บน Vercel ไม่มีที่เก็บไฟล์ถาวร จึงต้องมี DATABASE_URL เสมอ
  if (process.env.VERCEL && !/^postgres(ql)?:\/\//.test(target)) {
    throw Object.assign(new Error('DATABASE_URL is not set'), { code: 'NO_DATABASE_URL' });
  }
  const db = /^postgres(ql)?:\/\//.test(target) ? openPg(target) : openPglite(target);
  await migrate(db);
  return db;
}

module.exports = { openDb };
