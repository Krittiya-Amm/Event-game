// Vercel serverless entry: every /api/* request lands here (see vercel.json). Static pages come from /public.
import { createApp } from '../src/app.js';

if (!process.env.DATABASE_URL) {
  // Serverless has no persistent disk — refuse to fall back to SQLite and silently lose data.
  throw new Error('DATABASE_URL is not set. Add the Supabase "Transaction pooler" connection string in Vercel → Settings → Environment Variables.');
}

const { app } = await createApp();
export default app;
