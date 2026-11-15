/**
 * Phase 2 integration tests. Boots `wrangler dev` against a throwaway local D1
 * database, applies both migrations, then exercises the real HTTP API as
 * different users (owner, marketing manager, writer, viewer, outsider, admin).
 *
 * Run: npm test     (requires no network or API keys — mock providers are used)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-test-'));
let PORT = 0;
let BASE = '';

/** Bind to port 0 so a stale dev server can never be mistaken for ours. */
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

function stopServer() {
  if (!server) return;
  // The dev server spawns workerd as a grandchild, so signal the whole group.
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

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
  }
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

const serverLog = join(PERSIST, 'wrangler.log');
let server;

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`· using port ${PORT}`);
  console.log('· applying migrations');
  migrate('migrations/0001_init.sql');
  migrate('migrations/0002_site_analysis.sql');
  migrate('migrations/0004_setup_codes.sql');

  console.log('· starting wrangler dev');
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), `--persist-to=${PERSIST}`, '--log-level', 'error'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
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

  // -------------------------------------------------------------------------
  // Setup: admin, two tenants, members
  // -------------------------------------------------------------------------
  const admin = new Client('admin');
  const adminEmail = process.env.SETUP_ADMIN_EMAIL ?? 'admin@example.com';
  const start = await admin.req('/api/setup/start', {
    method: 'POST',
    body: { email: adminEmail },
  });
  check('setup issues a verification code', start.status === 200 && start.data.code, start.data);
  const verify = await admin.req('/api/setup/verify', {
    method: 'POST',
    body: { email: adminEmail, code: start.data.code },
  });
  const setup = await admin.req('/api/setup', {
    method: 'POST',
    body: {
      name: 'Platform Admin',
      email: adminEmail,
      password: 'AdminPass12345',
      setupToken: verify.data.setupToken,
    },
  });
  check('setup creates the first super admin', setup.status === 200, setup.data);

  const anon = new Client('anon');

  const future = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const companyA = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name: 'شركة ألفا',
      ownerEmail: 'owner-a@example.com',
      ownerName: 'مالك ألفا',
      status: 'active',
      subscriptionStart: past,
      subscriptionEnd: future,
    },
  });
  const companyAId = companyA.data?.companyId ?? companyA.data?.company?.id ?? companyA.data?.id;
  check('admin creates an active tenant', Boolean(companyAId), companyA.data);

  const companyB = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name: 'شركة بيتا',
      ownerEmail: 'owner-b@example.com',
      status: 'active',
      subscriptionStart: past,
      subscriptionEnd: future,
    },
  });
  const companyBId = companyB.data?.companyId ?? companyB.data?.company?.id ?? companyB.data?.id;

  const expiredCompany = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name: 'شركة منتهية',
      ownerEmail: 'owner-x@example.com',
      status: 'expired',
      subscriptionStart: past,
      subscriptionEnd: past,
    },
  });
  const expiredCompanyId =
    expiredCompany.data?.companyId ?? expiredCompany.data?.company?.id ?? expiredCompany.data?.id;
  check('second tenant exists', Boolean(companyBId), companyB.data);

  const tempA = companyA.data?.ownerTempPassword;
  const tempB = companyB.data?.ownerTempPassword;
  const tempX = expiredCompany.data?.ownerTempPassword;
  check('owner temporary passwords are returned once', Boolean(tempA && tempB && tempX));

  const ownerA = await signIn('ownerA', 'owner-a@example.com', tempA, 'OwnerAPass12345');
  const ownerB = await signIn('ownerB', 'owner-b@example.com', tempB, 'OwnerBPass12345');
  const ownerX = await signIn('ownerX', 'owner-x@example.com', tempX, 'OwnerXPass12345');

  const meA = await ownerA.req('/api/auth/me');
  const permsA = meA.data?.companies?.[0]?.permissions ?? [];
  check('owner has analysis permissions', permsA.includes('analysis.create') && permsA.includes('analysis.approve'));

  async function addMember(role, email) {
    const created = await ownerA.req(`/api/company/${companyAId}/members`, {
      method: 'POST',
      body: { name: `${role} user`, email, role },
    });
    const password = created.data?.tempPassword;
    if (!password) throw new Error(`could not add ${role}: ${created.text}`);
    return signIn(role, email, password, `${role.replace(/[^a-z]/g, '')}Pass12345`);
  }

  const manager = await addMember('marketing_manager', 'manager-a@example.com');
  const writer = await addMember('content_writer', 'writer-a@example.com');
  const viewer = await addMember('viewer', 'viewer-a@example.com');

  const managerPerms = (await manager.req('/api/auth/me')).data?.companies?.[0]?.permissions ?? [];
  check('marketing manager cannot approve', !managerPerms.includes('analysis.approve'));
  const writerPerms = (await writer.req('/api/auth/me')).data?.companies?.[0]?.permissions ?? [];
  check(
    'writer can only read approved analyses',
    writerPerms.includes('analysis.view_approved') && !writerPerms.includes('analysis.edit')
  );

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------
  const anonList = await anon.req(`/api/company/${companyAId}/site-analyses`);
  check('anonymous cannot list analyses', anonList.status === 401, anonList.data);

  const viewerCreate = await viewer.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  check('viewer cannot create an analysis', viewerCreate.status === 403, viewerCreate.data);

  const writerCreate = await writer.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  check('content writer cannot create an analysis', writerCreate.status === 403, writerCreate.data);

  const expiredCreate = await ownerX.req(`/api/company/${expiredCompanyId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  check('expired subscription blocks analysis', expiredCreate.status === 402, expiredCreate.data);

  const invalidUrl = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'not a url', consent: true },
  });
  check('invalid URL is rejected', invalidUrl.status === 422 && invalidUrl.data?.error?.code === 'invalid_url', invalidUrl.data);

  const privateUrl = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'http://127.0.0.1/admin', consent: true },
  });
  check(
    'private/loopback URL is rejected',
    privateUrl.status === 422 && ['url_not_allowed', 'invalid_url'].includes(privateUrl.data?.error?.code),
    privateUrl.data
  );

  const noConsent = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com' },
  });
  check('consent is required', noConsent.status === 422 && noConsent.data?.error?.code === 'consent_required', noConsent.data);

  // -------------------------------------------------------------------------
  // Limits are enforced server-side
  // -------------------------------------------------------------------------
  const clamped = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true, maxPages: 999, maxDepth: 99 },
  });
  const clampOk =
    clamped.status === 201 && clamped.data.analysis.maxPages <= 40 && clamped.data.analysis.maxDepth <= 4;
  check('page/depth limits are clamped on the server', clampOk, clamped.data);

  // -------------------------------------------------------------------------
  // Happy path with mock providers
  // -------------------------------------------------------------------------
  const created = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'example.com', locale: 'ar', consent: true, maxPages: 4, maxDepth: 1 },
  });
  const analysisId = created.data?.analysis?.id;
  check('analysis is created as a draft', created.status === 201 && created.data.analysis.status === 'draft', created.data);

  const started = await ownerA.req(`/api/company/${companyAId}/site-analyses/${analysisId}/start`, {
    method: 'POST',
  });
  check(
    'mock crawl + mock analysis produce a draft report',
    started.status === 200 && started.data.analysis.status === 'awaiting_review',
    started.data
  );
  const resultV1 = started.data?.result;
  check('result has the fixed schema', Boolean(resultV1?.result?.company_profile && Array.isArray(resultV1.result.risks)));
  check('version 1 is stored', resultV1?.version === 1, resultV1?.version);
  check('provider is labelled mock', started.data.analysis.provider === 'mock', started.data.analysis.provider);
  check('report language is arabic', started.data.analysis.locale === 'ar');
  check(
    'every field carries provenance',
    ['company_name', 'industry', 'summary'].every((key) => {
      const field = resultV1.result.company_profile[key];
      return field && typeof field.source === 'string' && typeof field.confidence === 'number';
    }),
    resultV1?.result?.company_profile
  );
  check(
    'missing data is not invented',
    resultV1.result.value_proposition[0]?.source === 'missing' &&
      resultV1.result.missing_information.length > 0,
    resultV1?.result?.value_proposition
  );

  const pagesAsOwner = await ownerA.req(`/api/company/${companyAId}/site-analyses/${analysisId}/pages`);
  check('crawled pages are recorded', pagesAsOwner.status === 200 && pagesAsOwner.data.pages.length > 0);

  const pagesAsViewer = await viewer.req(`/api/company/${companyAId}/site-analyses/${analysisId}/pages`);
  check('viewer cannot read raw crawled pages', pagesAsViewer.status === 403, pagesAsViewer.data);

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------
  const crossRead = await ownerB.req(`/api/company/${companyAId}/site-analyses/${analysisId}`);
  check(
    'company B cannot read company A analysis',
    crossRead.status === 403 || crossRead.status === 404,
    crossRead.data
  );

  const crossList = await ownerB.req(`/api/company/${companyAId}/site-analyses`);
  check('company B cannot list company A analyses', crossList.status === 403, crossList.data);

  const crossEdit = await ownerB.req(`/api/company/${companyAId}/site-analyses/${analysisId}/results`, {
    method: 'PUT',
    body: { result: {} },
  });
  check('company B cannot edit company A results', crossEdit.status === 403, crossEdit.data);

  // -------------------------------------------------------------------------
  // Viewer isolation on unreviewed drafts
  // -------------------------------------------------------------------------
  const viewerListBefore = await viewer.req(`/api/company/${companyAId}/site-analyses`);
  check(
    'viewer sees no unapproved analyses',
    viewerListBefore.status === 200 && viewerListBefore.data.analyses.length === 0,
    viewerListBefore.data
  );

  const viewerDetailBefore = await viewer.req(`/api/company/${companyAId}/site-analyses/${analysisId}`);
  check('viewer cannot open an unapproved report', viewerDetailBefore.status === 403, viewerDetailBefore.data);

  // -------------------------------------------------------------------------
  // Editing creates versions, never overwrites
  // -------------------------------------------------------------------------
  const editedResult = JSON.parse(JSON.stringify(resultV1.result));
  editedResult.company_profile.company_name = {
    value: 'شركة ألفا — اسم معتمد',
    source: 'website',
    confidence: 1,
  };
  const edit1 = await manager.req(`/api/company/${companyAId}/site-analyses/${analysisId}/results`, {
    method: 'PUT',
    body: { result: editedResult, comment: 'تصحيح الاسم التجاري' },
  });
  check('marketing manager can edit and create version 2', edit1.status === 200 && edit1.data.result.version === 2, edit1.data);

  const viewerEdit = await viewer.req(`/api/company/${companyAId}/site-analyses/${analysisId}/results`, {
    method: 'PUT',
    body: { result: editedResult },
  });
  check('viewer cannot edit results', viewerEdit.status === 403, viewerEdit.data);

  const v1 = await ownerA.req(`/api/company/${companyAId}/site-analyses/${analysisId}?version=1`);
  check(
    'previous version is retained unchanged',
    v1.status === 200 && v1.data.result.result.company_profile.company_name.value !== 'شركة ألفا — اسم معتمد',
    v1.data?.result?.version
  );

  // -------------------------------------------------------------------------
  // Approval workflow
  // -------------------------------------------------------------------------
  const managerApprove = await manager.req(
    `/api/company/${companyAId}/site-analyses/${analysisId}/approve`,
    { method: 'POST', body: {} }
  );
  check('marketing manager cannot approve', managerApprove.status === 403, managerApprove.data);

  const writerApprove = await writer.req(
    `/api/company/${companyAId}/site-analyses/${analysisId}/approve`,
    { method: 'POST', body: {} }
  );
  check('content writer cannot approve', writerApprove.status === 403, writerApprove.data);

  const missingComment = await ownerA.req(
    `/api/company/${companyAId}/site-analyses/${analysisId}/request-changes`,
    { method: 'POST', body: {} }
  );
  check('request changes needs a comment', missingComment.status === 422, missingComment.data);

  const changes = await ownerA.req(
    `/api/company/${companyAId}/site-analyses/${analysisId}/request-changes`,
    { method: 'POST', body: { comment: 'أضف القيمة المقترحة' } }
  );
  check('request changes moves to changes_requested', changes.status === 200 && changes.data.analysis.status === 'changes_requested', changes.data);

  const resubmit = await manager.req(
    `/api/company/${companyAId}/site-analyses/${analysisId}/submit-review`,
    { method: 'POST', body: { comment: 'جاهز للاعتماد' } }
  );
  check('submit for review works', resubmit.status === 200 && resubmit.data.analysis.status === 'awaiting_review', resubmit.data);

  const approved = await ownerA.req(`/api/company/${companyAId}/site-analyses/${analysisId}/approve`, {
    method: 'POST',
    body: { comment: 'معتمد' },
  });
  check('owner approves the report', approved.status === 200 && approved.data.analysis.status === 'approved', approved.data);
  check('approved version is recorded', approved.data.analysis.approvedVersion === 2, approved.data.analysis.approvedVersion);

  const detail = await ownerA.req(`/api/company/${companyAId}/site-analyses/${analysisId}`);
  check(
    'approval history is kept',
    detail.data.approvals.some((entry) => entry.action === 'approved') &&
      detail.data.approvals.some((entry) => entry.action === 'changes_requested'),
    detail.data.approvals
  );

  const viewerListAfter = await viewer.req(`/api/company/${companyAId}/site-analyses`);
  check(
    'viewer now sees the approved analysis',
    viewerListAfter.data.analyses.some((row) => row.id === analysisId),
    viewerListAfter.data.analyses
  );

  const viewerDetailAfter = await viewer.req(`/api/company/${companyAId}/site-analyses/${analysisId}`);
  check('viewer can open the approved report', viewerDetailAfter.status === 200);
  check('viewer has no edit capability', viewerDetailAfter.data.capabilities.edit === false);

  // Editing an approved report reopens the review.
  const reopen = await manager.req(`/api/company/${companyAId}/site-analyses/${analysisId}/results`, {
    method: 'PUT',
    body: { result: editedResult, comment: 'تعديل بعد الاعتماد' },
  });
  check(
    'editing an approved report reopens review',
    reopen.status === 200 && reopen.data.analysis.status === 'awaiting_review' && reopen.data.analysis.approvedVersion === null,
    reopen.data.analysis
  );

  // -------------------------------------------------------------------------
  // Provider failure + retry, cancel
  // -------------------------------------------------------------------------
  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.ai_provider': 'openai' } },
  });
  const failing = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true, maxPages: 2, maxDepth: 0 },
  });
  const failingId = failing.data?.analysis?.id;
  const failedRun = await ownerA.req(`/api/company/${companyAId}/site-analyses/${failingId}/start`, {
    method: 'POST',
  });
  check(
    'missing AI credentials fail clearly',
    failedRun.status === 422 && failedRun.data?.error?.code === 'ai_provider_not_configured',
    failedRun.data
  );
  const failedDetail = await ownerA.req(`/api/company/${companyAId}/site-analyses/${failingId}`);
  check(
    'failed job stores the error code',
    failedDetail.data.analysis.status === 'failed' && failedDetail.data.analysis.errorMessage === 'ai_provider_not_configured',
    failedDetail.data.analysis
  );

  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.ai_provider': 'mock' } },
  });
  const retried = await ownerA.req(`/api/company/${companyAId}/site-analyses/${failingId}/retry`, {
    method: 'POST',
  });
  check('retry succeeds after the provider is fixed', retried.status === 200 && retried.data.analysis.status === 'awaiting_review', retried.data);

  const toCancel = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  const cancelId = toCancel.data.analysis.id;
  const cancelled = await ownerA.req(`/api/company/${companyAId}/site-analyses/${cancelId}/cancel`, {
    method: 'POST',
  });
  check('draft analysis can be cancelled', cancelled.status === 200 && cancelled.data.analysis.status === 'cancelled', cancelled.data);
  const cancelAgain = await ownerA.req(`/api/company/${companyAId}/site-analyses/${cancelId}/cancel`, {
    method: 'POST',
  });
  check('cancelling a cancelled job is refused', cancelAgain.status === 409, cancelAgain.data);

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.rate_limit_per_hour': '1' } },
  });
  const quotaFirst = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  const quotaSecond = await ownerA.req(`/api/company/${companyAId}/site-analyses`, {
    method: 'POST',
    body: { url: 'https://example.com', consent: true },
  });
  check(
    'hourly rate limit is enforced',
    [201, 429].includes(quotaFirst.status) && quotaSecond.status === 429,
    { first: quotaFirst.status, second: quotaSecond.data }
  );
  await admin.req('/api/admin/settings', {
    method: 'PATCH',
    body: { values: { 'analysis.rate_limit_per_hour': '10' } },
  });

  // -------------------------------------------------------------------------
  // Admin monitoring + secrets
  // -------------------------------------------------------------------------
  const adminJobs = await admin.req('/api/admin/site-analyses');
  check('admin can see analysis jobs', adminJobs.status === 200 && adminJobs.data.analyses.length > 0);
  check(
    'admin job view carries no report content',
    adminJobs.data.analyses.every((row) => row.result === undefined && row.resultJson === undefined)
  );

  const adminRetry = await admin.req(`/api/admin/site-analyses/${failingId}/cancel`, { method: 'POST' });
  check(
    'admin cancel is refused for a non-running job',
    adminRetry.status === 409,
    adminRetry.data
  );

  const audit = await admin.req('/api/admin/audit?action=site_analysis&limit=50');
  const auditActions = (audit.data?.logs ?? []).map((row) => row.action);
  check(
    'analysis actions are audited',
    auditActions.includes('site_analysis.created') &&
      auditActions.includes('site_analysis.approved') &&
      auditActions.includes('site_analysis.failed'),
    auditActions.slice(0, 10)
  );

  const settings = await admin.req('/api/admin/settings');
  const settingsText = JSON.stringify(settings.data);
  check(
    'settings never expose provider secrets',
    !/AI_API_KEY|CRAWLER_API_TOKEN|sk-[A-Za-z0-9]/.test(settingsText)
  );
  const detailText = JSON.stringify(detail.data);
  check('analysis payload never exposes secrets', !/AI_API_KEY|CRAWLER_API_TOKEN|sk-[A-Za-z0-9]/.test(detailText));

  const crossAdmin = await viewer.req('/api/admin/site-analyses');
  check('tenant user cannot reach admin monitoring', crossAdmin.status === 403, crossAdmin.data);
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
    if (!existsSync(PERSIST)) console.log('note: temp persistence dir was removed');
    process.exit(failures.length ? 1 : 0);
  })
  .then(() => {
    // Keep the temp log path visible for debugging failed runs.
    if (failures.length && existsSync(serverLog)) console.log(readFileSync(serverLog, 'utf8').slice(-2000));
  });
