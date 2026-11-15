/**
 * Site-analysis pipeline (crawl → extract → analyse → draft report).
 *
 * Runs inside the Worker request so no background queue or extra service is
 * required. Limits (pages, depth, concurrency, hourly rate) come from platform
 * settings and are re-clamped here, so a client can never raise them.
 */
import type { Env } from './db';
import { audit, first, newId, nowIso, run } from './db';
import { sha256Hex } from './auth';
import { aiProviderStatus, resolveAiProvider } from './ai';
import { ProviderError, normalizeResult, overallConfidence, sourceSummary } from './ai/types';
import { CrawlerError, resolveCrawlerProvider, type CrawlResult } from './crawler';

export type AnalysisLimits = {
  defaultMaxPages: number;
  defaultMaxDepth: number;
  hardMaxPages: number;
  hardMaxDepth: number;
  maxConcurrent: number;
  rateLimitPerHour: number;
  requireConsent: boolean;
  showCostToClient: boolean;
};

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

export function analysisLimits(_env: Env, settings: Record<string, string>): AnalysisLimits {
  return {
    defaultMaxPages: int(settings['analysis.default_max_pages'], 10),
    defaultMaxDepth: int(settings['analysis.default_max_depth'], 2),
    hardMaxPages: Math.min(int(settings['analysis.max_pages_hard_limit'], 40), 40),
    hardMaxDepth: Math.min(int(settings['analysis.max_depth_hard_limit'], 4), 4),
    maxConcurrent: Math.min(int(settings['analysis.max_concurrent_jobs'], 1), 5),
    rateLimitPerHour: int(settings['analysis.rate_limit_per_hour'], 10),
    requireConsent: (settings['analysis.require_consent'] ?? '1') !== '0',
    showCostToClient: (settings['analysis.show_cost_to_client'] ?? '0') === '1',
  };
}

export function clampRequestedLimits(
  limits: AnalysisLimits,
  rawPages: unknown,
  rawDepth: unknown
) {
  const pages = Number(rawPages);
  const depth = Number(rawDepth);
  return {
    maxPages: Math.max(
      1,
      Math.min(Number.isFinite(pages) && pages > 0 ? Math.round(pages) : limits.defaultMaxPages, limits.hardMaxPages)
    ),
    maxDepth: Math.max(
      0,
      Math.min(Number.isFinite(depth) && depth >= 0 ? Math.round(depth) : limits.defaultMaxDepth, limits.hardMaxDepth)
    ),
  };
}

export type JobActor = { id: string; email: string };

type StartOutcome =
  | { ok: true; analysisId: string }
  | { ok: false; code: string; status: number };

/**
 * Concurrency guard. `excludeAnalysisId` lets the pipeline re-check without
 * counting the job it is currently running (it marks itself `queued` first).
 */
export async function checkConcurrency(
  env: Env,
  companyId: string,
  limits: AnalysisLimits,
  excludeAnalysisId?: string
): Promise<{ ok: true } | { ok: false; code: string; status: number }> {
  const running = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM site_analyses
      WHERE company_id = ? AND status IN ('queued', 'crawling', 'extracting', 'analyzing')
      ${excludeAnalysisId ? 'AND id != ?' : ''}`,
    ...(excludeAnalysisId ? [companyId, excludeAnalysisId] : [companyId])
  );
  if ((running?.n ?? 0) >= limits.maxConcurrent) {
    return { ok: false, code: 'analysis_in_progress', status: 409 };
  }
  return { ok: true };
}

/** Concurrency + hourly quota guard, enforced before any crawl starts. */
export async function checkAnalysisQuota(
  env: Env,
  companyId: string,
  limits: AnalysisLimits
): Promise<{ ok: true } | { ok: false; code: string; status: number }> {
  const running = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM site_analyses
      WHERE company_id = ? AND status IN ('queued', 'crawling', 'extracting', 'analyzing')`,
    companyId
  );
  if ((running?.n ?? 0) >= limits.maxConcurrent) {
    return { ok: false, code: 'analysis_in_progress', status: 409 };
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM site_analyses WHERE company_id = ? AND created_at >= ?`,
    companyId,
    since
  );
  if ((recent?.n ?? 0) >= limits.rateLimitPerHour) {
    return { ok: false, code: 'analysis_rate_limited', status: 429 };
  }

  // Package quota is a real limit: the plan caps new analyses per month.
  const company = await first<{ plan_id: string | null }>(
    env,
    'SELECT plan_id FROM companies WHERE id = ?',
    companyId
  );
  if (company?.plan_id) {
    const plan = await first<{ monthly_analyses: number | null }>(
      env,
      'SELECT monthly_analyses FROM plans WHERE id = ?',
      company.plan_id
    );
    if (plan && plan.monthly_analyses !== null && plan.monthly_analyses !== undefined) {
      const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00.000Z`;
      const used = await first<{ n: number }>(
        env,
        `SELECT COUNT(*) AS n FROM site_analyses WHERE company_id = ? AND created_at >= ?`,
        companyId,
        monthStart
      );
      if ((used?.n ?? 0) >= Number(plan.monthly_analyses)) {
        return { ok: false, code: 'plan_quota_exceeded', status: 429 };
      }
    }
  }
  return { ok: true };
}

async function markFailed(env: Env, analysisId: string, companyId: string, code: string) {
  await run(
    env,
    `UPDATE site_analyses SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    code,
    nowIso(),
    nowIso(),
    analysisId,
    companyId
  );
}

async function recordUsage(
  env: Env,
  entry: {
    companyId: string;
    userId: string | null;
    analysisId: string;
    provider: string;
    model: string;
    operation?: string;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostMicros?: number;
    status: 'ok' | 'error';
    errorMessage?: string | null;
  }
) {
  await run(
    env,
    `INSERT INTO ai_usage_events (id, company_id, user_id, analysis_id, provider, model, operation,
       input_tokens, output_tokens, estimated_cost_micros, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId('aiuse'),
    entry.companyId,
    entry.userId,
    entry.analysisId,
    entry.provider,
    entry.model,
    entry.operation ?? 'site_analysis',
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    entry.estimatedCostMicros ?? 0,
    entry.status,
    entry.errorMessage ?? null,
    nowIso()
  );
  if (entry.status === 'ok') {
    await run(
      env,
      `INSERT INTO usage_events (id, company_id, kind, quantity, provider, model, cost_micros, meta, created_at)
       VALUES (?, ?, 'site_analysis', 1, ?, ?, ?, ?, ?)`,
      newId('use'),
      entry.companyId,
      entry.provider,
      entry.model,
      entry.estimatedCostMicros ?? 0,
      JSON.stringify({ analysisId: entry.analysisId }),
      nowIso()
    );
  }
}

/**
 * Runs the whole pipeline for one analysis row and returns the final status.
 * Errors are stored as stable codes; upstream messages and secrets are never
 * persisted or returned.
 */
export async function runAnalysisPipeline(
  env: Env,
  analysis: any,
  actor: JobActor,
  settings: Record<string, string>
): Promise<{ ok: boolean; code?: string }> {
  const companyId = analysis.company_id;
  const analysisId = analysis.id;
  const started = nowIso();

  const limits = analysisLimits(env, settings);
  const quota = await checkConcurrency(env, companyId, limits, analysisId);
  if (!quota.ok) {
    return { ok: false, code: quota.code };
  }

  await run(
    env,
    `UPDATE site_analyses SET status = 'crawling', started_at = ?, completed_at = NULL,
       error_message = NULL, updated_at = ? WHERE id = ? AND company_id = ?`,
    started,
    started,
    analysisId,
    companyId
  );

  const crawler = resolveCrawlerProvider(env, settings);
  let crawl: CrawlResult;
  try {
    crawl = await crawler.crawl({
      url: analysis.normalized_url || analysis.url,
      maxPages: Math.min(analysis.max_pages || limits.defaultMaxPages, limits.hardMaxPages),
      maxDepth: Math.min(analysis.max_depth ?? limits.defaultMaxDepth, limits.hardMaxDepth),
      locale: analysis.locale,
      userAgent: settings['analysis.crawler_user_agent'],
    });
  } catch (error) {
    const code = error instanceof CrawlerError ? error.code : 'crawl_failed';
    await markFailed(env, analysisId, companyId, code);
    await audit(env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId,
      action: 'site_analysis.failed',
      entityType: 'site_analysis',
      entityId: analysisId,
      meta: { stage: 'crawl', code, crawler: crawler.name },
    });
    return { ok: false, code };
  }

  const goodPages = crawl.pages.filter((page) => page.status === 'ok' && page.contentMarkdown.trim());

  // Persist pages (replacing any previous crawl of the same analysis).
  await run(env, 'DELETE FROM site_pages WHERE analysis_id = ? AND company_id = ?', analysisId, companyId);
  const timestamp = nowIso();
  for (const page of crawl.pages) {
    await run(
      env,
      `INSERT INTO site_pages (id, analysis_id, company_id, url, title, status_code, content_markdown,
         content_hash, word_count, depth, crawl_status, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('page'),
      analysisId,
      companyId,
      page.url,
      page.title || null,
      page.statusCode ?? null,
      page.contentMarkdown || null,
      page.contentMarkdown ? await sha256Hex(page.contentMarkdown) : null,
      page.wordCount,
      page.depth,
      page.status,
      page.errorMessage ?? null,
      timestamp
    );
  }

  await run(
    env,
    `UPDATE site_analyses SET status = 'extracting', robots_policy = ?, pages_found = ?,
       pages_analyzed = ?, pages_failed = ?, crawler_provider = ?, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    crawl.robotsPolicy,
    crawl.pagesFound,
    crawl.pagesAnalyzed,
    crawl.pagesFailed,
    crawler.name,
    timestamp,
    analysisId,
    companyId
  );

  if (!goodPages.length) {
    await markFailed(env, analysisId, companyId, 'crawl_no_content');
    return { ok: false, code: 'crawl_no_content' };
  }

  let provider;
  try {
    provider = resolveAiProvider(env, settings);
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'ai_provider_not_configured';
    await markFailed(env, analysisId, companyId, code);
    await audit(env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId,
      action: 'site_analysis.failed',
      entityType: 'site_analysis',
      entityId: analysisId,
      meta: { stage: 'provider', code },
    });
    return { ok: false, code };
  }

  await run(
    env,
    `UPDATE site_analyses SET status = 'analyzing', provider = ?, model = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    provider.name,
    provider.model,
    nowIso(),
    analysisId,
    companyId
  );

  let analysed;
  try {
    analysed = await provider.analyzeSite({
      companyId,
      analysisId,
      locale: analysis.locale,
      url: analysis.normalized_url || analysis.url,
      pages: goodPages.map((page) => ({
        url: page.url,
        title: page.title,
        contentMarkdown: page.contentMarkdown,
        wordCount: page.wordCount,
      })),
    });
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : 'ai_provider_failed';
    await recordUsage(env, {
      companyId,
      userId: actor.id,
      analysisId,
      provider: provider.name,
      model: provider.model,
      status: 'error',
      errorMessage: code,
    });
    await markFailed(env, analysisId, companyId, code);
    await audit(env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId,
      action: 'site_analysis.failed',
      entityType: 'site_analysis',
      entityId: analysisId,
      meta: { stage: 'analyze', code, provider: provider.name },
    });
    return { ok: false, code };
  }

  const result = normalizeResult(analysed.result);
  const confidence = overallConfidence(result);
  const summary = sourceSummary(result);
  const version = (Number(analysis.latest_version) || 0) + 1;
  const completed = nowIso();

  await run(
    env,
    `INSERT INTO analysis_results (id, analysis_id, company_id, version, result_json, source_summary,
       confidence, created_by_ai, edited_by_user, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
    newId('res'),
    analysisId,
    companyId,
    version,
    JSON.stringify(result),
    JSON.stringify(summary),
    confidence,
    completed,
    completed
  );

  await run(
    env,
    `UPDATE site_analyses SET status = 'awaiting_review', latest_version = ?, provider = ?,
       model = ?, completed_at = ?, error_message = NULL, updated_at = ?
     WHERE id = ? AND company_id = ?`,
    version,
    provider.name,
    provider.model,
    completed,
    completed,
    analysisId,
    companyId
  );

  await recordUsage(env, {
    companyId,
    userId: actor.id,
    analysisId,
    provider: provider.name,
    model: provider.model,
    inputTokens: analysed.usage.inputTokens,
    outputTokens: analysed.usage.outputTokens,
    estimatedCostMicros: analysed.usage.estimatedCostMicros,
    status: 'ok',
  });

  await audit(env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId,
    action: 'site_analysis.completed',
    entityType: 'site_analysis',
    entityId: analysisId,
    meta: {
      version,
      provider: provider.name,
      model: provider.model,
      pagesAnalyzed: crawl.pagesAnalyzed,
      confidence,
      sources: summary,
    },
  });

  if (provider.name === 'mock') {
    await audit(env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId,
      action: 'site_analysis.mock_provider_used',
      entityType: 'site_analysis',
      entityId: analysisId,
      meta: { provider: provider.name },
    });
  }

  return { ok: true };
}

/** Start (or retry) an analysis and return the outcome it settled on. */
export async function startAnalysisJob(
  env: Env,
  analysis: any,
  actor: JobActor,
  settings: Record<string, string>
): Promise<StartOutcome> {
  if (analysis.status === 'approved') return { ok: false, code: 'analysis_approved', status: 409 };
  if (['crawling', 'extracting', 'analyzing', 'queued'].includes(analysis.status)) {
    return { ok: false, code: 'analysis_in_progress', status: 409 };
  }

  const limits = analysisLimits(env, settings);
  const quota = await checkAnalysisQuota(env, analysis.company_id, limits);
  if (!quota.ok) return { ok: false, code: quota.code, status: quota.status };

  await run(
    env,
    `UPDATE site_analyses SET status = 'queued', updated_at = ? WHERE id = ? AND company_id = ?`,
    nowIso(),
    analysis.id,
    analysis.company_id
  );
  await audit(env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: analysis.company_id,
    action: 'site_analysis.started',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { url: analysis.normalized_url, maxPages: analysis.max_pages, maxDepth: analysis.max_depth },
  });

  const outcome = await runAnalysisPipeline(env, analysis, actor, settings);
  if (!outcome.ok) return { ok: false, code: outcome.code ?? 'analysis_failed', status: 422 };
  return { ok: true, analysisId: analysis.id };
}

export { aiProviderStatus };
export type { Env };
