const crypto = require('node:crypto');
const express = require('express');
const { requireRole } = require('../auth');
const { HttpError, str, appUrl } = require('../util');
const line = require('../line');
const { sealSecret, openSecret } = require('../secrets');

const lineError = (err) => (err instanceof line.LineError ? new HttpError(400, err.message) : err);

// webhook จาก LINE (ไม่ต้องล็อกอิน แต่ตรวจลายเซ็นด้วย channel secret ของร้าน)
function lineWebhookRoutes(db) {
  const r = express.Router();
  r.post('/line/webhook/:key', async (req, res) => {
    const t = await db.one('SELECT id, line_token, line_secret, line_group_id FROM tenants WHERE line_webhook_key = ?', [String(req.params.key)]);
    if (!t || !t.line_secret) throw new HttpError(404, 'ไม่พบ webhook');
    if (!line.validSignature(openSecret(t.line_secret), req.rawBody, req.get('x-line-signature'))) throw new HttpError(401, 'ลายเซ็นไม่ถูกต้อง');
    const token = t.line_token && openSecret(t.line_token);
    await db.run('UPDATE tenants SET line_last_webhook_at = now() WHERE id = ?', [t.id]);

    for (const ev of Array.isArray(req.body.events) ? req.body.events : []) {
      const groupId = ev.source?.type === 'group' ? ev.source.groupId : null;
      if (!groupId) continue;
      if (ev.type === 'leave') {
        await db.run('UPDATE tenants SET line_group_id = NULL, line_group_name = NULL WHERE id = ? AND line_group_id = ?', [t.id, groupId]);
        continue;
      }
      // บอทถูกเชิญเข้ากลุ่ม หรือมีข้อความในกลุ่มขณะยังไม่ได้ผูกกลุ่ม → ผูกกลุ่มนี้
      if (ev.type === 'join' || (ev.type === 'message' && !t.line_group_id)) {
        let groupName = null;
        if (token) groupName = (await line.groupSummary(token, groupId).catch(() => ({}))).groupName || null;
        await db.run('UPDATE tenants SET line_group_id = ?, line_group_name = ? WHERE id = ?', [groupId, groupName, t.id]);
        t.line_group_id = groupId;
        if (token && ev.replyToken) {
          await line
            .reply(token, ev.replyToken, '✅ เชื่อมต่อ MYD Easy กับกลุ่มนี้แล้ว\nระบบจะแจ้งเตือนเมื่อมีงานใหม่และเมื่อเปลี่ยนสถานะงาน')
            .catch((err) => console.error('ตอบกลับ LINE ไม่สำเร็จ:', err.message));
        }
      }
    }
    res.json({ ok: true });
  });
  return r;
}

// ตั้งค่า LINE ของร้าน (เจ้าของร้าน/ผู้ดูแล)
function lineSettingsRoutes(db) {
  const r = express.Router();
  const admin = requireRole('owner', 'admin');

  const settings = async (req) => {
    const t = await db.one(
      `SELECT line_enabled, line_token, line_secret, line_bot_name, line_group_id, line_group_name, line_webhook_key, line_last_webhook_at
       FROM tenants WHERE id = ?`,
      [req.user.tenant_id],
    );
    // ไม่ส่ง token/secret กลับไปที่หน้าเว็บ บอกแค่ว่าตั้งแล้วหรือยัง
    return {
      enabled: t.line_enabled,
      has_token: Boolean(t.line_token),
      has_secret: Boolean(t.line_secret),
      bot_name: t.line_bot_name,
      group_id: t.line_group_id,
      group_name: t.line_group_name,
      last_webhook_at: t.line_last_webhook_at,
      webhook_url: t.line_webhook_key ? `${appUrl(req)}/api/line/webhook/${t.line_webhook_key}` : null,
    };
  };

  r.get('/line/settings', admin, async (req, res) => res.json(await settings(req)));

  r.put('/line/settings', admin, async (req, res) => {
    const tid = req.user.tenant_id;
    const b = req.body;
    const cur = await db.one('SELECT line_token, line_webhook_key FROM tenants WHERE id = ?', [tid]);
    const token = str(b.token);
    const secret = str(b.secret);
    if (token) {
      // ตรวจ token กับ LINE ก่อนบันทึก และเก็บชื่อบอทไว้แสดง
      const info = await line.botInfo(token).catch((err) => {
        throw lineError(err);
      });
      await db.run('UPDATE tenants SET line_token = ?, line_bot_name = ? WHERE id = ?', [sealSecret(token), info.displayName || info.basicId || null, tid]);
    }
    if (secret) await db.run('UPDATE tenants SET line_secret = ? WHERE id = ?', [sealSecret(secret), tid]);
    if (!cur.line_webhook_key) await db.run('UPDATE tenants SET line_webhook_key = ? WHERE id = ?', [crypto.randomBytes(18).toString('base64url'), tid]);
    if (b.enabled !== undefined) {
      if (b.enabled && !token && !cur.line_token) throw new HttpError(400, 'กรุณาใส่ Channel access token ก่อนเปิดการแจ้งเตือน');
      await db.run('UPDATE tenants SET line_enabled = ? WHERE id = ?', [Boolean(b.enabled), tid]);
    }
    res.json(await settings(req));
  });

  r.post('/line/test', admin, async (req, res) => {
    const t = await db.one('SELECT name, line_token, line_group_id FROM tenants WHERE id = ?', [req.user.tenant_id]);
    if (!t.line_token) throw new HttpError(400, 'ยังไม่ได้ใส่ Channel access token');
    if (!t.line_group_id) throw new HttpError(400, 'ยังไม่ได้ผูกกลุ่ม LINE — เชิญบอทเข้ากลุ่มก่อน');
    await line.push(openSecret(t.line_token), t.line_group_id, `🧪 ทดสอบการแจ้งเตือนจาก MYD Easy\nร้าน: ${t.name}\nโดย: ${req.user.name}`).catch((err) => {
      throw lineError(err);
    });
    res.json({ ok: true });
  });

  r.delete('/line/group', admin, async (req, res) => {
    await db.run('UPDATE tenants SET line_group_id = NULL, line_group_name = NULL WHERE id = ?', [req.user.tenant_id]);
    res.json(await settings(req));
  });

  // ล้างการเชื่อมต่อทั้งหมด
  r.delete('/line/settings', admin, async (req, res) => {
    await db.run(
      `UPDATE tenants SET line_enabled = false, line_token = NULL, line_secret = NULL, line_bot_name = NULL,
         line_group_id = NULL, line_group_name = NULL WHERE id = ?`,
      [req.user.tenant_id],
    );
    res.json(await settings(req));
  });

  return r;
}

module.exports = { lineWebhookRoutes, lineSettingsRoutes };
