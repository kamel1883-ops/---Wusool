/**
 * Social accounts, post approval and publishing — integration tests.
 *
 * A local server stands in for Meta and Google, so the real Worker code runs
 * the real flow: authorization code exchange, Page discovery, sealed token
 * storage, per-platform adaptation, approval gating, publishing, partial
 * failure, retry/backoff, idempotent re-publish and revocation handling.
 *
 * What this proves: the publishing path works against the documented endpoints
 * with the payloads we send. What it does not prove: that Meta grants access to
 * a given Page (that is an app-review and account fact, not code).
 *
 * Run: node tests/social.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-social-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'social-admin@example.com';
const JOBS_SECRET = 'test-jobs-secret';
const TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');

let PORT = 0;
let BASE = '';
let FAKE_PORT = 0;
let FAKE = '';

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` → ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

function migrate(file) {
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'wusool-db', '--local', `--persist-to=${PERSIST}`, `--file=${file}`],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`migration failed: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Fake provider: Meta Graph + Google APIs
// ---------------------------------------------------------------------------

const state = { feedCalls: [], tokenExchanges: 0 };

function startFakeProvider() {
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${FAKE_PORT}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    const json = (payload, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };

    if (url.pathname.endsWith('/oauth/access_token')) {
      state.tokenExchanges += 1;
      const isLongLived = url.searchParams.get('grant_type') === 'fb_exchange_token';
      return json({
        access_token: isLongLived ? 'FAKE_LONG_USER_TOKEN' : 'FAKE_USER_TOKEN',
        token_type: 'bearer',
        expires_in: 5_184_000,
        scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
      });
    }

    if (url.pathname.endsWith('/me/accounts')) {
      return json({
        data: [
          {
            id: 'PAGE123',
            name: 'Test Page',
            access_token: 'FAKE_PAGE_TOKEN',
            tasks: ['CREATE_CONTENT', 'MODERATE'],
            instagram_business_account: { id: 'IG456', username: 'test_ig' },
          },
        ],
      });
    }

    if (/\/PAGE123\/feed$/.test(url.pathname) && request.method === 'POST') {
      const params = new URLSearchParams(body);
      const message = params.get('message') ?? '';
      state.feedCalls.push({ message, token: params.get('access_token') });
      if (message.includes('TRIGGER_190')) {
        return json(
          { error: { message: 'Error validating access token: Session has expired', code: 190 } },
          400
        );
      }
      if (message.includes('TRIGGER_FAIL')) {
        return json({ error: { message: 'temporarily unavailable', code: 2 } }, 500);
      }
      return json({ id: 'PAGE123_777' });
    }

    if (/\/IG456\/media$/.test(url.pathname) && request.method === 'POST') {
      const params = new URLSearchParams(body);
      if ((params.get('image_url') ?? '').includes('fail')) {
        return json({ error: { message: 'Media could not be fetched', code: 9004 } }, 400);
      }
      return json({ id: 'CONTAINER1' });
    }

    if (/\/IG456\/media_publish$/.test(url.pathname) && request.method === 'POST') {
      return json({ id: 'IG_MEDIA_1' });
    }

    if (/\/IG_MEDIA_1$/.test(url.pathname)) {
      return json({ permalink: 'https://www.instagram.com/p/AbCdEf/' });
    }

    // Google
    if (url.pathname === '/token' && request.method === 'POST') {
      return json({
        access_token: 'FAKE_GOOGLE_TOKEN',
        refresh_token: 'FAKE_GOOGLE_REFRESH',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/analytics.readonly',
      });
    }
    if (url.pathname.endsWith('/v1beta/accountSummaries')) {
      return json({
        accountSummaries: [
          {
            account: 'accounts/1',
            displayName: 'Acme Analytics',
            propertySummaries: [{ property: 'properties/42', displayName: 'Main site' }],
          },
        ],
      });
    }
    if (url.pathname.endsWith('/webmasters/v3/sites')) return json({ siteEntry: [] });
    if (url.pathname.endsWith('/tagmanager/v2/accounts')) return json({ account: [] });
    if (url.pathname.endsWith('/v1/accounts')) {
      return json({ accounts: [{ name: 'accounts/9', accountName: 'Acme GBP', type: 'PERSONAL' }] });
    }

    return json({ error: { message: `unexpected ${request.method} ${url.pathname}` } }, 404);
  });

  return new Promise((resolve) => {
    server.listen(FAKE_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------

async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/api/public/branding`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('server did not start');
}

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async req(path, options = {}) {
    const headers = { 'x-wusool-client': 'web', ...(options.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
    });
    for (const entry of response.headers.getSetCookie?.() ?? []) {
      const pair = entry.split(';')[0];
      if (pair.startsWith('ws_session=')) this.cookie = pair;
    }
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await response.json().catch(() => null) : null;
    return {
      status: response.status,
      data,
      text: data ? JSON.stringify(data) : '',
      location: response.headers.get('location'),
    };
  }
}

async function signIn(label, email, password, newPassword) {
  const client = new Client(label);
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200) throw new Error(`${label} login failed: ${login.status} ${login.text}`);
  if (newPassword) {
    const changed = await client.req('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: password, newPassword },
    });
    if (changed.status !== 200) throw new Error(`${label} password change failed: ${changed.text}`);
  }
  return client;
}

async function createCompany(admin, name, email) {
  const created = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name,
      ownerEmail: email,
      ownerName: 'مالك الشركة',
      status: 'active',
      subscriptionStart: '2025-01-01',
      subscriptionEnd: '2027-12-31',
    },
  });
  const companyId = created.data?.companyId ?? created.data?.company?.id ?? created.data?.id;
  return { companyId, tempPassword: created.data?.ownerTempPassword, created };
}

let server;
function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    try {
      server.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  FAKE_PORT = await freePort();
  FAKE = `http://127.0.0.1:${FAKE_PORT}`;
  console.log(`· api ${PORT} · fake provider ${FAKE_PORT}`);

  for (const file of [
    'migrations/0001_init.sql',
    'migrations/0002_site_analysis.sql',
    'migrations/0003_orders.sql',
    'migrations/0004_setup_codes.sql',
    'migrations/0005_concurrency.sql',
    'migrations/0006_growth.sql',
    'migrations/0007_social.sql',
  ]) {
    migrate(file);
  }

  const fake = await startFakeProvider();

  console.log('· starting wrangler dev');
  const vars = [
    `META_APP_ID:test-app-id`,
    `META_APP_SECRET:test-app-secret`,
    `SOCIAL_TOKEN_KEY:${TOKEN_KEY}`,
    `JOBS_SECRET:${JOBS_SECRET}`,
    `SOCIAL_GRAPH_BASE:${FAKE}`,
    `SOCIAL_META_OAUTH_BASE:${FAKE}`,
    `SOCIAL_META_TOKEN_BASE:${FAKE}`,
    `SOCIAL_GOOGLE_OAUTH_BASE:${FAKE}`,
    `SOCIAL_GOOGLE_TOKEN_BASE:${FAKE}`,
    `SOCIAL_GOOGLE_API_BASE:${FAKE}`,
    `SOCIAL_GOOGLE_ADMIN_BASE:${FAKE}`,
    `GOOGLE_CLIENT_ID:test-google-id`,
    `GOOGLE_CLIENT_SECRET:test-google-secret`,
  ].flatMap((value) => ['--var', value]);

  server = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), `--persist-to=${PERSIST}`, '--log-level', 'error', ...vars],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env } }
  );
  const logStream = [];
  server.stdout.on('data', (chunk) => logStream.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logStream.push(chunk.toString()));
  process.on('exit', () => {
    if (failures.length) {
      console.log('\n--- wrangler log tail ---');
      console.log(logStream.join('').slice(-3000));
    }
  });

  await waitForServer();
  console.log('· server ready\n');

  const admin = new Client('admin');
  const start = await admin.req('/api/setup/start', { method: 'POST', body: { email: SEED_ADMIN } });
  const verify = await admin.req('/api/setup/verify', {
    method: 'POST',
    body: { email: SEED_ADMIN, code: start.data.code },
  });
  await admin.req('/api/setup', {
    method: 'POST',
    body: {
      name: 'Platform Admin',
      email: SEED_ADMIN,
      password: 'AdminPass12345',
      setupToken: verify.data.setupToken,
    },
  });

  const companyA = await createCompany(admin, 'شركة النشر', 'publish-owner@example.com');
  const companyB = await createCompany(admin, 'شركة أخرى', 'other-owner@example.com');
  const ownerA = await signIn('ownerA', 'publish-owner@example.com', companyA.tempPassword, 'PublishOwner12345');
  const ownerB = await signIn('ownerB', 'other-owner@example.com', companyB.tempPassword, 'OtherOwner12345');

  const baseA = `/api/company/${companyA.companyId}/social`;
  const baseB = `/api/company/${companyB.companyId}/social`;

  // -------------------------------------------------------------------------
  // Platform truth
  // -------------------------------------------------------------------------
  const anonymous = await new Client('anon').req(baseA);
  check('social overview requires a session', anonymous.status === 401, anonymous.status);

  const overview = await ownerA.req(baseA);
  check('social overview loads', overview.status === 200, overview.data);
  const platforms = overview.data?.platforms ?? [];
  check('all eleven channels are listed', platforms.length === 11, platforms.length);

  const byKey = Object.fromEntries(platforms.map((item) => [item.key, item]));
  check(
    'Facebook is connectable but does not claim advanced access',
    byKey.facebook_page?.availability === 'available' && byKey.facebook_page?.reviewPending === true,
    byKey.facebook_page
  );
  check(
    'email reports the credentials it actually needs',
    byKey.email?.availability === 'requires_credentials' &&
      byKey.email?.availabilityReasons?.includes('EMAIL_API_KEY'),
    byKey.email
  );
  check(
    'TikTok is reported as not supported instead of offering a dead button',
    byKey.tiktok_business?.availability === 'not_supported',
    byKey.tiktok_business?.availability
  );
  check(
    'the capability matrix is served, not hardcoded in the client',
    byKey.instagram_business?.capabilities?.publishText === false &&
      byKey.instagram_business?.limits?.requiresMedia === true,
    byKey.instagram_business
  );
  check(
    'scheduler readiness is reported from the server secret',
    overview.data?.setup?.scheduler === 'configured',
    overview.data?.setup
  );

  const tiktokStart = await ownerA.req(`${baseA}/oauth/start`, {
    method: 'POST',
    body: { platform: 'tiktok_business' },
  });
  check(
    'starting an unsupported OAuth flow is refused with a stable code',
    tiktokStart.status === 409 && tiktokStart.data?.error?.code === 'oauth_not_supported',
    tiktokStart.data
  );

  // -------------------------------------------------------------------------
  // Meta OAuth: start → callback → choose account
  // -------------------------------------------------------------------------
  const started = await ownerA.req(`${baseA}/oauth/start`, {
    method: 'POST',
    body: { platform: 'facebook_page' },
  });
  check('Meta authorization starts', started.status === 200, started.data);
  const authorizeUrl = new URL(started.data.authorizeUrl);
  check(
    'the authorize URL is the official dialog with the requested scopes',
    authorizeUrl.host === `127.0.0.1:${FAKE_PORT}` &&
      authorizeUrl.searchParams.get('scope')?.includes('pages_manage_posts'),
    started.data.authorizeUrl
  );
  const oauthState = started.data.state;

  const badState = await ownerA.req(`${baseA}/oauth/callback?code=x&state=nope`, { method: 'GET' });
  check(
    'an unknown state is refused before any token exchange',
    badState.location?.includes('oauth=invalid'),
    badState.location
  );

  const callback = await ownerA.req(`${baseA}/oauth/callback?code=good-code&state=${oauthState}`, {
    method: 'GET',
  });
  check(
    'a valid callback lands on the account picker',
    callback.location?.includes('oauth=select'),
    callback.location
  );

  const replay = await ownerA.req(`${baseA}/oauth/callback?code=good-code&state=${oauthState}`, {
    method: 'GET',
  });
  check('an OAuth state cannot be reused', replay.location?.includes('oauth=used'), replay.location);

  const pending = await ownerA.req(`${baseA}/oauth/pending?state=${oauthState}`);
  check('the Page and its Instagram account are discovered', pending.data?.accounts?.length === 2, pending.data);

  const foreignComplete = await ownerB.req(`${baseB}/oauth/complete`, {
    method: 'POST',
    body: { state: oauthState, accountIds: ['PAGE123'] },
  });
  check(
    'another tenant cannot finish someone else authorization',
    foreignComplete.status === 403 || foreignComplete.status === 404,
    foreignComplete.data
  );

  const completed = await ownerA.req(`${baseA}/oauth/complete`, {
    method: 'POST',
    body: { state: oauthState, accountIds: ['PAGE123', 'IG456'] },
  });
  check('choosing the Page stores the connection', completed.status === 200, completed.data);
  check('the flow reports both connected accounts', completed.data?.connected?.length === 2, completed.data);

  const afterConnect = await ownerA.req(baseA);
  const fbConnection = (afterConnect.data?.connections ?? []).find((c) => c.platform === 'facebook_page');
  check('the connection is listed for its company', Boolean(fbConnection), afterConnect.data?.connections);
  check(
    'the token is never returned by the API',
    !JSON.stringify(afterConnect.data).includes('FAKE_PAGE_TOKEN') &&
      !JSON.stringify(afterConnect.data).includes('FAKE_LONG_USER_TOKEN'),
    'a provider token appeared in the response'
  );
  check(
    'expiry and granted scopes are exposed instead',
    Array.isArray(fbConnection?.grantedScopes) && fbConnection.grantedScopes.length > 0,
    fbConnection
  );

  const igFromSameFlow = (afterConnect.data?.connections ?? []).find(
    (c) => c.accountId === 'IG456'
  );
  check(
    'an Instagram account from the same Meta flow is stored as Instagram, not as a Page',
    igFromSameFlow?.platform === 'instagram_business',
    igFromSameFlow ?? afterConnect.data?.connections
  );
  check(
    'the Page keeps its own platform',
    fbConnection?.platform === 'facebook_page' && fbConnection?.accountId === 'PAGE123',
    fbConnection
  );

  const otherTenantView = await ownerB.req(baseB);
  check(
    'the other company sees no connection',
    (otherTenantView.data?.connections ?? []).length === 0,
    otherTenantView.data?.connections
  );

  // -------------------------------------------------------------------------
  // Adaptation and previews
  // -------------------------------------------------------------------------
  const previewPost = {
    title: 'عرض الخدمة',
    bodyAr: 'نص المنشور التجريبي',
    bodyEn: 'Draft body',
    linkUrl: 'https://example.com/offer',
    hashtags: '#تسويق #نمو',
    language: 'ar',
    media: [],
  };

  const preview = await ownerA.req(`${baseA}/preview`, {
    method: 'POST',
    body: { ...previewPost, platforms: ['facebook_page', 'instagram_business'] },
  });
  const previews = Object.fromEntries((preview.data?.previews ?? []).map((item) => [item.platform, item]));
  check('previews come from the server', preview.status === 200 && Object.keys(previews).length === 2, preview.data);
  check(
    'Facebook preview keeps the text and the link',
    previews.facebook_page?.status === 'ready' &&
      previews.facebook_page?.text?.includes('https://example.com/offer'),
    previews.facebook_page
  );
  check(
    'Instagram is blocked for a post without an image',
    previews.instagram_business?.status === 'blocked' &&
      previews.instagram_business?.issues?.some((issue) => issue.code === 'media_required'),
    previews.instagram_business
  );

  // -------------------------------------------------------------------------
  // Post lifecycle: draft cannot be approved or published directly
  // -------------------------------------------------------------------------
  const created = await ownerA.req(`${baseA}/posts`, {
    method: 'POST',
    body: {
      ...previewPost,
      targets: [{ platform: 'facebook_page', connectionId: fbConnection.id }],
    },
  });
  check('a post is created as a draft', created.status === 201 && created.data?.post?.status === 'draft', created.data);
  const postId = created.data?.post?.id;
  check(
    'the target carries the adapted text',
    created.data?.post?.targets?.[0]?.status === 'ready',
    created.data?.post?.targets
  );

  const earlyApprove = await ownerA.req(`${baseA}/posts/${postId}/approve`, { method: 'POST', body: {} });
  check(
    'a draft cannot be approved without submission',
    earlyApprove.status === 409 && earlyApprove.data?.error?.code === 'post_state_invalid',
    earlyApprove.data
  );

  const earlyPublish = await ownerA.req(`${baseA}/posts/${postId}/publish`, { method: 'POST', body: {} });
  check(
    'an unapproved post cannot publish, and nothing is sent',
    earlyPublish.status === 409 && state.feedCalls.length === 0,
    { status: earlyPublish.status, calls: state.feedCalls.length }
  );

  const submitted = await ownerA.req(`${baseA}/posts/${postId}/submit`, { method: 'POST', body: {} });
  check(
    'submitting moves the post to awaiting approval',
    submitted.data?.post?.status === 'awaiting_approval',
    submitted.data?.post?.status
  );

  const approved = await ownerA.req(`${baseA}/posts/${postId}/approve`, { method: 'POST', body: {} });
  check(
    'approval records who approved and when',
    approved.status === 200 && approved.data?.post?.status === 'approved' && Boolean(approved.data?.post?.approvedAt),
    approved.data?.post
  );

  const published = await ownerA.req(`${baseA}/posts/${postId}/publish`, { method: 'POST', body: {} });
  check(
    'the approved post publishes to the Page',
    published.status === 200 && published.data?.post?.status === 'published',
    published.data?.post?.status
  );
  const fbTarget = published.data?.post?.targets?.[0];
  check(
    'the external id and URL are stored',
    fbTarget?.externalId === 'PAGE123_777' &&
      fbTarget?.externalUrl === 'https://www.facebook.com/PAGE123_777',
    fbTarget
  );
  check('exactly one Page post was sent', state.feedCalls.length === 1, state.feedCalls);
  check(
    'the Page token — not the user token — was used',
    state.feedCalls[0]?.token === 'FAKE_PAGE_TOKEN',
    state.feedCalls[0]?.token
  );

  const republish = await ownerA.req(`${baseA}/posts/${postId}/publish`, { method: 'POST', body: {} });
  check(
    'publishing twice is refused and does not post again',
    republish.status === 409 && state.feedCalls.length === 1,
    { status: republish.status, calls: state.feedCalls.length }
  );

  const editAfterPublish = await ownerA.req(`${baseA}/posts/${postId}`, {
    method: 'PUT',
    body: { ...previewPost, bodyAr: 'تعديل بعد النشر' },
  });
  check(
    'a published post cannot be edited in place',
    editAfterPublish.status === 409 && editAfterPublish.data?.error?.code === 'post_already_published',
    editAfterPublish.data
  );

  const copy = await ownerA.req(`${baseA}/posts/${postId}/duplicate`, { method: 'POST', body: {} });
  check(
    'a copy is created instead, starting as a new draft',
    copy.status === 201 && copy.data?.post?.status === 'draft' && copy.data?.post?.id !== postId,
    copy.data?.post?.status
  );

  // -------------------------------------------------------------------------
  // Partial publication: Facebook succeeds, Instagram fails
  // -------------------------------------------------------------------------
  const igStarted = await ownerA.req(`${baseA}/oauth/start`, {
    method: 'POST',
    body: { platform: 'instagram_business' },
  });
  await ownerA.req(
    `${baseA}/oauth/callback?code=good-code-2&state=${igStarted.data.state}`,
    { method: 'GET' }
  );
  await ownerA.req(`${baseA}/oauth/complete`, {
    method: 'POST',
    body: { state: igStarted.data.state, accountIds: ['IG456'] },
  });
  const withIg = await ownerA.req(baseA);
  const igConnection = (withIg.data?.connections ?? []).find((c) => c.platform === 'instagram_business');
  check('the Instagram account is connected separately', Boolean(igConnection), withIg.data?.connections);

  const multi = await ownerA.req(`${baseA}/posts`, {
    method: 'POST',
    body: {
      ...previewPost,
      media: [{ url: 'https://cdn.example.com/poster-fail.jpg', kind: 'image' }],
      targets: [
        { platform: 'facebook_page', connectionId: fbConnection.id },
        { platform: 'instagram_business', connectionId: igConnection.id },
      ],
    },
  });
  const multiId = multi.data?.post?.id;
  const multiTargets = multi.data?.post?.targets ?? [];
  check(
    'both platforms produce their own target',
    multiTargets.length === 2 && multiTargets.every((target) => target.status === 'ready'),
    multiTargets
  );

  await ownerA.req(`${baseA}/posts/${multiId}/submit`, { method: 'POST', body: {} });
  await ownerA.req(`${baseA}/posts/${multiId}/approve`, { method: 'POST', body: {} });
  const before = state.feedCalls.length;
  const publishedMulti = await ownerA.req(`${baseA}/posts/${multiId}/publish`, { method: 'POST', body: {} });
  const targetsMulti = publishedMulti.data?.post?.targets ?? [];
  const fbMulti = targetsMulti.find((target) => target.platform === 'facebook_page');
  const igMulti = targetsMulti.find((target) => target.platform === 'instagram_business');
  check(
    'the post ends partially published',
    publishedMulti.data?.post?.status === 'partially_published',
    publishedMulti.data?.post?.status
  );
  check('Facebook stays published', fbMulti?.status === 'published', fbMulti);
  check(
    'Instagram records the real provider failure',
    igMulti?.status === 'failed' && igMulti?.errorCode === 'graph_9004',
    igMulti
  );
  check('Facebook was not re-posted in the retry', state.feedCalls.length === before + 1, state.feedCalls.length);

  const retry = await ownerA.req(`${baseA}/posts/${multiId}/publish`, { method: 'POST', body: {} });
  const retryTargets = retry.data?.post?.targets ?? [];
  check(
    'retrying touches only the failed platform',
    retryTargets.find((target) => target.platform === 'facebook_page')?.attempts ===
      fbMulti?.attempts &&
      retryTargets.find((target) => target.platform === 'instagram_business')?.attempts >
        igMulti?.attempts,
    retryTargets
  );
  check('no second Facebook post was created', state.feedCalls.length === before + 1, state.feedCalls.length);

  // -------------------------------------------------------------------------
  // Revoked token: the connection is marked for reconnect, not silently retried
  // -------------------------------------------------------------------------
  const revoked = await ownerA.req(`${baseA}/posts`, {
    method: 'POST',
    body: {
      ...previewPost,
      bodyAr: 'TRIGGER_190 نص',
      targets: [{ platform: 'facebook_page', connectionId: fbConnection.id }],
    },
  });
  const revokedId = revoked.data?.post?.id;
  await ownerA.req(`${baseA}/posts/${revokedId}/submit`, { method: 'POST', body: {} });
  await ownerA.req(`${baseA}/posts/${revokedId}/approve`, { method: 'POST', body: {} });
  const revokedPublish = await ownerA.req(`${baseA}/posts/${revokedId}/publish`, { method: 'POST', body: {} });
  const revokedTarget = revokedPublish.data?.post?.targets?.[0];
  check(
    'a revoked token is reported as a provider error',
    revokedTarget?.status === 'failed' && revokedTarget?.errorCode === 'graph_190',
    revokedTarget
  );
  const afterRevoke = await ownerA.req(baseA);
  const fbAfter = (afterRevoke.data?.connections ?? []).find((c) => c.platform === 'facebook_page');
  check(
    'the connection asks for a reconnect',
    fbAfter?.tokenStatus === 'requires_reconnect',
    fbAfter?.tokenStatus
  );

  // -------------------------------------------------------------------------
  // Queue, scheduling and the internal tick
  // -------------------------------------------------------------------------
  const scheduled = await ownerA.req(`${baseA}/posts`, {
    method: 'POST',
    body: {
      ...previewPost,
      bodyAr: 'منشور مجدول',
      scheduledAt: new Date(Date.now() + 4_000).toISOString(),
      targets: [{ platform: 'facebook_page', connectionId: fbConnection.id }],
    },
  });
  const scheduledId = scheduled.data?.post?.id;
  await ownerA.req(`${baseA}/posts/${scheduledId}/submit`, { method: 'POST', body: {} });
  const scheduledApprove = await ownerA.req(`${baseA}/posts/${scheduledId}/approve`, { method: 'POST', body: {} });
  check(
    'approving a post with a date queues it as scheduled',
    scheduledApprove.data?.post?.status === 'scheduled',
    scheduledApprove.data?.post?.status
  );
  const jobsBefore = await ownerA.req(`${baseA}/jobs`);
  check(
    'one job exists per target',
    (jobsBefore.data?.jobs ?? []).length === 1 &&
      jobsBefore.data?.jobs?.[0]?.state === 'pending',
    jobsBefore.data?.jobs
  );

  const noSecret = await fetch(`${BASE}/api/internal/social/tick`, { method: 'POST' });
  check('the scheduler endpoint rejects callers without the secret', noSecret.status === 401, noSecret.status);

  const withSecret = await fetch(`${BASE}/api/internal/social/tick`, {
    method: 'POST',
    headers: { 'x-wusool-jobs-secret': JOBS_SECRET },
  });
  check('the scheduler endpoint accepts the deployment secret', withSecret.status === 200, withSecret.status);

  await sleep(6_000);
  const drained = await ownerA.req(`${baseA}/jobs/run`, { method: 'POST', body: {} });
  check('a due job runs from the queue', drained.data?.ran === 1, drained.data);
  const scheduledAfter = await ownerA.req(`${baseA}/posts/${scheduledId}`);
  check(
    'the scheduled post published from the queue',
    scheduledAfter.data?.post?.status === 'published',
    scheduledAfter.data?.post?.status
  );
  const jobsAfter = await ownerA.req(`${baseA}/jobs`);
  check(
    'the job is marked done',
    jobsAfter.data?.jobs?.[0]?.state === 'done',
    jobsAfter.data?.jobs
  );

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  const disconnecting = await ownerA.req(`${baseA}/connections/${fbConnection.id}`, { method: 'DELETE' });
  check('a connection can be disconnected', disconnecting.status === 200, disconnecting.data);
  const afterDisconnect = await ownerA.req(baseA);
  check(
    'the connection is gone',
    (afterDisconnect.data?.connections ?? []).every((connection) => connection.id !== fbConnection.id),
    afterDisconnect.data?.connections
  );
  const publishedStill = await ownerA.req(`${baseA}/posts/${postId}`);
  check(
    'already published targets keep their record',
    publishedStill.data?.post?.targets?.[0]?.status === 'published',
    publishedStill.data?.post?.targets
  );

  // -------------------------------------------------------------------------
  // Google: GA4 flow and the per-account choice
  // -------------------------------------------------------------------------
  const ga4Start = await ownerA.req(`${baseA}/oauth/start`, {
    method: 'POST',
    body: { platform: 'ga4' },
  });
  check('Google authorization starts', ga4Start.status === 200, ga4Start.data);
  const ga4Url = new URL(ga4Start.data.authorizeUrl);
  check(
    'the Google flow uses PKCE and offline access',
    ga4Url.searchParams.get('code_challenge_method') === 'S256' &&
      ga4Url.searchParams.get('access_type') === 'offline',
    ga4Start.data.authorizeUrl
  );
  await ownerA.req(`${baseA}/oauth/callback?code=g-code&state=${ga4Start.data.state}`, { method: 'GET' });
  const ga4Pending = await ownerA.req(`${baseA}/oauth/pending?state=${ga4Start.data.state}`);
  check(
    'GA4 properties are discovered through the Admin API',
    ga4Pending.data?.accounts?.[0]?.accountId === 'properties/42',
    ga4Pending.data
  );
  const ga4Complete = await ownerA.req(`${baseA}/oauth/complete`, {
    method: 'POST',
    body: { state: ga4Start.data.state, accountIds: ['properties/42'] },
  });
  check('the GA4 property is stored for the company', ga4Complete.status === 200, ga4Complete.data);
  const finalOverview = await ownerA.req(baseA);
  const ga4 = (finalOverview.data?.connections ?? []).find((c) => c.platform === 'ga4');
  check('the GA4 connection reports its access-token expiry', Boolean(ga4?.expiresAt), ga4);
  check(
    'no Google token leaks either',
    !JSON.stringify(finalOverview.data).includes('FAKE_GOOGLE_TOKEN') &&
      !JSON.stringify(finalOverview.data).includes('FAKE_GOOGLE_REFRESH'),
    'a Google token appeared in the response'
  );

  // -------------------------------------------------------------------------
  // Tenant isolation on posts
  // -------------------------------------------------------------------------
  const crossPost = await ownerB.req(`${baseB}/posts/${postId}`);
  check(
    'another tenant cannot read the post by id',
    crossPost.status === 404,
    crossPost.status
  );

  fake.close();
  stopServer();
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failed checks:');
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  stopServer();
  process.exit(1);
});
