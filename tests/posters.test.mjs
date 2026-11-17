/**
 * Poster drafts — integration tests.
 *
 * Proves that a poster is rendered by the Worker, that drafts are never public,
 * that an approved poster is immutable, and that the rendered SVG escapes the
 * client's text instead of injecting it as markup.
 *
 * Run: node tests/posters.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-posters-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'poster-admin@example.com';

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

class Client {
  constructor() {
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
      text: data ? JSON.stringify(data) : await response.text().catch(() => ''),
      location: response.headers.get('location'),
    };
  }
}

async function signIn(email, password, newPassword) {
  const client = new Client();
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  if (newPassword) {
    const changed = await client.req('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: password, newPassword },
    });
    if (changed.status !== 200) throw new Error(`password change failed: ${changed.text}`);
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
      /* gone */
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
      /* not up */
    }
    await sleep(500);
  }
  throw new Error('server did not start');
}

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

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
    'migrations/0010_posters.sql',
  ]) {
    migrate(file);
  }

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
      console.log(logStream.join('').slice(-2000));
    }
  });
  await waitForServer();

  const admin = new Client();
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

  const companyA = await createCompany(admin, 'شركة البوسترات', 'poster-owner@example.com');
  const companyB = await createCompany(admin, 'شركة ثانية', 'poster-other@example.com');
  const ownerA = await signIn('poster-owner@example.com', companyA.tempPassword, 'PosterOwner12345');
  const ownerB = await signIn('poster-other@example.com', companyB.tempPassword, 'PosterOther1234');

  const baseA = `/api/company/${companyA.companyId}/posters`;
  const baseB = `/api/company/${companyB.companyId}/posters`;

  const sizes = await ownerA.req(baseA);
  check('the poster workspace loads', sizes.status === 200, sizes.data);
  check(
    'the six platform sizes are served by the API',
    (sizes.data?.sizes ?? []).length === 6 &&
      sizes.data.sizes.some((size) => size.key === 'instagram_business' && size.width === 1080),
    sizes.data?.sizes
  );

  const badSize = await ownerA.req(baseA, {
    method: 'POST',
    body: { headline: 'عنوان', sizeKey: 'not_a_platform' },
  });
  check('an unknown size is rejected', badSize.status === 422, badSize.data);

  const badColor = await ownerA.req(baseA, {
    method: 'POST',
    body: { headline: 'عنوان', sizeKey: 'instagram_business', brandColor: 'red' },
  });
  check('a non-hex brand colour is rejected', badColor.status === 422, badColor.data);

  const created = await ownerA.req(baseA, {
    method: 'POST',
    body: {
      headline: 'عرض <script>alert(1)</script> نوفمبر',
      subhead: 'خصم 20% على الخدمات',
      cta: 'اطلب الآن',
      sizeKey: 'instagram_business',
      template: 'bold',
      brandColor: '#0f766e',
      language: 'ar',
    },
  });
  check('a poster draft is created', created.status === 201, created.data);
  const poster = created.data?.poster;
  check('a draft has no public image URL', poster?.imageUrl === null, poster);

  const publicDraft = await ownerA.req(`/api/public/posters/${poster.id}.svg`);
  check('a draft is not served publicly', publicDraft.status === 404, publicDraft.status);

  const preview = await ownerA.req(`${baseA}/${poster.id}/preview.svg`);
  check('the authenticated preview renders SVG', preview.status === 200, preview.status);
  const svg = preview.text;
  check(
    'the SVG escapes client text instead of injecting it',
    svg.includes('&lt;script&gt;') && !svg.includes('<script>'),
    svg.slice(0, 200)
  );
  check(
    'the SVG uses the platform size',
    svg.includes('width="1080"') && svg.includes('height="1080"'),
    svg.slice(0, 200)
  );

  const foreignPreview = await ownerB.req(`${baseB}/${poster.id}/preview.svg`);
  check('another tenant cannot preview the poster', foreignPreview.status === 404, foreignPreview.status);

  const editDraft = await ownerA.req(`${baseA}/${poster.id}`, {
    method: 'PATCH',
    body: { headline: 'عنوان محدّث' },
  });
  check(
    'a draft can be edited and its version increments',
    editDraft.data?.poster?.version === 2,
    editDraft.data?.poster
  );

  const approve = await ownerA.req(`${baseA}/${poster.id}/approve`, { method: 'POST', body: {} });
  check('a poster can be approved', approve.data?.poster?.status === 'approved', approve.data?.poster);
  check(
    'an approved poster exposes its public URL',
    typeof approve.data?.poster?.imageUrl === 'string' && approve.data.poster.imageUrl.endsWith('.svg'),
    approve.data?.poster?.imageUrl
  );

  const publicApproved = await fetch(approve.data.poster.imageUrl);
  check('the approved poster is served publicly', publicApproved.status === 200, publicApproved.status);
  check(
    'the public response is an SVG image',
    (publicApproved.headers.get('content-type') ?? '').includes('image/svg+xml'),
    publicApproved.headers.get('content-type')
  );

  const editApproved = await ownerA.req(`${baseA}/${poster.id}`, {
    method: 'PATCH',
    body: { headline: 'تغيير بعد الاعتماد' },
  });
  check(
    'an approved poster cannot be edited',
    editApproved.status === 409 && editApproved.data?.error?.code === 'poster_approved_immutable',
    editApproved.data
  );

  const archive = await ownerA.req(`${baseA}/${poster.id}/archive`, { method: 'POST', body: {} });
  check('a poster can be archived', archive.data?.poster?.status === 'archived', archive.data?.poster);
  const publicArchived = await fetch(approve.data.poster.imageUrl);
  check('an archived poster is no longer served', publicArchived.status === 404, publicArchived.status);

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
