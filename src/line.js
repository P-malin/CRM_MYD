// เรียก LINE Messaging API (ตั้ง LINE_API_BASE เพื่อชี้ไปเซิร์ฟเวอร์จำลองตอนทดสอบ)
const crypto = require('node:crypto');

const base = () => process.env.LINE_API_BASE || 'https://api.line.me';

class LineError extends Error {}

async function call(token, method, path, body) {
  let res;
  try {
    res = await fetch(`${base()}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    throw new LineError(`เชื่อมต่อ LINE ไม่ได้ (${err.name === 'TimeoutError' ? 'หมดเวลา' : err.message})`);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // ignore non-JSON body
  }
  if (!res.ok) {
    const hint = res.status === 401 ? ' — Channel access token ไม่ถูกต้องหรือหมดอายุ' : res.status === 429 ? ' — ส่งเกินโควตาข้อความของ LINE OA' : '';
    throw new LineError(`LINE ตอบกลับ ${res.status}: ${data.message || text || 'error'}${hint}`);
  }
  return data;
}

// ข้อความเกิน 5,000 ตัวอักษร LINE ไม่รับ
const textMessage = (text) => ({ type: 'text', text: String(text).slice(0, 4900) });

module.exports = {
  LineError,
  botInfo: (token) => call(token, 'GET', '/v2/bot/info'),
  groupSummary: (token, groupId) => call(token, 'GET', `/v2/bot/group/${encodeURIComponent(groupId)}/summary`),
  push: (token, to, text) => call(token, 'POST', '/v2/bot/message/push', { to, messages: [textMessage(text)] }),
  reply: (token, replyToken, text) => call(token, 'POST', '/v2/bot/message/reply', { replyToken, messages: [textMessage(text)] }),
  // ตรวจลายเซ็น webhook: base64(HMAC-SHA256(channel secret, raw body))
  validSignature(secret, rawBody, signature) {
    if (!secret || !rawBody || !signature) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
    const given = Buffer.from(String(signature), 'base64');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  },
};
