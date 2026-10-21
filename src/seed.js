import { addDays } from './time.js';
import { setSetting } from './db.js';

export const DEFAULT_PRIZES = [
  { id: 'doll', name: 'ตุ๊กตาน้องสุกี้', emoji: '🧸', color: '#f59e0b', sort: 1 },
  { id: 'keychain', name: 'พวงกุญแจ', emoji: '🔑', color: '#ec4899', sort: 2 },
  { id: 'card', name: 'การ์ดมูน', emoji: '🌙', color: '#6366f1', sort: 3 },
];

// From WMMT-1663 "ข้อเสนอการกระจายรางวัล" — adjustable in Backoffice.
export const DEFAULT_DISTRIBUTION = [
  { doll: 0, keychain: 5, card: 45 },
  { doll: 1, keychain: 5, card: 44 },
  { doll: 0, keychain: 5, card: 45 },
  { doll: 1, keychain: 5, card: 44 },
];

export const DEFAULT_COUPONS = [
  { brand: 'LINE', benefit: 'ลด 50% Setup LINE Account (ย้ายมา Sellsuki + สมัครแพ็กโปร 1 ปีขึ้นไป)', service: 'line' },
  { brand: 'Akita', benefit: 'ฟรีบริการแพ็ก 100 ออเดอร์แรก กับ Akita Fulfillment', service: 'warehouse' },
  { brand: 'Wizemoves Influencer', benefit: 'ลด 10% Influencer Marketing', service: 'influencer' },
  { brand: 'Wizemoves Ads', benefit: 'ลด 10% Online Advertising', service: 'ads' },
  { brand: 'Wizemoves Content', benefit: 'ซื้อบริการ 1 ปี ฟรี 1 เดือน', service: 'content' },
  { brand: 'Wizemoves Martech', benefit: 'ลด 5%', service: 'website' },
];

/** Shuffle counts {prizeId: n} into an array of prize ids (Fisher–Yates). */
export function buildSlots(counts) {
  const list = [];
  for (const [id, n] of Object.entries(counts)) for (let i = 0; i < n; i++) list.push(id);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** Insert the default prizes/days/promotions/settings on an empty database. Returns true if it seeded. */
export async function seedIfEmpty(db, { startDate }) {
  const { n } = await db.get('SELECT COUNT(*) AS n FROM prizes');
  if (n) return false;
  const { insertSlots } = await import('./rewards.js');
  await db.tx(async (q) => {
    for (const p of DEFAULT_PRIZES) {
      await q.run('INSERT INTO prizes (id, name, emoji, color, sort) VALUES (?, ?, ?, ?, ?)', [p.id, p.name, p.emoji, p.color, p.sort]);
    }
    for (const [i, counts] of DEFAULT_DISTRIBUTION.entries()) {
      await q.run('INSERT INTO event_days (day_no, date, open_time, close_time) VALUES (?, ?, ?, ?)', [i + 1, addDays(startDate, i), '09:00', '18:00']);
      await insertSlots(q, i + 1, 1, buildSlots(counts));
    }
    for (const [i, c] of DEFAULT_COUPONS.entries()) {
      await q.run('INSERT INTO coupons (brand, benefit, service, sort) VALUES (?, ?, ?, ?)', [c.brand, c.benefit, c.service, i + 1]);
    }
    await setSetting(q, 'event_name', 'Sellsuki Scratch & Win');
    await setSetting(q, 'daily_limit', 50);
    await setSetting(q, 'play_limit', 'event'); // 'event' = 1 ครั้งตลอดงาน, 'day' = 1 ครั้ง/วัน
    await setSetting(q, 'cta_text', 'นัดคุยกับทีมเพื่อรับ Customer Report ฟรี');
    await setSetting(q, 'cta_url', 'https://www.sellsuki.co.th');
  });
  return true;
}
