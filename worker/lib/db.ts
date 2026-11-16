/**
 * Database helpers, platform settings and domain types.
 * Every tenant-scoped query in this project is filtered by a company id that is
 * derived from the signed-in user's membership — never from request input.
 */

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV?: string;
  // Server-side provider configuration. Secrets live only in the Worker
  // environment and are never returned by an endpoint.
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_API_KEY?: string;
  AI_GATEWAY_URL?: string;
  CRAWLER_PROVIDER?: string;
  CRAWLER_ACCOUNT_ID?: string;
  CRAWLER_API_TOKEN?: string;
  // When set, /setup accepts only this address (case-insensitive) for the
  // first Super Admin. Never a real address in source — deployment secret.
  SETUP_ADMIN_EMAIL?: string;
  // Lead discovery through a licensed data provider. Without all three the
  // discovery endpoint refuses instead of returning invented records.
  LEAD_DATA_PROVIDER?: string;
  LEAD_DATA_API_URL?: string;
  LEAD_DATA_API_KEY?: string;
  // Outbound channels. Presence of credentials is not the same as permission:
  // platform settings `integration.<channel>.approved` must also be set.
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_PHONE_ID?: string;
  META_PAGE_TOKEN?: string;
  META_PAGE_ID?: string;
  META_IG_USER_ID?: string;
  LINKEDIN_TOKEN?: string;
  LINKEDIN_ORGANIZATION_ID?: string;
}

export type Row = Record<string, any>;

export const nowIso = () => new Date().toISOString();

export const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const randomHex = (bytes = 24) => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

/** Readable one-time password for accounts created by an owner/Super Admin. */
export const generateTempPassword = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('');
};

export async function all<T = Row>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = env.DB.prepare(sql);
  const bound = params.length ? stmt.bind(...(params as any[])) : stmt;
  const res = await bound.all<T>();
  return (res.results ?? []) as T[];
}

export async function first<T = Row>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const stmt = env.DB.prepare(sql);
  const bound = params.length ? stmt.bind(...(params as any[])) : stmt;
  return ((await bound.first<T>()) ?? null) as T | null;
}

export async function run(env: Env, sql: string, ...params: unknown[]) {
  const stmt = env.DB.prepare(sql);
  const bound = params.length ? stmt.bind(...(params as any[])) : stmt;
  return bound.run();
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
  const rows = await all<{ key: string; value: string }>(
    env,
    'SELECT key, value FROM platform_settings'
  );
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function setSettings(env: Env, patch: Record<string, string>) {
  for (const [key, value] of Object.entries(patch)) {
    await run(
      env,
      `INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      String(value ?? ''),
      nowIso()
    );
  }
}

export async function settingsList(env: Env) {
  const s = await getSettings(env);
  return {
    brand: {
      nameAr: s['brand.name_ar'] ?? 'وصول',
      nameEn: s['brand.name_en'] ?? 'Wusool',
      taglineAr: s['brand.tagline_ar'] ?? '',
      taglineEn: s['brand.tagline_en'] ?? '',
      primaryColor: s['brand.primary_color'] ?? '#17C6B4',
      inkColor: s['brand.ink_color'] ?? '#0E1B2D',
      // The first schema seeded `/brand/logo.jpg`, a file that never shipped;
      // map it to the bundled mark so old databases keep a visible logo.
      logoUrl:
        !s['brand.logo_url'] || s['brand.logo_url'] === '/brand/logo.jpg'
          ? '/brand/logo.svg'
          : s['brand.logo_url'],
      website: s['brand.website'] ?? '',
    },
    support: { email: s['support.email'] ?? '', whatsapp: s['support.whatsapp'] ?? '' },
    platform: {
      defaultLocale: s['platform.default_locale'] === 'en' ? 'en' : 'ar',
      supportedLocales: (s['platform.supported_locales'] ?? 'ar,en')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      setupCompleted: s['platform.setup_completed'] === '1',
      warningDays: Number(s['subscription.warning_days'] ?? '30') || 30,
    },
    raw: s,
  };
}

export type AuditEntry = {
  actorUserId?: string | null;
  actorEmail?: string | null;
  companyId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  meta?: unknown;
  ip?: string | null;
};

export async function audit(env: Env, entry: AuditEntry) {
  await run(
    env,
    `INSERT INTO audit_logs
       (id, actor_user_id, actor_email, company_id, action, entity_type, entity_id, meta, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('log'),
    entry.actorUserId ?? null,
    entry.actorEmail ?? null,
    entry.companyId ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.meta === undefined ? null : JSON.stringify(entry.meta),
    entry.ip ?? null,
    nowIso()
  );
}

export type CompanyStatus = 'pending' | 'active' | 'suspended' | 'expired' | 'cancelled';

/**
 * Subscription state is computed, never stored as a separate truth:
 * an "active" company whose end date has passed is shown as expired even
 * before an administrator changes the stored status.
 */
export function computeSubscription(
  company: { status: string; subscription_end?: string | null; subscription_start?: string | null },
  warningDays = 30
) {
  const today = new Date();
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let effectiveStatus = company.status as CompanyStatus;
  let daysLeft: number | null = null;

  if (company.subscription_end) {
    const raw = company.subscription_end;
    const endMs = Date.parse(raw.length === 10 ? `${raw}T23:59:59Z` : raw);
    if (!Number.isNaN(endMs)) {
      daysLeft = Math.ceil((endMs - startOfToday) / 86_400_000);
      if (effectiveStatus === 'active' && daysLeft < 0) effectiveStatus = 'expired';
    }
  }

  return {
    status: company.status as CompanyStatus,
    effectiveStatus,
    daysLeft,
    expiringSoon:
      effectiveStatus === 'active' && daysLeft !== null && daysLeft <= warningDays,
    isActive: effectiveStatus === 'active',
  };
}

/** Parse JSON bodies defensively (an empty body is a valid empty object). */
export async function readJson<T = Record<string, any>>(c: any): Promise<T> {
  try {
    const body = await c.req.json();
    return (body ?? {}) as T;
  } catch {
    return {} as T;
  }
}

export const str = (value: unknown, max = 500): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export const isEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

export const isIsoDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

export function planLabel(
  plan: { name_ar?: string | null; name_en?: string | null } | null | undefined,
  locale: 'ar' | 'en'
) {
  if (!plan) return null;
  return (locale === 'ar' ? plan.name_ar : plan.name_en) || plan.name_ar || plan.name_en || null;
}
