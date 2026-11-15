import { Hono } from 'hono';
import type { AppEnv } from './lib/auth';
import publicRoutes from './routes/public';
import companyRoutes from './routes/company';
import adminRoutes from './routes/admin';

const app = new Hono<AppEnv>();

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (MUTATING.has(c.req.method)) {
    // Defence in depth on top of the SameSite=Lax session cookie: every
    // mutation must come from our own client and from the same origin.
    if (c.req.header('x-wusool-client') !== 'web') {
      return c.json({ error: { code: 'csrf_rejected' } }, 403);
    }
    const origin = c.req.header('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== new URL(c.req.url).host) {
          return c.json({ error: { code: 'csrf_rejected' } }, 403);
        }
      } catch {
        return c.json({ error: { code: 'csrf_rejected' } }, 403);
      }
    }
  }

  await next();
});

app.route('/api', publicRoutes);
app.route('/api/company', companyRoutes);
app.route('/api/admin', adminRoutes);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'not_found' } }, 404);
  }
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  return asset;
});

app.onError((error, c) => {
  console.error('unhandled_error', { path: c.req.path, message: error?.message });
  return c.json({ error: { code: 'internal_error' } }, 500);
});

export default app;
