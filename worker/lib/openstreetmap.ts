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
/** Used only when the primary instance answers "at capacity" or 429. */
export const OSM_FALLBACK_ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';
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
export function buildOverpassQuery(city: SaudiCity, limit: number): string {
  const box = coreBox(city);
  const union = OSM_CONTACT_KEYS.map((key) => `  nwr["name"]["${key}"](${box});`).join('\n');
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
 * Runs one bounded Overpass request. Network/capacity problems become stable
 * error codes instead of an empty result, so the screen can say "busy, retry"
 * rather than "no leads found".
 * When a public instance rejects a request because it is at capacity — or a
 * query times out on it — the next mirror is tried sequentially before the
 * run is reported as failed. A configured `LEAD_DATA_API_URL` is never
 * overridden: the operator chose it, so it stays a single attempt.
 */
export async function discoverOpenDataLeads(options: OsmDiscoveryOptions): Promise<OsmDiscoveryResult> {
  const configured = options.endpoint && /^https?:\/\//i.test(options.endpoint) ? options.endpoint : null;
  const endpoints = configured ? [configured] : [OSM_ENDPOINT, OSM_FALLBACK_ENDPOINT];
  let lastError: LeadSourceError | null = null;

  for (const endpoint of endpoints) {
    try {
      return await requestOverpass(endpoint, options);
    } catch (error) {
      const failure = error instanceof LeadSourceError ? error : null;
      // Capacity rejections and per-instance timeouts are worth retrying on
      // another mirror; anything else (or the last mirror) ends the run.
      const retryable = failure?.code === 'lead_source_busy' || failure?.code === 'lead_source_timeout';
      if (!retryable || endpoint === endpoints[endpoints.length - 1]) {
        throw failure ?? new LeadSourceError('lead_source_failed');
      }
      lastError = failure;
    }
  }

  throw lastError ?? new LeadSourceError('lead_source_failed');
}

async function requestOverpass(
  endpoint: string,
  options: OsmDiscoveryOptions
): Promise<OsmDiscoveryResult> {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const query = buildOverpassQuery(options.city, limit);
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 45_000);

  let payload: any;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': OSM_USER_AGENT,
      },
      body: new URLSearchParams({ data: query }).toString(),
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
    seen.add(lead.sourceUrl);
    leads.push(lead);
    if (leads.length >= limit) break;
  }

  return { leads, endpoint, skipped: Math.max(skipped, elements.length - leads.length) };
}
