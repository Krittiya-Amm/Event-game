import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { bangkokNow } from '../src/time.js';
import { seedIfEmpty } from '../src/seed.js';
import { PG_SCHEMA, TABLES } from '../src/db.js';

async function resetPg(url) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
  await c.query(PG_SCHEMA);
  await c.end();
}

const env = { ADMIN_USERNAME: 'martech', ADMIN_PASSWORD: 'admin-test', STAFF_PIN: 'staff-test', WEB_PLAY: '1' };

// Controllable clock in Bangkok time.
function makeClock(date, time) {
  const c = { date, time };
  const fn = () => ({ date: c.date, time: c.time, iso: `${c.date}T${c.time}:00+07:00` });
  fn.set = (d, t) => { c.date = d; c.time = t; };
  return fn;
}

async function boot({ limit = 'event' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
  const clock = makeClock('2026-11-01', '10:00');
  // TEST_DATABASE_URL runs the whole suite against Postgres (fresh schema per test); default is SQLite.
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) await resetPg(pgUrl);
  const { app, db } = await createApp({ dbFile: join(dir, 'db.sqlite'), env: { ...env, DATABASE_URL: pgUrl || '' }, clock });
  if (pgUrl) await seedIfEmpty(db, { startDate: clock().date });
  await db.run("UPDATE settings SET value = ? WHERE key = 'play_limit'", [limit]);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { uid, method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(uid ? { 'x-device-id': uid } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  let phoneSeq = 0;
  const register = (uid, phone = `08${String(10000000 + ++phoneSeq).slice(-8)}`, consent = true, interest = 'line_oa') =>
    call('/api/register', { uid, method: 'POST', body: { name: `Player ${uid}`, company: 'ACME', phone, consent, interest } });
  const login = await call('/api/admin/login', { method: 'POST', body: { username: 'martech', password: 'admin-test' } });
  const admin = { 'x-admin-key': login.body.token };
  return { db, clock, call, register, base, admin, close: async () => { server.close(); await db.close(); } };
}

test('Bangkok clock rolls over at local midnight, not UTC', () => {
  assert.deepEqual(bangkokNow(new Date('2026-11-01T16:59:00Z')).date, '2026-11-01');
  assert.deepEqual(bangkokNow(new Date('2026-11-01T17:00:00Z')).date, '2026-11-02');
  assert.equal(bangkokNow(new Date('2026-11-01T17:00:00Z')).time, '00:00');
});

test('200 concurrent players → exactly 50 winners, prizes match the slot config', async () => {
  const t = await boot();
  try {
    const uids = Array.from({ length: 200 }, (_, i) => `W-concurrent-${String(i).padStart(4, '0')}`);
    await Promise.all(uids.map((uid) => t.register(uid)));
    const results = await Promise.all(uids.map((uid) => t.call('/api/play', { uid, method: 'POST' })));

    const won = results.filter((r) => r.body.status === 'won');
    const soldout = results.filter((r) => r.body.status === 'soldout');
    assert.equal(won.length, 50);
    assert.equal(soldout.length, 150);

    const plays = (await t.db.all('SELECT slot_no, prize_id FROM plays WHERE day_no = 1 ORDER BY slot_no', []));
    assert.deepEqual(plays.map((p) => p.slot_no), Array.from({ length: 50 }, (_, i) => i + 1));
    const slots = (await t.db.all('SELECT slot_no, prize_id FROM slots WHERE day_no = 1 ORDER BY slot_no', []));
    assert.deepEqual(plays, slots, 'player N gets exactly the prize in slot N');

    const tally = {}; for (const p of plays) tally[p.prize_id] = (tally[p.prize_id] || 0) + 1;
    assert.deepEqual(tally, { keychain: 5, card: 45 }); // Day 1 default distribution
    assert.equal(new Set(won.map((r) => r.body.play.code)).size, 50, 'codes are unique');
  } finally { await t.close(); }
});

test('same LINE ID cannot play twice (parallel double-tap returns the same result)', async () => {
  const t = await boot();
  try {
    await t.register('W-double-tap');
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => t.call('/api/play', { uid: 'W-double-tap', method: 'POST' })));
    const statuses = [a, b, c].map((r) => r.body.status).sort();
    assert.deepEqual(statuses, ['played', 'played', 'won']);
    assert.equal(new Set([a, b, c].map((r) => r.body.play.code)).size, 1);
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM plays', [])).n, 1);

    // 'event' limit: next day still blocked.
    t.clock.set('2026-11-02', '10:00');
    const next = await t.call('/api/play', { uid: 'W-double-tap', method: 'POST' });
    assert.equal(next.body.status, 'played');
  } finally { await t.close(); }
});

test("play_limit='day' allows one play per day", async () => {
  const t = await boot({ limit: 'day' });
  try {
    await t.register('W-daily-player');
    assert.equal((await t.call('/api/play', { uid: 'W-daily-player', method: 'POST' })).body.status, 'won');
    assert.equal((await t.call('/api/play', { uid: 'W-daily-player', method: 'POST' })).body.status, 'played');
    t.clock.set('2026-11-02', '10:00');
    assert.equal((await t.call('/api/play', { uid: 'W-daily-player', method: 'POST' })).body.status, 'won');
  } finally { await t.close(); }
});

test('game is closed outside open hours and outside event days', async () => {
  const t = await boot();
  try {
    await t.register('W-early-bird');
    t.clock.set('2026-11-01', '08:59');
    assert.equal((await t.call('/api/play', { uid: 'W-early-bird', method: 'POST' })).body.status, 'closed');
    t.clock.set('2026-11-01', '18:00');
    assert.equal((await t.call('/api/play', { uid: 'W-early-bird', method: 'POST' })).body.status, 'closed');
    t.clock.set('2026-11-09', '10:00');
    const s = await t.call('/api/state', { uid: 'W-early-bird' });
    assert.equal(s.body.status, 'closed');
    assert.equal(s.body.next, null);
  } finally { await t.close(); }
});

test('must register before playing; bad lead data is rejected', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/play', { uid: 'W-no-register', method: 'POST' })).body.status, 'register');
    const bad = await t.call('/api/register', { uid: 'W-no-register', method: 'POST', body: { name: 'A', company: '', phone: '123' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.body.errors).sort(), ['company', 'interest', 'name', 'phone']);
    assert.equal((await t.call('/api/state')).status, 401, 'no identity → 401');
  } finally { await t.close(); }
});

test('staff can redeem a code once only', async () => {
  const t = await boot();
  try {
    await t.register('W-winner-0001');
    const { body } = await t.call('/api/play', { uid: 'W-winner-0001', method: 'POST' });
    const staff = { 'x-staff-key': 'staff-test' };
    assert.equal((await t.call(`/api/staff/lookup?code=${body.play.code}`)).status, 401);
    const look = await t.call(`/api/staff/lookup?code=${body.play.code.toLowerCase()}`, { headers: staff });
    assert.equal(look.body.play.player.name, 'Player W-winner-0001');

    const [r1, r2] = await Promise.all([1, 2].map(() =>
      t.call('/api/staff/redeem', { method: 'POST', headers: staff, body: { code: body.play.code, staffName: 'Neen' } })));
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal((await t.call('/api/staff/redeem', { method: 'POST', headers: staff, body: { code: 'ZZZZZZ' } })).status, 404);

    const state = await t.call('/api/state', { uid: 'W-winner-0001' });
    assert.equal(state.body.play.redeemed, true);
  } finally { await t.close(); }
});

test('consent is optional and stored; shows in CSV', async () => {
  const t = await boot();
  try {
    assert.equal((await t.register('W-consent-yes', '0811111111', true)).status, 200);
    assert.equal((await t.register('W-consent-no', '0822222222', false)).status, 200);
    const rows = Object.fromEntries((await t.db.all('SELECT line_user_id, consent FROM players', [])).map((r) => [r.line_user_id, r.consent]));
    assert.deepEqual(rows, { 'W-consent-yes': 1, 'W-consent-no': 0 });
    // Not consenting still lets you play.
    assert.equal((await t.call('/api/play', { uid: 'W-consent-no', method: 'POST' })).body.status, 'won');
    const csv = await t.call('/api/admin/export.csv', { headers: t.admin });
    assert.match(csv.body, /W-consent-no,.*,ไม่ยินยอม,/);
    assert.match(csv.body, /W-consent-yes,.*,ยินยอม,/);
  } finally { await t.close(); }
});

test('player-side claim needs a staff name, works once, only for your own code', async () => {
  const t = await boot();
  try {
    await t.register('W-claim-owner'); await t.register('W-claim-other');
    const { body } = await t.call('/api/play', { uid: 'W-claim-owner', method: 'POST' });
    const code = body.play.code;
    assert.equal((await t.call('/api/claim', { uid: 'W-claim-owner', method: 'POST', body: { code, staffName: '' } })).status, 400);
    assert.equal((await t.call('/api/claim', { uid: 'W-claim-other', method: 'POST', body: { code, staffName: 'Neen' } })).status, 404);
    assert.equal((await t.call('/api/claim', { uid: 'W-claim-owner', method: 'POST', body: { code, staffName: 'Neen' } })).status, 200);
    assert.equal((await t.call('/api/claim', { uid: 'W-claim-owner', method: 'POST', body: { code, staffName: 'Neen' } })).status, 409);
    assert.equal((await t.db.get('SELECT redeemed_by FROM plays WHERE code = ?', [code])).redeemed_by, 'Neen');
  } finally { await t.close(); }
});

test('rewards: counts drive the daily cap; cannot go below what was won; prize add/remove', async () => {
  const t = await boot();
  const admin = t.admin;
  const put = (body) => t.call('/api/admin/rewards', { method: 'PUT', headers: admin, body });
  try {
    const cur = (await t.call('/api/admin/rewards', { headers: admin })).body;
    assert.deepEqual(cur.counts[1], { keychain: 5, card: 45 });
    const prizes = [...cur.prizes, { id: 'p-cap', name: 'หมวก', emoji: '🧢', color: '#123456' }];
    const counts = { 1: { doll: 0, keychain: 1, card: 1, 'p-cap': 1 }, 2: { card: 2 }, 3: {}, 4: {} };
    assert.equal((await put({ prizes, counts })).status, 200);
    const slots = (await t.db.all('SELECT prize_id FROM slots WHERE day_no = 1', [])).map((r) => r.prize_id).sort();
    assert.deepEqual(slots, ['card', 'keychain', 'p-cap']);

    // Day 1 now has exactly 3 prizes → 4th player is sold out.
    for (const u of ['W-cap-000001', 'W-cap-000002', 'W-cap-000003', 'W-cap-000004']) await t.register(u);
    const res = [];
    for (const u of ['W-cap-000001', 'W-cap-000002', 'W-cap-000003', 'W-cap-000004']) res.push((await t.call('/api/play', { uid: u, method: 'POST' })).body.status);
    assert.deepEqual(res, ['won', 'won', 'won', 'soldout']);

    // Lowering a prize below what was already won is rejected.
    const low = await put({ prizes, counts: { ...counts, 1: { keychain: 0, card: 1, 'p-cap': 1 } } });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /แจกไปแล้ว/);
    // Removing a prize that was won is rejected; removing an unused one works.
    assert.equal((await put({ prizes: prizes.filter((p) => p.id !== 'p-cap'), counts })).status, 400);
    assert.equal((await put({ prizes: prizes.filter((p) => p.id !== 'doll'), counts })).status, 200);
    assert.equal((await t.db.get("SELECT COUNT(*) AS n FROM prizes WHERE id = 'doll'", [])).n, 0);
  } finally { await t.close(); }
});

test('schedule: date range rebuilds days; days with players keep their date', async () => {
  const t = await boot();
  const admin = t.admin;
  const put = (body) => t.call('/api/admin/schedule', { method: 'PUT', headers: admin, body });
  try {
    assert.equal((await put({ start: '2026-11-01', end: '2026-11-06', open_time: '10:00', close_time: '20:00' })).status, 200);
    const days = (await t.db.all('SELECT * FROM event_days ORDER BY day_no', []));
    assert.equal(days.length, 6);
    assert.deepEqual([days[0].date, days[5].date], ['2026-11-01', '2026-11-06']);
    assert.ok(days.every((d) => d.open_time === '10:00' && d.close_time === '20:00'));
    // New Day 5/6 copy the prize counts of the last existing day (Day 4: 1 doll, 5 keychain, 44 card).
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM slots WHERE day_no = 6', [])).n, 50);

    await t.register('W-sched-player');
    assert.equal((await t.call('/api/play', { uid: 'W-sched-player', method: 'POST' })).body.status, 'won');
    // Day 1 (Nov 1) has a player → can't move the start date, but can shorten the end.
    assert.equal((await put({ start: '2026-11-02', end: '2026-11-06', open_time: '10:00', close_time: '20:00' })).status, 400);
    assert.equal((await put({ start: '2026-11-01', end: '2026-11-03', open_time: '09:00', close_time: '18:00' })).status, 200);
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM event_days', [])).n, 3);
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM slots WHERE day_no > 3', [])).n, 0);
    assert.equal((await put({ start: '2026-11-05', end: '2026-11-01', open_time: '09:00', close_time: '18:00' })).status, 400);
  } finally { await t.close(); }
});

test('one phone number = one player: reused after playing is rejected, before playing it moves device', async () => {
  const t = await boot();
  try {
    await t.register('W-phone-first', '0899999999');
    // Same phone on a new device before playing → allowed, old registration moves over.
    assert.equal((await t.register('W-phone-second', '0899999999')).status, 200);
    assert.equal((await t.db.get("SELECT COUNT(*) AS n FROM players WHERE phone = '0899999999'", [])).n, 1);
    assert.equal((await t.call('/api/play', { uid: 'W-phone-second', method: 'POST' })).body.status, 'won');
    // After playing → a third device can't reuse the number.
    const again = await t.register('W-phone-third', '089-999-9999');
    assert.equal(again.status, 400);
    assert.ok(again.body.errors.phone);
  } finally { await t.close(); }
});

test('staff PIN is locked out after repeated wrong attempts', async () => {
  const t = await boot();
  try {
    for (let i = 0; i < 8; i++) {
      assert.equal((await t.call('/api/staff/ping', { headers: { 'x-staff-key': `wrong-${i}` } })).status, 401);
    }
    assert.equal((await t.call('/api/staff/ping', { headers: { 'x-staff-key': 'staff-test' } })).status, 429);
  } finally { await t.close(); }
});

test('booth poster QR points at the game', async () => {
  const t = await boot();
  try {
    const r = await t.call('/api/qr-entry');
    assert.equal(r.status, 200);
    assert.match(r.body, /<svg/);
  } finally { await t.close(); }
});

test('interested service is required, stored, and decides the promotion', async () => {
  const t = await boot();
  try {
    const bad = await t.register('W-svc-missing', '0833333333', true, '');
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.interest);
    // Old (first-version) ids are no longer accepted from the form.
    assert.equal((await t.register('W-svc-legacy', '0833333334', true, 'line')).status, 400);
    const expect = { line_oa: ['LINE'], ads_content: ['Wizemoves Influencer', 'Wizemoves Ads', 'Wizemoves Content'], line_martech: ['Wizemoves Martech'], warehouse: ['Akita'] };
    for (const [svc, brands] of Object.entries(expect)) {
      const uid = `W-svc-${svc.replace(/_/g, '-')}-00`; // device ids allow letters, digits and '-'
      assert.equal((await t.register(uid, undefined, true, svc)).status, 200);
      const { body } = await t.call('/api/play', { uid, method: 'POST' });
      assert.ok(brands.includes(body.play.coupon.brand), `${svc} → ${body.play.coupon.brand}`);
      assert.equal(body.play.coupon.service, svc);
    }
    // A promotion still tagged with an old id matches the new option.
    await t.db.run("UPDATE coupons SET service = 'warehouse' WHERE brand = 'Akita'");
    await t.db.run("UPDATE coupons SET service = 'line' WHERE brand = 'LINE'");
    await t.register('W-svc-oldcoupon', undefined, true, 'line_oa');
    assert.equal((await t.call('/api/play', { uid: 'W-svc-oldcoupon', method: 'POST' })).body.play.coupon.brand, 'LINE');
    const cfg = (await t.call('/api/admin/config', { headers: t.admin })).body;
    assert.equal(cfg.coupons.find((c) => c.brand === 'LINE').service, 'line_oa');
    assert.equal(cfg.services.length, 11);
    const csv = await t.call('/api/admin/export.csv', { headers: t.admin });
    assert.match(csv.body, /W-svc-warehouse-00,.*,คลังสินค้าและขนส่ง,"?Akita, Patona"?,/);
  } finally { await t.close(); }
});

test('schedule: per-day hours override the default; reset-plays clears test data so days can move', async () => {
  const t = await boot();
  const admin = t.admin;
  const put = (body) => t.call('/api/admin/schedule', { method: 'PUT', headers: admin, body });
  try {
    const ok = await put({ start: '2026-11-01', end: '2026-11-03', open_time: '09:00', close_time: '18:00',
      times: { '2026-11-02': { open_time: '10:00', close_time: '21:30' } } });
    assert.equal(ok.status, 200);
    const days = (await t.db.all('SELECT date, open_time, close_time FROM event_days ORDER BY day_no', [])).map((d) => `${d.date} ${d.open_time}-${d.close_time}`);
    assert.deepEqual(days, ['2026-11-01 09:00-18:00', '2026-11-02 10:00-21:30', '2026-11-03 09:00-18:00']);
    const bad = await put({ start: '2026-11-01', end: '2026-11-01', open_time: '09:00', close_time: '18:00', times: { '2026-11-01': { open_time: '20:00', close_time: '19:00' } } });
    assert.equal(bad.status, 400);

    await t.register('W-reset-player');
    await t.call('/api/play', { uid: 'W-reset-player', method: 'POST' });
    const moved = await put({ start: '2026-11-05', end: '2026-11-07', open_time: '09:00', close_time: '18:00' });
    assert.equal(moved.status, 400);
    assert.equal(moved.body.code, 'has_players');

    assert.equal((await t.call('/api/admin/reset-plays', { method: 'POST', headers: admin, body: {} })).status, 400);
    const r = await t.call('/api/admin/reset-plays', { method: 'POST', headers: admin, body: { confirm: 'RESET' } });
    assert.deepEqual([r.status, r.body.players, r.body.plays], [200, 1, 1]);
    assert.equal((await put({ start: '2026-11-05', end: '2026-11-07', open_time: '09:00', close_time: '18:00' })).status, 200);
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM prizes', [])).n, 3, 'prizes are kept');
  } finally { await t.close(); }
});

test('prize image: upload a raster image, attach it to a prize, it shows in game config', async () => {
  const t = await boot();
  const admin = t.admin;
  try {
    const base = t.base;
    // 1×1 transparent PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await fetch(`${base}/api/admin/upload`, { method: 'POST', headers: { ...admin, 'Content-Type': 'image/png' }, body: png });
    assert.equal(up.status, 200);
    const { url } = await up.json();
    assert.match(url, /^\/uploads\/prize-[a-z0-9-]+\.png$/);
    const file = await fetch(base + url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');

    // Wrong type / spoofed type / no auth are rejected.
    const svg = await fetch(`${base}/api/admin/upload`, { method: 'POST', headers: { ...admin, 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
    assert.equal(svg.status, 400);
    const fake = await fetch(`${base}/api/admin/upload`, { method: 'POST', headers: { ...admin, 'Content-Type': 'image/png' }, body: 'not really a png at all' });
    assert.equal(fake.status, 400);
    assert.equal((await fetch(`${base}/api/admin/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 401);

    const cur = (await t.call('/api/admin/rewards', { headers: admin })).body;
    const prizes = cur.prizes.map((p) => (p.id === 'card' ? { ...p, image: url } : p));
    assert.equal((await t.call('/api/admin/rewards', { method: 'PUT', headers: admin, body: { prizes, counts: cur.counts } })).status, 200);
    const cfg = (await t.call('/api/config')).body;
    assert.equal(cfg.prizes.find((p) => p.id === 'card').image, url);
    // Anything that isn't one of our upload paths is dropped.
    const evil = cur.prizes.map((p) => (p.id === 'card' ? { ...p, image: 'javascript:alert(1)' } : p));
    await t.call('/api/admin/rewards', { method: 'PUT', headers: admin, body: { prizes: evil, counts: cur.counts } });
    assert.equal((await t.call('/api/config')).body.prizes.find((p) => p.id === 'card').image, null);
  } finally { await t.close(); }
});

test('backoffice login: username + password give a session; wrong ones and old static key do not', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/admin/config', { headers: t.admin })).status, 200);
    assert.equal((await t.call('/api/admin/config', { headers: { 'x-admin-key': 'admin-test' } })).status, 401, 'raw password is not a key');
    const bad = await t.call('/api/admin/login', { method: 'POST', body: { username: 'martech', password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal((await t.call('/api/admin/login', { method: 'POST', body: { username: 'someone', password: 'admin-test' } })).status, 401);
    const ok = await t.call('/api/admin/login', { method: 'POST', body: { username: 'Martech ', password: 'admin-test' } });
    assert.equal(ok.status, 200);
    const h = { 'x-admin-key': ok.body.token };
    assert.equal((await t.call('/api/admin/logout', { method: 'POST', headers: h })).status, 200);
    assert.equal((await t.call('/api/admin/config', { headers: h })).status, 401, 'logged-out token is dead');
  } finally { await t.close(); }
});

test('rewards: locked positions put a prize on exact player numbers; the rest stays random', async () => {
  const t = await boot();
  try {
    const put = (body) => t.call('/api/admin/rewards', { method: 'PUT', headers: t.admin, body });
    const cur = (await t.call('/api/admin/rewards', { headers: t.admin })).body;
    const counts = { ...cur.counts, 1: { doll: 3, keychain: 5, card: 42 } };
    // Validation: more positions than the prize count, duplicates across prizes, beyond the day's total.
    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: '1, 2, 3, 4' } } })).status, 400);
    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: '7', keychain: '7' } } })).status, 400);
    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: '51' } } })).status, 400);
    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: 'abc' } } })).status, 400);

    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: '10, 25 40', keychain: [1] } } })).status, 200);
    const saved = (await t.call('/api/admin/rewards', { headers: t.admin })).body;
    assert.deepEqual(saved.locks, { 1: { doll: [10, 25, 40], keychain: [1] } });
    const at = Object.fromEntries((await t.db.all('SELECT slot_no, prize_id FROM slots WHERE day_no = 1', [])).map((r) => [r.slot_no, r.prize_id]));
    assert.equal(at[10], 'doll'); assert.equal(at[25], 'doll'); assert.equal(at[40], 'doll'); assert.equal(at[1], 'keychain');
    assert.equal(Object.values(at).filter((p) => p === 'doll').length, 3);
    assert.equal(Object.values(at).length, 50);

    // Player 1 gets the keychain; saving again without `locks` keeps the locks and the played slot.
    await t.register('W-lock-0001');
    assert.equal((await t.call('/api/play', { uid: 'W-lock-0001', method: 'POST' })).body.play.prize.id, 'keychain');
    assert.equal((await put({ prizes: cur.prizes, counts })).status, 200);
    assert.deepEqual((await t.call('/api/admin/rewards', { headers: t.admin })).body.locks, { 1: { doll: [10, 25, 40], keychain: [1] } });
    // A played position cannot be re-locked to a different prize.
    assert.equal((await put({ prizes: cur.prizes, counts, locks: { 1: { doll: '1' } } })).status, 400);
    // Clearing the locks works.
    assert.equal((await put({ prizes: cur.prizes, counts, locks: {} })).status, 200);
    assert.deepEqual((await t.call('/api/admin/rewards', { headers: t.admin })).body.locks, {});
  } finally { await t.close(); }
});

test('state returns the player\'s own lead details (for the survey link) and nobody else\'s', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/state', { uid: 'W-me-000001' })).body.me, null);
    await t.register('W-me-000001', '0811112222');
    const mine = (await t.call('/api/state', { uid: 'W-me-000001' })).body.me;
    assert.deepEqual(mine, { name: 'Player W-me-000001', company: 'ACME', phone: '0811112222', callbackAt: null });
    assert.equal((await t.call('/api/state', { uid: 'W-me-000002' })).body.me, null);
  } finally { await t.close(); }
});

test('"นัดคุยกับทีม": player requests a call-back once; Backoffice lists it and marks it contacted', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/contact-request', { uid: 'W-cb-nobody01', method: 'POST' })).status, 404); // not registered
    await t.register('W-cb-player01', '0812223333', false, 'warehouse');
    const first = await t.call('/api/contact-request', { uid: 'W-cb-player01', method: 'POST' });
    assert.equal(first.status, 200);
    t.clock.set('2026-11-01', '11:00');
    const again = await t.call('/api/contact-request', { uid: 'W-cb-player01', method: 'POST' });
    assert.equal(again.body.at, first.body.at); // first tap wins
    assert.equal((await t.call('/api/state', { uid: 'W-cb-player01' })).body.me.callbackAt, first.body.at);

    const list = (await t.call('/api/admin/callbacks', { headers: t.admin })).body.rows;
    assert.equal(list.length, 1);
    assert.equal(list[0].phone, '0812223333');
    assert.equal(list[0].interestLabel, 'คลังสินค้าและขนส่ง');
    assert.equal((await t.call('/api/admin/overview', { headers: t.admin })).body.callbacks, 1);
    assert.equal((await t.call('/api/admin/callbacks')).status, 401); // admin only

    assert.equal((await t.call('/api/admin/callbacks/done', { method: 'POST', headers: t.admin, body: { uid: 'W-cb-player01' } })).status, 200);
    // final: marking again or trying to undo changes nothing
    t.clock.set('2026-11-01', '12:00');
    assert.equal((await t.call('/api/admin/callbacks/done', { method: 'POST', headers: t.admin, body: { uid: 'W-cb-player01', done: false } })).status, 409);
    assert.equal((await t.call('/api/admin/callbacks', { headers: t.admin })).body.rows.length, 0);
    assert.equal((await t.call('/api/admin/callbacks?status=done', { headers: t.admin })).body.rows.length, 1);
    assert.equal((await t.call('/api/admin/overview', { headers: t.admin })).body.callbacks, 0);
    const csv = await t.call('/api/admin/export.csv', { headers: t.admin });
    assert.match(csv.body, /ขอให้ติดต่อกลับ \(นัดคุย\)/);
    assert.match(csv.body, /W-cb-player01,.*2026-11-01T10:00:00\+07:00,2026-11-01T11:00:00\+07:00/);
  } finally { await t.close(); }
});
