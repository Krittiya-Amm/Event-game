const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

let pin = store.get('staff-pin');
let staffName = store.get('staff-name');
const recent = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-staff-key': pin || '', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  return { status: res.status, data };
}

function logout() {
  store.del('staff-pin'); pin = null;
  $('#main').hidden = true; $('#login').hidden = false;
}

function enter() {
  $('#login').hidden = true; $('#main').hidden = false;
  $('#who').textContent = staffName;
  const code = new URLSearchParams(location.search).get('code');
  if (code) { $('#lookup-form').code.value = code; lookup(code).catch(() => {}); window.history.replaceState(null, '', '/staff'); }
  else $('#lookup-form').code.focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  pin = f.pin.value; staffName = f.staffName.value.trim();
  const res = await fetch('/api/staff/ping', { headers: { 'x-staff-key': pin } });
  if (!res.ok) { $('#login-err').textContent = 'PIN ไม่ถูกต้อง'; return; }
  store.set('staff-pin', pin); store.set('staff-name', staffName);
  f.pin.value = '';
  enter();
});
$('#logout').addEventListener('click', logout);

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' }) : '-';

function renderTicket(play, banner) {
  const t = $('#ticket');
  t.hidden = false;
  const p = play.player || {};
  t.innerHTML = `
    ${banner || ''}
    <div class="ticket-prize"><span class="e">${esc(play.prize.emoji)}</span>
      <div><div class="muted small">รางวัล · Day ${play.dayNo}</div><div class="n">${esc(play.prize.name)}</div></div></div>
    <dl class="kv">
      <dt>โค้ด</dt><dd>${esc(play.code)}</dd>
      <dt>ชื่อ</dt><dd>${esc(p.name)}</dd>
      <dt>บริษัท</dt><dd>${esc(p.company)}</dd>
      <dt>เบอร์โทร</dt><dd>${esc(p.phone)}</dd>
      <dt>สถานะ</dt><dd>${play.redeemed
        ? `<span class="badge danger">รับไปแล้ว</span> ${fmtTime(play.redeemedAt)} · ${esc(play.redeemedBy)}`
        : '<span class="badge warn">ยังไม่ได้รับ</span>'}</dd>
    </dl>
    ${play.redeemed ? '' : '<button class="btn btn-ok btn-lg" id="confirm" type="button">✓ ยืนยันส่งมอบรางวัลแล้ว</button>'}`;
  $('#confirm')?.addEventListener('click', () => redeem(play.code));
}

async function lookup(code) {
  const { status, data } = await api(`/api/staff/lookup?code=${encodeURIComponent(code.trim().toUpperCase())}`);
  if (status === 404) {
    $('#ticket').hidden = false;
    $('#ticket').innerHTML = '<div class="status-banner danger">ไม่พบโค้ดนี้ในระบบ</div>';
    return;
  }
  renderTicket(data.play, data.play.redeemed ? '<div class="status-banner danger">⚠️ โค้ดนี้รับรางวัลไปแล้ว</div>' : '');
}

async function redeem(code) {
  const btn = $('#confirm');
  if (btn) btn.disabled = true;
  const { status, data } = await api('/api/staff/redeem', { method: 'POST', body: JSON.stringify({ code, staffName }) });
  if (status === 200) {
    renderTicket(data.play, '<div class="status-banner ok">✓ ยืนยันการรับรางวัลเรียบร้อย</div>');
    recent.unshift(`${data.play.code} · ${data.play.prize.name} · ${data.play.player?.name || ''}`);
    $('#history').innerHTML = recent.slice(0, 10).map((h) => `<li>${esc(h)}</li>`).join('');
    const f = $('#lookup-form'); f.code.value = ''; f.code.focus();
  } else if (data.play) {
    renderTicket(data.play, '<div class="status-banner danger">⚠️ โค้ดนี้รับรางวัลไปแล้ว</div>');
  } else {
    $('#ticket').innerHTML = '<div class="status-banner danger">ไม่พบโค้ดนี้ในระบบ</div>';
  }
}

$('#lookup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = e.currentTarget.code.value.trim();
  if (code) lookup(code).catch(() => {});
});

if (pin && staffName) enter();
else {
  const f = $('#login-form');
  if (staffName) f.staffName.value = staffName;
}
