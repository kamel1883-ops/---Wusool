/** Crawler resolution — chosen server-side from env or platform settings. */
import type { Env } from '../db';
import { CloudflareCrawlerProvider } from './cloudflare';
import { FetchCrawlerProvider } from './fetch';
import { MockCrawlerProvider } from './mock';
import type { SiteCrawlerProvider } from './types';

export * from './types';

export function resolveCrawlerProvider(
  env: Env,
  settings: Record<string, string>
): SiteCrawlerProvider {
  const provider = String(env.CRAWLER_PROVIDER ?? settings['analysis.crawler_provider'] ?? 'mock')
    .toLowerCase()
    .trim();
  if (provider === 'cloudflare') return new CloudflareCrawlerProvider(env);
  if (provider === 'fetch') return new FetchCrawlerProvider();
  return new MockCrawlerProvider();
}
