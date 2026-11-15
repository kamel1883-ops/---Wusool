/**
 * Super Admin order intake routes. Mounted at /api/admin alongside admin.ts.
 * Approving a request is the ONLY way a public order becomes a tenant:
 * user + company + owner membership + subscription dates + first invoice.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import { requireAuth, requireSuperAdmin } from '../lib/auth';
import {
  all,
  audit,
  first,
  isEmail,
  newId,
  nowIso,
  readJson,
  run,
  str,
} from '../lib/db';
import { apiError } from './public';
import { nextInvoiceNumber } from '../lib/invoices';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('*', requireSuperAdmin);

const ORDER_MONTHS = [3, 6, 9, 12];

/** Add calendar months without time-of-day surprises (dates are YYYY-MM-DD). */
const addPeriodMonths = (dateStr: string, months: number) => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(year || 1970, (month || 1) - 1, day || 1));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
};

const serializePurchaseRequest = (row: any) => ({
  id: row.id,
  companyName: row.company_name,
  contactName: row.contact_name,
  email: row.email,
  phone: row.phone,
  planId: row.plan_id,
  planNameAr: row.plan_name_ar ?? null,
  planNameEn: row.plan_name_en ?? null,
  months: row.months,
  amountSar: row.amount_sar ?? null,
  status: row.status,
  reviewNote: row.review_note,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

app.get('/purchase-requests', async (c) => {
  const status = str(c.req.query('status'), 40);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('r.status = ?');
    params.push(status);
  }
  const rows = await all<any>(
    c.env,
    `SELECT r.*, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en,
            pp.price_sar AS amount_sar
       FROM purchase_requests r
       LEFT JOIN plans p ON p.id = r.plan_id
       LEFT JOIN plan_prices pp ON pp.plan_id = r.plan_id AND pp.months = r.months
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC LIMIT 200`,
    ...params
  );
  return c.json({ requests: rows.map(serializePurchaseRequest) });
});

app.post('/purchase-requests/:requestId/approve', async (c) => {
  const actor = c.get('user');
  const request = await first<any>(
    c.env,
    'SELECT * FROM purchase_requests WHERE id = ?',
    c.req.param('requestId')
  );
  if (!request) return apiError(c, 404, 'request_not_found');
  if (request.status !== 'pending_review') return apiError(c, 409, 'request_already_reviewed');

  const plan = await first<any>(
    c.env,
    'SELECT * FROM plans WHERE id = ? AND is_active = 1',
    request.plan_id
  );
  if (!plan) return apiError(c, 422, 'invalid_plan');
  const price = await first<{ price_sar: number }>(
    c.env,
    'SELECT price_sar FROM plan_prices WHERE plan_id = ? AND months = ?',
    request.plan_id,
    request.months
  );
  if (!price) return apiError(c, 422, 'invalid_period');

  const duplicate = await first<any>(c.env, 'SELECT id FROM users WHERE email = ?', request.email);
  if (duplicate) return apiError(c, 409, 'email_taken');

  const timestamp = nowIso();
  const today = timestamp.slice(0, 10);
  const periodEnd = addPeriodMonths(today, request.months);

  const userId = newId('usr');
  await run(
    c.env,
    `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations,
       locale, platform_role, status, must_change_password, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ar', 'none', 'active', 0, ?, ?, NULL)`,
    userId,
    request.email,
    request.contact_name || request.company_name,
    request.password_hash,
    request.password_salt,
    request.password_iterations,
    timestamp,
    timestamp
  );

  const companyId = newId('co');
  await run(
    c.env,
    `INSERT INTO companies (id, name, legal_name, domain, industry, city, country, contact_name,
       contact_email, contact_phone, plan_id, subscription_start, subscription_end, status,
       notes, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, 'SA', ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    companyId,
    request.company_name,
    request.contact_name,
    request.email,
    request.phone,
    request.plan_id,
    today,
    periodEnd,
    timestamp,
    timestamp
  );
  await run(
    c.env,
    `INSERT INTO memberships (id, user_id, company_id, role, status, created_at)
     VALUES (?, ?, ?, 'owner', 'active', ?)`,
    newId('mem'),
    userId,
    companyId,
    timestamp
  );

  const invoiceId = newId('inv');
  await run(
    c.env,
    `INSERT INTO invoices (id, company_id, number, amount_sar, currency, period_start, period_end,
       issued_at, due_at, status, notes, created_at)
     VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, NULL, 'issued', ?, ?)`,
    invoiceId,
    companyId,
    await nextInvoiceNumber(c.env),
    price.price_sar,
    today,
    periodEnd,
    timestamp,
    `طلب شراء ${request.id} — ${request.months} أشهر`,
    timestamp
  );

  await run(
    c.env,
    `UPDATE purchase_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, updated_at = ?
      WHERE id = ?`,
    actor.id,
    timestamp,
    timestamp,
    request.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId,
    action: 'purchase_request.approved',
    entityType: 'purchase_request',
    entityId: request.id,
    meta: { companyId, userId, planId: request.plan_id, months: request.months, invoiceId },
  });
  return c.json({ ok: true, companyId, userId, invoiceId, subscriptionEnd: periodEnd });
});

app.post('/purchase-requests/:requestId/reject', async (c) => {
  const actor = c.get('user');
  const request = await first<any>(
    c.env,
    'SELECT * FROM purchase_requests WHERE id = ?',
    c.req.param('requestId')
  );
  if (!request) return apiError(c, 404, 'request_not_found');
  if (request.status !== 'pending_review') return apiError(c, 409, 'request_already_reviewed');

  const body = await readJson<{ note?: unknown }>(c);
  const note = str(body.note, 1000);
  if (!note) return apiError(c, 422, 'comment_required');

  const timestamp = nowIso();
  await run(
    c.env,
    `UPDATE purchase_requests SET status = 'rejected', review_note = ?, reviewed_by = ?,
       reviewed_at = ?, updated_at = ? WHERE id = ?`,
    note,
    actor.id,
    timestamp,
    timestamp,
    request.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'purchase_request.rejected',
    entityType: 'purchase_request',
    entityId: request.id,
    meta: { note },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// User email replacement (Super Admin only — tenants can never change emails)
// ---------------------------------------------------------------------------

app.patch('/users/:userId/email', async (c) => {
  const actor = c.get('user');
  const target = await first<any>(c.env, 'SELECT * FROM users WHERE id = ?', c.req.param('userId'));
  if (!target) return apiError(c, 404, 'user_not_found');

  const body = await readJson<{ email?: unknown }>(c);
  const email = str(body.email, 190).toLowerCase();
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (email === target.email) return apiError(c, 422, 'no_changes');

  const taken = await first<any>(c.env, 'SELECT id FROM users WHERE email = ?', email);
  if (taken) return apiError(c, 409, 'email_taken');

  await run(c.env, 'UPDATE users SET email = ?, updated_at = ? WHERE id = ?', email, nowIso(), target.id);
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', target.id);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.email_changed',
    entityType: 'user',
    entityId: target.id,
    meta: { previousEmail: target.email, newEmail: email },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Plan period prices
// ---------------------------------------------------------------------------

app.get('/plans/:planId/prices', async (c) => {
  const plan = await first<any>(c.env, 'SELECT id FROM plans WHERE id = ?', c.req.param('planId'));
  if (!plan) return apiError(c, 404, 'plan_not_found');
  const rows = await all<{ months: number; price_sar: number }>(
    c.env,
    'SELECT months, price_sar FROM plan_prices WHERE plan_id = ? ORDER BY months',
    plan.id
  );
  return c.json({
    prices: rows.map((row) => ({ months: row.months, price: row.price_sar })),
  });
});

app.put('/plans/:planId/prices', async (c) => {
  const actor = c.get('user');
  const plan = await first<any>(c.env, 'SELECT id FROM plans WHERE id = ?', c.req.param('planId'));
  if (!plan) return apiError(c, 404, 'plan_not_found');

  const body = await readJson<{ prices?: unknown }>(c);
  if (!Array.isArray(body.prices) || !body.prices.length) return apiError(c, 422, 'prices_required');

  const clean: Array<{ months: number; price: number }> = [];
  for (const entry of body.prices) {
    const months = Number((entry as any)?.months);
    const price = Number((entry as any)?.price);
    if (!ORDER_MONTHS.includes(months)) return apiError(c, 422, 'invalid_period');
    if (!Number.isFinite(price) || price < 0) return apiError(c, 422, 'invalid_amount');
    clean.push({ months, price: Math.round(price) });
  }

  for (const entry of clean) {
    await run(
      c.env,
      `INSERT INTO plan_prices (plan_id, months, price_sar) VALUES (?, ?, ?)
       ON CONFLICT(plan_id, months) DO UPDATE SET price_sar = excluded.price_sar`,
      plan.id,
      entry.months,
      entry.price
    );
  }
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'plan.prices_updated',
    entityType: 'plan',
    entityId: plan.id,
    meta: { prices: clean },
  });
  return c.json({ ok: true });
});

export default app;
