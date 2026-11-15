/** Crawler contract and URL safety helpers (SSRF guard). */

export type CrawlPageStatus = 'ok' | 'blocked' | 'not_found' | 'error' | 'skipped';

export type CrawledPage = {
  url: string;
  title: string;
  contentMarkdown: string;
  wordCount: number;
  statusCode: number | null;
  status: CrawlPageStatus;
  depth: number;
  errorMessage?: string | null;
};

export type CrawlResult = {
  startUrl: string;
  robotsPolicy: 'allowed' | 'disallowed' | 'missing' | 'error';
  pages: CrawledPage[];
  pagesFound: number;
  pagesAnalyzed: number;
  pagesFailed: number;
};

export type CrawlInput = {
  url: string;
  maxPages: number;
  maxDepth: number;
  locale?: 'ar' | 'en' | 'ar-en';
  userAgent?: string;
};

export interface SiteCrawlerProvider {
  readonly name: string;
  crawl(input: CrawlInput): Promise<CrawlResult>;
}

export class CrawlerError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Blocks loopback, private ranges, link-local and non-http(s) URLs. */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /\.internal$/i,
  /\.localhost$/i,
];

export const isIpLiteral = (host: string) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');

/** Normalizes user input into a canonical http(s) URL or throws. */
export function normalizeSiteUrl(input: string): URL {
  const raw = String(input ?? '').trim();
  if (!raw) throw new CrawlerError('invalid_url');
  if (raw.length > 500) throw new CrawlerError('invalid_url');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CrawlerError('invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CrawlerError('invalid_url');
  if (!url.hostname.includes('.')) throw new CrawlerError('invalid_url');
  if (url.username || url.password) throw new CrawlerError('invalid_url');
  if (url.port && url.port !== '80' && url.port !== '443') throw new CrawlerError('invalid_url');

  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) throw new CrawlerError('url_not_allowed');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) throw new CrawlerError('url_not_allowed');

  url.hash = '';
  url.protocol = url.protocol === 'http:' ? 'http:' : 'https:';
  if (!url.pathname) url.pathname = '/';
  return url;
}

export const sameOrigin = (a: URL, b: URL) => a.protocol === b.protocol && a.host === b.host;

const SKIP_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|rar|7z|mp4|mp3|docx?|xlsx?|pptx?|css|js|xml|ico)$/i;

export const looksCrawlable = (url: URL) =>
  !SKIP_EXTENSIONS.test(url.pathname) &&
  !/\/(wp-admin|wp-login|login|signin|admin|cart|checkout|account)(\/|$)/i.test(url.pathname);
