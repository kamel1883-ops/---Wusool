/**
 * Order intake + activation tests. Boots `wrangler dev` against a throwaway
 * local D1 database, applies all three migrations, and exercises the public
 * landing/order APIs plus Super Admin approval, suspension and email change.
 *
 * The first-admin address is pinned through the SETUP_ADMIN_EMAIL environment
 * variable (a dummy default for tests — never a real address in this repo).
 *
 * Run: npm test
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-orders-'));
const SEED_ADMIN = process.env.SETUP_ADMIN_EMAIL ?? 'seed-admin@example.com';
const DEV_VARS = join(ROOT, '.dev.vars');
let devVarsBackup = null;

// wrangler dev reads Worker bindings from the `.dev.vars` file (gitignored),
// not from the parent process environment — so the test pins the seed there
// and restores the file afterwards.
function pinSeedEmail() {
  devVarsBackup = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8') : null;
  const lines = (devVarsBackup ?? '').split('\n').filter((line) => !line.startsWith('SETUP_ADMIN_EMAIL='));
  lines.push(`SETUP_ADMIN_EMAIL=${SEED_ADMIN}`);
  writeFileSync(DEV_VARS, `${lines.join('\n')}\n`);
}

function restoreDevVars() {
  try {
    if (devVarsBackup === null) unlinkSync(DEV_VARS);
    else writeFileSync(DEV_VARS, devVarsBackup);
  } catch {
    /* best effort */
  }
}
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
    console.log(`FAIL  ${name}${detail ? ` → ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
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
    return { status: response.status, data };
  }
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

const addMonths = (dateStr, months) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
};

async function main() {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  console.log(`· using port ${PORT}`);
  console.log('· applying migrations');
  migrate('migrations/0001_init.sql');
  migrate('migrations/0002_site_analysis.sql');
  migrate('migrations/0003_orders.sql');

  console.log('· starting wrangler dev');
  pinSeedEmail();
  server = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', String(PORT), `--persist-to=${PERSIST}`, '--log-level', 'error'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, SETUP_ADMIN_EMAIL: SEED_ADMIN },
    }
  );
  await waitForServer();
  console.log('· server ready\n');

  const admin = new Client('admin');
  const anon = new Client('anon');

  // -------------------------------------------------------------------------
  // Setup is pinned to the seeded admin address
  // -------------------------------------------------------------------------
  const wrongSetup = await anon.req('/api/setup', {
    method: 'POST',
    body: { name: 'Intruder', email: 'intruder@example.com', password: 'IntruderPass12345' },
  });
  check(
    'setup rejects an address outside the seed',
    wrongSetup.status === 403 && wrongSetup.data?.error?.code === 'setup_email_not_allowed',
    wrongSetup.data
  );

  const setup = await admin.req('/api/setup', {
    method: 'POST',
    body: { name: 'Platform Admin', email: SEED_ADMIN, password: 'AdminPass12345' },
  });
  check('setup accepts the seeded admin address', setup.status === 200, setup.data);

  // -------------------------------------------------------------------------
  // Public plans catalogue
  // -------------------------------------------------------------------------
  const plans = await anon.req('/api/public/plans');
  check('public plans list is open', plans.status === 200 && plans.data.plans.length === 3, plans.data);
  const basic = plans.data.plans.find((plan) => plan.id === 'plan_starter');
  const priceOf = (plan, months) => plan?.prices.find((entry) => entry.months === months)?.price;
  check(
    'period prices match the approved table',
    priceOf(basic, 3) === 200 &&
      priceOf(basic, 12) === 800 &&
      priceOf(plans.data.plans.find((p) => p.id === 'plan_growth'), 6) === 800 &&
      priceOf(plans.data.plans.find((p) => p.id === 'plan_enterprise'), 12) === 2600,
    plans.data.plans
  );

  // -------------------------------------------------------------------------
  // Order intake creates no account
  // -------------------------------------------------------------------------
  const order = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: {
      companyName: 'شركة النور',
      contactName: 'نورة العتيبي',
      email: 'owner-noor@example.com',
      phone: '0550001122',
      planId: 'plan_starter',
      months: 6,
      password: 'NoorPass12345',
    },
  });
  check('order is accepted as pending', order.status === 201, order.data);

  const duplicate = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: {
      companyName: 'شركة النور',
      email: 'owner-noor@example.com',
      planId: 'plan_starter',
      months: 6,
      password: 'NoorPass12345',
    },
  });
  check(
    'second pending order for the same email is refused',
    duplicate.status === 409 && duplicate.data?.error?.code === 'request_pending',
    duplicate.data
  );

  const badPeriod = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: { companyName: 'X', email: 'other@example.com', planId: 'plan_starter', months: 5, password: 'OtherPass12345' },
  });
  check('invalid period is rejected', badPeriod.status === 422, badPeriod.data);

  const weak = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: { companyName: 'X', email: 'weak@example.com', planId: 'plan_starter', months: 3, password: 'short' },
  });
  check('weak password is rejected', weak.status === 422, weak.data);

  const lookup = await anon.req('/api/public/purchase-requests?email=owner-noor@example.com');
  check(
    'requester can follow their own order',
    lookup.status === 200 &&
      lookup.data.requests.length === 1 &&
      lookup.data.requests[0].status === 'pending_review',
    lookup.data
  );

  // -------------------------------------------------------------------------
  // Admin approval activates tenant + subscription + invoice
  // -------------------------------------------------------------------------
  const pending = await admin.req('/api/admin/purchase-requests?status=pending_review');
  check(
    'admin sees the pending order with the amount',
    pending.data.requests.some((row) => row.email === 'owner-noor@example.com' && row.amountSar === 400),
    pending.data
  );
  const requestId = pending.data.requests.find((row) => row.email === 'owner-noor@example.com').id;

  const approved = await admin.req(`/api/admin/purchase-requests/${requestId}/approve`, { method: 'POST' });
  check('approval creates the tenant', approved.status === 200 && Boolean(approved.data.companyId), approved.data);

  const today = new Date().toISOString().slice(0, 10);
  check(
    'subscription period matches the ordered term',
    approved.data.subscriptionEnd === addMonths(today, 6),
    approved.data
  );

  const owner = new Client('owner');
  const ownerLogin = await owner.req('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-noor@example.com', password: 'NoorPass12345' },
  });
  check('owner signs in with the chosen password', ownerLogin.status === 200, ownerLogin.data);
  const ownerProfile = await owner.req('/api/auth/me');
  check('approved owner has no forced password change', ownerProfile.data?.user?.mustChangePassword === false);

  const me = await owner.req('/api/auth/me');
  check('owner belongs to the new company', me.data?.companies?.[0]?.id === approved.data.companyId);

  const invoices = await owner.req(`/api/company/${approved.data.companyId}/invoices`);
  check(
    'first invoice exists with the ordered amount',
    invoices.data?.invoices?.some((row) => row.amountSar === 400 && row.status === 'issued'),
    invoices.data?.invoices
  );

  const repeat = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: { companyName: 'Y', email: 'owner-noor@example.com', planId: 'plan_starter', months: 3, password: 'AnotherPass12345' },
  });
  check('order for an existing account email is refused', repeat.status === 409, repeat.data);

  const again = await admin.req(`/api/admin/purchase-requests/${requestId}/approve`, { method: 'POST' });
  check('double approval is refused', again.status === 409, again.data);

  // -------------------------------------------------------------------------
  // Rejection with a visible reason
  // -------------------------------------------------------------------------
  const order2 = await anon.req('/api/public/purchase-requests', {
    method: 'POST',
    body: { companyName: 'شركة الظل', email: 'owner-shadow@example.com', planId: 'plan_growth', months: 3, password: 'ShadowPass12345' },
  });
  const shadowId = (await admin.req('/api/admin/purchase-requests?status=pending_review')).data.requests.find(
    (row) => row.email === 'owner-shadow@example.com'
  ).id;
  check('second order recorded', order2.status === 201);

  const noNote = await admin.req(`/api/admin/purchase-requests/${shadowId}/reject`, {
    method: 'POST',
    body: {},
  });
  check('rejection needs a reason', noNote.status === 422, noNote.data);

  const rejected = await admin.req(`/api/admin/purchase-requests/${shadowId}/reject`, {
    method: 'POST',
    body: { note: 'بيانات ناقصة' },
  });
  check('rejection works', rejected.status === 200, rejected.data);

  const shadowLookup = await anon.req('/api/public/purchase-requests?email=owner-shadow@example.com');
  check(
    'requester sees the rejection and reason',
    shadowLookup.data.requests[0].status === 'rejected' &&
      shadowLookup.data.requests[0].reviewNote === 'بيانات ناقصة',
    shadowLookup.data
  );

  const shadowLogin = await anon.req('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-shadow@example.com', password: 'ShadowPass12345' },
  });
  check('rejected request creates no login', shadowLogin.status === 401, shadowLogin.data);

  // -------------------------------------------------------------------------
  // Suspension revokes sessions; admin-only email change
  // -------------------------------------------------------------------------
  const suspended = await admin.req(`/api/admin/companies/${approved.data.companyId}`, {
    method: 'PATCH',
    body: { status: 'suspended' },
  });
  check('admin can suspend the company', suspended.status === 200, suspended.data);

  const afterSuspend = await owner.req('/api/auth/me');
  check('suspension revokes the owner session', afterSuspend.status === 401, afterSuspend.data);

  const reactivated = await admin.req(`/api/admin/companies/${approved.data.companyId}`, {
    method: 'PATCH',
    body: { status: 'active' },
  });
  check('admin can reactivate the company', reactivated.status === 200, reactivated.data);

  const users = await admin.req('/api/admin/users?q=owner-noor@example.com');
  const targetId = users.data.users[0].id;

  const changed = await admin.req(`/api/admin/users/${targetId}/email`, {
    method: 'PATCH',
    body: { email: 'owner-noor-new@example.com' },
  });
  check('admin changes the user email', changed.status === 200, changed.data);

  const newLogin = await anon.req('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-noor-new@example.com', password: 'NoorPass12345' },
  });
  check('new email signs in with the same password', newLogin.status === 200, newLogin.data);
  const ownerNew = new Client('ownerNew');
  const relogin = await ownerNew.req('/api/auth/login', {
    method: 'POST',
    body: { email: 'owner-noor-new@example.com', password: 'NoorPass12345' },
  });
  check('re-login confirms the email change', relogin.status === 200);

  const audit = await admin.req('/api/admin/audit?action=user.email_changed&limit=10');
  check(
    'email change is audited with both addresses',
    (audit.data?.logs ?? []).some(
      (row) => row.meta?.previousEmail === 'owner-noor@example.com' && row.meta?.newEmail === 'owner-noor-new@example.com'
    ),
    audit.data?.logs
  );

  const selfEmail = await ownerNew.req('/api/auth/profile', { method: 'PATCH', body: { email: 'hacker@example.com' } });
  const stillMe = await ownerNew.req('/api/auth/me');
  check(
    'tenant cannot change their own email',
    selfEmail.status === 200 && stillMe.data?.user?.email === 'owner-noor-new@example.com',
    stillMe.data?.user
  );

  // -------------------------------------------------------------------------
  // Plan price management
  // -------------------------------------------------------------------------
  const prices = await admin.req('/api/admin/plans/plan_starter/prices');
  check('admin reads period prices', prices.data.prices.length === 4, prices.data);

  const priceUpdate = await admin.req('/api/admin/plans/plan_starter/prices', {
    method: 'PUT',
    body: { prices: [{ months: 3, price: 200 }, { months: 6, price: 400 }, { months: 9, price: 600 }, { months: 12, price: 800 }] },
  });
  check('admin rewrites period prices', priceUpdate.status === 200, priceUpdate.data);

  const badPrices = await admin.req('/api/admin/plans/plan_starter/prices', {
    method: 'PUT',
    body: { prices: [{ months: 5, price: 100 }] },
  });
  check('invalid period in prices is rejected', badPrices.status === 422, badPrices.data);

  const tenantPrices = await anon.req('/api/admin/plans/plan_starter/prices');
  check('tenant cannot reach price management', tenantPrices.status === 403, tenantPrices.data);
}

main()
  .catch((error) => {
    failures.push(`fatal: ${error.message}`);
    console.error(error);
  })
  .finally(async () => {
    stopServer();
    restoreDevVars();
    await sleep(800);
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('failed checks:');
      for (const name of failures) console.log(` - ${name}`);
    }
    process.exit(failures.length ? 1 : 0);
  });
