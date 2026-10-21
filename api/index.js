// Vercel serverless entry: every /api/* request lands here (see vercel.json). Static pages come from /public.
import { createApp } from '../src/app.js';

// Mask anything secret-looking before an error message is shown.
const scrub = (s) => String(s)
  .replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://***')
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
  .replace(/sb_secret_\w+/g, '***');

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      // Serverless has no persistent disk — never fall back to SQLite and silently lose data.
      if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not set. Add the Supabase "Transaction pooler" connection string in Vercel → Settings → Environment Variables, then Redeploy.');
      }
      return (await createApp()).app;
    })().catch((err) => { ready = null; throw err; }); // retry on the next request
  }
  return ready;
}

export default async function handler(req, res) {
  let app;
  try {
    app = await init();
  } catch (err) {
    console.error('startup failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'startup_failed', reason: scrub(err.message) }));
  }
  return app(req, res);
}
