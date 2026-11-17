/**
 * Post studio — integration tests.
 *
 * Proves the idea-in / post-out flow end to end: generation returns a caption
 * plus a poster draft, regeneration produces a different variant, approval
 * makes the poster public, saving stores the post in the library with the
 * poster as media, and another tenant cannot generate or save into it.
 *
 * Run: node tests/studio.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-studio-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'studio-admin@example.com';

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

  const companyA = await createCompany(admin, 'شركة الاستوديو', 'studio-owner@example.com');
  const companyB = await createCompany(admin, 'شركة ثانية', 'studio-other@example.com');
  const ownerA = await signIn('studio-owner@example.com', companyA.tempPassword, 'StudioOwner12345');
  const ownerB = await signIn('studio-other@example.com', companyB.tempPassword, 'StudioOther1234');

  const socialA = `/api/company/${companyA.companyId}/social`;
  const socialB = `/api/company/${companyB.companyId}/social`;

  const idea = 'أبغى شخصين سعوديين واقفين ماسكين جوال، والمنشور يقول إن الخدمة توصل لبيتك';

  const emptyIdea = await ownerA.req(`${socialA}/studio/generate`, {
    method: 'POST',
    body: { idea: 'ab', sizeKey: 'instagram_business' },
  });
  check('a too-short idea is rejected', emptyIdea.status === 422 && emptyIdea.data?.error?.code === 'studio_idea_required', emptyIdea.data);

  const badSize = await ownerA.req(`${socialA}/studio/generate`, {
    method: 'POST',
    body: { idea, sizeKey: 'not_a_platform' },
  });
  check('an unknown size is rejected', badSize.status === 422, badSize.data);

  const generated = await ownerA.req(`${socialA}/studio/generate`, {
    method: 'POST',
    body: { idea, sizeKey: 'instagram_business', language: 'ar', variant: 0 },
  });
  check('generation returns a draft', generated.status === 201, generated.data);
  const draft = generated.data?.draft;
  check('the draft carries a caption and poster copy', Boolean(draft?.captionAr) && Boolean(draft?.headline), draft);
  check('the draft carries an image description from the idea', Boolean(draft?.imagePrompt), draft?.imagePrompt);
  check('the draft carries a poster draft id and preview URL', Boolean(draft?.posterId) && Boolean(draft?.posterPreviewUrl), draft);

  const preview = await ownerA.req(draft.posterPreviewUrl.replace(BASE, ''));
  check('the generated poster preview renders', preview.status === 200 && preview.text.includes('<svg'), preview.status);

  const foreignGenerate = await ownerB.req(`${socialA}/studio/generate`, {
    method: 'POST',
    body: { idea, sizeKey: 'instagram_business' },
  });
  check('another tenant cannot generate into this company', foreignGenerate.status === 404 || foreignGenerate.status === 403, foreignGenerate.status);

  const regenerated = await ownerA.req(`${socialA}/studio/generate`, {
    method: 'POST',
    body: {
      idea,
      feedback: 'أقصر',
      sizeKey: 'instagram_business',
      variant: 1,
      previous: { headline: draft.headline, caption: draft.captionAr },
    },
  });
  check('regeneration returns 201', regenerated.status === 201, regenerated.data);
  check(
    'regeneration produces a different variant',
    regenerated.data?.draft?.posterId !== draft.posterId && regenerated.data?.draft?.variant === 1,
    regenerated.data?.draft
  );

  const approve = await ownerA.req(`/api/company/${companyA.companyId}/posters/${draft.posterId}/approve`, {
    method: 'POST',
    body: {},
  });
  check('the generated poster can be approved', approve.data?.poster?.status === 'approved', approve.data?.poster);
  check('an approved poster exposes a public image URL', typeof approve.data?.poster?.imageUrl === 'string', approve.data?.poster?.imageUrl);

  const saved = await ownerA.req(`${socialA}/studio/save`, {
    method: 'POST',
    body: {
      title: draft.title,
      bodyAr: draft.captionAr,
      bodyEn: draft.captionEn,
      hashtags: draft.hashtags,
      ctaLabel: draft.cta,
      language: 'ar',
      posterId: draft.posterId,
    },
  });
  check('saving stores the post in the library', saved.status === 201, saved.data);
  check('the saved post is a draft with the generated text', saved.data?.post?.status === 'draft' && saved.data?.post?.bodyAr === draft.captionAr, saved.data?.post);
  check(
    'the saved post carries the approved poster as media',
    saved.data?.post?.media?.[0]?.url === approve.data?.poster?.imageUrl,
    saved.data?.post?.media
  );

  const library = await ownerA.req(`${socialA}/posts`);
  check(
    'the saved post appears in the library for later copy',
    (library.data?.posts ?? []).some((post) => post.id === saved.data?.post?.id),
    library.data?.posts?.length
  );

  const foreignSave = await ownerB.req(`${socialA}/studio/save`, {
    method: 'POST',
    body: { bodyAr: draft.captionAr, posterId: draft.posterId },
  });
  check('another tenant cannot save into this company', foreignSave.status === 404 || foreignSave.status === 403, foreignSave.status);

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
