// แปลงจำนวนเงินเป็นตัวหนังสือภาษาไทย เช่น 10500.25 → "หนึ่งหมื่นห้าร้อยบาทยี่สิบห้าสตางค์"
(function (root) {
  const DIGIT = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const PLACE = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

  // อ่านกลุ่มไม่เกิน 6 หลัก; hasHigher = มีหลักล้านขึ้นไปอยู่ด้านหน้า (1 ในหลักหน่วยอ่านว่า "เอ็ด")
  function readGroup(str, hasHigher) {
    const s = str.replace(/^0+/, '');
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const d = Number(s[i]);
      const pos = s.length - 1 - i;
      if (!d) continue;
      if (pos === 1) out += d === 1 ? 'สิบ' : d === 2 ? 'ยี่สิบ' : `${DIGIT[d]}สิบ`;
      else if (pos === 0 && d === 1 && (s.length > 1 || hasHigher)) out += 'เอ็ด';
      else out += DIGIT[d] + PLACE[pos];
    }
    return out;
  }

  function readInt(str) {
    if (str.length > 6) return `${readInt(str.slice(0, -6))}ล้าน${readGroup(str.slice(-6), true)}`;
    return readGroup(str, false);
  }

  function bahtText(amount) {
    const n = Math.round(Math.abs(Number(amount) || 0) * 100);
    const baht = String(Math.floor(n / 100));
    const satang = n % 100;
    if (n === 0) return 'ศูนย์บาทถ้วน';
    let out = Number(amount) < 0 ? 'ลบ' : '';
    if (baht !== '0') out += `${readInt(baht)}บาท`;
    out += satang ? `${readGroup(String(satang), false)}สตางค์` : 'ถ้วน';
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = bahtText;
  else root.bahtText = bahtText;
})(this);
