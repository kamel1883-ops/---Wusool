/**
 * OpenStreetMap open-data discovery.
 *
 * Two layers are checked:
 *   1. The connector itself (bundled with esbuild and imported directly):
 *      Saudi-city resolution, one bounded Overpass query, contact mapping,
 *      ODbL attribution, and stable failure codes for busy/timed-out servers.
 *   2. The real HTTP endpoint with `LEAD_DATA_PROVIDER=openstreetmap` and a
 *      local Overpass stand-in: an approved analysis plus a Saudi city produce
 *      leads whose source link and attribution are the OSM ones, duplicates are
 *      not inserted twice, and nothing is invented.
 *
 * No real network call is made: the Overpass endpoint is the local mock.
 *
 * Run: npm test
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const PERSIST = mkdtempSync(join(tmpdir(), 'wusool-osm-'));
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

/** A local stand-in for an Overpass interpreter. */
function startOverpassMock(options = {}) {
  const state = {
    requests: [],
    status: options.status ?? 200,
    body: options.body ?? JSON.stringify({ elements: [] }),
    delayMs: options.delayMs ?? 0,
    count: 0,
  };
  const server = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      state.count += 1;
      state.requests.push({
        url: req.url,
        userAgent: req.headers['user-agent'] ?? '',
        contentType: req.headers['content-type'] ?? '',
        raw,
      });
      const send = () => {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(state.body);
      };
      if (state.delayMs) setTimeout(send, state.delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${address.port}/api/interpreter`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function waitForServer(timeoutMs = 120_000) {
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
    return { status: response.status, data };
  }
}

async function signIn(label, email, password, newPassword) {
  const client = new Client(label);
  const login = await client.req('/api/auth/login', { method: 'POST', body: { email, password } });
  if (login.status !== 200) throw new Error(`${label} login failed: ${login.status}`);
  if (newPassword) {
    await client.req('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: password, newPassword },
    });
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
  return {
    companyId: created.data?.companyId ?? created.data?.company?.id ?? created.data?.id,
    tempPassword: created.data?.ownerTempPassword,
  };
}

/** Overpass elements used by both layers of this test. */
const ELEMENTS = [
  {
    type: 'node',
    id: 101,
    lat: 24.7,
    lon: 46.7,
    tags: {
      name: 'مخبز الرياض',
      amenity: 'bakery',
      phone: '+966 11 123 4567',
      website: 'www.example-bakery.sa',
      'addr:city': 'الرياض',
      'addr:street': 'شارع العليا',
    },
  },
  {
    type: 'way',
    id: 202,
    center: { lat: 24.8, lon: 46.6 },
    tags: {
      name: 'Al Noor Clinics',
      healthcare: 'clinic',
      'contact:phone': '+966112233445',
      'contact:email': 'info@alnoor.example',
    },
  },
  { type: 'node', id: 303, lat: 24.9, lon: 46.9, tags: { amenity: 'cafe', phone: '+966112223344' } },
  { type: 'node', id: 404, lat: 24.6, lon: 46.6, tags: { name: 'بلا بيانات اتصال', amenity: 'shop' } },
];

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

async function bundleConnector() {
  const outfile = join(PERSIST, 'openstreetmap.mjs');
  const result = spawnSync(
    'npx',
    [
      'esbuild',
      'worker/lib/openstreetmap.ts',
      '--bundle',
      '--format=esm',
      '--target=es2022',
      '--platform=neutral',
      `--outfile=${outfile}`,
      '--log-level=error',
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error('could not bundle the OSM connector');
  }
  return import(pathToFileURL(outfile).href);
}

async function connectorChecks() {
  console.log('· connector: city resolution, query shape, mapping, failures');
  const osm = await bundleConnector();

  const riyadh = osm.resolveSaudiCity('الرياض');
  check('arabic city resolves to Riyadh', riyadh?.en === 'Riyadh', riyadh);
  check('english city resolves to Riyadh', osm.resolveSaudiCity('riyadh')?.ar === 'الرياض');
  check('spelling variant resolves', osm.resolveSaudiCity('جده')?.en === 'Jeddah');
  check(
    'city with a country suffix still resolves',
    osm.resolveSaudiCity('الرياض، السعودية')?.en === 'Riyadh'
  );
  check('non-Saudi city is not supported', osm.resolveSaudiCity('Dubai') === null);
  check('empty city is not supported', osm.resolveSaudiCity('') === null);

  const query = osm.buildOverpassQuery(riyadh, 12);
  check('query targets the city bounding box', query.includes('(24.3,46.2,25.1,47.2)'), query);
  check('query caps the returned elements', query.includes('out center tags 12;'), query);
  check('query requires a published contact detail', query.includes('phone|contact:phone'), query);
  check('query does not ask for a key', !/authorization/i.test(query));
  check('query cap cannot exceed 50', osm.buildOverpassQuery(riyadh, 5000).includes('out center tags 50;'));

  const bakery = osm.mapOsmElement(ELEMENTS[0], riyadh);
  check('a business with a phone becomes a lead', bakery?.companyName === 'مخبز الرياض', bakery);
  check('website without a scheme gets https', bakery?.website === 'https://www.example-bakery.sa/', bakery?.website);
  check('phone keeps its published origin', bakery?.phoneSource === 'public_page', bakery);
  check(
    'source link is the OSM element',
    bakery?.sourceUrl === 'https://www.openstreetmap.org/node/101',
    bakery?.sourceUrl
  );
  check(
    'evidence carries the ODbL attribution',
    /OpenStreetMap/.test(bakery?.evidence ?? '') && /ODbL/.test(bakery?.evidence ?? ''),
    bakery?.evidence
  );
  check('signal is a fit, not an invented request', bakery?.signal === 'company_fit');

  const clinic = osm.mapOsmElement(ELEMENTS[1], riyadh);
  check('a way with contact tags becomes a lead', clinic?.companyName === 'Al Noor Clinics', clinic);
  check('contact:phone is used as the phone', clinic?.phone === '+966112233445', clinic?.phone);
  check('contact:email is used as the email', clinic?.email === 'info@alnoor.example', clinic?.email);
  check('sector is shown with its Arabic label', clinic?.sector === 'عيادة', clinic?.sector);
  check(
    'sector hints carry the tag and the Arabic plural for matching',
    (clinic?.sectorHints ?? []).includes('clinic') && (clinic?.sectorHints ?? []).includes('عيادات'),
    clinic?.sectorHints
  );
  check(
    'the dedupe key is the OSM element identity',
    bakery?.dedupeKey === 'osm:node/101',
    bakery?.dedupeKey
  );

  check('an element without a name is dropped', osm.mapOsmElement(ELEMENTS[2], riyadh) === null);
  check('an element without contact data is dropped', osm.mapOsmElement(ELEMENTS[3], riyadh) === null);
  check('malformed input is dropped', osm.mapOsmElement({ type: 'node' }, riyadh) === null);

  // --- A real request against the local Overpass stand-in -------------------
  const mock = await startOverpassMock({
    body: JSON.stringify({ version: 0.6, elements: ELEMENTS }),
  });
  const result = await osm.discoverOpenDataLeads({ endpoint: mock.url, city: riyadh, limit: 10 });
  check('the request is one bounded Overpass call', mock.state.count === 1, mock.state.count);
  check('two valid records become leads', result.leads.length === 2, result.leads.length);
  check('records without name or contact are counted as skipped', result.skipped === 2, result.skipped);
  check(
    'the request identifies the app and the data licence',
    /Wusool/.test(mock.state.requests[0]?.userAgent ?? '') &&
      /openstreetmap\.org/.test(mock.state.requests[0]?.userAgent ?? ''),
    mock.state.requests[0]?.userAgent
  );
  check(
    'the query is sent as Overpass `data`',
    (mock.state.requests[0]?.raw ?? '').startsWith('data=') &&
      decodeURIComponent(mock.state.requests[0].raw).includes('[out:json]'),
    (mock.state.requests[0]?.raw ?? '').slice(0, 120)
  );
  check(
    'no credential header is sent to the open source',
    !/authorization/i.test(JSON.stringify(mock.state.requests[0] ?? {})),
    mock.state.requests[0]
  );
  await mock.close();

  // --- Stable failure codes -------------------------------------------------
  const calls = [];
  const stubFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('overpass-api.de')) {
      return new Response('# 502 Gateway Timeout', { status: 502 });
    }
    return new Response(JSON.stringify({ elements: ELEMENTS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const fallback = await osm.discoverOpenDataLeads({
    endpoint: null,
    city: riyadh,
    limit: 5,
    fetchImpl: stubFetch,
  });
  check(
    'an at-capacity primary is retried once on the fallback instance',
    calls.length === 2 && calls[1].includes('kumi') && fallback.leads.length === 2,
    calls
  );
  check(
    'the fallback attempt keeps the same bounded query',
    !calls.some((url) => url.includes('?')),
    calls
  );

  const busy = await startOverpassMock({ status: 502, body: '# 502 Gateway Timeout' });
  const busyError = await osm
    .discoverOpenDataLeads({ endpoint: busy.url, city: riyadh, limit: 5 })
    .then(() => null)
    .catch((error) => error);
  check('a busy instance reports lead_source_busy', busyError?.code === 'lead_source_busy', busyError?.code);
  await busy.close();

  const html = await startOverpassMock({ status: 200, body: '<html>maintenance</html>' });
  const htmlError = await osm
    .discoverOpenDataLeads({ endpoint: html.url, city: riyadh, limit: 5 })
    .then(() => null)
    .catch((error) => error);
  check('a non-JSON page is not treated as zero leads', htmlError?.code === 'lead_source_busy', htmlError?.code);
  await html.close();

  const slow = await startOverpassMock({
    delayMs: 1500,
    body: JSON.stringify({ elements: ELEMENTS }),
  });
  const slowError = await osm
    .discoverOpenDataLeads({ endpoint: slow.url, city: riyadh, limit: 5, timeoutMs: 250 })
    .then(() => null)
    .catch((error) => error);
  check('a slow query reports lead_source_timeout', slowError?.code === 'lead_source_timeout', slowError?.code);
  await slow.close();

  const remark = await startOverpassMock({
    body: JSON.stringify({ elements: [], remark: 'runtime error: Query timed out in "query" at line 3' }),
  });
  const remarkError = await osm
    .discoverOpenDataLeads({ endpoint: remark.url, city: riyadh, limit: 5 })
    .then(() => null)
    .catch((error) => error);
  check(
    'an Overpass runtime timeout inside a 200 is not reported as "no leads"',
    remarkError?.code === 'lead_source_timeout',
    remarkError?.code
  );
  await remark.close();
}

async function httpChecks() {
  console.log('\n· http: discovery through the API with a local Overpass stand-in');
  const mock = await startOverpassMock({
    body: JSON.stringify({ version: 0.6, elements: ELEMENTS }),
  });

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
  ]) {
    migrate(file);
  }

  server = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--local',
      '--port',
      String(PORT),
      `--persist-to=${PERSIST}`,
      '--log-level',
      'error',
      // Wrangler only exposes `--var` values to the Worker; process env would
      // not reach `c.env` inside workerd.
      '--var',
      'LEAD_DATA_PROVIDER:openstreetmap',
      '--var',
      `LEAD_DATA_API_URL:${mock.url}`,
      '--var',
      // Two seconds keeps the test fast while still proving the guard exists.
      'LEAD_DISCOVERY_COOLDOWN_SECONDS:2',
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env },
    }
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

  const first = await createCompany(admin, 'شركة الرياض', 'osm-owner@example.com');
  const owner = await signIn('owner', 'osm-owner@example.com', first.tempPassword, 'OsmOwner12345');
  const base = `/api/company/${first.companyId}/growth`;

  const overview = await owner.req(base);
  const osmSource = (overview.data?.sources ?? []).find((source) => source.provider === 'openstreetmap');
  check('the OSM source is reported as connected without a key', osmSource?.state === 'connected', osmSource);
  check(
    'the OSM source states the data licence',
    (osmSource?.requires ?? []).some((line) => line.includes('ODbL')),
    osmSource
  );

  // Discovery still starts from an approved analysis.
  const noAnalysis = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 5 } });
  check(
    'discovery still needs an approved analysis',
    noAnalysis.status === 409 && noAnalysis.data?.error?.code === 'analysis_not_approved',
    noAnalysis.data
  );

  const analysis = await owner.req(`/api/company/${first.companyId}/site-analyses`, {
    method: 'POST',
    body: { url: 'example.com', locale: 'ar', consent: true, maxPages: 2, maxDepth: 1 },
  });
  const analysisId = analysis.data?.analysis?.id;
  await owner.req(`/api/company/${first.companyId}/site-analyses/${analysisId}/start`, { method: 'POST' });
  const approved = await owner.req(
    `/api/company/${first.companyId}/site-analyses/${analysisId}/approve`,
    { method: 'POST', body: { comment: 'معتمد' } }
  );
  check('the mock analysis is approved', approved.status === 200, approved.data);

  const withoutCity = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 5 } });
  check(
    'discovery without a supported Saudi city is refused',
    withoutCity.status === 422 && withoutCity.data?.error?.code === 'lead_city_not_supported',
    withoutCity.data
  );
  check('a refused discovery makes no Overpass call', mock.state.count === 0, mock.state.count);

  await owner.req(`${base}/icp`, { method: 'PUT', body: { cities: ['الرياض'], sectors: ['مخابز'] } });

  const run = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 10 } });
  check('discovery runs against OpenStreetMap', run.status === 200, run.data);
  check('two documented leads are inserted', run.data?.inserted === 2, run.data);
  check('records without enough evidence are skipped', run.data?.skipped === 2, run.data);
  check('the response names the city that was queried', run.data?.city === 'الرياض', run.data);
  check('exactly one Overpass query was sent', mock.state.count === 1, mock.state.count);
  check(
    'the discovery response names the open-data provider',
    run.data?.provider === 'openstreetmap',
    run.data
  );

  const leads = await owner.req(`${base}/leads`);
  const rows = leads.data?.leads ?? [];
  check('the discovered leads are listed', rows.length === 2, rows.length);
  const bakery = rows.find((lead) => lead.companyName === 'مخبز الرياض');
  check('the OSM provider is stored on the lead', bakery?.sourceProvider === 'openstreetmap', bakery?.sourceProvider);
  check(
    'the lead keeps its OSM element link',
    bakery?.sourceUrl === 'https://www.openstreetmap.org/node/101',
    bakery?.sourceUrl
  );
  check('the lead keeps the published phone', bakery?.phone === '+966 11 123 4567', bakery?.phone);
  check('the lead carries a score with reasons', bakery?.score > 0 && bakery?.scoreReasons?.length > 0, bakery);
  check(
    'the lead evidence names OpenStreetMap and ODbL',
    /OpenStreetMap/.test(bakery?.evidenceText ?? '') && /ODbL/.test(bakery?.evidenceText ?? ''),
    bakery?.evidenceText
  );
  check(
    'no lead claims consent it did not receive',
    rows.every((lead) => lead.consentState === 'unknown' && lead.doNotContact === false),
    rows.map((lead) => lead.consentState)
  );
  check(
    'no discovered record starts qualified',
    rows.every((lead) => lead.stage === 'new'),
    rows.map((lead) => lead.stage)
  );
  check(
    'the stored classification is potential',
    rows.every((lead) => lead.classification === 'potential'),
    rows.map((lead) => lead.classification)
  );
  check(
    'the match score explains a sector match with the profile activity',
    (bakery?.scoreReasons ?? []).some((reason) => reason.code === 'sector_match'),
    bakery?.scoreReasons
  );

  const stats = await owner.req(base);
  check('the overview counts potential and confirmed separately',
    stats.data?.stats?.potential === 2 && stats.data?.stats?.confirmed === 0,
    stats.data?.stats
  );

  const tooSoon = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 10 } });
  check(
    'a repeated run is refused by the Overpass cooldown',
    tooSoon.status === 429 && tooSoon.data?.error?.code === 'lead_source_cooldown',
    tooSoon.data
  );
  check('the cooldown refusal sends no second query', mock.state.count === 1, mock.state.count);

  await sleep(2200);
  const again = await owner.req(`${base}/discover`, { method: 'POST', body: { limit: 10 } });
  check(
    'a later run does not duplicate the same OSM elements',
    again.status === 200 && again.data?.inserted === 0 && again.data?.skipped === 4,
    again.data
  );
  check('the dedupe run sends exactly one more query', mock.state.count === 2, mock.state.count);

  const clinic = rows.find((lead) => lead.companyName === 'Al Noor Clinics');
  const confirmed = await owner.req(`${base}/leads/${clinic.id}`, {
    method: 'PATCH',
    body: { stage: 'qualified' },
  });
  check(
    'only a human stage change confirms a lead',
    confirmed.status === 200 && confirmed.data?.lead?.classification === 'confirmed',
    confirmed.data
  );
  const afterConfirm = await owner.req(base);
  check(
    'confirmed and potential are counted separately after review',
    afterConfirm.data?.stats?.confirmed === 1 && afterConfirm.data?.stats?.potential === 1,
    afterConfirm.data?.stats
  );

  // Tenant isolation: a second company sees none of the first company's leads.
  const second = await createCompany(admin, 'شركة جدة', 'osm-other@example.com');
  const other = await signIn('other', 'osm-other@example.com', second.tempPassword, 'OsmOther12345');
  const otherLeads = await other.req(`/api/company/${second.companyId}/growth/leads`);
  check('another tenant sees no leads from this run', (otherLeads.data?.leads ?? []).length === 0, otherLeads.data);
  const otherOverview = await other.req(`/api/company/${second.companyId}/growth`);
  const overviewJson = JSON.stringify(otherOverview.data);
  check(
    'the source list exposes neither the endpoint nor a credential value',
    !overviewJson.includes('127.0.0.1') && !/bearer/i.test(overviewJson) && !overviewJson.includes('LEAD_DATA_API_KEY='),
    otherOverview.data?.sources
  );

  await mock.close();
}

async function main() {
  try {
    await connectorChecks();
    await httpChecks();
  } finally {
    stopServer();
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((name) => ` - ${name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
