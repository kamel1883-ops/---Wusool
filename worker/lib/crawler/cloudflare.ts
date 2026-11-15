/**
 * Cloudflare Browser Rendering crawl provider (structure ready, off by default).
 *
 * It stays inactive until the deployment provides an account id and token, and
 * until a Super Admin switches the crawler provider to `cloudflare`. The token
 * is read from the Worker secret store only — never from D1 or the browser.
 */
import type { Env } from '../db';
import {
  type CrawlInput,
  type CrawlResult,
  type SiteCrawlerProvider,
  CrawlerError,
  normalizeSiteUrl,
} from './types';

type CloudflareCrawlRecord = {
  url?: string;
  markdown?: string;
  html?: string;
  status?: string;
  metadata?: { title?: string; statusCode?: number };
};

export class CloudflareCrawlerProvider implements SiteCrawlerProvider {
  readonly name = 'cloudflare';

  constructor(private env: Env) {}

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const accountId = String(this.env.CRAWLER_ACCOUNT_ID ?? '').trim();
    const apiToken = String(this.env.CRAWLER_API_TOKEN ?? '').trim();
    if (!accountId || !apiToken) throw new CrawlerError('crawler_not_configured');

    const start = normalizeSiteUrl(input.url);
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/crawl`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          url: start.toString(),
          limit: Math.max(1, Math.min(input.maxPages || 10, 40)),
          depth: Math.max(0, Math.min(input.maxDepth ?? 1, 4)),
          formats: ['markdown'],
          render: false,
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new CrawlerError('crawler_unreachable');
    }

    if (!response.ok) throw new CrawlerError('crawler_failed');

    const payload: any = await response.json().catch(() => null);
    const records: CloudflareCrawlRecord[] = Array.isArray(payload?.result?.records)
      ? payload.result.records
      : Array.isArray(payload?.records)
        ? payload.records
        : [];
    if (!records.length) throw new CrawlerError('crawl_no_content');

    const pages = records.map((record, index) => {
      const url = record.url || start.toString();
      const content = String(record.markdown ?? '');
      const ok = !record.status || record.status === 'completed' || record.status === 'ok';
      return {
        url,
        title: String(record.metadata?.title ?? '').slice(0, 200),
        contentMarkdown: content,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        statusCode: record.metadata?.statusCode ?? (ok ? 200 : null),
        status: ok ? ('ok' as const) : ('error' as const),
        depth: index === 0 ? 0 : 1,
        errorMessage: ok ? null : 'crawl_failed',
      };
    });

    const analyzed = pages.filter((page) => page.status === 'ok' && page.wordCount > 0);
    if (!analyzed.length) throw new CrawlerError('crawl_no_content');

    return {
      startUrl: start.toString(),
      robotsPolicy: 'allowed',
      pages,
      pagesFound: pages.length,
      pagesAnalyzed: analyzed.length,
      pagesFailed: pages.length - analyzed.length,
    };
  }
}
