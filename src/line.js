// LINE Login (LIFF ID token verification) + optional Messaging API push.

const tokenCache = new Map(); // idToken -> { sub, name, exp }

export async function verifyIdToken(idToken, channelId) {
  const hit = tokenCache.get(idToken);
  if (hit && hit.exp * 1000 > Date.now()) return hit;

  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  const user = { sub: body.sub, name: body.name || null, exp: body.exp };
  tokenCache.set(idToken, user);
  if (tokenCache.size > 5000) tokenCache.delete(tokenCache.keys().next().value);
  return user;
}

/** Fire-and-forget result push. Only delivered if the user has added the OA as a friend. */
export function pushResult(accessToken, to, play, baseUrl) {
  if (!accessToken || to.startsWith('W-')) return;
  const text = [
    `🎉 ยินดีด้วย! คุณได้รับ ${play.prize.emoji} ${play.prize.name}`,
    `โค้ดรับรางวัล: ${play.code}`,
    'แสดงโค้ดนี้กับ Staff ที่บูธเพื่อรับรางวัล',
    play.coupon ? `\n🎟 โปรโมชันของคุณ: ${play.coupon.brand} — ${play.coupon.benefit}` : '',
    baseUrl ? `\nดูผลอีกครั้ง: ${baseUrl}` : '',
  ].join('\n');
  fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  }).catch((err) => console.warn('LINE push failed:', err.message));
}
