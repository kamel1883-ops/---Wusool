/**
 * Connection tests for Super Admin (no customer data involved).
 * Every outcome is a stable code; secrets are never echoed.
 */
import type { Env } from '../db';

export type CrawlerTestOutcome =
  | { ok: true; detail: string }
  | { ok: false; code: string };

export async function testCrawlerConnection(
  env: Env,
  settings: Record<string, string>
): Promise<CrawlerTestOutcome> {
  const provider = String(env.CRAWLER_PROVIDER ?? settings['analysis.crawler_provider'] ?? 'mock')
    .toLowerCase()
    .trim();

  if (provider === 'mock') return { ok: true, detail: 'mock_no_credentials_needed' };

  if (provider === 'fetch') {
    return { ok: true, detail: 'fetch_no_credentials_needed' };
  }

  if (provider === 'cloudflare') {
    const accountId = String(env.CRAWLER_ACCOUNT_ID ?? '').trim();
    const apiToken = String(env.CRAWLER_API_TOKEN ?? '').trim();
    if (!accountId || !apiToken) return { ok: false, code: 'crawler_not_configured' };
    let response: Response;
    try {
      response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        method: 'GET',
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { ok: false, code: 'crawler_unreachable' };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: response.status === 401 || response.status === 403 ? 'crawler_unauthorized' : 'crawler_failed',
      };
    }
    return { ok: true, detail: 'cloudflare_token_verified' };
  }

  return { ok: false, code: 'crawler_unsupported' };
}
