/**
 * Wusool Tracking routes.
 *
 * Three surfaces, mounted separately in worker/index.ts:
 *   * `/t/:code`            — public redirect that records one click.
 *   * `/api/tracking/events` — public beacon for on-site events (rate limited).
 *   * `/api/company/...`     — authenticated builder and reports.
 *
 * The redirect is deliberately outside `/api`, so it carries no session, no
 * CSRF header and no tenant input beyond the random code. A company can only
 * read its own links and events because the company id comes from membership.
 */
import { Hono } from 'hono';
import { companyContext, requireAuth, type AppEnv } from '../lib/auth';
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
import { apiError } from './public';
import {
  countsByLink,
  destinationWithUtm,
  isEventKind,
  isHttpUrl,
  newLinkCode,
  recordEvent,
  totalsFor,
  UTM_KEYS,
  withinBeaconLimit,
} from '../lib/tracking';
import { isPlatform, PLATFORMS } from '../lib/social/platforms';

const companyApp = new Hono<AppEnv>();

companyApp.use('*', requireAuth);
companyApp.use('/:companyId', companyContext);
companyApp.use('/:companyId/*', companyContext);

const MANAGE = 'leads.manage';

const serializeLink = (row: any, origin: string, counts?: any) => ({
  id: row.id,
  code: row.code,
  label: row.label,
  destinationUrl: row.destination_url,
  shortUrl: `${origin}/t/${row.code}`,
  campaignId: row.campaign_id,
  postId: row.post_id,
  platform: row.platform,
  status: row.status,
  utm: {
    source: row.utm_source,
    medium: row.utm_medium,
    campaign: row.utm_campaign,
    content: row.utm_content,
    term: row.utm_term,
  },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  counts: counts
    ? {
        clicks: counts.clicks,
        pageViews: counts.pageViews,
        whatsappClicks: counts.whatsappClicks,
        callClicks: counts.callClicks,
        formSubmits: counts.formSubmits,
        leads: counts.leads,
      }
    : null,
});

async function requireActiveSubscription(c: any) {
  if (c.get('user')?.platformRole === 'super_admin') return null;
  const company = c.get('company');
  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) {
    return c.json(
      { error: { code: 'subscription_inactive', status: subscription.effectiveStatus } },
      402
    );
  }
  return null;
}

companyApp.get('/:companyId/tracking', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const [rows, totals, counts] = await Promise.all([
    all<any>(
      c.env,
      'SELECT * FROM tracking_links WHERE company_id = ? ORDER BY created_at DESC LIMIT 200',
      company.id
    ),
    totalsFor(c.env, company.id),
    countsByLink(c.env, company.id),
  ]);

  const campaignRows = await all<any>(
    c.env,
    `SELECT campaign_id, COUNT(*) AS leads FROM leads
      WHERE company_id = ? AND campaign_id IS NOT NULL GROUP BY campaign_id`,
    company.id
  );

  const origin = new URL(c.req.url).origin;
  const leadsTotal = await first<any>(
    c.env,
    'SELECT COUNT(*) AS total, SUM(CASE WHEN tracking_link_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed FROM leads WHERE company_id = ?',
    company.id
  );

  return c.json({
    links: rows.map((row) => serializeLink(row, origin, counts.get(row.id))),
    totals,
    campaigns: campaignRows.map((row) => ({
      campaignId: row.campaign_id,
      leads: Number(row.leads ?? 0),
    })),
    leads: {
      total: Number(leadsTotal?.total ?? 0),
      attributed: Number(leadsTotal?.attributed ?? 0),
    },
    // Reach, impressions and engagement come from the platforms' insight APIs,
    // which this build does not read. Saying so is better than a zero.
    platformMetrics: {
      state: 'not_implemented',
      note: 'Impressions, reach and engagement are read from platform insight APIs. Those calls are not implemented in this build, so they are not shown as numbers.',
    },
    attribution: {
      state: 'working_test',
      window: 'last_30_days',
      measuredBy: 'first_party_redirect_and_beacon',
      note: 'Clicks and events are recorded by this Worker. A click is not a visit: a visitor who blocks the beacon shows as a click only.',
    },
    canManage: can(c.get('role'), MANAGE),
    canView: true,
  });
});

companyApp.post('/:companyId/tracking/links', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const blocked = await requireActiveSubscription(c);
  if (blocked) return blocked;

  const body = await readJson<Record<string, unknown>>(c);
  const destinationUrl = str(body.destinationUrl, 1200);
  if (!isHttpUrl(destinationUrl)) return apiError(c, 422, 'destination_url_invalid');
  const label = str(body.label, 160) || 'Link';
  const utm = Object.fromEntries(
    UTM_KEYS.map((key) => {
      const camel = key.replace(/_(.)/g, (_, letter) => String(letter).toUpperCase());
      return [key, str(body[camel], 200)];
    })
  ) as Record<string, string>;

  let campaignId: string | null = null;
  if (body.campaignId) {
    const campaign = await first<any>(
      c.env,
      'SELECT id FROM campaigns WHERE id = ? AND company_id = ?',
      str(body.campaignId, 60),
      company.id
    );
    if (!campaign) return apiError(c, 422, 'campaign_not_found');
    campaignId = campaign.id;
  }
  let postId: string | null = null;
  if (body.postId) {
    const post = await first<any>(
      c.env,
      'SELECT id FROM social_posts WHERE id = ? AND company_id = ?',
      str(body.postId, 60),
      company.id
    );
    if (!post) return apiError(c, 422, 'post_not_found');
    postId = post.id;
  }
  let platform: string | null = null;
  if (body.platform) {
    if (!isPlatform(body.platform) || PLATFORMS[body.platform].category !== 'social') {
      return apiError(c, 422, 'invalid_platform');
    }
    platform = body.platform;
  }

  let code = newLinkCode();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clash = await first<any>(c.env, 'SELECT id FROM tracking_links WHERE code = ?', code);
    if (!clash) break;
    code = newLinkCode();
  }

  const id = newId('tlnk');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO tracking_links (id, company_id, campaign_id, post_id, platform, code, label, destination_url,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id,
    company.id,
    campaignId,
    postId,
    platform,
    code,
    label,
    destinationUrl,
    utm.utm_source || null,
    utm.utm_medium || null,
    utm.utm_campaign || null,
    utm.utm_content || null,
    utm.utm_term || null,
    actor.id,
    timestamp,
    timestamp
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'tracking.link_created',
    entityType: 'tracking_link',
    entityId: id,
    meta: { platform, campaignId },
  });

  const row = await first<any>(c.env, 'SELECT * FROM tracking_links WHERE id = ?', id);
  return c.json({ link: serializeLink(row, new URL(c.req.url).origin) }, 201);
});

companyApp.patch('/:companyId/tracking/links/:linkId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const blocked = await requireActiveSubscription(c);
  if (blocked) return blocked;

  const link = await first<any>(
    c.env,
    'SELECT * FROM tracking_links WHERE id = ? AND company_id = ?',
    c.req.param('linkId'),
    company.id
  );
  if (!link) return apiError(c, 404, 'link_not_found');

  const body = await readJson<Record<string, unknown>>(c);
  const status = body.status === 'paused' || body.status === 'active' ? body.status : link.status;
  const label = body.label !== undefined ? str(body.label, 160) || link.label : link.label;
  const destinationUrl =
    body.destinationUrl !== undefined ? str(body.destinationUrl, 1200) : link.destination_url;
  if (!isHttpUrl(destinationUrl)) return apiError(c, 422, 'destination_url_invalid');

  const utmValue = (key: string, column: string) => {
    const camel = key.replace(/_(.)/g, (_, letter: string) => letter.toUpperCase());
    return body[camel] !== undefined ? str(body[camel], 200) || null : link[column];
  };

  await run(
    c.env,
    `UPDATE tracking_links SET label = ?, destination_url = ?, status = ?,
       utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, utm_term = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    label,
    destinationUrl,
    status,
    utmValue('utm_source', 'utm_source'),
    utmValue('utm_medium', 'utm_medium'),
    utmValue('utm_campaign', 'utm_campaign'),
    utmValue('utm_content', 'utm_content'),
    utmValue('utm_term', 'utm_term'),
    nowIso(),
    link.id,
    company.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'tracking.link_updated',
    entityType: 'tracking_link',
    entityId: link.id,
    meta: { status },
  });
  const row = await first<any>(c.env, 'SELECT * FROM tracking_links WHERE id = ?', link.id);
  return c.json({ link: serializeLink(row, new URL(c.req.url).origin) });
});

companyApp.delete('/:companyId/tracking/links/:linkId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const blocked = await requireActiveSubscription(c);
  if (blocked) return blocked;
  const link = await first<any>(
    c.env,
    'SELECT * FROM tracking_links WHERE id = ? AND company_id = ?',
    c.req.param('linkId'),
    company.id
  );
  if (!link) return apiError(c, 404, 'link_not_found');
  // Events are kept and left unattributed; deleting a link must not rewrite
  // what was already measured.
  await run(c.env, 'DELETE FROM tracking_links WHERE id = ? AND company_id = ?', link.id, company.id);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'tracking.link_deleted',
    entityType: 'tracking_link',
    entityId: link.id,
    meta: {},
  });
  return c.json({ ok: true });
});

companyApp.get('/:companyId/tracking/links/:linkId/events', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const link = await first<any>(
    c.env,
    'SELECT * FROM tracking_links WHERE id = ? AND company_id = ?',
    c.req.param('linkId'),
    company.id
  );
  if (!link) return apiError(c, 404, 'link_not_found');
  const rows = await all<any>(
    c.env,
    `SELECT id, kind, platform, occurred_at, country, device, referrer_host, metadata_json
       FROM tracking_events WHERE company_id = ? AND link_id = ?
      ORDER BY occurred_at DESC LIMIT 100`,
    company.id,
    link.id
  );
  return c.json({
    events: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      platform: row.platform,
      occurredAt: row.occurred_at,
      country: row.country,
      device: row.device,
      referrerHost: row.referrer_host,
      metadata: JSON.parse(row.metadata_json || '{}'),
    })),
    // There is no per-visitor identity to show; the hash is not exported.
    privacy: { identified: false },
  });
});

export default companyApp;

// ---------------------------------------------------------------------------
// Public surfaces
// ---------------------------------------------------------------------------

export const redirectRoutes = new Hono<AppEnv>();

redirectRoutes.get('/t/:code', async (c) => {
  const code = String(c.req.param('code') ?? '');
  if (!/^[a-f0-9]{6,32}$/.test(code)) return c.text('Not found', 404);
  const link = await first<any>(
    c.env,
    'SELECT * FROM tracking_links WHERE code = ? AND status = ?',
    code,
    'active'
  );
  if (!link) return c.text('Not found', 404);

  try {
    const referrer = c.req.header('referer') ?? '';
    let referrerHost: string | null = null;
    if (referrer) {
      try {
        referrerHost = new URL(referrer).host.slice(0, 120);
      } catch {
        referrerHost = null;
      }
    }
    await recordEvent(c.env, {
      companyId: link.company_id,
      linkId: link.id,
      postId: link.post_id,
      campaignId: link.campaign_id,
      platform: link.platform,
      kind: 'click',
      ip: c.req.header('cf-connecting-ip') ?? '0.0.0.0',
      userAgent: c.req.header('user-agent') ?? '',
      country: c.req.header('cf-ipcountry') ?? null,
      referrerHost,
      metadata: { code },
    });
  } catch {
    // A failed measurement must not block the visitor's destination.
  }

  c.header('Cache-Control', 'no-store');
  return c.redirect(destinationWithUtm(link), 302);
});

export const beaconRoutes = new Hono<AppEnv>();

beaconRoutes.post('/tracking/events', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const code = str(body.code, 40);
  const kind = str(body.kind, 30);
  if (!isLinkCode(code)) return apiError(c, 404, 'link_not_found');
  if (!isEventKind(kind) || kind === 'click' || kind === 'lead') {
    // Clicks are recorded by the redirect and leads by the CRM, so a beacon
    // cannot claim either.
    return apiError(c, 422, 'event_kind_invalid');
  }
  const link = await first<any>(
    c.env,
    'SELECT * FROM tracking_links WHERE code = ? AND status = ?',
    code,
    'active'
  );
  if (!link) return apiError(c, 404, 'link_not_found');

  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  const userAgent = c.req.header('user-agent') ?? '';
  const allowed = await withinBeaconLimit(c.env, {
    companyId: link.company_id,
    linkId: link.id,
    ip,
    userAgent,
  });
  if (!allowed) return c.json({ ok: true, counted: false }, 202);

  await recordEvent(c.env, {
    companyId: link.company_id,
    linkId: link.id,
    postId: link.post_id,
    campaignId: link.campaign_id,
    platform: link.platform,
    kind,
    ip,
    userAgent,
    country: c.req.header('cf-ipcountry') ?? null,
    metadata: {
      path: str(body.path, 300),
      durationMs: Number(body.durationMs ?? 0) || 0,
      formId: str(body.formId, 80) || null,
      channel: str(body.channel, 40) || null,
    },
  });
  return c.json({ ok: true, counted: true }, 202);
});

const isLinkCode = (value: string) => /^[a-f0-9]{6,32}$/.test(value);
