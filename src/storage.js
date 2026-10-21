// Prize image storage: Supabase Storage (public bucket) when configured, otherwise a local folder.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUCKET = 'prizes';
const NAME_RE = /^[a-z0-9._-]+$/i;

// Legacy service_role keys are JWTs (eyJ…) and go in both headers; new secret keys (sb_secret_…) only in `apikey`.
// Accept whatever was pasted (e.g. https://x.supabase.co/rest/v1/) — only the origin matters.
const baseUrl = (u) => { try { return u ? new URL(u.trim()).origin : ''; } catch { return ''; } };
const authHeaders = (key) => (key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key });

export function createStorage({ env, uploadDir }) {
  const url = baseUrl(env.SUPABASE_URL);
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  if (url && key) {
    const publicBase = `${url}/storage/v1/object/public/${BUCKET}/`;
    return {
      kind: 'supabase',
      async save(name, buf, contentType) {
        const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${name}`, {
          method: 'POST',
          headers: { ...authHeaders(key), 'Content-Type': contentType, 'cache-control': '2592000', 'x-upsert': 'false' },
          body: buf,
        });
        if (!res.ok) throw new Error(`Supabase upload failed (${res.status}): ${await res.text().catch(() => '')}`);
        return publicBase + name;
      },
      isOwnUrl: (u) => typeof u === 'string' && u.startsWith(publicBase) && NAME_RE.test(u.slice(publicBase.length)),
    };
  }

  mkdirSync(uploadDir, { recursive: true });
  return {
    kind: 'local',
    dir: uploadDir,
    async save(name, buf) { writeFileSync(join(uploadDir, name), buf); return `/uploads/${name}`; },
    isOwnUrl: (u) => typeof u === 'string' && /^\/uploads\/[a-z0-9._-]+$/i.test(u),
  };
}

/** Create the public `prizes` bucket if it doesn't exist (used by `npm run db:setup`). */
export async function ensureBucket(env) {
  const url = baseUrl(env.SUPABASE_URL);
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return 'skipped (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)';
  const headers = { ...authHeaders(key), 'Content-Type': 'application/json' };
  const got = await fetch(`${url}/storage/v1/bucket/${BUCKET}`, { headers });
  if (got.ok) return 'exists';
  const res = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 3 * 1024 * 1024, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }),
  });
  if (!res.ok) throw new Error(`Could not create bucket (${res.status}): ${await res.text().catch(() => '')}`);
  return 'created';
}
