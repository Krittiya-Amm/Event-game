const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let config = null;
let authHeaders = {};
let current = null; // current play (always the one the server assigned)
let pollTimer = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Built-in artwork for the default prizes (doll = official 3D น้องสุกี้ from Marketing's Characters folder).
const ART_SRC = { doll: '/img/prizes/doll.png', keychain: '/img/prizes/keychain.svg', card: '/img/prizes/card.svg' };
// Order: image uploaded in Backoffice → built-in illustration → emoji.
const prizeArt = (p) => (p.image
  ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" draggable="false">`
  : ART_SRC[p.id]
    ? `<img src="${ART_SRC[p.id]}" alt="${esc(p.name)}" draggable="false">`
    : `<span class="emoji">${esc(p.emoji)}</span>`);

// Reward tiers drive the celebration only (glow, confetti, timing) — never the prize itself,
// which always comes from the server's slot allocation.
const TIER_OF = { doll: 'grand', keychain: 'special', card: 'standard' };
const TIERS = {
  grand: { label: 'รางวัลใหญ่', confetti: 170, hold: 1200 },
  special: { label: 'รางวัลพิเศษ', confetti: 100, hold: 1000 },
  standard: { label: 'รางวัลนำโชค', confetti: 55, hold: 850 },
};
const tierOf = (p) => TIER_OF[p.id] || 'standard';
const tierTag = (p) => { const t = tierOf(p); return `<span data-tier="${t}"><svg class="ic"><use href="#i-spark"/></svg>${TIERS[t].label}</span>`; };

// ---------- sound (Web Audio, no files) — OFF until the player turns it on ----------
const sound = (() => {
  let ctx = null;
  let enabled = false;
  try { enabled = localStorage.getItem('sound') === 'on'; } catch { /* ignore */ }
  const ensure = () => {
    if (!enabled) return null;
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  function tone(freq, start, dur, { type = 'sine', vol = 0.14 } = {}) {
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    const t = c.currentTime + start;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  // Continuous scratch: one looping noise voice whose volume follows finger speed.
  let noiseBuf = null;
  let scr = null;
  function makeNoise(c) {
    if (noiseBuf) return noiseBuf;
    const len = c.sampleRate * 2;
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let brown = 0; let grit = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      brown = (brown + 0.04 * w) / 1.04;
      if (Math.random() < 0.004) grit = 1;
      grit *= 0.985;
      d[i] = brown * 2.2 + w * 0.22 * (0.35 + grit);
    }
    return noiseBuf;
  }
  const api = {
    get enabled() { return enabled; },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('sound', enabled ? 'on' : 'off'); } catch { /* ignore */ }
      if (!enabled) api.scratchEnd();
      return enabled;
    },
    tap() { tone(880, 0, 0.09, { type: 'triangle', vol: 0.05 }); },
    scratchStart() {
      const c = ensure(); if (!c || scr) return;
      const src = c.createBufferSource(); src.buffer = makeNoise(c); src.loop = true;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
      const filter = c.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 1800; filter.Q.value = 0.6;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000;
      const gain = c.createGain(); gain.gain.value = 0;
      src.connect(hp).connect(filter).connect(lp).connect(gain).connect(c.destination);
      src.start(0, Math.random());
      scr = { src, filter, gain, idle: null };
    },
    /** speed in px/ms — faster finger = louder, slightly brighter rasp. */
    scratchMove(speed) {
      if (!scr || !ctx) return;
      const t = ctx.currentTime;
      const v = Math.min(1, speed / 1.6);
      scr.gain.gain.setTargetAtTime(0.03 + v * 0.2, t, 0.025);
      scr.filter.frequency.setTargetAtTime(1500 + v * 1700, t, 0.05);
      clearTimeout(scr.idle);
      scr.idle = setTimeout(() => scr && scr.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04), 70);
    },
    scratchEnd() {
      if (!scr || !ctx) return;
      const { src, gain, idle } = scr; scr = null;
      clearTimeout(idle);
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
      src.stop(ctx.currentTime + 0.25);
    },
    /** Soft chime; richer for higher tiers. */
    win(tier) {
      const notes = { grand: [523, 659, 784, 1047, 1319, 1568], special: [587, 740, 880, 1175], standard: [659, 880, 1175] }[tier];
      notes.forEach((n, i) => tone(n, i * 0.085, 0.5, { vol: 0.11 }));
      tone(notes.at(-1) * 2, notes.length * 0.085, 0.8, { vol: 0.05 });
    },
    done() { [784, 1175].forEach((n, i) => tone(n, i * 0.1, 0.4, { vol: 0.1 })); },
  };
  return api;
})();

// ---------- helpers ----------
const STEP_OF = { register: 1, scratch: 2, result: 3 }; // the intro screen has no step bar

function show(name, { loadingText } = {}) {
  if (name === 'loading') bind('loadingText', loadingText || 'กำลังโหลด…');
  $$('.screen').forEach((s) => { s.hidden = s.dataset.screen !== name; });
  const step = STEP_OF[name];
  $('#steps').hidden = !step;
  if (step) setStep(step);
  window.scrollTo({ top: 0 });
  clearInterval(pollTimer);
}

function setStep(n, done = false) {
  $$('#steps li').forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle('active', i === n && !done);
    li.classList.toggle('done', i < n || (i === n && done));
  });
}

function bind(key, value, { html = false } = {}) {
  $$(`[data-bind="${key}"]`).forEach((el) => { el[html ? 'innerHTML' : 'textContent'] = value ?? ''; });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const thaiDate = (iso) => new Date(`${iso}T00:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });
const thaiTime = (iso) => new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !headers['x-staff-key']) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok && ![400, 401, 404, 409, 429].includes(res.status)) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return { ok: res.ok, status: res.status, data };
}

function fail(err) {
  console.error(err);
  bind('errorText', err.status === 401
    ? 'ไม่สามารถยืนยันตัวตนได้ กรุณาสแกน QR ที่บูธใหม่อีกครั้ง'
    : navigator.onLine === false
      ? 'ไม่มีการเชื่อมต่ออินเทอร์เน็ต ตรวจสอบสัญญาณแล้วลองใหม่'
      : 'การเชื่อมต่อขัดข้อง ข้อมูลและผลรางวัลของคุณยังอยู่ครบ กดลองใหม่ได้เลย');
  show('error');
}

// ---------- identity ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

const DEVICE_ID_RE = /^W-[A-Za-z0-9-]{8,64}$/;

// crypto.randomUUID only exists on https/localhost; the booth Wi-Fi link is plain http, so build the id ourselves.
function newDeviceId() {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `W-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function deviceId({ fresh = false } = {}) {
  let id;
  if (!fresh) { try { id = localStorage.getItem('device-id'); } catch { /* storage blocked */ } }
  if (!id || !DEVICE_ID_RE.test(id)) {
    id = newDeviceId();
    try { localStorage.setItem('device-id', id); } catch { /* ignore */ }
  }
  return id;
}

async function initIdentity() {
  // Opened inside LINE with a LIFF app configured → use the LINE identity; otherwise plain web entry.
  const inLine = /\bLine\//i.test(navigator.userAgent);
  if (config.liffId && (inLine || !config.webPlay)) {
    await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
    await window.liff.init({ liffId: config.liffId });
    if (!window.liff.isLoggedIn()) {
      window.liff.login({ redirectUri: location.href });
      return new Promise(() => {}); // page will redirect
    }
    authHeaders = { Authorization: `Bearer ${window.liff.getIDToken()}` };
    return;
  }
  if (config.webPlay) { authHeaders = { 'x-device-id': deviceId() }; return; }
  throw Object.assign(new Error('no entry method'), { status: 401 });
}

// ---------- rendering ----------
function renderStatic() {
  bind('eventName', config.eventName);
  document.title = config.eventName || document.title;
  bind('prizeStrip', config.prizes.map((p) => {
    const t = tierOf(p);
    return `<div class="prize-card ${t}"><span class="art">${prizeArt(p)}</span><span class="n">${esc(p.name)}</span><span class="t">${TIERS[t].label}</span></div>`;
  }).join(''), { html: true });
  bind('couponList', config.coupons.map((c) => `<li><b>${esc(c.brand)}</b><span>${esc(c.benefit)}</span></li>`).join(''), { html: true });
  bind('ctaText', config.ctaText);
  const sel = $('#form-register select[name=interest]');
  sel.insertAdjacentHTML('beforeend', (config.services || []).map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join(''));
  upgradeSelect(sel);
  const perDay = config.playLimit === 'day';
  bind('playRule', perDay ? 'วันละ 1 สิทธิ์ / เบอร์' : '1 สิทธิ์ / 1 เบอร์โทร');
  bind('playRuleShort', perDay ? 'วันละ 1 ครั้ง' : '1 ครั้งตลอดงาน');
  $$('[data-cta]').forEach((a) => { if (config.ctaUrl) { a.href = config.ctaUrl; a.hidden = false; } });
}

function setPrize(play) {
  current = play;
  bind('prizeArt', prizeArt(play.prize), { html: true });
  bind('tierHtml', tierTag(play.prize), { html: true });
  bind('prizeName', play.prize.name);
  bind('code', play.code);
  $('#redeem-qr').src = `/api/qr/${encodeURIComponent(play.code)}`;
  $('#coupon-card').hidden = !play.coupon;
  if (play.coupon) {
    bind('couponBrand', play.coupon.brand);
    bind('couponBenefit', play.coupon.benefit);
    const svc = (config.services || []).find((s) => s.id === play.coupon.service);
    bind('couponTag', svc ? `สิทธิพิเศษสำหรับบริการ ${svc.label}` : 'สิทธิพิเศษของคุณ');
  }
  setRedeemed(play.redeemed, play.redeemedAt);
}

/** Step 7 end state: the result card flips to "รับรางวัลเรียบร้อย · บันทึกผลลงระบบแล้ว". */
function setRedeemed(redeemed, at) {
  current.redeemed = redeemed;
  if (at) current.redeemedAt = at;
  $('#redeem-card').classList.toggle('is-redeemed', redeemed);
  bind('redeemedAt', current.redeemedAt ? thaiTime(current.redeemedAt) : '');
  if (!$('#steps').hidden) setStep(3, redeemed);
  if (redeemed) bind('resultEyebrow', 'ขอบคุณที่ร่วมสนุก');
}

function renderSchedule(state) {
  bind('schedule', state.days.map((d) =>
    `<li class="${d.date === state.now.date ? 'today' : ''}"><span>Day ${d.day_no} · ${thaiDate(d.date)}</span><span>${d.open_time}–${d.close_time} น.</span></li>`).join(''), { html: true });
}

function nextText(next) {
  return next ? `กลับมาลุ้นใหม่ได้ ${thaiDate(next.date)} เวลา ${next.open_time} น.` : '';
}

function route(state) {
  switch (state.status) {
    case 'ready':
    case 'register': {
      // Intro first; registered players skip the form and go straight to their card.
      isRegistered = state.status === 'ready';
      $('#welcome').hidden = !isRegistered;
      bind('playerName', state.playerName);
      bind('introCta', isRegistered ? 'เปิดบัตรของฉัน' : 'ร่วมสนุกเลย');
      $('#intro-sub').textContent = isRegistered ? 'แตะเพื่อเริ่มขูดได้ทันที' : 'ลงทะเบียนไม่ถึง 1 นาที';
      show('landing');
      break;
    }
    case 'played':
      // Same prize as before — refreshing never draws again.
      setPrize(state.play);
      if (!state.play.revealed) return startScratch();
      bind('resultEyebrow', state.play.redeemed ? 'ขอบคุณที่ร่วมสนุก' : 'รางวัลของคุณ');
      showResult();
      break;
    case 'soldout':
      bind('nextText', nextText(state.next));
      show('soldout');
      break;
    case 'closed': {
      if (state.lastPlay) { // past winners can still pull up their code at the booth
        setPrize(state.lastPlay);
        bind('resultEyebrow', state.lastPlay.redeemed ? 'ขอบคุณที่ร่วมสนุก' : 'ผลรางวัลของคุณ');
        return showResult();
      }
      const ended = !state.next;
      bind('closedTitle', ended ? 'กิจกรรมจบแล้ว' : 'เกมยังไม่เปิด');
      bind('closedText', ended ? 'ขอบคุณที่ร่วมสนุกกับเรา แล้วพบกันใหม่ในกิจกรรมครั้งหน้า' : `เปิดให้เล่น ${thaiDate(state.next.date)} เวลา ${state.next.open_time} น.`);
      renderSchedule(state);
      show('closed');
      break;
    }
    default:
      fail(new Error(`unknown state ${state.status}`));
  }
}

async function refresh() {
  show('loading');
  try {
    const { data } = await api('/api/state');
    route(data);
  } catch (err) {
    // A stale/rejected web device id → start over with a fresh one once instead of showing an error.
    if (err.status === 401 && authHeaders['x-device-id'] && !refresh.retried) {
      refresh.retried = true;
      authHeaders = { 'x-device-id': deviceId({ fresh: true }) };
      return refresh();
    }
    fail(err);
  }
}

// ---------- step 3: register ----------
const regForm = $('#form-register');

function setFieldError(form, key, msg) {
  const el = $(`[data-err="${key}"]`, form);
  if (el) el.textContent = msg || '';
  const input = form.elements[key];
  const target = input?.closest?.('.cselect')?.querySelector('.cselect-btn') || input;
  if (target?.setAttribute) target.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function focusFirstError(form) {
  const first = $$('[data-err]', form).find((el) => el.textContent);
  if (!first) return;
  const input = form.elements[first.dataset.err];
  (input?.closest?.('.cselect')?.querySelector('.cselect-btn') || input)?.focus?.();
}

regForm.addEventListener('input', (e) => { if (e.target.name) setFieldError(regForm, e.target.name, ''); });
regForm.addEventListener('change', (e) => { if (e.target.name) setFieldError(regForm, e.target.name, ''); });

regForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = regForm;
  const btn = $('button[type="submit"]', form);
  if (btn.disabled) return; // already sending
  const fd = new FormData(form);
  $$('[data-err]', form).forEach((el) => setFieldError(form, el.dataset.err, ''));
  if (fd.get('terms') !== 'on') {
    setFieldError(form, 'terms', 'กรุณายอมรับเงื่อนไขการร่วมกิจกรรมก่อนเริ่มเกม');
    focusFirstError(form);
    return;
  }
  btn.disabled = true; btn.classList.add('busy');
  try {
    const { ok, data } = await api('/api/register', {
      method: 'POST',
      body: { name: fd.get('name'), company: fd.get('company'), phone: fd.get('phone'), interest: fd.get('interest') || '', consent: fd.get('consent') === 'on' },
    });
    if (!ok) {
      for (const [k, v] of Object.entries(data.errors || {})) setFieldError(form, k, v);
      focusFirstError(form);
      return;
    }
    if (data.status === 'ready') await startPlay();
    else route(data);
  } catch (err) { fail(err); } finally { btn.disabled = false; btn.classList.remove('busy'); }
});

// ---------- intro → register ----------
let isRegistered = false;
const onScreen = (name) => !$(`[data-screen="${name}"]`).hidden;
$('#btn-intro').addEventListener('click', () => {
  if (isRegistered) return startPlay();
  show('register');
  history.pushState({ screen: 'register' }, ''); // phone back button returns to the intro
});
$('#btn-back').addEventListener('click', () => {
  if (history.state?.screen === 'register') history.back();
  else show('landing');
});
window.addEventListener('popstate', () => { if (onScreen('register')) show('landing'); });

// ---------- step 4: scratch ----------
let playing = false;
async function startPlay() {
  if (playing) return; // double tap → one request
  playing = true;
  show('loading', { loadingText: 'กำลังเตรียมบัตรของคุณ…' });
  try {
    const { data } = await api('/api/play', { method: 'POST' });
    if (data.status === 'won') {
      setPrize(data.play);
      return startScratch();
    }
    await refresh(); // played / soldout / closed — let state decide the screen
  } catch (err) { fail(err); } finally { playing = false; }
}

const REVEAL_AT = 0.5; // share of the foil actually cleared
let scratchSession = 0;

function startScratch() {
  const session = ++scratchSession;
  bind('resultEyebrow', 'ยินดีด้วย');
  show('scratch');
  $('#scratch-kicker').textContent = 'บัตรของคุณพร้อมแล้ว';
  $('#scratch-title').textContent = 'ขูดเพื่อเปิดรางวัลของคุณ';
  setMeter(0);
  const canvas = $('#scratch-canvas');
  canvas.classList.remove('done');
  const prize = $('#scratch-prize');
  prize.classList.add('hidden-prize');
  $('.gold-sweep', prize).classList.remove('go');
  const frame = $('#ticket-frame');
  frame.classList.remove('revealed');
  frame.dataset.tier = tierOf(current.prize);
  $('#foil-sheen').classList.remove('off');
  $('#scratch-hint').classList.remove('quiet');
  const revealBtn = $('#btn-reveal-all');
  revealBtn.hidden = true;
  const helpTimer = setTimeout(() => { revealBtn.hidden = false; }, 12000);

  let card = null;
  let finished = false;
  const reveal = (from) => {
    if (finished || session !== scratchSession) return; // one reveal per card
    finished = true;
    clearTimeout(helpTimer);
    revealBtn.hidden = true;
    setMeter(100);
    api('/api/reveal', { method: 'POST', body: { code: current.code } }).catch(() => {});
    (card ? card.clearRest(from) : Promise.resolve()).then(() => celebrate(session));
  };
  revealBtn.onclick = () => reveal(null);

  // Draw once the web font is ready (Thai text measured with a fallback font ends up off-centre).
  const fontsReady = document.fonts
    ? Promise.all(['600 26px Prompt', '500 11px Prompt'].map((f) => document.fonts.load(f, 'ขูดตรงนี้'))).catch(() => {})
    : Promise.resolve();
  // clientWidth forces layout, so no need to wait for a frame (rAF also stalls in background tabs).
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => {
    if (session !== scratchSession || finished) return;
    card = setupScratch(canvas, reveal);
  });
}

function setMeter(pct) {
  $('#scratch-bar').style.width = `${pct}%`;
  $('#scratch-meter').setAttribute('aria-valuenow', String(Math.round(pct)));
}

/** Reward reveal: gold sweep + fade/scale of the prize, tiered glow and confetti, then the claim screen. */
function celebrate(session) {
  if (session !== scratchSession) return;
  const tier = tierOf(current.prize);
  $('#scratch-canvas').classList.add('done');
  $('#foil-sheen').classList.add('off');
  $('#scratch-hint').classList.add('quiet');
  $('#scratch-prize').classList.remove('hidden-prize');
  $('#ticket-frame').classList.add('revealed');
  $('#scratch-kicker').textContent = TIERS[tier].label;
  $('#scratch-title').textContent = 'ยินดีด้วย คุณได้รับรางวัล';
  const sweep = $('#scratch-prize .gold-sweep');
  sweep.classList.remove('go'); void sweep.offsetWidth; sweep.classList.add('go');
  sound.win(tier);
  navigator.vibrate?.(tier === 'grand' ? [30, 40, 70] : 30);
  confetti(tier);
  setTimeout(() => { if (session === scratchSession) showResult(); }, reducedMotion() ? 900 : TIERS[tier].hold);
}

// ---------- step 5: result ----------
function showResult() {
  show('result');
  setRedeemed(current.redeemed);
  // Staff may also confirm from the /staff page — watch so this screen reaches the end state on its own.
  if (!current.redeemed) {
    pollTimer = setInterval(async () => {
      try {
        const { data } = await api('/api/state');
        const p = data.play || data.lastPlay;
        if (p?.code === current.code && p.redeemed) { clearInterval(pollTimer); setRedeemed(true, p.redeemedAt); sound.done(); }
      } catch { /* keep polling */ }
    }, 6000);
  }
}

// ---------- step 6: staff confirm on this phone ----------
const dialog = $('#staff-dialog');
const staffForm = $('#staff-form');
let claiming = false;

$('#btn-staff').addEventListener('click', () => {
  if (current?.redeemed) return;
  staffForm.reset();
  $('[data-err="staffName"]').textContent = '';
  dialog.showModal();
  setTimeout(() => staffForm.staffName.focus(), 50);
});
$('#staff-cancel').addEventListener('click', () => dialog.close());

staffForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (claiming) return; // one confirm request at a time
  const staffName = staffForm.staffName.value.trim();
  const err = $('[data-err="staffName"]');
  err.textContent = '';
  if (staffName.length < 1) { err.textContent = 'กรุณากรอก Staff Name'; staffForm.staffName.focus(); return; }
  const btn = $('button[type="submit"]', staffForm);
  claiming = true; btn.disabled = true;
  try {
    const { status, data } = await api('/api/claim', { method: 'POST', body: { code: current.code, staffName } });
    if (status === 200 || status === 409) {
      dialog.close();
      clearInterval(pollTimer);
      setRedeemed(true, data.play?.redeemedAt);
      if (status === 200) sound.done();
      return;
    }
    err.textContent = status === 400 ? (data.error || 'กรุณากรอก Staff Name') : 'ไม่พบโค้ดนี้';
  } catch {
    err.textContent = 'การเชื่อมต่อขัดข้อง ลองใหม่อีกครั้ง';
  } finally { claiming = false; btn.disabled = false; }
});

// ---------- scratch canvas ----------
/** Metallic gold foil: brushed grain, embossed diamond pattern, inner frame and a centre medallion. */
function drawFoil(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w, h);
  [[0, '#b38c48'], [0.17, '#efd8a0'], [0.34, '#c19a54'], [0.5, '#f7e8bf'], [0.68, '#b48b45'], [0.85, '#e4c98e'], [1, '#a57d3a']]
    .forEach(([o, c]) => g.addColorStop(o, c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // brushed-metal grain
  for (let i = 0, n = (w * h) / 200; i < n; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(255,248,225,${0.05 + Math.random() * 0.09})` : `rgba(80,55,15,${0.03 + Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * w - 20, Math.random() * h, 12 + Math.random() * 60, 0.7);
  }

  // embossed diamond lattice (light edge + dark edge)
  const step = 18;
  const lattice = (color, off) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = -h; d < w + h; d += step) {
      ctx.moveTo(d + off, off); ctx.lineTo(d + h + off, h + off);
      ctx.moveTo(d + off, h + off); ctx.lineTo(d + h + off, off);
    }
    ctx.stroke();
  };
  lattice('rgba(255,246,220,.16)', 0.7);
  lattice('rgba(96,66,20,.13)', 0);

  // inner engraved frame
  const frame = (inset, r, color, off) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(inset + off, inset + off, w - inset * 2, h - inset * 2, r); else ctx.rect(inset + off, inset + off, w - inset * 2, h - inset * 2);
    ctx.stroke();
  };
  frame(12, 13, 'rgba(255,246,220,.55)', 1); frame(12, 13, 'rgba(90,60,18,.45)', 0);
  frame(17, 9, 'rgba(255,246,220,.3)', 1); frame(17, 9, 'rgba(90,60,18,.25)', 0);

  // centre medallion
  const cx = w / 2; const cy = h / 2; const r = Math.min(w, h) * 0.25;
  const halo = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 1.7);
  halo.addColorStop(0, 'rgba(255,246,215,.35)'); halo.addColorStop(1, 'rgba(255,246,215,0)');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, w, h);
  const disc = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  disc.addColorStop(0, '#f8eac3'); disc.addColorStop(0.45, '#dcb873'); disc.addColorStop(1, '#a98039');
  ctx.fillStyle = disc;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(90,60,18,.55)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,248,225,.7)'; ctx.beginPath(); ctx.arc(cx, cy + 0.8, r - 6, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(90,60,18,.35)'; ctx.beginPath(); ctx.arc(cx, cy, r - 6, 0, Math.PI * 2); ctx.stroke();

  // Centre by measuring, not by textAlign — some browsers ignore textAlign here and left-align.
  const engraved = (text, font, cyText, { spacing = 0 } = {}) => {
    ctx.font = font; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
    const m = ctx.measureText(text);
    const left = m.actualBoundingBoxLeft ?? 0; const right = m.actualBoundingBoxRight ?? m.width;
    const asc = m.actualBoundingBoxAscent || 0; const desc = m.actualBoundingBoxDescent || 0;
    const x = cx + (left - right) / 2; const y = cyText + (asc - desc) / 2;
    ctx.fillStyle = 'rgba(255,250,232,.75)'; ctx.fillText(text, x, y + 1); // light edge below = pressed in
    ctx.fillStyle = '#4b3511'; ctx.fillText(text, x, y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  };
  engraved('ขูดตรงนี้', '600 26px Prompt, sans-serif', cy - 8);
  engraved('SCRATCH TO REVEAL', '500 10px Prompt, sans-serif', cy + 22, { spacing: 2.2 });
}

/** Real scratching on a canvas mask. Returns { clearRest(point) } for the automatic reveal. */
function setupScratch(canvas, onThreshold) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Layout size, not getBoundingClientRect(): the card plays an intro animation and a transformed rect
  // would make the foil smaller than the card.
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  drawFoil(ctx, width, height);

  // Eraser: round brush, smoothed with quadratic curves through midpoints, soft anti-aliased edge.
  ctx.globalCompositeOperation = 'destination-out';
  const brush = Math.max(30, width * 0.115);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush;
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
  ctx.shadowColor = '#000'; ctx.shadowBlur = 5 * dpr;

  const glow = $('#scratch-glow');
  const hint = $('#scratch-hint');
  const sheen = $('#foil-sheen');
  let drawing = false;
  let locked = false;
  let prev = null; let lastMid = null;
  let lastCheck = 0;
  let lastMove = { x: 0, y: 0, t: 0 };
  let glowPos = null; let glowRaf = 0;

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (width / r.width), y: (e.clientY - r.top) * (height / r.height) };
  };
  const placeGlow = (p) => {
    glowPos = p;
    if (glowRaf) return;
    glowRaf = requestAnimationFrame(() => { glowRaf = 0; glow.style.transform = `translate3d(${glowPos.x}px, ${glowPos.y}px, 0)`; });
  };

  function dot(p) { ctx.beginPath(); ctx.arc(p.x, p.y, brush / 2, 0, Math.PI * 2); ctx.fill(); }
  function extend(p) {
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1.5) return;
    const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
    ctx.beginPath(); ctx.moveTo(lastMid.x, lastMid.y); ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y); ctx.stroke();
    lastMid = mid; prev = p;
  }
  function finishStroke() {
    if (prev && lastMid) { ctx.beginPath(); ctx.moveTo(lastMid.x, lastMid.y); ctx.lineTo(prev.x, prev.y); ctx.stroke(); }
    prev = null; lastMid = null;
  }

  /** Share of the foil that is actually transparent (grid sample of the alpha channel). */
  function cleared() {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const step = Math.max(4, Math.round(7 * dpr));
    let clear = 0; let total = 0;
    for (let y = step >> 1; y < canvas.height; y += step) {
      const row = y * canvas.width;
      for (let x = step >> 1; x < canvas.width; x += step) { total++; if (data[(row + x) * 4 + 3] < 128) clear++; }
    }
    return clear / total;
  }
  function check() {
    lastCheck = performance.now();
    const p = cleared();
    setMeter(Math.min(100, (p / REVEAL_AT) * 100));
    if (p >= REVEAL_AT) { lock(); onThreshold(prev || lastMove); }
  }

  const down = (e) => {
    if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    drawing = true;
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    const p = pt(e);
    prev = p; lastMid = p; dot(p);
    lastMove = { x: p.x, y: p.y, t: e.timeStamp };
    sound.scratchStart();
    hint.classList.add('quiet');
    sheen.classList.add('off');
    placeGlow(p); glow.classList.add('on');
    navigator.vibrate?.(6);
  };
  const move = (e) => {
    if (!drawing || locked) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() || [e]) extend(pt(ev));
    const p = pt(e); const dt = Math.max(1, e.timeStamp - lastMove.t);
    placeGlow(p);
    sound.scratchMove(Math.hypot(p.x - lastMove.x, p.y - lastMove.y) / dt);
    lastMove = { x: p.x, y: p.y, t: e.timeStamp };
    if (performance.now() - lastCheck > 120) check();
  };
  const up = () => {
    if (!drawing) return;
    drawing = false;
    finishStroke();
    sound.scratchEnd();
    glow.classList.remove('on');
    if (!locked) check();
  };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move, { passive: false });
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);

  // No more input once the reveal starts (prevents a second trigger).
  function lock() {
    if (locked) return;
    locked = true; drawing = false;
    sound.scratchEnd();
    glow.classList.remove('on');
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('lostpointercapture', up);
  }

  /** Wipe the remaining foil outward from the last touch point in ~520 ms. */
  function clearRest(from) {
    lock();
    const wipeAll = () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.shadowBlur = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); };
    if (reducedMotion()) { wipeAll(); return Promise.resolve(); }
    const o = from && Number.isFinite(from.x) ? from : { x: width / 2, y: height / 2 };
    const maxR = Math.max(...[[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => Math.hypot(x - o.x, y - o.y))) + 30;
    const dur = 520;
    ctx.shadowBlur = 0;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let done = false;
      const finish = () => { if (done) return; done = true; wipeAll(); resolve(); };
      setTimeout(finish, dur + 250); // rAF pauses in background tabs — never leave the player stuck mid-reveal
      (function frame(t) {
        if (done) return;
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - (1 - k) ** 3; // ease-out cubic
        const r = brush * 0.6 + (maxR - brush * 0.6) * e;
        const grad = ctx.createRadialGradient(o.x, o.y, r * 0.78, o.x, o.y, r);
        grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI * 2); ctx.fill();
        if (k < 1) requestAnimationFrame(frame); else finish();
      })(t0);
    });
  }

  return { clearRest };
}

// ---------- confetti (brand colours, amount by tier) ----------
let confettiRun = 0;
function confetti(tier = 'standard') {
  if (reducedMotion()) return;
  const run = ++confettiRun; // a newer burst stops the older loop
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = innerWidth; const H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  // Always wipe the whole bitmap: the viewport can resize mid-animation (mobile URL bar).
  const wipe = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const colors = ['#7c3aed', '#a78bfa', '#fcd34d', '#facc15', '#32a9ff', '#f472b6', '#f36f25', '#e2c27f'];
  const count = TIERS[tier]?.confetti || 55;
  const origins = tier === 'grand' ? [[W / 2, H * 0.38], [W * 0.15, H * 0.55], [W * 0.85, H * 0.55]] : [[W / 2, H * 0.4]];
  const parts = Array.from({ length: count }, (_, i) => {
    const [ox, oy] = origins[i % origins.length];
    const spread = tier === 'grand' ? 13 : 10;
    return {
      x: ox + (Math.random() - 0.5) * 40, y: oy,
      vx: (Math.random() - 0.5) * spread, vy: -Math.random() * (spread + 1) - 3,
      s: Math.random() * 6 + 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25,
      f: Math.random() * Math.PI * 2, round: Math.random() < 0.25,
      c: colors[(Math.random() * colors.length) | 0],
    };
  });
  const start = performance.now();
  (function frame(t) {
    if (run !== confettiRun) return;
    wipe();
    const age = t - start;
    ctx.globalAlpha = age > 1900 ? Math.max(0, 1 - (age - 1900) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.28; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.f += 0.18;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s / 3, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.scale(1, Math.cos(p.f)); ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); } // flutter
      ctx.restore();
    }
    if (age < 2500) requestAnimationFrame(frame);
    else { ctx.globalAlpha = 1; wipe(); }
  })(start);
}

// ---------- branded dropdown (same component as Backoffice, game styling) ----------
// The OS popup can't be themed; draw our own list and keep the real <select> (hidden) for the form value.
function upgradeSelect(sel) {
  if (sel.dataset.cselect) return;
  sel.dataset.cselect = '1';
  const wrap = document.createElement('div');
  wrap.className = 'cselect';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'cselect-btn' });
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const list = Object.assign(document.createElement('ul'), { className: 'cselect-list', hidden: true });
  list.setAttribute('role', 'listbox');
  wrap.append(btn, list);
  let active = -1;
  const opts = () => [...sel.options].filter((o) => !o.disabled);
  const label = () => {
    const o = sel.selectedOptions[0];
    btn.textContent = o?.textContent ?? '';
    btn.classList.toggle('placeholder', !o || o.disabled || !o.value);
  };
  const render = () => {
    list.innerHTML = opts().map((o, i) => `<li role="option" data-i="${i}" aria-selected="${o.selected}" class="${i === active ? 'active' : ''}"><svg class="ic"><use href="#i-check"/></svg><span>${esc(o.textContent)}</span></li>`).join('');
  };
  const open = () => {
    active = Math.max(0, opts().findIndex((o) => o.selected));
    render();
    list.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    // Always open downward; scroll the page if the list would run off the bottom of the screen.
    if (list.getBoundingClientRect().bottom > innerHeight - 8) list.scrollIntoView({ block: 'end', behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const close = () => { list.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const choose = (i) => {
    const o = opts()[i]; if (!o) return;
    sel.value = o.value; label(); close(); btn.focus();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sound.tap();
  };
  const move = (d) => { active = Math.min(opts().length - 1, Math.max(0, active + d)); render(); list.children[active]?.scrollIntoView({ block: 'nearest' }); };
  btn.addEventListener('click', () => (list.hidden ? open() : close()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); if (list.hidden) open(); else move(e.key === 'ArrowDown' ? 1 : -1); }
    else if ((e.key === 'Enter' || e.key === ' ') && !list.hidden) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') close();
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(Number(li.dataset.i)); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  sel.form?.addEventListener('reset', () => setTimeout(label));
  label();
}

// ---------- boot ----------
$$('[data-action="refresh"]').forEach((b) => b.addEventListener('click', refresh));

const soundBtn = $('#btn-sound');
const syncSoundBtn = () => {
  soundBtn.setAttribute('aria-pressed', String(sound.enabled));
  soundBtn.setAttribute('aria-label', sound.enabled ? 'ปิดเสียง' : 'เปิดเสียง');
};
syncSoundBtn();
soundBtn.addEventListener('click', () => { sound.toggle(); syncSoundBtn(); sound.tap(); });

(async function boot() {
  // Testing helper: open "/?new" to start over as a new player on this device.
  if (new URLSearchParams(location.search).has('new')) {
    try { localStorage.removeItem('device-id'); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  }
  try {
    config = (await api('/api/config')).data;
    renderStatic();
    await initIdentity();
    await refresh();
  } catch (err) { fail(err); }
})();
