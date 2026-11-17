/**
 * Lead acquisition and marketing automation — integration tests.
 *
 * These exercise the guarantees that matter more than the happy path:
 * discovery refuses (and writes nothing) without a licensed source, a lead
 * cannot exist without a reviewable source, contact data cannot be stored
 * without a stated origin, consent/DNC exclude recipients, and a campaign can
 * never launch while its channel is unconnected.
 *
 * Run: npm test
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-growth-'));
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
    for (const entry of response.headers.getSetCookie?.() ?? []) {
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

async function createCompany(admin, name, email) {
  const past = '2025-01-01';
  const future = '2027-12-31';
  const created = await admin.req('/api/admin/companies', {
    method: 'POST',
    body: {
      name,
      ownerEmail: email,
      ownerName: 'مالك الشركة',
      status: 'active',
      subscriptionStart: past,
      subscriptionEnd: future,
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
  console.log(`· using port ${PORT}`);
  for (const file of [
    'migrations/0001_init.sql',
    'migrations/0002_site_analysis.sql',
    'migrations/0003_orders.sql',
    'migrations/0004_setup_codes.sql',
    'migrations/0005_concurrency.sql',
    'migrations/0006_growth.sql',
    'migrations/0011_lead_classification.sql',
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

  const first = await createCompany(admin, 'شركة الاكتشاف', 'lead-owner@example.com');
  check('tenant is created', Boolean(first.companyId), first.created.data);
  const owner = await signIn('owner', 'lead-owner@example.com', first.tempPassword, 'LeadOwner12345');
  const base = `/api/company/${first.companyId}/growth`;

  // -------------------------------------------------------------------------
  // Nothing is invented before a source exists
  // -------------------------------------------------------------------------
  const overview = await owner.req(base);
  check('growth overview loads', overview.status === 200, overview.data);
  check('a new tenant starts with zero leads', overview.data?.stats?.leads === 0, overview.data?.stats);
  const licensed = (overview.data?.sources ?? []).find((source) => source.provider === 'licensed_data');
  check(
    'the licensed source reports "requires credentials"',
    licensed?.state === 'requires_credentials',
    licensed
  );
  check(
    'no channel claims to be connected',
    (overview.data?.channels ?? []).every((channel) => channel.state !== 'connected'),
    overview.data?.channels
  );
  const secretLike = (value) => /^[A-Z][A-Z0-9_]*(\s*=.*)?$/.test(String(value ?? ''));
  check(
    'no deployment secret name reaches the client in channel requirements',
    (overview.data?.channels ?? []).every((channel) =>
      (channel.requires ?? []).every((item) => !secretLike(item))
    ),
    overview.data?.channels
  );
  check(
    'no deployment secret name reaches the client in source requirements',
    (overview.data?.sources ?? []).every((source) =>
      (source.requires ?? []).every((item) => !secretLike(item))
    ),
    overview.data?.sources
  );
  const metaChannel = (overview.data?.channels ?? []).find((channel) => channel.channel === 'meta');
  check(
    'the legacy static-token channel cannot send in this build',
    metaChannel?.canSendFromThisBuild === false,
    metaChannel
  );

  const discovery = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 5 } });
  check(
    'discovery refuses without a source (stable code)',
    discovery.status === 409 && discovery.data?.error?.code === 'lead_source_not_connected',
    discovery.data
  );
  const afterDiscovery = await owner.req(`${base}/leads`);
  check(
    'a refused discovery writes no leads',
    afterDiscovery.status === 200 && (afterDiscovery.data?.leads ?? []).length === 0,
    afterDiscovery.data
  );

  const discoveryBeforeAnalysis = await owner.req(`${base}/icp/derive`, { method: 'POST' });
  check(
    'the profile needs an approved analysis',
    discoveryBeforeAnalysis.status === 409 &&
      discoveryBeforeAnalysis.data?.error?.code === 'analysis_not_approved',
    discoveryBeforeAnalysis.data
  );

  // -------------------------------------------------------------------------
  // Manual, documented leads only
  // -------------------------------------------------------------------------
  const noSource = await owner.req(`${base}/leads`, {
    method: 'POST',
    body: { companyName: 'شركة بلا مصدر', interestSignal: 'public_request', evidenceText: 'طلب علني' },
  });
  check(
    'a lead without a source link is rejected',
    noSource.status === 422 && noSource.data?.error?.code === 'lead_source_url_required',
    noSource.data
  );

  const noEvidence = await owner.req(`${base}/leads`, {
    method: 'POST',
    body: {
      companyName: 'شركة بلا دليل',
      interestSignal: 'public_request',
      sourceUrl: 'https://example.com/blog/post',
    },
  });
  check(
    'a lead without evidence is rejected',
    noEvidence.status === 422 && noEvidence.data?.error?.code === 'lead_evidence_required',
    noEvidence.data
  );

  const noContactOrigin = await owner.req(`${base}/leads`, {
    method: 'POST',
    body: {
      companyName: 'شركة ببريد مجهول المصدر',
      interestSignal: 'public_question',
      evidenceText: 'سؤال عام عن نظام تسويق آلي',
      sourceUrl: 'https://example.com/question',
      email: 'someone@example.com',
    },
  });
  check(
    'contact data without a declared origin is rejected',
    noContactOrigin.status === 422 && noContactOrigin.data?.error?.code === 'contact_source_required',
    noContactOrigin.data
  );

  const createdLead = await owner.req(`${base}/leads`, {
    method: 'POST',
    body: {
      companyName: 'مصنع الرياض للأغذية',
      name: 'سارة العتيبي',
      sector: 'الأغذية',
      city: 'الرياض',
      country: 'SA',
      email: 'sara@example.com',
      emailSource: 'public_page',
      interestSignal: 'public_request',
      evidenceText: 'نشرت الشركة طلبًا علنيًا لتوريد نظام تسويق آلي في حسابها الرسمي.',
      sourceUrl: 'https://example.com/public-post',
      profileUrl: 'https://example.com/company',
    },
  });
  const leadId = createdLead.data?.lead?.id;
  check('a documented lead is created', createdLead.status === 201 && Boolean(leadId), createdLead.data);
  check(
    'the lead carries a score with explicit reasons',
    createdLead.data?.lead?.score > 0 && (createdLead.data?.lead?.scoreReasons ?? []).length > 0,
    createdLead.data?.lead
  );
  check(
    'a hand-entered lead is also stored as potential, not confirmed',
    createdLead.data?.lead?.classification === 'potential',
    createdLead.data?.lead?.classification
  );
  check(
    'the lead keeps its evidence and source',
    createdLead.data?.lead?.sourceUrl === 'https://example.com/public-post' &&
      createdLead.data?.lead?.evidenceText?.length > 10 &&
      createdLead.data?.lead?.sourceKind === 'manual_research',
    createdLead.data?.lead
  );

  const duplicate = await owner.req(`${base}/leads`, {
    method: 'POST',
    body: {
      companyName: 'مصنع الرياض للأغذية',
      sector: 'الأغذية',
      email: 'sara@example.com',
      emailSource: 'public_page',
      interestSignal: 'public_request',
      evidenceText: 'نفس الطلب العلني.',
      sourceUrl: 'https://example.com/public-post',
    },
  });
  check(
    'a duplicate lead is refused',
    duplicate.status === 409 && duplicate.data?.error?.code === 'duplicate_lead',
    duplicate.data
  );

  // -------------------------------------------------------------------------
  // Consent, do-not-contact and the suppression list
  // -------------------------------------------------------------------------
  const consented = await owner.req(`${base}/leads/${leadId}`, {
    method: 'PATCH',
    body: { consentState: 'granted', stage: 'qualified' },
  });
  check(
    'consent and stage are recorded',
    consented.status === 200 &&
      consented.data?.lead?.consentState === 'granted' &&
      consented.data?.lead?.stage === 'qualified',
    consented.data
  );

  const dnc = await owner.req(`${base}/leads/${leadId}`, { method: 'PATCH', body: { doNotContact: true } });
  check('do-not-contact is stored', dnc.status === 200 && dnc.data?.lead?.doNotContact === true, dnc.data);
  const suppressions = await owner.req(`${base}/suppressions`);
  check(
    'do-not-contact adds the address to the suppression list',
    (suppressions.data?.suppressions ?? []).some((row) => row.address === 'sara@example.com'),
    suppressions.data
  );

  const activity = await owner.req(`${base}/leads/${leadId}/activities`, {
    method: 'POST',
    body: { kind: 'call', note: 'جرت مكالمة تعريفية، طلبت عرض سعر.' },
  });
  check('the contact log accepts an entry', activity.status === 201, activity.data);
  const activityList = await owner.req(`${base}/leads/${leadId}/activities`);
  check(
    'the contact log returns the entry',
    (activityList.data?.activities ?? []).some((row) => row.kind === 'call'),
    activityList.data
  );

  // -------------------------------------------------------------------------
  // Campaigns cannot launch on an unconnected channel
  // -------------------------------------------------------------------------
  const campaign = await owner.req(`${base}/campaigns`, {
    method: 'POST',
    body: {
      name: 'حملة الأغذية — الربع الرابع',
      objective: 'حجز اجتماعات',
      audience: 'مصانع أغذية في الرياض',
      sector: 'الأغذية',
      city: 'الرياض',
      channel: 'email',
      budgetSar: 5000,
    },
  });
  const campaignId = campaign.data?.campaign?.id;
  check('a campaign is created', campaign.status === 201 && Boolean(campaignId), campaign.data);
  check(
    'an unconnected channel puts the campaign in awaiting_channel',
    campaign.data?.campaign?.status === 'awaiting_channel',
    campaign.data?.campaign
  );

  await owner.req(`${base}/leads/${leadId}`, { method: 'PATCH', body: { campaignId } });

  const preflight = await owner.req(`${base}/campaigns/${campaignId}/preflight`, { method: 'POST' });
  const blockerCodes = (preflight.data?.blockers ?? []).map((blocker) => blocker.code);
  check('preflight reports the campaign as not ready', preflight.data?.ready === false, preflight.data);
  check('preflight names the unconnected channel', blockerCodes.includes('channel_not_connected'), blockerCodes);
  check('preflight names the missing content', blockerCodes.includes('content_ref_required'), blockerCodes);
  check('preflight excludes the do-not-contact lead', blockerCodes.includes('do_not_contact_excluded'), blockerCodes);

  const launch = await owner.req(`${base}/campaigns/${campaignId}/launch`, { method: 'POST' });
  check(
    'launch is refused with the blocker list',
    launch.status === 409 && launch.data?.error?.code === 'campaign_not_ready',
    launch.data
  );

  const metaCampaign = await owner.req(`${base}/campaigns`, {
    method: 'POST',
    body: { name: 'حملة سوشيال قديمة', channel: 'meta', contentRef: 'رابط منشور معتمد' },
  });
  const metaId = metaCampaign.data?.campaign?.id;
  check('a legacy-channel campaign is still accepted for migration', metaCampaign.status === 201, metaCampaign.data);
  const metaPreflight = await owner.req(`${base}/campaigns/${metaId}/preflight`, { method: 'POST' });
  check(
    'a legacy static-token channel can never report ready',
    metaPreflight.data?.ready === false,
    metaPreflight.data
  );
  check(
    'the preflight channel snapshot carries no secret names either',
    (metaPreflight.data?.channel?.requires ?? []).every((item) => !secretLike(item)),
    metaPreflight.data?.channel
  );

  const metricsBefore = await owner.req(`${base}/metrics`);
  check(
    'no message was recorded by a refused launch',
    (metricsBefore.data?.metrics ?? []).length === 0,
    metricsBefore.data
  );
  check(
    'ROI stays unavailable without revenue',
    metricsBefore.data?.totals?.roi === null && metricsBefore.data?.totals?.costPerLead === null,
    metricsBefore.data?.totals
  );

  const metric = await owner.req(`${base}/metrics`, {
    method: 'POST',
    body: {
      campaignId,
      periodDate: '2026-11-01',
      impressions: 1000,
      engagements: 40,
      replies: 6,
      leads: 4,
      meetings: 2,
      proposals: 1,
      won: 1,
      spendSar: 500,
      revenueSar: 2500,
    },
  });
  check('a manual result period is stored', metric.status === 201, metric.data);
  const metrics = await owner.req(`${base}/metrics`);
  check(
    'totals are computed from the entered numbers only',
    metrics.data?.totals?.leads === 4 &&
      metrics.data?.totals?.spend === 500 &&
      metrics.data?.totals?.revenue === 2500 &&
      metrics.data?.totals?.roi === 400 &&
      metrics.data?.totals?.costPerLead === 125,
    metrics.data?.totals
  );

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------
  const second = await createCompany(admin, 'شركة أخرى', 'other-owner@example.com');
  const other = await signIn('other', 'other-owner@example.com', second.tempPassword, 'OtherOwner12345');
  const otherLeads = await other.req(`/api/company/${second.companyId}/growth/leads`);
  check(
    'a second tenant sees none of the first tenant leads',
    otherLeads.status === 200 && (otherLeads.data?.leads ?? []).length === 0,
    otherLeads.data
  );
  const crossTenant = await other.req(`/api/company/${first.companyId}/growth/leads`);
  check('cross-tenant reads are refused', crossTenant.status === 403, crossTenant.data);

  const viewerEmail = await admin.req('/api/admin/companies/' + first.companyId);
  check('admin can read the tenant', viewerEmail.status === 200);
}

try {
  await main();
} catch (error) {
  failures.push(`unexpected: ${error?.message ?? error}`);
  console.error(error);
} finally {
  stopServer();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(' | ')}`);
    process.exitCode = 1;
  }
}
