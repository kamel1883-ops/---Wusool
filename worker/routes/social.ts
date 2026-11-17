/**
 * Social accounts, channels and the post library. Mounted at /api/company.
 *
 * Everything here is tenant-scoped: the company comes from the caller's
 * membership, never from the request. Tokens are sealed before storage and
 * never serialised — the account endpoints expose status, scopes and expiry
 * only, which is what the client needs to decide whether to reconnect.
 *
 * Publishing requires an approved post; scheduling requires an approved post
 * and at least one ready target. A post that already published cannot be
 * edited in place — a copy is created instead, so what was published stays
 * recorded exactly as it went out.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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
import { tokenKeyConfigured } from '../lib/crypto';
import { apiError } from './public';
import {
  availabilityOf,
  capabilityStatesOf,
  connectorConfig,
  isPlatform,
  PLATFORM_ORDER,
  PLATFORMS,
  platformStateOf,
  publishesAnything,
  tokenStatusOf,
  type PlatformKey,
} from '../lib/social/platforms';
import { adaptPost, type PostInput } from '../lib/social/adapt';
import {
  companyConnections,
  consumeState,
  finishFlow,
  isOauthPlatform,
  loadPendingAccounts,
  startFlow,
  storeConnection,
  usableToken,
} from '../lib/social/oauth';
import {
  enqueueTarget,
  logEvent,
  publishTarget,
  recomputePostStatus,
  runDueJobs,
} from '../lib/social/publish';
import { buildAiDraft, buildLocalDraft, generateStudioImage } from '../lib/social/studio';
import { isPosterSize, isPosterTemplate, POSTER_SIZES } from '../lib/posters';
import { ProviderError } from '../lib/ai/types';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

/**
 * Every social route needs a subscription that is active today. The check is
 * computed from the company row (so an expired end date counts even when the
 * stored status is still "active") and returns a stable 402 so the client can
 * link to billing. Platform administrators keep their own console under
 * /api/admin; this guard only covers a tenant's social workspace.
 */
const socialSubscription: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user')?.platformRole === 'super_admin') return next();
  const company = c.get('company');
  if (!company) return c.json({ error: { code: 'company_not_found' } }, 404);
  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) {
    return c.json(
      {
        error: {
          code: 'subscription_inactive',
          status: subscription.effectiveStatus,
          daysLeft: subscription.daysLeft,
        },
      },
      402
    );
  }
  await next();
};

app.use('/:companyId/social', socialSubscription);
app.use('/:companyId/social/*', socialSubscription);

/**
 * The redirect URI every provider should be configured with.
 *
 * Defaults to the deployment's own origin so a preview and production can
 * coexist, and accepts an explicit override for custom domains or a locked
 * canonical host.
 */
export function oauthRedirectUri(c: any) {
  const configured = str((c.env as any).SOCIAL_OAUTH_REDIRECT_URI, 500);
  if (configured) return configured;
  return `${new URL(c.req.url).origin}/api/social/oauth/callback`;
}

const MANAGE = 'social.manage';
const APPROVE = 'content.approve';
const CREATE = 'content.create';

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseJson = <T,>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const serializeConnection = (row: any) => ({
  id: row.id,
  platform: row.platform,
  accountId: row.account_id,
  pageId: row.page_id,
  profileId: row.profile_id,
  accountName: row.account_name,
  accountType: row.account_type,
  tokenStatus: tokenStatusOf(row),
  scopes: parseJson<string[]>(row.scopes_json, []),
  grantedScopes: parseJson<string[]>(row.granted_scopes_json, []),
  connectedBy: row.connected_by,
  connectedAt: row.connected_at,
  expiresAt: row.expires_at,
  lastSyncAt: row.last_sync_at,
  lastError: row.last_error,
  metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
});

/**
 * A public profile link is only included when it can be built from a stable
 * identifier the provider returned (a Page id, a username). Otherwise it is
 * null and the client hides the "open account" action instead of guessing.
 */
const profileUrlFor = (row: any): string | null => {
  if (row.platform === 'facebook_page' && row.page_id) {
    return `https://www.facebook.com/${row.page_id}`;
  }
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  const username = typeof metadata.username === 'string' ? metadata.username.replace(/^@/, '') : '';
  if (row.platform === 'instagram_business' && username) {
    return `https://www.instagram.com/${username}`;
  }
  if (row.platform === 'x_twitter' && username) {
    return `https://x.com/${username}`;
  }
  return null;
};

/**
 * What a company member may see: the account identity, its live state and a
 * link to the public profile. Scopes, expiry, sync details, raw provider
 * errors and stored metadata stay on the server; the super-admin console
 * reads those through /api/admin/integrations instead.
 */
const serializeConnectionForClient = (row: any) => ({
  id: row.id,
  platform: row.platform,
  pageId: row.page_id,
  profileId: row.profile_id,
  accountName: row.account_name,
  accountType: row.account_type,
  tokenStatus: tokenStatusOf(row),
  connectedAt: row.connected_at,
  profileUrl: profileUrlFor(row),
});

const serializeTarget = (row: any) => {
  const adapted = parseJson<any>(row.adapted_json, {});
  return {
    id: row.id,
    platform: row.platform,
    connectionId: row.connection_id,
    accountName: row.account_name,
    status: row.status,
    text: row.adapted_text,
    issues: Array.isArray(adapted.issues) ? adapted.issues : [],
    notes: Array.isArray(adapted.notes) ? adapted.notes : [],
    externalId: row.external_id,
    externalUrl: row.external_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    publishedAt: row.published_at,
  };
};

const loadPost = async (env: any, companyId: string, postId: string) => {
  const post = await first<any>(
    env,
    'SELECT * FROM social_posts WHERE id = ? AND company_id = ?',
    postId,
    companyId
  );
  if (!post) return null;
  const targets = await all<any>(
    env,
    'SELECT * FROM social_post_targets WHERE post_id = ? AND company_id = ? ORDER BY platform',
    postId,
    companyId
  );
  return { post, targets };
};

const serializePost = (post: any, targets: any[]) => ({
  id: post.id,
  title: post.title,
  bodyAr: post.body_ar,
  bodyEn: post.body_en,
  linkUrl: post.link_url,
  ctaLabel: post.cta_label,
  hashtags: post.hashtags,
  media: parseJson<any[]>(post.media_json, []),
  language: post.language,
  status: post.status,
  version: post.version,
  scheduledAt: post.scheduled_at,
  createdBy: post.created_by,
  submittedBy: post.submitted_by,
  submittedAt: post.submitted_at,
  approvedBy: post.approved_by,
  approvedAt: post.approved_at,
  reviewNote: post.review_note ?? null,
  reviewedBy: post.reviewed_by ?? null,
  reviewedAt: post.reviewed_at ?? null,
  publishedAt: post.published_at,
  createdAt: post.created_at,
  updatedAt: post.updated_at,
  targets: targets.map(serializeTarget),
});

const postInput = (body: Record<string, unknown>, fallback?: any): PostInput => ({
  title: str(body.title ?? fallback?.title, 200),
  bodyAr: str(body.bodyAr ?? fallback?.bodyAr, 8000),
  bodyEn: str(body.bodyEn ?? fallback?.bodyEn, 8000),
  linkUrl: str(body.linkUrl ?? fallback?.linkUrl, 800),
  ctaLabel: str(body.ctaLabel ?? fallback?.ctaLabel, 60),
  hashtags: str(body.hashtags ?? fallback?.hashtags, 600),
  language:
    body.language === 'en' || body.language === 'both' || body.language === 'ar'
      ? (body.language as 'ar' | 'en' | 'both')
      : (fallback?.language ?? 'ar'),
  media: Array.isArray(body.media)
    ? (body.media as any[])
        .map((item) => ({
          url: str(item?.url, 800),
          kind: item?.kind === 'video' ? ('video' as const) : ('image' as const),
          alt: str(item?.alt, 300),
        }))
        .filter((item) => item.url)
        .slice(0, 10)
    : (fallback?.media ?? []),
});

/** Rebuilds every target row for a post from the selected platforms. */
async function syncTargets(
  env: any,
  companyId: string,
  postId: string,
  input: PostInput,
  selection: Array<{ platform: PlatformKey; connectionId: string }>
) {
  const existing = await all<any>(
    env,
    'SELECT * FROM social_post_targets WHERE post_id = ? AND company_id = ?',
    postId,
    companyId
  );
  const keptIds = new Set<string>();
  const timestamp = nowIso();

  for (const item of selection) {
    const connection = await first<any>(
      env,
      'SELECT * FROM social_connections WHERE id = ? AND company_id = ? AND platform = ?',
      item.connectionId,
      companyId,
      item.platform
    );
    if (!connection) throw new Error('connection_not_found');

    const adapted = adaptPost(input, item.platform);
    const current = existing.find((row) => row.connection_id === item.connectionId);
    const adaptedJson = JSON.stringify({
      issues: adapted.issues,
      notes: adapted.notes,
      media: adapted.media,
      linkUrl: input.linkUrl || null,
      subject: adapted.subject,
      platform: item.platform,
    });

    // A target that already published keeps its record; re-selecting it does
    // not reset what happened.
    if (current?.status === 'published') {
      keptIds.add(current.id);
      await run(
        env,
        `UPDATE social_post_targets SET adapted_text = ?, adapted_json = ?, updated_at = ? WHERE id = ?`,
        adapted.text,
        adaptedJson,
        timestamp,
        current.id
      );
      continue;
    }

    if (current) {
      keptIds.add(current.id);
      await run(
        env,
        `UPDATE social_post_targets SET connection_id = ?, platform = ?, account_name = ?, adapted_text = ?,
           adapted_json = ?, status = ?, error_code = NULL, error_message = NULL, updated_at = ?
         WHERE id = ?`,
        item.connectionId,
        item.platform,
        connection.account_name,
        adapted.text,
        adaptedJson,
        adapted.status === 'ready' ? 'ready' : 'blocked',
        timestamp,
        current.id
      );
    } else {
      const id = newId('tgt');
      keptIds.add(id);
      await run(
        env,
        `INSERT INTO social_post_targets (id, post_id, company_id, connection_id, platform, account_name,
           adapted_text, adapted_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        postId,
        companyId,
        item.connectionId,
        item.platform,
        connection.account_name,
        adapted.text,
        adaptedJson,
        adapted.status === 'ready' ? 'ready' : 'blocked',
        timestamp,
        timestamp
      );
    }
  }

  for (const row of existing) {
    if (keptIds.has(row.id)) continue;
    if (row.status === 'published') continue;
    await run(
      env,
      'DELETE FROM social_post_targets WHERE id = ? AND company_id = ?',
      row.id,
      companyId
    );
  }
}

async function saveVersion(
  env: any,
  post: any,
  userId: string,
  reason: string,
  version: number
) {
  await run(
    env,
    `INSERT INTO social_post_versions (id, post_id, company_id, version, snapshot_json, created_by, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('pver'),
    post.id,
    post.company_id,
    version,
    JSON.stringify({
      title: post.title,
      bodyAr: post.body_ar,
      bodyEn: post.body_en,
      linkUrl: post.link_url,
      ctaLabel: post.cta_label,
      hashtags: post.hashtags,
      media: parseJson<any[]>(post.media_json, []),
      language: post.language,
      scheduledAt: post.scheduled_at,
    }),
    userId,
    reason,
    nowIso()
  );
}

// ---------------------------------------------------------------------------
// Overview: platforms, availability, connections
// ---------------------------------------------------------------------------

app.get('/:companyId/social', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const settings = await getSettings(c.env);
  const rows = await companyConnections(c.env, company.id);
  const connections = rows.map(serializeConnection);
  const config = connectorConfig(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );

  // Super admins keep the full technical picture (it powers the integrations
  // console). Everyone else gets a client-safe shape: no env-var names, no
  // scopes, no review notes, no expiry or error internals.
  const isSuperAdmin = c.get('user')?.platformRole === 'super_admin';

  const platforms = PLATFORM_ORDER.map((key) => {
    const spec = PLATFORMS[key];
    const availability = availabilityOf(key, c.env as any, settings);
    const platformConnections = isSuperAdmin
      ? connections.filter((connection) => connection.platform === key)
      : rows
          .filter((row) => row.platform === key)
          .map((row) => serializeConnectionForClient(row));
    if (isSuperAdmin) {
      return {
        key,
        name: spec.name,
        category: spec.category,
        connector: spec.connector,
        accountRequirement: spec.accountRequirement,
        capabilities: spec.capabilities,
        access: spec.access,
        limits: spec.limits,
        publishable: publishesAnything(key),
        oauthImplemented: isOauthPlatform(key),
        // `state` is what the channel can actually do in this build;
        // `availability` only says whether an authorization can be started.
        state: platformStateOf(key, c.env as any, settings),
        capabilityStates: capabilityStatesOf(key),
        availability: availability.state,
        availabilityReasons: availability.reasons,
        accessApproved: availability.accessApproved,
        reviewPending: availability.reviewPending,
        connections: platformConnections,
      };
    }
    return {
      key,
      name: spec.name,
      category: spec.category,
      publishable: publishesAnything(key),
      oauthImplemented: isOauthPlatform(key),
      state: platformStateOf(key, c.env as any, settings),
      availability: availability.state,
      connections: platformConnections,
    };
  });

  const posts = await first<any>(
    c.env,
    `SELECT
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
       SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting,
       SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
       SUM(CASE WHEN status = 'published' OR status = 'partially_published' THEN 1 ELSE 0 END) AS published,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       COUNT(*) AS total
     FROM social_posts WHERE company_id = ?`,
    company.id
  );
  const jobs = await first<any>(
    c.env,
    `SELECT SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM social_jobs WHERE company_id = ?`,
    company.id
  );

  return c.json({
    platforms,
    connections: isSuperAdmin ? connections : rows.map((row) => serializeConnectionForClient(row)),
    setup: isSuperAdmin
      ? {
      tokenKeyConfigured: tokenKeyConfigured(c.env as any),
      meta: { configured: config.meta.configured, requires: config.meta.requires },
      google: { configured: config.google.configured, requires: config.google.requires },
      email: { configured: config.email.configured, requires: config.email.requires },
      scheduler: {
        state: Boolean((c.env as any).JOBS_SECRET) ? 'configured' : 'blocked_by_hosting',
        // This hosting target has no cron trigger, so a due job is only run by
        // an external caller with the secret or by a company admin on demand.
        execution: 'manual_or_external',
        automatic: false,
      },
    }
      : null,
    analytics: {
      state: 'not_implemented',
      note: 'Reading GA4 reports, Search Console queries, Meta/Instagram insights or Business Profile metrics is not implemented. Only manual campaign results are available.',
    },
    subscription: {
      status: subscription.effectiveStatus,
      isActive: subscription.isActive,
      daysLeft: subscription.daysLeft,
    },
    stats: {
      connections: connections.length,
      needsReconnect: connections.filter(
        (row) => row.tokenStatus === 'requires_reconnect' || row.tokenStatus === 'expired'
      ).length,
      posts: {
        total: Number(posts?.total ?? 0),
        drafts: Number(posts?.drafts ?? 0),
        awaiting: Number(posts?.awaiting ?? 0),
        scheduled: Number(posts?.scheduled ?? 0),
        published: Number(posts?.published ?? 0),
        failed: Number(posts?.failed ?? 0),
      },
      jobs: { pending: Number(jobs?.pending ?? 0), failed: Number(jobs?.failed ?? 0) },
    },
    canManage: can(c.get('role'), MANAGE),
    canApprove: can(c.get('role'), APPROVE),
    canCreate: can(c.get('role'), CREATE),
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

app.post('/:companyId/social/oauth/start', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  if (!tokenKeyConfigured(c.env as any)) return apiError(c, 503, 'token_storage_not_configured');

  const body = await readJson<{ platform?: string }>(c);
  const platform = String(body.platform ?? '');
  if (!isPlatform(platform)) return apiError(c, 422, 'invalid_platform');
  if (!isOauthPlatform(platform)) return apiError(c, 409, 'oauth_not_supported');

  const settings = await getSettings(c.env);
  const availability = availabilityOf(platform, c.env as any, settings);
  if (availability.state === 'requires_credentials') {
    return apiError(c, 409, 'platform_requires_credentials');
  }
  if (availability.state === 'not_supported') {
    return apiError(c, 409, 'oauth_not_supported');
  }

  // One redirect URI for the whole platform. Providers match the redirect URI
  // byte for byte, so a per-company path would force the operator to register
  // a URI for every customer they onboard. The tenant is carried by the signed
  // `state` row instead (see socialCallbackRoutes below).
  const redirectUri = oauthRedirectUri(c);

  try {
    const started = await startFlow(c.env, {
      companyId: company.id,
      platform,
      userId: actor.id,
      redirectUri,
    });
    await logEvent(c.env, {
      companyId: company.id,
      kind: 'oauth.started',
      detail: platform,
      actorUserId: actor.id,
    });
    return c.json({ authorizeUrl: started.authorizeUrl, state: started.state });
  } catch (error) {
    const code = String((error as Error)?.message ?? 'oauth_start_failed');
    return apiError(c, 409, code.startsWith('meta_app_not_configured') || code.startsWith('google_app_not_configured')
      ? 'platform_requires_credentials'
      : 'oauth_start_failed');
  }
});

app.get('/:companyId/social/oauth/callback', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const state = str(c.req.query('state'), 100);
  const code = str(c.req.query('code'), 2000);
  const denied = str(c.req.query('error'), 100);

  const appBase = `/app/${company.id}/social`;
  if (!state) return c.redirect(`${appBase}?oauth=invalid`);
  if (denied) return c.redirect(`${appBase}?oauth=denied`);

  let row: any;
  try {
    row = await consumeState(c.env, state, actor.id);
  } catch (error) {
    const reason = String((error as Error)?.message ?? 'oauth_state_invalid').replace(
      'oauth_state_',
      ''
    );
    return c.redirect(`${appBase}?oauth=${encodeURIComponent(reason)}`);
  }
  if (row.company_id !== company.id) return c.redirect(`${appBase}?oauth=tenant_mismatch`);
  if (!code) return c.redirect(`${appBase}?oauth=code_missing`);

  try {
    await finishFlow(c.env, row, code);
    await logEvent(c.env, {
      companyId: company.id,
      kind: 'oauth.authorized',
      detail: String(row.platform),
      actorUserId: actor.id,
    });
    return c.redirect(`${appBase}?oauth=select&state=${encodeURIComponent(state)}`);
  } catch (error) {
    const message = String((error as Error)?.message ?? 'oauth_failed');
    await logEvent(c.env, {
      companyId: company.id,
      kind: 'oauth.failed',
      detail: `${row.platform}: ${message}`.slice(0, 400),
      actorUserId: actor.id,
    });
    const reason = message.split(':')[0].replace(/_failed$/, '');
    return c.redirect(`${appBase}?oauth=${encodeURIComponent(reason)}`);
  }
});

/**
 * Provider redirect target shared by every tenant: `/api/social/oauth/callback`.
 *
 * The provider only ever sees this one URL. The tenant is read from the `state`
 * row, which was written for the signed-in user when the flow started, and the
 * caller is checked against the membership of that company before any token is
 * exchanged. A state that belongs to another user or company is refused, so a
 * single shared endpoint does not weaken tenant isolation.
 */
export const socialCallbackRoutes = new Hono<AppEnv>();
socialCallbackRoutes.use('*', requireAuth);

socialCallbackRoutes.get('/social/oauth/callback', async (c) => {
  const actor = c.get('user');
  const state = str(c.req.query('state'), 100);
  const code = str(c.req.query('code'), 2000);
  const denied = str(c.req.query('error'), 100);

  if (!state) return c.redirect('/app?oauth=invalid');
  if (denied) return c.redirect('/app?oauth=denied');

  let row: any;
  try {
    row = await consumeState(c.env, state, actor.id);
  } catch (error) {
    const reason = String((error as Error)?.message ?? 'oauth_state_invalid').replace(
      'oauth_state_',
      ''
    );
    return c.redirect(`/app?oauth=${encodeURIComponent(reason)}`);
  }

  const appBase = `/app/${row.company_id}/social`;
  const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', row.company_id);
  const membership = await first<any>(
    c.env,
    'SELECT id, status FROM memberships WHERE user_id = ? AND company_id = ?',
    actor.id,
    row.company_id
  );
  if (!company || !membership || membership.status !== 'active') {
    return c.redirect('/app?oauth=tenant_mismatch');
  }

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive && actor.platformRole !== 'super_admin') {
    return c.redirect(`${appBase}?oauth=subscription_inactive`);
  }
  if (!code) return c.redirect(`${appBase}?oauth=code_missing`);

  try {
    await finishFlow(c.env, row, code);
    await logEvent(c.env, {
      companyId: company.id,
      kind: 'oauth.authorized',
      detail: String(row.platform),
      actorUserId: actor.id,
    });
    return c.redirect(`${appBase}?oauth=select&state=${encodeURIComponent(state)}`);
  } catch (error) {
    const message = String((error as Error)?.message ?? 'oauth_failed');
    await logEvent(c.env, {
      companyId: company.id,
      kind: 'oauth.failed',
      detail: `${row.platform}: ${message}`.slice(0, 400),
      actorUserId: actor.id,
    });
    const reason = message.split(':')[0].replace(/_failed$/, '');
    return c.redirect(`${appBase}?oauth=${encodeURIComponent(reason)}`);
  }
});

app.get('/:companyId/social/oauth/pending', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const state = str(c.req.query('state'), 100);
  const row = await first<any>(
    c.env,
    'SELECT * FROM oauth_states WHERE state = ? AND company_id = ?',
    state,
    company.id
  );
  if (!row) return apiError(c, 404, 'oauth_state_not_found');
  const { accounts } = await loadPendingAccounts(c.env, state);
  return c.json({
    platform: row.platform,
    accounts: accounts.map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
      accountType: account.accountType,
      pageId: account.pageId,
      profileId: account.profileId,
      metadata: account.metadata,
    })),
  });
});

app.post('/:companyId/social/oauth/complete', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<{ state?: string; accountIds?: string[] }>(c);
  const state = str(body.state, 100);
  const wanted = new Set(Array.isArray(body.accountIds) ? body.accountIds.map(String) : []);
  if (!state) return apiError(c, 422, 'oauth_state_required');
  if (!wanted.size) return apiError(c, 422, 'account_selection_required');

  const { row, accounts, tokens } = await loadPendingAccounts(c.env, state);
  if (row.company_id !== company.id) return apiError(c, 403, 'forbidden');
  const platform = row.platform as PlatformKey;

  const chosen = accounts.filter((account) => wanted.has(account.accountId));
  if (!chosen.length) return apiError(c, 422, 'account_selection_invalid');

  // One Meta authorization returns Pages and their linked Instagram accounts.
  // Each becomes its own connection with its own platform: an Instagram
  // account is never stored as a Page, because the two publish differently.
  const platformFor = (account: any): PlatformKey =>
    platform === 'facebook_page' && account.accountType === 'instagram_professional'
      ? 'instagram_business'
      : platform;

  const connected: string[] = [];
  for (const account of chosen) {
    const targetPlatform = platformFor(account);
    const id = await storeConnection(c.env, {
      companyId: company.id,
      platform: targetPlatform,
      account,
      tokens,
      pageToken: account.accessToken,
      userId: actor.id,
      scopes: PLATFORMS[targetPlatform].access.scopes,
    });
    connected.push(id);
    await logEvent(c.env, {
      companyId: company.id,
      connectionId: id,
      kind: 'connection.connected',
      detail: `${targetPlatform}: ${account.accountName}`,
      actorUserId: actor.id,
    });
  }

  await run(
    c.env,
    'UPDATE oauth_states SET pending_token_enc = NULL, pending_accounts_json = NULL WHERE state = ?',
    state
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'social.connected',
    entityType: 'social_connection',
    entityId: company.id,
    meta: { platform, accounts: chosen.map((account) => account.accountId) },
  });

  return c.json({ connected });
});

app.delete('/:companyId/social/connections/:connectionId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');

  const connection = await first<any>(
    c.env,
    'SELECT * FROM social_connections WHERE id = ? AND company_id = ?',
    c.req.param('connectionId'),
    company.id
  );
  if (!connection) return apiError(c, 404, 'connection_not_found');

  await run(c.env, 'DELETE FROM social_tokens WHERE connection_id = ?', connection.id);
  await run(c.env, 'DELETE FROM social_connections WHERE id = ? AND company_id = ?', connection.id, company.id);
  await run(
    c.env,
    `UPDATE social_post_targets SET connection_id = NULL, status = 'blocked', error_code = 'connection_removed', updated_at = ?
     WHERE connection_id = ? AND status <> 'published'`,
    nowIso(),
    connection.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    kind: 'connection.disconnected',
    detail: `${connection.platform}: ${connection.account_name}`,
    actorUserId: actor.id,
  });
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'social.disconnected',
    entityType: 'social_connection',
    entityId: connection.id,
    meta: { platform: connection.platform },
  });

  return c.json({ ok: true });
});

app.post('/:companyId/social/connections/:connectionId/verify', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const connection = await first<any>(
    c.env,
    'SELECT * FROM social_connections WHERE id = ? AND company_id = ?',
    c.req.param('connectionId'),
    company.id
  );
  if (!connection) return apiError(c, 404, 'connection_not_found');

  try {
    await usableToken(c.env, connection);
    await run(
      c.env,
      `UPDATE social_connections SET token_status = 'connected', last_error = NULL, last_sync_at = ?, updated_at = ? WHERE id = ?`,
      nowIso(),
      nowIso(),
      connection.id
    );
    return c.json({ tokenStatus: 'connected' });
  } catch (error) {
    const code = String((error as Error)?.message ?? 'token_invalid');
    await run(
      c.env,
      `UPDATE social_connections SET token_status = 'requires_reconnect', last_error = ?, updated_at = ? WHERE id = ?`,
      code.slice(0, 200),
      nowIso(),
      connection.id
    );
    return apiError(c, 409, 'token_requires_reconnect');
  }
});

/**
 * Adapts a post for the selected platforms without saving anything. This is
 * what feeds the per-platform previews, so the client sees exactly the text
 * and the errors the server would use — not a client-side approximation.
 */
app.post('/:companyId/social/preview', async (c) => {
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');
  const body = await readJson<Record<string, unknown>>(c);
  const input = postInput(body);
  if (!input.bodyAr && !input.bodyEn) return apiError(c, 422, 'post_body_required');
  if (input.linkUrl && !isHttpUrl(input.linkUrl)) return apiError(c, 422, 'link_invalid');

  const platforms = Array.isArray(body.platforms)
    ? (body.platforms as unknown[]).filter((item): item is PlatformKey => isPlatform(item))
    : [];
  if (!platforms.length) return apiError(c, 422, 'platforms_required');

  return c.json({
    previews: platforms.map((platform) => {
      const adapted = adaptPost(input, platform);
      return {
        platform,
        spec: {
          name: PLATFORMS[platform].name,
          limits: PLATFORMS[platform].limits,
          capabilities: PLATFORMS[platform].capabilities,
          reviewNote: PLATFORMS[platform].access.reviewNote,
        },
        status: adapted.status,
        text: adapted.text,
        subject: adapted.subject,
        media: adapted.media,
        issues: adapted.issues,
        notes: adapted.notes,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// Post studio — idea in, caption + image out.
//
// The client writes one idea ("two Saudi men holding a phone, the post says
// …"); the server writes the caption and the poster copy, renders the poster
// as a draft, and optionally asks the image gateway for a raster image. The
// client then approves, regenerates with feedback, or saves — saving stores a
// draft in the post library the client can return to and copy from anytime.
// Nothing publishes from here: approval and publishing stay on their own
// server-checked paths.
// ---------------------------------------------------------------------------

/** Facts from the latest approved analysis — website/inference values only. */
async function studioContext(env: any, companyId: string): Promise<string[]> {
  const row = await first<any>(
    env,
    `SELECT r.result_json FROM analysis_results r
       JOIN site_analyses a ON a.id = r.analysis_id
      WHERE a.company_id = ? AND a.status = 'approved' AND r.version = a.approved_version
      ORDER BY a.created_at DESC LIMIT 1`,
    companyId
  );
  if (!row) return [];
  let parsed: any = null;
  try {
    parsed = JSON.parse(row.result_json);
  } catch {
    return [];
  }
  const usable = (field: any) =>
    field && typeof field.value === 'string' && field.value.trim() && field.source !== 'missing' && field.source !== 'suggestion'
      ? field.value.trim()
      : '';
  const out: string[] = [];
  const industry = usable(parsed?.company_profile?.industry);
  const summary = usable(parsed?.company_profile?.summary);
  if (summary) out.push(summary);
  if (industry) out.push(industry);
  const services = Array.isArray(parsed?.products_and_services)
    ? parsed.products_and_services.map(usable).filter(Boolean).slice(0, 4)
    : [];
  if (services.length) out.push(`Services: ${services.join('، ')}`);
  return out.slice(0, 4);
}

app.post('/:companyId/social/studio/generate', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const idea = str(body.idea, 2000);
  if (idea.length < 3) return apiError(c, 422, 'studio_idea_required');
  const language = body.language === 'en' ? 'en' : 'ar';
  const sizeKey = str(body.sizeKey, 40) || 'instagram_business';
  if (!isPosterSize(sizeKey)) return apiError(c, 422, 'poster_size_invalid');
  const template = str(body.template, 20) || 'bold';
  if (!isPosterTemplate(template)) return apiError(c, 422, 'poster_template_invalid');
  const brandColor = str(body.brandColor, 7) || '#0f766e';
  if (!/^#[0-9a-fA-F]{6}$/.test(brandColor)) return apiError(c, 422, 'color_invalid');
  const variant = Math.max(0, Math.min(50, Math.floor(Number(body.variant ?? 0) || 0)));
  const feedback = str(body.feedback, 1000);

  const previousRaw = body.previous && typeof body.previous === 'object' ? (body.previous as any) : null;
  const previous = previousRaw
    ? {
        headline: str(previousRaw.headline, 240),
        caption: str(previousRaw.caption ?? previousRaw.captionAr ?? previousRaw.captionEn, 2000),
      }
    : null;

  const input = {
    idea,
    feedback,
    language: language as 'ar' | 'en',
    companyName: String(company.name ?? ''),
    context: await studioContext(c.env, company.id),
    previous,
    variant,
  };

  let draft;
  try {
    draft = (await buildAiDraft(c.env as any, input)) ?? buildLocalDraft(input);
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'ai_provider_failed';
    return apiError(c, 502, code);
  }

  // The studio image is the server-rendered poster draft: approving it makes
  // its public URL usable as the saved post's media, exactly like a poster
  // created by hand from the posters tab.
  const size = POSTER_SIZES[sizeKey];
  const posterId = newId('pstr');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO poster_drafts (id, company_id, title, headline, subhead, cta, template, size_key,
       width, height, brand_color, language, status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
    posterId,
    company.id,
    draft.title || draft.headline.slice(0, 60),
    draft.headline,
    draft.subhead || null,
    draft.cta || null,
    template,
    sizeKey,
    size.width,
    size.height,
    brandColor,
    language,
    actor.id,
    timestamp,
    timestamp
  );

  // Optional raster image; the poster above is the image when this is unset.
  let imageUrl: string | null = null;
  let imagePreviewUrl: string | null = null;
  const generated = await generateStudioImage(c.env as any, draft.imagePrompt, size.width, size.height);
  if (generated?.kind === 'url') {
    imageUrl = generated.url;
  } else if (generated?.kind === 'base64') {
    const imageId = newId('stimg');
    const bytes = Uint8Array.from(atob(generated.base64), (ch) => ch.charCodeAt(0));
    await c.env.FILES.put(`studio/${imageId}.png`, bytes, {
      httpMetadata: { contentType: generated.contentType },
    });
    imagePreviewUrl = `/${company.id}/social/studio/images/${imageId}`;
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'studio.generated',
    entityType: 'poster',
    entityId: posterId,
    meta: { sizeKey, variant },
  });

  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      draft: {
        ...draft,
        posterId,
        posterPreviewUrl: `${origin}/api/company/${company.id}/posters/${posterId}/preview.svg`,
        imageUrl,
        imagePreviewUrl,
        variant,
      },
    },
    201
  );
});

/** Authenticated preview of an AI-generated studio image (never public). */
app.get('/:companyId/social/studio/images/:imageId', async (c) => {
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const imageId = String(c.req.param('imageId') ?? '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!imageId.startsWith('stimg_')) return c.text('Not found', 404);
  const object = await c.env.FILES.get(`studio/${imageId}.png`);
  if (!object) return c.text('Not found', 404);
  c.header('content-type', object.httpMetadata?.contentType ?? 'image/png');
  c.header('cache-control', 'private, max-age=300');
  c.header('x-content-type-options', 'nosniff');
  return c.body(object.body);
});

/**
 * Save a studio draft into the post library as a draft. No targets are
 * required: the client can return to it anytime, copy the text or image,
 * and pick platforms later from the library's edit screen.
 */
app.post('/:companyId/social/studio/save', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const bodyAr = str(body.bodyAr ?? body.captionAr, 8000);
  const bodyEn = str(body.bodyEn ?? body.captionEn, 8000);
  if (!bodyAr && !bodyEn) return apiError(c, 422, 'post_body_required');
  const language =
    body.language === 'en' || body.language === 'both' || body.language === 'ar'
      ? (body.language as 'ar' | 'en' | 'both')
      : 'ar';

  const media: Array<{ url: string; kind: 'image' | 'video'; alt?: string }> = [];
  const posterId = str(body.posterId, 60);
  if (posterId) {
    const poster = await first<any>(
      c.env,
      'SELECT * FROM poster_drafts WHERE id = ? AND company_id = ?',
      posterId,
      company.id
    );
    if (poster) {
      const origin = new URL(c.req.url).origin;
      media.push({
        url:
          poster.status === 'approved'
            ? `${origin}/api/public/posters/${poster.id}.svg`
            : `${origin}/api/company/${company.id}/posters/${poster.id}/preview.svg`,
        kind: 'image',
        alt: poster.headline,
      });
    }
  }
  const imageUrl = str(body.imageUrl, 2000);
  if (imageUrl && isHttpUrl(imageUrl)) media.push({ url: imageUrl, kind: 'image' });

  const timestamp = nowIso();
  const id = newId('post');
  await run(
    c.env,
    `INSERT INTO social_posts (id, company_id, title, body_ar, body_en, link_url, cta_label, hashtags,
       media_json, language, status, version, scheduled_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, NULL, ?, ?, ?)`,
    id,
    company.id,
    str(body.title, 200) || null,
    bodyAr || null,
    bodyEn || null,
    null,
    str(body.ctaLabel ?? body.cta, 60) || null,
    str(body.hashtags, 600) || null,
    JSON.stringify(media),
    language,
    actor.id,
    timestamp,
    timestamp
  );
  const post = await first<any>(c.env, 'SELECT * FROM social_posts WHERE id = ?', id);
  await saveVersion(c.env, post, actor.id, 'created', 1);
  await logEvent(c.env, {
    companyId: company.id,
    postId: id,
    kind: 'post.created',
    detail: String(str(body.title, 200) || id),
    actorUserId: actor.id,
  });
  const loaded = await loadPost(c.env, company.id, id);
  return c.json({ post: serializePost(loaded!.post, loaded!.targets) }, 201);
});

// ---------------------------------------------------------------------------
// Post library
// ---------------------------------------------------------------------------

app.get('/:companyId/social/posts', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const status = str(c.req.query('status'), 30);
  const search = str(c.req.query('q'), 120);
  const conditions = ['company_id = ?'];
  const params: any[] = [company.id];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search) {
    conditions.push('(COALESCE(title, "") LIKE ? OR COALESCE(body_ar, "") LIKE ? OR COALESCE(body_en, "") LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const posts = await all<any>(
    c.env,
    `SELECT * FROM social_posts WHERE ${conditions.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100`,
    ...params
  );
  const targets = posts.length
    ? await all<any>(
        c.env,
        `SELECT * FROM social_post_targets WHERE company_id = ? AND post_id IN (${posts.map(() => '?').join(',')})`,
        company.id,
        ...posts.map((post) => post.id)
      )
    : [];
  return c.json({
    posts: posts.map((post) =>
      serializePost(
        post,
        targets.filter((target) => target.post_id === post.id)
      )
    ),
  });
});

app.post('/:companyId/social/posts', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const input = postInput(body);
  if (!input.bodyAr && !input.bodyEn) return apiError(c, 422, 'post_body_required');
  if (input.linkUrl && !isHttpUrl(input.linkUrl)) return apiError(c, 422, 'link_invalid');

  const selection = Array.isArray(body.targets)
    ? (body.targets as any[])
        .map((item) => ({
          platform: String(item?.platform ?? ''),
          connectionId: String(item?.connectionId ?? ''),
        }))
        .filter((item) => isPlatform(item.platform) && item.connectionId)
    : [];
  if (!selection.length) return apiError(c, 422, 'targets_required');

  const timestamp = nowIso();
  const id = newId('post');
  const scheduledAt = str(body.scheduledAt, 40) || null;
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
    return apiError(c, 422, 'schedule_invalid');
  }

  await run(
    c.env,
    `INSERT INTO social_posts (id, company_id, title, body_ar, body_en, link_url, cta_label, hashtags,
       media_json, language, status, version, scheduled_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`,
    id,
    company.id,
    input.title || null,
    input.bodyAr || null,
    input.bodyEn || null,
    input.linkUrl || null,
    input.ctaLabel || null,
    input.hashtags || null,
    JSON.stringify(input.media),
    input.language,
    scheduledAt,
    actor.id,
    timestamp,
    timestamp
  );

  try {
    await syncTargets(c.env, company.id, id, input, selection as any);
  } catch (error) {
    await run(c.env, 'DELETE FROM social_posts WHERE id = ? AND company_id = ?', id, company.id);
    const code = String((error as Error)?.message ?? 'target_sync_failed');
    return apiError(c, code === 'connection_not_found' ? 422 : 500, code);
  }

  const post = await first<any>(c.env, 'SELECT * FROM social_posts WHERE id = ?', id);
  await saveVersion(c.env, post, actor.id, 'created', 1);
  await logEvent(c.env, {
    companyId: company.id,
    postId: id,
    kind: 'post.created',
    detail: String(input.title || id),
    actorUserId: actor.id,
  });

  const loaded = await loadPost(c.env, company.id, id);
  return c.json({ post: serializePost(loaded!.post, loaded!.targets) }, 201);
});

app.get('/:companyId/social/posts/:postId', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');

  const versions = await all<any>(
    c.env,
    'SELECT * FROM social_post_versions WHERE post_id = ? AND company_id = ? ORDER BY version DESC',
    loaded.post.id,
    company.id
  );
  const jobs = await all<any>(
    c.env,
    'SELECT * FROM social_jobs WHERE company_id = ? AND target_id IN (SELECT id FROM social_post_targets WHERE post_id = ?) ORDER BY run_at',
    company.id,
    loaded.post.id
  );
  return c.json({
    post: serializePost(loaded.post, loaded.targets),
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      createdBy: version.created_by,
      reason: version.reason,
      createdAt: version.created_at,
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      targetId: job.target_id,
      state: job.state,
      runAt: job.run_at,
      attempts: job.attempts,
      lastError: job.last_error,
    })),
  });
});

app.put('/:companyId/social/posts/:postId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');

  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (loaded.post.status === 'published' || loaded.post.status === 'partially_published') {
    return apiError(c, 409, 'post_already_published');
  }

  const body = await readJson<Record<string, unknown>>(c);
  const current = serializePost(loaded.post, loaded.targets);
  const input = postInput(body, current);
  if (!input.bodyAr && !input.bodyEn) return apiError(c, 422, 'post_body_required');
  if (input.linkUrl && !isHttpUrl(input.linkUrl)) return apiError(c, 422, 'link_invalid');

  const selection = Array.isArray(body.targets)
    ? (body.targets as any[])
        .map((item) => ({
          platform: String(item?.platform ?? ''),
          connectionId: String(item?.connectionId ?? ''),
        }))
        .filter((item) => isPlatform(item.platform) && item.connectionId)
    : current.targets.map((target: any) => ({
        platform: target.platform,
        connectionId: target.connectionId,
      }));
  if (!selection.length) return apiError(c, 422, 'targets_required');

  const scheduledAt = str(body.scheduledAt, 40) || null;
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
    return apiError(c, 422, 'schedule_invalid');
  }

  const version = Number(loaded.post.version) + 1;
  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE social_posts SET title = ?, body_ar = ?, body_en = ?, link_url = ?, cta_label = ?, hashtags = ?,
       media_json = ?, language = ?, scheduled_at = ?, version = ?, status = 'draft', submitted_by = NULL,
       submitted_at = NULL, approved_by = NULL, approved_at = NULL, review_note = NULL,
       reviewed_by = NULL, reviewed_at = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    input.title || null,
    input.bodyAr || null,
    input.bodyEn || null,
    input.linkUrl || null,
    input.ctaLabel || null,
    input.hashtags || null,
    JSON.stringify(input.media),
    input.language,
    scheduledAt,
    version,
    timestamp,
    loaded.post.id,
    company.id
  );

  try {
    await syncTargets(c.env, company.id, loaded.post.id, input, selection as any);
  } catch (error) {
    const code = String((error as Error)?.message ?? 'target_sync_failed');
    return apiError(c, code === 'connection_not_found' ? 422 : 500, code);
  }

  const refreshed = await first<any>(c.env, 'SELECT * FROM social_posts WHERE id = ?', loaded.post.id);
  await saveVersion(c.env, refreshed, actor.id, 'edited', version);
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.edited',
    detail: `v${version}`,
    actorUserId: actor.id,
  });

  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});

app.post('/:companyId/social/posts/:postId/duplicate', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');

  const timestamp = nowIso();
  const id = newId('post');
  await run(
    c.env,
    `INSERT INTO social_posts (id, company_id, title, body_ar, body_en, link_url, cta_label, hashtags,
       media_json, language, status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
    id,
    company.id,
    loaded.post.title ? `${loaded.post.title} (copy)` : null,
    loaded.post.body_ar,
    loaded.post.body_en,
    loaded.post.link_url,
    loaded.post.cta_label,
    loaded.post.hashtags,
    loaded.post.media_json,
    loaded.post.language,
    actor.id,
    timestamp,
    timestamp
  );

  for (const target of loaded.targets) {
    const adapted = adaptPost(
      {
        title: loaded.post.title ?? '',
        bodyAr: loaded.post.body_ar ?? '',
        bodyEn: loaded.post.body_en ?? '',
        linkUrl: loaded.post.link_url ?? '',
        ctaLabel: loaded.post.cta_label ?? '',
        hashtags: loaded.post.hashtags ?? '',
        language: loaded.post.language,
        media: parseJson(loaded.post.media_json, []),
      },
      target.platform as PlatformKey
    );
    await run(
      c.env,
      `INSERT INTO social_post_targets (id, post_id, company_id, connection_id, platform, account_name,
         adapted_text, adapted_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('tgt'),
      id,
      company.id,
      target.connection_id,
      target.platform,
      target.account_name,
      adapted.text,
      JSON.stringify({ issues: adapted.issues, notes: adapted.notes, media: adapted.media }),
      adapted.status === 'ready' ? 'ready' : 'blocked',
      timestamp,
      timestamp
    );
  }

  const post = await first<any>(c.env, 'SELECT * FROM social_posts WHERE id = ?', id);
  await saveVersion(c.env, post, actor.id, 'duplicated', 1);
  const result = await loadPost(c.env, company.id, id);
  return c.json({ post: serializePost(result!.post, result!.targets) }, 201);
});

app.post('/:companyId/social/posts/:postId/submit', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (
    !['draft', 'changes_requested', 'rejected', 'awaiting_approval', 'approved'].includes(
      loaded.post.status
    )
  ) {
    return apiError(c, 409, 'post_state_invalid');
  }
  if (!loaded.targets.length) return apiError(c, 422, 'targets_required');

  await run(
    c.env,
    `UPDATE social_posts SET status = 'awaiting_approval', submitted_by = ?, submitted_at = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    actor.id,
    nowIso(),
    nowIso(),
    loaded.post.id,
    company.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.submitted',
    actorUserId: actor.id,
  });
  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});

app.post('/:companyId/social/posts/:postId/approve', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (loaded.post.status === 'published' || loaded.post.status === 'partially_published') {
    return apiError(c, 409, 'post_already_published');
  }
  // Approval follows a submission: the approver must be able to see that the
  // author handed the copy over, and the version they approved stays recorded.
  if (!['awaiting_approval', 'approved'].includes(loaded.post.status)) {
    return apiError(c, 409, 'post_state_invalid');
  }
  if (!loaded.targets.length) return apiError(c, 422, 'targets_required');

  const blocking = loaded.targets.filter((target) => target.status === 'blocked');
  if (blocking.length) {
    return c.json(
      {
        error: {
          code: 'targets_blocked',
          targets: blocking.map((target) => ({
            platform: target.platform,
            issues: parseJson<any>(target.adapted_json, {}).issues ?? [],
          })),
        },
      },
      409
    );
  }

  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE social_posts SET status = ?, approved_by = ?, approved_at = ?, review_note = NULL,
       reviewed_by = NULL, reviewed_at = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    loaded.post.scheduled_at ? 'scheduled' : 'approved',
    actor.id,
    timestamp,
    timestamp,
    loaded.post.id,
    company.id
  );
  await run(
    c.env,
    `UPDATE social_post_targets SET status = 'ready', updated_at = ? WHERE post_id = ? AND status = 'blocked'`,
    timestamp,
    loaded.post.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.approved',
    detail: `v${loaded.post.version}`,
    actorUserId: actor.id,
  });
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'social.post_approved',
    entityType: 'social_post',
    entityId: loaded.post.id,
    meta: { version: loaded.post.version, platforms: loaded.targets.map((target) => target.platform) },
  });

  if (loaded.post.scheduled_at) {
    for (const target of loaded.targets) {
      if (target.status === 'published') continue;
      await enqueueTarget(c.env, {
        companyId: company.id,
        targetId: target.id,
        runAt: loaded.post.scheduled_at,
      });
    }
  }

  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});


// ---------------------------------------------------------------------------
// Review decisions: reject or send back for changes, with a stored reason
// ---------------------------------------------------------------------------

async function reviewDecision(c: any, decision: 'rejected' | 'changes_requested') {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');

  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (loaded.post.status === 'published' || loaded.post.status === 'partially_published') {
    return apiError(c, 409, 'post_already_published');
  }
  if (loaded.post.status !== 'awaiting_approval') {
    return apiError(c, 409, 'post_state_invalid');
  }

  const body = await readJson<{ reason?: string }>(c);
  const reason = str(body.reason, 500);
  if (reason.length < 3) return apiError(c, 422, 'review_reason_required');

  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE social_posts SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?,
       approved_by = NULL, approved_at = NULL, scheduled_at = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    decision,
    reason,
    actor.id,
    timestamp,
    timestamp,
    loaded.post.id,
    company.id
  );
  // A decision can only happen before approval, but cancelling any queued job
  // here keeps the queue consistent if a state was forced.
  await run(
    c.env,
    `UPDATE social_jobs SET state = 'cancelled', updated_at = ?
      WHERE company_id = ? AND target_id IN (SELECT id FROM social_post_targets WHERE post_id = ?)`,
    timestamp,
    company.id,
    loaded.post.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: decision === 'rejected' ? 'post.rejected' : 'post.changes_requested',
    detail: reason,
    actorUserId: actor.id,
  });
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: decision === 'rejected' ? 'social.post_rejected' : 'social.post_changes_requested',
    entityType: 'social_post',
    entityId: loaded.post.id,
    meta: { reason, version: loaded.post.version },
  });

  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
}

app.post('/:companyId/social/posts/:postId/reject', (c) => reviewDecision(c, 'rejected'));
app.post('/:companyId/social/posts/:postId/request-changes', (c) =>
  reviewDecision(c, 'changes_requested')
);

/**
 * Restoring does not overwrite history: it creates a new draft from the
 * snapshot and leaves the original post (and the version list) untouched.
 */
app.post('/:companyId/social/posts/:postId/versions/:version/restore', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), CREATE)) return apiError(c, 403, 'forbidden');

  const original = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!original) return apiError(c, 404, 'post_not_found');
  const versionNumber = Number(c.req.param('version'));
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    return apiError(c, 422, 'version_invalid');
  }
  const snapshotRow = await first<any>(
    c.env,
    'SELECT * FROM social_post_versions WHERE post_id = ? AND company_id = ? AND version = ?',
    original.post.id,
    company.id,
    versionNumber
  );
  if (!snapshotRow) return apiError(c, 404, 'version_not_found');

  const snapshot = parseJson<any>(snapshotRow.snapshot_json, {});
  const input: PostInput = {
    title: str(snapshot.title, 200),
    bodyAr: str(snapshot.bodyAr, 8000),
    bodyEn: str(snapshot.bodyEn, 8000),
    linkUrl: str(snapshot.linkUrl, 800),
    ctaLabel: str(snapshot.ctaLabel, 60),
    hashtags: str(snapshot.hashtags, 600),
    language:
      snapshot.language === 'en' || snapshot.language === 'both' || snapshot.language === 'ar'
        ? snapshot.language
        : 'ar',
    media: Array.isArray(snapshot.media) ? snapshot.media : [],
  };

  const selection: Array<{ platform: PlatformKey; connectionId: string }> = [];
  for (const target of original.targets) {
    if (!target.connection_id) continue;
    if (!isPlatform(target.platform) || !publishesAnything(target.platform)) continue;
    const connection = await first<any>(
      c.env,
      'SELECT id FROM social_connections WHERE id = ? AND company_id = ?',
      target.connection_id,
      company.id
    );
    if (connection) selection.push({ platform: target.platform, connectionId: target.connection_id });
  }
  if (!selection.length) return apiError(c, 422, 'restore_requires_connection');

  const timestamp = nowIso();
  const id = newId('post');
  await run(
    c.env,
    `INSERT INTO social_posts (id, company_id, title, body_ar, body_en, link_url, cta_label, hashtags,
       media_json, language, status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
    id,
    company.id,
    input.title || null,
    input.bodyAr || null,
    input.bodyEn || null,
    input.linkUrl || null,
    input.ctaLabel || null,
    input.hashtags || null,
    JSON.stringify(input.media),
    input.language,
    actor.id,
    timestamp,
    timestamp
  );
  try {
    await syncTargets(c.env, company.id, id, input, selection);
  } catch (error) {
    await run(c.env, 'DELETE FROM social_posts WHERE id = ? AND company_id = ?', id, company.id);
    return apiError(c, 422, 'restore_targets_failed');
  }
  const created = await first<any>(c.env, 'SELECT * FROM social_posts WHERE id = ?', id);
  await saveVersion(c.env, created, actor.id, `restored_from_v${versionNumber}`, 1);
  await logEvent(c.env, {
    companyId: company.id,
    postId: id,
    kind: 'post.restored',
    detail: `from ${original.post.id} v${versionNumber}`,
    actorUserId: actor.id,
  });
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'social.post_restored',
    entityType: 'social_post',
    entityId: id,
    meta: { from: original.post.id, version: versionNumber },
  });

  const result = await loadPost(c.env, company.id, id);
  return c.json({ post: serializePost(result!.post, result!.targets) }, 201);
});

/**
 * Version snapshots are read here, not inside the post payload, so listing a
 * library page never ships the full history body.
 */
app.get('/:companyId/social/posts/:postId/versions/:version', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const versionNumber = Number(c.req.param('version'));
  const row = await first<any>(
    c.env,
    'SELECT * FROM social_post_versions WHERE post_id = ? AND company_id = ? AND version = ?',
    c.req.param('postId'),
    company.id,
    versionNumber
  );
  if (!row) return apiError(c, 404, 'version_not_found');
  return c.json({
    version: row.version,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    snapshot: parseJson<any>(row.snapshot_json, {}),
  });
});

app.post('/:companyId/social/posts/:postId/schedule', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (!loaded.post.approved_at) return apiError(c, 409, 'post_not_approved');

  const body = await readJson<{ scheduledAt?: string }>(c);
  const scheduledAt = str(body.scheduledAt, 40);
  const when = Date.parse(scheduledAt);
  if (!scheduledAt || Number.isNaN(when)) return apiError(c, 422, 'schedule_invalid');
  if (when < Date.now() - 60_000) return apiError(c, 422, 'schedule_in_past');

  await run(
    c.env,
    `UPDATE social_posts SET scheduled_at = ?, status = 'scheduled', updated_at = ? WHERE id = ? AND company_id = ?`,
    new Date(when).toISOString(),
    nowIso(),
    loaded.post.id,
    company.id
  );
  for (const target of loaded.targets) {
    if (target.status === 'published') continue;
    await enqueueTarget(c.env, {
      companyId: company.id,
      targetId: target.id,
      runAt: new Date(when).toISOString(),
    });
  }
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.scheduled',
    detail: new Date(when).toISOString(),
    actorUserId: c.get('user').id,
  });
  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});

app.post('/:companyId/social/posts/:postId/publish', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (!loaded.post.approved_at) return apiError(c, 409, 'post_not_approved');
  if (!loaded.targets.length) return apiError(c, 422, 'targets_required');

  const pending = loaded.targets.filter((target) => target.status !== 'published');
  if (!pending.length) return apiError(c, 409, 'post_already_published');

  const outcomes: Array<{ targetId: string; platform: string; status: string; errorCode?: string }> = [];
  for (const target of pending) {
    const outcome = await publishTarget(c.env, { companyId: company.id, targetId: target.id });
    outcomes.push({
      targetId: target.id,
      platform: target.platform,
      status: outcome.status,
      errorCode: outcome.errorCode,
    });
  }
  await recomputePostStatus(c.env, loaded.post.id);
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.publish_requested',
    detail: JSON.stringify(outcomes).slice(0, 400),
    actorUserId: actor.id,
  });

  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets), outcomes });
});

app.post('/:companyId/social/posts/:postId/cancel', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  if (loaded.post.status === 'published') return apiError(c, 409, 'post_already_published');

  await run(
    c.env,
    'UPDATE social_jobs SET state = \'cancelled\', updated_at = ? WHERE company_id = ? AND target_id IN (SELECT id FROM social_post_targets WHERE post_id = ?)',
    nowIso(),
    company.id,
    loaded.post.id
  );
  await run(
    c.env,
    `UPDATE social_posts SET status = 'cancelled', updated_at = ? WHERE id = ? AND company_id = ?`,
    nowIso(),
    loaded.post.id,
    company.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.cancelled',
    actorUserId: actor.id,
  });
  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});

app.post('/:companyId/social/posts/:postId/archive', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), APPROVE)) return apiError(c, 403, 'forbidden');
  const loaded = await loadPost(c.env, company.id, c.req.param('postId'));
  if (!loaded) return apiError(c, 404, 'post_not_found');
  await run(
    c.env,
    `UPDATE social_posts SET status = 'archived', updated_at = ? WHERE id = ? AND company_id = ?`,
    nowIso(),
    loaded.post.id,
    company.id
  );
  await logEvent(c.env, {
    companyId: company.id,
    postId: loaded.post.id,
    kind: 'post.archived',
    actorUserId: actor.id,
  });
  const result = await loadPost(c.env, company.id, loaded.post.id);
  return c.json({ post: serializePost(result!.post, result!.targets) });
});

// ---------------------------------------------------------------------------
// Queue and activity
// ---------------------------------------------------------------------------

app.get('/:companyId/social/jobs', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const rows = await all<any>(
    c.env,
    `SELECT j.*, t.platform, t.account_name, t.status AS target_status, p.title AS post_title
       FROM social_jobs j
       JOIN social_post_targets t ON t.id = j.target_id
       LEFT JOIN social_posts p ON p.id = t.post_id
      WHERE j.company_id = ? ORDER BY j.run_at DESC LIMIT 100`,
    company.id
  );
  return c.json({
    scheduler: {
      state: Boolean((c.env as any).JOBS_SECRET) ? 'configured' : 'blocked_by_hosting',
      execution: 'manual_or_external',
      automatic: false,
    },
    jobs: rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      accountName: row.account_name,
      postTitle: row.post_title,
      targetStatus: row.target_status,
      state: row.state,
      runAt: row.run_at,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
  });
});

app.post('/:companyId/social/jobs/run', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), MANAGE)) return apiError(c, 403, 'forbidden');
  const results = await runDueJobs(c.env, { companyId: company.id, limit: 10 });
  return c.json({
    ran: results.length,
    outcomes: results.map((item) => ({
      targetId: item.targetId,
      status: item.outcome.status,
      errorCode: item.outcome.errorCode ?? null,
    })),
  });
});

app.get('/:companyId/social/events', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), CREATE) && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const rows = await all<any>(
    c.env,
    'SELECT * FROM social_events WHERE company_id = ? ORDER BY created_at DESC LIMIT 100',
    company.id
  );
  return c.json({
    events: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      detail: row.detail,
      postId: row.post_id,
      targetId: row.target_id,
      connectionId: row.connection_id,
      actorUserId: row.actor_user_id,
      createdAt: row.created_at,
    })),
  });
});

export default app;
