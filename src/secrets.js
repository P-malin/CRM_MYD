// เข้ารหัสค่าลับ (เช่น LINE token) ก่อนเก็บลงฐานข้อมูล ด้วย AES-256-GCM
// กุญแจมาจาก env APP_SECRET — ถ้าไม่ได้ตั้ง จะเก็บแบบไม่เข้ารหัส (เหมาะกับรันบนเครื่องตัวเองเท่านั้น)
const crypto = require('node:crypto');

const key = () => (process.env.APP_SECRET ? crypto.createHash('sha256').update(process.env.APP_SECRET).digest() : null);

function sealSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const k = key();
  if (!k) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function openSecret(sealed) {
  if (!sealed) return null;
  if (sealed.startsWith('plain:')) return sealed.slice(6);
  const [ver, iv, tag, ct] = sealed.split(':');
  const k = key();
  if (ver !== 'v1' || !k) throw new Error('ถอดรหัสค่าลับไม่ได้ (ตรวจ APP_SECRET)');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { sealSecret, openSecret };
