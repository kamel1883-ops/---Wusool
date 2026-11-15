/**
 * Dependency-free same-origin crawler that runs inside the Worker.
 *
 * Safeguards: robots.txt is fetched and honoured, only the submitted origin is
 * visited (never an external domain), private/loopback hosts are rejected,
 * pages are limited by count and depth, responses are size-capped and every
 * request has a timeout. Login walls, CAPTCHAs and paywalls are never bypassed:
 * a non-200 response is recorded as skipped/failed, not retried aggressively.
 */
import {
  type CrawlInput,
  type CrawlResult,
  type CrawledPage,
  type SiteCrawlerProvider,
  CrawlerError,
  normalizeSiteUrl,
  sameOrigin,
  looksCrawlable,
  isIpLiteral,
} from './types';
import { isPathAllowed, parseRobots, type RobotsRules } from './robots';

const DEFAULT_UA = 'WusoolBot/1.0 (+site analysis for a subscribed customer)';
const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 12_000;

const decodeEntities = (value: string) =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)));

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|tr|h1|h2|h3|h4|h5|h6|ul|ol|table|header|footer|main|nav)>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<h1[^>]*>/gi, '\n# ')
      .replace(/<h2[^>]*>/gi, '\n## ')
      .replace(/<h3[^>]*>/gi, '\n### ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pageTitle(html: string, fallbackUrl: string): string {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim().slice(0, 200);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) return decodeEntities(title[1]).trim().replace(/\s+/g, ' ').slice(0, 200);
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return fallbackUrl.slice(0, 200);
  }
}

export function extractLinks(html: string, base: URL): URL[] {
  const links: URL[] = [];
  const seen = new Set<string>();
  const regex = /<a\b[^>]*href=["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const raw = match[1].trim();
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      continue;
    }
    if (!sameOrigin(url, base)) continue;
    if (isIpLiteral(url.hostname)) continue;
    url.hash = '';
    if (!looksCrawlable(url)) continue;
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(url);
  }
  return links;
}

async function fetchText(url: string, userAgent: string): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      'accept-language': 'ar,en;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

export class FetchCrawlerProvider implements SiteCrawlerProvider {
  readonly name = 'fetch';

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const start = normalizeSiteUrl(input.url);
    const userAgent = input.userAgent?.trim() || DEFAULT_UA;
    const maxPages = Math.max(1, Math.min(input.maxPages || 10, 40));
    const maxDepth = Math.max(0, Math.min(input.maxDepth ?? 1, 4));

    let robots: RobotsRules = { policy: 'missing', rules: [] };
    try {
      const response = await fetchText(`${start.origin}/robots.txt`, userAgent);
      if (response.ok) {
        const body = (await response.text()).slice(0, 100_000);
        robots = parseRobots(body, userAgent);
        robots.policy = 'allowed';
      } else {
        robots = { policy: 'missing', rules: [] };
      }
    } catch {
      robots = { policy: 'error', rules: [] };
    }

    if (!isPathAllowed(robots, start.pathname)) {
      return {
        startUrl: start.toString(),
        robotsPolicy: 'disallowed',
        pages: [
          {
            url: start.toString(),
            title: '',
            contentMarkdown: '',
            wordCount: 0,
            statusCode: null,
            status: 'blocked',
            depth: 0,
            errorMessage: 'robots_disallowed',
          },
        ],
        pagesFound: 1,
        pagesAnalyzed: 0,
        pagesFailed: 1,
      };
    }

    const pages: CrawledPage[] = [];
    const visited = new Set<string>([start.toString()]);
    const queue: Array<{ url: URL; depth: number }> = [{ url: start, depth: 0 }];

    while (queue.length && pages.filter((page) => page.status === 'ok').length < maxPages) {
      const current = queue.shift()!;
      if (current.depth > maxDepth) continue;

      let response: Response;
      try {
        response = await fetchText(current.url.toString(), userAgent);
      } catch {
        pages.push({
          url: current.url.toString(),
          title: '',
          contentMarkdown: '',
          wordCount: 0,
          statusCode: null,
          status: 'error',
          depth: current.depth,
          errorMessage: 'fetch_failed',
        });
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        pages.push({
          url: current.url.toString(),
          title: '',
          contentMarkdown: '',
          wordCount: 0,
          statusCode: response.status,
          status: 'not_found',
          depth: current.depth,
          errorMessage: 'not_found',
        });
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        pages.push({
          url: current.url.toString(),
          title: '',
          contentMarkdown: '',
          wordCount: 0,
          statusCode: response.status,
          status: 'blocked',
          depth: current.depth,
          errorMessage: 'protected_page',
        });
        continue;
      }
      if (!response.ok) {
        pages.push({
          url: current.url.toString(),
          title: '',
          contentMarkdown: '',
          wordCount: 0,
          statusCode: response.status,
          status: 'error',
          depth: current.depth,
          errorMessage: `status_${response.status}`,
        });
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
        pages.push({
          url: current.url.toString(),
          title: '',
          contentMarkdown: '',
          wordCount: 0,
          statusCode: response.status,
          status: 'skipped',
          depth: current.depth,
          errorMessage: 'not_html',
        });
        continue;
      }

      const raw = await response.text();
      const html = raw.slice(0, MAX_HTML_BYTES);
      const text = htmlToText(html);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      pages.push({
        url: current.url.toString(),
        title: pageTitle(html, current.url.toString()),
        contentMarkdown: text,
        wordCount,
        statusCode: response.status,
        status: 'ok',
        depth: current.depth,
      });

      if (current.depth >= maxDepth) continue;
      for (const link of extractLinks(html, start)) {
        const key = link.toString();
        if (visited.has(key)) continue;
        if (!isPathAllowed(robots, link.pathname)) continue;
        visited.add(key);
        queue.push({ url: link, depth: current.depth + 1 });
      }
    }

    const analyzed = pages.filter((page) => page.status === 'ok' && page.wordCount > 0);
    if (!analyzed.length) throw new CrawlerError('crawl_no_content');

    return {
      startUrl: start.toString(),
      robotsPolicy: robots.policy,
      pages,
      pagesFound: pages.length,
      pagesAnalyzed: analyzed.length,
      pagesFailed: pages.length - analyzed.length,
    };
  }
}
