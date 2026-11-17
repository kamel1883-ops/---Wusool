import { Hono } from 'hono';
import type { AppEnv } from './lib/auth';
import publicRoutes from './routes/public';
import companyRoutes from './routes/company';
import analysisRoutes from './routes/analysis';
import growthRoutes from './routes/growth';
import socialRoutes, { socialCallbackRoutes } from './routes/social';
import dashboardRoutes from './routes/dashboard';
import posterRoutes, { posterPublicRoutes } from './routes/posters';
import trackingRoutes, { beaconRoutes, redirectRoutes } from './routes/tracking';
import ownerResetRoutes from './routes/owner-reset';
import { runDueJobs } from './lib/social/publish';
import adminRoutes from './routes/admin';
import purchaseAdminRoutes from './routes/purchase-admin';

const app = new Hono<AppEnv>();

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Public measurement endpoint. It is called by a landing-page beacon, not by
 * the signed-in client, so it cannot carry our CSRF header. It has no session
 * to hijack: the only input is a link code, and the handler caps events per
 * visitor and refuses fictional kinds.
 */
const CSRF_EXEMPT = new Set(['/api/tracking/events']);

/**
 * Scheduler entry point for due publishing jobs.
 *
 * Registered before the browser-oriented middleware because a scheduler is not
 * a browser: it authenticates with a shared secret. When JOBS_SECRET is unset
 * this deployment has no scheduler, and the endpoint says so (503) instead of
 * pretending jobs run in the background.
 */
app.post('/api/internal/social/tick', async (c) => {
  const secret = String(c.env.JOBS_SECRET ?? '');
  if (!secret) {
    return c.json({ error: { code: 'scheduler_not_configured' } }, 503);
  }
  if (c.req.header('x-wusool-jobs-secret') !== secret) {
    return c.json({ error: { code: 'unauthorized' } }, 401);
  }
  const limit = Math.max(1, Math.min(20, Number(c.req.query('limit') ?? 10) || 10));
  const results = await runDueJobs(c.env, { limit });
  return c.json({
    ran: results.length,
    published: results.filter((item) => item.outcome.status === 'published').length,
    failed: results.filter((item) => item.outcome.status === 'failed').length,
  });
});

app.use('/api/*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (MUTATING.has(c.req.method) && !CSRF_EXEMPT.has(c.req.path)) {
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

app.route('/', redirectRoutes);
app.route('/', ownerResetRoutes);
app.route('/api', beaconRoutes);
app.route('/api', posterPublicRoutes);
app.route('/api', publicRoutes);
app.route('/api/company', companyRoutes);
app.route('/api/company', analysisRoutes);
app.route('/api/company', growthRoutes);
app.route('/api/company', socialRoutes);
// Shared OAuth landing page: one redirect URI registered once per provider.
app.route('/api', socialCallbackRoutes);
app.route('/api/company', trackingRoutes);
app.route('/api/company', dashboardRoutes);
app.route('/api/company', posterRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/admin', purchaseAdminRoutes);

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
