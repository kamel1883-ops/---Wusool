/**
 * Performance dashboard.
 *
 * Every number carries where it came from. A metric with no recorded source is
 * returned as `available: false` with a reason, never as zero: a zero would be
 * read as "we measured nothing happened", which is a different claim.
 */
import { Hono } from 'hono';
import { companyContext, requireAuth, type AppEnv } from '../lib/auth';
import { all, computeSubscription, first, getSettings, nowIso } from '../lib/db';
import { can } from '../lib/rbac';
import { apiError } from './public';
import { totalsFor } from '../lib/tracking';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

type Metric = {
  value: number | null;
  available: boolean;
  source: string;
  note?: string;
};

const measured = (value: number | null | undefined, source: string, note?: string): Metric => ({
  value: value === null || value === undefined || Number.isNaN(Number(value)) ? null : Number(value),
  available: value !== null && value !== undefined && !Number.isNaN(Number(value)),
  source,
  ...(note ? { note } : {}),
});

const unavailable = (source: string, note: string): Metric => ({
  value: null,
  available: false,
  source,
  note,
});

app.get('/:companyId/dashboard', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'reports.view') && !can(c.get('role'), 'social.manage')) {
    return apiError(c, 403, 'forbidden');
  }
  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );

  const [connectionRows, postRow, jobsRow, leadRow, stageRows, metricsRow, tracking, linkRows] =
    await Promise.all([
      all<any>(c.env, 'SELECT platform, token_status, expires_at FROM social_connections WHERE company_id = ?', company.id),
      first<any>(
        c.env,
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
           SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting,
           SUM(CASE WHEN status = 'changes_requested' THEN 1 ELSE 0 END) AS changes_requested,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
           SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
           SUM(CASE WHEN status = 'partially_published' THEN 1 ELSE 0 END) AS partially_published,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM social_posts WHERE company_id = ?`,
        company.id
      ),
      first<any>(
        c.env,
        `SELECT SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM social_jobs WHERE company_id = ?`,
        company.id
      ),
      first<any>(
        c.env,
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN stage = 'qualified' THEN 1 ELSE 0 END) AS qualified,
           SUM(CASE WHEN stage = 'contacted' THEN 1 ELSE 0 END) AS contacted,
           SUM(CASE WHEN stage = 'replied' THEN 1 ELSE 0 END) AS replied,
           SUM(CASE WHEN stage = 'meeting' THEN 1 ELSE 0 END) AS meeting,
           SUM(CASE WHEN stage = 'proposal' THEN 1 ELSE 0 END) AS proposal,
           SUM(CASE WHEN stage = 'won' THEN 1 ELSE 0 END) AS won,
           SUM(CASE WHEN stage = 'lost' THEN 1 ELSE 0 END) AS lost,
           SUM(CASE WHEN tracking_link_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed
         FROM leads WHERE company_id = ?`,
        company.id
      ),
      all<any>(
        c.env,
        'SELECT stage, COUNT(*) AS total FROM leads WHERE company_id = ? GROUP BY stage',
        company.id
      ),
      first<any>(
        c.env,
        `SELECT SUM(revenue_sar) AS revenue, SUM(spend_sar) AS spend, SUM(leads_count) AS leads,
                SUM(meetings) AS meetings, SUM(won) AS won, COUNT(*) AS rows_count
           FROM campaign_metrics WHERE company_id = ?`,
        company.id
      ),
      totalsFor(c.env, company.id),
      all<any>(
        c.env,
        `SELECT platform, COUNT(*) AS clicks FROM tracking_events
          WHERE company_id = ? AND kind = 'click' AND platform IS NOT NULL
          GROUP BY platform ORDER BY clicks DESC`,
        company.id
      ),
    ]);

  const revenue = Number(metricsRow?.revenue ?? 0);
  const spend = Number(metricsRow?.spend ?? 0);
  const hasMetrics = Number(metricsRow?.rows_count ?? 0) > 0;
  const leadsTotal = Number(leadRow?.total ?? 0);

  const cpl = hasMetrics && spend > 0 && leadsTotal > 0 ? spend / leadsTotal : null;
  const roi = hasMetrics && spend > 0 ? (revenue - spend) / spend : null;

  const platformClicks = linkRows.map((row) => ({
    platform: row.platform,
    clicks: Number(row.clicks ?? 0),
  }));

  return c.json({
    generatedAt: nowIso(),
    subscription: {
      status: subscription.effectiveStatus,
      isActive: subscription.isActive,
      daysLeft: subscription.daysLeft,
    },
    accounts: {
      connected: connectionRows.length,
      needsReconnect: connectionRows.filter(
        (row) =>
          row.token_status === 'requires_reconnect' ||
          (row.expires_at && Date.parse(row.expires_at) <= Date.now())
      ).length,
      byPlatform: connectionRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.platform] = (acc[row.platform] ?? 0) + 1;
        return acc;
      }, {}),
    },
    posts: {
      total: measured(Number(postRow?.total ?? 0), 'social_posts'),
      drafts: measured(Number(postRow?.drafts ?? 0), 'social_posts'),
      awaitingApproval: measured(Number(postRow?.awaiting ?? 0), 'social_posts'),
      changesRequested: measured(Number(postRow?.changes_requested ?? 0), 'social_posts'),
      approved: measured(Number(postRow?.approved ?? 0), 'social_posts'),
      scheduled: measured(Number(postRow?.scheduled ?? 0), 'social_posts'),
      published: measured(Number(postRow?.published ?? 0), 'social_posts'),
      partiallyPublished: measured(Number(postRow?.partially_published ?? 0), 'social_posts'),
      failed: measured(Number(postRow?.failed ?? 0), 'social_posts'),
    },
    scheduling: {
      pending: measured(Number(jobsRow?.pending ?? 0), 'social_jobs'),
      failed: measured(Number(jobsRow?.failed ?? 0), 'social_jobs'),
      automatic: Boolean((c.env as any).JOBS_SECRET) ? 'external_runner_required' : 'blocked_by_hosting',
    },
    reach: {
      impressions: unavailable('platform_insights_api', 'Impressions are read from each platform’s insight API, which this build does not call.'),
      reach: unavailable('platform_insights_api', 'Reach is read from each platform’s insight API, which this build does not call.'),
      engagement: unavailable('platform_insights_api', 'Engagement is read from each platform’s insight API, which this build does not call.'),
    },
    tracking: {
      clicks: measured(tracking.clicks, 'tracking_events:click'),
      pageViews: measured(tracking.pageViews, 'tracking_events:page_view'),
      uniqueVisitors: measured(tracking.uniqueVisitors, 'tracking_events:visitor_hash'),
      whatsappClicks: measured(tracking.whatsappClicks, 'tracking_events:whatsapp_click'),
      callClicks: measured(tracking.callClicks, 'tracking_events:call_click'),
      formSubmits: measured(tracking.formSubmits, 'tracking_events:form_submit'),
      byPlatform: platformClicks,
      window: 'last_30_days',
    },
    leads: {
      total: measured(leadsTotal, 'leads'),
      attributed: measured(Number(leadRow?.attributed ?? 0), 'leads:tracking_link_id'),
      byStage: stageRows.map((row) => ({ stage: row.stage, total: Number(row.total ?? 0) })),
      meetings: measured(Number(leadRow?.meeting ?? 0), 'leads:stage'),
      won: measured(Number(leadRow?.won ?? 0), 'leads:stage'),
      replies: measured(Number(leadRow?.replied ?? 0), 'leads:stage'),
    },
    revenue: {
      booked: measured(hasMetrics ? revenue : null, 'campaign_metrics:revenue_sar'),
      spend: measured(hasMetrics ? spend : null, 'campaign_metrics:spend_sar'),
      cpl: cpl === null ? unavailable('campaign_metrics', 'CPL needs recorded spend and at least one lead.') : measured(cpl, 'campaign_metrics:spend/leads'),
      roi: roi === null ? unavailable('campaign_metrics', 'ROI needs recorded spend; revenue may be zero.') : measured(roi, '(revenue-spend)/spend'),
    },
    highlights: {
      bestPost: unavailable('platform_insights_api', 'Comparing posts needs engagement from the platform APIs, which is not implemented.'),
      bestCampaign: linkRows.length
        ? (() => {
            const best = platformClicks[0];
            return {
              value: best.platform,
              available: true,
              source: 'tracking_events:click',
              note: `${best.clicks} tracked clicks`,
            };
          })()
        : unavailable('tracking_events', 'No tracked clicks yet, so no campaign can be ranked.'),
      bestPlatform: platformClicks.length
        ? { value: platformClicks[0].platform, available: true, source: 'tracking_events:click', note: `${platformClicks[0].clicks} clicks` }
        : unavailable('tracking_events', 'No platform-attributed clicks yet.'),
      bestAudience: unavailable('platform_insights_api', 'Audience breakdowns are not returned by an API this build calls.'),
    },
    demographics: {
      state: 'unavailable',
      note: 'Age, gender, country and language are only shown when a platform returns them as aggregated data. None of the implemented APIs do, so this stays unavailable.',
    },
  });
});

export default app;
