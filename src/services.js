// Services a lead can say they're interested in. The promotion they get is matched to this choice.
export const SERVICES = [
  { id: 'line', label: 'LINE' },
  { id: 'influencer', label: 'อินฟลู' },
  { id: 'ads', label: 'ยิงแอด' },
  { id: 'content', label: 'ทำคอนเทนต์' },
  { id: 'website', label: 'ทำเว็บไซต์' },
  { id: 'warehouse', label: 'คลังสินค้า' },
];
export const SERVICE_IDS = new Set(SERVICES.map((s) => s.id));
export const serviceLabel = (id) => SERVICES.find((s) => s.id === id)?.label ?? '';

// Default promotion ↔ service mapping for the seeded brands.
export const BRAND_SERVICE = {
  LINE: 'line',
  'Wizemoves Influencer': 'influencer',
  'Wizemoves Ads': 'ads',
  'Wizemoves Content': 'content',
  'Wizemoves Martech': 'website',
  Akita: 'warehouse',
};
