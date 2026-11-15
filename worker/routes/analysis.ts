/**
 * Site-analysis routes for a tenant workspace. Mounted at /api/company.
 *
 * Every route resolves the company from the caller's membership (never from the
 * URL alone), checks the permission on the server, records an audit entry, and
 * filters rows by the resolved company id — so changing an id in the request
 * cannot reach another tenant's data.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import { companyContext, requireAuth } from '../lib/auth';
import {
  all,
  audit,
  computeSubscription,
  first,
  getSettings,
  newId,
  nowIso,
  readJson,
  run,
  str,
} from '../lib/db';
import { can } from '../lib/rbac';
import { apiError } from './public';
import {
  analysisLimits,
  checkAnalysisQuota,
  clampRequestedLimits,
  startAnalysisJob,
} from '../lib/analysis-pipeline';
import { aiProviderStatus } from '../lib/ai';
import { CrawlerError, normalizeSiteUrl } from '../lib/crawler/types';
import { normalizeResult, overallConfidence, sourceSummary } from '../lib/ai/types';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

const REVIEW_PERMISSION = 'analysis.review';
const EDIT_PERMISSION = 'analysis.edit';
const APPROVE_PERMISSION = 'analysis.approve';
const CREATE_PERMISSION = 'analysis.create';

const canReview = (role: string | undefined) => can(role, REVIEW_PERMISSION) || can(role, APPROVE_PERMISSION);

const serializeAnalysis = (row: any) => ({
  id: row.id,
  companyId: row.company_id,
  url: row.url,
  normalizedUrl: row.normalized_url,
  status: row.status,
  provider: row.provider,
  model: row.model,
  crawlerProvider: row.crawler_provider,
  locale: row.locale,
  maxPages: row.max_pages,
  maxDepth: row.max_depth,
  consentConfirmed: Boolean(row.consent_confirmed),
  latestVersion: row.latest_version,
  approvedVersion: row.approved_version,
  robotsPolicy: row.robots_policy,
  pagesFound: row.pages_found,
  pagesAnalyzed: row.pages_analyzed,
  pagesFailed: row.pages_failed,
  errorMessage: row.error_message,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeResult = (row: any) => ({
  id: row.id,
  analysisId: row.analysis_id,
  version: row.version,
  result: row.result_json ? JSON.parse(row.result_json) : null,
  confidence: row.confidence,
  sourceSummary: row.source_summary ? JSON.parse(row.source_summary) : null,
  createdByAi: Boolean(row.created_by_ai),
  editedByUser: row.edited_by_user,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const serializeApproval = (row: any) => ({
  id: row.id,
  version: row.version,
  action: row.action,
  userId: row.user_id,
  userName: row.user_name ?? null,
  comment: row.comment,
  createdAt: row.created_at,
});

async function loadAnalysis(env: any, companyId: string, analysisId: string) {
  return first<any>(
    env,
    'SELECT * FROM site_analyses WHERE id = ? AND company_id = ?',
    analysisId,
    companyId
  );
}

async function latestResult(env: any, analysisId: string, companyId: string, version?: number) {
  if (version) {
    return first<any>(
      env,
      'SELECT * FROM analysis_results WHERE analysis_id = ? AND company_id = ? AND version = ?',
      analysisId,
      companyId,
      version
    );
  }
  return first<any>(
    env,
    `SELECT * FROM analysis_results WHERE analysis_id = ? AND company_id = ?
      ORDER BY version DESC LIMIT 1`,
    analysisId,
    companyId
  );
}

const canReadAnalysis = (role: string | undefined, analysis: any) =>
  canReview(role) || analysis.status === 'approved';

// ---------------------------------------------------------------------------
// Create / list / detail
// ---------------------------------------------------------------------------

app.post('/:companyId/site-analyses', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, CREATE_PERMISSION)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const limits = analysisLimits(c.env, settings);
  const body = await readJson<Record<string, unknown>>(c);

  if (limits.requireConsent && body.consent !== true) return apiError(c, 422, 'consent_required');

  let url: URL;
  try {
    url = normalizeSiteUrl(str(body.url, 500));
  } catch (error) {
    const code = error instanceof CrawlerError ? error.code : 'invalid_url';
    return apiError(c, 422, code);
  }

  const locale = body.locale === 'en' ? 'en' : body.locale === 'ar-en' ? 'ar-en' : 'ar';
  const requested = clampRequestedLimits(limits, body.maxPages, body.maxDepth);

  const quota = await checkAnalysisQuota(c.env, company.id, limits);
  if (!quota.ok) return apiError(c, quota.status, quota.code);

  const id = newId('ana');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO site_analyses (id, company_id, created_by, url, normalized_url, status, locale,
       max_pages, max_depth, consent_confirmed, provider, model, crawler_provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    id,
    company.id,
    actor.id,
    url.toString(),
    url.toString(),
    locale,
    requested.maxPages,
    requested.maxDepth,
    aiProviderStatus(c.env, settings).provider,
    aiProviderStatus(c.env, settings).model,
    String(settings['analysis.crawler_provider'] ?? 'mock'),
    timestamp,
    timestamp
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.created',
    entityType: 'site_analysis',
    entityId: id,
    meta: { url: url.toString(), locale, maxPages: requested.maxPages, maxDepth: requested.maxDepth },
  });

  const row = await loadAnalysis(c.env, company.id, id);
  return c.json({ analysis: serializeAnalysis(row) }, 201);
});

app.get('/:companyId/site-analyses', async (c) => {
  const company = c.get('company');
  const role = c.get('role');
  const settings = await getSettings(c.env);
  const limits = analysisLimits(c.env, settings);

  const rows = canReview(role)
    ? await all<any>(
        c.env,
        'SELECT * FROM site_analyses WHERE company_id = ? ORDER BY created_at DESC LIMIT 100',
        company.id
      )
    : await all<any>(
        c.env,
        `SELECT * FROM site_analyses WHERE company_id = ? AND status = 'approved'
          ORDER BY created_at DESC LIMIT 100`,
        company.id
      );

  return c.json({
    analyses: rows.map(serializeAnalysis),
    ai: aiProviderStatus(c.env, settings),
    limits: {
      defaultMaxPages: limits.defaultMaxPages,
      defaultMaxDepth: limits.defaultMaxDepth,
      hardMaxPages: limits.hardMaxPages,
      hardMaxDepth: limits.hardMaxDepth,
      requireConsent: limits.requireConsent,
      showCostToClient: limits.showCostToClient,
    },
    capabilities: {
      create: can(role, CREATE_PERMISSION),
      edit: can(role, EDIT_PERMISSION),
      review: canReview(role),
      approve: can(role, APPROVE_PERMISSION),
    },
  });
});

app.get('/:companyId/site-analyses/:analysisId', async (c) => {
  const company = c.get('company');
  const role = c.get('role');
  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!canReadAnalysis(role, analysis)) return apiError(c, 403, 'forbidden');

  const versionParam = Number(c.req.query('version'));
  const version = Number.isFinite(versionParam) && versionParam > 0 ? versionParam : undefined;
  if (!canReview(role) && version && version !== analysis.approved_version) {
    return apiError(c, 403, 'forbidden');
  }

  const result = await latestResult(c.env, analysis.id, company.id, version);
  const versions = await all<any>(
    c.env,
    `SELECT id, version, confidence, edited_by_user, created_at FROM analysis_results
      WHERE analysis_id = ? AND company_id = ? ORDER BY version DESC`,
    analysis.id,
    company.id
  );
  const approvals = canReview(role)
    ? await all<any>(
        c.env,
        `SELECT a.*, u.name AS user_name FROM analysis_approvals a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.analysis_id = ? AND a.company_id = ? ORDER BY a.created_at DESC`,
        analysis.id,
        company.id
      )
    : [];

  const settings = await getSettings(c.env);
  const limits = analysisLimits(c.env, settings);

  return c.json({
    analysis: serializeAnalysis(analysis),
    result: result ? serializeResult(result) : null,
    versions: versions.map((row) => ({
      id: row.id,
      version: row.version,
      confidence: row.confidence,
      editedByUser: row.edited_by_user,
      createdAt: row.created_at,
    })),
    approvals: approvals.map(serializeApproval),
    ai: aiProviderStatus(c.env, settings),
    capabilities: {
      // Editing an approved report is allowed but reopens the review (a new
      // version is created and `approved_version` is cleared).
      edit: can(role, EDIT_PERMISSION),
      review: canReview(role),
      approve: can(role, APPROVE_PERMISSION),
      reopen: can(role, EDIT_PERMISSION) && analysis.status === 'approved',
      showCost: limits.showCostToClient,
    },
  });
});

// ---------------------------------------------------------------------------
// Job control
// ---------------------------------------------------------------------------

app.post('/:companyId/site-analyses/:analysisId/start', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, CREATE_PERMISSION)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!analysis.consent_confirmed && analysisLimits(c.env, settings).requireConsent) {
    return apiError(c, 422, 'consent_required');
  }

  const outcome = await startAnalysisJob(c.env, analysis, actor, settings);
  if (!outcome.ok) return apiError(c, outcome.status, outcome.code);

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  const result = await latestResult(c.env, analysis.id, company.id);
  return c.json({
    analysis: serializeAnalysis(row),
    result: result ? serializeResult(result) : null,
  });
});

app.post('/:companyId/site-analyses/:analysisId/retry', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, CREATE_PERMISSION)) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) return apiError(c, 402, 'subscription_inactive');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['failed', 'cancelled', 'changes_requested'].includes(analysis.status)) {
    return apiError(c, 409, 'analysis_not_retryable');
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.retried',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { previousStatus: analysis.status },
  });

  const outcome = await startAnalysisJob(c.env, analysis, actor, settings);
  if (!outcome.ok) return apiError(c, outcome.status, outcome.code);

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  const result = await latestResult(c.env, analysis.id, company.id);
  return c.json({
    analysis: serializeAnalysis(row),
    result: result ? serializeResult(result) : null,
  });
});

app.post('/:companyId/site-analyses/:analysisId/cancel', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, CREATE_PERMISSION)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['draft', 'queued', 'crawling', 'extracting', 'analyzing'].includes(analysis.status)) {
    return apiError(c, 409, 'analysis_not_cancellable');
  }

  await run(
    c.env,
    `UPDATE site_analyses SET status = 'cancelled', completed_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    nowIso(),
    nowIso(),
    analysis.id,
    company.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.cancelled',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { previousStatus: analysis.status },
  });

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  return c.json({ analysis: serializeAnalysis(row) });
});

// ---------------------------------------------------------------------------
// Results editing and human approval
// ---------------------------------------------------------------------------

app.put('/:companyId/site-analyses/:analysisId/results', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, EDIT_PERMISSION)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');

  const body = await readJson<{ result?: unknown; comment?: unknown }>(c);
  if (!body.result || typeof body.result !== 'object') return apiError(c, 422, 'result_required');

  const result = normalizeResult(body.result);
  const version = (Number(analysis.latest_version) || 0) + 1;
  const timestamp = nowIso();

  await run(
    c.env,
    `INSERT INTO analysis_results (id, analysis_id, company_id, version, result_json, source_summary,
       confidence, created_by_ai, edited_by_user, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    newId('res'),
    analysis.id,
    company.id,
    version,
    JSON.stringify(result),
    JSON.stringify(sourceSummary(result)),
    overallConfidence(result),
    actor.id,
    timestamp,
    timestamp
  );

  // An edit of an approved report reopens the review: approval is always the
  // last human action, never something inherited from an older version.
  const reopened = analysis.status === 'approved';
  await run(
    c.env,
    `UPDATE site_analyses SET latest_version = ?, status = 'awaiting_review', approved_version = NULL,
       updated_at = ? WHERE id = ? AND company_id = ?`,
    version,
    timestamp,
    analysis.id,
    company.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.edited',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { version, reopened, comment: str(body.comment, 500) || null },
  });

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  const saved = await latestResult(c.env, analysis.id, company.id, version);
  return c.json({ analysis: serializeAnalysis(row), result: serializeResult(saved) });
});

async function recordApproval(
  env: any,
  analysis: any,
  action: 'submitted' | 'approved' | 'changes_requested' | 'reanalysis_requested',
  userId: string,
  comment: string | null,
  version: number
) {
  await run(
    env,
    `INSERT INTO analysis_approvals (id, analysis_id, company_id, version, action, user_id, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('apr'),
    analysis.id,
    analysis.company_id,
    version,
    action,
    userId,
    comment,
    nowIso()
  );
}

app.post('/:companyId/site-analyses/:analysisId/submit-review', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, EDIT_PERMISSION)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['draft', 'changes_requested', 'awaiting_review'].includes(analysis.status)) {
    return apiError(c, 409, 'invalid_status');
  }
  if (!analysis.latest_version) return apiError(c, 409, 'analysis_has_no_result');

  const body = await readJson<{ comment?: unknown }>(c);
  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE site_analyses SET status = 'awaiting_review', updated_at = ? WHERE id = ? AND company_id = ?`,
    timestamp,
    analysis.id,
    company.id
  );
  await recordApproval(
    c.env,
    analysis,
    'submitted',
    actor.id,
    str(body.comment, 1000) || null,
    analysis.latest_version
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.submitted',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { version: analysis.latest_version },
  });

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  return c.json({ analysis: serializeAnalysis(row) });
});

app.post('/:companyId/site-analyses/:analysisId/approve', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!can(role, APPROVE_PERMISSION)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (analysis.status !== 'awaiting_review') return apiError(c, 409, 'invalid_status');
  if (!analysis.latest_version) return apiError(c, 409, 'analysis_has_no_result');

  const body = await readJson<{ comment?: unknown }>(c);
  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE site_analyses SET status = 'approved', approved_version = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    analysis.latest_version,
    timestamp,
    analysis.id,
    company.id
  );
  await recordApproval(
    c.env,
    analysis,
    'approved',
    actor.id,
    str(body.comment, 1000) || null,
    analysis.latest_version
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.approved',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { version: analysis.latest_version, approvedAt: timestamp },
  });

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  return c.json({ analysis: serializeAnalysis(row) });
});

app.post('/:companyId/site-analyses/:analysisId/request-changes', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role');
  if (!canReview(role)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['awaiting_review', 'approved'].includes(analysis.status)) {
    return apiError(c, 409, 'invalid_status');
  }

  const body = await readJson<{ comment?: unknown }>(c);
  const comment = str(body.comment, 1000);
  if (!comment) return apiError(c, 422, 'comment_required');

  await run(
    c.env,
    `UPDATE site_analyses SET status = 'changes_requested', approved_version = NULL, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    nowIso(),
    analysis.id,
    company.id
  );
  await recordApproval(c.env, analysis, 'changes_requested', actor.id, comment, analysis.latest_version);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'site_analysis.changes_requested',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { version: analysis.latest_version, comment },
  });

  const row = await loadAnalysis(c.env, company.id, analysis.id);
  return c.json({ analysis: serializeAnalysis(row) });
});

app.get('/:companyId/site-analyses/:analysisId/pages', async (c) => {
  const company = c.get('company');
  const role = c.get('role');
  if (!canReview(role)) return apiError(c, 403, 'forbidden');

  const analysis = await loadAnalysis(c.env, company.id, c.req.param('analysisId'));
  if (!analysis) return apiError(c, 404, 'analysis_not_found');

  const pages = await all<any>(
    c.env,
    `SELECT id, url, title, status_code, word_count, depth, crawl_status, error_message, created_at
       FROM site_pages WHERE analysis_id = ? AND company_id = ? ORDER BY depth, created_at`,
    analysis.id,
    company.id
  );
  return c.json({
    pages: pages.map((page) => ({
      id: page.id,
      url: page.url,
      title: page.title,
      statusCode: page.status_code,
      wordCount: page.word_count,
      depth: page.depth,
      status: page.crawl_status,
      errorMessage: page.error_message,
      createdAt: page.created_at,
    })),
  });
});

export default app;
