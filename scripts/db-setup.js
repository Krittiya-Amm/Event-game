// One-time (re-runnable) Supabase setup:  npm run db:setup
//   • creates the tables, • locks them down with Row Level Security, • seeds default prizes/days/promotions,
//   • creates the public "prizes" Storage bucket for prize images.
import pg from 'pg';
import { PG_SCHEMA, TABLES, openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';
import { ensureBucket } from '../src/storage.js';
import { bangkokNow } from '../src/time.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ DATABASE_URL is not set (put the Supabase connection string in .env).');
  process.exit(1);
}

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
console.log('✓ connected');

await client.query(PG_SCHEMA);
console.log(`✓ tables ready (${TABLES.join(', ')})`);

// Supabase exposes the public schema through its REST API. With RLS on and no policies, that API can't
// read or write these tables (players' phone numbers stay private); our server connects directly and is unaffected.
for (const t of TABLES) await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
console.log('✓ row level security enabled on all tables');
await client.end();

const db = await openDb({ url });
const seeded = await seedIfEmpty(db, { startDate: bangkokNow().date });
console.log(seeded ? '✓ seeded default prizes, 4 event days from today, promotions and settings' : '✓ data already present — seed skipped');
await db.close();

try {
  console.log(`✓ storage bucket "prizes": ${await ensureBucket(process.env)}`);
} catch (err) {
  console.error(`✗ storage bucket: ${err.message}`);
  process.exitCode = 1;
}
console.log('Done.');
