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

const SIGN_TYPES = [
  'ป้ายไวนิล',
  'ป้ายอะคริลิก',
  'ป้ายกล่องไฟ',
  'ตัวอักษรสแตนเลส/โลหะ',
  'ป้ายไฟ LED/นีออน',
  'สติ๊กเกอร์/ฟิล์ม',
  'ป้ายโครงเหล็ก/บิลบอร์ด',
  'ป้ายบอกทาง/ป้ายจราจร',
  'อื่นๆ',
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
  SIGN_TYPES,
  PRIORITIES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  ROLES,
};
