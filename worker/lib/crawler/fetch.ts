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

/**
 * Visual inventory of a page: every <img> with its alt text, file name and
 * declared dimensions, plus the meta description. Appended to the extracted
 * text so the analysis can reason about the site's images (brand assets,
 * product shots, missing alt text) instead of seeing text only.
 */
export type PageImage = { src: string; alt: string; width: number | null; height: number | null };

export function extractImages(html: string, base: URL): PageImage[] {
  const images: PageImage[] = [];
  const seen = new Set<string>();
  const regex = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const tag = match[0];
    const srcRaw =
      /\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag)?.slice(1).find(Boolean) ?? '';
    const src = srcRaw.trim();
    if (!src || src.startsWith('data:')) continue;
    let absolute: string;
    try {
      absolute = new URL(src, base).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const attr = (name: string) => {
      const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
      return decodeEntities(found?.[1] ?? found?.[2] ?? '').trim();
    };
    const dimension = (name: string) => {
      const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
      const value = Number(found?.[1] ?? found?.[2]);
      return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    };
    images.push({
      src: absolute,
      alt: attr('alt'),
      width: dimension('width'),
      height: dimension('height'),
    });
    if (images.length >= 20) break;
  }
  return images;
}

export function metaDescription(html: string): string {
  const found =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(html);
  return found ? decodeEntities(found[1]).trim().slice(0, 400) : '';
}

/**
 * Appends the visual inventory to the extracted text in a stable format the
 * analysis prompt and the local provider both understand.
 */
export function withVisualInventory(text: string, html: string, base: URL): string {
  const parts: string[] = [];
  const description = metaDescription(html);
  if (description) parts.push(`Meta description: ${description}`);
  const images = extractImages(html, base);
  if (images.length) {
    parts.push('Images:');
    for (const image of images) {
      let fileName = '';
      try {
        fileName = new URL(image.src).pathname.split('/').pop() ?? '';
      } catch {
        fileName = '';
      }
      const size = image.width && image.height ? ` | ${image.width}x${image.height}` : '';
      parts.push(`- ${image.alt ? `alt="${image.alt}" | ` : ''}${fileName || image.src}${size}`);
    }
  }
  return parts.length ? `${text}\n\n${parts.join('\n')}` : text;
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
      const text = withVisualInventory(htmlToText(html), html, current.url);
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
