// สถานะงานตามลำดับขั้นตอนของร้านป้าย
const JOB_STATUSES = [
  { key: 'new', label: 'รับงานใหม่', color: '#64748b' },
  { key: 'designing', label: 'กำลังออกแบบ', color: '#8b5cf6' },
  { key: 'awaiting_approval', label: 'รอลูกค้าอนุมัติแบบ', color: '#f59e0b' },
  { key: 'producing', label: 'กำลังผลิต', color: '#3b82f6' },
  { key: 'installing', label: 'รอติดตั้ง/ส่งมอบ', color: '#06b6d4' },
  { key: 'completed', label: 'เสร็จสิ้น', color: '#22c55e' },
  { key: 'cancelled', label: 'ยกเลิก', color: '#ef4444' },
];
const STATUS_KEYS = JOB_STATUSES.map((s) => s.key);
// สถานะที่ถือว่างานยังไม่จบ (ใช้คำนวณงานค้าง / เลยกำหนด)
const OPEN_STATUSES = STATUS_KEYS.filter((k) => k !== 'completed' && k !== 'cancelled');

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

const ROLES = [
  { key: 'owner', label: 'เจ้าของร้าน' },
  { key: 'admin', label: 'ผู้ดูแล' },
  { key: 'staff', label: 'พนักงาน' },
];

module.exports = {
  JOB_STATUSES,
  STATUS_KEYS,
  OPEN_STATUSES,
  DEFAULT_JOB_TYPES,
  PRIORITIES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  ROLES,
};
