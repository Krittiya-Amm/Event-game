// One small async database interface, two drivers:
//   • Postgres (Supabase) when DATABASE_URL is set — for Vercel / production
//   • SQLite (node:sqlite) otherwise — local dev and the booth Wi-Fi setup
// SQL is written once with `?` placeholders; the Postgres driver rewrites them to $1, $2, …
import { BRAND_SERVICE } from './services.js';

const COMMON_TABLES = (id) => `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prizes (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🎁',
  image TEXT,                          -- uploaded image URL; null = built-in art / emoji
  color TEXT NOT NULL DEFAULT '#7c3aed',
  sort  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS event_days (
  day_no     INTEGER PRIMARY KEY,
  date       TEXT NOT NULL UNIQUE,      -- YYYY-MM-DD (Asia/Bangkok)
  open_time  TEXT NOT NULL,             -- HH:MM
  close_time TEXT NOT NULL              -- HH:MM
);
CREATE TABLE IF NOT EXISTS slots (
  day_no   INTEGER NOT NULL,
  slot_no  INTEGER NOT NULL,
  prize_id TEXT NOT NULL REFERENCES prizes(id),
  PRIMARY KEY (day_no, slot_no)
);
CREATE TABLE IF NOT EXISTS players (
  line_user_id TEXT PRIMARY KEY,
  line_name    TEXT,
  name         TEXT NOT NULL,
  company      TEXT NOT NULL,
  phone        TEXT NOT NULL,
  consent      INTEGER NOT NULL DEFAULT 0, -- 1 = agreed to be contacted
  interest     TEXT,                       -- service id from services.js
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS players_phone ON players(phone);
CREATE TABLE IF NOT EXISTS coupons (
  id      ${id},
  brand   TEXT NOT NULL,
  benefit TEXT NOT NULL,
  service TEXT,                       -- service id this promotion is for (services.js)
  active  INTEGER NOT NULL DEFAULT 1,
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plays (
  id           ${id},
  line_user_id TEXT NOT NULL REFERENCES players(line_user_id),
  day_no       INTEGER NOT NULL,
  date         TEXT NOT NULL,
  slot_no      INTEGER NOT NULL,
  prize_id     TEXT NOT NULL REFERENCES prizes(id),
  coupon_id    INTEGER REFERENCES coupons(id),
  code         TEXT NOT NULL UNIQUE,
  revealed_at  TEXT,
  redeemed_at  TEXT,
  redeemed_by  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (day_no, slot_no),
  UNIQUE (line_user_id, day_no)
);
-- Backoffice sessions and failed-login/PIN counters live in the DB so they work across serverless instances.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_fails (
  ip    TEXT PRIMARY KEY,
  n     INTEGER NOT NULL DEFAULT 0,
  until BIGINT NOT NULL DEFAULT 0
);
`;

export const SQLITE_SCHEMA = COMMON_TABLES('INTEGER PRIMARY KEY AUTOINCREMENT');
export const PG_SCHEMA = COMMON_TABLES('SERIAL PRIMARY KEY');
export const TABLES = ['settings', 'prizes', 'event_days', 'slots', 'players', 'coupons', 'plays', 'admin_sessions', 'auth_fails'];

/** Open the database chosen by config: { url } → Postgres, else { file } → SQLite. */
export async function openDb({ url, file }) {
  return url ? openPostgres(url) : openSqlite(file);
}

// ---------------------------------------------------------------- SQLite
async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SQLITE_SCHEMA);
  migrateSqlite(raw);

  const api = {
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    run: async (sql, params = []) => ({ changes: Number(raw.prepare(sql).run(...params).changes) }),
    exec: async (sql) => { raw.exec(sql); },
  };
  // node:sqlite is synchronous on one connection; a promise chain keeps transactions from overlapping.
  let queue = Promise.resolve();
  const tx = (fn) => {
    const run = queue.then(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await fn(api); raw.exec('COMMIT'); return out; } catch (err) { raw.exec('ROLLBACK'); throw err; }
    });
    queue = run.catch(() => {});
    return run;
  };
  return { dialect: 'sqlite', ...api, tx, raw, close: async () => raw.close() };
}

/** Additive column migrations for SQLite files created by older versions. */
function migrateSqlite(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const p = cols('players');
  if (!p.includes('consent')) db.exec('ALTER TABLE players ADD COLUMN consent INTEGER NOT NULL DEFAULT 0');
  if (!p.includes('interest')) db.exec('ALTER TABLE players ADD COLUMN interest TEXT');
  if (!cols('prizes').includes('image')) db.exec('ALTER TABLE prizes ADD COLUMN image TEXT');
  if (!cols('coupons').includes('service')) {
    db.exec('ALTER TABLE coupons ADD COLUMN service TEXT');
    const set = db.prepare('UPDATE coupons SET service = ? WHERE brand = ? AND service IS NULL');
    for (const [brand, service] of Object.entries(BRAND_SERVICE)) set.run(service, brand);
  }
}

// ---------------------------------------------------------------- Postgres
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

async function openPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, (v) => Number(v)); // COUNT(*) / BIGINT → number
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 3, // small: each serverless instance has its own pool; Supabase's pooler fans in
    ssl: local ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 10_000,
  });
  const wrap = (q) => ({
    all: async (sql, params = []) => (await q(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await q(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => ({ changes: (await q(toPg(sql), params)).rowCount }),
    exec: async (sql) => { await q(sql); },
  });
  const api = wrap((sql, params) => pool.query(sql, params));
  /** Transaction on one connection. `lock` takes a transaction-scoped advisory lock so concurrent
   *  prize draws for the same day queue up instead of racing (works through Supabase's pooler). */
  const tx = async (fn, { lock } = {}) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (lock != null) await client.query('SELECT pg_advisory_xact_lock($1)', [lock]);
      const out = await fn(wrap((sql, params) => client.query(sql, params)));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  };
  return { dialect: 'pg', ...api, tx, pool, close: () => pool.end() };
}

// ---------------------------------------------------------------- settings
export async function getSettings(db) {
  const rows = await db.all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}
