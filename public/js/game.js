const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let config = null;
let authHeaders = {};
let current = null; // current play
let pollTimer = null;

const PRIZE_ART = new Set(['doll', 'keychain', 'card']);
// Order: image uploaded in Backoffice → built-in illustration → emoji.
const prizeArt = (p) => (p.image
  ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" draggable="false">`
  : PRIZE_ART.has(p.id)
    ? `<img src="/img/prizes/${p.id}.svg" alt="${esc(p.name)}" draggable="false">`
    : `<span class="emoji">${esc(p.emoji)}</span>`);

// Gacha-style rarity labels (display only — real odds come from the Backoffice slots).
const RARITY = {
  doll: { label: 'SUPER RARE', color: '#f59e0b', legend: true },
  keychain: { label: 'RARE', color: '#ec4899' },
  card: { label: 'LUCKY', color: '#6366f1' },
};
const rarityOf = (p) => RARITY[p.id] || { label: 'PRIZE', color: '#5b2be0' };
const rarityTag = (p) => `<span style="--rc:${rarityOf(p).color}">${rarityOf(p).label}</span>`;

// ---------- sound (Web Audio, no files) ----------
const sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('muted') === '1'; } catch { /* ignore */ }
  const ensure = () => {
    if (muted) return null;
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  function tone(freq, start, dur, { type = 'triangle', vol = 0.18 } = {}) {
    const c = ensure(); if (!c) return;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    const t = c.currentTime + start;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  // Continuous scratch: one looping "grainy" noise voice whose volume follows finger speed.
  let noiseBuf = null;
  let scr = null; // { src, filter, gain, idle }
  function makeNoise(c) {
    if (noiseBuf) return noiseBuf;
    const len = c.sampleRate * 2;
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let brown = 0; let grit = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      brown = (brown + 0.04 * w) / 1.04;                         // soft body
      if (Math.random() < 0.004) grit = 1;                        // tiny foil "crackles"
      grit *= 0.985;
      d[i] = brown * 2.2 + w * 0.22 * (0.35 + grit);
    }
    return noiseBuf;
  }
  return {
    get muted() { return muted; },
    toggle() { muted = !muted; try { localStorage.setItem('muted', muted ? '1' : '0'); } catch { /* ignore */ } return muted; },
    unlock: ensure,
    tap() { tone(660, 0, 0.08, { type: 'square', vol: 0.06 }); tone(990, 0.05, 0.1, { type: 'square', vol: 0.05 }); },
    scratchStart() {
      const c = ensure(); if (!c || scr) return;
      const src = c.createBufferSource(); src.buffer = makeNoise(c); src.loop = true;
      src.loopStart = Math.random(); // vary texture between strokes
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
      const filter = c.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 1800; filter.Q.value = 0.6;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5000;
      const gain = c.createGain(); gain.gain.value = 0;
      src.connect(hp).connect(filter).connect(lp).connect(gain).connect(c.destination);
      src.start(0, src.loopStart);
      scr = { src, filter, gain, idle: null };
    },
    /** speed in px/ms — faster finger = louder, slightly brighter rasp. */
    scratchMove(speed) {
      if (!scr || !ctx) return;
      const t = ctx.currentTime;
      const v = Math.min(1, speed / 1.6);
      scr.gain.gain.setTargetAtTime(0.03 + v * 0.22, t, 0.025);
      scr.filter.frequency.setTargetAtTime(1500 + v * 1700, t, 0.05);
      clearTimeout(scr.idle);
      scr.idle = setTimeout(() => scr && scr.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04), 70); // finger stopped
    },
    scratchEnd() {
      if (!scr || !ctx) return;
      const { src, gain, idle } = scr; scr = null;
      clearTimeout(idle);
      gain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
      src.stop(ctx.currentTime + 0.25);
    },
    win(big) {
      const notes = big ? [523, 659, 784, 1047, 1319, 1568] : [523, 659, 784, 1047];
      notes.forEach((n, i) => tone(n, i * 0.09, 0.35, { vol: 0.16 }));
      tone(notes.at(-1) * 2, notes.length * 0.09, 0.6, { type: 'sine', vol: 0.08 });
    },
    done() { [784, 1047].forEach((n, i) => tone(n, i * 0.1, 0.3, { vol: 0.14 })); },
  };
})();

// ---------- helpers ----------
const STEP_OF = { landing: 1, scratch: 2, result: 3 };

function show(name) {
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
  bind('errorText', err.status === 401 ? 'ไม่สามารถยืนยันตัวตนได้ กรุณาสแกน QR ใหม่อีกครั้ง' : 'การเชื่อมต่อขัดข้อง กรุณาลองใหม่');
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
    const r = rarityOf(p);
    return `<div class="prize-card${r.legend ? ' legend' : ''}" style="--rc:${r.color}"><span class="tag">${r.label}</span>`
      + `<span class="art">${prizeArt(p)}</span><span class="n">${esc(p.name)}</span></div>`;
  }).join(''), { html: true });
  $$('.prize-card').forEach((c) => c.addEventListener('click', () => {
    c.classList.remove('wobble'); void c.offsetWidth; c.classList.add('wobble');
    sound.tap(); navigator.vibrate?.(10);
  }));
  bind('couponList', config.coupons.map((c) => `<li><b>${esc(c.brand)}</b><span>${esc(c.benefit)}</span></li>`).join(''), { html: true });
  bind('ctaText', config.ctaText);
  const sel = $('#form-register select[name=interest]');
  sel.insertAdjacentHTML('beforeend', (config.services || []).map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join(''));
  upgradeSelect(sel);
  bind('playRule', config.playLimit === 'day' ? 'เล่นได้วันละ 1 ครั้ง / 1 เบอร์โทร' : 'เล่นได้ 1 ครั้งตลอดงาน / 1 เบอร์โทร');
  $$('[data-cta]').forEach((a) => { if (config.ctaUrl) { a.href = config.ctaUrl; a.hidden = false; } });
}

function setPrize(play) {
  current = play;
  bind('prizeArt', prizeArt(play.prize), { html: true });
  bind('rarityHtml', rarityTag(play.prize), { html: true });
  bind('prizeName', play.prize.name);
  bind('code', play.code);
  $('#redeem-qr').src = `/api/qr/${encodeURIComponent(play.code)}`;
  $('#coupon-card').hidden = !play.coupon;
  if (play.coupon) {
    bind('couponBrand', play.coupon.brand);
    bind('couponBenefit', play.coupon.benefit);
    const svc = (config.services || []).find((s) => s.id === play.coupon.service);
    bind('couponTag', svc ? `โบนัส! โปรโมชันสำหรับบริการ ${svc.label}` : 'โบนัส! โปรโมชันพิเศษของคุณ');
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
  if (redeemed) bind('resultEyebrow', 'ขอบคุณที่ร่วมสนุก!');
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
      const registered = state.status === 'ready';
      $('#form-register').hidden = registered;
      $('#welcome').hidden = !registered;
      bind('playerName', state.playerName);
      show('landing');
      break;
    }
    case 'played':
      setPrize(state.play);
      if (!state.play.revealed) return startScratch();
      bind('resultEyebrow', state.play.redeemed ? 'ขอบคุณที่ร่วมสนุก!' : 'รางวัลของคุณ');
      showResult(false);
      break;
    case 'soldout':
      bind('nextText', nextText(state.next));
      show('soldout');
      break;
    case 'closed': {
      if (state.lastPlay) { // past winners can still pull up their code at the booth
        setPrize(state.lastPlay);
        bind('resultEyebrow', state.lastPlay.redeemed ? 'ขอบคุณที่ร่วมสนุก!' : 'ผลรางวัลของคุณ');
        return showResult(false);
      }
      const ended = !state.next;
      bind('closedTitle', ended ? 'กิจกรรมจบแล้ว' : 'เกมยังไม่เปิด');
      bind('closedText', ended ? 'ขอบคุณที่ร่วมสนุกกับเรา' : `เปิดให้เล่น ${thaiDate(state.next.date)} เวลา ${state.next.open_time} น.`);
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
$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const fd = new FormData(form);
  $$('[data-err]', form).forEach((el) => { el.textContent = ''; });
  const btn = $('button[type="submit"]', form);
  btn.disabled = true;
  try {
    const { ok, data } = await api('/api/register', {
      method: 'POST',
      body: { name: fd.get('name'), company: fd.get('company'), phone: fd.get('phone'), interest: fd.get('interest') || '', consent: fd.get('consent') === 'on' },
    });
    if (!ok) {
      for (const [k, v] of Object.entries(data.errors || {})) { const el = $(`[data-err="${k}"]`, form); if (el) el.textContent = v; }
      return;
    }
    if (data.status === 'ready') await startPlay();
    else route(data);
  } catch (err) { fail(err); } finally { btn.disabled = false; }
});
$('#btn-start').addEventListener('click', () => startPlay());

// ---------- step 4: scratch ----------
async function startPlay() {
  show('loading');
  try {
    const { data } = await api('/api/play', { method: 'POST' });
    if (data.status === 'won') {
      setPrize(data.play);
      return startScratch();
    }
    await refresh(); // played / soldout / closed — let state decide the screen
  } catch (err) { fail(err); }
}

function startScratch() {
  bind('resultEyebrow', 'ยินดีด้วย!');
  show('scratch');
  $('#scratch-title').textContent = 'ขูดให้สุด!';
  const bar = $('#scratch-bar'); const pct = $('#scratch-pct');
  bar.style.width = '0'; pct.textContent = '0%';
  const canvas = $('#scratch-canvas');
  canvas.classList.remove('done');
  $('#scratch-prize').classList.add('hidden-prize'); // blurred + zoomed until the reveal
  $('#hint-hand').classList.remove('gone');
  $('#cheer').textContent = '';
  $('#stamp').className = 'stamp';
  $('#ticket-frame').classList.remove('legend-win', 'revealed');
  $('#scratch-bar').classList.remove('hot');
  const revealBtn = $('#btn-reveal-all');
  revealBtn.hidden = true;
  const helpTimer = setTimeout(() => { revealBtn.hidden = false; }, 12000);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(helpTimer);
    revealBtn.hidden = true;
    canvas.classList.add('done');
    $('#scratch-prize').classList.remove('hidden-prize');
    api('/api/reveal', { method: 'POST', body: { code: current.code } }).catch(() => {});
    // Reveal moment: flash → card pops → fanfare + confetti, then move on to the claim screen.
    const flash = $('#flash'); flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    const frame = $('#ticket-frame'); frame.classList.remove('revealed'); void frame.offsetWidth; frame.classList.add('revealed');
    $('#scratch-title').textContent = 'ได้รางวัลแล้ว!';
    const r = rarityOf(current.prize);
    const stamp = $('#stamp');
    stamp.textContent = `${r.label}!`;
    stamp.style.setProperty('--rc', r.color);
    stamp.classList.add('slam');
    $('#coin').classList.remove('on');
    $('#cheer').textContent = '';
    if (r.legend) frame.classList.add('legend-win');
    bar.style.width = '100%'; pct.textContent = '100%';
    sound.win(!!rarityOf(current.prize).legend);
    navigator.vibrate?.([30, 40, 60]);
    confetti();
    setTimeout(() => showResult(false), 2200);
  };
  revealBtn.onclick = finish;
  // Draw once web fonts are ready (Thai text measured with a fallback font ends up off-centre).
  // Ask for the exact faces the canvas uses — fonts.ready alone can resolve before they were ever requested.
  const fontsReady = document.fonts
    ? Promise.all(['600 32px Mitr', '600 26px Mitr', '500 15px Prompt'].map((f) => document.fonts.load(f, 'ขูดตรงนี้'))).catch(() => {})
    : Promise.resolve();
  Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => requestAnimationFrame(() => setupScratch(canvas, finish)));
}

// ---------- step 5: result ----------
function showResult(celebrate) {
  show('result');
  setRedeemed(current.redeemed);
  if (celebrate) confetti();
  // Staff may also confirm from the /staff page — watch so this screen reaches the end state on its own.
  if (!current.redeemed) {
    pollTimer = setInterval(async () => {
      try {
        const { data } = await api('/api/state');
        const p = data.play || data.lastPlay;
        if (p?.code === current.code && p.redeemed) { clearInterval(pollTimer); setRedeemed(true, p.redeemedAt); confetti(); sound.done(); }
      } catch { /* keep polling */ }
    }, 6000);
  }
}

// ---------- step 6: staff confirm on this phone ----------
const dialog = $('#staff-dialog');
const staffForm = $('#staff-form');

$('#btn-staff').addEventListener('click', () => {
  staffForm.reset();
  $('[data-err="staffName"]').textContent = '';
  dialog.showModal();
  setTimeout(() => staffForm.staffName.focus(), 50);
});
$('#staff-cancel').addEventListener('click', () => dialog.close());

staffForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const staffName = staffForm.staffName.value.trim();
  const err = $('[data-err="staffName"]');
  err.textContent = '';
  if (staffName.length < 1) { err.textContent = 'กรุณากรอก Staff Code'; staffForm.staffName.focus(); return; }
  const btn = $('button[type="submit"]', staffForm);
  btn.disabled = true;
  try {
    const { status, data } = await api('/api/claim', { method: 'POST', body: { code: current.code, staffName } });
    if (status === 200 || status === 409) {
      dialog.close();
      clearInterval(pollTimer);
      setRedeemed(true, data.play?.redeemedAt);
      if (status === 200) { confetti(); sound.done(); }
      return;
    }
    err.textContent = status === 400 ? (data.error || 'กรุณากรอก Staff Code') : 'ไม่พบโค้ดนี้';
  } catch {
    err.textContent = 'การเชื่อมต่อขัดข้อง ลองใหม่อีกครั้ง';
  } finally { btn.disabled = false; }
});

// ---------- scratch canvas ----------
const REVEAL_AT = 0.6;

function setupScratch(canvas, onDone) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Layout size, not getBoundingClientRect(): the ticket plays a scale/rotate intro animation,
  // and a transformed rect would make the foil smaller than the card (blurry, off-centre text).
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // Foil: holographic silver-violet with glitter and "?" marks
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#b9b2e6'); g.addColorStop(0.3, '#ece8ff'); g.addColorStop(0.5, '#a99fdc');
  g.addColorStop(0.72, '#e4dfff'); g.addColorStop(1, '#9187cc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 260; i++) { // glitter
    ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.6})`;
    const r = Math.random() * 1.6 + 0.4;
    ctx.beginPath(); ctx.arc(Math.random() * width, Math.random() * height, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 26px Mitr, Prompt, sans-serif';
  for (let y = 30, row = 0; y < height; y += 54, row++) {
    for (let x = row % 2 ? 28 : 64; x < width; x += 72) {
      ctx.fillStyle = 'rgba(70, 40, 170, 0.13)';
      ctx.fillText(row % 3 === 1 ? '★' : '?', x, y);
    }
  }
  // center badge
  const bw = Math.min(230, width * 0.72); const bh = 92; const bx = (width - bw) / 2; const by = height / 2 - bh / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 22); else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  // Centre by measuring, not by textAlign — some browsers (seen in Safari) ignore textAlign here and left-align.
  const centered = (text, font, color, cy) => {
    ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const m = ctx.measureText(text);
    const left = m.actualBoundingBoxLeft ?? 0; const right = m.actualBoundingBoxRight ?? m.width;
    const asc = m.actualBoundingBoxAscent || 0; const desc = m.actualBoundingBoxDescent || 0;
    const x = width / 2 + (left - right) / 2; // glyph box spans [x - left, x + right]
    ctx.fillText(text, x, cy + (asc - desc) / 2); // visible glyphs (incl. Thai marks) centred on (width/2, cy)
  };
  centered('ขูดตรงนี้!', '600 32px Mitr, Prompt, sans-serif', '#5b2be0', height / 2 - 13);
  centered('ใช้นิ้วถูไปมาบนบัตร', '500 15px Prompt, sans-serif', '#6b6489', height / 2 + 24);

  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(36, width * 0.11);

  let drawing = false;
  let last = null;
  let lastMove = { x: 0, y: 0, t: 0 };
  let moves = 0;
  const bar = $('#scratch-bar');
  const pctEl = $('#scratch-pct');
  const coin = $('#coin');
  const moveCoin = ({ x, y }) => { coin.style.transform = `translate(${x}px, ${y}px) rotate(${(x + y) % 360}deg)`; };
  const CHEERS = [[20, 'ดีมาก!'], [40, 'อีกนิด!'], [52, 'ใกล้แล้ว!!']];
  let cheered = 0;
  const sparkles = $('#sparkles');
  let lastSpark = 0;
  bar.style.width = '0';

  function spark({ x, y }) {
    const now = performance.now();
    if (now - lastSpark < 45) return;
    lastSpark = now;
    for (let i = 0; i < 2; i++) {
      const el = document.createElement('i');
      const a = Math.random() * Math.PI * 2; const d = 18 + Math.random() * 26;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      el.style.setProperty('--dx', `${Math.cos(a) * d}px`); el.style.setProperty('--dy', `${Math.sin(a) * d}px`);
      if (Math.random() < 0.4) el.style.background = '#fff';
      sparkles.appendChild(el);
      setTimeout(() => el.remove(), 650);
    }
  }

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    // Map screen px → canvas px even if the card is still mid-animation (scaled).
    return { x: (e.clientX - r.left) * (width / r.width), y: (e.clientY - r.top) * (height / r.height) };
  };

  function progress() {
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let clear = 0; let total = 0;
    for (let i = 3; i < data.length; i += 4 * 24) { total++; if (data[i] === 0) clear++; }
    return clear / total;
  }

  function stroke(to) {
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    last = to;
    spark(to);
    if (++moves % 6 === 0) check();
  }

  function check() {
    const p = progress();
    // Show the real scratched area; the prize sharpens and reveals at 60%.
    const shown = Math.min(100, Math.round(p * 100));
    bar.style.width = `${Math.min(100, (p / REVEAL_AT) * 100)}%`;
    pctEl.textContent = `${shown}%`;
    if (cheered < CHEERS.length && shown >= CHEERS[cheered][0] && shown < REVEAL_AT * 100) {
      $('#cheer').innerHTML = `<span>${CHEERS[cheered][1]}</span>`;
      const fr = $('#ticket-frame'); fr.classList.remove('nudge'); void fr.offsetWidth; fr.classList.add('nudge');
      if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(15);
      while (cheered < CHEERS.length && shown >= CHEERS[cheered][0]) cheered++;
    }
    bar.classList.toggle('hot', shown >= 45);
    if (shown >= REVEAL_AT * 100) { cleanup(); onDone(); } // the moment the counter shows 60%, reveal
  }

  const down = (e) => {
    drawing = true;
    canvas.setPointerCapture?.(e.pointerId);
    last = pt(e);
    stroke({ x: last.x + 0.1, y: last.y + 0.1 });
    sound.unlock();
    sound.scratchStart();
    $('#hint-hand').classList.add('gone');
    moveCoin(last); coin.classList.add('on');
    lastMove = { x: last.x, y: last.y, t: e.timeStamp };
    if (navigator.vibrate) navigator.vibrate(8);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() || [e]) stroke(pt(ev));
    const p = pt(e); const dt = Math.max(1, e.timeStamp - lastMove.t);
    moveCoin(p);
    sound.scratchMove(Math.hypot(p.x - lastMove.x, p.y - lastMove.y) / dt);
    lastMove = { x: p.x, y: p.y, t: e.timeStamp };
  };
  const up = () => { sound.scratchEnd(); coin.classList.remove('on'); if (drawing) { drawing = false; check(); } };

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move, { passive: false });
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  function cleanup() {
    sound.scratchEnd();
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
  }
}

// ---------- confetti ----------
let confettiRun = 0;
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const run = ++confettiRun; // a newer burst stops the older loop
  const c = $('#confetti');
  const ctx = c.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = innerWidth; const H = innerHeight;
  c.width = W * dpr; c.height = H * dpr;
  // Always wipe the whole bitmap: the viewport can resize mid-animation (mobile URL bar), and clearing only
  // the current innerWidth/innerHeight would leave streaks behind.
  const wipe = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  const colors = ['#ffc531', '#ff7ad9', '#3ee6ff', '#ffffff', '#a78bfa'];
  const parts = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35,
    vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 13 - 4,
    s: Math.random() * 7 + 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(t) {
    if (run !== confettiRun) return;
    wipe();
    for (const p of parts) {
      p.vy += 0.32; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (t - start < 3200) requestAnimationFrame(frame);
    else wipe();
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
    wrap.classList.remove('drop-up');
    const r = list.getBoundingClientRect();
    if (r.bottom > innerHeight - 8 && wrap.getBoundingClientRect().top > r.height + 16) wrap.classList.add('drop-up');
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
  soundBtn.setAttribute('aria-pressed', String(sound.muted));
  soundBtn.setAttribute('aria-label', sound.muted ? 'เปิดเสียง' : 'ปิดเสียง');
};
syncSoundBtn();
soundBtn.addEventListener('click', () => { sound.toggle(); syncSoundBtn(); sound.tap(); });
document.addEventListener('click', (e) => { if (e.target.closest('.btn-play')) sound.tap(); });

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
