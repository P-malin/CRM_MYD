// ประเภทของสถานะ — ระบบใช้คำนวณงานค้าง/เลยกำหนด/ยอดขาย/ส่งตรงเวลา
//   open      = ระหว่างดำเนินการ (ยังไม่ส่งมอบ → นับงานเลยกำหนดส่ง)
//   delivered = ส่งมอบแล้ว รอปิดงาน (บันทึกเวลาส่งมอบ)
//   done      = ปิดงาน
//   cancelled = ยกเลิก (ไม่นับยอดขาย)
const STATUS_KINDS = [
  { key: 'open', label: 'ระหว่างดำเนินการ' },
  { key: 'delivered', label: 'ส่งมอบแล้ว (รอปิดงาน)' },
  { key: 'done', label: 'ปิดงาน' },
  { key: 'cancelled', label: 'ยกเลิก' },
];
// สถานะที่ยังไม่ปิด (แสดงบนบอร์ด / นับเป็นงานที่กำลังดำเนินการ)
const ACTIVE_KINDS = ['open', 'delivered'];

// สถานะงานเริ่มต้นของร้านใหม่ (แต่ละร้านแก้ไข/เพิ่ม/เรียงลำดับเองได้ในหน้าตั้งค่า)
// legacy = สถานะเดิมก่อนมี master (ใช้แปลงงานเก่าตอน migrate)
const DEFAULT_JOB_STATUSES = [
  { name: 'รับลูกค้าใหม่', description: 'มีลูกค้าติดต่อเข้ามา', color: '#64748b', kind: 'open', legacy: 'new' },
  { name: 'รอรายละเอียด', description: 'รอขนาด แบบ หรือข้อมูลเพิ่มเติม', color: '#a855f7', kind: 'open', legacy: 'designing' },
  { name: 'เสนอราคา', description: 'ส่งใบเสนอราคาแล้ว', color: '#8b5cf6', kind: 'open' },
  { name: 'รออนุมัติ', description: 'ลูกค้ากำลังพิจารณา', color: '#f59e0b', kind: 'open', legacy: 'awaiting_approval' },
  { name: 'ยืนยันงาน', description: 'ลูกค้าตกลงสั่งผลิต', color: '#0ea5e9', kind: 'open' },
  { name: 'รอมัดจำ', description: 'รอรับเงินมัดจำ', color: '#eab308', kind: 'open' },
  { name: 'รอผลิต', description: 'เตรียมวัสดุและเริ่มผลิต', color: '#6366f1', kind: 'open' },
  { name: 'กำลังผลิต', description: 'อยู่ระหว่างการผลิต', color: '#3b82f6', kind: 'open', legacy: 'producing' },
  { name: 'รอติดตั้ง/จัดส่ง', description: 'ผลิตเสร็จและรอส่งมอบ', color: '#06b6d4', kind: 'open', legacy: 'installing' },
  { name: 'ติดตั้ง/จัดส่งแล้ว', description: 'ส่งมอบสินค้าให้ลูกค้าแล้ว', color: '#14b8a6', kind: 'delivered' },
  { name: 'รอชำระเงิน', description: 'มียอดคงเหลือที่ต้องเก็บ', color: '#f97316', kind: 'delivered' },
  { name: 'ปิดงาน', description: 'ส่งมอบและชำระเงินครบแล้ว', color: '#22c55e', kind: 'done', legacy: 'completed' },
  { name: 'ยกเลิก', description: 'ลูกค้ายกเลิก/ไม่สั่งผลิต', color: '#ef4444', kind: 'cancelled', legacy: 'cancelled' },
];

// ประเภทงานเริ่มต้นของร้านใหม่ (แต่ละร้านแก้ไข/เพิ่มเองได้ในหน้าตั้งค่า)
// requires_detail = ต้องกรอกรายละเอียดงานเมื่อเลือกประเภทนี้
const DEFAULT_JOB_TYPES = [
  { name: 'อักษรอะคริลิก', description: 'อักษรอะคริลิกตามสีและความหนาที่เลือก' },
  { name: 'อักษรพ่นสี', description: 'อักษรที่ผ่านการพ่นสี' },
  { name: 'อักษรโลหะ', description: 'อักษรผลิตจากวัสดุโลหะ' },
  { name: 'อักษรสแตนเลส', description: 'อักษรสแตนเลสสีเงิน' },
  { name: 'อักษรสแตนเลสสีทอง', description: 'อักษรสแตนเลสสีทอง' },
  { name: 'อักษรไฟสว่างหน้า ขอบซิงค์', description: 'อักษรไฟส่องสว่างด้านหน้า พร้อมขอบซิงค์' },
  { name: 'อักษรไฟสว่างหน้า ขอบสแตนเลส', description: 'อักษรไฟส่องสว่างด้านหน้า พร้อมขอบสแตนเลส' },
  { name: 'งานป้ายอื่น ๆ', description: 'ระบุรายละเอียดเพิ่มเติม', requires_detail: true },
];

const PRIORITIES = [
  { key: 'low', label: 'ต่ำ' },
  { key: 'normal', label: 'ปกติ' },
  { key: 'high', label: 'ด่วน' },
  { key: 'urgent', label: 'ด่วนมาก' },
];

// วิธีส่งมอบงาน — needs_address = ต้องระบุที่อยู่จัดส่ง/ติดตั้ง
const DELIVERY_METHODS = [
  { key: 'shop_delivery', label: 'ร้านจัดส่งสินค้า', needs_address: true },
  { key: 'shop_install', label: 'ร้านเข้าติดตั้งหน้างาน', needs_address: true },
  { key: 'customer_pickup', label: 'ลูกค้ามารับสินค้าเอง' },
  { key: 'customer_install', label: 'ลูกค้านำไปติดตั้งเอง' },
];

const PAYMENT_KINDS = [
  { key: 'deposit', label: 'มัดจำ' },
  { key: 'installment', label: 'ชำระงวด' },
  { key: 'final', label: 'ชำระส่วนที่เหลือ' },
];

const PAYMENT_METHODS = [
  { key: 'cash', label: 'เงินสด' },
  { key: 'transfer', label: 'โอนเงิน' },
  { key: 'promptpay', label: 'พร้อมเพย์' },
  { key: 'cheque', label: 'เช็ค' },
  { key: 'card', label: 'บัตร' },
];

const QUOTE_STATUSES = [
  { key: 'draft', label: 'ร่าง', color: '#64748b' },
  { key: 'sent', label: 'ส่งลูกค้าแล้ว', color: '#3b82f6' },
  { key: 'accepted', label: 'ลูกค้าอนุมัติ', color: '#16a34a' },
  { key: 'rejected', label: 'ไม่อนุมัติ', color: '#dc2626' },
];

// ประเภทเอกสารรับเงิน (tax_invoice ออกได้เฉพาะร้านที่จด VAT)
const RECEIPT_TYPES = [
  { key: 'receipt', label: 'ใบเสร็จรับเงิน', en: 'RECEIPT', prefix: 'RC' },
  { key: 'tax_invoice', label: 'ใบเสร็จรับเงิน/ใบกำกับภาษี', en: 'RECEIPT / TAX INVOICE', prefix: 'IV' },
];

// หมวดไฟล์แนบของงาน
const FILE_CATEGORIES = [
  { key: 'design', label: 'แบบป้าย', icon: '🎨' },
  { key: 'before', label: 'รูปหน้างาน (ก่อนติดตั้ง)', icon: '📷' },
  { key: 'after', label: 'รูปหลังติดตั้ง', icon: '✅' },
  { key: 'other', label: 'อื่น ๆ', icon: '📎' },
];
const FILE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'tif', 'tiff', 'pdf', 'ai', 'eps', 'psd', 'cdr', 'svg', 'dxf', 'dwg', 'zip', 'rar', '7z'];
const MAX_FILE_MB = 20;

const ROLES = [
  { key: 'owner', label: 'เจ้าของร้าน' },
  { key: 'admin', label: 'ผู้ดูแล' },
  { key: 'staff', label: 'พนักงาน' },
];

module.exports = {
  STATUS_KINDS,
  ACTIVE_KINDS,
  DEFAULT_JOB_STATUSES,
  DEFAULT_JOB_TYPES,
  PRIORITIES,
  DELIVERY_METHODS,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  QUOTE_STATUSES,
  RECEIPT_TYPES,
  FILE_CATEGORIES,
  FILE_EXTENSIONS,
  MAX_FILE_MB,
  ROLES,
};
