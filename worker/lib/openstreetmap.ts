/**
 * OpenStreetMap lead discovery — a no-key, open-data source (ODbL).
 *
 * Why this module exists: "licensed provider" sources need an account and a
 * key. OpenStreetMap publishes business records (name, phone, website, email,
 * address) as open data, so a tenant can start discovering local Saudi leads
 * without buying a data plan.
 *
 * Rules this module keeps:
 *   - One bounded Overpass request per run, restricted to a Saudi city box.
 *     The public instances are shared, and their fair-use policy expects a
 *     User-Agent and no parallel scripts.
 *   - Nothing is invented: an element without a name or without any published
 *     contact detail is dropped, and every lead keeps its OSM element URL plus
 *     the ODbL attribution required by the OpenStreetMap Foundation.
 *   - Only Saudi Arabian cities in the table below are queried, so a tenant
 *     cannot turn this into a worldwide crawl.
 */

export const OSM_ENDPOINT = 'https://overpass-api.de/api/interpreter';
export const OSM_NEARBY_ENDPOINT = 'https://overpass-api.de/api/interpreter';
/** Kept for reference; not part of the tier plan (chronically over-busy). */
export const OSM_FALLBACK_ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';

/**
 * Public Overpass mirrors, tried in order. The main instance frequently
 * reports "at capacity" (502) under load; the French OSM mirror and NextGIS
 * answer the same bounded queries without a key, so discovery rotates
 * across them instead of failing the whole run on one busy server.
 * A configured `LEAD_DATA_API_URL` always wins over this list.
 */
export const OSM_ENDPOINTS = [
  // Measured working order (June 2026): the French mirror and NextGIS answer
  // bounded queries in ~2-5s while overpass-api.de is chronically at
  // capacity. Starting with a busy mirror burned the whole 50s deadline on
  // two 20s timeouts before a working mirror was ever tried.
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.nextgis.com/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors — ODbL 1.0';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const OSM_USER_AGENT = 'Wusool/1.0 (lead discovery; +https://openstreetmap.org/copyright)';

/** Overpass text/JSON errors surface as one of these stable codes. */
export class LeadSourceError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

type Bbox = readonly [south: number, west: number, north: number, east: number];

export type SaudiCity = {
  ar: string;
  en: string;
  /** south, west, north, east — the metro area, not the administrative region. */
  bbox: Bbox;
  aliases: string[];
};

/**
 * Metro bounding boxes for the cities where most Saudi businesses are listed.
 * They are deliberately generous: a lead just outside the municipal boundary
 * is still a local lead, and the OSM record itself carries addr:city when the
 * contributor added it.
 */
export const SAUDI_CITIES: SaudiCity[] = [
  { ar: 'الرياض', en: 'Riyadh', bbox: [24.3, 46.2, 25.1, 47.2], aliases: ['رياض', 'riyadh', 'al riyadh', 'ar riyadh'] },
  { ar: 'جدة', en: 'Jeddah', bbox: [21.2, 39.0, 21.9, 39.4], aliases: ['جده', 'jeddah', 'jedda', 'jiddah'] },
  { ar: 'مكة المكرمة', en: 'Makkah', bbox: [21.28, 39.68, 21.52, 39.98], aliases: ['مكة', 'مكه', 'مكه المكرمه', 'makkah', 'mecca', 'makkah al mukarramah'] },
  { ar: 'المدينة المنورة', en: 'Madinah', bbox: [24.35, 39.47, 24.62, 39.75], aliases: ['المدينة', 'المدينه', 'madinah', 'medina', 'al madinah'] },
  { ar: 'الدمام', en: 'Dammam', bbox: [26.32, 49.95, 26.55, 50.25], aliases: ['دمام', 'dammam', 'ad dammam'] },
  { ar: 'الخبر', en: 'Khobar', bbox: [26.18, 50.1, 26.34, 50.28], aliases: ['khobar', 'al khobar', 'khubar'] },
  { ar: 'الظهران', en: 'Dhahran', bbox: [26.22, 50.08, 26.34, 50.2], aliases: ['dhahran'] },
  { ar: 'الأحساء', en: 'Al Ahsa', bbox: [25.2, 49.4, 25.6, 49.85], aliases: ['الهفوف', 'هفوف', 'hofuf', 'al ahsa', 'ahsa', 'al hofuf'] },
  { ar: 'القطيف', en: 'Qatif', bbox: [26.45, 49.9, 26.62, 50.08], aliases: ['قطيف', 'qatif', 'al qatif'] },
  { ar: 'الجبيل', en: 'Jubail', bbox: [26.85, 49.5, 27.15, 49.8], aliases: ['جبيل', 'jubail', 'al jubail'] },
  { ar: 'حفر الباطن', en: 'Hafr Al Batin', bbox: [28.35, 45.9, 28.5, 46.05], aliases: ['hafr al batin', 'hafr albatin'] },
  { ar: 'بريدة', en: 'Buraydah', bbox: [26.25, 43.85, 26.45, 44.1], aliases: ['بريده', 'buraydah', 'buraidah', 'qassim'] },
  { ar: 'عنيزة', en: 'Unaizah', bbox: [26.02, 43.88, 26.18, 44.05], aliases: ['عنيزه', 'unaizah', 'onizah', 'unayzah'] },
  { ar: 'حائل', en: 'Hail', bbox: [27.42, 41.58, 27.62, 41.8], aliases: ['حایل', 'hail', 'ha il', 'ha’il'] },
  { ar: 'تبوك', en: 'Tabuk', bbox: [28.3, 36.48, 28.5, 36.7], aliases: ['tabuk', 'tabouk'] },
  { ar: 'الطائف', en: 'Taif', bbox: [21.18, 40.32, 21.38, 40.52], aliases: ['طائف', 'taif', 'at taif'] },
  { ar: 'أبها', en: 'Abha', bbox: [18.12, 42.4, 18.3, 42.62], aliases: ['ابها', 'abha'] },
  { ar: 'خميس مشيط', en: 'Khamis Mushait', bbox: [18.22, 42.65, 18.38, 42.82], aliases: ['خميس مشيط', 'khamis mushait', 'khamis mushayt'] },
  { ar: 'بيشة', en: 'Bisha', bbox: [19.93, 42.52, 20.06, 42.68], aliases: ['بيشه', 'bisha'] },
  { ar: 'جازان', en: 'Jazan', bbox: [16.82, 42.48, 16.98, 42.66], aliases: ['جيزان', 'jazan', 'jizan'] },
  { ar: 'نجران', en: 'Najran', bbox: [17.42, 44.05, 17.6, 44.25], aliases: ['najran'] },
  { ar: 'ينبع', en: 'Yanbu', bbox: [23.92, 38.1, 24.2, 38.38], aliases: ['yanbu', 'yanbu al bahr'] },
  { ar: 'سكاكا', en: 'Sakaka', bbox: [29.86, 40.12, 30.02, 40.32], aliases: ['الجوف', 'jauf', 'al jouf', 'sakaka', 'sakakah'] },
  { ar: 'عرعر', en: 'Arar', bbox: [30.92, 40.95, 31.06, 41.12], aliases: ['arar'] },
  { ar: 'الباحة', en: 'Al Baha', bbox: [19.92, 41.4, 20.08, 41.55], aliases: ['الباحه', 'al baha', 'al bahah'] },
  { ar: 'الخرج', en: 'Al Kharj', bbox: [24.08, 47.22, 24.22, 47.4], aliases: ['خرج', 'al kharj', 'kharj'] },
  { ar: 'العلا', en: 'AlUla', bbox: [26.53, 37.83, 26.7, 38.02], aliases: ['alula', 'al ula', 'al-ula'] },
  { ar: 'رابغ', en: 'Rabigh', bbox: [22.75, 39.0, 22.85, 39.1], aliases: ['rabigh'] },
];

/** Normalises Arabic/English spelling variants so "الرياض" matches "رياض". */
export function normalizeCityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u0640\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Resolves a free-text ICP city to a supported Saudi metro area. Returns null
 * for anything outside the table: discovery then refuses instead of turning a
 * typo into a country-wide query.
 */
export function resolveSaudiCity(value: string): SaudiCity | null {
  const parts = String(value ?? '')
    .split(/[,،/|]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const candidates = parts.length ? parts : [String(value ?? '')];
  const wanted = candidates.map(normalizeCityName).filter(Boolean);

  for (const city of SAUDI_CITIES) {
    const names = [city.ar, city.en, ...city.aliases].map(normalizeCityName);
    if (wanted.some((entry) => names.includes(entry))) return city;
    // "الرياض، السعودية" keeps only a prefix match on a word boundary.
    if (wanted.some((entry) => names.some((name) => entry.startsWith(`${name} `) || entry.endsWith(` ${name}`)))) {
      return city;
    }
  }
  return null;
}

const escapeOverpass = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Which OSM key each known sector tag lives under. Nearly every value in
 * OSM_SECTOR_LABELS is `shop=<value>` or `amenity=<value>`; the exceptions
 * (hotel=tourism, office values, leisure) are listed explicitly.
 */
export const OSM_SECTOR_KEYS: Record<string, string> = {
  bakery: 'shop', supermarket: 'shop', convenience: 'shop', greengrocer: 'shop',
  butcher: 'shop', pharmacy: 'shop', furniture: 'shop', electronics: 'shop',
  mobile_phone: 'shop', clothes: 'shop', hardware: 'shop',
  cafe: 'amenity', restaurant: 'amenity', fast_food: 'amenity', clinic: 'amenity',
  dentist: 'amenity', doctors: 'amenity', hospital: 'amenity', veterinary: 'amenity',
  school: 'amenity', university: 'amenity', car_repair: 'amenity', bank: 'amenity',
  hotel: 'tourism', gym: 'leisure', fitness_centre: 'leisure',
  estate_agent: 'office', lawyer: 'office', accountant: 'office', insurance: 'office',
  travel_agency: 'office', beauty: 'shop', hairdresser: 'shop', laundry: 'shop',
  optician: 'shop', photographer: 'office',
};

export type OsmSectorFilter = { key: string; value: string };

/**
 * Maps a tenant's ICP terms (Arabic or English, from sectors/services/
 * keywords) onto concrete Overpass tag filters, so the query itself only
 * returns businesses in the activity the tenant actually targets — instead
 * of the nearest famous names in the city centre. Matching reuses the same
 * hint table scoring uses, so query and score agree with each other.
 * Terms that map to nothing (e.g. "تصميم مواقع") produce no filter and the
 * caller falls back to the generic contact query.
 */
export function osmFiltersForTerms(terms: string[] | undefined): OsmSectorFilter[] {
  const wanted = (terms ?? []).map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return [];
  const filters: OsmSectorFilter[] = [];
  const seen = new Set<string>();
  for (const [tag, meta] of Object.entries(OSM_SECTOR_LABELS)) {
    const key = OSM_SECTOR_KEYS[tag];
    if (!key) continue;
    const hints = [tag, meta.ar, ...meta.hints].map((h) => h.toLowerCase());
    const hit = wanted.some((term) => hints.some((hint) => term.includes(hint) || hint.includes(term)));
    if (!hit) continue;
    const id = `${key}=${tag}`;
    if (seen.has(id)) continue;
    seen.add(id);
    filters.push({ key, value: tag });
  }
  return filters.slice(0, 12);
}

/**
 * Contact keys used when a sector filter is present. The full list doubles
 * the arm count (filters × keys) and public mirrors shed such queries;
 * the four keys below cover the overwhelming majority of published records,
 * and the per-element main-API rescue fills in the rest.
 */
export const OSM_SECTOR_CONTACT_KEYS = ['phone', 'contact:phone', 'website', 'email'];

/** City centre (bbox midpoint) — OSM API neighbourhood queries anchor here. */
export function cityCentre(city: SaudiCity): { lat: number; lng: number } {
  const [south, west, north, east] = city.bbox;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/** A tighter, server-cheaper query: `nodes + ways`, not `nwr` (relations
 *  force a full member scan). `around` anchors close to the city centre so
 *  the server stops touching far tiles even while it is loaded. */
export function buildAroundQuery(city: SaudiCity, limit: number, radiusMeters: number, sectorFilters?: OsmSectorFilter[]): string {
  const { lat, lng } = cityCentre(city);
  const around = `around:${radiusMeters},${Number(lat.toFixed(4))},${Number(lng.toFixed(4))}`;
  const arms = !sectorFilters?.length
    ? OSM_CONTACT_KEYS.map((key) => `nw["name"]["${key}"](${around});`)
    : sectorFilters.flatMap((f) =>
        OSM_SECTOR_CONTACT_KEYS.map((key) => `nw["name"]["${f.key}"="${f.value}"]["${key}"](${around});`)
      );
  const union = arms.join('\n');
  return [
    '[out:json][timeout:20];',
    `// ${escapeOverpass(city.en)} (${escapeOverpass(city.ar)}) — Wusool open-data discovery`,
    '(',
    union,
    ');',
    `out center tags ${Math.max(1, Math.min(50, limit))};`,
  ].join('\n');
}

/**
 * One named element from Overpass merged with the full tags the main OSM API
 * returns for the same element id. Overpass answers name+contact quickly but
 * app loads earlier than when pushed. `null` means the fetch was incomplete.
 */
export function mergeOsmTags(
  element: any,
  tags: Record<string, string> | null | undefined,
  city: SaudiCity,
): OpenDataLead | null {
  const baseTags = element?.tags;
  if (!tags && !baseTags) return null;
  if (tags) {
    return mapOsmElement({ type: element?.type, id: element?.id, tags }, city);
  }
  return mapOsmElement(element, city);
}

/**
 * The dense business core of a metro area: the bbox centre ±0.15° (~16 km),
 * clamped inside the metro bbox. Public Overpass instances shed heavy queries
 * under load, so discovery scans the core where listed businesses cluster
 * instead of the whole administrative sprawl.
 */
export function coreBox(city: SaudiCity): string {
  const [south, west, north, east] = city.bbox;
  const midLat = (south + north) / 2;
  const midLng = (west + east) / 2;
  const round2 = (value: number) => Number(value.toFixed(2));
  const coreSouth = Math.max(south, round2(midLat - 0.15));
  const coreWest = Math.max(west, round2(midLng - 0.15));
  const coreNorth = Math.min(north, round2(midLat + 0.15));
  const coreEast = Math.min(east, round2(midLng + 0.15));
  return `${coreSouth},${coreWest},${coreNorth},${coreEast}`;
}

/** Contact details solicited from OSM. The sector is read client-side from tags. */
export const OSM_CONTACT_KEYS = [
  'phone',
  'contact:phone',
  'website',
  'contact:website',
  'email',
  'contact:email',
];

/**
 * Builds one bounded Overpass query: named elements that publish at least one
 * contact detail inside the city core, capped at `limit`. Every arm is an
 * exact-key match that uses the server index — a regex key scan over a whole
 * metro area is what gets killed on loaded public instances.
 */
export function buildOverpassQuery(city: SaudiCity, limit: number, sectorFilters?: OsmSectorFilter[]): string {
  const box = coreBox(city);
  // Targeted mode (measured June 2026): sector × contact arms inside the
  // city-core bbox answer in ~3s with every element carrying a contact
  // detail. The same arms under `around:` timed out at 26s+ on public
  // mirrors, and sector-only arms returned 200 elements of which only ~8%
  // published any contact — discovery therefore uses the bbox shape
  // whenever a sector filter is present.
  const arms = !sectorFilters?.length
    ? OSM_CONTACT_KEYS.map((key) => `  nwr["name"]["${key}"](${box});`)
    : sectorFilters.flatMap((f) =>
        OSM_SECTOR_CONTACT_KEYS.map((key) => `  nwr["name"]["${f.key}"="${f.value}"]["${key}"](${box});`)
      );
  const union = arms.join('\n');
  return [
    '[out:json][timeout:20];',
    `// ${escapeOverpass(city.en)} (${escapeOverpass(city.ar)}) — Wusool open-data discovery`,
    '(',
    union,
    ');',
    `out center tags ${Math.max(1, Math.min(50, limit))};`,
  ].join('\n');
}

/**
 * OSM tags are English values (`bakery`, `clinic`). A tenant's ideal-customer
 * profile is usually written in Arabic, so every known tag also carries the
 * Arabic label and plural used when matching the record against that profile.
 * An unknown tag is stored as-is and simply matches nothing — it is not
 * translated from a guess.
 */
export const OSM_SECTOR_LABELS: Record<string, { ar: string; hints: string[] }> = {
  bakery: { ar: 'مخبز', hints: ['مخابز', 'bakery', 'bakeries'] },
  cafe: { ar: 'مقهى', hints: ['مقاهي', 'كافيه', 'cafe', 'coffee'] },
  restaurant: { ar: 'مطعم', hints: ['مطاعم', 'restaurant', 'restaurants'] },
  fast_food: { ar: 'مطعم وجبات سريعة', hints: ['وجبات سريعة', 'fast food'] },
  supermarket: { ar: 'سوبرماركت', hints: ['بقالة', 'تموينات', 'supermarket', 'grocery'] },
  convenience: { ar: 'بقالة', hints: ['تموينات', 'convenience', 'grocery'] },
  greengrocer: { ar: 'خضار وفواكه', hints: ['خضار', 'فواكه', 'greengrocer'] },
  butcher: { ar: 'ملحمة', hints: ['لحوم', 'butcher'] },
  pharmacy: { ar: 'صيدلية', hints: ['صيدليات', 'pharmacy', 'pharmacies'] },
  clinic: { ar: 'عيادة', hints: ['عيادات', 'مجمع طبي', 'clinic', 'clinics'] },
  dentist: { ar: 'عيادة أسنان', hints: ['أسنان', 'dentist', 'dental'] },
  doctors: { ar: 'عيادة أطباء', hints: ['طبيب', 'أطباء', 'doctors'] },
  hospital: { ar: 'مستشفى', hints: ['مستشفيات', 'hospital', 'hospitals'] },
  veterinary: { ar: 'بيطري', hints: ['عيادة بيطرية', 'veterinary'] },
  hotel: { ar: 'فندق', hints: ['فنادق', 'إقامة', 'hotel', 'hotels'] },
  school: { ar: 'مدرسة', hints: ['مدارس', 'تعليم', 'school', 'schools'] },
  university: { ar: 'جامعة', hints: ['جامعات', 'university'] },
  gym: { ar: 'نادي رياضي', hints: ['صالة رياضية', 'جيم', 'gym', 'fitness'] },
  fitness_centre: { ar: 'نادي لياقة', hints: ['لياقة', 'جيم', 'fitness'] },
  car_repair: { ar: 'ورشة سيارات', hints: ['ورش', 'صيانة سيارات', 'car repair', 'garage'] },
  furniture: { ar: 'أثاث', hints: ['معرض أثاث', 'furniture'] },
  electronics: { ar: 'إلكترونيات', hints: ['اجهزة', 'electronics'] },
  mobile_phone: { ar: 'جوالات', hints: ['هواتف', 'mobile phone'] },
  clothes: { ar: 'ملابس', hints: ['أزياء', 'clothing', 'fashion'] },
  estate_agent: { ar: 'عقارات', hints: ['وساطة عقارية', 'real estate', 'property'] },
  lawyer: { ar: 'محاماة', hints: ['محامي', 'lawyer', 'legal'] },
  accountant: { ar: 'محاسبة', hints: ['محاسب', 'accounting', 'audit'] },
  insurance: { ar: 'تأمين', hints: ['insurance'] },
  travel_agency: { ar: 'سفر وسياحة', hints: ['وكالة سفر', 'travel agency'] },
  bank: { ar: 'بنك', hints: ['مصرف', 'bank'] },
  beauty: { ar: 'تجميل', hints: ['مركز تجميل', 'beauty', 'salon'] },
  hairdresser: { ar: 'صالون', hints: ['حلاقة', 'hairdresser', 'barber'] },
  laundry: { ar: 'مغسلة', hints: ['غسيل', 'laundry'] },
  optician: { ar: 'بصريات', hints: ['نظارات', 'optician'] },
  hardware: { ar: 'أدوات ومواد بناء', hints: ['مواد بناء', 'hardware'] },
  photographer: { ar: 'تصوير', hints: ['مصور', 'photographer'] },
};

export type OpenDataLead = {
  companyName: string;
  sector?: string;
  /** Tag value, Arabic label and plurals used for ICP matching. */
  sectorHints?: string[];
  /** Stable identity of the OSM element, so re-runs never duplicate a record. */
  dedupeKey: string;
  city: string;
  country: string;
  email?: string;
  emailSource?: 'public_page';
  phone?: string;
  phoneSource?: 'public_page';
  website?: string;
  profileUrl?: string;
  profilePlatform?: 'openstreetmap';
  signal: 'company_fit';
  evidence: string;
  sourceUrl: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOMAIN_RE = /^[\w-]+(\.[\w-]+)+([/?#].*)?$/;

/**
 * A lead is only usable when it carries a direct contact channel — a phone
 * number or an email. A website alone is not contact data: the tenant cannot
 * call, message or email it, so website-only records are dropped (after the
 * homepage rescue below has had a chance to find a real phone/email).
 */
export function hasDirectContact(
  lead: { phone?: string | null; email?: string | null } | null | undefined
): boolean {
  if (!lead) return false;
  const digits = String(lead.phone ?? '').replace(/[^0-9]/g, '');
  if (digits.length >= 7) return true;
  return EMAIL_RE.test(String(lead.email ?? '').trim().toLowerCase());
}

/**
 * Pulls Saudi phone numbers out of a business homepage. `tel:` links are
 * tried first (the site declares them as numbers), then the common Saudi
 * shapes (+966…, 05…, 01…, 920…, 800…). Returns the first few distinct
 * plausible numbers; never invents one.
 */
export function extractPhonesFromHtml(html: string): string[] {
  const text = String(html ?? '');
  if (!text) return [];
  const found: string[] = [];
  const push = (raw: string) => {
    const digits = String(raw ?? '').replace(/[^0-9]/g, '');
    const plausible =
      (digits.startsWith('966') && digits.length >= 12) ||
      (digits.startsWith('0') && digits.length >= 9) ||
      ((digits.startsWith('920') || digits.startsWith('800')) && digits.length >= 9 && digits.length <= 12);
    if (!plausible) return;
    const clean = String(raw ?? '').trim().slice(0, 40);
    if (clean && !found.includes(clean) && found.length < 3) found.push(clean);
  };
  for (const match of text.matchAll(/href=["']tel:([^"'#]+)/gi)) push(match[1]);
  if (found.length) return found;
  const generic =
    /(?:\+?966[\s-]?[0-9][0-9\s-]{7,}|\b0(?:5[0-9]|1[0-9]|2[0-9]|9[0-9])[\s-]?[0-9][0-9\s-]{6,}|\b(?:920|800)[\s-]?[0-9][0-9\s-]{5,})/g;
  for (const match of text.matchAll(generic)) push(match[0]);
  return found;
}

/** OSM contributors write `example.com` as often as `https://example.com`. */
export function normalizeWebsite(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : DOMAIN_RE.test(raw) ? `https://${raw}` : '';
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const OSM_URL = 'https://www.openstreetmap.org';

/**
 * Converts one Overpass element into a lead, or null when the record does not
 * carry enough published evidence. Nothing is filled in from a guess.
 */
export function mapOsmElement(element: any, city: SaudiCity): OpenDataLead | null {
  const tags = element?.tags;
  if (!tags || typeof tags !== 'object') return null;
  const type = typeof element?.type === 'string' ? element.type : '';
  const id = Number(element?.id);
  if (!['node', 'way', 'relation'].includes(type) || !Number.isFinite(id) || id <= 0) return null;

  const name = String(tags.name ?? tags['name:ar'] ?? tags['name:en'] ?? '').trim().slice(0, 200);
  if (!name) return null;

  const phone = String(tags.phone ?? tags['contact:phone'] ?? '').trim().slice(0, 40);
  const emailRaw = String(tags.email ?? tags['contact:email'] ?? '')
    .trim()
    .toLowerCase();
  const email = EMAIL_RE.test(emailRaw) ? emailRaw.slice(0, 200) : '';
  const website = normalizeWebsite(tags.website ?? '') ?? normalizeWebsite(tags['contact:website'] ?? '');
  if (!phone && !email && !website) return null;

  const sectorKey = ['healthcare', 'shop', 'amenity', 'office', 'tourism'].find((key) => tags[key]);
  const sectorTag = sectorKey ? String(tags[sectorKey]).trim().slice(0, 120) : '';
  const sectorMeta = sectorTag ? OSM_SECTOR_LABELS[sectorTag.split(';')[0].trim()] : undefined;
  const sector = sectorMeta ? sectorMeta.ar : sectorTag || undefined;
  const sectorHints = sectorTag
    ? [sectorTag, ...(sectorMeta ? [sectorMeta.ar, ...sectorMeta.hints] : [])]
    : [];
  const address = String(
    [tags['addr:street'], tags['addr:housenumber'], tags['addr:district']].filter(Boolean).join('، ')
  )
    .trim()
    .slice(0, 200);
  const listedCity = String(tags['addr:city'] ?? '').trim().slice(0, 120) || city.ar;

  const sourceUrl = `${OSM_URL}/${type}/${id}`;
  // Attribution comes first so it survives the truncated preview in the lead
  // list: the ODbL requires the data user to see where the record came from.
  const evidence = [
    `OpenStreetMap (${OSM_ATTRIBUTION}): «${name}»`,
    sectorKey ? `(${sectorKey}=${sector})` : '',
    phone ? 'هاتف منشور على OpenStreetMap' : email ? 'بريد منشور على OpenStreetMap' : 'موقع منشور على OpenStreetMap',
    address ? `— ${address}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 600);

  return {
    companyName: name,
    sector,
    sectorHints,
    dedupeKey: `osm:${type}/${id}`,
    city: listedCity,
    country: 'SA',
    email: email || undefined,
    emailSource: email ? 'public_page' : undefined,
    phone: phone || undefined,
    phoneSource: phone ? 'public_page' : undefined,
    website: website ?? undefined,
    profileUrl: sourceUrl,
    profilePlatform: 'openstreetmap',
    signal: 'company_fit',
    evidence,
    sourceUrl,
  };
}

export type OsmDiscoveryOptions = {
  endpoint?: string | null;
  city: SaudiCity;
  limit: number;
  /** Target the tenant's activity: only these OSM sector tags are queried. */
  sectorFilters?: OsmSectorFilter[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type OsmDiscoveryResult = {
  leads: OpenDataLead[];
  endpoint: string;
  /** Elements returned by Overpass that did not qualify as leads. */
  skipped: number;
};

/**
 * Runs one bounded Overpass request, then richer contact tags via the main
 * OSM API when Overpass answered with name-only records. Network/capacity
 * problems become stable error codes instead of an empty result, so the
 * screen can say "busy, retry" rather than "no leads found".
 *
 * Resilience under a loaded public instance (measured June 2026):
 *   1. Tier radii — a tighter query succeeds when a wide one is shed.
 *   2. Sequential retries — the first attempt is often rejected while the
 *      second, seconds later, answers (measured again and again).
 *   3. Main-OSM-API rescue — when Overpass returns name+contact with no
 *      other tags (ways whose tags were folded), the full tags are fetched
 *      from www.openstreetmap.org/api/0.6 directly when that helps.
 *
 * A configured `LEAD_DATA_API_URL` is never overridden: the operator chose
 * it, so it stays a single attempt.
 */

const TIER_RADII = [20_000, 13_000, 8_000];
const MAX_ATTEMPTS_PER_TIER = 2;
const PAUSE_MS = 800;

export async function discoverOpenDataLeads(options: OsmDiscoveryOptions): Promise<OsmDiscoveryResult> {
  const configured = options.endpoint && /^https?:\/\//i.test(options.endpoint) ? options.endpoint : null;
  const configuredEndpoints = configured ? [configured] : null;
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  let lastError: LeadSourceError | null = null;

  // No configured endpoint: rotate the public mirrors, each with its own
  // radius tiers, so one at-capacity server cannot fail the whole run.
  // Targeted (sector-filtered) queries use the bbox shape on every mirror:
  // the `around:` shape was measured timing out for sector arms while the
  // bbox shape answers in seconds.
  const targeted = !!options.sectorFilters?.length;
  const tiers: Array<{ endpoint: string; radius?: number; box?: boolean }> = configuredEndpoints
    ? configuredEndpoints.map((endpoint) => ({ endpoint, box: true }))
    : targeted
      ? OSM_ENDPOINTS.map((endpoint) => ({ endpoint, box: true }))
      : OSM_ENDPOINTS.flatMap((endpoint) => TIER_RADII.map((radius) => ({ endpoint, radius })));
  const deadline = Date.now() + 50_000;

  for (const tier of tiers) {
    if (Date.now() > deadline) break;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TIER; attempt += 1) {
      if (attempt > 1) {
        await sleep(PAUSE_MS);
      }
      const query = tier.box
        ? buildOverpassQuery(options.city, limit, options.sectorFilters)
        : buildAroundQuery(options.city, limit, tier.radius ?? 20_000, options.sectorFilters);
      try {
        const fetched = await requestOverpass(tier.endpoint, options, query);
        const enriched = await enrichWithMainApi(fetched.leads, options);
        const withContacts = await enrichContactsFromWebsites(enriched, options);
        // Hard rule: no phone and no email = not a lead. Website-only
        // records that the homepage rescue could not turn into a direct
        // contact are dropped here, never shown to the tenant.
        const leads = withContacts.filter(hasDirectContact);
        const droppedNoContact = withContacts.length - leads.length;
        return {
          leads,
          endpoint: tier.endpoint,
          skipped: fetched.skipped + droppedNoContact,
        };
      } catch (error) {
        const failure = error instanceof LeadSourceError ? error : null;
        lastError = failure ?? new LeadSourceError('lead_source_failed');
        const retryable =
          failure?.code === 'lead_source_busy' || failure?.code === 'lead_source_timeout';
        if (!retryable) {
          throw failure ?? new LeadSourceError('lead_source_failed');
        }
        // retryable: try again (next attempt, same tier), or the next tier.
      }
    }
  }

  throw lastError ?? new LeadSourceError('lead_source_failed');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Overpass returns a record with only the contact fields it filtered on when
 * the full tag set was folded into the query plan (common under load). The
 * main OSM API returns every tag for an element id in one light request;
 * fetch those for name-only records so leads keep sector/score evidence.
 * One element per call — small, cheap, and fail-soft per record.
 */
async function enrichWithMainApi(
  leads: OpenDataLead[],
  options: OsmDiscoveryOptions
): Promise<OpenDataLead[]> {
  // Light per-element tag lookups run in small parallel batches (5 at a
  // time): sequential adds ~1-3s per record, which made a 20-lead run take
  // over a minute. Batches keep the public API's fair-use spirit.
  const enriched: OpenDataLead[] = [];
  for (let i = 0; i < leads.length; i += 5) {
    const batch = await Promise.all(leads.slice(i, i + 5).map((lead) => enrichOneWithMainApi(lead, options)));
    enriched.push(...batch);
  }
  return enriched;
}

async function enrichOneWithMainApi(
  lead: OpenDataLead,
  options: OsmDiscoveryOptions
): Promise<OpenDataLead> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = elementApiUrl(lead);
  if (!url) return lead;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': OSM_USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) return lead;
      const payload: any = await response.json();
      const element = payload?.elements?.[0];
      if (element?.tags) {
        const merged = mergeOsmTags({ type: element.type, id: element.id, tags: element.tags }, element.tags, options.city);
        return merged ?? lead;
      }
      return lead;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return lead;
  }
}

/**
 * Many OSM records publish a website but no email and/or no phone. Fetching
 * the business's own homepage for a published `mailto:` / contact email or
 * a `tel:` / printed phone number is public data, not scraping a directory
 * — the values are stored with the same `public_page` source the leads
 * table already accepts. Bounded: at most 8 sites, 6s each, fail-soft per
 * record, and placeholder domains skipped.
 */
async function enrichContactsFromWebsites(
  leads: OpenDataLead[],
  options: OsmDiscoveryOptions
): Promise<OpenDataLead[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const enriched: OpenDataLead[] = [];
  let visited = 0;
  for (const lead of leads) {
    if ((lead.email && lead.phone) || !lead.website || visited >= 8) {
      enriched.push(lead);
      continue;
    }
    let host = '';
    try {
      host = new URL(lead.website).hostname.toLowerCase();
    } catch {
      enriched.push(lead);
      continue;
    }
    if (host.includes('example.') || host === 'localhost' || host.startsWith('127.')) {
      enriched.push(lead);
      continue;
    }
    visited += 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6_000);
      try {
        const response = await fetchImpl(lead.website, {
          headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': OSM_USER_AGENT },
          signal: controller.signal,
          redirect: 'follow',
        });
        if (!response.ok) {
          enriched.push(lead);
          continue;
        }
        const html = (await response.text()).slice(0, 300_000);
        const mailto = /mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(html)?.[1];
        const foundEmail = mailto ?? [...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
          .map((match) => match[0])
          .find((address) => !/^(noreply|no-reply|postmaster|mailer-daemon)@/i.test(address) && !/example\./i.test(address));
        const foundPhone = lead.phone ? undefined : extractPhonesFromHtml(html)[0];
        if (foundEmail || foundPhone) {
          enriched.push({
            ...lead,
            email: lead.email ?? (foundEmail ? foundEmail.toLowerCase().slice(0, 200) : undefined),
            emailSource: lead.email || foundEmail ? 'public_page' : undefined,
            phone: lead.phone ?? foundPhone,
            phoneSource: lead.phone || foundPhone ? 'public_page' : undefined,
          });
        } else {
          enriched.push(lead);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      enriched.push(lead);
    }
  }
  return enriched;
}

function elementApiUrl(lead: OpenDataLead): string | null {
  const match = /openstreetmap\.org\/(node|way|relation)\/(\d+)/.exec(lead.sourceUrl);
  if (!match) return null;
  return `https://www.openstreetmap.org/api/0.6/${match[1]}/${match[2]}`;
}

async function requestOverpass(
  endpoint: string,
  options: OsmDiscoveryOptions,
  query?: string
): Promise<Pick<OsmDiscoveryResult, 'leads' | 'skipped'>> {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const fetchQuery = query ?? buildOverpassQuery(options.city, limit);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 20_000);

  let payload: any;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': OSM_USER_AGENT,
      },
      body: new URLSearchParams({ data: fetchQuery }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new LeadSourceError(
        response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504
          ? 'lead_source_busy'
          : 'lead_source_failed',
        `overpass_status_${response.status}`
      );
    }
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LeadSourceError('lead_source_busy', 'overpass_non_json_response');
    }
  } catch (error) {
    if (error instanceof LeadSourceError) throw error;
    const name = (error as Error)?.name ?? '';
    const message = String((error as Error)?.message ?? '');
    if (timedOut || name === 'AbortError' || /abort|timeout/i.test(message)) {
      throw new LeadSourceError('lead_source_timeout', 'overpass_timeout');
    }
    throw new LeadSourceError('lead_source_failed', message || 'overpass_request_failed');
  } finally {
    clearTimeout(timer);
  }

  // Overpass reports query timeouts inside a 200 response as `remark`.
  if (typeof payload?.remark === 'string' && /timed out|runtime error/i.test(payload.remark)) {
    throw new LeadSourceError('lead_source_timeout', payload.remark.slice(0, 200));
  }

  const elements: any[] = Array.isArray(payload?.elements) ? payload.elements : [];
  const leads: OpenDataLead[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const seenNamePhone = new Set<string>();

  for (const element of elements) {
    const lead = mapOsmElement(element, options.city);
    if (!lead) {
      skipped += 1;
      continue;
    }
    if (seen.has(lead.sourceUrl)) {
      skipped += 1;
      continue;
    }
    // The same business is often listed twice in OSM under different element
    // ids (e.g. a café chain with two pins). Dedupe on normalized name+phone
    // so the tenant does not see the same prospect twice in one run.
    const namePhone = `${normalizeCityName(lead.companyName)}|${(lead.phone ?? '').replace(/[^0-9]/g, '')}`;
    if (lead.phone && seenNamePhone.has(namePhone)) {
      skipped += 1;
      continue;
    }
    seen.add(lead.sourceUrl);
    if (lead.phone) seenNamePhone.add(namePhone);
    leads.push(lead);
    if (leads.length >= limit) break;
  }

  return { leads, skipped: Math.max(skipped, elements.length - leads.length) };
}
