const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, requireStr, oneOf, date, intId, today, pagination } = require('../util');
const { RECEIPT_TYPES, PAYMENT_KINDS } = require('../constants');

const TYPE_KEYS = RECEIPT_TYPES.map((t) => t.key);
const VAT_RATE = 7;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ยอดที่รับเป็นยอดรวม VAT แล้ว → แยกฐานภาษีกับ VAT ออก (ใบกำกับภาษี)
function splitVat(total, docType) {
  if (docType !== 'tax_invoice') return { subtotal: total, vat_rate: 0, vat_amount: 0, total };
  const vat_amount = round2((total * VAT_RATE) / (100 + VAT_RATE));
  return { subtotal: round2(total - vat_amount), vat_rate: VAT_RATE, vat_amount, total };
}

module.exports = function receiptRoutes(db) {
  const r = express.Router();

  const getReceipt = async (tenantId, id) => {
    const rc = await db.one(
      `SELECT rc.*, j.job_no, j.title AS job_title, u.name AS created_by_name, v.name AS voided_by_name
       FROM receipts rc JOIN jobs j ON j.id = rc.job_id
       LEFT JOIN users u ON u.id = rc.created_by LEFT JOIN users v ON v.id = rc.voided_by
       WHERE rc.id = ? AND rc.tenant_id = ?`,
      [id, tenantId],
    );
    if (!rc) throw new HttpError(404, 'ไม่พบเอกสาร');
    return rc;
  };

  r.get('/receipts', async (req, res) => {
    const { limit, offset } = pagination(req.query);
    const conds = ['rc.tenant_id = ?'];
    const params = [req.user.tenant_id];
    if (TYPE_KEYS.includes(req.query.type)) {
      conds.push('rc.doc_type = ?');
      params.push(req.query.type);
    }
    if (['issued', 'void'].includes(req.query.status)) {
      conds.push('rc.status = ?');
      params.push(req.query.status);
    }
    const q = str(req.query.q);
    if (q) {
      conds.push('(rc.doc_no ILIKE ? OR rc.customer_name ILIKE ? OR j.job_no ILIKE ? OR j.title ILIKE ?)');
      params.push(...Array(4).fill(`%${q}%`));
    }
    const where = conds.join(' AND ');
    const { n: total } = await db.one(`SELECT COUNT(*) n FROM receipts rc JOIN jobs j ON j.id = rc.job_id WHERE ${where}`, params);
    const rows = await db.query(
      `SELECT rc.id, rc.doc_type, rc.doc_no, rc.status, rc.issue_date, rc.customer_name, rc.total, rc.vat_amount, rc.job_id, j.job_no, j.title AS job_title
       FROM receipts rc JOIN jobs j ON j.id = rc.job_id WHERE ${where}
       ORDER BY rc.issue_date DESC, rc.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    res.json({ total, rows });
  });

  r.get('/receipts/:id', async (req, res) => {
    const rc = await getReceipt(req.user.tenant_id, intId(req.params.id));
    rc.shop = await db.one('SELECT name, phone, email, address, tax_id, branch_name, vat_registered FROM tenants WHERE id = ?', [req.user.tenant_id]);
    res.json(rc);
  });

  // ข้อมูลตั้งต้นสำหรับฟอร์มออกเอกสารจากการชำระเงิน
  r.get('/receipts/draft/:paymentId', async (req, res) => {
    const t = req.user.tenant_id;
    const p = await db.one(
      `SELECT p.*, j.job_no, j.title, j.sign_type, c.name AS c_name, c.company, c.address, c.tax_id, c.branch, c.phone
       FROM payments p JOIN jobs j ON j.id = p.job_id JOIN customers c ON c.id = j.customer_id
       WHERE p.id = ? AND p.tenant_id = ?`,
      [intId(req.params.paymentId), t],
    );
    if (!p) throw new HttpError(404, 'ไม่พบรายการชำระเงิน');
    const shop = await db.one('SELECT vat_registered FROM tenants WHERE id = ?', [t]);
    const kind = (PAYMENT_KINDS.find((k) => k.key === p.kind) || {}).label || '';
    const docType = shop.vat_registered ? 'tax_invoice' : 'receipt';
    res.json({
      payment_id: p.id,
      doc_type: docType,
      vat_registered: shop.vat_registered,
      issue_date: p.paid_at,
      customer_name: p.company || p.c_name,
      customer_address: p.address,
      customer_tax_id: p.tax_id,
      customer_branch: p.branch || (p.tax_id && p.company ? 'สำนักงานใหญ่' : null),
      customer_phone: p.phone,
      description: `${[p.sign_type, p.title].filter(Boolean).join(' — ')} (งาน ${p.job_no})${kind ? `\n${kind}` : ''}`,
      amount: p.amount,
      ...splitVat(Number(p.amount), docType),
    });
  });

  r.post('/receipts', async (req, res) => {
    const t = req.user.tenant_id;
    const b = req.body;
    const pay = await db.one('SELECT * FROM payments WHERE id = ? AND tenant_id = ?', [Number(b.payment_id) || 0, t]);
    if (!pay) throw new HttpError(400, 'ไม่พบรายการชำระเงิน');
    const shop = await db.one('SELECT vat_registered, tax_id FROM tenants WHERE id = ?', [t]);
    const docType = oneOf(b.doc_type, TYPE_KEYS, 'ประเภทเอกสาร', 'receipt');
    if (docType === 'tax_invoice') {
      if (!shop.vat_registered) throw new HttpError(400, 'ร้านยังไม่ได้ตั้งค่าว่าจดทะเบียน VAT — ออกได้เฉพาะใบเสร็จรับเงิน');
      if (!shop.tax_id) throw new HttpError(400, 'กรุณาใส่เลขประจำตัวผู้เสียภาษีของร้านก่อน (ตั้งค่า → ข้อมูลร้าน)');
    }
    if (await db.one("SELECT 1 FROM receipts WHERE payment_id = ? AND status = 'issued'", [pay.id])) {
      throw new HttpError(409, 'การชำระเงินนี้ออกเอกสารแล้ว — ถ้าต้องการออกใหม่ให้ยกเลิกใบเดิมก่อน');
    }
    const head = {
      doc_type: docType,
      issue_date: date(b.issue_date, 'วันที่') || today(),
      customer_name: requireStr(b.customer_name, 'ชื่อลูกค้า'),
      customer_address: str(b.customer_address),
      customer_tax_id: str(b.customer_tax_id),
      customer_branch: str(b.customer_branch),
      customer_phone: str(b.customer_phone),
      description: requireStr(b.description, 'รายการ'),
      notes: str(b.notes),
      payment_method: pay.method,
      paid_at: pay.paid_at,
      ...splitVat(Number(pay.amount), docType),
    };
    if (docType === 'tax_invoice' && !head.customer_address) throw new HttpError(400, 'ใบกำกับภาษีต้องมีที่อยู่ของลูกค้า');
    const type = RECEIPT_TYPES.find((x) => x.key === docType);
    const seqCol = docType === 'tax_invoice' ? 'invoice_seq' : 'receipt_seq';
    const id = await db.tx(async (tx) => {
      const { seq } = await tx.one(`UPDATE tenants SET ${seqCol} = ${seqCol} + 1 WHERE id = ? RETURNING ${seqCol} AS seq`, [t]);
      const docNo = `${type.prefix}${head.issue_date.slice(2, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`;
      const cols = Object.keys(head);
      const row = await tx.one(
        `INSERT INTO receipts (tenant_id, job_id, payment_id, doc_no, created_by, ${cols.join(', ')})
         VALUES (?, ?, ?, ?, ?, ${cols.map(() => '?').join(', ')}) RETURNING id`,
        [t, pay.job_id, pay.id, docNo, req.user.id, ...cols.map((c) => head[c])],
      );
      return row.id;
    });
    res.status(201).json(await getReceipt(t, id));
  });

  // ยกเลิกเอกสาร (ไม่ลบ เพื่อให้เลขที่ต่อเนื่องตามหลักภาษี)
  r.post('/receipts/:id/void', requireRole('owner', 'admin'), async (req, res) => {
    const t = req.user.tenant_id;
    const rc = await getReceipt(t, intId(req.params.id));
    if (rc.status === 'void') throw new HttpError(400, 'เอกสารนี้ถูกยกเลิกแล้ว');
    const reason = requireStr(req.body.reason, 'เหตุผลที่ยกเลิก');
    await db.run("UPDATE receipts SET status = 'void', void_reason = ?, voided_at = now(), voided_by = ? WHERE id = ?", [reason, req.user.id, rc.id]);
    res.json(await getReceipt(t, rc.id));
  });

  return r;
};

module.exports.splitVat = splitVat;
