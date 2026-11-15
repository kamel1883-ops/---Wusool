/**
 * Super Admin routes. Mounted at /api/admin and guarded by platform role.
 * This is the only place where tenant status, plan and subscription dates
 * can be changed — tenants can never write those fields.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import {
  hashPassword,
  PASSWORD_ITERATIONS,
  requireAuth,
  requireSuperAdmin,
} from '../lib/auth';
import {
  all,
  audit,
  computeSubscription,
  first,
  generateTempPassword,
  getSettings,
  isEmail,
  isIsoDate,
  newId,
  nowIso,
  randomHex,
  readJson,
  run,
  setSettings,
  settingsList,
  str,
} from '../lib/db';
import { ROLE_PERMISSIONS, type CompanyRole } from '../lib/rbac';
import { apiError } from './public';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
app.use('*', requireSuperAdmin);

const COMPANY_STATUSES = ['pending', 'active', 'suspended', 'expired', 'cancelled'] as const;
type CompanyStatus = (typeof COMPANY_STATUSES)[number];
const isCompanyStatus = (value: unknown): value is CompanyStatus =>
  typeof value === 'string' && (COMPANY_STATUSES as readonly string[]).includes(value);

const INVOICE_STATUSES = ['draft', 'issued', 'pending_review', 'paid', 'void'] as const;

const COMPANY_LIST_SQL = `
  SELECT c.*, p.name_ar AS plan_name_ar, p.name_en AS plan_name_en,
         (SELECT COUNT(*) FROM memberships m WHERE m.company_id = c.id AND m.status = 'active') AS members_count,
         (SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.company_id = c.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_name,
         (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.company_id = c.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
         (SELECT COUNT(*) FROM payment_proofs pp WHERE pp.company_id = c.id AND pp.status = 'pending_review') AS pending_proofs
    FROM companies c LEFT JOIN plans p ON p.id = c.plan_id`;

const serializeCompanyRow = (row: any, locale: 'ar' | 'en', warningDays: number) => {
  const subscription = computeSubscription(row, warningDays);
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    domain: row.domain,
    industry: row.industry,
    city: row.city,
    country: row.country,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    planId: row.plan_id,
    planName:
      (locale === 'ar' ? row.plan_name_ar : row.plan_name_en) || row.plan_name_ar || row.plan_name_en || null,
    subscriptionStart: row.subscription_start,
    subscriptionEnd: row.subscription_end,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerName: row.owner_name,
    ownerEmail: row.owner_email,
    membersCount: row.members_count ?? 0,
    pendingProofs: row.pending_proofs ?? 0,
    subscription,
  };
};

async function nextInvoiceNumber(env: any) {
  const year = new Date().getUTCFullYear();
  const row = await first<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM invoices');
  let suffix = (row?.n ?? 0) + 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `WS-${year}-${String(suffix).padStart(4, '0')}`;
    const exists = await first(env, 'SELECT 1 AS x FROM invoices WHERE number = ?', candidate);
    if (!exists) return candidate;
    suffix += 1;
  }
  return `WS-${year}-${Date.now().toString(36).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

app.get('/overview', async (c) => {
  const user = c.get('user');
  const settings = await getSettings(c.env);
  const warningDays = Number(settings['subscription.warning_days'] ?? '30') || 30;

  const statusRows = await all<{ status: string; n: number }>(
    c.env,
    'SELECT status, COUNT(*) AS n FROM companies GROUP BY status'
  );
  const byStatus: Record<string, number> = {};
  for (const status of COMPANY_STATUSES) byStatus[status] = 0;
  for (const row of statusRows) byStatus[row.status] = row.n;

  const expiring = await all<any>(
    c.env,
    `SELECT id, name, subscription_end FROM companies
      WHERE status = 'active' AND subscription_end IS NOT NULL
        AND date(subscription_end) <= date('now', ?)
      ORDER BY subscription_end LIMIT 8`,
    `+${warningDays} days`
  );
  const pendingProofs = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM payment_proofs WHERE status = 'pending_review'`
  );
  const openInvoices = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM invoices WHERE status IN ('issued', 'pending_review')`
  );
  const paid = await first<{ total: number }>(
    c.env,
    `SELECT COALESCE(SUM(amount_sar), 0) AS total FROM invoices WHERE status = 'paid'`
  );
  const users = await first<{ n: number }>(c.env, 'SELECT COUNT(*) AS n FROM users');
  const pendingCompanies = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM companies WHERE status = 'pending'`
  );
  const usage = await all<{ kind: string; total: number }>(
    c.env,
    'SELECT kind, COALESCE(SUM(quantity), 0) AS total FROM usage_events GROUP BY kind'
  );
  const recent = await all<any>(c.env, `${COMPANY_LIST_SQL} ORDER BY c.created_at DESC LIMIT 6`);

  return c.json({
    warningDays,
    companies: {
      total: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      ...byStatus,
    },
    expiring: expiring.map((row) => ({ id: row.id, name: row.name, subscriptionEnd: row.subscription_end })),
    pendingProofs: pendingProofs?.n ?? 0,
    openInvoices: openInvoices?.n ?? 0,
    paidTotal: paid?.total ?? 0,
    users: users?.n ?? 0,
    pendingCompanies: pendingCompanies?.n ?? 0,
    usage: Object.fromEntries(usage.map((row) => [row.kind, row.total])),
    recentCompanies: recent.map((row) => serializeCompanyRow(row, user.locale, warningDays)),
  });
});

// ---------------------------------------------------------------------------
// Companies (tenants)
// ---------------------------------------------------------------------------

app.get('/companies', async (c) => {
  const user = c.get('user');
  const settings = await getSettings(c.env);
  const warningDays = Number(settings['subscription.warning_days'] ?? '30') || 30;

  const status = c.req.query('status');
  const q = str(c.req.query('q'), 120);
  const where: string[] = [];
  const params: unknown[] = [];
  if (isCompanyStatus(status)) {
    where.push('c.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(c.name LIKE ? OR c.domain LIKE ? OR c.contact_email LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `${COMPANY_LIST_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at DESC LIMIT 200`;
  const rows = await all<any>(c.env, sql, ...params);
  return c.json({ companies: rows.map((row) => serializeCompanyRow(row, user.locale, warningDays)) });
});

app.get('/plans', async (c) => {
  const rows = await all<any>(c.env, 'SELECT * FROM plans ORDER BY sort_order, created_at');
  return c.json({
    plans: rows.map((row) => ({
      id: row.id,
      nameAr: row.name_ar,
      nameEn: row.name_en,
      priceSar: row.price_sar,
      billingPeriod: row.billing_period,
      maxUsers: row.max_users,
      featuresAr: JSON.parse(row.features_ar || '[]'),
      featuresEn: JSON.parse(row.features_en || '[]'),
      isActive: Boolean(row.is_active),
      sortOrder: row.sort_order,
    })),
  });
});

app.post('/plans', async (c) => {
  const user = c.get('user');
  const body = await readJson<Record<string, unknown>>(c);
  const nameAr = str(body.nameAr, 120);
  const nameEn = str(body.nameEn, 120) || nameAr;
  if (!nameAr) return apiError(c, 422, 'name_required');
  const id = newId('plan');
  await run(
    c.env,
    `INSERT INTO plans (id, name_ar, name_en, price_sar, billing_period, max_users,
       features_ar, features_en, is_active, sort_order, created_at)
     VALUES (?, ?, ?, ?, 'annual', ?, ?, ?, ?, ?, ?)`,
    id,
    nameAr,
    nameEn,
    Math.max(0, Number(body.priceSar) || 0),
    body.maxUsers ? Number(body.maxUsers) : null,
    JSON.stringify(Array.isArray(body.featuresAr) ? body.featuresAr.slice(0, 20) : []),
    JSON.stringify(Array.isArray(body.featuresEn) ? body.featuresEn.slice(0, 20) : []),
    body.isActive === false ? 0 : 1,
    Number(body.sortOrder) || 0,
    nowIso()
  );
  await audit(c.env, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'plan.created',
    entityType: 'plan',
    entityId: id,
    meta: { nameAr },
  });
  return c.json({ ok: true, id });
});

app.patch('/plans/:planId', async (c) => {
  const user = c.get('user');
  const plan = await first<any>(c.env, 'SELECT * FROM plans WHERE id = ?', c.req.param('planId'));
  if (!plan) return apiError(c, 404, 'plan_not_found');
  const body = await readJson<Record<string, unknown>>(c);

  const fields: string[] = [];
  const params: unknown[] = [];
  if (typeof body.nameAr === 'string' && str(body.nameAr, 120)) {
    fields.push('name_ar = ?');
    params.push(str(body.nameAr, 120));
  }
  if (typeof body.nameEn === 'string' && str(body.nameEn, 120)) {
    fields.push('name_en = ?');
    params.push(str(body.nameEn, 120));
  }
  if (body.priceSar !== undefined) {
    fields.push('price_sar = ?');
    params.push(Math.max(0, Number(body.priceSar) || 0));
  }
  if (body.maxUsers !== undefined) {
    fields.push('max_users = ?');
    params.push(body.maxUsers === null || body.maxUsers === '' ? null : Number(body.maxUsers) || null);
  }
  if (Array.isArray(body.featuresAr)) {
    fields.push('features_ar = ?');
    params.push(JSON.stringify(body.featuresAr.slice(0, 20)));
  }
  if (Array.isArray(body.featuresEn)) {
    fields.push('features_en = ?');
    params.push(JSON.stringify(body.featuresEn.slice(0, 20)));
  }
  if (body.isActive !== undefined) {
    fields.push('is_active = ?');
    params.push(body.isActive ? 1 : 0);
  }
  if (body.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    params.push(Number(body.sortOrder) || 0);
  }
  if (!fields.length) return apiError(c, 422, 'no_changes');

  await run(c.env, `UPDATE plans SET ${fields.join(', ')} WHERE id = ?`, ...params, plan.id);
  await audit(c.env, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'plan.updated',
    entityType: 'plan',
    entityId: plan.id,
  });
  return c.json({ ok: true });
});

app.post('/companies', async (c) => {
  const actor = c.get('user');
  const body = await readJson<Record<string, unknown>>(c);

  const name = str(body.name, 160);
  const ownerEmail = str(body.ownerEmail, 190).toLowerCase();
  if (!name) return apiError(c, 422, 'name_required');
  if (ownerEmail && !isEmail(ownerEmail)) return apiError(c, 422, 'invalid_email');

  const status: CompanyStatus = isCompanyStatus(body.status) ? body.status : 'pending';
  const subscriptionStart = isIsoDate(String(body.subscriptionStart ?? '')) ? String(body.subscriptionStart) : null;
  const subscriptionEnd = isIsoDate(String(body.subscriptionEnd ?? '')) ? String(body.subscriptionEnd) : null;
  if (status === 'active' && !subscriptionEnd) return apiError(c, 422, 'subscription_end_required');

  const planId = str(body.planId, 60) || null;
  if (planId) {
    const plan = await first(c.env, 'SELECT id FROM plans WHERE id = ?', planId);
    if (!plan) return apiError(c, 422, 'invalid_plan');
  }

  const companyId = newId('co');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO companies (id, name, legal_name, domain, industry, city, country, contact_name,
       contact_email, contact_phone, plan_id, subscription_start, subscription_end, status, notes,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId,
    name,
    str(body.legalName, 200) || null,
    str(body.domain, 200) || null,
    str(body.industry, 120) || null,
    str(body.city, 120) || null,
    str(body.country, 60) || 'SA',
    str(body.contactName, 120) || null,
    str(body.contactEmail, 190).toLowerCase() || null,
    str(body.contactPhone, 40) || null,
    planId,
    subscriptionStart,
    subscriptionEnd,
    status,
    str(body.notes, 1000) || null,
    timestamp,
    timestamp
  );

  let ownerTempPassword: string | null = null;
  if (ownerEmail) {
    const ownerName = str(body.ownerName, 120) || name;
    const existing = await first<any>(c.env, 'SELECT * FROM users WHERE email = ?', ownerEmail);
    const userId = existing?.id ?? newId('usr');
    if (!existing) {
      ownerTempPassword = generateTempPassword();
      const salt = randomHex(16);
      const hash = await hashPassword(ownerTempPassword, salt);
      await run(
        c.env,
        `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations,
           locale, platform_role, status, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ar', 'none', 'active', 1, ?, ?)`,
        userId,
        ownerEmail,
        ownerName,
        hash,
        salt,
        PASSWORD_ITERATIONS,
        timestamp,
        timestamp
      );
    }
    await run(
      c.env,
      `INSERT INTO memberships (id, user_id, company_id, role, status, created_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
      newId('mem'),
      userId,
      companyId,
      timestamp
    );
  }

  const invoiceAmount = Math.max(0, Number(body.invoiceAmount) || 0);
  let invoiceId: string | null = null;
  if (invoiceAmount > 0) {
    invoiceId = newId('inv');
    await run(
      c.env,
      `INSERT INTO invoices (id, company_id, number, amount_sar, currency, period_start, period_end,
         issued_at, due_at, status, notes, created_at)
       VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, 'issued', ?, ?)`,
      invoiceId,
      companyId,
      await nextInvoiceNumber(c.env),
      invoiceAmount,
      subscriptionStart,
      subscriptionEnd,
      timestamp,
      isIsoDate(String(body.invoiceDueAt ?? '')) ? String(body.invoiceDueAt) : null,
      str(body.invoiceNotes, 500) || null,
      timestamp
    );
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId,
    action: 'company.created',
    entityType: 'company',
    entityId: companyId,
    meta: { name, status, ownerEmail: ownerEmail || null, invoiceId },
  });

  return c.json({ ok: true, companyId, ownerTempPassword, invoiceId });
});
