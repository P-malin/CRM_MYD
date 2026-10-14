// สร้างข้อมูลตัวอย่าง 2 ร้าน: npm run seed  (ใช้ฐานข้อมูลเดียวกับ server: DATABASE_URL หรือ PGlite)
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { JOB_STATUSES } = require('../src/constants');
const { DEFAULT_JOB_TYPES_VALUES } = require('../src/schema');

const pick = (arr, i) => arr[i % arr.length];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const dateOffset = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const SHOPS = [
  { name: 'ร้านป้ายเมืองทอง', email: 'demo@signshop.test', staff: ['สมศักดิ์', 'วิภา'] },
  { name: 'ป้ายสวยดีไซน์', email: 'demo2@signshop.test', staff: ['ธนา'] },
];
const CUSTOMERS = [
  ['คุณสมชาย ใจดี', 'ร้านกาแฟบ้านสวน', '0812345678'],
  ['คุณมาลี ศรีสุข', 'บริษัท สุขใจ จำกัด', '0898765432'],
  ['คุณวีระ ทองคำ', 'คลินิกทันตกรรมยิ้มสวย', '0861112222'],
  ['คุณนภา แก้วใส', 'ร้านอาหารครัวนภา', '0823334444'],
  ['คุณปรีชา มั่นคง', 'หจก. ปรีชาการช่าง', '0835556666'],
  ['คุณอรุณ รุ่งเรือง', 'โรงเรียนอนุบาลรุ่งอรุณ', '0847778888'],
];
const TITLES = ['ป้ายหน้าร้าน', 'ป้ายโปรโมชั่น', 'ป้ายกล่องไฟหน้าอาคาร', 'ตัวอักษรชื่อบริษัท', 'ป้ายบอกทางภายใน', 'สติ๊กเกอร์ติดกระจก', 'ป้ายไวนิลงานอีเวนต์'];

async function seedShop(t, si, shop) {
  const { id: tenant } = await t.one('INSERT INTO tenants (name, phone, address, job_seq) VALUES (?, ?, ?, 24) RETURNING id', [shop.name, '021234567', 'กรุงเทพฯ']);
  const jobTypes = await t.query(
    `INSERT INTO job_types (tenant_id, name, description, requires_detail, sort_order)
     SELECT ?, v.* FROM (VALUES ${DEFAULT_JOB_TYPES_VALUES}) AS v(name, description, requires_detail, sort_order) RETURNING id, name`,
    [tenant],
  );
  const { id: owner } = await t.one(
    "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, 'เจ้าของร้าน', ?, ?, 'owner') RETURNING id",
    [tenant, shop.email, hashPassword('password123')],
  );
  const staff = [];
  for (const [i, n] of shop.staff.entries()) {
    const u = await t.one("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'staff') RETURNING id", [
      tenant, n, `staff${i + 1}.${shop.email}`, hashPassword('password123'),
    ]);
    staff.push(u.id);
  }
  const custIds = [];
  for (const [i, [name, company, phone]] of CUSTOMERS.slice(si, si + 5).entries()) {
    const c = await t.one('INSERT INTO customers (tenant_id, name, company, phone, line_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', [
      tenant, name, company, phone, `line_${i}`, daysAgo(200 - i * 10),
    ]);
    custIds.push(c.id);
  }

  for (let i = 0; i < 24; i++) {
    const created = 170 - i * 7;
    const status = created > 40 ? (i % 9 === 0 ? 'cancelled' : 'completed') : pick(JOB_STATUSES.slice(0, 5), i).key;
    const price = 1500 + ((i * 3731) % 45000);
    const jobNo = `J${daysAgo(created).slice(2, 7).replace('-', '')}-${String(i + 1).padStart(4, '0')}`;
    const { id: job } = await t.one(
      `INSERT INTO jobs (tenant_id, job_no, customer_id, title, job_type_id, sign_type, description, material, width_cm, height_cm, quantity, price,
         status, priority, assigned_to, due_date, install_required, created_by, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        tenant, jobNo, pick(custIds, i), pick(TITLES, i), pick(jobTypes, i).id, pick(jobTypes, i).name, 'รายละเอียดงานตัวอย่าง', pick(['ไวนิล 380 แกรม', 'อะคริลิก 5 มม.', 'สแตนเลส', 'ซิงค์'], i),
        100 + (i % 5) * 50, 60 + (i % 3) * 40, 1 + (i % 3), price, status, pick(['normal', 'normal', 'high', 'urgent', 'low'], i),
        pick([owner, ...staff], i), dateOffset(-created + 14), i % 2 === 1, owner, daysAgo(created),
        status === 'completed' ? daysAgo(created - 12 - (i % 5)) : null,
      ],
    );
    await t.run("INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id, created_at) VALUES (?, ?, NULL, 'new', 'รับงาน', ?, ?)", [
      tenant, job, owner, daysAgo(created),
    ]);
    if (status !== 'new') {
      await t.run('INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        tenant, job, 'new', status, owner, daysAgo(Math.max(created - 10, 0)),
      ]);
    }
    const deposit = Math.round(price * 0.5);
    if (status !== 'cancelled') {
      await t.run("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', 'transfer', ?, ?)", [
        tenant, job, deposit, daysAgo(created).slice(0, 10), owner,
      ]);
    }
    if (status === 'completed' && i % 4 !== 0) {
      await t.run("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'final', 'cash', ?, ?)", [
        tenant, job, price - deposit, daysAgo(created - 14).slice(0, 10), owner,
      ]);
    }
  }
}

(async () => {
  const db = await openDb();
  for (const [si, shop] of SHOPS.entries()) {
    if (await db.one('SELECT 1 FROM users WHERE lower(email) = ?', [shop.email])) {
      console.log(`ข้าม ${shop.name}: มีอยู่แล้ว`);
      continue;
    }
    await db.tx((t) => seedShop(t, si, shop));
    console.log(`สร้าง ${shop.name}: เข้าสู่ระบบด้วย ${shop.email} / password123`);
  }
  await db.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
