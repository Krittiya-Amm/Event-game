const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let key = store.get('admin-key');
let cfg = null;        // { settings, prizes, days, coupons }
let overview = null;
let pane = 'dashboard';
let timer = null;

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const fmtClock = (iso) => iso ? new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '';
const thaiDate = (d, opts = {}) => new Date(`${d}T00:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok', ...opts });
const KNOWN_ART = new Set(['doll', 'keychain', 'card']);
const prizeById = (id) => cfg?.prizes.find((p) => p.id === id) || { id, name: id, emoji: '🎁', color: '#5b2be0' };
// Uploaded image → built-in illustration → emoji.
const artInner = (p) => (p.image ? `<img src="${esc(p.image)}" alt="">`
  : KNOWN_ART.has(p.id) ? `<img src="/img/prizes/${esc(p.id)}.svg" alt="">` : esc(p.emoji));
const art = (p, cls = '') => `<span class="art ${cls}">${artInner(p)}</span>`;

// ---------- feedback ----------
function toast(msg, err = false) {
  const t = $('#toast');
  t.innerHTML = `${err ? '' : icon('check')}<span>${esc(msg)}</span>`;
  t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

function confirmBox(title, text, yes = 'ยืนยัน') {
  const d = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = yes;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true }));
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-admin-key': key || '', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'บันทึกไม่สำเร็จ'); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ---------- auth ----------
$('#pw-toggle').addEventListener('click', () => {
  const i = $('#login-form').password;
  i.type = i.type === 'password' ? 'text' : 'password';
});
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  const res = await fetch('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: f.username.value, password: f.password.value }),
  }).catch(() => null);
  btn.disabled = false;
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok) { $('#login-err').textContent = res ? (data.error || 'เข้าสู่ระบบไม่สำเร็จ') : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'; f.password.select(); return; }
  key = data.token;
  store.set('admin-key', key);
  f.password.value = '';
  $('#login-err').textContent = '';
  enter();
});
function logout() {
  store.del('admin-key'); key = null; clearInterval(timer);
  $('#main').hidden = true; $('#login').hidden = false;
}
$('#logout').addEventListener('click', async () => {
  if (!(await guardLeave())) return;
  fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-key': key || '' } }).catch(() => {});
  logout();
});

async function enter() {
  $('#login').hidden = true; $('#main').hidden = false;
  await loadConfig();
  await refreshOverview();
  clearInterval(timer);
  timer = setInterval(() => refreshOverview().catch(() => {}), 10000);
  openTab(location.hash.slice(1) || 'dashboard');
}

async function loadConfig() {
  cfg = await api('/api/admin/config');
  $('#side-event').textContent = cfg.settings.event_name || '';
}

// ---------- unsaved-change handling ----------
// Each editable pane registers { isDirty, save, reset }. The bottom bar appears whenever the current pane is dirty.
const editors = {};
function syncSavebar() {
  const ed = editors[pane];
  $('#savebar').hidden = !(ed && ed.isDirty());
}
$('#save-cancel').addEventListener('click', () => { editors[pane]?.reset(); syncSavebar(); });
$('#save-ok').addEventListener('click', async () => {
  const btn = $('#save-ok');
  btn.disabled = true;
  try { const msg = await editors[pane].save(); syncSavebar(); toast(msg || 'บันทึกแล้ว'); } catch (err) { if (err.message !== 'unauthorized') toast(err.message, true); } finally { btn.disabled = false; }
});
async function guardLeave() {
  const ed = editors[pane];
  if (!ed || !ed.isDirty()) return true;
  const ok = await confirmBox('ออกโดยไม่บันทึก?', 'การแก้ไขในหน้านี้ยังไม่ได้บันทึก ถ้าออกตอนนี้การแก้ไขจะหายไป', 'ออกโดยไม่บันทึก');
  if (ok) ed.reset();
  return ok;
}
window.addEventListener('beforeunload', (e) => { if (editors[pane]?.isDirty()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- navigation ----------
const PAGES = {
  dashboard: ['ภาพรวม', 'สถานะเกมและรางวัลแบบเรียลไทม์'],
  players: ['ผู้เล่น', 'รายชื่อ Lead ผลรางวัล และสถานะการรับ'],
  slots: ['รางวัล', 'ของรางวัลและจำนวนที่แจกในแต่ละวัน'],
  schedule: ['วันและเวลา', 'เลือกช่วงวันจัดงานและเวลาเปิดเกม'],
  coupons: ['โปรโมชัน', 'Digital coupon ที่สุ่มให้ผู้ได้รางวัล'],
  settings: ['ตั้งค่าเกม', 'ชื่องาน สิทธิ์เล่น และปุ่ม CTA'],
};
const RENDER = { dashboard: renderDashboard, players: showPlayers, slots: showSlots, schedule: showSchedule, coupons: showCoupons, settings: showSettings };

async function openTab(name) {
  if (!PAGES[name]) name = 'dashboard';
  if (name !== pane && !(await guardLeave())) return;
  pane = name;
  if (location.hash !== `#${name}`) history.pushState(null, '', `#${name}`);
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  $('#page-title').textContent = PAGES[name][0];
  $('#page-sub').textContent = PAGES[name][1];
  closeMenu();
  window.scrollTo({ top: 0 });
  await RENDER[name]();
  syncSavebar();
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (key && h && h !== pane) openTab(h); });
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) openTab(g.dataset.goto); });

const closeMenu = () => { $('#side').classList.remove('open'); $('#scrim').hidden = true; };
$('#menu-btn').addEventListener('click', () => { $('#side').classList.add('open'); $('#scrim').hidden = false; });
$('#scrim').addEventListener('click', closeMenu);

// ---------- overview (status pill, badge, dashboard) ----------
async function refreshOverview() {
  overview = await api('/api/admin/overview');
  const live = overview.days.find((d) => d.day_no === overview.openDayNo);
  const pill = $('#status-pill');
  pill.className = `status-pill ${live ? 'live' : 'off'}`;
  pill.innerHTML = live
    ? `<span class="txt">เกมเปิดอยู่ · </span>Day ${live.day_no} ถึง ${esc(overview.closeTime)}`
    : `${icon('clock')}<span class="txt">เกมปิดอยู่ · </span>${esc(overview.now.time)} น.`;
  const nb = $('#nav-pending');
  nb.hidden = !overview.pending;
  nb.textContent = overview.pending;
  nb.title = `${overview.pending} คนยังไม่ได้รับรางวัล`;
  if (pane === 'dashboard') renderDashboard();
}

function renderDashboard() {
  if (!overview) return;
  const d = overview;
  const live = d.days.find((x) => x.day_no === d.openDayNo);
  const totalPlayed = d.days.reduce((a, x) => a + x.played, 0);
  const totalRedeemed = d.days.reduce((a, x) => a + x.redeemed, 0);

  if (live) {
    const left = live.limit - live.played;
    $('#today').innerHTML = `
      <div class="today-main">
        <span class="today-label">รางวัลคงเหลือวันนี้ · Day ${live.day_no} (${thaiDate(live.date)})</span>
        <div class="today-num">${left}<small> / ${live.limit}</small></div>
        <div class="meter" title="แจกไปแล้ว ${live.played} รางวัล"><span style="width:${live.limit ? (live.played / live.limit) * 100 : 0}%"></span></div>
        <span class="muted small">แจกไปแล้ว ${live.played} · เปิดถึง ${esc(live.close_time)} น.</span>
      </div>
      <div class="today-prizes">${live.byPrize.map((r) => {
        const p = prizeById(r.prizeId);
        return `<div class="prize-row">${art(p)}<div><span class="name">${esc(p.name)}</span>
          <div class="bar"><span style="width:${r.total ? (r.given / r.total) * 100 : 0}%;background:${esc(p.color)}"></span></div></div>
          ${!r.total ? '<span class="badge mute">ไม่มีวันนี้</span>' : `<span class="badge ${r.left ? 'mute' : 'warn'}">${r.left ? `เหลือ ${r.left}` : 'หมดแล้ว'}</span>`}</div>`;
      }).join('')}</div>`;
  } else {
    const next = d.days.find((x) => x.date > d.now.date || (x.date === d.now.date && d.now.time < x.open_time));
    $('#today').innerHTML = `<div class="empty-today">
      <span class="today-label">ตอนนี้เกมปิดอยู่</span>
      <h2>${next ? `เปิดครั้งถัดไป ${thaiDate(next.date, { weekday: 'long' })} เวลา ${esc(next.open_time)} น.` : 'กิจกรรมจบแล้ว'}</h2>
      <p class="muted small">ปรับวันและเวลาได้ที่ <button class="link-btn" type="button" data-goto="schedule">วันและเวลา</button></p></div>`;
  }

  $('#kpis').innerHTML = [
    ['users', `ลงทะเบียน (Lead) · ยินยอม ${d.consented}`, d.players, ''],
    ['gift', 'ได้รางวัลทั้งหมด', totalPlayed, ''],
    ['check', 'รับรางวัลแล้ว', totalRedeemed, ''],
    ['clock', 'รอรับรางวัล', d.pending, d.pending ? 'warn' : ''],
  ].map(([ic, l, v, cls]) => (ic === 'clock'
    ? `<button class="kpi ${cls}" type="button" data-goto-pending><span class="l">${icon(ic)}${l}</span><span class="v">${v}</span></button>`
    : `<div class="kpi ${cls}"><span class="l">${icon(ic)}${l}</span><span class="v">${v}</span></div>`)).join('');
  $('[data-goto-pending]').onclick = () => { playerFilter.status = 'pending'; openTab('players'); };

  $('#feed').innerHTML = d.recent.length ? d.recent.map((r) => {
    const p = prizeById(r.prize_id);
    return `<li>${art(p)}<div class="who"><b>${esc(r.name)}</b><span>${esc(p.name)} · ${fmtClock(r.created_at)} น.</span></div>
      ${r.redeemed_at ? `<span class="badge ok">${icon('check')}รับแล้ว</span>` : '<span class="badge warn">รอรับ</span>'}</li>`;
  }).join('') : '<li class="empty">ยังไม่มีผู้เล่น</li>';

  $('#day-list').innerHTML = d.days.map((x) => `
    <div class="day-row ${x.day_no === d.openDayNo ? 'live' : ''}">
      <div><b>Day ${x.day_no}</b><span class="muted">${thaiDate(x.date)} · ${esc(x.open_time)}–${esc(x.close_time)}</span></div>
      <div class="meter"><span style="width:${x.limit ? (x.played / x.limit) * 100 : 0}%"></span></div>
      <span class="count">${x.played}/${x.limit}</span>
    </div>`).join('');
}

// ---------- players ----------
const playerFilter = { q: '', status: '', day: '' };
let searchTimer = null;

async function showPlayers() {
  const sel = $('#player-day');
  sel.innerHTML = '<option value="">ทุกวัน</option>' + cfg.days.map((d) => `<option value="${d.day_no}">Day ${d.day_no} · ${thaiDate(d.date)}</option>`).join('');
  sel.value = playerFilter.day;
  $('#player-q').value = playerFilter.q;
  $$('#player-status button').forEach((b) => b.classList.toggle('on', b.dataset.v === playerFilter.status));
  await loadPlayers();
}

async function loadPlayers() {
  const qs = new URLSearchParams(playerFilter).toString();
  const { rows, total } = await api(`/api/admin/plays?${qs}`);
  $('#player-count').textContent = `ผู้เล่น ${total} คน${total > rows.length ? ` (แสดง ${rows.length} ล่าสุด)` : ''}`;
  $('#players-body').innerHTML = rows.length ? rows.map((r) => {
    const p = prizeById(r.prize_id);
    return `<tr>
      <td><div class="person"><b>${esc(r.name)}</b><span>${esc(r.company)}</span></div></td>
      <td class="nowrap">${esc(r.phone)}</td>
      <td class="nowrap">${esc(cfg.services.find((s) => s.id === r.interest)?.label || '-')}</td>
      <td>${r.consent ? `<span class="badge ok">${icon('check')}ยินยอม</span>` : '<span class="badge mute">ไม่ยินยอม</span>'}</td>
      <td><div class="prize-cell">${art(p)}<div>${esc(r.prize)}<small>Day ${r.day_no} · คนที่ ${r.slot_no}</small></div></div></td>
      <td><code class="code">${esc(r.code)}</code></td>
      <td class="nowrap muted">${fmtTime(r.created_at)}</td>
      <td class="nowrap">${r.redeemed_at
        ? `<span class="badge ok" title="${esc(r.redeemed_by)} · ${fmtTime(r.redeemed_at)}">${icon('check')}รับแล้ว</span>`
        : `<button class="btn btn-sm" type="button" data-redeem="${esc(r.code)}" data-name="${esc(r.name)}" data-prize="${esc(r.prize)}">ยืนยันรับ</button>`}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8"><div class="empty">${playerFilter.q || playerFilter.status || playerFilter.day ? 'ไม่พบผู้เล่นตามเงื่อนไขนี้' : 'ยังไม่มีผู้เล่น'}</div></td></tr>`;
}

$('#player-q').addEventListener('input', (e) => {
  playerFilter.q = e.target.value;
  clearTimeout(searchTimer); searchTimer = setTimeout(loadPlayers, 250);
});
$('#player-day').addEventListener('change', (e) => { playerFilter.day = e.target.value; loadPlayers(); });
$('#player-status').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  playerFilter.status = b.dataset.v;
  $$('#player-status button').forEach((x) => x.classList.toggle('on', x === b));
  loadPlayers();
});
$('#players-body').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-redeem]'); if (!b) return;
  const ok = await confirmBox('ยืนยันการรับรางวัล?', `${b.dataset.name} ได้รับ "${b.dataset.prize}" (โค้ด ${b.dataset.redeem}) เรียบร้อยแล้ว`, 'ยืนยันรับแล้ว');
  if (!ok) return;
  try {
    await api('/api/admin/redeem', { method: 'POST', body: { code: b.dataset.redeem } });
    toast('บันทึกการรับรางวัลแล้ว');
  } catch (err) { toast(err.status === 409 ? 'โค้ดนี้รับรางวัลไปแล้ว' : err.message, true); }
  loadPlayers(); refreshOverview();
});

$('#export').addEventListener('click', async () => {
  const res = await fetch('/api/admin/export.csv', { headers: { 'x-admin-key': key } });
  if (!res.ok) return toast('Export ไม่สำเร็จ', true);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export.csv';
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('ดาวน์โหลดไฟล์ CSV แล้ว');
});

// ---------- rewards (prize list × count per day) ----------
let rw = null; // { prizes, days, counts, given, original }
const PALETTE = ['#f59e0b', '#ec4899', '#6366f1', '#10b981', '#06b6d4', '#ef4444', '#8b5cf6', '#84cc16'];
const rwSnapshot = () => ({ prizes: rw.prizes, counts: rw.counts });

async function showSlots() {
  const data = await api('/api/admin/rewards');
  const counts = {};
  for (const d of data.days) counts[d.day_no] = Object.fromEntries(data.prizes.map((p) => [p.id, data.counts[d.day_no]?.[p.id] || 0]));
  rw = { prizes: data.prizes.map(({ id, name, emoji, color, image }) => ({ id, name, emoji, color, image: image || null })), days: data.days, counts, given: data.given };
  rw.original = clone(rwSnapshot());
  renderRewards();
}

function renderRewards() {
  const days = rw.days;
  const sum = (dayNo) => rw.prizes.reduce((a, p) => a + (Number(rw.counts[dayNo]?.[p.id]) || 0), 0);
  const rowTotal = (id) => days.reduce((a, d) => a + (Number(rw.counts[d.day_no]?.[id]) || 0), 0);
  $('#reward-table').innerHTML = `
    <thead><tr><th>ของรางวัล</th>${days.map((d) => `<th class="num">Day ${d.day_no}<small>${thaiDate(d.date)}</small></th>`).join('')}<th class="num">รวม</th><th></th></tr></thead>
    <tbody>${rw.prizes.map((p, i) => `
      <tr data-i="${i}">
        <td><div class="reward-name">
          <span class="art-edit">
            <button class="art-btn" type="button" data-upload title="เปลี่ยนรูปรางวัล" aria-label="เปลี่ยนรูป ${esc(p.name)}">${art(p, 'lg')}<span class="cam">${icon('camera')}</span></button>
            ${p.image ? `<button class="art-reset" type="button" data-unimage title="ใช้รูปเริ่มต้น" aria-label="ลบรูปที่อัปโหลด">×</button>` : ''}
          </span>
          <input name="name" value="${esc(p.name)}" maxlength="60" placeholder="ชื่อรางวัล" aria-label="ชื่อรางวัล">
          ${KNOWN_ART.has(p.id) || p.image ? '' : `<input class="emoji-in" name="emoji" value="${esc(p.emoji)}" maxlength="4" aria-label="อีโมจิ" title="อีโมจิ (ใช้เมื่อไม่มีรูป)">`}
          <input type="color" name="color" value="${esc(p.color)}" aria-label="สี" title="สี"></div></td>
        ${days.map((d) => {
          const given = rw.given[d.day_no]?.[p.id] || 0;
          return `<td class="num"><input class="count" type="number" min="${given}" inputmode="numeric" data-day="${d.day_no}" value="${rw.counts[d.day_no]?.[p.id] ?? 0}" aria-label="${esc(p.name)} Day ${d.day_no}">
            ${given ? `<small class="given">แจกแล้ว ${given}</small>` : ''}</td>`;
        }).join('')}
        <td class="num"><b>${rowTotal(p.id)}</b></td>
        <td><button class="icon-btn danger" type="button" data-remove aria-label="ลบ ${esc(p.name)}">${icon('trash')}</button></td>
      </tr>`).join('')}</tbody>
    <tfoot><tr><th>ผู้ได้รางวัลต่อวัน</th>${days.map((d) => `<th class="num">${sum(d.day_no)}</th>`).join('')}<th class="num">${days.reduce((a, d) => a + sum(d.day_no), 0)}</th><th></th></tr></tfoot>`;
  if (!days.length) $('#reward-table').innerHTML = '<tbody><tr><td><div class="empty">ยังไม่มีวันจัดงาน — ตั้งได้ที่ "วันและเวลา"</div></td></tr></tbody>';
  syncSavebar();
}

$('#reward-table').addEventListener('input', (e) => {
  const row = e.target.closest('tr[data-i]'); if (!row) return;
  const p = rw.prizes[Number(row.dataset.i)];
  if (e.target.classList.contains('count')) {
    rw.counts[e.target.dataset.day][p.id] = Math.max(0, Math.floor(Number(e.target.value) || 0));
    // update totals without re-rendering (keeps focus while typing)
    const days = rw.days;
    row.querySelector('td:nth-last-child(2) b').textContent = days.reduce((a, d) => a + (Number(rw.counts[d.day_no]?.[p.id]) || 0), 0);
    const foot = $$('#reward-table tfoot th');
    days.forEach((d, i) => { foot[i + 1].textContent = rw.prizes.reduce((a, q) => a + (Number(rw.counts[d.day_no]?.[q.id]) || 0), 0); });
    foot[days.length + 1].textContent = days.reduce((a, d) => a + rw.prizes.reduce((b, q) => b + (Number(rw.counts[d.day_no]?.[q.id]) || 0), 0), 0);
  } else if (e.target.name) {
    p[e.target.name] = e.target.value;
    if (e.target.name !== 'name') row.querySelector('.art').innerHTML = artInner(p);
  }
  syncSavebar();
});
// ---- prize image upload (resized in the browser so phones load it fast) ----
let uploadFor = null;
$('#reward-table').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-i]'); if (!row) return;
  const p = rw.prizes[Number(row.dataset.i)];
  if (e.target.closest('[data-upload]')) { uploadFor = p; $('#prize-file').value = ''; $('#prize-file').click(); }
  if (e.target.closest('[data-unimage]')) { p.image = null; renderRewards(); }
});
function shrinkImage(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/webp', 0.9);
    };
    img.onerror = () => reject(new Error('เปิดไฟล์รูปไม่ได้'));
    img.src = URL.createObjectURL(file);
  });
}
$('#prize-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file || !uploadFor) return;
  const p = uploadFor; uploadFor = null;
  try {
    const blob = file.type === 'image/gif' ? file : await shrinkImage(file); // keep GIF animation as-is
    const res = await fetch('/api/admin/upload', { method: 'POST', headers: { 'x-admin-key': key, 'Content-Type': blob.type || file.type }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    p.image = data.url;
    renderRewards();
    toast('อัปโหลดรูปแล้ว — กด "บันทึก" เพื่อใช้งาน');
  } catch (err) { toast(err.message, true); }
});

$('#reward-table').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-remove]')) return;
  const i = Number(e.target.closest('tr[data-i]').dataset.i);
  const p = rw.prizes[i];
  const given = rw.days.reduce((a, d) => a + (rw.given[d.day_no]?.[p.id] || 0), 0);
  if (given) return toast(`"${p.name}" มีผู้ได้รับไปแล้ว ${given} ชิ้น ลบไม่ได้ — ตั้งจำนวนเป็น 0 แทน`, true);
  if (!(await confirmBox(`ลบ "${p.name || 'รางวัลนี้'}"?`, 'รางวัลนี้จะถูกเอาออกจากทุกวัน · มีผลเมื่อกดบันทึก', 'ลบ'))) return;
  rw.prizes.splice(i, 1);
  for (const d of rw.days) delete rw.counts[d.day_no][p.id];
  renderRewards();
});
$('#reward-add').addEventListener('click', () => {
  const id = `p-${Date.now().toString(36)}`;
  rw.prizes.push({ id, name: '', emoji: '🎁', color: PALETTE[rw.prizes.length % PALETTE.length], image: null });
  for (const d of rw.days) rw.counts[d.day_no][id] = 0;
  renderRewards();
  $$('#reward-table tbody input[name=name]').at(-1)?.focus();
});
$('#reward-copy').addEventListener('click', () => {
  const first = rw.days[0]; if (!first) return;
  for (const d of rw.days.slice(1)) {
    for (const p of rw.prizes) rw.counts[d.day_no][p.id] = Math.max(rw.counts[first.day_no][p.id] || 0, rw.given[d.day_no]?.[p.id] || 0);
  }
  renderRewards();
  toast('คัดลอกจำนวนของ Day 1 แล้ว — กด "บันทึก" เพื่อใช้งาน');
});
editors.slots = {
  isDirty: () => !!rw && !same(rwSnapshot(), rw.original),
  reset: () => { const o = clone(rw.original); rw.prizes = o.prizes; rw.counts = o.counts; renderRewards(); },
  save: async () => {
    if (rw.prizes.some((p) => !p.name.trim())) throw new Error('กรุณาตั้งชื่อของรางวัลให้ครบ');
    await api('/api/admin/rewards', { method: 'PUT', body: rwSnapshot() });
    await loadConfig();
    await showSlots();
    refreshOverview();
  },
};

// ---------- schedule (date range, booking style) ----------
let sched = null;     // { start, end, open, close } — the same hours every day
let schedOrig = null;
let calMonth = null;  // first day of the left month, 'YYYY-MM-01'
let picking = 'start';
const iso = (d) => d.toISOString().slice(0, 10);
const dt = (s) => new Date(`${s}T00:00:00Z`);
const addD = (s, n) => { const d = dt(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((dt(b) - dt(a)) / 86400000);
const fmtLong = (s) => new Date(`${s}T00:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const rangeDates = () => {
  if (!sched.start || !sched.end) return [];
  const out = []; for (let d = sched.start; d <= sched.end; d = addD(d, 1)) out.push(d); return out;
};

function showSchedule() {
  const ds = cfg.days;
  // Default hours = the most common pair among existing days.
  const tally = {}; for (const d of ds) { const k = `${d.open_time}-${d.close_time}`; tally[k] = (tally[k] || 0) + 1; }
  const common = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0]?.split('-') || ['09:00', '18:00'];
  sched = { start: ds[0]?.date || null, end: ds[ds.length - 1]?.date || null, open: common[0], close: common[1] };
  // Older data may have different hours per day; saving will make them all the same.
  sched.mixed = Object.keys(tally).length > 1;
  schedOrig = clone(sched);
  calMonth = `${(sched.start || overview.now.date).slice(0, 7)}-01`;
  picking = 'start';
  $('#time-open').value = sched.open;
  $('#time-close').value = sched.close;
  renderRange();
}

function renderRange() {
  $('#range-start').textContent = sched.start ? fmtLong(sched.start) : 'เลือกวัน';
  $('#range-end').textContent = sched.end ? fmtLong(sched.end) : 'เลือกวัน';
  $$('.range-field').forEach((b) => b.classList.toggle('on', b.dataset.pick === picking));
  const dates = rangeDates();
  $('#range-days').innerHTML = dates.length ? `<b>${dates.length}</b> วัน` : '';
  const played = (overview?.days || []).filter((d) => d.played > 0).reduce((a, d) => a + d.played, 0);
  $('#range-help').textContent = (picking === 'start' ? 'แตะวันแรกของงาน' : 'แตะวันสุดท้ายของงาน')
    + (played ? ` · ตอนนี้มีผู้เล่นแล้ว ${played} คน ถ้าเลื่อนวันที่มีผู้เล่น ระบบจะถามให้ล้างข้อมูลทดสอบก่อน` : '');

  const months = innerWidth > 860 ? 2 : 1;
  const today = overview.now.date;
  const minDate = schedOrig.start && schedOrig.start < today ? schedOrig.start : today; // keep the current start selectable
  let html = '';
  for (let m = 0; m < months; m++) {
    const first = dt(calMonth); first.setUTCMonth(first.getUTCMonth() + m);
    const y = first.getUTCFullYear(); const mo = first.getUTCMonth();
    const title = new Date(Date.UTC(y, mo, 1)).toLocaleDateString('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const lead = first.getUTCDay();
    const len = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span></span>';
    for (let d = 1; d <= len; d++) {
      const s = iso(new Date(Date.UTC(y, mo, d)));
      const inRange = sched.start && sched.end && s >= sched.start && s <= sched.end;
      const off = s < minDate;
      const cls = [inRange ? 'in' : '', s === sched.start ? 'start' : '', s === sched.end ? 'end' : '', s === today ? 'is-today' : '', off ? 'past' : ''].join(' ');
      cells += `<button type="button" class="day ${cls}" data-date="${s}" ${off ? 'disabled' : ''} aria-label="${fmtLong(s)}" aria-pressed="${!!inRange}">${d}</button>`;
    }
    html += `<div class="cal"><div class="cal-title">${title}</div>
      <div class="cal-grid">${['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'].map((w) => `<span class="dow">${w}</span>`).join('')}${cells}</div></div>`;
  }
  $('#cals').innerHTML = html;

  const bad = !sched.open || !sched.close || sched.open >= sched.close;
  $('#time-note').innerHTML = bad ? '<span class="badge warn">เวลาเปิดต้องก่อนเวลาปิด</span>'
    : sched.mixed ? '<span class="muted">ตอนนี้บางวันมีเวลาไม่เหมือนกัน · กดบันทึกเพื่อให้ทุกวันใช้เวลานี้</span>' : '';
  syncSavebar();
}

$('#cals').addEventListener('click', (e) => {
  const b = e.target.closest('[data-date]'); if (!b) return;
  const s = b.dataset.date;
  if (picking === 'start' || !sched.start || s < sched.start) {
    sched.start = s;
    if (!sched.end || sched.end < s || daysBetween(s, sched.end) > 30) sched.end = null;
    picking = 'end';
  } else {
    if (daysBetween(sched.start, s) > 30) return toast('เลือกได้ไม่เกิน 31 วัน', true);
    sched.end = s;
    picking = 'start';
  }
  renderRange();
});
$$('.range-field').forEach((b) => b.addEventListener('click', () => {
  picking = b.dataset.pick;
  const target = sched[picking] || sched.start;
  if (target) calMonth = `${target.slice(0, 7)}-01`;
  renderRange();
}));
const shiftMonth = (n) => { const d = dt(calMonth); d.setUTCMonth(d.getUTCMonth() + n); calMonth = iso(d); renderRange(); };
$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));
$('#time-open').addEventListener('input', (e) => { sched.open = e.target.value; renderRange(); });
$('#time-close').addEventListener('input', (e) => { sched.close = e.target.value; renderRange(); });
addEventListener('resize', () => { if (pane === 'schedule' && sched) renderRange(); });

async function resetPlays() {
  const ok = await confirmBox('ล้างข้อมูลผู้เล่นทดสอบ?',
    'ผู้เล่นและผลการเล่นทั้งหมดจะถูกลบถาวร (ควร Export CSV เก็บไว้ก่อน) · ของรางวัล จำนวน วันเวลา และโปรโมชันยังอยู่', 'ล้างข้อมูล');
  if (!ok) return false;
  const r = await api('/api/admin/reset-plays', { method: 'POST', body: { confirm: 'RESET' } });
  await refreshOverview();
  toast(`ล้างแล้ว: ผู้เล่น ${r.players} คน · ผลการเล่น ${r.plays} รายการ`);
  return true;
}

editors.schedule = {
  isDirty: () => !!sched && (!same(sched, schedOrig) || sched.mixed),
  reset: () => showSchedule(),
  save: async () => {
    if (!sched.start || !sched.end) throw new Error('กรุณาเลือกวันเริ่มและวันสุดท้าย');
    if (!sched.open || !sched.close || sched.open >= sched.close) throw new Error('เวลาเปิดต้องก่อนเวลาปิด');
    const before = cfg.days.length;
    const body = { start: sched.start, end: sched.end, open_time: sched.open, close_time: sched.close };
    try {
      await api('/api/admin/schedule', { method: 'PUT', body });
    } catch (err) {
      if (err.data?.code !== 'has_players') throw err;
      // Moving days that already have (test) players: offer to clear them, then save again.
      if (!(await resetPlays())) throw new Error('ยังไม่ได้บันทึก — วันที่มีผู้เล่นแล้วเลื่อนไม่ได้');
      await api('/api/admin/schedule', { method: 'PUT', body });
    }
    await loadConfig();
    await refreshOverview();
    showSchedule();
    if (cfg.days.length > before) return 'บันทึกแล้ว · วันที่เพิ่มใช้จำนวนรางวัลเหมือนวันสุดท้ายเดิม ปรับได้ที่เมนู "รางวัล"';
    return 'บันทึกวันและเวลาแล้ว';
  },
};

// ---------- coupons ----------
let coupons = null;
const normCoupon = (c) => ({ ...c, service: c.service || '', active: c.active ? 1 : 0 });
function showCoupons() { coupons = clone(cfg.coupons).map(normCoupon); renderCoupons(); }
function renderCoupons() {
  $('#coupon-list').innerHTML = coupons.map((c, i) => `
    <div class="card coupon-row ${c.active ? '' : 'off'}" data-i="${i}">
      <input name="brand" value="${esc(c.brand)}" maxlength="60" placeholder="แบรนด์" aria-label="แบรนด์">
      <input class="benefit" name="benefit" value="${esc(c.benefit)}" maxlength="200" placeholder="สิทธิ์ที่ได้รับ" aria-label="สิทธิ์">
      <select name="service" aria-label="ให้กับผู้ที่สนใจบริการ" title="ให้กับผู้ที่สนใจบริการ">
        <option value="">ทุกบริการ (สำรอง)</option>
        ${cfg.services.map((s) => `<option value="${esc(s.id)}" ${c.service === s.id ? 'selected' : ''}>สนใจ: ${esc(s.label)}</option>`).join('')}
      </select>
      <label class="switch"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><span class="track"></span>${c.active ? 'เปิดใช้' : 'ปิดอยู่'}</label>
      <button class="icon-btn danger" type="button" data-remove aria-label="ลบ">${icon('trash')}</button>
    </div>`).join('') || '<div class="card empty">ยังไม่มีโปรโมชัน</div>';
  syncSavebar();
}
$('#coupon-list').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]'); if (!row) return;
  const c = coupons[Number(row.dataset.i)];
  if (e.target.name === 'active') { c.active = e.target.checked ? 1 : 0; renderCoupons(); return; }
  c[e.target.name] = e.target.value;
  syncSavebar();
});
$('#coupon-list').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-remove]')) return;
  const i = Number(e.target.closest('[data-i]').dataset.i);
  if (!(await confirmBox('ลบโปรโมชันนี้?', `${coupons[i].brand || 'โปรโมชันนี้'} จะไม่ถูกสุ่มให้ผู้เล่นอีก · มีผลเมื่อกดบันทึก`, 'ลบ'))) return;
  coupons.splice(i, 1);
  renderCoupons();
});
$('#coupon-add').addEventListener('click', () => {
  coupons.push({ brand: '', benefit: '', service: '', active: 1 });
  renderCoupons();
  $$('#coupon-list input[name=brand]').at(-1)?.focus();
});
editors.coupons = {
  isDirty: () => !!coupons && !same(coupons, cfg.coupons.map(normCoupon)),
  reset: () => showCoupons(),
  save: async () => {
    if (coupons.some((c) => !c.brand.trim() || !c.benefit.trim())) throw new Error('กรุณากรอกแบรนด์และสิทธิ์ให้ครบทุกแถว');
    await api('/api/admin/coupons', { method: 'PUT', body: coupons.map((c) => ({ id: c.id, brand: c.brand, benefit: c.benefit, service: c.service || '', active: !!c.active })) });
    await loadConfig();
    showCoupons();
  },
};

// ---------- settings ----------
let settingsDraft = null;
const SETTING_KEYS = ['event_name', 'play_limit', 'cta_text', 'cta_url'];
const pickSettings = (s) => Object.fromEntries(SETTING_KEYS.map((k) => [k, String(s[k] ?? '')]));
function showSettings() {
  settingsDraft = pickSettings(cfg.settings);
  const players = overview?.players ?? 0;
  $('#reset-info').textContent = players ? `ตอนนี้มีผู้เล่น ${players} คน` : 'ยังไม่มีผู้เล่น';
  const f = $('#settings-form');
  for (const k of SETTING_KEYS) {
    if (k === 'play_limit') $$('[name=play_limit]', f).forEach((r) => { r.checked = r.value === settingsDraft[k]; });
    else f[k].value = settingsDraft[k];
  }
  syncSavebar();
}
$('#settings-form').addEventListener('input', (e) => { if (e.target.name) { settingsDraft[e.target.name] = e.target.value; syncSavebar(); } });
$('#settings-form').addEventListener('submit', (e) => e.preventDefault());
editors.settings = {
  isDirty: () => !!settingsDraft && !same(settingsDraft, pickSettings(cfg.settings)),
  reset: () => showSettings(),
  save: async () => {
    await api('/api/admin/settings', { method: 'PUT', body: settingsDraft });
    await loadConfig();
    showSettings();
  },
};

$('#reset-plays').addEventListener('click', async () => {
  try { if (await resetPlays()) showSettings(); } catch (err) { toast(err.message, true); }
});

// ---------- branded dropdowns ----------
// The native <select> popup is drawn by the OS and can't be themed, so every select gets a custom list
// on top. The real <select> stays (hidden) and keeps the value + fires the usual input/change events.
function upgradeSelect(sel) {
  if (sel.dataset.cselect) return;
  sel.dataset.cselect = '1';
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cselect-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  if (sel.title) btn.title = sel.title;
  const list = document.createElement('ul');
  list.className = 'cselect-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.append(btn, list);
  let active = -1;

  const opts = () => [...sel.options].filter((o) => !o.disabled);
  const label = () => { btn.textContent = sel.selectedOptions[0]?.textContent ?? ''; };
  const render = () => {
    list.innerHTML = opts().map((o, i) => `<li role="option" data-i="${i}" aria-selected="${o.selected}" class="${i === active ? 'active' : ''}">${icon('check')}<span>${esc(o.textContent)}</span></li>`).join('');
  };
  const open = () => {
    document.querySelectorAll('.cselect.open').forEach((w) => w !== wrap && w.dispatchEvent(new Event('cselect:close')));
    active = Math.max(0, opts().findIndex((o) => o.selected));
    render();
    list.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    // Flip to the right edge / upwards when the list would run off the screen.
    wrap.classList.remove('align-right', 'drop-up');
    const r = list.getBoundingClientRect();
    if (r.right > innerWidth - 8) wrap.classList.add('align-right');
    if (r.bottom > innerHeight - 8 && wrap.getBoundingClientRect().top > r.height + 16) wrap.classList.add('drop-up');
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { list.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const choose = (i) => {
    const o = opts()[i]; if (!o) return;
    const changed = sel.value !== o.value;
    sel.value = o.value; label(); close(); btn.focus();
    if (changed) { sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  const move = (d) => { active = Math.min(opts().length - 1, Math.max(0, active + d)); render(); list.children[active]?.scrollIntoView({ block: 'nearest' }); };

  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); if (list.hidden) open(); else move(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter' || e.key === ' ') { if (!list.hidden) { e.preventDefault(); choose(active); } }
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close();
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
  list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(Number(li.dataset.i)); });
  wrap.addEventListener('cselect:close', close);
  sel.addEventListener('change', label);
  new MutationObserver(label).observe(sel, { childList: true, subtree: true, attributes: true });
  label();
}
document.addEventListener('click', (e) => { if (!e.target.closest('.cselect')) document.querySelectorAll('.cselect.open').forEach((w) => w.dispatchEvent(new Event('cselect:close'))); });
const upgradeAll = () => document.querySelectorAll('#main select:not([data-cselect])').forEach(upgradeSelect);
new MutationObserver(upgradeAll).observe(document.body, { childList: true, subtree: true });
upgradeAll();

// ---------- boot ----------
if (key) enter().catch(() => {});
