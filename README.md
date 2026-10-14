# CRM ร้านป้าย (CRM_MYD)

ระบบ CRM สำหรับ **ร้านทำป้าย** แบบ multi-tenant — หลายร้านใช้ระบบเดียวกันได้ โดยข้อมูลของแต่ละร้านแยกจากกันทั้งหมด

## ฟีเจอร์

| โมดูล | รายละเอียด |
|---|---|
| **สมัคร/เข้าสู่ระบบ** | ร้านใหม่สมัครเองได้ (สร้างร้าน + บัญชีเจ้าของร้าน), เพิ่มพนักงานได้ 3 ระดับสิทธิ์: เจ้าของร้าน / ผู้ดูแล / พนักงาน |
| **ข้อมูลลูกค้า** | ชื่อ บริษัท เบอร์โทร LINE อีเมล ที่อยู่ เลขผู้เสียภาษี หมายเหตุ, ค้นหา, ประวัติงานและยอดค้างชำระของลูกค้าแต่ละราย |
| **ประเภทงาน (master)** | แต่ละร้านมีรายการประเภทงานของตัวเอง เริ่มต้น 8 ประเภท (อักษรอะคริลิก, อักษรพ่นสี, อักษรโลหะ, อักษรสแตนเลส, อักษรสแตนเลสสีทอง, อักษรไฟสว่างหน้า ขอบซิงค์ / ขอบสแตนเลส, งานป้ายอื่น ๆ) เพิ่ม/แก้ไข/ปิดใช้งานได้ที่หน้าตั้งค่า, ตั้งให้บางประเภทต้องกรอกรายละเอียดงานได้ |
| **รับงาน** | เลขที่งานอัตโนมัติแยกแต่ละร้าน (`J2610-0001`), ประเภทงาน วัสดุ ขนาด จำนวน ราคา มัดจำ กำหนดส่ง ความเร่งด่วน ผู้รับผิดชอบ |
| **การส่งมอบงาน** | เลือกวิธีส่งมอบ: ร้านจัดส่งสินค้า / ร้านเข้าติดตั้งหน้างาน / ลูกค้ามารับสินค้าเอง / ลูกค้านำไปติดตั้งเอง — สองแบบแรกต้องระบุที่อยู่จัดส่ง/ติดตั้ง, แนบลิงก์ Google Maps ตำแหน่งหน้างาน (หรือพิมพ์พิกัด) แล้วกดเปิดแผนที่/นำทางได้จากหน้างาน, กรองรายการงานตามวิธีส่งมอบได้ |
| **สถานะงาน** | รับงานใหม่ → ออกแบบ → รอลูกค้าอนุมัติแบบ → ผลิต → รอติดตั้ง/ส่งมอบ → เสร็จสิ้น (หรือยกเลิก), มุมมองบอร์ด (Kanban) และตาราง, บันทึกประวัติทุกการเปลี่ยนสถานะ, แจ้งงานเลยกำหนด |
| **การชำระเงิน** | บันทึกมัดจำ / งวด / ส่วนที่เหลือ หลายช่องทาง, แสดงยอดคงค้างต่องาน |
| **รายงาน** | แดชบอร์ดภาพรวม, รายงานตามช่วงวันที่: ยอดรับงาน, ยอดรับชำระ, กราฟรายเดือน, แยกตามประเภทงาน, ลูกค้ายอดสูงสุด, ผลงานพนักงาน, อัตราส่งงานตรงเวลา, ส่งออก CSV (เปิดใน Excel ภาษาไทยได้) |

## สถาปัตยกรรม

```
เบราว์เซอร์ ──► Vercel ── หน้าเว็บ (public/) แบบ static
                    └── /api/* ──► Serverless Function (Express, api/index.js) ──► Supabase (PostgreSQL)
```

- **Vercel**: โฮสต์หน้าเว็บและ API (region โตเกียว `hnd1` ให้อยู่ใกล้ฐานข้อมูล Supabase)
- **Supabase**: ใช้เป็นฐานข้อมูล PostgreSQL — ระบบสร้างตารางให้อัตโนมัติตอนเริ่มทำงานครั้งแรก
- **รันบนเครื่องตัวเอง**: ถ้าไม่ได้ตั้ง `DATABASE_URL` จะใช้ [PGlite](https://pglite.dev) (Postgres ที่ฝังใน Node) เก็บข้อมูลที่ `data/pglite` — ไม่ต้องติดตั้งฐานข้อมูลเอง

## รันบนเครื่องตัวเอง

ต้องใช้ **Node.js 20 ขึ้นไป**

```bash
npm install
npm run seed     # (ไม่บังคับ) สร้างข้อมูลตัวอย่าง 2 ร้าน
npm start        # เปิด http://localhost:3000
```

บัญชีตัวอย่างหลัง `npm run seed`: `demo@signshop.test` / `password123` (และ `demo2@signshop.test` สำหรับร้านที่ 2)

```bash
npm test         # ทดสอบ API รวมถึงการแยกข้อมูลระหว่างร้าน
npm run dev      # รันแบบ auto-reload ระหว่างพัฒนา
```

| ตัวแปร | ความหมาย |
|---|---|
| `DATABASE_URL` | connection string ของ Postgres (Supabase) — ถ้าไม่ตั้งจะใช้ PGlite |
| `PGLITE_DIR` | โฟลเดอร์เก็บข้อมูล PGlite (ค่าเริ่มต้น `data/pglite`) |
| `PORT` | พอร์ตตอนรันบนเครื่อง (ค่าเริ่มต้น 3000) |
| `PG_POOL_MAX` | จำนวน connection สูงสุดต่อ instance (ค่าเริ่มต้น 3) |
| `TEST_DATABASE_URL` | ใช้รันเทสต์กับ Postgres จริง (ต้องเป็นฐานข้อมูลว่าง) |

## Deploy: Supabase + Vercel

### 1. สร้างฐานข้อมูลบน Supabase
1. สมัครที่ https://supabase.com → **New project**
2. ตั้งชื่อโปรเจค, ตั้ง **Database Password** (จดไว้), Region เลือกให้ตรงกับ `regions` ใน `vercel.json` (ตอนนี้ตั้งเป็นโตเกียว `hnd1` ตรงกับ Supabase `ap-northeast-1`)
3. เมื่อสร้างเสร็จ กดปุ่ม **Connect** ด้านบน → เลือก **Transaction pooler** (พอร์ต `6543`) แล้วคัดลอก URI จะได้หน้าตาประมาณ
   `postgresql://postgres.xxxxxxxx:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`
4. แทน `[YOUR-PASSWORD]` ด้วยรหัสผ่านจากข้อ 2

> ต้องใช้ **Transaction pooler** เท่านั้น — Vercel เป็น serverless เชื่อมต่อแบบ Direct connection ไม่ได้

ไม่ต้องสร้างตารางเอง แอปจะสร้างให้ตอนมี request แรก

### 2. Deploy บน Vercel
1. สมัครที่ https://vercel.com ด้วยบัญชี GitHub → **Add New… → Project** → Import repo นี้
2. Framework Preset: เลือก **Other** (ค่าอื่นตั้งไว้ใน `vercel.json` แล้ว)
3. เปิด **Environment Variables** เพิ่ม `DATABASE_URL` = URI จาก Supabase ข้อ 1
4. กด **Deploy** → เสร็จแล้วจะได้ URL เช่น `https://crm-myd.vercel.app`
5. เปิด `https://<โดเมน>/healthz` ควรเห็น `{"ok":true}` จากนั้นเปิดหน้าเว็บแล้วสมัครร้านแรกได้เลย

ทุกครั้งที่ push ขึ้น GitHub, Vercel จะ deploy ใหม่ให้อัตโนมัติ (branch อื่นที่ไม่ใช่ production จะได้ URL preview แยก)

### ใส่ข้อมูลตัวอย่างบน Supabase (ไม่บังคับ)
```bash
DATABASE_URL="postgresql://...:6543/postgres" npm run seed
```

### ความปลอดภัยของฐานข้อมูล
- ทุกตารางเปิด **Row Level Security** โดยไม่มี policy → ไม่มีใครอ่าน/เขียนข้อมูลผ่าน Supabase Data API (anon key) ได้
- แอปเชื่อมต่อด้วย role `postgres` ผ่าน `DATABASE_URL` เท่านั้น — **ห้ามเผยแพร่ `DATABASE_URL`** และอย่าใส่ไว้ในโค้ด
- สำรองข้อมูล: Supabase มี backup อัตโนมัติในแพ็กเกจ Pro; แพ็กเกจฟรีให้ export เองจากหน้า Database → Backups หรือใช้ `pg_dump`

### ข้อควรรู้เรื่องแพ็กเกจฟรี
- Supabase ฟรี: ฐานข้อมูล 500 MB และ **โปรเจคจะถูกพักถ้าไม่มีการใช้งาน 1 สัปดาห์** (ต้องกด Restore ในหน้า dashboard)
- Vercel Hobby (ฟรี): ใช้ได้เฉพาะงานส่วนตัวที่ไม่ใช่เชิงพาณิชย์ — เมื่อเปิดขายให้ร้านลูกค้าควรอัปเกรดเป็น Pro

## โครงสร้างโปรเจค

```
api/index.js         จุดเข้าใช้งานบน Vercel (serverless function)
src/
  server.js          รันบนเครื่องตัวเอง (npm start)
  app.js             ประกอบ Express app + error handler
  db.js              เชื่อมฐานข้อมูล (pg สำหรับ Supabase / PGlite สำหรับเครื่องตัวเอง) + migration อัตโนมัติ
  schema.js          โครงสร้างตาราง (PostgreSQL)
  auth.js            hash รหัสผ่าน (scrypt), session token, ตรวจสิทธิ์
  constants.js       สถานะงาน ประเภทป้าย ช่องทางชำระ ฯลฯ
  routes/            auth, users, customers, jobs, reports
public/              หน้าเว็บ (HTML/CSS/JS ล้วน ไม่ต้อง build)
scripts/seed.js      ข้อมูลตัวอย่าง
test/                ทดสอบ API (node:test)
vercel.json          ตั้งค่า Vercel (region, rewrites)
```

## การแยกข้อมูลแต่ละร้าน (Multi-tenant)

- ทุกตารางข้อมูลร้านมีคอลัมน์ `tenant_id`
- เมื่อเข้าสู่ระบบ ระบบจะรู้ `tenant_id` จาก session — **ทุก query กรองด้วย `req.user.tenant_id` เสมอ** และตรวจว่า id ที่อ้างอิง (ลูกค้า, พนักงาน) เป็นของร้านเดียวกัน
- มีเทสต์ยืนยันว่าร้านหนึ่งอ่าน/แก้ไขข้อมูลของอีกร้านไม่ได้ (`test/api.test.js`)

## API หลัก

ทุก endpoint (ยกเว้น `/api/meta`, `/api/auth/register`, `/api/auth/login`) ต้องส่ง header `Authorization: Bearer <token>`

| Method | Path | คำอธิบาย |
|---|---|---|
| POST | `/api/auth/register` | สมัครร้านใหม่ `{shop_name, name, email, password}` |
| POST | `/api/auth/login` | เข้าสู่ระบบ → `{token}` |
| GET | `/api/auth/me` | ผู้ใช้ปัจจุบัน + ข้อมูลร้าน |
| GET/POST | `/api/customers` | รายการ (`?q=`) / เพิ่มลูกค้า |
| GET/PUT/DELETE | `/api/customers/:id` | ดู (พร้อมประวัติงาน) / แก้ไข / ลบ |
| GET/POST | `/api/jobs` | รายการ (`?status=&q=&overdue=1&assigned_to=&job_type_id=&delivery_method=&open=1`) / รับงาน |
| GET/PUT/DELETE | `/api/jobs/:id` | ดู (พร้อมประวัติสถานะ+การชำระ) / แก้ไข / ลบ |
| POST | `/api/jobs/:id/status` | เปลี่ยนสถานะ `{status, note}` |
| POST | `/api/jobs/:id/payments` | บันทึกรับชำระ `{amount, kind, method, paid_at}` |
| GET/POST | `/api/job-types` | รายการประเภทงาน (`?all=1` รวมที่ปิดใช้งาน) / เพิ่ม |
| PUT/DELETE | `/api/job-types/:id` | แก้ไข / ลบ (ลบได้เฉพาะที่ยังไม่มีงานใช้) |
| GET | `/api/reports/dashboard` | ตัวเลขภาพรวม |
| GET | `/api/reports/summary?from=&to=` | รายงานตามช่วงวันที่ |
| GET | `/api/reports/jobs.csv?from=&to=` | ส่งออกรายการงาน |
| GET/POST/PUT | `/api/users` | จัดการผู้ใช้ในร้าน |

## แนวทางพัฒนาต่อ

- ออกใบเสนอราคา / ใบแจ้งหนี้ / ใบเสร็จ (PDF)
- แนบไฟล์แบบป้าย/รูปหน้างาน และให้ลูกค้าอนุมัติแบบผ่านลิงก์
- แจ้งเตือนผ่าน LINE เมื่อสถานะงานเปลี่ยน หรือใกล้ถึงกำหนดส่ง
- ระบบแพ็กเกจ/การเรียกเก็บเงินรายเดือนสำหรับแต่ละร้าน (SaaS billing)
- ใช้ Supabase Storage เก็บไฟล์แบบป้าย / รูปหน้างาน
- ใช้ Supabase Auth (ล็อกอินด้วย Google, ลืมรหัสผ่านทางอีเมล)
