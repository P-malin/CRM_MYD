// แปลง error ตอนเชื่อมฐานข้อมูลเป็นคำแนะนำภาษาไทย (ไม่เปิดเผย URI หรือรหัสผ่าน)
function dbErrorHint(err) {
  const msg = String(err?.message || '');
  const code = err?.code || '';
  if (code === 'NO_DATABASE_URL') {
    return 'ยังไม่ได้ตั้ง DATABASE_URL ใน Vercel (Settings → Environment Variables) หรือตั้งไว้ไม่ครบทุก Environment (Production/Preview) — ตั้งแล้วต้อง Redeploy';
  }
  if (/password authentication failed/i.test(msg)) return 'รหัสผ่านใน DATABASE_URL ไม่ถูกต้อง (ถ้าเพิ่ง reset รหัสใน Supabase ต้องแก้ใน Vercel แล้ว Redeploy)';
  if (/tenant or user not found/i.test(msg)) {
    return 'ชื่อผู้ใช้หรือ host ของ pooler ไม่ถูก — ให้คัดลอก URI ใหม่จากปุ่ม Connect → Transaction pooler (ชื่อผู้ใช้ต้องเป็น postgres.<project-id> และ host อาจเป็น aws-0 หรือ aws-1)';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'หา host ของฐานข้อมูลไม่เจอ — ตรวจตัวสะกดใน DATABASE_URL';
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' || /timeout/i.test(msg)) {
    return 'เชื่อมต่อไม่ได้/หมดเวลา — ต้องใช้ Transaction pooler พอร์ต 6543 (ไม่ใช่ Direct connection db.xxx.supabase.co:5432) และโปรเจค Supabase ต้องไม่ถูกพัก (Paused)';
  }
  if (/invalid url|invalid connection|ERR_INVALID_URL/i.test(msg + code)) {
    return 'รูปแบบ DATABASE_URL ไม่ถูกต้อง — ถ้ารหัสผ่านมีอักขระ @ # / ? % : ต้องแปลง (เช่น @ → %40) หรือ reset รหัสให้มีแค่ตัวอักษรกับตัวเลข';
  }
  return 'ดูรายละเอียดใน Vercel → Logs';
}

module.exports = { dbErrorHint };
