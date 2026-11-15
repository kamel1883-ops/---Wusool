/**
 * Provider integration tests: real-provider configuration surface, stable
 * failure codes, usage/cost recording, per-plan concurrency plumbing,
 * provenance labels and the guarantee that secrets never leak to the browser.
 *
 * No real API keys are used: the OpenAI-compatible path is exercised in its
 * "not configured" state (stable error, no key material anywhere), while the
 * mock provider proves the happy path end to end.
 *
 * Run: npm test
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-providers-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'seed-admin@example.com';
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
    console.log(`FAIL  ${name}${detail ? ` → ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
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
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const pair = entry.split(';')[0];
      if (pair.startsWith('ws_session=')) this.cookie = pair;
    }
    const type = response.headers.get('content-type') ?? '';
    const data = type.includes('application/json') ? await response.json().catch(() => null) : null;
    return { status: response.status, data, text: data ? JSON.stringify(data) : '' };
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

const SENSITIVE_KEY_PATTERN = /api[_-]?key|api[_-]?token|secret|bearer\s+[A-Za-z0-9_\-]{8,}|sk-[A-Za-z0-9]{8,}/i;

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`· using port ${PORT}`);
  console.log('· applying migrations');
  migrate('migrations/0001_init.sql');
  migrate('migrations/0002_site_analysis.sql');
  migrate('migrations/0003_orders.sql');
  migrate('migrations/0004_setup_codes.sql');
  migrate('migrations/0005_concurrency.sql');

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
  const setup = await admin.req('/api/setup', {
    method: 'POST',
    body: {
      name: 'Platform Admin',
      email: SEED_ADMIN,
      password: 'AdminPass12345',
      setupToken: verify.data.setupToken,
    },
  });
  check('setup completes with the code flow', setup.status === 200, setup.data);

  // -------------------------------------------------------------------------
  // Settings surface: no secrets, strict provider values
  // -------------------------------------------------------------------------
  const settings = await admin.req('/api/admin/settings');
  check('settings endpoint is reachable', settings.status === 200, settings.data);
  check(
    'settings payload carries no secret material',
    settings.status === 200 && !SENSITIVE_KEY_PATTERN.test(settings.text),
    settings.text.slice(0, 200)
  );

  const monitor = await admin.req('/api/admin/site-analyses');
  check('monitoring payload exposes provider status only', monitor.status === 200, monitor.data);
  check(
    'monitoring payload carries no secret material',
    !SENSITIVE_KEY_PATTERN.test(monitor.text),
    monitor.text.slice(0, 200)
  );
  check(
    'provider status shape includes the production warning flag',
    typeof monitor.data?.ai?.productionMockWarning === 'boolean',
    monitor.data?.ai
  );

  const badAi = await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.ai_provider': 'azure' } },
  });
  check(
    'unknown AI providers are rejected',
    badAi.status === 422 && badAi.data?.error?.code === 'invalid_provider',
    badAi.data
  );

  const badCrawler = await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.crawler_provider': 'scrapy' } },
  });
  check(
    'unknown crawler providers are rejected',
    badCrawler.status === 422 && badCrawler.data?.error?.code === 'invalid_provider',
    badCrawler.data
  );

  const badTarget = await admin.req('/api/admin/settings/test-connection', {
    method: 'POST',
    body: { target: 'smtp' },
  });
  check(
    'connection test rejects unknown targets',
    badTarget.status === 422 && badTarget.data?.error?.code === 'invalid_target',
    badTarget.data
  );

  const mockTest = await admin.req('/api/admin/settings/test-connection', {
    method: 'POST',
    body: { target: 'ai' },
  });
  check(
    'mock AI connection test passes without credentials',
    mockTest.status === 200 && mockTest.data?.mock === true,
    mockTest.data
  );

  const fetchTest = await admin.req('/api/admin/settings/test-connection', {
    method: 'POST',
    body: { target: 'crawler' },
  });
  check('fetch crawler test passes without credentials', fetchTest.status === 200, fetchTest.data);

  const cfCrawler = await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.crawler_provider': 'cloudflare' } },
  });
  const cfTest = await admin.req('/api/admin/settings/test-connection', {
    method: 'POST',
    body: { target: 'crawler' },
  });
  check(
    'cloudflare crawler without secrets fails with a stable code',
    cfCrawler.status === 200 &&
      cfTest.status === 422 &&
      cfTest.data?.code === 'crawler_not_configured',
    cfTest.data
  );
  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.crawler_provider': 'mock' } },
  });

  // -------------------------------------------------------------------------
  // OpenAI-compatible path without a key: stable failure, usage recorded
  // -------------------------------------------------------------------------
  const future = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const useOpenAi = await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.ai_provider': 'openai', 'analysis.ai_model': 'gpt-4o-mini' } },
  });
  check('admin can select the openai provider + model', useOpenAi.status === 200, useOpenAi.data);

  const statusAfter = await admin.req('/api/admin/site-analyses');
  check(
    'status reports the real provider as not configured',
    statusAfter.data?.ai?.provider === 'openai' && statusAfter.data?.ai?.configured === false,
    statusAfter.data?.ai
  );

  const aiTest = await admin.req('/api/admin/settings/test-connection', {
    method: 'POST',
    body: { target: 'ai' },
  });
  check(
    'AI connection test without a key fails cleanly',
    aiTest.status === 422 && aiTest.data?.code === 'ai_provider_not_configured',
    aiTest.data
  );
  check('failed test echoes no secret material', !SENSITIVE_KEY_PATTERN.test(aiTest.text));

  const company = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name: 'شركة المزودين',
      ownerEmail: 'owner-prov@example.com',
      ownerName: 'مالك المزودين',
      status: 'active',
      subscriptionStart: past,
      subscriptionEnd: future,
    },
  });
  const companyId = company.data?.companyId ?? company.data?.company?.id ?? company.data?.id;
  check('tenant exists for the provider run', Boolean(companyId), company.data);
  const owner = await signIn('ownerP', 'owner-prov@example.com', company.data.ownerTempPassword, 'OwnerProv12345');

  const created = await owner.req(`/api/company/${companyId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', locale: 'en', consent: true, maxPages: 2, maxDepth: 0 },
  });
  const analysisId = created.data?.analysis?.id;
  check('analysis draft is created', created.status === 201 && Boolean(analysisId), created.data);

  const started = await owner.req(`/api/company/${companyId}/site-analyses/${analysisId}/start`, {
    method: 'POST',
  });
  check(
    'missing key fails with a stable code (no key material)',
    started.status === 422 && started.data?.error?.code === 'ai_provider_not_configured',
    started.data
  );
  check('failure response echoes no secret material', !SENSITIVE_KEY_PATTERN.test(started.text ?? ''));

  const detail = await owner.req(`/api/company/${companyId}/site-analyses/${analysisId}`);
  check('failed analysis is recorded with the stable code', detail.data?.analysis?.errorMessage === 'ai_provider_not_configured');

  const adminDetail = await admin.req(`/api/admin/site-analyses/${analysisId}`);
  check(
    'error usage call is recorded server-side',
    (adminDetail.data?.usage ?? []).some(
      (row) => row.status === 'error' && row.error_message === 'ai_provider_not_configured'
    ),
    adminDetail.data?.usage
  );

  // -------------------------------------------------------------------------
  // Mock happy path: provenance labels + cost fields present
  // -------------------------------------------------------------------------
  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.ai_provider': 'mock', 'analysis.crawler_provider': 'mock' } },
  });

  const created2 = await owner.req(`/api/company/${companyId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', locale: 'ar', consent: true, maxPages: 3, maxDepth: 1 },
  });
  const analysisId2 = created2.data?.analysis?.id;
  const started2 = await owner.req(`/api/company/${companyId}/site-analyses/${analysisId2}/start`, {
    method: 'POST',
  });
  check('mock run completes', started2.status === 200, started2.data);

  const allowed = new Set(['website', 'inference', 'suggestion', 'missing']);
  const flat = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.value === 'string' && typeof node.source === 'string') flat.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(started2.data?.result?.result);
  check(
    'every emitted value carries a known provenance label',
    flat.length > 0 && flat.every((item) => allowed.has(item.source)),
    { count: flat.length }
  );
  check(
    'missing information stays visible instead of invented',
    (started2.data?.result?.result?.missing_information ?? []).length > 0
  );

  const adminDetail2 = await admin.req(`/api/admin/site-analyses/${analysisId2}`);
  const okUsage = (adminDetail2.data?.usage ?? []).find((row) => row.status === 'ok');
  check(
    'successful run records token usage + cost fields',
    Boolean(okUsage) &&
      typeof okUsage.input_tokens === 'number' &&
      typeof okUsage.estimated_cost_micros === 'number' &&
      okUsage.estimated_cost_micros >= 0,
    adminDetail2.data?.usage
  );

  // -------------------------------------------------------------------------
  // Per-plan concurrency plumbing
  // -------------------------------------------------------------------------
  const concPatch = await admin.req('/api/admin/plans/plan_starter', {
    method: 'PATCH',
    body: { maxConcurrent: 2 },
  });
  const plans = await admin.req('/api/admin/plans');
  const starter = (plans.data?.plans ?? []).find((plan) => plan.id === 'plan_starter');
  check(
    'per-plan concurrency is editable and readable',
    concPatch.status === 200 && starter?.maxConcurrent === 2,
    starter
  );
  const publicPlans = await admin.req('/api/public/plans');
  const publicStarter = (publicPlans.data?.plans ?? []).find((plan) => plan.id === 'plan_starter');
  check('public catalogue carries the concurrency cap', publicStarter?.maxConcurrent === 2, publicStarter);
}

main()
  .catch((error) => {
    failures.push(`fatal: ${error.message}`);
    console.error(error);
  })
  .finally(async () => {
    stopServer();
    await sleep(800);
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('failed checks:');
      for (const name of failures) console.log(` - ${name}`);
    }
    process.exit(failures.length ? 1 : 0);
  });
