// สร้างข้อมูลตัวอย่าง 2 ร้าน: node scripts/seed.js  (ใช้ DB_FILE เดียวกับ server)
const { openDb, transaction } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { JOB_STATUSES, SIGN_TYPES } = require('../src/constants');

const db = openDb(process.env.DB_FILE || 'data/crm.db');
const pick = (arr, i) => arr[i % arr.length];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);
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

for (const [si, shop] of SHOPS.entries()) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(shop.email)) {
    console.log(`ข้าม ${shop.name}: มีอยู่แล้ว`);
    continue;
  }
  transaction(db, () => {
    const t = db.prepare('INSERT INTO tenants (name, phone, address) VALUES (?, ?, ?)').run(shop.name, '021234567', 'กรุงเทพฯ').lastInsertRowid;
    const owner = db.prepare("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, 'เจ้าของร้าน', ?, ?, 'owner')")
      .run(t, shop.email, hashPassword('password123')).lastInsertRowid;
    const staff = shop.staff.map((n, i) =>
      db.prepare("INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'staff')")
        .run(t, n, `staff${i + 1}.${shop.email}`, hashPassword('password123')).lastInsertRowid);
    const custIds = CUSTOMERS.slice(si, si + 5).map(([name, company, phone], i) =>
      db.prepare('INSERT INTO customers (tenant_id, name, company, phone, line_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t, name, company, phone, `line_${i}`, daysAgo(200 - i * 10)).lastInsertRowid);

    for (let i = 0; i < 24; i++) {
      const created = 170 - i * 7;
      const status = created > 40 ? (i % 9 === 0 ? 'cancelled' : 'completed') : pick(JOB_STATUSES.slice(0, 5), i).key;
      const price = 1500 + ((i * 3731) % 45000);
      const seq = i + 1;
      const jobNo = `J${daysAgo(created).slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const due = dateOffset(-created + 14);
      const job = db.prepare(`INSERT INTO jobs (tenant_id, job_no, customer_id, title, sign_type, material, width_cm, height_cm, quantity, price,
          status, priority, assigned_to, due_date, install_required, created_by, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        t, jobNo, pick(custIds, i), pick(TITLES, i), pick(SIGN_TYPES, i), pick(['ไวนิล 380 แกรม', 'อะคริลิก 5 มม.', 'สแตนเลส', 'ซิงค์'], i),
        100 + (i % 5) * 50, 60 + (i % 3) * 40, 1 + (i % 3), price, status, pick(['normal', 'normal', 'high', 'urgent', 'low'], i),
        pick([owner, ...staff], i), due, i % 2, owner, daysAgo(created), status === 'completed' ? daysAgo(created - 12 - (i % 5)) : null,
      ).lastInsertRowid;
      db.prepare("INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, note, user_id, created_at) VALUES (?, ?, NULL, 'new', 'รับงาน', ?, ?)")
        .run(t, job, owner, daysAgo(created));
      if (status !== 'new') {
        db.prepare('INSERT INTO job_status_logs (tenant_id, job_id, from_status, to_status, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(t, job, 'new', status, owner, daysAgo(Math.max(created - 10, 0)));
      }
      if (status !== 'cancelled') {
        db.prepare("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'deposit', 'transfer', ?, ?)")
          .run(t, job, Math.round(price * 0.5), daysAgo(created).slice(0, 10), owner);
      }
      if (status === 'completed' && i % 4 !== 0) {
        db.prepare("INSERT INTO payments (tenant_id, job_id, amount, kind, method, paid_at, user_id) VALUES (?, ?, ?, 'final', 'cash', ?, ?)")
          .run(t, job, price - Math.round(price * 0.5), daysAgo(created - 14).slice(0, 10), owner);
      }
    }
    db.prepare('UPDATE tenants SET job_seq = 24 WHERE id = ?').run(t);
  });
  console.log(`สร้าง ${shop.name}: เข้าสู่ระบบด้วย ${shop.email} / password123`);
}
