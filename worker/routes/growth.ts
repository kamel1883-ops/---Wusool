/**
 * Lead acquisition and marketing automation. Mounted at /api/company.
 *
 * Two journeys live here:
 *   1. Discovery — turning an approved site analysis into an ideal customer
 *      profile, then finding leads through a licensed source. Without
 *      configured credentials the endpoint refuses and invents nothing.
 *   2. Activation — creating a campaign, checking it against real
 *      preconditions (connected channel, approved content, consent, DNC) and
 *      sending only through a channel that is actually wired up.
 *
 * Nothing in this file fabricates a lead, a phone number, an email or a metric.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import { companyContext, requireAuth } from '../lib/auth';
import {
  all,
  audit,
  computeSubscription,
  first,
  getSettings,
  newId,
  nowIso,
  readJson,
  run,
  str,
} from '../lib/db';
import { can } from '../lib/rbac';
import {
  LeadSourceError,
  OSM_ENDPOINT,
  discoverOpenDataLeads,
  resolveSaudiCity,
  type SaudiCity,
} from '../lib/openstreetmap';
import { apiError } from './public';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

const MANAGE = 'leads.manage';

const SIGNALS = ['search_intent', 'public_request', 'public_question', 'company_fit', 'inbound'] as const;
type Signal = (typeof SIGNALS)[number];

const STAGES = ['new', 'qualified', 'contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'] as const;
const CONSENT_STATES = ['unknown', 'granted', 'withdrawn'] as const;
const CHANNELS = ['email', 'whatsapp', 'meta', 'linkedin'] as const;
type Channel = (typeof CHANNELS)[number];

type ChannelState = 'connected' | 'awaiting_approval' | 'requires_credentials';

type ChannelInfo = {
  channel: Channel;
  label: { ar: string; en: string };
  state: ChannelState;
  /** Env vars that must exist on the deployment before the channel can send. */
  requires: string[];
  /** Extra approval a provider demands beyond credentials. */
  approval: { ar: string; en: string } | null;
  canSendFromThisBuild: boolean;
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const jsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.map((item) => str(item, 160)).filter(Boolean).slice(0, 40);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,،\n]/)
      .map((item) => item.trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 40);
  }
  return [];
};

const parseJson = <T,>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Channels — status is derived from the deployment, never from a UI toggle
// ---------------------------------------------------------------------------

function channelRegistry(env: any, settings: Record<string, string>): ChannelInfo[] {
  const approved = (channel: string) => settings[`integration.${channel}.approved`] === '1';
  const build = (
    channel: Channel,
    label: { ar: string; en: string },
    credentials: string[],
    hasCredentials: boolean,
    approval: { ar: string; en: string } | null,
    canSendFromThisBuild: boolean
  ): ChannelInfo => {
    let state: ChannelState = 'requires_credentials';
    if (hasCredentials) state = approval && !approved(channel) ? 'awaiting_approval' : 'connected';
    return { channel, label, state, requires: credentials, approval, canSendFromThisBuild };
  };

  return [
    build(
      'email',
      { ar: 'البريد الإلكتروني', en: 'Email' },
      ['EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM'],
      Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM),
      {
        ar: 'دومين المرسل موثّق عند المزوّد (SPF/DKIM)',
        en: 'Sender domain verified at the provider (SPF/DKIM)',
      },
      Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM)
    ),
    build(
      'whatsapp',
      { ar: 'WhatsApp Business Cloud API', en: 'WhatsApp Business Cloud API' },
      ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'],
      Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID),
      {
        ar: 'قالب معتمد من Meta وموافقة مستلم موثّقة',
        en: 'Meta-approved template and recorded recipient opt-in',
      },
      false
    ),
    build(
      'meta',
      { ar: 'Facebook وInstagram (Meta Graph API)', en: 'Facebook & Instagram (Meta Graph API)' },
      ['META_PAGE_TOKEN', 'META_PAGE_ID', 'META_IG_USER_ID'],
      Boolean(env.META_PAGE_TOKEN && env.META_PAGE_ID),
      {
        ar: 'مراجعة تطبيق Meta وصلاحيات pages_manage_posts / instagram_content_publish',
        en: 'Meta app review and pages_manage_posts / instagram_content_publish permissions',
      },
      false
    ),
    build(
      'linkedin',
      { ar: 'LinkedIn API الرسمي', en: 'LinkedIn official API' },
      ['LINKEDIN_TOKEN', 'LINKEDIN_ORGANIZATION_ID'],
      Boolean(env.LINKEDIN_TOKEN && env.LINKEDIN_ORGANIZATION_ID),
      {
        ar: 'الموافقة على Community Management API وصلاحية w_organization_social',
        en: 'Community Management API approval and w_organization_social permission',
      },
      false
    ),
  ];
}

/**
 * Client-safe view of a `requires` list. Server credentials are single-tenant
 * deployment secrets (or legacy static tokens that must NOT be provisioned for
 * a multi-tenant setup); only human-readable explanations cross the API.
 * Anything shaped like an env-var name never leaves the server.
 */
const clientSafeRequirements = (items: unknown): string[] => {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0 && !/^[A-Z][A-Z0-9_]*(\s*=.*)?$/.test(item));
};

/** Provider names that mean "use the open OpenStreetMap data, no key needed". */
const OPEN_DATA_PROVIDERS = ['openstreetmap', 'osm', 'overpass'];

/**
 * Resolves the configured discovery source. Two kinds exist:
 *   - licensed_data: an account, an endpoint and a key must all be present.
 *   - open_data:     OpenStreetMap over Overpass. No key and no fee; enabling
 *                    it is one variable, and the ODbL attribution is kept on
 *                    every record. `LEAD_DATA_API_URL` may point at a mirror
 *                    or a self-hosted instance when the public one is busy.
 */
function leadDataSource(env: any) {
  const configured = str(env.LEAD_DATA_PROVIDER, 40).toLowerCase();
  const url = str(env.LEAD_DATA_API_URL, 400);
  const key = str(env.LEAD_DATA_API_KEY, 400);
  const endpoint = isHttpUrl(url) ? url : null;

  // OpenStreetMap needs no key, so it is the default when nothing is
  // configured: the source shows "connected" out of the box instead of
  // forcing the owner to set LEAD_DATA_PROVIDER=openstreetmap manually.
  if (!configured || OPEN_DATA_PROVIDERS.includes(configured)) {
    return {
      provider: 'openstreetmap',
      kind: 'open_data' as const,
      tableKind: 'organisation_search' as const,
      label: 'OpenStreetMap (ODbL open data)',
      credentialRef: null as string | null,
      endpoint: endpoint ?? OSM_ENDPOINT,
      connected: true,
      requires: [
        'لا مفاتيح ولا رسوم — بيانات مفتوحة بترخيص ODbL',
        'No key or fee — OpenStreetMap open data under ODbL',
      ],
    };
  }

  return {
    provider: configured || null,
    kind: 'licensed_data' as const,
    tableKind: 'licensed_data' as const,
    label: 'Licensed lead-data provider',
    credentialRef: 'LEAD_DATA_API_KEY' as string | null,
    endpoint,
    connected: Boolean(configured && endpoint && key),
    requires: ['LEAD_DATA_PROVIDER', 'LEAD_DATA_API_URL', 'LEAD_DATA_API_KEY'],
  };
}

// ---------------------------------------------------------------------------
// Scoring — deterministic, explainable, stored with the lead
// ---------------------------------------------------------------------------

type ScoreReason = { code: string; points: number; detail: string };

function scoreLead(
  input: {
    signal: Signal;
    sector?: string | null;
    /** Additional spellings (tag value, Arabic label, plurals) used only for matching. */
    sectorHints?: string[];
    city?: string | null;
    email?: string | null;
    phone?: string | null;
    consentState?: string;
  },
  icp: { sectors: string[]; services: string[]; keywords: string[]; cities: string[] }
) {
  const reasons: ScoreReason[] = [];
  let score = 20;
  reasons.push({ code: 'evidence', points: 20, detail: 'قابل للمراجعة عبر مصدر عام' });

  const signalPoints: Record<Signal, number> = {
    inbound: 30,
    public_request: 25,
    search_intent: 22,
    public_question: 18,
    company_fit: 10,
  };
  score += signalPoints[input.signal];
  reasons.push({ code: `signal.${input.signal}`, points: signalPoints[input.signal], detail: 'قوة مؤشر الاهتمام' });

  // "Match with the client's activity": the record's sector is compared with
  // the profile's sectors, services and keywords in both Arabic and English.
  const wanted = [...icp.sectors, ...icp.services, ...icp.keywords]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const nearby = [input.sector ?? '', ...(input.sectorHints ?? [])]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const matchedTerm = nearby.find((term) =>
    wanted.some((item) => item.includes(term) || term.includes(item))
  );
  if (matchedTerm) {
    score += 12;
    reasons.push({ code: 'sector_match', points: 12, detail: `نشاط مطابق لملف العميل المثالي (${matchedTerm})` });
  }
  const city = (input.city ?? '').toLowerCase();
  if (city && icp.cities.some((item) => item.toLowerCase().includes(city) || city.includes(item.toLowerCase()))) {
    score += 8;
    reasons.push({ code: 'city_match', points: 8, detail: 'مدينة داخل نطاق الاستهداف' });
  }
  if (input.email) {
    score += 6;
    reasons.push({ code: 'email_available', points: 6, detail: 'بريد متاح بمصدر معلن' });
  }
  if (input.phone) {
    score += 4;
    reasons.push({ code: 'phone_available', points: 4, detail: 'هاتف متاح بمصدر معلن' });
  }
  if (input.consentState === 'granted') {
    score += 10;
    reasons.push({ code: 'consent_granted', points: 10, detail: 'موافقة تواصل مسجّلة' });
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

const leadDedupeKey = (lead: {
  email?: string | null;
  website?: string | null;
  companyName?: string | null;
  name?: string | null;
  city?: string | null;
}) => {
  if (lead.email) return `email:${lead.email.trim().toLowerCase()}`;
  if (lead.website) {
    try {
      return `domain:${new URL(lead.website).host.toLowerCase().replace(/^www\./, '')}`;
    } catch {
      /* fall through */
    }
  }
  const label = (lead.companyName || lead.name || 'unknown').trim().toLowerCase();
  return `name:${label}|${(lead.city || '').trim().toLowerCase()}`;
};

const serializeLead = (row: any) => ({
  id: row.id,
  name: row.name,
  companyName: row.company_name,
  jobTitle: row.job_title,
  sector: row.sector,
  city: row.city,
  country: row.country,
  email: row.email,
  emailSource: row.email_source,
  phone: row.phone,
  phoneSource: row.phone_source,
  website: row.website,
  profileUrl: row.profile_url,
  profilePlatform: row.profile_platform,
  sourceKind: row.source_kind,
  sourceProvider: row.source_provider,
  sourceUrl: row.source_url,
  evidenceText: row.evidence_text,
  evidenceCheckedAt: row.evidence_checked_at,
  interestSignal: row.interest_signal,
  score: row.score,
  scoreReasons: parseJson<ScoreReason[]>(row.score_reason_json, []),
  classification: row.classification ?? 'potential',
  stage: row.stage,
  consentState: row.consent_state,
  consentAt: row.consent_at,
  doNotContact: Boolean(row.do_not_contact),
  campaignId: row.campaign_id,
  discoveredAt: row.discovered_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeIcp = (row: any) => ({
  services: parseJson<string[]>(row.services_json, []),
  sectors: parseJson<string[]>(row.sectors_json, []),
  cities: parseJson<string[]>(row.cities_json, []),
  countries: parseJson<string[]>(row.countries_json, []),
  keywords: parseJson<string[]>(row.keywords_json, []),
  problems: parseJson<string[]>(row.problems_json, []),
  idealAudience: row.ideal_audience ?? '',
  offer: row.offer ?? '',
  analysisId: row.analysis_id ?? null,
  evidence: parseJson<any[]>(row.evidence_json, []),
  updatedAt: row.updated_at,
});

const EMPTY_ICP = {
  services: [] as string[],
  sectors: [] as string[],
  cities: [] as string[],
  countries: [] as string[],
  keywords: [] as string[],
  problems: [] as string[],
  idealAudience: '',
  offer: '',
  analysisId: null as string | null,
  evidence: [] as any[],
  updatedAt: null as string | null,
};

const serializeCampaign = (row: any) => ({
  id: row.id,
  name: row.name,
  objective: row.objective,
  audience: row.audience,
  sector: row.sector,
  city: row.city,
  channel: row.channel,
  status: row.status,
  contentRef: row.content_ref,
  contentApproved: Boolean(row.content_approved),
  budgetSar: row.budget_sar,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  createdBy: row.created_by,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function loadIcp(env: any, companyId: string) {
  const row = await first<any>(env, 'SELECT * FROM company_icp WHERE company_id = ?', companyId);
  return row ? serializeIcp(row) : EMPTY_ICP;
}

async function approvedAnalysis(env: any, companyId: string) {
  return first<any>(
    env,
    `SELECT a.id, a.url, a.approved_version, a.completed_at, r.result_json
       FROM site_analyses a
       LEFT JOIN analysis_results r
         ON r.analysis_id = a.id AND r.version = a.approved_version
      WHERE a.company_id = ? AND a.status = 'approved' AND a.approved_version IS NOT NULL
      ORDER BY a.completed_at DESC LIMIT 1`,
    companyId
  );
}

function deriveIcp(resultJson: string | null) {
  const result = parseJson<any>(resultJson ?? '', null);
  if (!result) return null;

  const titles = (field: string) =>
    Array.isArray(result[field])
      ? result[field]
          .map((item: any) => str(item?.value ?? item?.text ?? item, 180))
          .filter(Boolean)
          .slice(0, 20)
      : [];
  const evidence: any[] = [];
  const withEvidence = (field: string, sourceField: string) => {
    if (!Array.isArray(result[sourceField])) return;
    result[sourceField].slice(0, 8).forEach((item: any) => {
      const value = str(item?.value ?? item?.text ?? item, 180);
      if (!value) return;
      evidence.push({
        field,
        value,
        source: item?.source ?? 'website',
        confidence: typeof item?.confidence === 'number' ? item.confidence : null,
        evidenceUrl: item?.evidence_url ?? item?.evidenceUrl ?? null,
      });
    });
  };

  const services = titles('products_and_services');
  const sectors = titles('target_markets');
  const cities = titles('target_locations');
  const keywords = titles('keywords');
  const problems = titles('customer_problems');
  const audiences = titles('audiences').concat(titles('buyer_personas'));
  withEvidence('services', 'products_and_services');
  withEvidence('sectors', 'target_markets');
  withEvidence('cities', 'target_locations');
  withEvidence('keywords', 'keywords');
  withEvidence('problems', 'customer_problems');
  withEvidence('audiences', 'audiences');

  const audienceText = audiences[0] ?? '';
  const offer = titles('value_proposition')[0] ?? '';

  if (!services.length && !sectors.length && !audiences.length) return null;
  return {
    services,
    sectors,
    cities,
    countries: [] as string[],
    keywords,
    problems,
    idealAudience: audienceText,
    offer,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

app.get('/:companyId/growth', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'leads.manage') && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const settings = await getSettings(c.env);
  const icp = await loadIcp(c.env, company.id);
  const analysis = await approvedAnalysis(c.env, company.id);
  const source = leadDataSource(c.env);

  const counts = await first<any>(
    c.env,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN stage IN ('qualified','contacted','replied','meeting','proposal','won') THEN 1 ELSE 0 END) AS qualified,
       SUM(CASE WHEN consent_state = 'granted' THEN 1 ELSE 0 END) AS consented,
       SUM(CASE WHEN do_not_contact = 1 THEN 1 ELSE 0 END) AS dnc,
       SUM(CASE WHEN classification = 'potential' THEN 1 ELSE 0 END) AS potential,
       SUM(CASE WHEN classification = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
     FROM leads WHERE company_id = ?`,
    company.id
  );
  const campaignCount = await first<any>(
    c.env,
    'SELECT COUNT(*) AS total FROM campaigns WHERE company_id = ?',
    company.id
  );
  const messageStats = await first<any>(
    c.env,
    `SELECT
       SUM(CASE WHEN status IN ('sent','delivered') THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM outreach_messages WHERE company_id = ?`,
    company.id
  );

  return c.json({
    icp,
    analysis: analysis
      ? { id: analysis.id, url: analysis.url, approvedVersion: analysis.approved_version, approvedAt: analysis.completed_at }
      : null,
    sources: [
      {
        provider: 'openstreetmap',
        kind: 'open_data',
        label: {
          ar: 'OpenStreetMap — بيانات أعمال مفتوحة',
          en: 'OpenStreetMap — open business data',
        },
        state: source.kind === 'open_data' ? 'connected' : 'disabled',
        requires: clientSafeRequirements(
          source.kind === 'open_data'
            ? ['لا مفاتيح ولا رسوم — ترخيص ODbL', 'No key, no fee — ODbL licence', '© OpenStreetMap contributors']
            : ['LEAD_DATA_PROVIDER=openstreetmap', 'لا مفاتيح — بيانات مفتوحة ODbL', 'No key — OpenStreetMap ODbL']
        ),
        providerName: 'openstreetmap',
      },
      {
        provider: 'licensed_data',
        kind: 'licensed_data',
        label: { ar: 'مزوّد بيانات عملاء مرخّص', en: 'Licensed lead-data provider' },
        state: source.kind === 'licensed_data' && source.connected ? 'connected' : 'requires_credentials',
        requires: clientSafeRequirements(['LEAD_DATA_PROVIDER', 'LEAD_DATA_API_URL', 'LEAD_DATA_API_KEY']),

        providerName: source.kind === 'licensed_data' ? source.provider : null,
      },
      {
        provider: 'manual_research',
        kind: 'manual_research',
        label: { ar: 'إدخال يدوي موثّق من فريقك', en: 'Documented manual entry by your team' },
        state: 'connected',
        requires: ['مصدر عام لكل عميل + سبب الترشيح', 'Public source link and reason per lead'],
        providerName: null,
      },
    ],
    channels: channelRegistry(c.env, settings).map((channel) => ({
      ...channel,
      requires: clientSafeRequirements(channel.requires),
    })),
    stats: {
      leads: Number(counts?.total ?? 0),
      qualified: Number(counts?.qualified ?? 0),
      consented: Number(counts?.consented ?? 0),
      doNotContact: Number(counts?.dnc ?? 0),
      potential: Number(counts?.potential ?? 0),
      confirmed: Number(counts?.confirmed ?? 0),
      campaigns: Number(campaignCount?.total ?? 0),
      sent: Number(messageStats?.sent ?? 0),
      failed: Number(messageStats?.failed ?? 0),
    },
    canManage: can(c.get('role'), MANAGE),
  });
});

// ---------------------------------------------------------------------------
// Ideal customer profile
// ---------------------------------------------------------------------------

app.put('/:companyId/growth/icp', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const timestamp = nowIso();
  const values = {
    services: jsonArray(body.services),
    sectors: jsonArray(body.sectors),
    cities: jsonArray(body.cities),
    countries: jsonArray(body.countries),
    keywords: jsonArray(body.keywords),
    problems: jsonArray(body.problems),
    idealAudience: str(body.idealAudience, 600),
    offer: str(body.offer, 600),
  };

  const existing = await first<any>(c.env, 'SELECT company_id FROM company_icp WHERE company_id = ?', company.id);
  if (existing) {
    await run(
      c.env,
      `UPDATE company_icp SET services_json = ?, sectors_json = ?, cities_json = ?, countries_json = ?,
         keywords_json = ?, problems_json = ?, ideal_audience = ?, offer = ?, updated_by = ?, updated_at = ?
       WHERE company_id = ?`,
      JSON.stringify(values.services),
      JSON.stringify(values.sectors),
      JSON.stringify(values.cities),
      JSON.stringify(values.countries),
      JSON.stringify(values.keywords),
      JSON.stringify(values.problems),
      values.idealAudience,
      values.offer,
      actor.id,
      timestamp,
      company.id
    );
  } else {
    await run(
      c.env,
      `INSERT INTO company_icp (company_id, services_json, sectors_json, cities_json, countries_json,
         keywords_json, problems_json, ideal_audience, offer, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      company.id,
      JSON.stringify(values.services),
      JSON.stringify(values.sectors),
      JSON.stringify(values.cities),
      JSON.stringify(values.countries),
      JSON.stringify(values.keywords),
      JSON.stringify(values.problems),
      values.idealAudience,
      values.offer,
      actor.id,
      timestamp,
      timestamp
    );
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'icp.updated',
    entityType: 'company_icp',
    entityId: company.id,
    meta: { sectors: values.sectors.length, cities: values.cities.length },
  });

  return c.json({ icp: await loadIcp(c.env, company.id) });
});

app.post('/:companyId/growth/icp/derive', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const analysis = await approvedAnalysis(c.env, company.id);
  if (!analysis) return apiError(c, 409, 'analysis_not_approved');

  const derived = deriveIcp(analysis.result_json);
  if (!derived) return apiError(c, 422, 'icp_not_derivable');

  const timestamp = nowIso();
  const existing = await first<any>(c.env, 'SELECT company_id FROM company_icp WHERE company_id = ?', company.id);
  const payload: any[] = [
    JSON.stringify(derived.services),
    JSON.stringify(derived.sectors),
    JSON.stringify(derived.cities),
    JSON.stringify(derived.countries),
    JSON.stringify(derived.keywords),
    JSON.stringify(derived.problems),
    derived.idealAudience,
    derived.offer,
    analysis.id,
    JSON.stringify(derived.evidence),
    actor.id,
    timestamp,
  ];
  if (existing) {
    await run(
      c.env,
      `UPDATE company_icp SET services_json = ?, sectors_json = ?, cities_json = ?, countries_json = ?,
         keywords_json = ?, problems_json = ?, ideal_audience = ?, offer = ?, analysis_id = ?,
         evidence_json = ?, updated_by = ?, updated_at = ? WHERE company_id = ?`,
      ...payload,
      company.id
    );
  } else {
    await run(
      c.env,
      `INSERT INTO company_icp (services_json, sectors_json, cities_json, countries_json, keywords_json,
         problems_json, ideal_audience, offer, analysis_id, evidence_json, updated_by, updated_at, company_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...payload,
      company.id,
      timestamp
    );
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'icp.derived',
    entityType: 'company_icp',
    entityId: company.id,
    meta: { analysisId: analysis.id, version: analysis.approved_version },
  });

  return c.json({ icp: await loadIcp(c.env, company.id) });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

type ProviderLead = {
  name?: string;
  companyName?: string;
  jobTitle?: string;
  sector?: string;
  sectorHints?: string[];
  dedupeKey?: string;
  city?: string;
  country?: string;
  email?: string;
  emailSource?: string;
  phone?: string;
  phoneSource?: string;
  website?: string;
  profileUrl?: string;
  profilePlatform?: string;
  signal?: string;
  evidence?: string;
  sourceUrl?: string;
};

app.post('/:companyId/growth/discover', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const source = leadDataSource(c.env);
  if (!source.connected) return apiError(c, 409, 'lead_source_not_connected');

  const analysis = await approvedAnalysis(c.env, company.id);
  if (!analysis) return apiError(c, 409, 'analysis_not_approved');

  const icp = await loadIcp(c.env, company.id);
  const body = await readJson<{ limit?: number }>(c);
  const limit = Math.max(1, Math.min(50, Number(body.limit ?? 20) || 20));

  let candidates: ProviderLead[] = [];
  let targetCity: SaudiCity | null = null;
  // Records the source returned but that did not qualify as leads.
  let discarded = 0;
  try {
    if (source.kind === 'open_data') {
      // OpenStreetMap is queried inside one Saudi metro area taken from the
      // tenant's own profile. An unsupported city is refused, never widened
      // into a country-wide query.
      targetCity = resolveSaudiCity(icp.cities[0] ?? '');
      if (!targetCity) return apiError(c, 422, 'lead_city_not_supported');

      // Overpass is a shared public service. One query per run is already the
      // limit; a short per-tenant cooldown stops a repeated click from turning
      // into repeated load. 0 disables it (used by the tests).
      const cooldown = Math.max(0, Number(c.env.LEAD_DISCOVERY_COOLDOWN_SECONDS ?? 15) || 0);
      if (cooldown > 0) {
        const lastRun = await first<any>(
          c.env,
          "SELECT last_run_at FROM lead_sources WHERE company_id = ? AND provider = 'openstreetmap'",
          company.id
        );
        const elapsed = lastRun?.last_run_at
          ? Date.now() - Date.parse(lastRun.last_run_at)
          : Number.POSITIVE_INFINITY;
        if (Number.isFinite(elapsed) && elapsed < cooldown * 1000) {
          return apiError(c, 429, 'lead_source_cooldown', {
            retryAfterSeconds: Math.ceil((cooldown * 1000 - elapsed) / 1000),
          });
        }
      }

      const result = await discoverOpenDataLeads({ endpoint: source.endpoint, city: targetCity, limit });
      candidates = result.leads;
      discarded = result.skipped;
    } else {
      const response = await fetch(str(c.env.LEAD_DATA_API_URL, 400), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${str(c.env.LEAD_DATA_API_KEY, 400)}`,
        },
        body: JSON.stringify({
          provider: source.provider,
          limit,
          icp: {
            services: icp.services,
            sectors: icp.sectors,
            cities: icp.cities,
            keywords: icp.keywords,
            idealAudience: icp.idealAudience,
          },
        }),
      });
      if (!response.ok) throw new LeadSourceError('lead_source_failed', `status_${response.status}`);
      const payload: any = await response.json();
      candidates = Array.isArray(payload?.leads) ? payload.leads : [];
    }
  } catch (error) {
    const failure = error instanceof LeadSourceError ? error.code : 'lead_source_failed';
    const status = failure === 'lead_source_busy' ? 503 : failure === 'lead_source_timeout' ? 504 : 502;
    await run(
      c.env,
      `INSERT INTO lead_sources (id, company_id, provider, kind, label, status, credential_ref, last_run_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, provider) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      newId('src'),
      company.id,
      source.provider ?? 'licensed_data',
      source.tableKind,
      source.label,
      // OpenStreetMap stays configured when a query fails; it is the request
      // that failed, not the connection.
      source.kind === 'open_data' ? 'connected' : 'not_connected',
      source.credentialRef,
      nowIso(),
      str((error as Error)?.message ?? failure, 200),
      nowIso(),
      nowIso()
    );
    return apiError(c, status, failure);
  }

  let inserted = 0;
  let skipped = discarded;
  const timestamp = nowIso();

  for (const candidate of candidates.slice(0, limit)) {
    const evidence = str(candidate.evidence, 600);
    const sourceUrl = str(candidate.sourceUrl, 800);
    const signal = str(candidate.signal, 40) as Signal;
    const companyName = str(candidate.companyName, 200);
    const name = str(candidate.name, 200);

    // A record without a reviewable public source, a reason and a known signal
    // is not a lead — it is dropped instead of being padded with guesses.
    if ((!companyName && !name) || !evidence || !isHttpUrl(sourceUrl) || !SIGNALS.includes(signal)) {
      skipped += 1;
      continue;
    }
    const email = str(candidate.email, 200).toLowerCase();
    const phone = str(candidate.phone, 40);
    const emailSource = email ? str(candidate.emailSource, 40) : '';
    const phoneSource = phone ? str(candidate.phoneSource, 40) : '';
    if (email && !['public_page', 'licensed_provider'].includes(emailSource)) {
      skipped += 1;
      continue;
    }
    if (phone && !['public_page', 'licensed_provider'].includes(phoneSource)) {
      skipped += 1;
      continue;
    }

    const scored = scoreLead(
      {
        signal,
        sector: str(candidate.sector, 120),
        sectorHints: Array.isArray(candidate.sectorHints)
          ? candidate.sectorHints.map((hint) => str(hint, 80)).filter(Boolean).slice(0, 12)
          : undefined,
        city: str(candidate.city, 120),
        email: email || null,
        phone: phone || null,
      },
      icp
    );
    // An open-data record keeps the identity of its element, so the same
    // company is never inserted twice by repeated runs.
    const dedupe =
      str(candidate.dedupeKey, 200) ||
      leadDedupeKey({
        email: email || null,
        website: str(candidate.website, 400) || null,
        companyName: companyName || null,
        name: name || null,
        city: str(candidate.city, 120) || null,
      });

    const result = await run(
      c.env,
      `INSERT INTO leads (id, company_id, name, company_name, job_title, sector, city, country, email, email_source,
         phone, phone_source, website, profile_url, profile_platform, source_kind, source_provider, source_url,
         evidence_text, evidence_checked_at, interest_signal, score, score_reason_json, stage, consent_state,
         do_not_contact, discovered_at, created_by, created_at, updated_at, dedupe_key, classification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'licensed_provider', ?, ?, ?, ?, ?, ?, ?, 'new', 'unknown', 0, ?, ?, ?, ?, ?, 'potential')
       ON CONFLICT(company_id, dedupe_key) DO NOTHING`,
      newId('lead'),
      company.id,
      name || null,
      companyName || null,
      str(candidate.jobTitle, 120) || null,
      str(candidate.sector, 120) || null,
      str(candidate.city, 120) || null,
      str(candidate.country, 120) || null,
      email || null,
      email ? emailSource : null,
      phone || null,
      phone ? phoneSource : null,
      str(candidate.website, 400) || null,
      str(candidate.profileUrl, 400) || null,
      str(candidate.profilePlatform, 60) || null,
      source.provider,
      sourceUrl,
      evidence,
      timestamp,
      signal,
      scored.score,
      JSON.stringify(scored.reasons),
      timestamp,
      actor.id,
      timestamp,
      timestamp,
      dedupe
    );
    if ((result as any)?.meta?.changes) inserted += 1;
    else skipped += 1;
  }

  await run(
    c.env,
    `INSERT INTO lead_sources (id, company_id, provider, kind, label, status, credential_ref, last_run_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, NULL, ?, ?)
     ON CONFLICT(company_id, provider) DO UPDATE SET status = 'connected', last_run_at = excluded.last_run_at, last_error = NULL, updated_at = excluded.updated_at`,
    newId('src'),
    company.id,
    source.provider ?? 'licensed_data',
    source.tableKind,
    source.label,
    source.credentialRef,
    timestamp,
    timestamp,
    timestamp
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'lead.discovered',
    entityType: 'lead',
    entityId: company.id,
    meta: { provider: source.provider, inserted, skipped },
  });

  return c.json({ inserted, skipped, provider: source.provider, city: targetCity?.ar ?? null });
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

app.get('/:companyId/growth/leads', async (c) => {
  const company = c.get('company');
  const stage = str(c.req.query('stage'), 30);
  const search = str(c.req.query('q'), 120);
  const conditions = ['company_id = ?'];
  const params: any[] = [company.id];
  if (stage && STAGES.includes(stage as any)) {
    conditions.push('stage = ?');
    params.push(stage);
  }
  if (search) {
    conditions.push('(COALESCE(name, "") LIKE ? OR COALESCE(company_name, "") LIKE ? OR COALESCE(email, "") LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const rows = await all<any>(
    c.env,
    `SELECT * FROM leads WHERE ${conditions.join(' AND ')} ORDER BY score DESC, discovered_at DESC LIMIT 200`,
    ...params
  );
  return c.json({ leads: rows.map(serializeLead) });
});

app.post('/:companyId/growth/leads', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const body = await readJson<Record<string, unknown>>(c);
  const name = str(body.name, 200);
  const companyName = str(body.companyName, 200);
  const sourceUrl = str(body.sourceUrl, 800);
  const evidenceText = str(body.evidenceText, 800);
  const signal = str(body.interestSignal, 40) as Signal;

  if (!name && !companyName) return apiError(c, 422, 'lead_name_required');
  if (!isHttpUrl(sourceUrl)) return apiError(c, 422, 'lead_source_url_required');
  if (!evidenceText) return apiError(c, 422, 'lead_evidence_required');
  if (!SIGNALS.includes(signal)) return apiError(c, 422, 'lead_signal_required');

  const email = str(body.email, 200).toLowerCase();
  const phone = str(body.phone, 40);
  const emailSource = str(body.emailSource, 40);
  const phoneSource = str(body.phoneSource, 40);
  if (email && !['public_page', 'customer_provided', 'licensed_provider'].includes(emailSource)) {
    return apiError(c, 422, 'contact_source_required');
  }
  if (phone && !['public_page', 'customer_provided', 'licensed_provider'].includes(phoneSource)) {
    return apiError(c, 422, 'contact_source_required');
  }

  const icp = await loadIcp(c.env, company.id);
  const consentState = CONSENT_STATES.includes(str(body.consentState, 20) as any)
    ? (str(body.consentState, 20) as string)
    : 'unknown';
  const scored = scoreLead(
    { signal, sector: str(body.sector, 120), city: str(body.city, 120), email: email || null, phone: phone || null, consentState },
    icp
  );
  const dedupe = leadDedupeKey({
    email: email || null,
    website: str(body.website, 400) || null,
    companyName: companyName || null,
    name: name || null,
    city: str(body.city, 120) || null,
  });
  const timestamp = nowIso();
  const id = newId('lead');

  try {
    await run(
      c.env,
      `INSERT INTO leads (id, company_id, campaign_id, name, company_name, job_title, sector, city, country,
         email, email_source, phone, phone_source, website, profile_url, profile_platform, source_kind, source_provider,
         source_url, evidence_text, evidence_checked_at, interest_signal, score, score_reason_json, stage,
         consent_state, consent_at, do_not_contact, owner_user_id, discovered_at, created_by, created_at, updated_at,
         dedupe_key, classification)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual_research', ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      company.id,
      str(body.campaignId, 60) || null,
      name || null,
      companyName || null,
      str(body.jobTitle, 120) || null,
      str(body.sector, 120) || null,
      str(body.city, 120) || null,
      str(body.country, 120) || null,
      email || null,
      email ? emailSource : null,
      phone || null,
      phone ? phoneSource : null,
      str(body.website, 400) || null,
      str(body.profileUrl, 400) || null,
      str(body.profilePlatform, 60) || null,
      str(body.sourceProvider, 120) || null,
      sourceUrl,
      evidenceText,
      timestamp,
      signal,
      scored.score,
      JSON.stringify(scored.reasons),
      consentState,
      consentState === 'granted' ? timestamp : null,
      actor.id,
      timestamp,
      actor.id,
      timestamp,
      timestamp,
      dedupe,
      // Discovered or hand-entered, it is unverified until a person reviews it.
      'potential'
    );
  } catch (error) {
    if (String((error as Error)?.message ?? '').includes('UNIQUE')) {
      return apiError(c, 409, 'duplicate_lead');
    }
    throw error;
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'lead.created',
    entityType: 'lead',
    entityId: id,
    meta: { signal, sourceUrl },
  });

  const row = await first<any>(c.env, 'SELECT * FROM leads WHERE id = ? AND company_id = ?', id, company.id);
  return c.json({ lead: serializeLead(row) }, 201);
});

app.patch('/:companyId/growth/leads/:leadId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const lead = await first<any>(
    c.env,
    'SELECT * FROM leads WHERE id = ? AND company_id = ?',
    c.req.param('leadId'),
    company.id
  );
  if (!lead) return apiError(c, 404, 'lead_not_found');

  const body = await readJson<Record<string, unknown>>(c);
  const updates: string[] = [];
  const params: any[] = [];
  const timestamp = nowIso();

  const stage = str(body.stage, 20);
  if (stage) {
    if (!STAGES.includes(stage as any)) return apiError(c, 422, 'invalid_stage');
    updates.push('stage = ?');
    params.push(stage);
    // A human moving the record out of `new` is the only way a lead stops
    // being "potential"; discovery never confirms a company on its own.
    if (stage !== 'new' && lead.classification !== 'confirmed') {
      updates.push('classification = ?');
      params.push('confirmed');
    }
    await run(
      c.env,
      'INSERT INTO lead_activities (id, company_id, lead_id, kind, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('act'),
      company.id,
      lead.id,
      'stage_change',
      `${lead.stage} → ${stage}`,
      actor.id,
      timestamp
    );
  }

  const consentState = str(body.consentState, 20);
  if (consentState) {
    if (!CONSENT_STATES.includes(consentState as any)) return apiError(c, 422, 'invalid_consent_state');
    updates.push('consent_state = ?', 'consent_at = ?');
    params.push(consentState, consentState === 'granted' ? timestamp : null);
    if (consentState === 'granted' && lead.classification !== 'confirmed') {
      updates.push('classification = ?');
      params.push('confirmed');
    }
    await run(
      c.env,
      'INSERT INTO lead_activities (id, company_id, lead_id, kind, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId('act'),
      company.id,
      lead.id,
      'consent',
      consentState,
      actor.id,
      timestamp
    );
  }

  if (body.doNotContact !== undefined) {
    const dnc = body.doNotContact === true || body.doNotContact === 1 ? 1 : 0;
    updates.push('do_not_contact = ?');
    params.push(dnc);
    if (dnc && lead.email) {
      await run(
        c.env,
        `INSERT INTO suppressions (id, company_id, channel, address, reason, created_by, created_at)
         VALUES (?, ?, 'email', ?, 'do_not_contact', ?, ?)
         ON CONFLICT(company_id, channel, address) DO NOTHING`,
        newId('sup'),
        company.id,
        String(lead.email).toLowerCase(),
        actor.id,
        timestamp
      );
    }
  }

  if (body.campaignId !== undefined) {
    const campaignId = str(body.campaignId, 60) || null;
    if (campaignId) {
      const campaign = await first<any>(
        c.env,
        'SELECT id FROM campaigns WHERE id = ? AND company_id = ?',
        campaignId,
        company.id
      );
      if (!campaign) return apiError(c, 422, 'campaign_not_found');
    }
    updates.push('campaign_id = ?');
    params.push(campaignId);
  }

  if (!updates.length) return apiError(c, 422, 'no_changes');

  await run(
    c.env,
    `UPDATE leads SET ${updates.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`,
    ...params,
    timestamp,
    lead.id,
    company.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'lead.updated',
    entityType: 'lead',
    entityId: lead.id,
    meta: body,
  });

  const row = await first<any>(c.env, 'SELECT * FROM leads WHERE id = ? AND company_id = ?', lead.id, company.id);
  return c.json({ lead: serializeLead(row) });
});

app.get('/:companyId/growth/leads/:leadId/activities', async (c) => {
  const company = c.get('company');
  const rows = await all<any>(
    c.env,
    `SELECT * FROM lead_activities WHERE lead_id = ? AND company_id = ? ORDER BY created_at DESC LIMIT 100`,
    c.req.param('leadId'),
    company.id
  );
  return c.json({
    activities: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      note: row.note,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    })),
  });
});

app.post('/:companyId/growth/leads/:leadId/activities', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const lead = await first<any>(
    c.env,
    'SELECT id FROM leads WHERE id = ? AND company_id = ?',
    c.req.param('leadId'),
    company.id
  );
  if (!lead) return apiError(c, 404, 'lead_not_found');

  const body = await readJson<Record<string, unknown>>(c);
  const kind = str(body.kind, 20) || 'note';
  const note = str(body.note, 1000);
  if (!['note', 'email', 'call', 'whatsapp', 'meeting', 'proposal'].includes(kind)) {
    return apiError(c, 422, 'invalid_activity_kind');
  }
  if (!note) return apiError(c, 422, 'note_required');

  const id = newId('act');
  const timestamp = nowIso();
  await run(
    c.env,
    'INSERT INTO lead_activities (id, company_id, lead_id, kind, note, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    company.id,
    lead.id,
    kind,
    note,
    actor.id,
    timestamp
  );
  return c.json({ activity: { id, kind, note, actorUserId: actor.id, createdAt: timestamp } }, 201);
});

// ---------------------------------------------------------------------------
// Suppression list
// ---------------------------------------------------------------------------

app.get('/:companyId/growth/suppressions', async (c) => {
  const company = c.get('company');
  const rows = await all<any>(
    c.env,
    'SELECT * FROM suppressions WHERE company_id = ? ORDER BY created_at DESC LIMIT 200',
    company.id
  );
  return c.json({
    suppressions: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      address: row.address,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  });
});

app.post('/:companyId/growth/suppressions', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const channel = str(body.channel, 20) || 'all';
  const address = str(body.address, 300).toLowerCase();
  if (!['email', 'whatsapp', 'all'].includes(channel)) return apiError(c, 422, 'invalid_channel');
  if (!address) return apiError(c, 422, 'address_required');

  await run(
    c.env,
    `INSERT INTO suppressions (id, company_id, channel, address, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company_id, channel, address) DO NOTHING`,
    newId('sup'),
    company.id,
    channel,
    address,
    str(body.reason, 300) || 'unsubscribe',
    actor.id,
    nowIso()
  );

  return c.json({ ok: true }, 201);
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

app.get('/:companyId/growth/campaigns', async (c) => {
  const company = c.get('company');
  const rows = await all<any>(
    c.env,
    'SELECT * FROM campaigns WHERE company_id = ? ORDER BY created_at DESC LIMIT 100',
    company.id
  );
  return c.json({ campaigns: rows.map(serializeCampaign) });
});

app.post('/:companyId/growth/campaigns', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const body = await readJson<Record<string, unknown>>(c);
  const name = str(body.name, 160);
  const channel = str(body.channel, 20) as Channel;
  if (!name) return apiError(c, 422, 'campaign_name_required');
  if (!CHANNELS.includes(channel)) return apiError(c, 422, 'invalid_channel');

  const registry = channelRegistry(c.env, settings);
  const channelInfo = registry.find((item) => item.channel === channel);
  const id = newId('cmp');
  const timestamp = nowIso();

  await run(
    c.env,
    `INSERT INTO campaigns (id, company_id, name, objective, audience, sector, city, channel, status,
       content_ref, content_approved, budget_sar, starts_on, ends_on, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    id,
    company.id,
    name,
    str(body.objective, 400) || null,
    str(body.audience, 400) || null,
    str(body.sector, 120) || null,
    str(body.city, 120) || null,
    channel,
    channelInfo?.state === 'connected' ? 'draft' : 'awaiting_channel',
    str(body.contentRef, 300) || null,
    Number(body.budgetSar) > 0 ? Math.round(Number(body.budgetSar)) : null,
    str(body.startsOn, 20) || null,
    str(body.endsOn, 20) || null,
    actor.id,
    timestamp,
    timestamp
  );

  await run(
    c.env,
    `INSERT INTO campaign_channels (id, company_id, campaign_id, channel, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newId('chc'),
    company.id,
    id,
    channel,
    channelInfo?.state ?? 'requires_credentials',
    timestamp
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: id,
    meta: { channel, channelState: channelInfo?.state },
  });

  const row = await first<any>(c.env, 'SELECT * FROM campaigns WHERE id = ? AND company_id = ?', id, company.id);
  return c.json({ campaign: serializeCampaign(row), channel: channelInfo ?? null }, 201);
});

app.patch('/:companyId/growth/campaigns/:campaignId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const campaign = await first<any>(
    c.env,
    'SELECT * FROM campaigns WHERE id = ? AND company_id = ?',
    c.req.param('campaignId'),
    company.id
  );
  if (!campaign) return apiError(c, 404, 'campaign_not_found');

  const body = await readJson<Record<string, unknown>>(c);
  const updates: string[] = [];
  const params: any[] = [];
  const timestamp = nowIso();

  if (body.name !== undefined) {
    const name = str(body.name, 160);
    if (!name) return apiError(c, 422, 'campaign_name_required');
    updates.push('name = ?');
    params.push(name);
  }
  if (body.objective !== undefined) {
    updates.push('objective = ?');
    params.push(str(body.objective, 400) || null);
  }
  if (body.audience !== undefined) {
    updates.push('audience = ?');
    params.push(str(body.audience, 400) || null);
  }
  if (body.sector !== undefined) {
    updates.push('sector = ?');
    params.push(str(body.sector, 120) || null);
  }
  if (body.city !== undefined) {
    updates.push('city = ?');
    params.push(str(body.city, 120) || null);
  }
  if (body.contentRef !== undefined) {
    updates.push('content_ref = ?', 'content_approved = 0');
    params.push(str(body.contentRef, 300) || null);
  }
  if (body.contentApproved !== undefined) {
    const approved = body.contentApproved === true || body.contentApproved === 1;
    if (approved && !campaign.content_ref) return apiError(c, 422, 'content_ref_required');
    updates.push('content_approved = ?', 'approved_by = ?', 'approved_at = ?');
    params.push(approved ? 1 : 0, approved ? actor.id : null, approved ? timestamp : null);
  }
  if (body.budgetSar !== undefined) {
    updates.push('budget_sar = ?');
    params.push(Number(body.budgetSar) > 0 ? Math.round(Number(body.budgetSar)) : null);
  }
  if (body.status !== undefined) {
    const status = str(body.status, 30);
    const allowed = ['draft', 'awaiting_channel', 'ready', 'running', 'paused', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return apiError(c, 422, 'invalid_status');
    updates.push('status = ?');
    params.push(status);
  }

  if (!updates.length) return apiError(c, 422, 'no_changes');
  await run(
    c.env,
    `UPDATE campaigns SET ${updates.join(', ')}, updated_at = ? WHERE id = ? AND company_id = ?`,
    ...params,
    timestamp,
    campaign.id,
    company.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: campaign.id,
    meta: body,
  });

  const row = await first<any>(c.env, 'SELECT * FROM campaigns WHERE id = ? AND company_id = ?', campaign.id, company.id);
  return c.json({ campaign: serializeCampaign(row) });
});

type Blocker = { code: string; count?: number };

async function preflight(env: any, company: any, campaign: any, settings: Record<string, string>) {
  const registry = channelRegistry(env, settings);
  const info = registry.find((item) => item.channel === campaign.channel);
  const blockers: Blocker[] = [];

  if (!info || info.state !== 'connected') blockers.push({ code: 'channel_not_connected' });
  if (!campaign.content_ref) blockers.push({ code: 'content_ref_required' });
  else if (!campaign.content_approved) blockers.push({ code: 'content_not_approved' });

  const audience = await all<any>(
    env,
    `SELECT id, email, phone, consent_state, do_not_contact FROM leads
      WHERE company_id = ? AND campaign_id = ? AND do_not_contact = 0`,
    company.id,
    campaign.id
  );
  const suppressed = await all<any>(
    env,
    `SELECT address FROM suppressions WHERE company_id = ? AND channel IN (?, 'all')`,
    company.id,
    campaign.channel === 'email' || campaign.channel === 'whatsapp' ? campaign.channel : 'email'
  );
  const suppressedSet = new Set(suppressed.map((row) => String(row.address).toLowerCase()));

  let eligible = 0;
  let missingContact = 0;
  let missingConsent = 0;
  let suppressedCount = 0;
  let dncCount = 0;

  for (const lead of audience) {
    const address = campaign.channel === 'email' ? lead.email : lead.phone;
    if (!address) {
      missingContact += 1;
      continue;
    }
    if (suppressedSet.has(String(address).toLowerCase())) {
      suppressedCount += 1;
      continue;
    }
    if (['email', 'whatsapp'].includes(campaign.channel) && lead.consent_state !== 'granted') {
      missingConsent += 1;
      continue;
    }
    eligible += 1;
  }

  const excluded = await first<any>(
    env,
    'SELECT COUNT(*) AS total FROM leads WHERE company_id = ? AND campaign_id = ? AND do_not_contact = 1',
    company.id,
    campaign.id
  );
  dncCount = Number(excluded?.total ?? 0);

  if (dncCount) blockers.push({ code: 'do_not_contact_excluded', count: dncCount });
  if (suppressedCount) blockers.push({ code: 'suppressed_excluded', count: suppressedCount });
  if (missingConsent) blockers.push({ code: 'consent_missing', count: missingConsent });
  if (missingContact) blockers.push({ code: 'contact_missing', count: missingContact });
  if (!eligible) blockers.push({ code: 'audience_empty' });
  if (info && info.state === 'connected' && !info.canSendFromThisBuild) {
    blockers.push({ code: 'channel_adapter_unavailable' });
  }

  return {
    ready: blockers.length === 0,
    blockers,
    eligible,
    info: info ?? null,
  };
}

app.post('/:companyId/growth/campaigns/:campaignId/preflight', async (c) => {
  const company = c.get('company');
  const campaign = await first<any>(
    c.env,
    'SELECT * FROM campaigns WHERE id = ? AND company_id = ?',
    c.req.param('campaignId'),
    company.id
  );
  if (!campaign) return apiError(c, 404, 'campaign_not_found');
  const settings = await getSettings(c.env);
  const result = await preflight(c.env, company, campaign, settings);
  return c.json({
    ready: result.ready,
    blockers: result.blockers,
    eligible: result.eligible,
    channel: result.info
      ? { ...result.info, requires: clientSafeRequirements(result.info.requires) }
      : null,
  });
});

app.post('/:companyId/growth/campaigns/:campaignId/launch', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const campaign = await first<any>(
    c.env,
    'SELECT * FROM campaigns WHERE id = ? AND company_id = ?',
    c.req.param('campaignId'),
    company.id
  );
  if (!campaign) return apiError(c, 404, 'campaign_not_found');

  const settings = await getSettings(c.env);
  const check = await preflight(c.env, company, campaign, settings);
  if (!check.ready) {
    await audit(c.env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId: company.id,
      action: 'campaign.launch_blocked',
      entityType: 'campaign',
      entityId: campaign.id,
      meta: { blockers: check.blockers },
    });
    return c.json({ error: { code: 'campaign_not_ready', blockers: check.blockers } }, 409);
  }

  const rows = await all<any>(
    c.env,
    `SELECT id, email, phone FROM leads
      WHERE company_id = ? AND campaign_id = ? AND do_not_contact = 0
        AND consent_state = 'granted' AND ${campaign.channel === 'email' ? 'email' : 'phone'} IS NOT NULL`,
    company.id,
    campaign.id
  );

  const timestamp = nowIso();
  const body = str(campaign.content_ref, 600);
  let sent = 0;
  let failed = 0;

  for (const lead of rows) {
    const to = campaign.channel === 'email' ? lead.email : lead.phone;
    const messageId = newId('msg');
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${str(c.env.EMAIL_API_KEY, 400)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: str(c.env.EMAIL_FROM, 200),
          to,
          subject: campaign.name,
          text: body,
        }),
      });
      if (!response.ok) throw new Error(`status_${response.status}`);
      sent += 1;
      await run(
        c.env,
        `INSERT INTO outreach_messages (id, company_id, campaign_id, lead_id, channel, to_address, subject, body,
           status, provider, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)`,
        messageId,
        company.id,
        campaign.id,
        lead.id,
        campaign.channel,
        to,
        campaign.name,
        body,
        `email:${str(c.env.EMAIL_PROVIDER, 40) || 'resend'}`,
        timestamp,
        nowIso()
      );
    } catch (error) {
      failed += 1;
      await run(
        c.env,
        `INSERT INTO outreach_messages (id, company_id, campaign_id, lead_id, channel, to_address, subject, body,
           status, provider, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
        messageId,
        company.id,
        campaign.id,
        lead.id,
        campaign.channel,
        to,
        campaign.name,
        body,
        `email:${str(c.env.EMAIL_PROVIDER, 40) || 'resend'}`,
        'email_send_failed',
        timestamp
      );
    }
  }

  await run(
    c.env,
    `UPDATE campaigns SET status = 'running', updated_at = ? WHERE id = ? AND company_id = ?`,
    timestamp,
    campaign.id,
    company.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'campaign.launched',
    entityType: 'campaign',
    entityId: campaign.id,
    meta: { sent, failed, channel: campaign.channel },
  });

  return c.json({ sent, failed });
});

// ---------------------------------------------------------------------------
// Results and conversions
// ---------------------------------------------------------------------------

app.get('/:companyId/growth/metrics', async (c) => {
  const company = c.get('company');
  const campaignId = str(c.req.query('campaignId'), 60);
  const rows = await all<any>(
    c.env,
    campaignId
      ? 'SELECT * FROM campaign_metrics WHERE company_id = ? AND campaign_id = ? ORDER BY period_date DESC'
      : 'SELECT * FROM campaign_metrics WHERE company_id = ? ORDER BY period_date DESC LIMIT 200',
    ...(campaignId ? [company.id, campaignId] : [company.id])
  );
  const totals = rows.reduce(
    (acc, row) => ({
      impressions: acc.impressions + row.impressions,
      engagements: acc.engagements + row.engagements,
      replies: acc.replies + row.replies,
      leads: acc.leads + row.leads_count,
      meetings: acc.meetings + row.meetings,
      proposals: acc.proposals + row.proposals,
      won: acc.won + row.won,
      revenue: acc.revenue + row.revenue_sar,
      spend: acc.spend + row.spend_sar,
    }),
    { impressions: 0, engagements: 0, replies: 0, leads: 0, meetings: 0, proposals: 0, won: 0, revenue: 0, spend: 0 }
  );

  return c.json({
    metrics: rows.map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      periodDate: row.period_date,
      impressions: row.impressions,
      engagements: row.engagements,
      replies: row.replies,
      leads: row.leads_count,
      meetings: row.meetings,
      proposals: row.proposals,
      won: row.won,
      revenueSar: row.revenue_sar,
      spendSar: row.spend_sar,
      source: row.source,
      note: row.note,
      createdAt: row.created_at,
    })),
    totals: {
      ...totals,
      // Derived only when the client actually entered the numbers behind them.
      costPerLead: totals.leads > 0 && totals.spend > 0 ? Math.round(totals.spend / totals.leads) : null,
      roas: totals.spend > 0 && totals.revenue > 0 ? Number((totals.revenue / totals.spend).toFixed(2)) : null,
      roi:
        totals.spend > 0 && totals.revenue > 0
          ? Number((((totals.revenue - totals.spend) / totals.spend) * 100).toFixed(1))
          : null,
    },
  });
});

app.post('/:companyId/growth/metrics', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const campaignId = str(body.campaignId, 60);
  if (!campaignId) return apiError(c, 422, 'campaign_required');
  const campaign = await first<any>(
    c.env,
    'SELECT id FROM campaigns WHERE id = ? AND company_id = ?',
    campaignId,
    company.id
  );
  if (!campaign) return apiError(c, 422, 'campaign_not_found');

  const periodDate = str(body.periodDate, 20) || nowIso().slice(0, 10);
  const number = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));

  await run(
    c.env,
    `INSERT INTO campaign_metrics (id, company_id, campaign_id, period_date, impressions, engagements, replies,
       leads_count, meetings, proposals, won, revenue_sar, spend_sar, source, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)
     ON CONFLICT(campaign_id, period_date) DO UPDATE SET
       impressions = excluded.impressions, engagements = excluded.engagements, replies = excluded.replies,
       leads_count = excluded.leads_count, meetings = excluded.meetings, proposals = excluded.proposals,
       won = excluded.won, revenue_sar = excluded.revenue_sar, spend_sar = excluded.spend_sar,
       note = excluded.note`,
    newId('met'),
    company.id,
    campaignId,
    periodDate,
    number(body.impressions),
    number(body.engagements),
    number(body.replies),
    number(body.leads),
    number(body.meetings),
    number(body.proposals),
    number(body.won),
    number(body.revenueSar),
    number(body.spendSar),
    str(body.note, 400) || null,
    actor.id,
    nowIso()
  );

  return c.json({ ok: true }, 201);
});

export default app;
