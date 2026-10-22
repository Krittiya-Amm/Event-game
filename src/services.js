// Services a lead can say they're interested in. The promotion they get is matched to this choice.
// `backend` = the Sellsuki service(s) behind the option (for the sales team; shown in Backoffice/CSV only).
export const SERVICES = [
  { id: 'strategy', label: 'วางแผนกลยุทธ์ธุรกิจ', backend: 'Business Consulting' },
  { id: 'ads_content', label: 'โฆษณาและคอนเทนต์ออนไลน์', backend: 'Digital Ads, Content' },
  { id: 'e_distributor', label: 'ดูแลร้านค้าออนไลน์', backend: 'e-Distributor' },
  { id: 'website', label: 'ทำเว็บไซต์', backend: 'Website Development' },
  { id: 'data', label: 'วิเคราะห์ข้อมูลธุรกิจ', backend: 'Data Analytics, Oc2plus' },
  { id: 'hr', label: 'ที่ปรึกษาด้าน HR', backend: 'HR Consulting' },
  { id: 'line_oa', label: 'ดูแล LINE OA', backend: 'LINE OA, OA Corporate' },
  { id: 'line_ads', label: 'โฆษณาบน LINE', backend: 'Smart Channel, Today, Sticker' },
  { id: 'line_martech', label: 'ระบบการตลาดบน LINE', backend: 'MarTech, My Customer CRM' },
  { id: 'warehouse', label: 'คลังสินค้าและขนส่ง', backend: 'Akita, Patona' },
  { id: 'unsure', label: 'ยังไม่แน่ใจ ขอคำแนะนำ', backend: 'AE คัดกรอง' },
];
export const SERVICE_IDS = new Set(SERVICES.map((s) => s.id));

// Ids from the first version of the form. Old players/promotions keep working: they map to the new option.
const LEGACY = {
  line: { to: 'line_oa', label: 'LINE' },
  influencer: { to: 'ads_content', label: 'อินฟลู' },
  ads: { to: 'ads_content', label: 'ยิงแอด' },
  content: { to: 'ads_content', label: 'ทำคอนเทนต์' },
  warehouse: { to: 'warehouse', label: 'คลังสินค้า' },
};
/** Current service id for any stored value (new id, legacy id, or nothing). */
export const normalizeService = (id) => (SERVICE_IDS.has(id) ? id : LEGACY[id]?.to || '');
/** Label for a stored player choice — legacy answers keep the wording the player actually picked. */
export const serviceLabel = (id) => SERVICES.find((s) => s.id === id)?.label ?? LEGACY[id]?.label ?? '';
export const serviceBackend = (id) => SERVICES.find((s) => s.id === normalizeService(id))?.backend ?? '';
/** { id: label } for every value that may be stored, legacy ids included (Backoffice display). */
export const SERVICE_LABELS = Object.fromEntries([
  ...Object.entries(LEGACY).map(([id, l]) => [id, l.label]),
  ...SERVICES.map((s) => [s.id, s.label]),
]);

// Default promotion ↔ service mapping for the seeded brands.
export const BRAND_SERVICE = {
  LINE: 'line_oa',
  'Wizemoves Influencer': 'ads_content',
  'Wizemoves Ads': 'ads_content',
  'Wizemoves Content': 'ads_content',
  'Wizemoves Martech': 'line_martech',
  Akita: 'warehouse',
};
