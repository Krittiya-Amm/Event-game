import { randomInt } from 'node:crypto';
import { getSettings } from './db.js';
import { normalizeService } from './services.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

const PLAY_SELECT = `
  SELECT pl.id, pl.code, pl.day_no, pl.date, pl.slot_no, pl.revealed_at, pl.redeemed_at, pl.redeemed_by, pl.created_at,
         pl.line_user_id, pr.id AS prize_id, pr.name AS prize_name, pr.emoji AS prize_emoji, pr.color AS prize_color, pr.image AS prize_image,
         c.brand AS coupon_brand, c.benefit AS coupon_benefit, c.service AS coupon_service
  FROM plays pl
  JOIN prizes pr ON pr.id = pl.prize_id
  LEFT JOIN coupons c ON c.id = pl.coupon_id`;

const SQL = {
  day: 'SELECT * FROM event_days WHERE date = ?',
  days: 'SELECT * FROM event_days ORDER BY day_no',
  player: 'SELECT * FROM players WHERE line_user_id = ?',
  playerByPhone: 'SELECT * FROM players WHERE phone = ? AND line_user_id <> ?',
  hasPlayed: 'SELECT 1 AS x FROM plays WHERE line_user_id = ? LIMIT 1',
  deletePlayer: 'DELETE FROM players WHERE line_user_id = ?',
  upsertPlayer: `
    INSERT INTO players (line_user_id, line_name, name, company, phone, consent, interest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(line_user_id) DO UPDATE SET line_name = excluded.line_name, name = excluded.name,
      company = excluded.company, phone = excluded.phone, consent = excluded.consent, interest = excluded.interest`,
  playByUser: `${PLAY_SELECT} WHERE pl.line_user_id = ? ORDER BY pl.id DESC LIMIT 1`,
  playByUserDay: `${PLAY_SELECT} WHERE pl.line_user_id = ? AND pl.day_no = ?`,
  playByCode: `${PLAY_SELECT} WHERE pl.code = ?`,
  usedToday: 'SELECT COUNT(*) AS n, COALESCE(MAX(slot_no), 0) AS max_slot FROM plays WHERE day_no = ?',
  slot: 'SELECT prize_id FROM slots WHERE day_no = ? AND slot_no = ?',
  slotCount: 'SELECT COUNT(*) AS n FROM slots WHERE day_no = ?',
  activeCoupons: 'SELECT id, service FROM coupons WHERE active = 1',
  codeExists: 'SELECT 1 AS x FROM plays WHERE code = ?',
  insertPlay: `
    INSERT INTO plays (line_user_id, day_no, date, slot_no, prize_id, coupon_id, code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  reveal: 'UPDATE plays SET revealed_at = ? WHERE code = ? AND line_user_id = ? AND revealed_at IS NULL',
  redeem: 'UPDATE plays SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND redeemed_at IS NULL',
  claim: 'UPDATE plays SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND line_user_id = ? AND redeemed_at IS NULL',
};

export function publicPlay(p) {
  if (!p) return null;
  return {
    code: p.code,
    dayNo: p.day_no,
    date: p.date,
    prize: { id: p.prize_id, name: p.prize_name, emoji: p.prize_emoji, color: p.prize_color, image: p.prize_image },
    coupon: p.coupon_brand ? { brand: p.coupon_brand, benefit: p.coupon_benefit, service: normalizeService(p.coupon_service) || null } : null,
    revealed: !!p.revealed_at,
    redeemed: !!p.redeemed_at,
    redeemedAt: p.redeemed_at,
  };
}

/** Promotion for the service the player picked; any active one if none is set up for it. */
function pickCoupon(coupons, interest) {
  const want = normalizeService(interest); // old and new ids both match
  const match = coupons.filter((c) => want && normalizeService(c.service) === want);
  const pool = match.length ? match : coupons;
  return pool.length ? pool[randomInt(pool.length)] : null;
}

const PLAY_LOCK = 4242; // advisory lock id for prize draws (Postgres)

export function createGame(db, clock) {
  /** Where is the event right now? → { now, open, day, today, next } */
  async function window(q = db) {
    const now = clock();
    const day = await q.get(SQL.day, [now.date]);
    const open = !!day && now.time >= day.open_time && now.time < day.close_time;
    const days = await q.all(SQL.days);
    const next = days.find((d) => d.date > now.date || (d.date === now.date && now.time < d.open_time)) || null;
    return { now, open, day: open ? day : null, today: day || null, next, days };
  }

  const existingPlay = (q, uid, dayNo, limit) => (limit === 'day' ? q.get(SQL.playByUserDay, [uid, dayNo]) : q.get(SQL.playByUser, [uid]));

  async function state(uid) {
    const [s, w, player, last] = await Promise.all([getSettings(db), window(), db.get(SQL.player, [uid]), db.get(SQL.playByUser, [uid])]);
    // `me` = the player's own lead details (only ever returned to that same player) for the survey hand-off.
    const me = player ? { name: player.name, company: player.company, phone: player.phone, callbackAt: player.callback_at || null } : null;
    const base = { days: w.days, registered: !!player, playerName: player?.name || null, me, lastPlay: publicPlay(last), now: w.now };
    if (!w.open) return { ...base, status: 'closed', next: w.next };
    const [{ n: used }, { n: limit }, prior] = await Promise.all([
      db.get(SQL.usedToday, [w.day.day_no]), db.get(SQL.slotCount, [w.day.day_no]), existingPlay(db, uid, w.day.day_no, s.play_limit),
    ]);
    const today = { dayNo: w.day.day_no, remaining: Math.max(0, limit - used), limit };
    if (prior) return { ...base, ...today, status: 'played', play: publicPlay(prior) };
    if (used >= limit) return { ...base, ...today, status: 'soldout', next: w.days.find((d) => d.date > w.now.date) || null };
    if (!player) return { ...base, ...today, status: 'register' };
    return { ...base, ...today, status: 'ready' };
  }

  /** One phone number = one player. A phone already used by another device that has played is rejected;
   *  one that only registered (e.g. cleared browser before playing) moves to this device. */
  function register(uid, lineName, { name, company, phone, consent, interest }) {
    return db.tx(async (q) => {
      for (const other of await q.all(SQL.playerByPhone, [phone, uid])) {
        if (await q.get(SQL.hasPlayed, [other.line_user_id])) return { error: 'phone_used' };
        await q.run(SQL.deletePlayer, [other.line_user_id]);
      }
      await q.run(SQL.upsertPlayer, [uid, lineName || null, name, company, phone, consent ? 1 : 0, interest || null, clock().iso]);
      return { ok: true };
    }, { lock: PLAY_LOCK });
  }

  /** Allocate the next slot for this player. Serialised (SQLite: one writer; Postgres: advisory lock), and the
   *  UNIQUE(day_no, slot_no) / UNIQUE(line_user_id, day_no) constraints back it up — never over the day's prizes. */
  function play(uid) {
    return db.tx(async (q) => {
      const s = await getSettings(q);
      const w = await window(q);
      if (!w.open) return { status: 'closed' };
      const player = await q.get(SQL.player, [uid]);
      if (!player) return { status: 'register' };

      const prior = await existingPlay(q, uid, w.day.day_no, s.play_limit);
      if (prior) return { status: 'played', play: publicPlay(prior) };

      const { max_slot: maxSlot } = await q.get(SQL.usedToday, [w.day.day_no]);
      const slotNo = Number(maxSlot) + 1;
      const slot = await q.get(SQL.slot, [w.day.day_no, slotNo]);
      if (!slot) return { status: 'soldout' }; // no prize left for today

      let code;
      do code = genCode(); while (await q.get(SQL.codeExists, [code]));
      const coupon = pickCoupon(await q.all(SQL.activeCoupons), player.interest);
      await q.run(SQL.insertPlay, [uid, w.day.day_no, w.now.date, slotNo, slot.prize_id, coupon?.id ?? null, code, w.now.iso]);
      return { status: 'won', play: publicPlay(await q.get(SQL.playByCode, [code])) };
    }, { lock: PLAY_LOCK });
  }

  async function reveal(uid, code) {
    await db.run(SQL.reveal, [clock().iso, code, uid]);
  }

  async function lookup(code) {
    const p = await db.get(SQL.playByCode, [String(code || '').trim().toUpperCase()]);
    if (!p) return null;
    const player = await db.get(SQL.player, [p.line_user_id]);
    return { ...publicPlay(p), slotNo: p.slot_no, redeemedBy: p.redeemed_by, player };
  }

  /** Staff confirm. Returns { ok, reason, play }. A code can only be redeemed once. */
  async function redeem(code, staffName) {
    const c = String(code || '').trim().toUpperCase();
    const res = await db.run(SQL.redeem, [clock().iso, staffName || 'staff', c]);
    const play = await lookup(c);
    if (!play) return { ok: false, reason: 'not_found' };
    if (res.changes === 0) return { ok: false, reason: 'already_redeemed', play };
    return { ok: true, play };
  }

  /** Player-side confirm at the booth: staff types their code on the player's phone. Only the player's own code. */
  async function claim(uid, code, staffName) {
    const c = String(code || '').trim().toUpperCase();
    const res = await db.run(SQL.claim, [clock().iso, staffName, c, uid]);
    const p = await db.get(SQL.playByCode, [c]);
    if (!p || p.line_user_id !== uid) return { ok: false, reason: 'not_found' };
    if (res.changes === 0) return { ok: false, reason: 'already_redeemed', play: publicPlay(p) };
    return { ok: true, play: publicPlay(p) };
  }

  /** "นัดคุยกับทีม": flag the lead for a call-back (first tap wins; repeats are no-ops). → ISO time or null */
  async function requestCallback(uid) {
    await db.run('UPDATE players SET callback_at = COALESCE(callback_at, ?) WHERE line_user_id = ?', [clock().iso, uid]);
    return (await db.get('SELECT callback_at FROM players WHERE line_user_id = ?', [uid]))?.callback_at || null;
  }

  return { window, state, register, play, reveal, lookup, redeem, claim, requestCallback };
}
