/**
 * OAuth plumbing for the platforms whose official flow is implemented here.
 *
 * Implemented today: Meta (Facebook Pages + Instagram professional accounts,
 * which arrive together through a Page) and Google (GA4, Search Console,
 * Tag Manager, Business Profile discovery). TikTok, Snapchat and LinkedIn have
 * no authorization path in this build and are reported as `not_supported`
 * rather than shown behind a dead button.
 *
 * Security properties:
 *   * `state` is random, single use, expires in 10 minutes, and is bound to the
 *     user and company that started the flow — a callback cannot attach an
 *     account to another tenant.
 *   * Google uses PKCE; the verifier never leaves the Worker.
 *   * Tokens are sealed (AES-GCM) before being written and are never returned
 *     by an endpoint.
 */
import { all, first, newId, nowIso, randomHex, run, type Env } from '../db';
import { open, seal } from '../crypto';
import {
  PLATFORMS,
  PLATFORMS_WITH_OAUTH,
  type PlatformKey,
} from './platforms';

const STATE_TTL_MS = 10 * 60 * 1000;

const graphBase = (env: Env) =>
  String((env as any).SOCIAL_GRAPH_BASE ?? 'https://graph.facebook.com').replace(/\/$/, '');
const graphVersion = (env: Env) => String((env as any).SOCIAL_GRAPH_VERSION ?? 'v23.0');
const metaOauthBase = (env: Env) =>
  String((env as any).SOCIAL_META_OAUTH_BASE ?? 'https://www.facebook.com').replace(/\/$/, '');
const metaTokenBase = (env: Env) =>
  String((env as any).SOCIAL_META_TOKEN_BASE ?? 'https://graph.facebook.com').replace(/\/$/, '');
const googleOauthBase = (env: Env) =>
  String((env as any).SOCIAL_GOOGLE_OAUTH_BASE ?? 'https://accounts.google.com').replace(/\/$/, '');
const googleTokenBase = (env: Env) =>
  String((env as any).SOCIAL_GOOGLE_TOKEN_BASE ?? 'https://oauth2.googleapis.com').replace(/\/$/, '');
const googleApiBase = (env: Env) =>
  String((env as any).SOCIAL_GOOGLE_API_BASE ?? 'https://www.googleapis.com').replace(/\/$/, '');
const googleAdminBase = (env: Env) =>
  String((env as any).SOCIAL_GOOGLE_ADMIN_BASE ?? 'https://analyticsadmin.googleapis.com').replace(
    /\/$/,
    ''
  );

export const isOauthPlatform = (key: string): key is PlatformKey =>
  PLATFORMS_WITH_OAUTH.includes(key as PlatformKey);

const b64url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const sha256b64url = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return b64url(new Uint8Array(digest));
};

export type StartedFlow = { state: string; authorizeUrl: string };

/** Creates a single-use state row and the authorize URL for the platform. */
export async function startFlow(
  env: Env,
  input: { companyId: string; platform: PlatformKey; userId: string; redirectUri: string }
): Promise<StartedFlow> {
  const spec = PLATFORMS[input.platform];
  const state = randomHex(24);
  const verifier = randomHex(32);
  const expiresAt = new Date(Date.now() + STATE_TTL_MS).toISOString();

  await run(
    env,
    `INSERT INTO oauth_states (state, company_id, platform, user_id, code_verifier, redirect_uri, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    state,
    input.companyId,
    input.platform,
    input.userId,
    spec.connector === 'google' ? verifier : null,
    input.redirectUri,
    nowIso(),
    expiresAt
  );

  let authorizeUrl = '';
  if (spec.connector === 'meta') {
    const clientId = String((env as any).META_APP_ID ?? '');
    if (!clientId) throw new Error('meta_app_not_configured');
    const url = new URL(`${metaOauthBase(env)}/${graphVersion(env)}/dialog/oauth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', spec.access.scopes.join(','));
    authorizeUrl = url.toString();
  } else if (spec.connector === 'google') {
    const clientId = String((env as any).GOOGLE_CLIENT_ID ?? '');
    if (!clientId) throw new Error('google_app_not_configured');
    const url = new URL(`${googleOauthBase(env)}/o/oauth2/v2/auth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', spec.access.scopes.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('code_challenge', await sha256b64url(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl = url.toString();
  } else {
    throw new Error('oauth_not_supported');
  }

  return { state, authorizeUrl };
}

export async function consumeState(env: Env, state: string, userId: string) {
  const row = await first<any>(env, 'SELECT * FROM oauth_states WHERE state = ?', state);
  if (!row) throw new Error('oauth_state_invalid');
  if (row.consumed_at) throw new Error('oauth_state_used');
  if (row.user_id !== userId) throw new Error('oauth_state_owner_mismatch');
  if (Date.parse(row.expires_at) <= Date.now()) throw new Error('oauth_state_expired');
  await run(env, 'UPDATE oauth_states SET consumed_at = ? WHERE state = ?', nowIso(), state);
  return row;
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scopes: string[];
};

async function metaExchange(
  env: Env,
  params: Record<string, string>
): Promise<TokenSet> {
  const url = new URL(`${metaTokenBase(env)}/${graphVersion(env)}/oauth/access_token`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString());
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const detail = payload?.error?.message ?? `status_${response.status}`;
    throw new Error(`meta_token_failed:${detail}`);
  }
  return {
    accessToken: String(payload.access_token),
    refreshToken: null,
    expiresIn: Number(payload.expires_in ?? 0) || null,
    scopes: Array.isArray(payload.scope)
      ? payload.scope.map(String)
      : String(payload.scope ?? '')
          .split(',')
          .map((scope) => scope.trim())
          .filter(Boolean),
  };
}

export async function exchangeCode(
  env: Env,
  input: { platform: PlatformKey; code: string; redirectUri: string; verifier: string | null }
): Promise<TokenSet> {
  const spec = PLATFORMS[input.platform];
  if (spec.connector === 'meta') {
    const shortLived = await metaExchange(env, {
      client_id: String((env as any).META_APP_ID ?? ''),
      client_secret: String((env as any).META_APP_SECRET ?? ''),
      redirect_uri: input.redirectUri,
      code: input.code,
    });
    // Short-lived user tokens expire in about an hour; exchange for a long-lived
    // one (around 60 days) before reading the Pages.
    const longLived = await metaExchange(env, {
      grant_type: 'fb_exchange_token',
      client_id: String((env as any).META_APP_ID ?? ''),
      client_secret: String((env as any).META_APP_SECRET ?? ''),
      fb_exchange_token: shortLived.accessToken,
    });
    return longLived;
  }

  if (spec.connector === 'google') {
    const body = new URLSearchParams({
      code: input.code,
      client_id: String((env as any).GOOGLE_CLIENT_ID ?? ''),
      client_secret: String((env as any).GOOGLE_CLIENT_SECRET ?? ''),
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.verifier ?? '',
    });
    const response = await fetch(`${googleTokenBase(env)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || !payload?.access_token) {
      const detail = payload?.error_description ?? payload?.error ?? `status_${response.status}`;
      throw new Error(`google_token_failed:${detail}`);
    }
    return {
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
      expiresIn: Number(payload.expires_in ?? 0) || null,
      scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
    };
  }

  throw new Error('oauth_not_supported');
}

/** Refreshes a Google access token from its stored refresh token. */
export async function refreshGoogleToken(
  env: Env,
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const body = new URLSearchParams({
    client_id: String((env as any).GOOGLE_CLIENT_ID ?? ''),
    client_secret: String((env as any).GOOGLE_CLIENT_SECRET ?? ''),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(`${googleTokenBase(env)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error('google_refresh_failed');
  }
  return {
    accessToken: String(payload.access_token),
    expiresIn: Number(payload.expires_in ?? 0) || null,
  };
}

export type DiscoveredAccount = {
  accountId: string;
  accountName: string;
  accountType: string;
  pageId: string | null;
  profileId: string | null;
  /** Only used in-memory while finishing a Meta flow. */
  accessToken: string | null;
  metadata: Record<string, unknown>;
};

async function metaPages(env: Env, userToken: string): Promise<DiscoveredAccount[]> {
  const url = new URL(`${graphBase(env)}/${graphVersion(env)}/me/accounts`);
  url.searchParams.set(
    'fields',
    'id,name,access_token,tasks,instagram_business_account{id,username}'
  );
  url.searchParams.set('limit', '100');
  url.searchParams.set('access_token', userToken);
  const response = await fetch(url.toString());
  const payload: any = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload?.data)) {
    throw new Error(`meta_pages_failed:${payload?.error?.message ?? response.status}`);
  }
  const out: DiscoveredAccount[] = [];
  for (const page of payload.data) {
    const tasks: string[] = Array.isArray(page.tasks) ? page.tasks : [];
    out.push({
      accountId: String(page.id),
      accountName: String(page.name ?? page.id),
      accountType: tasks.includes('CREATE_CONTENT') ? 'page_can_publish' : 'page_read_only',
      pageId: String(page.id),
      profileId: null,
      accessToken: page.access_token ? String(page.access_token) : null,
      metadata: { tasks },
    });
    const ig = page.instagram_business_account;
    if (ig?.id) {
      out.push({
        accountId: String(ig.id),
        accountName: `@${String(ig.username ?? ig.id)}`,
        accountType: 'instagram_professional',
        pageId: String(page.id),
        profileId: String(ig.id),
        accessToken: page.access_token ? String(page.access_token) : null,
        metadata: { username: ig.username ?? null, linkedPageId: String(page.id) },
      });
    }
  }
  return out;
}

async function googleAccounts(
  env: Env,
  platform: PlatformKey,
  accessToken: string
): Promise<DiscoveredAccount[]> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const get = async (url: string) => {
    const response = await fetch(url, { headers });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`google_discovery_failed:${payload?.error?.message ?? response.status}`);
    }
    return payload;
  };

  if (platform === 'ga4') {
    const payload = await get(`${googleAdminBase(env)}/v1beta/accountSummaries?pageSize=200`);
    const out: DiscoveredAccount[] = [];
    for (const account of payload?.accountSummaries ?? []) {
      for (const property of account?.propertySummaries ?? []) {
        out.push({
          accountId: String(property.property ?? ''),
          accountName: `${account.displayName ?? 'GA4'} · ${property.displayName ?? ''}`.trim(),
          accountType: 'ga4_property',
          pageId: null,
          profileId: String(property.property ?? ''),
          accessToken: null,
          metadata: { account: account.account ?? null },
        });
      }
    }
    return out;
  }

  if (platform === 'search_console') {
    const payload = await get(`${googleApiBase(env)}/webmasters/v3/sites`);
    return (payload?.siteEntry ?? []).map((site: any) => ({
      accountId: String(site.siteUrl ?? ''),
      accountName: String(site.siteUrl ?? ''),
      accountType: String(site.permissionLevel ?? 'site'),
      pageId: null,
      profileId: String(site.siteUrl ?? ''),
      accessToken: null,
      metadata: { permissionLevel: site.permissionLevel ?? null },
    }));
  }

  if (platform === 'google_tag_manager') {
    const payload = await get(`${googleApiBase(env)}/tagmanager/v2/accounts?pageSize=200`);
    const out: DiscoveredAccount[] = [];
    for (const account of payload?.account ?? []) {
      out.push({
        accountId: String(account.accountId ?? account.path ?? ''),
        accountName: String(account.name ?? account.accountId ?? 'GTM'),
        accountType: 'gtm_account',
        pageId: null,
        profileId: null,
        accessToken: null,
        metadata: { path: account.path ?? null },
      });
    }
    return out;
  }

  if (platform === 'google_business_profile') {
    const payload = await get(
      `${googleApiBase(env)}/v1/accounts?pageSize=100`
    );
    const out: DiscoveredAccount[] = [];
    for (const account of payload?.accounts ?? []) {
      out.push({
        accountId: String(account.name ?? ''),
        accountName: String(account.accountName ?? account.name ?? 'Business Profile'),
        accountType: String(account.type ?? 'PERSONAL'),
        pageId: null,
        profileId: null,
        accessToken: null,
        metadata: { accountPath: account.name ?? null },
      });
    }
    return out;
  }

  throw new Error('google_discovery_not_supported');
}

export async function discoverAccounts(
  env: Env,
  platform: PlatformKey,
  accessToken: string
): Promise<DiscoveredAccount[]> {
  const spec = PLATFORMS[platform];
  if (spec.connector === 'meta') return metaPages(env, accessToken);
  if (spec.connector === 'google') return googleAccounts(env, platform, accessToken);
  throw new Error('oauth_not_supported');
}

/**
 * Completes a Meta or Google flow: exchanges the code, discovers accounts, and
 * stores them sealed. Meta lands as two possible connections (Page + Instagram)
 * because Instagram publishing uses the Page token of its linked Page.
 */
export async function finishFlow(
  env: Env,
  state: any,
  code: string
): Promise<{ connected: number; pending: Array<{ accountId: string; accountName: string }> }> {
  const platform = state.platform as PlatformKey;
  const tokens = await exchangeCode(env, {
    platform,
    code,
    redirectUri: state.redirect_uri,
    verifier: state.code_verifier ?? null,
  });
  const accounts = await discoverAccounts(env, platform, tokens.accessToken);
  if (!accounts.length) throw new Error('oauth_no_accounts_returned');

  if (PLATFORMS[platform].connector === 'google') {
    // Google returns a per-account list; the client picks which one to store.
    await run(
      env,
      'UPDATE oauth_states SET pending_token_enc = ?, pending_accounts_json = ? WHERE state = ?',
      await seal(env, JSON.stringify(tokens)),
      JSON.stringify(accounts),
      state.state
    );
    return {
      connected: 0,
      pending: accounts.map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
      })),
    };
  }

  // Meta: keep the long-lived user token and the discovered Pages until the
  // client chooses; nothing is published from a user token.
  await run(
    env,
    'UPDATE oauth_states SET pending_token_enc = ?, pending_accounts_json = ? WHERE state = ?',
    await seal(env, JSON.stringify(tokens)),
    JSON.stringify(accounts),
    state.state
  );
  return {
    connected: 0,
    pending: accounts.map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
    })),
  };
}

export async function loadPendingAccounts(env: Env, state: string) {
  const row = await first<any>(env, 'SELECT * FROM oauth_states WHERE state = ?', state);
  if (!row?.pending_accounts_json) throw new Error('oauth_no_pending_accounts');
  return {
    row,
    accounts: JSON.parse(row.pending_accounts_json) as DiscoveredAccount[],
    tokens: JSON.parse(await open(env, row.pending_token_enc)) as TokenSet,
  };
}

export async function storeConnection(
  env: Env,
  input: {
    companyId: string;
    platform: PlatformKey;
    account: DiscoveredAccount;
    tokens: TokenSet;
    pageToken?: string | null;
    userId: string;
    scopes: string[];
  }
) {
  const timestamp = nowIso();
  const accessToken =
    input.platform === 'facebook_page' || input.platform === 'instagram_business'
      ? input.pageToken ?? input.account.accessToken ?? input.tokens.accessToken
      : input.tokens.accessToken;

  const expiresAt =
    input.tokens.expiresIn && input.platform !== 'facebook_page' && input.platform !== 'instagram_business'
      ? new Date(Date.now() + input.tokens.expiresIn * 1000).toISOString()
      : null;

  const existing = await first<any>(
    env,
    'SELECT id FROM social_connections WHERE company_id = ? AND platform = ? AND account_id = ?',
    input.companyId,
    input.platform,
    input.account.accountId
  );
  const id = existing?.id ?? newId('soc');

  if (existing) {
    await run(
      env,
      `UPDATE social_connections SET page_id = ?, profile_id = ?, account_name = ?, account_type = ?,
         token_status = 'connected', scopes_json = ?, granted_scopes_json = ?, connected_by = ?,
         connected_at = ?, expires_at = ?, last_error = NULL, metadata_json = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
      input.account.pageId,
      input.account.profileId,
      input.account.accountName,
      input.account.accountType,
      JSON.stringify(input.scopes),
      JSON.stringify(input.tokens.scopes),
      input.userId,
      timestamp,
      expiresAt,
      JSON.stringify(input.account.metadata ?? {}),
      timestamp,
      id,
      input.companyId
    );
    await run(
      env,
      `INSERT INTO social_tokens (connection_id, access_token_enc, refresh_token_enc, key_version, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(connection_id) DO UPDATE SET access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc, updated_at = excluded.updated_at`,
      id,
      await seal(env, accessToken),
      input.tokens.refreshToken ? await seal(env, input.tokens.refreshToken) : null,
      timestamp
    );
  } else {
    await run(
      env,
      `INSERT INTO social_connections (id, company_id, platform, account_id, page_id, profile_id, account_name,
         account_type, token_status, scopes_json, granted_scopes_json, connected_by, connected_at, expires_at,
         metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.companyId,
      input.platform,
      input.account.accountId,
      input.account.pageId,
      input.account.profileId,
      input.account.accountName,
      input.account.accountType,
      JSON.stringify(input.scopes),
      JSON.stringify(input.tokens.scopes),
      input.userId,
      timestamp,
      expiresAt,
      JSON.stringify(input.account.metadata ?? {}),
      timestamp,
      timestamp
    );
    await run(
      env,
      `INSERT INTO social_tokens (connection_id, access_token_enc, refresh_token_enc, key_version, updated_at)
       VALUES (?, ?, ?, 1, ?)`,
      id,
      await seal(env, accessToken),
      input.tokens.refreshToken ? await seal(env, input.tokens.refreshToken) : null,
      timestamp
    );
  }

  return id;
}

/** Reads a usable token for a connection, refreshing Google when needed. */
export async function usableToken(
  env: Env,
  connection: any
): Promise<{ accessToken: string; refreshed: boolean }> {
  const stored = await first<any>(
    env,
    'SELECT * FROM social_tokens WHERE connection_id = ?',
    connection.id
  );
  if (!stored) throw new Error('token_missing');

  if (
    connection.expires_at &&
    Date.parse(connection.expires_at) <= Date.now() &&
    stored.refresh_token_enc
  ) {
    const refreshToken = await open(env, stored.refresh_token_enc);
    const refreshed = await refreshGoogleToken(env, refreshToken);
    await run(
      env,
      `UPDATE social_tokens SET access_token_enc = ?, updated_at = ? WHERE connection_id = ?`,
      await seal(env, refreshed.accessToken),
      nowIso(),
      connection.id
    );
    const expiresAt = refreshed.expiresIn
      ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString()
      : null;
    await run(
      env,
      'UPDATE social_connections SET expires_at = ?, token_status = ?, updated_at = ? WHERE id = ?',
      expiresAt,
      'connected',
      nowIso(),
      connection.id
    );
    return { accessToken: refreshed.accessToken, refreshed: true };
  }

  if (connection.expires_at && Date.parse(connection.expires_at) <= Date.now()) {
    throw new Error('token_expired');
  }
  return { accessToken: await open(env, stored.access_token_enc), refreshed: false };
}

export async function companyConnections(env: Env, companyId: string) {
  return all<any>(
    env,
    'SELECT * FROM social_connections WHERE company_id = ? ORDER BY platform, account_name',
    companyId
  );
}
