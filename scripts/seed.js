// สร้างข้อมูลตัวอย่าง 2 ร้าน: npm run seed  (ใช้ฐานข้อมูลเดียวกับ server: DATABASE_URL หรือ PGlite)
const { openDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { DEFAULT_JOB_TYPES_VALUES, DEFAULT_JOB_STATUSES_VALUES } = require('../src/schema');

const pick = (arr, i) => arr[i % arr.length];
const DELIVERY = ['shop_install', 'customer_pickup', 'shop_delivery', 'customer_install'];
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
  const statuses = await t.query(
    `INSERT INTO job_statuses (tenant_id, name, description, color, kind, sort_order)
     SELECT ?, v.* FROM (VALUES ${DEFAULT_JOB_STATUSES_VALUES}) AS v(name, description, color, kind, sort_order) RETURNING id, kind`,
    [tenant],
  );
  const byKind = (k) => statuses.filter((x) => x.kind === k);
  const working = statuses.filter((x) => x.kind === 'open' || x.kind === 'delivered');
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
    // งานเก่า → ปิดงาน/ยกเลิก, งานใหม่ → กระจายตามสถานะที่ยังไม่ปิด
    const st = created > 40 ? (i % 9 === 0 ? byKind('cancelled')[0] : byKind('done')[0]) : pick(working, i * 2);
    const delivered = st.kind === 'delivered' || st.kind === 'done';
    const price = 1500 + ((i * 3731) % 45000);
    const jobNo = `J${daysAgo(created).slice(2, 7).replace('-', '')}-${String(i + 1).padStart(4, '0')}`;
    const { id: job } = await t.one(
      `INSERT INTO jobs (tenant_id, job_no, customer_id, title, job_type_id, sign_type, description, material, width_cm, height_cm, quantity, price,
         status_id, priority, assigned_to, due_date, delivery_method, install_required, install_address, created_by, created_at, completed_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        tenant, jobNo, pick(custIds, i), pick(TITLES, i), pick(jobTypes, i).id, pick(jobTypes, i).name, 'รายละเอียดงานตัวอย่าง', pick(['ไวนิล 380 แกรม', 'อะคริลิก 5 มม.', 'สแตนเลส', 'ซิงค์'], i),
        100 + (i % 5) * 50, 60 + (i % 3) * 40, 1 + (i % 3), price, st.id, pick(['normal', 'normal', 'high', 'urgent', 'low'], i),
        pick([owner, ...staff], i), dateOffset(-created + 14), pick(DELIVERY, i), pick(DELIVERY, i) === 'shop_install',
        ['shop_delivery', 'shop_install'].includes(pick(DELIVERY, i)) ? '99/1 ถ.สุขุมวิท กรุงเทพฯ' : null, owner, daysAgo(created),
        st.kind === 'done' ? daysAgo(created - 14) : null,
        delivered ? daysAgo(created - 12 - (i % 5)) : null,
      ],
    );
    await t.run("INSERT INTO job_status_logs (tenant_id, job_id, to_status_id, note, user_id, created_at) VALUES (?, ?, ?, 'รับงาน', ?, ?)", [
      tenant, job, statuses[0].id, owner, daysAgo(created),
    ]);
    if (st.id !== statuses[0].id) {
      await t.run('INSERT INTO job_status_logs (tenant_id, job_id, from_status_id, to_status_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        tenant, job, statuses[0].id, st.id, owner, daysAgo(Math.max(created - 10, 0)),
      ]);
    }
    const deposit = Math.round(price * 0.5);
    if (st.kind !== 'cancelled') {
      await t.run("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', 'transfer', ?, ?)", [
        tenant, job, deposit, daysAgo(created).slice(0, 10), owner,
      ]);
    }
    if (st.kind === 'done') {
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
