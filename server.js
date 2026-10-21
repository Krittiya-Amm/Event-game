import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './src/app.js';

const dbFile = process.env.DB_FILE || 'data/event.db';
mkdirSync(dirname(dbFile), { recursive: true });

const { app, db } = await createApp({ dbFile });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`🎟  Scratch Card running on http://localhost:${port}  (database: ${db.dialect === 'pg' ? 'Postgres / Supabase' : `SQLite ${dbFile}`})`);
  console.log(`   Game:       http://localhost:${port}/`);
  console.log(`   Staff:      http://localhost:${port}/staff`);
  console.log(`   Backoffice: http://localhost:${port}/admin`);
});
