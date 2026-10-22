import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, getSettings, setSetting } from './db.js';
import { createStorage } from './storage.js';
import { seedIfEmpty, MOCK_COUPONS } from './seed.js';
import { createGame } from './game.js';
import { bangkokNow } from './time.js';
import { verifyIdToken, pushResult } from './line.js';
import { getRewards, saveRewards, saveSchedule, resetPlays, InputError } from './rewards.js';
import { SERVICES, SERVICE_IDS, SERVICE_LABELS, serviceLabel, serviceBackend, normalizeService } from './services.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

function safeEqual(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build the Express app. Postgres (Supabase) when DATABASE_URL is set, else a local SQLite file. */
export async function createApp({ dbFile = 'data/event.db', env = process.env, clock = () => bangkokNow() } = {}) {
  const db = await openDb({ url: env.DATABASE_URL, file: dbFile });
  // Local SQLite seeds itself; Postgres is seeded once by `npm run db:setup`.
  if (db.dialect === 'sqlite') await seedIfEmpty(db, { startDate: clock().date });
  // Prize images: Supabase Storage when configured, else a folder next to the SQLite file.
  const storage = createStorage({ env, uploadDir: join(dirname(dbFile), 'uploads') });
  const game = createGame(db, clock);

  const LIFF_ID = env.LIFF_ID || '';
  const LOGIN_CHANNEL_ID = env.LINE_LOGIN_CHANNEL_ID || '';
  // Web entry (default): the browser keeps a random device id; one play per device AND per phone number.
  const WEB_PLAY = env.WEB_PLAY !== '0';
  if (!LOGIN_CHANNEL_ID && !WEB_PLAY) {
    console.warn('⚠️  WEB_PLAY=0 but LINE_LOGIN_CHANNEL_ID is not set — players cannot enter.');
  }

  // Throttle wrong staff PINs / admin logins: 8 misses → 5-minute lock. Stored in the DB so it holds
  // across serverless instances.
  const pinBlocked = async (ip) => ((await db.get('SELECT until FROM auth_fails WHERE ip = ?', [ip]))?.until || 0) > Date.now();
  async function pinFailed(ip) {
    await db.run('INSERT INTO auth_fails (ip, n, until) VALUES (?, 1, 0) ON CONFLICT(ip) DO UPDATE SET n = auth_fails.n + 1', [ip]);
    const { n } = await db.get('SELECT n FROM auth_fails WHERE ip = ?', [ip]);
    if (n >= 8) await db.run('UPDATE auth_fails SET n = 0, until = ? WHERE ip = ?', [Date.now() + 5 * 60_000, ip]);
  }
  const pinCleared = (ip) => db.run('DELETE FROM auth_fails WHERE ip = ?', [ip]);

  const app = express();
  app.disable('x-powered-by');
  // On Vercel the client IP / https come from the proxy headers.
  if (env.VERCEL || env.TRUST_PROXY === '1') app.set('trust proxy', true);
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  if (storage.kind === 'local') {
    app.use('/uploads', express.static(storage.dir, {
      maxAge: '30d', immutable: true, fallthrough: false,
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    }));
  }

  // ---------- auth ----------
  async function player(req, res, next) {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (bearer && LOGIN_CHANNEL_ID) {
      const user = await verifyIdToken(bearer, LOGIN_CHANNEL_ID).catch(() => null);
      if (user) { req.uid = user.sub; req.lineName = user.name; return next(); }
    }
    const device = req.get('x-device-id');
    if (WEB_PLAY && device && /^W-[A-Za-z0-9-]{8,64}$/.test(device)) {
      req.uid = device; req.lineName = null; return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  }
  // Backoffice: one account (ADMIN_USERNAME / ADMIN_PASSWORD). Login hands out a random session token
  // (12h, stored in the DB), sent back as x-admin-key.
  const ADMIN_USER = env.ADMIN_USERNAME || 'admin';
  const SESSION_MS = 12 * 60 * 60 * 1000;
  async function admin(req, res, next) {
    const token = req.get('x-admin-key') || '';
    const row = token && await db.get('SELECT expires_at FROM admin_sessions WHERE token = ?', [token]);
    if (row && row.expires_at > Date.now()) return next();
    res.status(401).json({ error: 'unauthorized' });
  }
  async function staff(req, res, next) {
    if (await pinBlocked(req.ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const k = req.get('x-staff-key');
    if (safeEqual(k, env.STAFF_PIN)) { await pinCleared(req.ip); return next(); }
    await pinFailed(req.ip);
    res.status(401).json({ error: 'unauthorized' });
  }

  // ---------- public / player ----------
  app.get('/api/config', async (req, res) => {
    const [s, prizes, coupons] = await Promise.all([
      getSettings(db),
      db.all('SELECT id, name, emoji, color, image FROM prizes ORDER BY sort'),
      db.all('SELECT brand, benefit, service FROM coupons WHERE active = 1 ORDER BY sort, id'),
    ]);
    res.json({
      liffId: LIFF_ID,
      webPlay: WEB_PLAY,
      eventName: s.event_name,
      ctaText: s.cta_text,
      playLimit: s.play_limit,
      services: SERVICES.map(({ id, label }) => ({ id, label })), // backend names are for the sales team only
      prizes,
      coupons,
    });
  });

  app.get('/api/state', player, async (req, res) => res.json(await game.state(req.uid)));

  app.post('/api/register', player, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const company = String(req.body?.company || '').trim();
    const phone = String(req.body?.phone || '').replace(/[\s-]/g, '');
    const errors = {};
    if (name.length < 2 || name.length > 100) errors.name = 'กรุณากรอกชื่อ';
    if (company.length < 1 || company.length > 150) errors.company = 'กรุณากรอกชื่อบริษัท';
    if (!/^0\d{8,9}$/.test(phone)) errors.phone = 'เบอร์โทรไม่ถูกต้อง';
    const interest = String(req.body?.interest || '');
    if (!SERVICE_IDS.has(interest)) errors.interest = 'กรุณาเลือกบริการที่สนใจ';
    if (Object.keys(errors).length) return res.status(400).json({ errors });
    const consent = req.body?.consent === true; // optional — stored so Sales only contacts people who agreed
    const out = await game.register(req.uid, req.lineName, { name, company, phone, consent, interest });
    if (out.error === 'phone_used') return res.status(400).json({ errors: { phone: 'เบอร์โทรนี้ร่วมสนุกไปแล้ว' } });
    res.json(await game.state(req.uid));
  });

  app.post('/api/play', player, async (req, res) => {
    const out = await game.play(req.uid);
    if (out.status === 'won') pushResult(env.LINE_CHANNEL_ACCESS_TOKEN, req.uid, out.play, env.PUBLIC_URL);
    res.json(out);
  });

  // Step 6 on the player's phone: staff types their name to confirm the hand-over.
  app.post('/api/claim', player, async (req, res) => {
    const staffName = String(req.body?.staffName || '').trim().slice(0, 50);
    if (!staffName) return res.status(400).json({ error: 'กรุณากรอก Staff Name' });
    const out = await game.claim(req.uid, req.body?.code, staffName);
    res.status(out.ok ? 200 : out.reason === 'not_found' ? 404 : 409).json(out);
  });

  // "นัดคุยกับทีม": the lead asks Sales to call back — shows up in Backoffice → ติดต่อกลับ.
  app.post('/api/contact-request', player, async (req, res) => {
    const at = await game.requestCallback(req.uid);
    if (!at) return res.status(404).json({ error: 'กรุณาลงทะเบียนก่อน' });
    res.json({ ok: true, at });
  });

  app.post('/api/reveal', player, async (req, res) => {
    await game.reveal(req.uid, String(req.body?.code || ''));
    res.json({ ok: true });
  });

  // Booth poster QR → game entry URL (User Flow step 1).
  app.get('/api/qr-entry', async (req, res) => {
    const base = env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const svg = await QRCode.toString(`${base}/`, { type: 'svg', margin: 1, width: 480, color: { dark: '#1f1640' } });
    res.type('image/svg+xml').send(svg);
  });

  app.get('/api/qr/:code', async (req, res) => {
    const code = req.params.code.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 12);
    const base = env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const svg = await QRCode.toString(`${base}/staff?code=${code}`, { type: 'svg', margin: 1, width: 240 });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  });

  // ---------- staff ----------
  app.get('/api/staff/ping', staff, (req, res) => res.json({ ok: true }));

  app.get('/api/staff/lookup', staff, async (req, res) => {
    const play = await game.lookup(req.query.code);
    if (!play) return res.status(404).json({ error: 'not_found' });
    res.json({ play });
  });

  app.post('/api/staff/redeem', staff, async (req, res) => {
    const out = await game.redeem(req.body?.code, String(req.body?.staffName || '').slice(0, 50));
    res.status(out.ok ? 200 : out.reason === 'not_found' ? 404 : 409).json(out);
  });

  // ---------- backoffice ----------
  app.post('/api/admin/login', async (req, res) => {
    if (await pinBlocked(req.ip)) return res.status(429).json({ error: 'ใส่ผิดหลายครั้ง กรุณารอ 5 นาที' });
    const userOk = safeEqual(String(req.body?.username || '').trim().toLowerCase(), ADMIN_USER.toLowerCase());
    const passOk = safeEqual(String(req.body?.password || ''), env.ADMIN_PASSWORD);
    if (!userOk || !passOk || !env.ADMIN_PASSWORD) {
      await pinFailed(req.ip);
      return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    await pinCleared(req.ip);
    const token = randomBytes(24).toString('hex');
    await db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [Date.now()]);
    await db.run('INSERT INTO admin_sessions (token, expires_at) VALUES (?, ?)', [token, Date.now() + SESSION_MS]);
    res.json({ token, username: ADMIN_USER });
  });
  app.post('/api/admin/logout', async (req, res) => {
    await db.run('DELETE FROM admin_sessions WHERE token = ?', [req.get('x-admin-key') || '']);
    res.json({ ok: true });
  });

  // Confirm a prize hand-over from Backoffice (e.g. staff forgot to tap it at the booth).
  app.post('/api/admin/redeem', admin, async (req, res) => {
    const out = await game.redeem(req.body?.code, 'Backoffice');
    res.status(out.ok ? 200 : out.reason === 'not_found' ? 404 : 409).json(out);
  });

  app.get('/api/admin/overview', admin, async (req, res) => {
    const [days, prizes, slotRows, playRows, w, players, consented, pending, recent, callbacks] = await Promise.all([
      db.all('SELECT * FROM event_days ORDER BY day_no'),
      db.all('SELECT id, name, emoji, color, image FROM prizes ORDER BY sort'),
      db.all('SELECT day_no, prize_id, COUNT(*) AS n FROM slots GROUP BY day_no, prize_id'),
      db.all('SELECT day_no, prize_id, COUNT(*) AS given, COUNT(redeemed_at) AS redeemed FROM plays GROUP BY day_no, prize_id'),
      game.window(),
      db.get('SELECT COUNT(*) AS n FROM players'),
      db.get('SELECT COUNT(*) AS n FROM players WHERE consent = 1'),
      db.get('SELECT COUNT(*) AS n FROM plays WHERE redeemed_at IS NULL'),
      db.all(`SELECT pl.code, pl.day_no, pl.slot_no, pl.prize_id, pl.created_at, pl.redeemed_at, p.name, p.company
              FROM plays pl JOIN players p ON p.line_user_id = pl.line_user_id ORDER BY pl.id DESC LIMIT 8`),
      db.get('SELECT COUNT(*) AS n FROM players WHERE callback_at IS NOT NULL AND callback_done_at IS NULL'),
    ]);
    const slotMap = {}; for (const r of slotRows) slotMap[`${r.day_no}:${r.prize_id}`] = r.n;
    const playMap = {}; for (const r of playRows) playMap[`${r.day_no}:${r.prize_id}`] = r;
    res.json({
      now: w.now,
      openDayNo: w.day?.day_no ?? null,
      players: players.n,
      consented: consented.n,
      pending: pending.n,
      callbacks: callbacks.n,
      closeTime: w.today?.close_time ?? null,
      recent,
      prizes,
      days: days.map((d) => {
        const rows = prizes.map((p) => {
          const k = `${d.day_no}:${p.id}`;
          const total = slotMap[k] || 0;
          const given = playMap[k]?.given || 0;
          return { prizeId: p.id, total, given, redeemed: playMap[k]?.redeemed || 0, left: total - given };
        });
        return {
          ...d,
          limit: rows.reduce((a, r) => a + r.total, 0),
          played: rows.reduce((a, r) => a + r.given, 0),
          redeemed: rows.reduce((a, r) => a + r.redeemed, 0),
          byPrize: rows,
        };
      }),
    });
  });

  app.get('/api/admin/config', admin, async (req, res) => {
    const [settings, prizes, days, coupons] = await Promise.all([
      getSettings(db),
      db.all('SELECT * FROM prizes ORDER BY sort'),
      db.all('SELECT * FROM event_days ORDER BY day_no'),
      db.all('SELECT * FROM coupons ORDER BY sort, id'),
    ]);
    // Old promotions may still carry first-version service ids — show them as the matching new option.
    res.json({ settings, prizes, days, coupons: coupons.map((c) => ({ ...c, service: normalizeService(c.service) || null })), services: SERVICES, serviceLabels: SERVICE_LABELS, mockCoupons: MOCK_COUPONS });
  });

  app.put('/api/admin/settings', admin, async (req, res) => {
    const b = req.body || {};
    if (!['event', 'day'].includes(b.play_limit)) return res.status(400).json({ error: 'play_limit ไม่ถูกต้อง' });
    await db.tx(async (q) => {
      await setSetting(q, 'event_name', String(b.event_name || '').slice(0, 100));
      await setSetting(q, 'play_limit', b.play_limit);
      await setSetting(q, 'cta_text', String(b.cta_text || '').slice(0, 200));
      await setSetting(q, 'cta_url', String(b.cta_url || '').slice(0, 500));
    });
    res.json({ ok: true });
  });

  const inputErrors = (fn) => async (req, res) => {
    try { await fn(req.body); res.json({ ok: true }); } catch (err) {
      if (err instanceof InputError) return res.status(400).json({ error: err.message, code: err.code });
      throw err;
    }
  };

  // Prize image upload (raw bytes). Raster formats only — SVG could carry script. Returns the URL to save on the prize.
  const IMAGE_TYPES = {
    'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
    'image/gif': { ext: 'gif', magic: (b) => b.subarray(0, 4).toString() === 'GIF8' },
  };
  app.post('/api/admin/upload', admin, express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
    const kind = IMAGE_TYPES[String(req.get('content-type') || '').split(';')[0].trim()];
    const buf = req.body;
    if (!kind || !Buffer.isBuffer(buf) || buf.length < 16 || !kind.magic(buf)) {
      return res.status(400).json({ error: 'รองรับเฉพาะรูป PNG, JPG, WEBP หรือ GIF' });
    }
    const name = `prize-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${kind.ext}`;
    res.json({ url: await storage.save(name, buf, String(req.get('content-type')).split(';')[0].trim()) });
  });

  // รางวัล: prize list + how many of each per day (the day's winners = the sum).
  app.get('/api/admin/rewards', admin, async (req, res) => res.json(await getRewards(db)));
  app.put('/api/admin/rewards', admin, inputErrors((body) => saveRewards(db, body, { isImage: storage.isOwnUrl })));

  // วันและเวลา: one continuous date range with the same opening hours each day.
  app.put('/api/admin/schedule', admin, inputErrors((body) => saveSchedule(db, body)));

  // Wipe test players/plays before the real event. Requires an explicit confirm word.
  app.post('/api/admin/reset-plays', admin, async (req, res) => {
    if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: 'ต้องยืนยันก่อนล้างข้อมูล' });
    res.json({ ok: true, ...(await resetPlays(db)) });
  });

  app.put('/api/admin/coupons', admin, async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [];
    if (list.some((c) => !String(c.brand || '').trim() || !String(c.benefit || '').trim())) {
      return res.status(400).json({ error: 'กรุณากรอกแบรนด์และสิทธิ์ให้ครบ' });
    }
    await db.tx(async (q) => {
      const keep = new Set(list.filter((c) => c.id).map((c) => Number(c.id)));
      for (const c of await q.all('SELECT id FROM coupons')) {
        if (keep.has(c.id)) continue;
        // Keep rows already handed out so history stays intact; just hide them.
        if (await q.get('SELECT 1 AS x FROM plays WHERE coupon_id = ? LIMIT 1', [c.id])) await q.run('UPDATE coupons SET active = 0 WHERE id = ?', [c.id]);
        else await q.run('DELETE FROM coupons WHERE id = ?', [c.id]);
      }
      for (const [i, c] of list.entries()) {
        const service = SERVICE_IDS.has(c.service) ? c.service : null;
        const vals = [String(c.brand).trim(), String(c.benefit).trim(), service, c.active === false || c.active === 0 ? 0 : 1, i + 1];
        if (c.id) await q.run('UPDATE coupons SET brand = ?, benefit = ?, service = ?, active = ?, sort = ? WHERE id = ?', [...vals, Number(c.id)]);
        else await q.run('INSERT INTO coupons (brand, benefit, service, active, sort) VALUES (?, ?, ?, ?, ?)', vals);
      }
    });
    res.json({ ok: true });
  });

  const PLAYS_EXPORT = `
    SELECT pl.line_user_id, p.line_name, p.name, p.company, p.phone, p.consent, p.interest, p.callback_at, p.callback_done_at, pl.day_no, pl.date, pl.slot_no,
           pr.name AS prize, pl.prize_id, pl.code, c.brand AS coupon_brand, c.benefit AS coupon_benefit,
           pl.created_at, pl.revealed_at, pl.redeemed_at, pl.redeemed_by
    FROM plays pl
    JOIN players p ON p.line_user_id = pl.line_user_id
    JOIN prizes pr ON pr.id = pl.prize_id
    LEFT JOIN coupons c ON c.id = pl.coupon_id`;

  app.get('/api/admin/plays', admin, async (req, res) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const where = ['(p.name LIKE ? OR p.company LIKE ? OR p.phone LIKE ? OR pl.code LIKE ? OR pl.line_user_id LIKE ?)'];
    const args = [term, term, term, term, term];
    if (req.query.status === 'pending') where.push('pl.redeemed_at IS NULL');
    if (req.query.status === 'redeemed') where.push('pl.redeemed_at IS NOT NULL');
    if (Number(req.query.day)) { where.push('pl.day_no = ?'); args.push(Number(req.query.day)); }
    const sql = `${PLAYS_EXPORT} WHERE ${where.join(' AND ')}`;
    const [{ n: total }, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) AS n FROM (${sql}) AS t`, args),
      db.all(`${sql} ORDER BY pl.id DESC LIMIT 300`, args),
    ]);
    res.json({ rows, total });
  });

  // Leads who tapped "นัดคุยกับทีม" — newest first; ?status=pending|done|all
  app.get('/api/admin/callbacks', admin, async (req, res) => {
    const status = ['pending', 'done', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const where = status === 'pending' ? 'AND p.callback_done_at IS NULL' : status === 'done' ? 'AND p.callback_done_at IS NOT NULL' : '';
    const rows = await db.all(`
      SELECT p.line_user_id, p.name, p.company, p.phone, p.interest, p.consent, p.callback_at, p.callback_done_at,
             (SELECT pr.name FROM plays pl JOIN prizes pr ON pr.id = pl.prize_id WHERE pl.line_user_id = p.line_user_id ORDER BY pl.id DESC LIMIT 1) AS prize
      FROM players p WHERE p.callback_at IS NOT NULL ${where} ORDER BY p.callback_at DESC LIMIT 500`);
    res.json({ rows: rows.map((r) => ({ ...r, interestLabel: serviceLabel(r.interest), backend: serviceBackend(r.interest) })) });
  });
  app.post('/api/admin/callbacks/done', admin, async (req, res) => {
    // One-way: once marked as contacted it stays that way (no undo).
    const uid = String(req.body?.uid || '');
    const out = await db.run('UPDATE players SET callback_done_at = ? WHERE line_user_id = ? AND callback_at IS NOT NULL AND callback_done_at IS NULL',
      [clock().iso, uid]);
    if (out.changes) return res.json({ ok: true });
    const row = await db.get('SELECT callback_done_at FROM players WHERE line_user_id = ? AND callback_at IS NOT NULL', [uid]);
    if (!row) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
    res.status(409).json({ error: 'บันทึกว่าติดต่อแล้วก่อนหน้านี้', at: row.callback_done_at });
  });

  app.get('/api/admin/export.csv', admin, async (req, res) => {
    const [rows, players] = await Promise.all([
      db.all(`${PLAYS_EXPORT} ORDER BY pl.id`),
      db.all('SELECT p.* FROM players p WHERE NOT EXISTS (SELECT 1 FROM plays pl WHERE pl.line_user_id = p.line_user_id)'),
    ]);
    const consentText = (v) => (v ? 'ยินยอม' : 'ไม่ยินยอม');
    const header = ['Player ID (LINE/Web)', 'LINE Name', 'ชื่อ', 'บริษัท', 'เบอร์โทร', 'บริการที่สนใจ', 'บริการเบื้องหลัง', 'ยินยอมให้ติดต่อกลับ', 'ขอให้ติดต่อกลับ (นัดคุย)', 'ติดต่อแล้ว', 'Day', 'วันที่', 'ลำดับ', 'รางวัล', 'โค้ด',
      'โปรโมชัน', 'สิทธิ์โปรโมชัน', 'เวลาเล่น', 'เวลาเปิดผล', 'สถานะรับ', 'เวลารับ', 'Staff'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([r.line_user_id, r.line_name, r.name, r.company, r.phone, serviceLabel(r.interest), serviceBackend(r.interest), consentText(r.consent), r.callback_at, r.callback_done_at, r.day_no, r.date, r.slot_no, r.prize, r.code,
        r.coupon_brand, r.coupon_benefit, r.created_at, r.revealed_at, r.redeemed_at ? 'รับแล้ว' : 'ยังไม่รับ',
        r.redeemed_at, r.redeemed_by].map(csvCell).join(','));
    }
    // Leads who registered but never got a slot (e.g. arrived after quota was full).
    for (const p of players) {
      lines.push([p.line_user_id, p.line_name, p.name, p.company, p.phone, serviceLabel(p.interest), serviceBackend(p.interest), consentText(p.consent), p.callback_at, p.callback_done_at, '', '', '', '', '', '', '', p.created_at, '', 'ไม่ได้เล่น', '', '']
        .map(csvCell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="scratch-card-${clock().date}.csv"`)
      .send('﻿' + lines.join('\r\n'));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, req, res, next) => {
    if (err.status === 413) return res.status(413).json({ error: 'ไฟล์ใหญ่เกินไป (สูงสุด 3MB)' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return { app, db, game };
}
