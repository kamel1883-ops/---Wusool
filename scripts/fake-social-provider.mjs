/**
 * Local stand-in for Meta Graph and Google APIs, used only to exercise the
 * publishing path in a development preview. It never runs in production and is
 * not imported by the Worker: the Worker's base URLs are overridden with
 * --var for this local run.
 *
 *   node scripts/fake-social-provider.mjs 8790
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8790);
const feedCalls = [];

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  let body = '';
  for await (const chunk of request) body += chunk;
  const json = (payload, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };

  if (url.pathname.endsWith('/oauth/access_token')) {
    const long = url.searchParams.get('grant_type') === 'fb_exchange_token';
    return json({
      access_token: long ? 'LOCAL_LONG_USER_TOKEN' : 'LOCAL_USER_TOKEN',
      expires_in: 5_184_000,
      scope: 'pages_show_list,pages_manage_posts,pages_read_engagement',
    });
  }
  if (url.pathname.endsWith('/me/accounts')) {
    return json({
      data: [
        {
          id: 'LOCALPAGE1',
          name: 'متجر النخبة',
          access_token: 'LOCAL_PAGE_TOKEN',
          tasks: ['CREATE_CONTENT'],
          instagram_business_account: { id: 'LOCALIG1', username: 'elite_store' },
        },
      ],
    });
  }
  if (/\/LOCALPAGE1\/feed$/.test(url.pathname) && request.method === 'POST') {
    const params = new URLSearchParams(body);
    feedCalls.push({ message: params.get('message') });
    console.log(`· page post #${feedCalls.length}: ${params.get('message')?.slice(0, 40)}…`);
    return json({ id: `LOCALPAGE1_${900 + feedCalls.length}` });
  }
  if (/\/LOCALIG1\/media$/.test(url.pathname)) return json({ id: 'LOCALCONTAINER1' });
  if (/\/LOCALIG1\/media_publish$/.test(url.pathname)) return json({ id: 'LOCALIGMEDIA1' });
  if (/\/LOCALIGMEDIA1$/.test(url.pathname)) return json({ permalink: 'https://www.instagram.com/p/local/' });

  if (url.pathname === '/token') {
    return json({
      access_token: 'LOCAL_GOOGLE_TOKEN',
      refresh_token: 'LOCAL_GOOGLE_REFRESH',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
    });
  }
  if (url.pathname.endsWith('/v1beta/accountSummaries')) {
    return json({
      accountSummaries: [
        {
          account: 'accounts/1',
          displayName: 'متجر النخبة',
          propertySummaries: [{ property: 'properties/42', displayName: 'الموقع الرئيسي' }],
        },
      ],
    });
  }
  if (url.pathname.endsWith('/webmasters/v3/sites')) return json({ siteEntry: [] });
  if (url.pathname.endsWith('/tagmanager/v2/accounts')) return json({ account: [] });
  if (url.pathname.endsWith('/v1/accounts')) return json({ accounts: [] });

  return json({ error: { message: `unexpected ${request.method} ${url.pathname}` } }, 404);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`fake social provider on ${port}`);
});
