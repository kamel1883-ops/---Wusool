/**
 * First-party tracking: UTM links, click redirects and on-site events.
 *
 * Nothing here depends on an external analytics vendor. A link code is random
 * and public; it resolves to one stored destination for one company, and the
 * redirect only ever appends the UTMs recorded on that row. Events keep a
 * salted hash of the visitor instead of an IP or a user agent, so a report can
 * count unique visitors without being able to identify one.
 */
import { all, first, newId, nowIso, randomHex, run, type Env } from './db';

export const EVENT_KINDS = [
  'click',
  'page_view',
  'whatsapp_click',
  'call_click',
  'form_submit',
  'lead',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const isEventKind = (value: unknown): value is EventKind =>
  typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

export const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const newLinkCode = () => randomHex(5);

const trackingSalt = (env: Env) =>
  String((env as any).TRACKING_SALT ?? (env as any).SOCIAL_TOKEN_KEY ?? 'wusool-first-party');

/** Salted, truncated hash. The raw address and user agent are never stored. */
export async function visitorHash(env: Env, input: { ip: string; userAgent: string; companyId: string }) {
  const data = `${input.companyId}|${input.ip}|${input.userAgent}|${trackingSalt(env)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 40);
}

export function destinationWithUtm(row: any): string {
  const url = new URL(String(row.destination_url));
  for (const key of UTM_KEYS) {
    const value = row[key];
    if (value) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export const periodDateOf = (date = new Date()) => date.toISOString().slice(0, 10);

/** Coarse device class only — never a fingerprint. */
export function deviceOf(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'tablet';
  if (/mobi|android|iphone/.test(ua)) return 'mobile';
  if (!ua) return 'unknown';
  return 'desktop';
}

export async function recordEvent(
  env: Env,
  input: {
    companyId: string;
    linkId: string | null;
    leadId?: string | null;
    kind: EventKind;
    platform?: string | null;
    postId?: string | null;
    campaignId?: string | null;
    ip: string;
    userAgent: string;
    country?: string | null;
    referrerHost?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  const occurredAt = nowIso();
  await run(
    env,
    `INSERT INTO tracking_events (id, company_id, link_id, lead_id, post_id, campaign_id, kind, platform,
       occurred_at, period_date, visitor_hash, country, device, referrer_host, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('tev'),
    input.companyId,
    input.linkId,
    input.leadId ?? null,
    input.postId ?? null,
    input.campaignId ?? null,
    input.kind,
    input.platform ?? null,
    occurredAt,
    periodDateOf(new Date(occurredAt)),
    await visitorHash(env, {
      ip: input.ip,
      userAgent: input.userAgent,
      companyId: input.companyId,
    }),
    input.country ?? null,
    deviceOf(input.userAgent),
    input.referrerHost ?? null,
    JSON.stringify(input.metadata ?? {}),
    occurredAt
  );
  return occurredAt;
}

/**
 * A public beacon is unauthenticated by nature, so it is capped per visitor
 * and link: beyond that the event is dropped instead of inflating a report.
 */
export async function withinBeaconLimit(
  env: Env,
  input: { companyId: string; linkId: string; ip: string; userAgent: string }
) {
  const hash = await visitorHash(env, input);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await first<{ total: number }>(
    env,
    `SELECT COUNT(*) AS total FROM tracking_events
      WHERE company_id = ? AND link_id = ? AND visitor_hash = ? AND occurred_at >= ?`,
    input.companyId,
    input.linkId,
    hash,
    since
  );
  return Number(row?.total ?? 0) < 120;
}

export type TrackingTotals = {
  clicks: number;
  pageViews: number;
  whatsappClicks: number;
  callClicks: number;
  formSubmits: number;
  leads: number;
  uniqueVisitors: number;
};

export async function totalsFor(env: Env, companyId: string, sinceDays = 30) {
  const since = periodDateOf(new Date(Date.now() - sinceDays * 86_400_000));
  const row = await first<any>(
    env,
    `SELECT
       SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
       SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS page_views,
       SUM(CASE WHEN kind = 'whatsapp_click' THEN 1 ELSE 0 END) AS whatsapp_clicks,
       SUM(CASE WHEN kind = 'call_click' THEN 1 ELSE 0 END) AS call_clicks,
       SUM(CASE WHEN kind = 'form_submit' THEN 1 ELSE 0 END) AS form_submits,
       SUM(CASE WHEN kind = 'lead' THEN 1 ELSE 0 END) AS leads,
       COUNT(DISTINCT visitor_hash) AS unique_visitors
     FROM tracking_events WHERE company_id = ? AND period_date >= ?`,
    companyId,
    since
  );
  return {
    clicks: Number(row?.clicks ?? 0),
    pageViews: Number(row?.page_views ?? 0),
    whatsappClicks: Number(row?.whatsapp_clicks ?? 0),
    callClicks: Number(row?.call_clicks ?? 0),
    formSubmits: Number(row?.form_submits ?? 0),
    leads: Number(row?.leads ?? 0),
    uniqueVisitors: Number(row?.unique_visitors ?? 0),
  } satisfies TrackingTotals;
}

/** Counts per link, so the list can show what each link actually produced. */
export async function countsByLink(env: Env, companyId: string, sinceDays = 90) {
  const since = periodDateOf(new Date(Date.now() - sinceDays * 86_400_000));
  const rows = await all<any>(
    env,
    `SELECT link_id,
       SUM(CASE WHEN kind = 'click' THEN 1 ELSE 0 END) AS clicks,
       SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS page_views,
       SUM(CASE WHEN kind = 'whatsapp_click' THEN 1 ELSE 0 END) AS whatsapp_clicks,
       SUM(CASE WHEN kind = 'call_click' THEN 1 ELSE 0 END) AS call_clicks,
       SUM(CASE WHEN kind = 'form_submit' THEN 1 ELSE 0 END) AS form_submits,
       SUM(CASE WHEN kind = 'lead' THEN 1 ELSE 0 END) AS leads
     FROM tracking_events WHERE company_id = ? AND period_date >= ? AND link_id IS NOT NULL
     GROUP BY link_id`,
    companyId,
    since
  );
  const map = new Map<string, any>();
  for (const row of rows) {
    map.set(String(row.link_id), {
      clicks: Number(row.clicks ?? 0),
      pageViews: Number(row.page_views ?? 0),
      whatsappClicks: Number(row.whatsapp_clicks ?? 0),
      callClicks: Number(row.call_clicks ?? 0),
      formSubmits: Number(row.form_submits ?? 0),
      leads: Number(row.leads ?? 0),
    });
  }
  return map;
}
