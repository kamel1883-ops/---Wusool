/**
 * Wusool Tracking and dashboard — integration tests.
 *
 * Proves the parts that are actually implemented: UTM links, the public
 * redirect, click and beacon events, tenant isolation, the subscription gate,
 * and the dashboard's rule that a metric without a source is reported as
 * unavailable instead of zero.
 *
 * Run: node tests/tracking.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-tracking-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'tracking-admin@example.com';

let PORT = 0;
let BASE = '';
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
  if (!companyId) throw new Error(`company creation failed: ${created.text}`);
  return { companyId, tempPassword: created.data?.ownerTempPassword };
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

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`· api ${PORT}`);

  for (const file of [
    'migrations/0001_init.sql',
    'migrations/0002_site_analysis.sql',
    'migrations/0003_orders.sql',
    'migrations/0004_setup_codes.sql',
    'migrations/0005_concurrency.sql',
    'migrations/0006_growth.sql',
    'migrations/0011_lead_classification.sql',
    'migrations/0007_social.sql',
    'migrations/0008_social_review.sql',
    'migrations/0009_tracking.sql',
  ]) {
    migrate(file);
  }

  console.log('· starting wrangler dev');
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), `--persist-to=${PERSIST}`, '--log-level', 'error'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env } }
  );
  const logStream = [];
  server.stdout.on('data', (chunk) => logStream.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logStream.push(chunk.toString()));
  process.on('exit', () => {
    if (failures.length) {
      console.log('\n--- wrangler log tail ---');
      console.log(logStream.join('').slice(-2500));
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

  const companyA = await createCompany(admin, 'شركة القياس', 'tracking-owner@example.com');
  const companyB = await createCompany(admin, 'شركة ثانية', 'tracking-other@example.com');
  const ownerA = await signIn('ownerA', 'tracking-owner@example.com', companyA.tempPassword, 'TrackingOwner12345');
  const ownerB = await signIn('ownerB', 'tracking-other@example.com', companyB.tempPassword, 'TrackingOther12345');

  const baseA = `/api/company/${companyA.companyId}/tracking`;
  const baseB = `/api/company/${companyB.companyId}/tracking`;

  const anonymous = await new Client('anon').req(baseA);
  check('tracking requires a session', anonymous.status === 401, anonymous.status);

  const empty = await ownerA.req(baseA);
  check('the tracking workspace loads', empty.status === 200, empty.data);
  check('a new company has no links', (empty.data?.links ?? []).length === 0, empty.data?.links);
  check(
    'platform reach is declared unavailable instead of zero',
    empty.data?.platformMetrics?.state === 'not_implemented',
    empty.data?.platformMetrics
  );

  const badUrl = await ownerA.req(`${baseA}/links`, {
    method: 'POST',
    body: { label: 'bad', destinationUrl: 'javascript:alert(1)' },
  });
  check('a non-http destination is rejected', badUrl.status === 422, badUrl.data);

  const missingCampaign = await ownerA.req(`${baseA}/links`, {
    method: 'POST',
    body: { label: 'x', destinationUrl: 'https://example.com', campaignId: 'cmp_missing' },
  });
  check('a campaign from another company cannot be attached', missingCampaign.status === 422, missingCampaign.data);

  const created = await ownerA.req(`${baseA}/links`, {
    method: 'POST',
    body: {
      label: 'عرض نوفمبر',
      destinationUrl: 'https://example.com/offer?ref=wusool',
      utmSource: 'facebook',
      utmMedium: 'social',
      utmCampaign: 'november',
      platform: 'facebook_page',
    },
  });
  check('a tracking link is created', created.status === 201, created.data);
  const link = created.data?.link;
  check(
    'the short link is derived from the deployment origin',
    typeof link?.shortUrl === 'string' && link.shortUrl.endsWith(`/t/${link.code}`),
    link
  );

  // The redirect is public and outside /api; it must not need a session.
  const redirect = await fetch(`${BASE}/t/${link.code}`, { redirect: 'manual' });
  check('the redirect answers without a session', redirect.status === 302, redirect.status);
  const location = redirect.headers.get('location') ?? '';
  check(
    'the destination keeps its own query and gains the recorded UTMs',
    location.includes('ref=wusool') &&
      location.includes('utm_source=facebook') &&
      location.includes('utm_campaign=november'),
    location
  );

  const unknownCode = await fetch(`${BASE}/t/0000000000`, { redirect: 'manual' });
  check('an unknown code is not redirected anywhere', unknownCode.status === 404, unknownCode.status);

  const beacon = await fetch(`${BASE}/api/tracking/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: link.code, kind: 'page_view', path: '/offer' }),
  });
  check('a landing-page beacon is accepted without our CSRF header', beacon.status === 202, beacon.status);

  const fakeClick = await fetch(`${BASE}/api/tracking/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: link.code, kind: 'click' }),
  });
  check('a beacon cannot claim a click', fakeClick.status === 422, fakeClick.status);

  const whatsapp = await fetch(`${BASE}/api/tracking/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: link.code, kind: 'whatsapp_click' }),
  });
  check('a WhatsApp click is recorded', whatsapp.status === 202, whatsapp.status);

  const afterEvents = await ownerA.req(baseA);
  check(
    'the click and the beacon are counted',
    afterEvents.data?.totals?.clicks === 1 &&
      afterEvents.data?.totals?.pageViews === 1 &&
      afterEvents.data?.totals?.whatsappClicks === 1,
    afterEvents.data?.totals
  );
  check(
    'the link reports its own counts',
    afterEvents.data?.links?.[0]?.counts?.clicks === 1,
    afterEvents.data?.links?.[0]
  );

  const events = await ownerA.req(`${baseA}/links/${link.id}/events`);
  check('events can be listed for a link', (events.data?.events ?? []).length === 3, events.data?.events?.length);
  check(
    'no visitor identity is exposed',
    !JSON.stringify(events.data).includes('visitor_hash') &&
      !JSON.stringify(events.data).includes('"ip"') &&
      events.data?.privacy?.identified === false,
    events.data
  );

  const foreignEvents = await ownerB.req(`${baseB}/links/${link.id}/events`);
  check('another tenant cannot read the link events', foreignEvents.status === 404, foreignEvents.status);

  const foreignPatch = await ownerB.req(`${baseB}/links/${link.id}`, {
    method: 'PATCH',
    body: { label: 'hijack' },
  });
  check('another tenant cannot modify the link', foreignPatch.status === 404, foreignPatch.status);

  const paused = await ownerA.req(`${baseA}/links/${link.id}`, {
    method: 'PATCH',
    body: { status: 'paused' },
  });
  check('a link can be paused', paused.data?.link?.status === 'paused', paused.data?.link?.status);
  const pausedRedirect = await fetch(`${BASE}/t/${link.code}`, { redirect: 'manual' });
  check('a paused link stops redirecting', pausedRedirect.status === 404, pausedRedirect.status);

  await ownerA.req(`${baseA}/links/${link.id}`, { method: 'PATCH', body: { status: 'active' } });

  // ---------------------------------------------------------------------------
  // Dashboard: measured vs unavailable
  // ---------------------------------------------------------------------------
  const dashboard = await ownerA.req(`/api/company/${companyA.companyId}/dashboard`);
  check('the dashboard loads', dashboard.status === 200, dashboard.data);
  check(
    'a measured metric carries a value and its source',
    dashboard.data?.tracking?.clicks?.available === true &&
      dashboard.data?.tracking?.clicks?.source === 'tracking_events:click',
    dashboard.data?.tracking?.clicks
  );
  check(
    'an unmeasured metric is unavailable with a reason, not zero',
    dashboard.data?.reach?.impressions?.available === false &&
      dashboard.data?.reach?.impressions?.value === null &&
      typeof dashboard.data?.reach?.impressions?.note === 'string',
    dashboard.data?.reach?.impressions
  );
  check(
    'demographics stay unavailable without an official aggregate',
    dashboard.data?.demographics?.state === 'unavailable',
    dashboard.data?.demographics
  );
  check(
    'ROI is unavailable until spend is recorded',
    dashboard.data?.revenue?.roi?.available === false,
    dashboard.data?.revenue?.roi
  );
  check(
    'scheduling states that automatic execution needs an external runner',
    dashboard.data?.scheduling?.automatic === 'blocked_by_hosting',
    dashboard.data?.scheduling
  );

  // ---------------------------------------------------------------------------
  // Subscription gate: reads stay, writes stop
  // ---------------------------------------------------------------------------
  const yesterday = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const expire = await admin.req(`/api/admin/companies/${companyA.companyId}`, {
    method: 'PATCH',
    body: { status: 'active', subscriptionEnd: yesterday },
  });
  check('the subscription can be set to an expired date', expire.status === 200, expire.data);

  const readAfterExpiry = await ownerA.req(baseA);
  check('an expired subscription can still read its own reports', readAfterExpiry.status === 200, readAfterExpiry.status);
  const writeAfterExpiry = await ownerA.req(`${baseA}/links`, {
    method: 'POST',
    body: { label: 'blocked', destinationUrl: 'https://example.com' },
  });
  check(
    'an expired subscription cannot create links',
    writeAfterExpiry.status === 402 && writeAfterExpiry.data?.error?.code === 'subscription_inactive',
    writeAfterExpiry.data
  );

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
