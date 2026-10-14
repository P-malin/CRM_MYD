/* CRM ร้านป้าย — หน้าเว็บแบบ single-page (vanilla JS) */
'use strict';

const state = { token: localStorage.getItem('token'), me: null, meta: null, users: [], jobTypes: [] };
const $app = document.getElementById('app');

// ---------- helpers ----------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const baht = (n) => `฿${Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
// วันที่จาก API: 'YYYY-MM-DD' (วันที่ล้วน) หรือ ISO timestamp
const parseDate = (s) => new Date(s.length === 10 ? `${s}T00:00:00` : s);
const thDate = (s) => (s ? parseDate(s).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' }) : '-');
const thDateTime = (s) => (s ? parseDate(s).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '-');
const todayStr = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const label = (list, key) => (list.find((x) => x.key === key) || {}).label || key || '-';
const statusOf = (key) => state.meta.JOB_STATUSES.find((s) => s.key === key) || { label: key, color: '#999' };
const badge = (key) => {
  const s = statusOf(key);
  return `<span class="badge" style="background:${s.color}">${esc(s.label)}</span>`;
};
const isOpen = (status) => state.meta.OPEN_STATUSES.includes(status);
const isOverdue = (j) => j.due_date && isOpen(j.status) && j.due_date < todayStr();
const dueHtml = (j) => (j.due_date ? `<span class="${isOverdue(j) ? 'overdue' : ''}">${thDate(j.due_date)}</span>` : '<span class="muted">-</span>');
const prioTag = (p) => (p && p !== 'normal' ? `<span class="tag ${esc(p)}">${esc(label(state.meta.PRIORITIES, p))}</span>` : '');
const isAdmin = () => ['owner', 'admin'].includes(state.me?.user.role);
const size = (j) => (j.width_cm || j.height_cm ? `${j.width_cm ?? '?'} × ${j.height_cm ?? '?'} ซม.` : '-');
const options = (list, selected, { empty } = {}) =>
  (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') +
  list.map((o) => `<option value="${esc(o.key)}" ${String(o.key) === String(selected ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('');

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.token) {
    logoutLocal();
    throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.blob();
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

// ---------- modal ----------
const $modal = document.getElementById('modal');
function openModal(title, html, onSubmit) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  $modal.classList.remove('hidden');
  const form = $modal.querySelector('form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.error');
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await onSubmit(formData(form));
        closeModal();
      } catch (ex) {
        if (err) err.textContent = ex.message;
      } finally {
        btn.disabled = false;
      }
    });
    form.querySelector('input,select,textarea')?.focus();
  }
}
function closeModal() {
  $modal.classList.add('hidden');
}
$modal.addEventListener('click', (e) => {
  if (e.target === $modal || e.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

// ---------- auth ----------
function logoutLocal() {
  state.token = null;
  state.me = null;
  localStorage.removeItem('token');
  if (location.hash === '#/login') route();
  else location.hash = '#/login';
}

async function loadSession() {
  state.me = await api('GET', '/auth/me');
  state.users = await api('GET', '/users');
  state.jobTypes = await api('GET', '/job-types?all=1');
}

function renderAuth(mode) {
  const reg = mode === 'register';
  $app.innerHTML = `
    <div class="auth">
      <h1>🪧 CRM ร้านป้าย</h1>
      <div class="card">
        <h2>${reg ? 'สมัครใช้งานสำหรับร้านของคุณ' : 'เข้าสู่ระบบ'}</h2>
        <form class="form" id="auth-form">
          ${reg ? `<div><label>ชื่อร้าน</label><input name="shop_name" required></div>
                   <div><label>ชื่อของคุณ</label><input name="name" required></div>
                   <div><label>เบอร์โทรร้าน</label><input name="phone"></div>` : ''}
          <div><label>อีเมล</label><input name="email" type="email" required autocomplete="username"></div>
          <div><label>รหัสผ่าน${reg ? ' (อย่างน้อย 8 ตัวอักษร)' : ''}</label>
            <input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}"></div>
          <div class="error"></div>
          <button class="btn primary" type="submit">${reg ? 'สร้างร้านและเริ่มใช้งาน' : 'เข้าสู่ระบบ'}</button>
        </form>
        <p class="muted" style="text-align:center;margin-bottom:0">
          ${reg ? 'มีบัญชีแล้ว? <a href="#/login">เข้าสู่ระบบ</a>' : 'ยังไม่มีบัญชี? <a href="#/register">สมัครใช้งานสำหรับร้านใหม่</a>'}
        </p>
      </div>
    </div>`;
  const form = document.getElementById('auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('POST', reg ? '/auth/register' : '/auth/login', formData(form));
      state.token = token;
      localStorage.setItem('token', token);
      await loadSession();
      location.hash = '#/dashboard';
    } catch (ex) {
      form.querySelector('.error').textContent = ex.message;
    }
  });
}

// ---------- layout ----------
const NAV = [
  ['dashboard', '📊 แดชบอร์ด'],
  ['jobs', '🛠️ งาน'],
  ['customers', '👥 ลูกค้า'],
  ['reports', '📈 รายงาน'],
  ['settings', '⚙️ ตั้งค่า'],
];
function shell(active, content) {
  $app.innerHTML = `
    <div class="shell">
      <nav class="side">
        <div class="brand">🪧 ${esc(state.me.tenant.name)}<small>CRM ร้านป้าย</small></div>
        ${NAV.map(([k, t]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}">${t}</a>`).join('')}
        <div class="spacer"></div>
        <div class="who">${esc(state.me.user.name)} · ${esc(label(state.meta.ROLES, state.me.user.role))}</div>
        <a href="#" id="logout">🚪 ออกจากระบบ</a>
      </nav>
      <main class="main" id="main">${content}</main>
    </div>`;
  document.getElementById('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('POST', '/auth/logout').catch(() => {});
    logoutLocal();
  });
  return document.getElementById('main');
}

// ---------- dashboard ----------
async function viewDashboard() {
  const d = await api('GET', '/reports/dashboard');
  const main = shell('dashboard', `
    <div class="page-head"><h1>แดชบอร์ด</h1><button class="btn primary" id="new-job">+ รับงานใหม่</button></div>
    <div class="grid kpi" style="margin-bottom:16px">
      <div class="kpi-card"><div class="label">งานที่กำลังดำเนินการ</div><div class="value">${d.open_jobs}</div></div>
      <div class="kpi-card ${d.overdue ? 'alert' : ''}"><div class="label">งานเลยกำหนดส่ง</div><div class="value">${d.overdue}</div></div>
      <div class="kpi-card"><div class="label">ครบกำหนดใน 7 วัน</div><div class="value">${d.due_7_days}</div></div>
      <div class="kpi-card"><div class="label">ยอดรับงานเดือนนี้</div><div class="value">${baht(d.month_sales)}</div></div>
      <div class="kpi-card"><div class="label">รับชำระเดือนนี้</div><div class="value">${baht(d.month_collected)}</div></div>
      <div class="kpi-card"><div class="label">ยอดค้างชำระทั้งหมด</div><div class="value">${baht(d.outstanding)}</div></div>
    </div>
    <div class="card">
      <h2>สถานะงาน</h2>
      <div class="status-pills">
        ${state.meta.JOB_STATUSES.map((s) => `
          <a class="status-pill" href="#/jobs?status=${s.key}"><span class="dot" style="background:${s.color}"></span>${esc(s.label)} <b>${d.status_counts[s.key]}</b></a>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>งานที่ใกล้ถึงกำหนดส่ง</h2>
      ${d.upcoming.length ? `<div class="table-wrap"><table>
        <tr><th>เลขที่</th><th>งาน</th><th>ลูกค้า</th><th>สถานะ</th><th>กำหนดส่ง</th></tr>
        ${d.upcoming.map((j) => `<tr class="click" data-href="#/jobs/${j.id}">
          <td class="nowrap">${esc(j.job_no)}</td><td>${esc(j.title)} ${prioTag(j.priority)}</td><td>${esc(j.customer_name)}</td>
          <td>${badge(j.status)}</td><td class="nowrap">${dueHtml(j)}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">ไม่มีงานค้างที่กำหนดวันส่ง</p>'}
    </div>`);
  main.querySelector('#new-job').addEventListener('click', () => jobForm());
}

// ---------- customers ----------
function customerFormHtml(c = {}) {
  const f = (name, text, attrs = '') => `<div><label>${text}</label><input name="${name}" value="${esc(c[name])}" ${attrs}></div>`;
  return `<form class="form">
    ${f('name', 'ชื่อลูกค้า / ผู้ติดต่อ *', 'required')}${f('company', 'บริษัท / ร้าน')}
    ${f('phone', 'เบอร์โทร')}${f('line_id', 'LINE ID')}
    ${f('email', 'อีเมล', 'type="email"')}${f('tax_id', 'เลขผู้เสียภาษี')}
    <div class="full"><label>ที่อยู่</label><textarea name="address">${esc(c.address)}</textarea></div>
    <div class="full"><label>หมายเหตุ</label><textarea name="note">${esc(c.note)}</textarea></div>
    <div class="full error"></div>
    <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
  </form>`;
}

function customerForm(c, after) {
  openModal(c ? 'แก้ไขข้อมูลลูกค้า' : 'เพิ่มลูกค้าใหม่', customerFormHtml(c || {}), async (data) => {
    const saved = await api(c ? 'PUT' : 'POST', c ? `/customers/${c.id}` : '/customers', data);
    toast('บันทึกข้อมูลลูกค้าแล้ว');
    after ? after(saved) : route();
  });
}

async function viewCustomers(params) {
  const q = params.get('q') || '';
  const data = await api('GET', `/customers?limit=200&q=${encodeURIComponent(q)}`);
  const main = shell('customers', `
    <div class="page-head"><h1>ลูกค้า <span class="muted">(${data.total})</span></h1><button class="btn primary" id="add">+ เพิ่มลูกค้า</button></div>
    <form class="toolbar" id="search"><input name="q" placeholder="ค้นหาชื่อ, บริษัท, เบอร์โทร, LINE" value="${esc(q)}" style="min-width:280px"><button class="btn">ค้นหา</button></form>
    <div class="card table-wrap">
      ${data.rows.length ? `<table>
        <tr><th>ชื่อ</th><th>บริษัท</th><th>โทร</th><th>LINE</th><th class="right">จำนวนงาน</th><th class="right">มูลค่ารวม</th><th>งานล่าสุด</th></tr>
        ${data.rows.map((c) => `<tr class="click" data-href="#/customers/${c.id}">
          <td>${esc(c.name)}</td><td>${esc(c.company || '-')}</td><td class="nowrap">${esc(c.phone || '-')}</td><td>${esc(c.line_id || '-')}</td>
          <td class="right">${c.job_count}</td><td class="right">${baht(c.total_value)}</td><td class="nowrap">${thDate(c.last_job_at)}</td></tr>`).join('')}
      </table>` : '<p class="muted">ยังไม่มีข้อมูลลูกค้า</p>'}
    </div>`);
  main.querySelector('#add').addEventListener('click', () => customerForm(null, (c) => (location.hash = `#/customers/${c.id}`)));
  main.querySelector('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#/customers?q=${encodeURIComponent(e.target.q.value)}`;
  });
}

async function viewCustomer(id) {
  const c = await api('GET', `/customers/${id}`);
  const total = c.jobs.filter((j) => j.status !== 'cancelled').reduce((s, j) => s + j.price, 0);
  const paid = c.jobs.filter((j) => j.status !== 'cancelled').reduce((s, j) => s + j.paid, 0);
  const main = shell('customers', `
    <div class="page-head">
      <h1><a href="#/customers" class="muted">ลูกค้า</a> / ${esc(c.name)}</h1>
      <div class="toolbar" style="margin:0">
        <button class="btn" id="edit">แก้ไข</button>
        ${isAdmin() ? '<button class="btn danger" id="del">ลบ</button>' : ''}
        <button class="btn primary" id="new-job">+ รับงานให้ลูกค้านี้</button>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><h2>ข้อมูลลูกค้า</h2><dl class="info">
        <dt>บริษัท/ร้าน</dt><dd>${esc(c.company || '-')}</dd>
        <dt>เบอร์โทร</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '-'}</dd>
        <dt>LINE</dt><dd>${esc(c.line_id || '-')}</dd>
        <dt>อีเมล</dt><dd>${esc(c.email || '-')}</dd>
        <dt>เลขผู้เสียภาษี</dt><dd>${esc(c.tax_id || '-')}</dd>
        <dt>ที่อยู่</dt><dd>${esc(c.address || '-')}</dd>
        <dt>หมายเหตุ</dt><dd>${esc(c.note || '-')}</dd>
        <dt>ลูกค้าตั้งแต่</dt><dd>${thDate(c.created_at)}</dd>
      </dl></div>
      <div class="card"><h2>สรุปยอด</h2>
        <div class="money-row"><span>จำนวนงาน</span><span>${c.jobs.length}</span></div>
        <div class="money-row"><span>มูลค่างานรวม</span><span>${baht(total)}</span></div>
        <div class="money-row"><span>ชำระแล้ว</span><span>${baht(paid)}</span></div>
        <div class="money-row total"><span>ค้างชำระ</span><span>${baht(total - paid)}</span></div>
      </div>
    </div>
    <div class="card table-wrap"><h2>ประวัติงาน</h2>
      ${c.jobs.length ? `<table><tr><th>เลขที่</th><th>งาน</th><th>สถานะ</th><th class="right">ราคา</th><th class="right">ชำระแล้ว</th><th>กำหนดส่ง</th><th>วันที่รับงาน</th></tr>
        ${c.jobs.map((j) => `<tr class="click" data-href="#/jobs/${j.id}"><td class="nowrap">${esc(j.job_no)}</td><td>${esc(j.title)}</td><td>${badge(j.status)}</td>
          <td class="right">${baht(j.price)}</td><td class="right">${baht(j.paid)}</td><td class="nowrap">${dueHtml(j)}</td><td class="nowrap">${thDate(j.created_at)}</td></tr>`).join('')}
      </table>` : '<p class="muted">ยังไม่มีงาน</p>'}
    </div>`);
  main.querySelector('#edit').addEventListener('click', () => customerForm(c));
  main.querySelector('#new-job').addEventListener('click', () => jobForm({ customer_id: c.id }));
  main.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm(`ลบลูกค้า "${c.name}" ?`)) return;
    try {
      await api('DELETE', `/customers/${c.id}`);
      toast('ลบลูกค้าแล้ว');
      location.hash = '#/customers';
    } catch (ex) {
      toast(ex.message, true);
    }
  });
}

// ---------- jobs ----------
async function jobForm(job = {}) {
  const editing = Boolean(job.id);
  const customers = (await api('GET', '/customers?limit=200')).rows;
  if (!customers.length) {
    toast('กรุณาเพิ่มลูกค้าก่อนรับงาน', true);
    location.hash = '#/customers';
    return;
  }
  const users = state.users.filter((u) => u.active || u.id === job.assigned_to);
  // ประเภทที่ปิดใช้งานแล้วจะไม่แสดง ยกเว้นเป็นประเภทเดิมของงานนี้
  const types = state.jobTypes.filter((t) => t.active || t.id === job.job_type_id);
  const legacyType = editing && !job.job_type_id && job.sign_type; // งานเก่าก่อนมี master
  const v = (k) => esc(job[k] ?? '');
  openModal(editing ? `แก้ไขงาน ${job.job_no}` : 'รับงานใหม่', `
    <form class="form">
      <div class="full"><label>ลูกค้า *</label><select name="customer_id" required>
        ${options(customers.map((c) => ({ key: c.id, label: c.company ? `${c.name} (${c.company})` : c.name })), job.customer_id, { empty: '-- เลือกลูกค้า --' })}
      </select></div>
      <div class="full"><label>ชื่องาน *</label><input name="title" required value="${v('title')}" placeholder="เช่น ป้ายหน้าร้านกาแฟ"></div>
      <div class="full"><label>ประเภทงาน *</label><select name="job_type_id" ${legacyType ? '' : 'required'}>
        ${options(types.map((t) => ({ key: t.id, label: t.active ? t.name : `${t.name} (ปิดใช้งาน)` })), job.job_type_id, { empty: legacyType ? `${job.sign_type} (เดิม)` : '-- เลือกประเภทงาน --' })}
        </select><div class="muted" id="type-hint" style="font-size:13px;margin-top:4px"></div></div>
      <div class="full"><label>วัสดุ</label><input name="material" value="${v('material')}" placeholder="เช่น อะคริลิก 5 มม., ไวนิล 380 แกรม"></div>
      <div><label>กว้าง (ซม.)</label><input name="width_cm" type="number" min="0" step="any" value="${v('width_cm')}"></div>
      <div><label>สูง (ซม.)</label><input name="height_cm" type="number" min="0" step="any" value="${v('height_cm')}"></div>
      <div><label>จำนวน</label><input name="quantity" type="number" min="1" step="1" value="${job.quantity ?? 1}"></div>
      <div><label>ราคารวม (บาท)</label><input name="price" type="number" min="0" step="any" value="${v('price')}"></div>
      ${editing ? '' : `<div><label>มัดจำ (บาท)</label><input name="deposit" type="number" min="0" step="any"></div>
        <div><label>ช่องทางชำระมัดจำ</label><select name="deposit_method">${options(state.meta.PAYMENT_METHODS, 'cash')}</select></div>`}
      <div><label>กำหนดส่ง</label><input name="due_date" type="date" value="${v('due_date')}"></div>
      <div><label>ความเร่งด่วน</label><select name="priority">${options(state.meta.PRIORITIES, job.priority || 'normal')}</select></div>
      <div class="full"><label>ผู้รับผิดชอบ</label><select name="assigned_to">${options(users.map((u) => ({ key: u.id, label: u.name })), job.assigned_to, { empty: '-- ยังไม่มอบหมาย --' })}</select></div>
      <div class="full"><label id="desc-label">รายละเอียดงาน</label><textarea name="description">${v('description')}</textarea></div>
      <div class="full check"><input type="checkbox" name="install_required" id="inst" ${job.install_required ? 'checked' : ''}><label for="inst" style="margin:0">ต้องติดตั้งหน้างาน</label></div>
      <div class="full"><label>สถานที่ติดตั้ง</label><textarea name="install_address">${v('install_address')}</textarea></div>
      <div class="full error"></div>
      <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
    </form>`, async (data) => {
    const saved = await api(editing ? 'PUT' : 'POST', editing ? `/jobs/${job.id}` : '/jobs', data);
    toast(editing ? 'บันทึกการแก้ไขแล้ว' : `รับงาน ${saved.job_no} แล้ว`);
    if (location.hash === `#/jobs/${saved.id}`) route();
    else location.hash = `#/jobs/${saved.id}`;
  });
  // แสดงคำอธิบายของประเภทงาน และบังคับกรอกรายละเอียดถ้าประเภทนั้นต้องระบุ
  const form = $modal.querySelector('form');
  const syncType = () => {
    const t = state.jobTypes.find((x) => x.id === Number(form.job_type_id.value));
    form.querySelector('#type-hint').textContent = t?.description || '';
    form.description.required = Boolean(t?.requires_detail);
    form.querySelector('#desc-label').textContent = t?.requires_detail ? 'รายละเอียดงาน * (ประเภทนี้ต้องระบุ)' : 'รายละเอียดงาน';
  };
  form.job_type_id.addEventListener('change', syncType);
  syncType();
}

async function viewJobs(params) {
  const mode = params.get('view') || localStorage.getItem('jobsView') || 'board';
  localStorage.setItem('jobsView', mode);
  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const overdue = params.get('overdue') === '1';
  const assigned = params.get('assigned_to') || '';
  const jobType = params.get('job_type_id') || '';
  const qs = new URLSearchParams({ limit: '200', q, status, assigned_to: assigned, job_type_id: jobType, ...(overdue ? { overdue: '1' } : {}) });
  // มุมมองบอร์ด: ซ่อนงานที่เสร็จ/ยกเลิกเว้นแต่กรองสถานะเอง
  if (mode === 'board' && !status) qs.set('open', '1');
  const data = await api('GET', `/jobs?${qs}`);
  const S = state.meta.JOB_STATUSES;

  const table = `<div class="card table-wrap">${data.rows.length ? `<table>
    <tr><th>เลขที่</th><th>งาน</th><th>ลูกค้า</th><th>ประเภท</th><th>สถานะ</th><th>ผู้รับผิดชอบ</th><th class="right">ราคา</th><th class="right">ค้างชำระ</th><th>กำหนดส่ง</th></tr>
    ${data.rows.map((j) => `<tr class="click" data-href="#/jobs/${j.id}">
      <td class="nowrap">${esc(j.job_no)}</td><td>${esc(j.title)} ${prioTag(j.priority)}</td><td>${esc(j.customer_name)}</td><td>${esc(j.sign_type || '-')}</td>
      <td>${badge(j.status)}</td><td>${esc(j.assigned_name || '-')}</td><td class="right">${baht(j.price)}</td>
      <td class="right">${j.price - j.paid > 0 ? baht(j.price - j.paid) : '-'}</td><td class="nowrap">${dueHtml(j)}</td></tr>`).join('')}
  </table>` : '<p class="muted">ไม่พบงาน</p>'}</div>`;

  const cols = status ? S.filter((s) => status.split(',').includes(s.key)) : S.filter((s) => isOpen(s.key));
  const board = `<div class="board">${cols.map((s) => {
    const items = data.rows.filter((j) => j.status === s.key);
    return `<div class="col"><h3><span>${esc(s.label)}</span><span class="muted">${items.length}</span></h3>
      ${items.map((j) => `<div class="job-card" style="border-color:${s.color}" data-href="#/jobs/${j.id}">
        <div class="no">${esc(j.job_no)} ${prioTag(j.priority)}</div>
        <div class="t">${esc(j.title)}</div>
        <div class="meta"><span>${esc(j.customer_name)}</span><span>${dueHtml(j)}</span></div>
        <div class="meta"><span>${esc(j.sign_type || '')}</span><span>${esc(j.assigned_name || '')}</span></div>
      </div>`).join('')}</div>`;
  }).join('')}</div>`;

  const main = shell('jobs', `
    <div class="page-head"><h1>งาน <span class="muted">(${data.total})</span></h1><button class="btn primary" id="new-job">+ รับงานใหม่</button></div>
    <form class="toolbar" id="filters">
      <input name="q" placeholder="ค้นหาเลขที่, ชื่องาน, ลูกค้า" value="${esc(q)}">
      <select name="status">${options(S, status, { empty: mode === 'board' ? 'งานที่ยังไม่เสร็จ' : 'ทุกสถานะ' })}</select>
      <select name="job_type_id">${options(state.jobTypes.map((t) => ({ key: t.id, label: t.name })), jobType, { empty: 'ทุกประเภทงาน' })}</select>
      <select name="assigned_to">${options(state.users.map((u) => ({ key: u.id, label: u.name })), assigned, { empty: 'ผู้รับผิดชอบทั้งหมด' })}</select>
      <label class="check" style="display:flex;gap:6px;align-items:center;margin:0"><input type="checkbox" name="overdue" ${overdue ? 'checked' : ''} style="width:auto"> เฉพาะงานเลยกำหนด</label>
      <button class="btn">กรอง</button>
      <span style="flex:1"></span>
      <button type="button" class="btn small ${mode === 'board' ? 'primary' : ''}" data-view="board">บอร์ด</button>
      <button type="button" class="btn small ${mode === 'table' ? 'primary' : ''}" data-view="table">ตาราง</button>
    </form>
    ${mode === 'board' ? board : table}`);

  const form = main.querySelector('#filters');
  const go = (view) => {
    const f = formData(form);
    const p = new URLSearchParams({ view });
    for (const k of ['q', 'status', 'job_type_id', 'assigned_to']) if (f[k]) p.set(k, f[k]);
    if (f.overdue) p.set('overdue', '1');
    location.hash = `#/jobs?${p}`;
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go(mode);
  });
  main.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
  main.querySelector('#new-job').addEventListener('click', () => jobForm());
}

// สถานะถัดไปตามลำดับขั้นตอน (ใช้เป็นค่าเริ่มต้นตอนเปลี่ยนสถานะ)
function nextStatus(key) {
  const open = state.meta.OPEN_STATUSES;
  const i = open.indexOf(key);
  return i === -1 ? '' : open[i + 1] || 'completed';
}

async function viewJob(id) {
  const j = await api('GET', `/jobs/${id}`);
  const M = state.meta;
  const remaining = j.price - j.paid;
  const pct = j.price > 0 ? Math.min(100, Math.round((j.paid / j.price) * 100)) : 0;
  const main = shell('jobs', `
    <div class="page-head">
      <h1><a href="#/jobs" class="muted">งาน</a> / ${esc(j.job_no)} ${badge(j.status)}</h1>
      <div class="toolbar" style="margin:0">
        <button class="btn" onclick="window.print()">พิมพ์</button>
        <button class="btn" id="edit">แก้ไข</button>
        ${isAdmin() ? '<button class="btn danger" id="del">ลบงาน</button>' : ''}
      </div>
    </div>
    <div class="grid two">
      <div class="card"><h2>${esc(j.title)} ${prioTag(j.priority)}</h2><dl class="info">
        <dt>ลูกค้า</dt><dd><a href="#/customers/${j.customer_id}">${esc(j.customer_name)}</a>${j.customer_company ? ` (${esc(j.customer_company)})` : ''}${j.customer_phone ? ` · <a href="tel:${esc(j.customer_phone)}">${esc(j.customer_phone)}</a>` : ''}</dd>
        <dt>ประเภทงาน</dt><dd>${esc(j.sign_type || '-')}</dd>
        <dt>วัสดุ</dt><dd>${esc(j.material || '-')}</dd>
        <dt>ขนาด</dt><dd>${size(j)}</dd>
        <dt>จำนวน</dt><dd>${j.quantity}</dd>
        <dt>กำหนดส่ง</dt><dd>${dueHtml(j)}${isOverdue(j) ? ' (เลยกำหนด)' : ''}</dd>
        <dt>ผู้รับผิดชอบ</dt><dd>${esc(j.assigned_name || '-')}</dd>
        <dt>ติดตั้ง</dt><dd>${j.install_required ? `ต้องติดตั้ง${j.install_address ? `\n${esc(j.install_address)}` : ''}` : 'ไม่ต้องติดตั้ง'}</dd>
        <dt>รายละเอียด</dt><dd>${esc(j.description || '-')}</dd>
        <dt>วันที่รับงาน</dt><dd>${thDateTime(j.created_at)}</dd>
        ${j.completed_at ? `<dt>วันที่เสร็จ</dt><dd>${thDateTime(j.completed_at)}</dd>` : ''}
      </dl></div>
      <div>
        <div class="card"><h2>อัปเดตสถานะ</h2>
          <form id="status-form" class="form" style="grid-template-columns:1fr">
            <select name="status">${options(M.JOB_STATUSES.filter((s) => s.key !== j.status), nextStatus(j.status))}</select>
            <input name="note" placeholder="หมายเหตุ (ถ้ามี)">
            <button class="btn primary" type="submit">เปลี่ยนสถานะ</button>
          </form>
        </div>
        <div class="card"><h2>การชำระเงิน</h2>
          <div class="money-row"><span>ราคารวม</span><span>${baht(j.price)}</span></div>
          <div class="money-row"><span>ชำระแล้ว</span><span>${baht(j.paid)}</span></div>
          <div class="progress"><span style="width:${pct}%"></span></div>
          <div class="money-row total"><span>คงค้าง</span><span class="${remaining > 0 ? 'overdue' : ''}">${baht(remaining)}</span></div>
          ${j.payments.length ? `<table style="margin-top:10px"><tr><th>วันที่</th><th>ประเภท</th><th>ช่องทาง</th><th class="right">จำนวน</th>${isAdmin() ? '<th></th>' : ''}</tr>
            ${j.payments.map((p) => `<tr><td class="nowrap">${thDate(p.paid_at)}</td><td>${esc(label(M.PAYMENT_KINDS, p.kind))}${p.note ? `<div class="muted">${esc(p.note)}</div>` : ''}</td>
              <td>${esc(label(M.PAYMENT_METHODS, p.method))}</td><td class="right">${baht(p.amount)}</td>
              ${isAdmin() ? `<td><button class="icon-btn" data-delpay="${p.id}" title="ลบรายการ">🗑</button></td>` : ''}</tr>`).join('')}</table>` : ''}
          <div style="margin-top:12px"><button class="btn" id="add-pay">+ บันทึกรับชำระ</button></div>
        </div>
      </div>
    </div>
    <div class="card"><h2>ประวัติสถานะ</h2><ul class="timeline">
      ${j.logs.map((l) => `<li>${l.from_status ? `${badge(l.from_status)} → ` : ''}${badge(l.to_status)}
        <span class="muted"> · ${thDateTime(l.created_at)} · ${esc(l.user_name || '-')}</span>${l.note ? `<div>${esc(l.note)}</div>` : ''}</li>`).join('')}
    </ul></div>`);

  main.querySelector('#edit').addEventListener('click', () => jobForm(j));
  main.querySelector('#status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/jobs/${j.id}/status`, formData(e.target));
      toast('อัปเดตสถานะแล้ว');
      route();
    } catch (ex) {
      toast(ex.message, true);
    }
  });
  main.querySelector('#add-pay').addEventListener('click', () => {
    openModal('บันทึกรับชำระเงิน', `<form class="form">
      <div><label>จำนวนเงิน (บาท) *</label><input name="amount" type="number" min="0.01" step="any" required value="${remaining > 0 ? remaining : ''}"></div>
      <div><label>วันที่ชำระ</label><input name="paid_at" type="date" value="${todayStr()}"></div>
      <div><label>ประเภท</label><select name="kind">${options(M.PAYMENT_KINDS, j.paid > 0 ? 'final' : 'deposit')}</select></div>
      <div><label>ช่องทาง</label><select name="method">${options(M.PAYMENT_METHODS, 'transfer')}</select></div>
      <div class="full"><label>หมายเหตุ</label><input name="note"></div>
      <div class="full error"></div>
      <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
    </form>`, async (data) => {
      await api('POST', `/jobs/${j.id}/payments`, data);
      toast('บันทึกการชำระเงินแล้ว');
      route();
    });
  });
  main.querySelectorAll('[data-delpay]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('ลบรายการชำระเงินนี้?')) return;
      await api('DELETE', `/jobs/${j.id}/payments/${b.dataset.delpay}`).catch((ex) => toast(ex.message, true));
      route();
    }),
  );
  main.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm(`ลบงาน ${j.job_no}? ข้อมูลการชำระเงินและประวัติจะถูกลบด้วย`)) return;
    await api('DELETE', `/jobs/${j.id}`);
    toast('ลบงานแล้ว');
    location.hash = '#/jobs';
  });
}

// ---------- reports ----------
function monthRange(offset) {
  const d = new Date();
  const first = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + offset + 1, 0);
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [f(first), offset === 0 ? todayStr() : f(last)];
}

async function viewReports(params) {
  const [defFrom, defTo] = monthRange(0);
  const from = params.get('from') || defFrom;
  const to = params.get('to') || defTo;
  const r = await api('GET', `/reports/summary?from=${from}&to=${to}`);
  const T = r.totals;
  const maxMonth = Math.max(1, ...r.monthly.map((m) => Math.max(m.sales, m.collected)));
  const maxType = Math.max(1, ...r.by_sign_type.map((x) => x.value));
  const thMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('th-TH', { month: 'short', year: '2-digit' });
  const y = new Date().getFullYear();

  const main = shell('reports', `
    <div class="page-head"><h1>รายงาน</h1></div>
    <form class="toolbar" id="range">
      <label style="margin:0">ตั้งแต่</label><input type="date" name="from" value="${from}">
      <label style="margin:0">ถึง</label><input type="date" name="to" value="${to}">
      <button class="btn primary">แสดงรายงาน</button>
      <button type="button" class="btn small" data-range="${monthRange(0).join(',')}">เดือนนี้</button>
      <button type="button" class="btn small" data-range="${monthRange(-1).join(',')}">เดือนที่แล้ว</button>
      <button type="button" class="btn small" data-range="${monthRange(-2)[0]},${todayStr()}">3 เดือนล่าสุด</button>
      <button type="button" class="btn small" data-range="${y}-01-01,${todayStr()}">ปีนี้</button>
      <span style="flex:1"></span>
      <button type="button" class="btn" id="csv">⬇ ส่งออก CSV</button>
      <button type="button" class="btn" onclick="window.print()">พิมพ์</button>
    </form>
    <p class="muted">ช่วงวันที่ ${thDate(r.from)} – ${thDate(r.to)}</p>
    <div class="grid kpi" style="margin-bottom:16px">
      <div class="kpi-card"><div class="label">งานที่รับเข้า</div><div class="value">${T.jobs}</div></div>
      <div class="kpi-card"><div class="label">ยอดรับงาน (ไม่รวมยกเลิก)</div><div class="value">${baht(T.sales)}</div></div>
      <div class="kpi-card"><div class="label">ยอดรับชำระ</div><div class="value">${baht(T.collected)}</div></div>
      <div class="kpi-card"><div class="label">งานเสร็จในช่วงนี้</div><div class="value">${T.completed_in_range}</div></div>
      <div class="kpi-card"><div class="label">ส่งงานตรงเวลา</div><div class="value">${T.on_time_rate === null ? '-' : `${T.on_time_rate}%`}</div></div>
      <div class="kpi-card"><div class="label">ลูกค้าใหม่</div><div class="value">${T.new_customers}</div></div>
    </div>
    <div class="card"><div class="page-head" style="margin-bottom:0"><h2>ยอดรายเดือน</h2>
      <div class="legend"><span style="--c:var(--primary)">ยอดรับงาน</span><span style="--c:var(--ok)">ยอดรับชำระ</span></div></div>
      <div class="bars">${r.monthly.map((m) => `<div class="bar-group" title="${thMonth(m.month)}: รับงาน ${baht(m.sales)} / รับชำระ ${baht(m.collected)}">
        <div class="bar-pair"><div class="bar sales" style="height:${(m.sales / maxMonth) * 100}%"></div><div class="bar collected" style="height:${(m.collected / maxMonth) * 100}%"></div></div>
        <div class="bar-label">${thMonth(m.month)}</div></div>`).join('')}</div>
    </div>
    <div class="grid two">
      <div class="card"><h2>ยอดตามประเภทงาน</h2>
        ${r.by_sign_type.length ? `<table>${r.by_sign_type.map((x) => `<tr><td>${esc(x.sign_type)}<div class="hbar" style="width:${(x.value / maxType) * 100}%"></div></td>
          <td class="right nowrap">${x.jobs} งาน</td><td class="right nowrap">${baht(x.value)}</td></tr>`).join('')}</table>` : '<p class="muted">ไม่มีข้อมูล</p>'}
      </div>
      <div class="card"><h2>งานแยกตามสถานะ</h2>
        ${r.by_status.length ? `<table>${state.meta.JOB_STATUSES.map((s) => {
          const x = r.by_status.find((b) => b.status === s.key);
          return x ? `<tr><td>${badge(s.key)}</td><td class="right">${x.jobs} งาน</td><td class="right">${baht(x.value)}</td></tr>` : '';
        }).join('')}</table>` : '<p class="muted">ไม่มีข้อมูล</p>'}
      </div>
      <div class="card"><h2>ลูกค้ายอดสูงสุด</h2>
        ${r.top_customers.length ? `<table><tr><th>ลูกค้า</th><th class="right">งาน</th><th class="right">มูลค่า</th></tr>
          ${r.top_customers.map((c) => `<tr class="click" data-href="#/customers/${c.id}"><td>${esc(c.name)}${c.company ? `<div class="muted">${esc(c.company)}</div>` : ''}</td>
          <td class="right">${c.jobs}</td><td class="right">${baht(c.value)}</td></tr>`).join('')}</table>` : '<p class="muted">ไม่มีข้อมูล</p>'}
      </div>
      <div class="card"><h2>ผลงานพนักงาน</h2>
        ${r.by_staff.length ? `<table><tr><th>พนักงาน</th><th class="right">งาน</th><th class="right">เสร็จ</th><th class="right">ค้าง</th><th class="right">มูลค่า</th></tr>
          ${r.by_staff.map((s) => `<tr><td>${esc(s.name)}</td><td class="right">${s.jobs}</td><td class="right">${s.completed}</td><td class="right">${s.open}</td><td class="right">${baht(s.value)}</td></tr>`).join('')}</table>` : '<p class="muted">ไม่มีข้อมูล</p>'}
      </div>
    </div>`);

  const go = (f, t) => (location.hash = `#/reports?from=${f}&to=${t}`);
  main.querySelector('#range').addEventListener('submit', (e) => {
    e.preventDefault();
    go(e.target.from.value, e.target.to.value);
  });
  main.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => go(...b.dataset.range.split(','))));
  main.querySelector('#csv').addEventListener('click', async () => {
    try {
      const blob = await api('GET', `/reports/jobs.csv?from=${from}&to=${to}`);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `jobs_${from}_${to}.csv` });
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (ex) {
      toast(ex.message, true);
    }
  });
}

// ---------- settings ----------
function jobTypeFormHtml(t = {}) {
  return `<form class="form">
    <div class="full"><label>ชื่อประเภทงาน *</label><input name="name" required value="${esc(t.name)}"></div>
    <div class="full"><label>รายละเอียด</label><input name="description" value="${esc(t.description)}"></div>
    <div class="full check"><input type="checkbox" name="requires_detail" id="rd" ${t.requires_detail ? 'checked' : ''}>
      <label for="rd" style="margin:0">ต้องกรอกรายละเอียดงานเมื่อเลือกประเภทนี้ (เช่น งานอื่น ๆ)</label></div>
    ${t.id ? `<div class="full check"><input type="checkbox" name="active" id="ta" ${t.active ? 'checked' : ''}><label for="ta" style="margin:0">เปิดใช้งาน (ปิดแล้วจะไม่แสดงตอนรับงานใหม่)</label></div>` : ''}
    <div class="full error"></div>
    <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
  </form>`;
}

async function viewSettings() {
  state.users = await api('GET', '/users');
  state.jobTypes = await api('GET', '/job-types?all=1');
  const t = state.me.tenant;
  const admin = isAdmin();
  const main = shell('settings', `
    <div class="page-head"><h1>ตั้งค่า</h1></div>
    <div class="grid two">
      <div class="card"><h2>ข้อมูลร้าน</h2>
        <form class="form" id="shop">
          <div class="full"><label>ชื่อร้าน *</label><input name="name" required value="${esc(t.name)}" ${admin ? '' : 'disabled'}></div>
          <div><label>เบอร์โทร</label><input name="phone" value="${esc(t.phone)}" ${admin ? '' : 'disabled'}></div>
          <div><label>อีเมล</label><input name="email" type="email" value="${esc(t.email)}" ${admin ? '' : 'disabled'}></div>
          <div class="full"><label>เลขผู้เสียภาษี</label><input name="tax_id" value="${esc(t.tax_id)}" ${admin ? '' : 'disabled'}></div>
          <div class="full"><label>ที่อยู่</label><textarea name="address" ${admin ? '' : 'disabled'}>${esc(t.address)}</textarea></div>
          ${admin ? '<div class="full form-actions"><button class="btn primary">บันทึก</button></div>' : ''}
        </form>
      </div>
      <div class="card"><h2>เปลี่ยนรหัสผ่าน</h2>
        <form class="form" id="pw" style="grid-template-columns:1fr">
          <div><label>รหัสผ่านปัจจุบัน</label><input type="password" name="current_password" required autocomplete="current-password"></div>
          <div><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input type="password" name="new_password" required minlength="8" autocomplete="new-password"></div>
          <div class="form-actions"><button class="btn primary">เปลี่ยนรหัสผ่าน</button></div>
        </form>
      </div>
    </div>
    <div class="card table-wrap">
      <div class="page-head"><h2 style="margin:0">ประเภทงาน</h2>${admin ? '<button class="btn primary" id="add-type">+ เพิ่มประเภทงาน</button>' : ''}</div>
      <table><tr><th>ประเภทงาน</th><th>รายละเอียด</th><th>ต้องระบุรายละเอียด</th><th class="right">จำนวนงาน</th><th>สถานะ</th>${admin ? '<th></th>' : ''}</tr>
        ${state.jobTypes.map((jt) => `<tr><td>${esc(jt.name)}</td><td>${esc(jt.description || '-')}</td><td>${jt.requires_detail ? '✓' : ''}</td>
          <td class="right">${jt.job_count}</td><td>${jt.active ? 'ใช้งาน' : '<span class="muted">ปิดใช้งาน</span>'}</td>
          ${admin ? `<td class="nowrap"><button class="btn small" data-edit-type="${jt.id}">แก้ไข</button>
            ${jt.job_count ? '' : `<button class="btn small danger" data-del-type="${jt.id}">ลบ</button>`}</td>` : ''}</tr>`).join('')}
      </table>
    </div>
    <div class="card table-wrap">
      <div class="page-head"><h2 style="margin:0">ผู้ใช้งานในร้าน</h2>${admin ? '<button class="btn primary" id="add-user">+ เพิ่มผู้ใช้</button>' : ''}</div>
      <table><tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์</th><th>สถานะ</th>${admin ? '<th></th>' : ''}</tr>
        ${state.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(label(state.meta.ROLES, u.role))}</td>
          <td>${u.active ? 'ใช้งาน' : '<span class="muted">ปิดใช้งาน</span>'}</td>
          ${admin ? `<td>${u.id !== state.me.user.id ? `<button class="btn small" data-edit-user="${u.id}">แก้ไข</button>` : ''}</td>` : ''}</tr>`).join('')}
      </table>
    </div>`);

  main.querySelector('#add-type')?.addEventListener('click', () =>
    openModal('เพิ่มประเภทงาน', jobTypeFormHtml(), async (data) => {
      await api('POST', '/job-types', data);
      toast('เพิ่มประเภทงานแล้ว');
      route();
    }),
  );
  main.querySelectorAll('[data-edit-type]').forEach((b) =>
    b.addEventListener('click', () => {
      const jt = state.jobTypes.find((x) => x.id === Number(b.dataset.editType));
      openModal(`แก้ไขประเภทงาน`, jobTypeFormHtml(jt), async (data) => {
        await api('PUT', `/job-types/${jt.id}`, data);
        toast('บันทึกประเภทงานแล้ว');
        route();
      });
    }),
  );
  main.querySelectorAll('[data-del-type]').forEach((b) =>
    b.addEventListener('click', async () => {
      const jt = state.jobTypes.find((x) => x.id === Number(b.dataset.delType));
      if (!confirm(`ลบประเภทงาน "${jt.name}"?`)) return;
      try {
        await api('DELETE', `/job-types/${jt.id}`);
        toast('ลบประเภทงานแล้ว');
        route();
      } catch (ex) {
        toast(ex.message, true);
      }
    }),
  );
  main.querySelector('#shop').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.me.tenant = await api('PUT', '/tenant', formData(e.target));
      toast('บันทึกข้อมูลร้านแล้ว');
      route();
    } catch (ex) {
      toast(ex.message, true);
    }
  });
  main.querySelector('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/auth/password', formData(e.target));
      e.target.reset();
      toast('เปลี่ยนรหัสผ่านแล้ว');
    } catch (ex) {
      toast(ex.message, true);
    }
  });
  const roles = state.me.user.role === 'owner' ? state.meta.ROLES : state.meta.ROLES.filter((r) => r.key !== 'owner');
  main.querySelector('#add-user')?.addEventListener('click', () =>
    openModal('เพิ่มผู้ใช้งาน', `<form class="form">
      <div><label>ชื่อ *</label><input name="name" required></div>
      <div><label>สิทธิ์</label><select name="role">${options(roles, 'staff')}</select></div>
      <div><label>อีเมล (ใช้เข้าสู่ระบบ) *</label><input name="email" type="email" required></div>
      <div><label>รหัสผ่าน (อย่างน้อย 8 ตัว) *</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div class="full error"></div>
      <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">เพิ่ม</button></div>
    </form>`, async (data) => {
      await api('POST', '/users', data);
      toast('เพิ่มผู้ใช้แล้ว');
      route();
    }),
  );
  main.querySelectorAll('[data-edit-user]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.users.find((x) => x.id === Number(b.dataset.editUser));
      openModal(`แก้ไขผู้ใช้ ${u.email}`, `<form class="form">
        <div><label>ชื่อ</label><input name="name" value="${esc(u.name)}" required></div>
        <div><label>สิทธิ์</label><select name="role">${options(u.role === 'owner' ? state.meta.ROLES : roles, u.role)}</select></div>
        <div><label>ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)</label><input name="password" type="password" minlength="8" autocomplete="new-password"></div>
        <div class="check" style="align-self:end"><input type="checkbox" name="active" id="act" ${u.active ? 'checked' : ''}><label for="act" style="margin:0">เปิดใช้งาน</label></div>
        <div class="full error"></div>
        <div class="full form-actions"><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary" type="submit">บันทึก</button></div>
      </form>`, async (data) => {
        if (!data.password) delete data.password;
        await api('PUT', `/users/${u.id}`, data);
        toast('บันทึกแล้ว');
        route();
      });
    }),
  );
}

// ---------- router ----------
async function route() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  if (!state.token) return renderAuth(parts[0] === 'register' ? 'register' : 'login');
  try {
    if (!state.me) await loadSession();
    switch (parts[0]) {
      case 'jobs':
        return parts[1] ? await viewJob(parts[1]) : await viewJobs(params);
      case 'customers':
        return parts[1] ? await viewCustomer(parts[1]) : await viewCustomers(params);
      case 'reports':
        return await viewReports(params);
      case 'settings':
        return await viewSettings();
      case 'dashboard':
        return await viewDashboard();
      default:
        location.hash = '#/dashboard';
    }
  } catch (ex) {
    toast(ex.message, true);
    if (state.me) shell(parts[0], `<div class="card"><p>${esc(ex.message)}</p><a href="#/dashboard">กลับหน้าแดชบอร์ด</a></div>`);
  }
}

// คลิกแถวตาราง/การ์ดที่มี data-href เพื่อไปหน้ารายละเอียด
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-href]');
  if (el && !e.target.closest('a,button')) location.hash = el.dataset.href;
});
window.addEventListener('hashchange', route);

(async () => {
  state.meta = await api('GET', '/meta');
  route();
})();
