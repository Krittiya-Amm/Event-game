// Backoffice "รางวัล" (prize list + how many of each per day) and "วันและเวลา" (date range).
// Slots stay the source of truth for the game: player N of a day gets slot N. Admins only set counts;
// we shuffle them into slots, never touching slots that have already been won.
import { addDays } from './time.js';
import { buildSlots } from './seed.js';
import { getSettings, setSetting } from './db.js';

const ID_RE = /^[a-z0-9_-]{1,30}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_DAYS = 31;
const MAX_PER_DAY = 1000;

class InputError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export { InputError };

// Locked positions: "player N of Day D gets prize P" — kept in settings as JSON { day: { prizeId: [N, …] } },
// so no schema change is needed. Every other slot is still shuffled.
const LOCKS_KEY = 'locked_slots';
async function readLocks(q) {
  try { const v = JSON.parse((await getSettings(q))[LOCKS_KEY] || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
const writeLocks = (q, locks) => setSetting(q, LOCKS_KEY, JSON.stringify(locks));

/** { prizes, days, counts: {day: {prize: n}}, given: {day: {prize: n}}, locks: {day: {prize: [n]}}, played: {day: n} } */
export async function getRewards(db) {
  const [prizes, days, slotRows, playRows, locks, usedRows] = await Promise.all([
    db.all('SELECT id, name, emoji, color, image FROM prizes ORDER BY sort, id'),
    db.all('SELECT day_no, date FROM event_days ORDER BY day_no'),
    db.all('SELECT day_no, prize_id, COUNT(*) AS n FROM slots GROUP BY day_no, prize_id'),
    db.all('SELECT day_no, prize_id, COUNT(*) AS n FROM plays GROUP BY day_no, prize_id'),
    readLocks(db),
    db.all('SELECT day_no, MAX(slot_no) AS n FROM plays GROUP BY day_no'),
  ]);
  const counts = {}; const given = {};
  for (const d of days) { counts[d.day_no] = {}; given[d.day_no] = {}; }
  for (const r of slotRows) if (counts[r.day_no]) counts[r.day_no][r.prize_id] = r.n;
  for (const r of playRows) if (given[r.day_no]) given[r.day_no][r.prize_id] = r.n;
  const played = Object.fromEntries(usedRows.map((r) => [r.day_no, Number(r.n)]));
  return { prizes, days, counts, given, locks, played };
}

/** Multi-row insert (one round trip per 300 slots — matters on a remote database). */
export async function insertSlots(q, dayNo, firstSlot, prizeIds) {
  for (let i = 0; i < prizeIds.length; i += 300) {
    const chunk = prizeIds.slice(i, i + 300);
    const params = chunk.flatMap((id, k) => [dayNo, firstSlot + i + k, id]);
    await q.run(`INSERT INTO slots (day_no, slot_no, prize_id) VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}`, params);
  }
}

/** Rebuild a day's not-yet-won slots so the day ends up with exactly `want` of each prize.
 *  `locked` ({ prizeId: [slotNo, …] }) pins prizes to given player numbers; the rest is shuffled. */
async function allocateDay(q, dayNo, want, prizeName, locked = {}) {
  const played = await q.all('SELECT slot_no, prize_id FROM plays WHERE day_no = ? ORDER BY slot_no', [dayNo]);
  const used = played.length ? played[played.length - 1].slot_no : 0;
  const total = Object.values(want).reduce((a, n) => a + n, 0);
  const left = { ...want };
  for (const p of played) left[p.prize_id] = (left[p.prize_id] || 0) - 1;
  for (const [id, n] of Object.entries(left)) {
    if (n < 0) throw new InputError(`Day ${dayNo}: ${prizeName(id)} แจกไปแล้ว ${(want[id] || 0) - n} ชิ้น ตั้งน้อยกว่านี้ไม่ได้`);
  }
  const playedAt = Object.fromEntries(played.map((p) => [p.slot_no, p.prize_id]));
  const fixed = {}; // slotNo → prizeId, only for slots nobody has played yet
  for (const [id, positions] of Object.entries(locked)) {
    for (const n of positions) {
      if (n > total) throw new InputError(`Day ${dayNo}: วันนี้มีผู้ได้รางวัล ${total} คน ล็อกลำดับที่ ${n} ไม่ได้`);
      if (n <= used) {
        if (playedAt[n] && playedAt[n] !== id) throw new InputError(`Day ${dayNo}: คนที่ ${n} เล่นไปแล้ว (ได้${prizeName(playedAt[n])}) เปลี่ยนไม่ได้`);
        continue;
      }
      fixed[n] = id;
      left[id] -= 1;
      if (left[id] < 0) throw new InputError(`Day ${dayNo}: ${prizeName(id)} เหลือไม่พอให้ล็อกตามลำดับที่ใส่`);
    }
  }
  const free = buildSlots(left);
  const list = [];
  for (let n = used + 1; n <= total; n++) list.push(fixed[n] || free.pop());
  await q.run('DELETE FROM slots WHERE day_no = ? AND slot_no > ?', [dayNo, used]);
  await insertSlots(q, dayNo, used + 1, list);
}

/** Validate { prizeId: "10, 25" | [10, 25] } for one day → { prizeId: [10, 25] } (sorted, no empties). */
function parseDayLocks(dayNo, raw, want, names) {
  const out = {}; const seen = new Map();
  for (const [id, value] of Object.entries(raw || {})) {
    if (!names[id]) continue; // prize removed in this save
    const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/).filter(Boolean);
    const nums = [];
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1) throw new InputError(`Day ${dayNo}: ลำดับของ ${names[id]} ต้องเป็นเลข 1 ขึ้นไป`);
      if (seen.has(n)) throw new InputError(`Day ${dayNo}: ลำดับที่ ${n} ถูกใช้กับ ${seen.get(n)} แล้ว`);
      seen.set(n, names[id]);
      nums.push(n);
    }
    if (nums.length > (want[id] || 0)) throw new InputError(`Day ${dayNo}: ${names[id]} มี ${want[id] || 0} ชิ้น แต่ล็อกไว้ ${nums.length} ลำดับ`);
    if (nums.length) out[id] = nums.sort((a, b) => a - b);
  }
  return out;
}

/** `isImage(url)` decides which image URLs may be stored (our own uploads only). */
export async function saveRewards(db, body, { isImage = () => false } = {}) {
  const prizes = Array.isArray(body?.prizes) ? body.prizes : [];
  const counts = body?.counts && typeof body.counts === 'object' ? body.counts : {};
  const lockInput = body?.locks && typeof body.locks === 'object' ? body.locks : null; // null = keep current locks
  if (!prizes.length) throw new InputError('ต้องมีของรางวัลอย่างน้อย 1 รายการ');
  const ids = new Set();
  for (const p of prizes) {
    if (!ID_RE.test(p.id || '') || ids.has(p.id)) throw new InputError('รหัสรางวัลไม่ถูกต้อง');
    if (!String(p.name || '').trim()) throw new InputError('กรุณาตั้งชื่อรางวัลให้ครบ');
    ids.add(p.id);
  }
  const names = Object.fromEntries(prizes.map((p) => [p.id, String(p.name).trim()]));

  await db.tx(async (q) => {
    // Removed prizes: only if never won.
    for (const { id, name } of await q.all('SELECT id, name FROM prizes')) {
      if (ids.has(id)) continue;
      if (await q.get('SELECT 1 AS x FROM plays WHERE prize_id = ? LIMIT 1', [id])) throw new InputError(`"${name}" มีผู้ได้รับไปแล้ว ลบไม่ได้ (ตั้งจำนวนเป็น 0 แทน)`);
      await q.run('DELETE FROM slots WHERE prize_id = ?', [id]);
      await q.run('DELETE FROM prizes WHERE id = ?', [id]);
    }
    let i = 0;
    for (const p of prizes) {
      await q.run(`INSERT INTO prizes (id, name, emoji, color, image, sort) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, color = excluded.color, image = excluded.image, sort = excluded.sort`,
      [p.id, names[p.id], String(p.emoji || '🎁').slice(0, 8), /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#7c3aed',
        isImage(p.image) ? p.image : null, ++i]);
    }

    const current = await readLocks(q);
    const locks = {};
    for (const { day_no: dayNo } of await q.all('SELECT day_no FROM event_days ORDER BY day_no')) {
      const want = {};
      let total = 0;
      for (const id of ids) {
        const n = Number(counts[dayNo]?.[id] ?? 0);
        if (!Number.isInteger(n) || n < 0) throw new InputError(`Day ${dayNo}: จำนวน ${names[id]} ต้องเป็นตัวเลข 0 ขึ้นไป`);
        if (n) want[id] = n;
        total += n;
      }
      if (total > MAX_PER_DAY) throw new InputError(`Day ${dayNo}: รวมเกิน ${MAX_PER_DAY} รางวัล`);
      const dayLocks = parseDayLocks(dayNo, (lockInput || current)[dayNo], want, names);
      if (Object.keys(dayLocks).length) locks[dayNo] = dayLocks;
      await allocateDay(q, dayNo, want, (id) => names[id] || id, dayLocks);
    }
    await writeLocks(q, locks);
  }, { lock: 4242 });
}

/** Replace the event days with a continuous date range. `open_time`/`close_time` are the default hours;
 *  `times` ({ 'YYYY-MM-DD': { open_time, close_time } }) overrides them for individual days. */
export async function saveSchedule(db, body) {
  const { start, end, open_time: open, close_time: close } = body || {};
  const times = body?.times && typeof body.times === 'object' ? body.times : {};
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '')) throw new InputError('กรุณาเลือกวันเริ่มและวันสิ้นสุด');
  if (end < start) throw new InputError('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (!TIME_RE.test(open || '') || !TIME_RE.test(close || '') || open >= close) throw new InputError('เวลาเปิดต้องก่อนเวลาปิด');
  const dates = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_DAYS) throw new InputError(`เลือกได้ไม่เกิน ${MAX_DAYS} วัน`);
  }
  const hours = (date) => {
    const t = times[date];
    const o = t?.open_time || open; const c = t?.close_time || close;
    if (!TIME_RE.test(o) || !TIME_RE.test(c) || o >= c) throw new InputError(`${date}: เวลาเปิดต้องก่อนเวลาปิด`);
    return [o, c];
  };
  dates.forEach(hours); // validate before touching anything

  await db.tx(async (q) => {
    const old = await q.all('SELECT * FROM event_days ORDER BY day_no');
    // Days that already have players must keep their Day number and date.
    for (const d of old) {
      if (!(await q.get('SELECT 1 AS x FROM plays WHERE day_no = ? LIMIT 1', [d.day_no]))) continue;
      if (dates[d.day_no - 1] !== d.date) {
        throw new InputError(`Day ${d.day_no} (${d.date}) มีผู้เล่นแล้ว — ช่วงวันใหม่ต้องยังมีวันนี้เป็น Day ${d.day_no}`, 'has_players');
      }
    }
    // New days start with the same prize counts as the last existing day.
    const template = old.length
      ? Object.fromEntries((await q.all('SELECT prize_id, COUNT(*) AS n FROM slots WHERE day_no = ? GROUP BY prize_id', [old[old.length - 1].day_no])).map((r) => [r.prize_id, r.n]))
      : {};

    for (const d of old) {
      if (d.day_no > dates.length) {
        await q.run('DELETE FROM slots WHERE day_no = ?', [d.day_no]);
        await q.run('DELETE FROM event_days WHERE day_no = ?', [d.day_no]);
      } else {
        await q.run('UPDATE event_days SET date = ? WHERE day_no = ?', [`tmp-${d.day_no}`, d.day_no]); // avoid UNIQUE(date) clashes
      }
    }
    for (const [i, date] of dates.entries()) {
      const dayNo = i + 1;
      const isNew = !old.some((d) => d.day_no === dayNo);
      await q.run(`INSERT INTO event_days (day_no, date, open_time, close_time) VALUES (?, ?, ?, ?)
        ON CONFLICT(day_no) DO UPDATE SET date = excluded.date, open_time = excluded.open_time, close_time = excluded.close_time`,
      [dayNo, date, ...hours(date)]);
      if (isNew) await allocateDay(q, dayNo, template, (id) => id);
    }
    // A day number that was dropped or re-created starts without locked positions.
    const locks = await readLocks(q);
    let changed = false;
    for (const k of Object.keys(locks)) {
      if (Number(k) > dates.length || !old.some((d) => d.day_no === Number(k))) { delete locks[k]; changed = true; }
    }
    if (changed) await writeLocks(q, locks);
  }, { lock: 4242 });
}

/** Start the real event clean: remove every player and play (prizes, counts, dates, promotions stay). */
export function resetPlays(db) {
  return db.tx(async (q) => {
    const { n: plays } = await q.get('SELECT COUNT(*) AS n FROM plays');
    const { n: players } = await q.get('SELECT COUNT(*) AS n FROM players');
    await q.run('DELETE FROM plays');
    await q.run('DELETE FROM players');
    return { plays, players };
  }, { lock: 4242 });
}
