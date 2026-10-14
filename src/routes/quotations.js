const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, num, oneOf, date, intId, today, pagination } = require('../util');

const { QUOTE_STATUSES } = require('../constants');

const STATUS_KEYS = QUOTE_STATUSES.map((s) => s.key);
const VAT_RATES = [0, 7];
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ตรวจรายการสินค้า/บริการ และคำนวณยอด (คำนวณที่ server เสมอ ไม่เชื่อยอดจากหน้าเว็บ)
function readItems(items) {
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'กรุณาเพิ่มรายการอย่างน้อย 1 รายการ');
  if (items.length > 50) throw new HttpError(400, 'รายการต้องไม่เกิน 50 รายการ');
  return items.map((it, i) => {
    const description = requireStr(it.description, `รายละเอียดรายการที่ ${i + 1}`);
    const quantity = num(it.quantity, `จำนวนรายการที่ ${i + 1}`, { min: 0.01, def: 1 });
    const unit_price = num(it.unit_price, `ราคาต่อหน่วยรายการที่ ${i + 1}`, { min: 0, def: 0 });
    return { description, quantity, unit: str(it.unit), unit_price, amount: round2(quantity * unit_price) };
  });
}

function totals(items, discount, vatRate) {
  const subtotal = round2(items.reduce((s, it) => s + it.amount, 0));
  if (discount > subtotal) throw new HttpError(400, 'ส่วนลดต้องไม่เกินยอดรวม');
  const vat_amount = round2(((subtotal - discount) * vatRate) / 100);
  return { subtotal, vat_amount, total: round2(subtotal - discount + vat_amount) };
}

module.exports = function quotationRoutes(db) {
  const r = express.Router();

  const getQuote = async (tenantId, id, q = db) => {
    const quote = await q.one(
      `SELECT qt.*, j.job_no, j.title AS job_title, j.customer_id, u.name AS created_by_name
       FROM quotations qt JOIN jobs j ON j.id = qt.job_id LEFT JOIN users u ON u.id = qt.created_by
       WHERE qt.id = ? AND qt.tenant_id = ?`,
      [id, tenantId],
    );
    if (!quote) throw new HttpError(404, 'ไม่พบใบเสนอราคา');
    quote.items = await q.query(
      'SELECT id, description, quantity, unit, unit_price, amount FROM quotation_items WHERE quotation_id = ? ORDER BY sort_order, id',
      [quote.id],
    );
    return quote;
  };

  // อ่านส่วนหัวเอกสารจาก body (ใช้ทั้งสร้างและแก้ไข)
  function readHeader(b, cur) {
    const pick = (k) => (b[k] === undefined ? cur[k] : b[k]);
    const issue_date = date(pick('issue_date'), 'วันที่') || today();
    const valid_until = date(pick('valid_until'), 'ยืนราคาถึง');
    if (valid_until && valid_until < issue_date) throw new HttpError(400, 'วันยืนราคาต้องไม่ก่อนวันที่ออกเอกสาร');
    return {
      issue_date,
      valid_until,
      customer_name: requireStr(pick('customer_name'), 'ชื่อลูกค้า'),
      customer_address: str(pick('customer_address')),
      customer_tax_id: str(pick('customer_tax_id')),
      customer_phone: str(pick('customer_phone')),
      discount: num(pick('discount'), 'ส่วนลด', { min: 0, def: 0 }),
      vat_rate: Number(oneOf(String(pick('vat_rate') ?? 0), VAT_RATES.map(String), 'VAT', '0')),
      notes: str(pick('notes')),
    };
  }

  async function saveItems(tx, tenantId, quoteId, items) {
    await tx.run('DELETE FROM quotation_items WHERE quotation_id = ?', [quoteId]);
    for (const [i, it] of items.entries()) {
      await tx.run(
        'INSERT INTO quotation_items (quotation_id, tenant_id, sort_order, description, quantity, unit, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [quoteId, tenantId, i + 1, it.description, it.quantity, it.unit, it.unit_price, it.amount],
      );
    }
  }

  r.get('/quotations', async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const conds = ['qt.tenant_id = ?'];
    const params = [req.user.tenant_id];
    if (STATUS_KEYS.includes(req.query.status)) {
      conds.push('qt.status = ?');
      params.push(req.query.status);
    }
    if (Number.isInteger(Number(req.query.job_id)) && req.query.job_id) {
      conds.push('qt.job_id = ?');
      params.push(Number(req.query.job_id));
    }
    const q = str(req.query.q);
    if (q) {
      conds.push('(qt.quote_no ILIKE ? OR qt.customer_name ILIKE ? OR j.job_no ILIKE ? OR j.title ILIKE ?)');
      params.push(...Array(4).fill(`%${q}%`));
    }
    const where = conds.join(' AND ');
    const { n: total } = await db.one(`SELECT COUNT(*) n FROM quotations qt JOIN jobs j ON j.id = qt.job_id WHERE ${where}`, params);
    const rows = await db.query(
      `SELECT qt.id, qt.quote_no, qt.status, qt.issue_date, qt.valid_until, qt.customer_name, qt.total, qt.job_id, j.job_no, j.title AS job_title
       FROM quotations qt JOIN jobs j ON j.id = qt.job_id WHERE ${where}
       ORDER BY qt.issue_date DESC, qt.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ total, rows });
  });

  r.get('/quotations/:id', async (req, res) => {
    const quote = await getQuote(req.user.tenant_id, intId(req.params.id));
    // ข้อมูลร้านสำหรับหัวเอกสาร
    quote.shop = await db.one('SELECT name, phone, email, address, tax_id FROM tenants WHERE id = ?', [req.user.tenant_id]);
    res.json(quote);
  });

  // สร้างจากงาน: ถ้าไม่ส่งรายการมา จะเติมจากข้อมูลงานให้
  r.post('/quotations', async (req, res) => {
    const t = req.user.tenant_id;
    const jobId = num(req.body.job_id, 'งาน', { min: 1 });
    const job = jobId && (await db.one(
      `SELECT j.*, c.name AS c_name, c.company AS c_company, c.address AS c_address, c.tax_id AS c_tax_id, c.phone AS c_phone
       FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = ? AND j.tenant_id = ?`,
      [jobId, t],
    ));
    if (!job) throw new HttpError(400, 'ไม่พบงาน');
    const shop = await db.one('SELECT quote_terms, quote_validity_days, quote_vat FROM tenants WHERE id = ?', [t]);
    const issue = today();
    const size = job.width_cm || job.height_cm ? ` ขนาด ${job.width_cm ?? '-'}×${job.height_cm ?? '-'} ซม.` : '';
    const defaults = {
      issue_date: issue,
      valid_until: shop.quote_validity_days > 0 ? addDays(issue, shop.quote_validity_days) : null,
      customer_name: job.c_company ? `${job.c_company} (${job.c_name})` : job.c_name,
      customer_address: job.c_address,
      customer_tax_id: job.c_tax_id,
      customer_phone: job.c_phone,
      discount: 0,
      vat_rate: shop.quote_vat ? 7 : 0,
      notes: shop.quote_terms,
    };
    const header = readHeader(req.body, defaults);
    const items = readItems(
      req.body.items || [
        {
          description: [job.sign_type, job.title].filter(Boolean).join(' — ') + size + (job.material ? ` วัสดุ ${job.material}` : '') +
            (job.description ? `\n${job.description}` : ''),
          quantity: job.quantity || 1,
          unit: 'ชิ้น',
          unit_price: job.quantity ? round2(Number(job.price) / job.quantity) : Number(job.price),
        },
      ],
    );
    const sums = totals(items, header.discount, header.vat_rate);
    const id = await db.tx(async (tx) => {
      const { quote_seq: seq } = await tx.one('UPDATE tenants SET quote_seq = quote_seq + 1 WHERE id = ? RETURNING quote_seq', [t]);
      const quoteNo = `QT${issue.slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const cols = { ...header, ...sums };
      const { id: qid } = await tx.one(
        `INSERT INTO quotations (tenant_id, job_id, quote_no, created_by, ${Object.keys(cols).join(', ')})
         VALUES (?, ?, ?, ?, ${Object.keys(cols).map(() => '?').join(', ')}) RETURNING id`,
        [t, job.id, quoteNo, req.user.id, ...Object.values(cols)],
      );
      await saveItems(tx, t, qid, items);
      return qid;
    });
    res.status(201).json(await getQuote(t, id));
  });

  r.put('/quotations/:id', async (req, res) => {
    const t = req.user.tenant_id;
    const cur = await getQuote(t, intId(req.params.id));
    if (cur.status === 'accepted') throw new HttpError(400, 'ใบเสนอราคานี้ลูกค้าอนุมัติแล้ว แก้ไขไม่ได้ — ให้สร้างฉบับแก้ไขแทน');
    const header = readHeader(req.body, cur);
    const items = req.body.items === undefined ? readItems(cur.items) : readItems(req.body.items);
    const sums = totals(items, header.discount, header.vat_rate);
    await db.tx(async (tx) => {
      const cols = { ...header, ...sums };
      await tx.run(`UPDATE quotations SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')}, updated_at = now() WHERE id = ?`, [
        ...Object.values(cols),
        cur.id,
      ]);
      await saveItems(tx, t, cur.id, items);
    });
    res.json(await getQuote(t, cur.id));
  });

  // เปลี่ยนสถานะ; อนุมัติ + apply_to_job = อัปเดตราคางานให้เท่ายอดใบเสนอราคา
  r.post('/quotations/:id/status', async (req, res) => {
    const t = req.user.tenant_id;
    const cur = await getQuote(t, intId(req.params.id));
    const status = oneOf(req.body.status, STATUS_KEYS, 'สถานะ', null);
    if (!status) throw new HttpError(400, 'กรุณาเลือกสถานะ');
    await db.tx(async (tx) => {
      await tx.run(
        "UPDATE quotations SET status = ?, accepted_at = CASE WHEN ? = 'accepted' THEN now() ELSE NULL END, updated_at = now() WHERE id = ?",
        [status, status, cur.id],
      );
      if (status === 'accepted' && req.body.apply_to_job) {
        await tx.run('UPDATE jobs SET price = ?, updated_at = now() WHERE id = ? AND tenant_id = ?', [cur.total, cur.job_id, t]);
      }
    });
    res.json(await getQuote(t, cur.id));
  });

  // สร้างฉบับแก้ไข (คัดลอกเป็นใบใหม่สถานะร่าง)
  r.post('/quotations/:id/duplicate', async (req, res) => {
    const t = req.user.tenant_id;
    const src = await getQuote(t, intId(req.params.id));
    const shop = await db.one('SELECT quote_validity_days FROM tenants WHERE id = ?', [t]);
    const issue = today();
    const id = await db.tx(async (tx) => {
      const { quote_seq: seq } = await tx.one('UPDATE tenants SET quote_seq = quote_seq + 1 WHERE id = ? RETURNING quote_seq', [t]);
      const quoteNo = `QT${issue.slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const { id: qid } = await tx.one(
        `INSERT INTO quotations (tenant_id, job_id, quote_no, created_by, issue_date, valid_until, customer_name, customer_address,
           customer_tax_id, customer_phone, discount, vat_rate, subtotal, vat_amount, total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [t, src.job_id, quoteNo, req.user.id, issue, shop.quote_validity_days > 0 ? addDays(issue, shop.quote_validity_days) : null,
          src.customer_name, src.customer_address, src.customer_tax_id, src.customer_phone, src.discount, src.vat_rate,
          src.subtotal, src.vat_amount, src.total, src.notes],
      );
      await saveItems(tx, t, qid, src.items);
      return qid;
    });
    res.status(201).json(await getQuote(t, id));
  });

  r.delete('/quotations/:id', requireRole('owner', 'admin'), async (req, res) => {
    const cur = await getQuote(req.user.tenant_id, intId(req.params.id));
    await db.run('DELETE FROM quotations WHERE id = ?', [cur.id]);
    res.json({ ok: true });
  });

  return r;
};

module.exports.readItems = readItems;
module.exports.totals = totals;
