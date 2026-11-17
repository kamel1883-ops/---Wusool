/**
 * Poster drafts: create, edit while a draft, approve, and serve.
 *
 * A poster has no public URL until a client approves it, so an unapproved
 * design can never be attached to a post that references it.
 */
import { Hono } from 'hono';
import { companyContext, requireAuth, type AppEnv } from '../lib/auth';
import {
  all,
  audit,
  computeSubscription,
  first,
  getSettings,
  newId,
  nowIso,
  readJson,
  run,
  str,
} from '../lib/db';
import { can } from '../lib/rbac';
import { apiError } from './public';
import {
  isPosterSize,
  isPosterTemplate,
  POSTER_SIZES,
  renderPosterSvg,
  posterSizes,
  type PosterTemplate,
} from '../lib/posters';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

const HEX = /^#[0-9a-fA-F]{6}$/;

const serialize = (row: any, origin: string) => ({
  id: row.id,
  title: row.title,
  headline: row.headline,
  subhead: row.subhead,
  cta: row.cta,
  template: row.template,
  sizeKey: row.size_key,
  width: row.width,
  height: row.height,
  brandColor: row.brand_color,
  language: row.language,
  status: row.status,
  version: row.version,
  approvedAt: row.approved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // Drafts are intentionally not addressable: the public route serves approved
  // posters only.
  imageUrl: row.status === 'approved' ? `${origin}/api/public/posters/${row.id}.svg` : null,
});

async function activeSubscription(c: any) {
  if (c.get('user')?.platformRole === 'super_admin') return null;
  const settings = await getSettings(c.env);
  const subscription = computeSubscription(
    c.get('company'),
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!subscription.isActive) {
    return c.json({ error: { code: 'subscription_inactive' } }, 402);
  }
  return null;
}

app.get('/:companyId/posters', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'content.create') && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const rows = await all<any>(
    c.env,
    'SELECT * FROM poster_drafts WHERE company_id = ? ORDER BY created_at DESC LIMIT 100',
    company.id
  );
  const origin = new URL(c.req.url).origin;
  return c.json({
    posters: rows.map((row) => serialize(row, origin)),
    sizes: posterSizes,
    templates: ['bold', 'minimal', 'offer'],
    canCreate: can(c.get('role'), 'content.create'),
    canApprove: can(c.get('role'), 'content.approve'),
  });
});

app.post('/:companyId/posters', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), 'content.create')) return apiError(c, 403, 'forbidden');
  const blocked = await activeSubscription(c);
  if (blocked) return blocked;

  const body = await readJson<Record<string, unknown>>(c);
  const headline = str(body.headline, 240);
  if (!headline) return apiError(c, 422, 'poster_headline_required');
  const sizeKey = str(body.sizeKey, 40);
  if (!isPosterSize(sizeKey)) return apiError(c, 422, 'poster_size_invalid');
  const template = str(body.template, 20) || 'bold';
  if (!isPosterTemplate(template)) return apiError(c, 422, 'poster_template_invalid');
  const brandColor = str(body.brandColor, 7) || '#0f766e';
  if (!HEX.test(brandColor)) return apiError(c, 422, 'color_invalid');

  const size = POSTER_SIZES[sizeKey];
  const id = newId('pstr');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO poster_drafts (id, company_id, title, headline, subhead, cta, template, size_key,
       width, height, brand_color, language, status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
    id,
    company.id,
    str(body.title, 160) || headline.slice(0, 60),
    headline,
    str(body.subhead, 400) || null,
    str(body.cta, 60) || null,
    template,
    sizeKey,
    size.width,
    size.height,
    brandColor,
    body.language === 'en' ? 'en' : 'ar',
    actor.id,
    timestamp,
    timestamp
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'poster.created',
    entityType: 'poster',
    entityId: id,
    meta: { sizeKey, template },
  });

  const row = await first<any>(c.env, 'SELECT * FROM poster_drafts WHERE id = ?', id);
  return c.json({ poster: serialize(row, new URL(c.req.url).origin) }, 201);
});

app.patch('/:companyId/posters/:posterId', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'content.create')) return apiError(c, 403, 'forbidden');
  const blocked = await activeSubscription(c);
  if (blocked) return blocked;

  const poster = await first<any>(
    c.env,
    'SELECT * FROM poster_drafts WHERE id = ? AND company_id = ?',
    c.req.param('posterId'),
    company.id
  );
  if (!poster) return apiError(c, 404, 'poster_not_found');
  if (poster.status === 'approved') return apiError(c, 409, 'poster_approved_immutable');

  const body = await readJson<Record<string, unknown>>(c);
  const headline = body.headline !== undefined ? str(body.headline, 240) : poster.headline;
  if (!headline) return apiError(c, 422, 'poster_headline_required');
  const sizeKey = body.sizeKey !== undefined ? str(body.sizeKey, 40) : poster.size_key;
  if (!isPosterSize(sizeKey)) return apiError(c, 422, 'poster_size_invalid');
  const template = body.template !== undefined ? str(body.template, 20) : poster.template;
  if (!isPosterTemplate(template)) return apiError(c, 422, 'poster_template_invalid');
  const brandColor = body.brandColor !== undefined ? str(body.brandColor, 7) : poster.brand_color;
  if (!HEX.test(brandColor)) return apiError(c, 422, 'color_invalid');
  const size = POSTER_SIZES[sizeKey];

  await run(
    c.env,
    `UPDATE poster_drafts SET title = ?, headline = ?, subhead = ?, cta = ?, template = ?,
       size_key = ?, width = ?, height = ?, brand_color = ?, language = ?, version = version + 1,
       updated_at = ? WHERE id = ? AND company_id = ?`,
    body.title !== undefined ? str(body.title, 160) || poster.title : poster.title,
    headline,
    body.subhead !== undefined ? str(body.subhead, 400) || null : poster.subhead,
    body.cta !== undefined ? str(body.cta, 60) || null : poster.cta,
    template,
    sizeKey,
    size.width,
    size.height,
    brandColor,
    body.language === 'en' ? 'en' : poster.language,
    nowIso(),
    poster.id,
    company.id
  );
  const row = await first<any>(c.env, 'SELECT * FROM poster_drafts WHERE id = ?', poster.id);
  return c.json({ poster: serialize(row, new URL(c.req.url).origin) });
});

/** Authenticated preview: drafts can be looked at without becoming public. */
app.get('/:companyId/posters/:posterId/preview.svg', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'content.create') && !can(c.get('role'), 'reports.view')) {
    return apiError(c, 403, 'forbidden');
  }
  const poster = await first<any>(
    c.env,
    'SELECT * FROM poster_drafts WHERE id = ? AND company_id = ?',
    c.req.param('posterId'),
    company.id
  );
  if (!poster) return c.text('Not found', 404);
  const svg = renderPosterSvg({
    headline: poster.headline,
    subhead: poster.subhead ?? '',
    cta: poster.cta ?? '',
    template: poster.template as PosterTemplate,
    size: POSTER_SIZES[poster.size_key] ?? {
      key: poster.size_key,
      width: poster.width,
      height: poster.height,
      label: poster.size_key,
    },
    brandColor: poster.brand_color,
    language: poster.language === 'en' ? 'en' : 'ar',
  });
  c.header('content-type', 'image/svg+xml; charset=utf-8');
  c.header('cache-control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
  return c.body(svg);
});

app.post('/:companyId/posters/:posterId/approve', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  if (!can(c.get('role'), 'content.approve')) return apiError(c, 403, 'forbidden');
  const poster = await first<any>(
    c.env,
    'SELECT * FROM poster_drafts WHERE id = ? AND company_id = ?',
    c.req.param('posterId'),
    company.id
  );
  if (!poster) return apiError(c, 404, 'poster_not_found');
  if (poster.status === 'archived') return apiError(c, 409, 'poster_archived');
  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE poster_drafts SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND company_id = ?`,
    actor.id,
    timestamp,
    timestamp,
    poster.id,
    company.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'poster.approved',
    entityType: 'poster',
    entityId: poster.id,
    meta: { version: poster.version },
  });
  const row = await first<any>(c.env, 'SELECT * FROM poster_drafts WHERE id = ?', poster.id);
  return c.json({ poster: serialize(row, new URL(c.req.url).origin) });
});

app.post('/:companyId/posters/:posterId/archive', async (c) => {
  const company = c.get('company');
  if (!can(c.get('role'), 'content.approve')) return apiError(c, 403, 'forbidden');
  const poster = await first<any>(
    c.env,
    'SELECT * FROM poster_drafts WHERE id = ? AND company_id = ?',
    c.req.param('posterId'),
    company.id
  );
  if (!poster) return apiError(c, 404, 'poster_not_found');
  await run(
    c.env,
    `UPDATE poster_drafts SET status = 'archived', updated_at = ? WHERE id = ? AND company_id = ?`,
    nowIso(),
    poster.id,
    company.id
  );
  const row = await first<any>(c.env, 'SELECT * FROM poster_drafts WHERE id = ?', poster.id);
  return c.json({ poster: serialize(row, new URL(c.req.url).origin) });
});

export default app;

/** Public: approved posters only, rendered at request time. */
export const posterPublicRoutes = new Hono<AppEnv>();

posterPublicRoutes.get('/public/posters/:posterId', async (c) => {
  const id = String(c.req.param('posterId') ?? '').replace(/\.svg$/, '');
  const poster = await first<any>(
    c.env,
    `SELECT * FROM poster_drafts WHERE id = ? AND status = 'approved'`,
    id
  );
  if (!poster) return c.text('Not found', 404);
  const svg = renderPosterSvg({
    headline: poster.headline,
    subhead: poster.subhead ?? '',
    cta: poster.cta ?? '',
    template: poster.template as PosterTemplate,
    size: POSTER_SIZES[poster.size_key] ?? {
      key: poster.size_key,
      width: poster.width,
      height: poster.height,
      label: poster.size_key,
    },
    brandColor: poster.brand_color,
    language: poster.language === 'en' ? 'en' : 'ar',
  });
  c.header('content-type', 'image/svg+xml; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  c.header('x-content-type-options', 'nosniff');
  return c.body(svg);
});
