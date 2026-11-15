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
import { nextInvoiceNumber } from '../lib/invoices';
import { analysisLimits, startAnalysisJob } from '../lib/analysis-pipeline';
import { aiProviderStatus } from '../lib/ai';
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
      monthlyAnalyses: row.monthly_analyses ?? null,
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
       monthly_analyses, features_ar, features_en, is_active, sort_order, created_at)
     VALUES (?, ?, ?, ?, 'annual', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    nameAr,
    nameEn,
    Math.max(0, Number(body.priceSar) || 0),
    body.maxUsers ? Number(body.maxUsers) : null,
    body.monthlyAnalyses === null || body.monthlyAnalyses === '' || body.monthlyAnalyses === undefined
      ? null
      : Math.max(0, Number(body.monthlyAnalyses) || 0),
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
  if (body.monthlyAnalyses !== undefined) {
    fields.push('monthly_analyses = ?');
    params.push(
      body.monthlyAnalyses === null || body.monthlyAnalyses === ''
        ? null
        : Math.max(0, Number(body.monthlyAnalyses) || 0)
    );
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

app.get('/companies/:companyId', async (c) => {
  const actor = c.get('user');
  const settings = await getSettings(c.env);
  const warningDays = Number(settings['subscription.warning_days'] ?? '30') || 30;
  const row = await first<any>(
    c.env,
    `${COMPANY_LIST_SQL} WHERE c.id = ?`,
    c.req.param('companyId')
  );
  if (!row) return apiError(c, 404, 'company_not_found');

  const members = await all<any>(
    c.env,
    `SELECT m.id, m.role, m.status, m.created_at, u.id AS user_id, u.name, u.email,
            u.last_login_at, u.status AS user_status
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.company_id = ? ORDER BY m.created_at`,
    row.id
  );
  const invoices = await all<any>(
    c.env,
    `SELECT * FROM invoices WHERE company_id = ? ORDER BY issued_at DESC`,
    row.id
  );
  const proofs = await all<any>(
    c.env,
    'SELECT * FROM payment_proofs WHERE company_id = ? ORDER BY created_at DESC',
    row.id
  );
  const usage = await all<any>(
    c.env,
    `SELECT kind, COALESCE(SUM(quantity), 0) AS total, COALESCE(SUM(cost_micros), 0) AS cost_micros
       FROM usage_events WHERE company_id = ? GROUP BY kind`,
    row.id
  );
  const activity = await all<any>(
    c.env,
    `SELECT action, actor_email, entity_type, entity_id, meta, created_at
       FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 50`,
    row.id
  );

  return c.json({
    company: serializeCompanyRow(row, actor.locale, warningDays),
    members: members.map((m) => ({
      id: m.id,
      userId: m.user_id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      userStatus: m.user_status,
      lastLoginAt: m.last_login_at,
      createdAt: m.created_at,
    })),
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      amountSar: invoice.amount_sar,
      currency: invoice.currency,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      issuedAt: invoice.issued_at,
      dueAt: invoice.due_at,
      status: invoice.status,
      notes: invoice.notes,
      proofs: proofs
        .filter((proof) => proof.invoice_id === invoice.id)
        .map((proof) => ({
          id: proof.id,
          fileName: proof.file_name,
          mimeType: proof.mime_type,
          sizeBytes: proof.size_bytes,
          reference: proof.reference,
          note: proof.note,
          status: proof.status,
          reviewNote: proof.review_note,
          reviewedAt: proof.reviewed_at,
          createdAt: proof.created_at,
        })),
    })),
    usage: Object.fromEntries(usage.map((entry) => [entry.kind, entry.total])),
    activity: activity.map((log) => ({
      action: log.action,
      actorEmail: log.actor_email,
      entityType: log.entity_type,
      entityId: log.entity_id,
      meta: log.meta ? JSON.parse(log.meta) : null,
      createdAt: log.created_at,
    })),
  });
});

app.patch('/companies/:companyId', async (c) => {
  const actor = c.get('user');
  const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', c.req.param('companyId'));
  if (!company) return apiError(c, 404, 'company_not_found');
  const body = await readJson<Record<string, unknown>>(c);

  const fields: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };

  if (typeof body.name === 'string' && str(body.name, 160)) push('name', str(body.name, 160));
  for (const [input, column] of [
    ['legalName', 'legal_name'],
    ['domain', 'domain'],
    ['industry', 'industry'],
    ['city', 'city'],
    ['country', 'country'],
    ['contactName', 'contact_name'],
    ['contactPhone', 'contact_phone'],
    ['notes', 'notes'],
  ] as const) {
    if (typeof body[input] === 'string') push(column, str(body[input], 1000) || null);
  }
  if (typeof body.contactEmail === 'string') {
    const email = str(body.contactEmail, 190).toLowerCase();
    if (email && !isEmail(email)) return apiError(c, 422, 'invalid_email');
    push('contact_email', email || null);
  }

  let nextStatus: CompanyStatus = company.status;
  if (body.status !== undefined) {
    if (!isCompanyStatus(body.status)) return apiError(c, 422, 'invalid_status');
    nextStatus = body.status;
    push('status', nextStatus);
  }

  if (body.planId !== undefined) {
    const planId = str(body.planId, 60) || null;
    if (planId) {
      const plan = await first(c.env, 'SELECT id FROM plans WHERE id = ?', planId);
      if (!plan) return apiError(c, 422, 'invalid_plan');
    }
    push('plan_id', planId);
  }

  let start = company.subscription_start as string | null;
  let end = company.subscription_end as string | null;
  if (body.subscriptionStart !== undefined) {
    const value = String(body.subscriptionStart ?? '');
    if (value && !isIsoDate(value)) return apiError(c, 422, 'invalid_date');
    start = value || null;
    push('subscription_start', start);
  }
  if (body.subscriptionEnd !== undefined) {
    const value = String(body.subscriptionEnd ?? '');
    if (value && !isIsoDate(value)) return apiError(c, 422, 'invalid_date');
    end = value || null;
    push('subscription_end', end);
  }

  if (nextStatus === 'active' && !end) return apiError(c, 422, 'subscription_end_required');
  if (nextStatus === 'active' && !start) {
    start = new Date().toISOString().slice(0, 10);
    push('subscription_start', start);
  }

  if (!fields.length) return apiError(c, 422, 'no_changes');
  push('updated_at', nowIso());

  await run(c.env, `UPDATE companies SET ${fields.join(', ')} WHERE id = ?`, ...params, company.id);

  if (nextStatus === 'suspended' || nextStatus === 'cancelled') {
    // Removing access immediately for every member of a suspended tenant.
    await run(
      c.env,
      `DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM memberships WHERE company_id = ?)`,
      company.id
    );
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: nextStatus !== company.status ? `company.status.${nextStatus}` : 'company.updated',
    entityType: 'company',
    entityId: company.id,
    meta: { fields: fields.map((field) => field.split(' = ')[0]) },
  });

  return c.json({ ok: true });
});

app.delete('/companies/:companyId', async (c) => {
  const actor = c.get('user');
  const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', c.req.param('companyId'));
  if (!company) return apiError(c, 404, 'company_not_found');

  const members = await all<{ user_id: string }>(
    c.env,
    'SELECT user_id FROM memberships WHERE company_id = ?',
    company.id
  );
  const proofs = await all<{ file_key: string }>(
    c.env,
    'SELECT file_key FROM payment_proofs WHERE company_id = ?',
    company.id
  );
  for (const proof of proofs) {
    await c.env.FILES.delete(proof.file_key).catch(() => undefined);
  }
  await run(c.env, 'DELETE FROM payment_proofs WHERE company_id = ?', company.id);
  await run(c.env, 'DELETE FROM invoices WHERE company_id = ?', company.id);
  await run(c.env, 'DELETE FROM usage_events WHERE company_id = ?', company.id);
  await run(c.env, 'DELETE FROM memberships WHERE company_id = ?', company.id);
  await run(c.env, 'DELETE FROM companies WHERE id = ?', company.id);

  for (const member of members) {
    const remaining = await first<{ n: number }>(
      c.env,
      'SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?',
      member.user_id
    );
    if ((remaining?.n ?? 0) === 0) {
      const user = await first<any>(c.env, 'SELECT platform_role FROM users WHERE id = ?', member.user_id);
      if (user?.platform_role === 'none') {
        await run(c.env, 'DELETE FROM users WHERE id = ?', member.user_id);
      }
    }
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: null,
    action: 'company.deleted',
    entityType: 'company',
    entityId: company.id,
    meta: { name: company.name, status: company.status },
  });
  return c.json({ ok: true });
});

app.post('/companies/:companyId/invoices', async (c) => {
  const actor = c.get('user');
  const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', c.req.param('companyId'));
  if (!company) return apiError(c, 404, 'company_not_found');

  const body = await readJson<Record<string, unknown>>(c);
  const amountSar = Math.round(Number(body.amountSar));
  if (!Number.isFinite(amountSar) || amountSar <= 0) return apiError(c, 422, 'invalid_amount');

  const periodStart = isIsoDate(String(body.periodStart ?? '')) ? String(body.periodStart) : null;
  const periodEnd = isIsoDate(String(body.periodEnd ?? '')) ? String(body.periodEnd) : null;
  const dueAt = isIsoDate(String(body.dueAt ?? '')) ? String(body.dueAt) : null;

  const id = newId('inv');
  const number = await nextInvoiceNumber(c.env);
  await run(
    c.env,
    `INSERT INTO invoices (id, company_id, number, amount_sar, currency, period_start, period_end,
       issued_at, due_at, status, notes, created_at)
     VALUES (?, ?, ?, ?, 'SAR', ?, ?, ?, ?, 'issued', ?, ?)`,
    id,
    company.id,
    number,
    amountSar,
    periodStart,
    periodEnd,
    nowIso(),
    dueAt,
    str(body.notes, 500) || null,
    nowIso()
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: id,
    meta: { number, amountSar },
  });
  return c.json({ ok: true, id, number });
});

// ---------------------------------------------------------------------------
// Invoices and payment proofs
// ---------------------------------------------------------------------------

app.get('/invoices', async (c) => {
  const status = c.req.query('status');
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof status === 'string' && (INVOICE_STATUSES as readonly string[]).includes(status)) {
    where.push('i.status = ?');
    params.push(status);
  }
  const rows = await all<any>(
    c.env,
    `SELECT i.*, c.name AS company_name,
            (SELECT COUNT(*) FROM payment_proofs p WHERE p.invoice_id = i.id AND p.status = 'pending_review') AS pending_proofs
       FROM invoices i JOIN companies c ON c.id = i.company_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.issued_at DESC LIMIT 300`,
    ...params
  );
  return c.json({
    invoices: rows.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      companyName: row.company_name,
      number: row.number,
      amountSar: row.amount_sar,
      currency: row.currency,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      issuedAt: row.issued_at,
      dueAt: row.due_at,
      status: row.status,
      notes: row.notes,
      pendingProofs: row.pending_proofs ?? 0,
    })),
  });
});

app.get('/proofs', async (c) => {
  const status = c.req.query('status') ?? 'pending_review';
  const rows = await all<any>(
    c.env,
    `SELECT p.*, i.number AS invoice_number, i.amount_sar, i.period_start, i.period_end, c.name AS company_name
       FROM payment_proofs p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN companies c ON c.id = p.company_id
      WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 200`,
    status
  );
  return c.json({
    proofs: rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      invoiceNumber: row.invoice_number,
      invoiceAmountSar: row.amount_sar,
      invoicePeriodStart: row.period_start,
      invoicePeriodEnd: row.period_end,
      companyId: row.company_id,
      companyName: row.company_name,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      reference: row.reference,
      note: row.note,
      status: row.status,
      reviewNote: row.review_note,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
    })),
  });
});

app.post('/proofs/:proofId/review', async (c) => {
  const actor = c.get('user');
  const proof = await first<any>(
    c.env,
    'SELECT * FROM payment_proofs WHERE id = ?',
    c.req.param('proofId')
  );
  if (!proof) return apiError(c, 404, 'proof_not_found');
  if (proof.status !== 'pending_review') return apiError(c, 409, 'proof_already_reviewed');

  const body = await readJson<{ decision?: string; note?: string }>(c);
  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    return apiError(c, 422, 'invalid_decision');
  }
  const note = str(body.note, 500) || null;
  const timestamp = nowIso();

  await run(
    c.env,
    `UPDATE payment_proofs SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`,
    body.decision,
    actor.id,
    timestamp,
    note,
    proof.id
  );

  const invoice = await first<any>(c.env, 'SELECT * FROM invoices WHERE id = ?', proof.invoice_id);
  if (body.decision === 'approved' && invoice) {
    await run(c.env, `UPDATE invoices SET status = 'paid' WHERE id = ?`, invoice.id);

    const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', invoice.company_id);
    if (company) {
      const start = invoice.period_start || company.subscription_start;
      const end = invoice.period_end || company.subscription_end;
      await run(
        c.env,
        `UPDATE companies SET status = 'active', subscription_start = ?, subscription_end = ?, updated_at = ?
          WHERE id = ?`,
        start ?? new Date().toISOString().slice(0, 10),
        end ?? null,
        timestamp,
        company.id
      );
    }
  } else {
    await run(
      c.env,
      `UPDATE invoices SET status = 'issued' WHERE id = ? AND status = 'pending_review'`,
      proof.invoice_id
    );
  }

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: proof.company_id,
    action: body.decision === 'approved' ? 'payment_proof.approved' : 'payment_proof.rejected',
    entityType: 'payment_proof',
    entityId: proof.id,
    meta: { invoiceNumber: invoice?.number ?? null, note, amountSar: invoice?.amount_sar ?? null },
  });

  return c.json({ ok: true });
});

app.get('/proofs/:proofId/file', async (c) => {
  const proof = await first<any>(
    c.env,
    'SELECT * FROM payment_proofs WHERE id = ?',
    c.req.param('proofId')
  );
  if (!proof) return apiError(c, 404, 'file_not_found');
  const object = await c.env.FILES.get(proof.file_key);
  if (!object) return apiError(c, 404, 'file_not_found');
  return new Response(object.body, {
    headers: {
      'Content-Type': proof.mime_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${encodeURIComponent(proof.file_name)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

app.get('/users', async (c) => {
  const q = str(c.req.query('q'), 120);
  const rows = await all<any>(
    c.env,
    `SELECT u.id, u.name, u.email, u.platform_role, u.status, u.must_change_password,
            u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS memberships_count
       FROM users u
      ${q ? 'WHERE (u.name LIKE ? OR u.email LIKE ?)' : ''}
      ORDER BY u.created_at DESC LIMIT 200`,
    ...(q ? [`%${q}%`, `%${q}%`] : [])
  );
  return c.json({
    users: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      platformRole: row.platform_role,
      status: row.status,
      mustChangePassword: Boolean(row.must_change_password),
      membershipsCount: row.memberships_count ?? 0,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    })),
  });
});

app.post('/users', async (c) => {
  const actor = c.get('user');
  const body = await readJson<Record<string, unknown>>(c);
  const name = str(body.name, 120);
  const email = str(body.email, 190).toLowerCase();
  const isSuper = body.platformRole === 'super_admin';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name) return apiError(c, 422, 'name_required');
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (await first(c.env, 'SELECT id FROM users WHERE email = ?', email)) {
    return apiError(c, 409, 'email_taken');
  }

  const generated = password.length >= 8 ? null : generateTempPassword();
  const plain = generated ?? password;
  const salt = randomHex(16);
  const hash = await hashPassword(plain, salt);
  const id = newId('usr');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations,
       locale, platform_role, status, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ar', ?, 'active', ?, ?, ?)`,
    id,
    email,
    name,
    hash,
    salt,
    PASSWORD_ITERATIONS,
    isSuper ? 'super_admin' : 'none',
    generated ? 1 : 0,
    timestamp,
    timestamp
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.created',
    entityType: 'user',
    entityId: id,
    meta: { email, platformRole: isSuper ? 'super_admin' : 'none' },
  });
  return c.json({ ok: true, id, tempPassword: generated });
});

app.patch('/users/:userId', async (c) => {
  const actor = c.get('user');
  const target = await first<any>(c.env, 'SELECT * FROM users WHERE id = ?', c.req.param('userId'));
  if (!target) return apiError(c, 404, 'user_not_found');
  const body = await readJson<Record<string, unknown>>(c);

  const fields: string[] = [];
  const params: unknown[] = [];
  if (typeof body.name === 'string' && str(body.name, 120)) {
    fields.push('name = ?');
    params.push(str(body.name, 120));
  }
  if (body.status === 'active' || body.status === 'disabled') {
    if (target.id === actor.id && body.status === 'disabled') {
      return apiError(c, 409, 'cannot_disable_self');
    }
    fields.push('status = ?');
    params.push(body.status);
    if (body.status === 'disabled') {
      await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', target.id);
    }
  }
  if (body.platformRole === 'super_admin' || body.platformRole === 'none') {
    if (target.id === actor.id && body.platformRole !== 'super_admin') {
      return apiError(c, 409, 'cannot_demote_self');
    }
    fields.push('platform_role = ?');
    params.push(body.platformRole);
  }
  if (!fields.length) return apiError(c, 422, 'no_changes');

  fields.push('updated_at = ?');
  params.push(nowIso());
  await run(c.env, `UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...params, target.id);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.updated',
    entityType: 'user',
    entityId: target.id,
    meta: { status: body.status, platformRole: body.platformRole },
  });
  return c.json({ ok: true });
});

app.post('/users/:userId/reset-password', async (c) => {
  const actor = c.get('user');
  const target = await first<any>(c.env, 'SELECT * FROM users WHERE id = ?', c.req.param('userId'));
  if (!target) return apiError(c, 404, 'user_not_found');

  const tempPassword = generateTempPassword();
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);
  await run(
    c.env,
    `UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ?,
       must_change_password = 1, updated_at = ? WHERE id = ?`,
    salt,
    hash,
    PASSWORD_ITERATIONS,
    nowIso(),
    target.id
  );
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', target.id);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'user.password_reset',
    entityType: 'user',
    entityId: target.id,
  });
  return c.json({ ok: true, tempPassword });
});

// ---------------------------------------------------------------------------
// Usage, audit, settings
// ---------------------------------------------------------------------------

app.get('/usage', async (c) => {
  const rows = await all<any>(
    c.env,
    `SELECT u.company_id, c.name AS company_name, u.kind,
            COALESCE(SUM(u.quantity), 0) AS quantity,
            COALESCE(SUM(u.cost_micros), 0) AS cost_micros
       FROM usage_events u LEFT JOIN companies c ON c.id = u.company_id
      GROUP BY u.company_id, u.kind ORDER BY c.name`
  );
  const byCompany = new Map<string, any>();
  for (const row of rows) {
    const entry = byCompany.get(row.company_id) ?? {
      companyId: row.company_id,
      companyName: row.company_name ?? '—',
      siteAnalysis: 0,
      contentGeneration: 0,
      imageGeneration: 0,
      emailSend: 0,
      whatsappSend: 0,
      costMicros: 0,
    };
    if (row.kind === 'site_analysis') entry.siteAnalysis = row.quantity;
    if (row.kind === 'content_generation') entry.contentGeneration = row.quantity;
    if (row.kind === 'image_generation') entry.imageGeneration = row.quantity;
    if (row.kind === 'email_send') entry.emailSend = row.quantity;
    if (row.kind === 'whatsapp_send') entry.whatsappSend = row.quantity;
    entry.costMicros += row.cost_micros;
    byCompany.set(row.company_id, entry);
  }
  return c.json({ usage: [...byCompany.values()] });
});

app.get('/audit', async (c) => {
  const companyId = str(c.req.query('companyId'), 80);
  const action = str(c.req.query('action'), 80);
  const limit = Math.min(300, Math.max(1, Number(c.req.query('limit')) || 100));
  const where: string[] = [];
  const params: unknown[] = [];
  if (companyId) {
    where.push('company_id = ?');
    params.push(companyId);
  }
  if (action) {
    where.push('action LIKE ?');
    params.push(`${action}%`);
  }
  const rows = await all<any>(
    c.env,
    `SELECT company_id, actor_email, action, entity_type, entity_id, meta, created_at
       FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ?`,
    ...params,
    limit
  );
  return c.json({
    logs: rows.map((row) => ({
      companyId: row.company_id,
      actorEmail: row.actor_email,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      meta: row.meta ? JSON.parse(row.meta) : null,
      createdAt: row.created_at,
    })),
  });
});

const SETTINGS_PREFIXES = ['brand.', 'support.', 'billing.', 'owner.', 'subscription.', 'platform.', 'analysis.'];
const RESERVED_SETTING_KEYS = new Set(['platform.setup_completed']);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

app.get('/settings', async (c) => {
  const settings = await settingsList(c.env);
  return c.json({
    values: settings.raw,
    brand: settings.brand,
    support: settings.support,
    platform: settings.platform,
  });
});

app.patch('/settings', async (c) => {
  const actor = c.get('user');
  const body = await readJson<{ values?: Record<string, unknown> }>(c);
  const values = body.values ?? {};
  const patch: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(values)) {
    if (RESERVED_SETTING_KEYS.has(key)) continue;
    if (!SETTINGS_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return apiError(c, 422, 'invalid_setting_key', { key });
    }
    if (typeof rawValue !== 'string') return apiError(c, 422, 'invalid_setting_value', { key });
    const value = rawValue.trim().slice(0, 1000);

    if (key === 'brand.primary_color' || key === 'brand.ink_color') {
      if (value && !HEX_COLOR.test(value)) return apiError(c, 422, 'invalid_color', { key });
    }
    if (key === 'platform.default_locale' && !['ar', 'en'].includes(value)) {
      return apiError(c, 422, 'invalid_locale', { key });
    }
    if (key === 'platform.supported_locales') {
      const locales = value.split(',').map((item) => item.trim()).filter((item) => ['ar', 'en'].includes(item));
      if (!locales.length) return apiError(c, 422, 'invalid_locale', { key });
      patch[key] = [...new Set(locales)].join(',');
      continue;
    }
    if (key === 'subscription.warning_days') {
      const days = Number(value);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return apiError(c, 422, 'invalid_number', { key });
      }
      patch[key] = String(Math.round(days));
      continue;
    }
    patch[key] = value;
  }

  if (!Object.keys(patch).length) return apiError(c, 422, 'no_changes');
  await setSettings(c.env, patch);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'settings.updated',
    entityType: 'platform_settings',
    meta: { keys: Object.keys(patch) },
  });
  return c.json({ ok: true });
});

/**
 * Site-analysis monitoring (Phase 2). Super Admin sees job state, provider,
 * limits and technical errors — not the customer's report content, unless that
 * is ever explicitly granted; every look at an analysis is audited.
 */
app.get('/site-analyses', async (c) => {
  const status = str(c.req.query('status'), 40);
  const companyId = str(c.req.query('companyId'), 80);
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (companyId) {
    where.push('a.company_id = ?');
    params.push(companyId);
  }

  const rows = await all<any>(
    c.env,
    `SELECT a.*, co.name AS company_name, u.email AS creator_email
       FROM site_analyses a
       LEFT JOIN companies co ON co.id = a.company_id
       LEFT JOIN users u ON u.id = a.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC LIMIT 200`,
    ...params
  );
  const usage = await all<any>(
    c.env,
    `SELECT analysis_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(estimated_cost_micros) AS cost_micros, COUNT(*) AS calls
       FROM ai_usage_events GROUP BY analysis_id`
  );
  const usageByAnalysis = new Map(usage.map((row) => [row.analysis_id, row]));

  return c.json({
    analyses: rows.map((row) => {
      const cost = usageByAnalysis.get(row.id);
      return {
        id: row.id,
        companyId: row.company_id,
        companyName: row.company_name,
        creatorEmail: row.creator_email,
        url: row.normalized_url,
        status: row.status,
        locale: row.locale,
        provider: row.provider,
        model: row.model,
        crawlerProvider: row.crawler_provider,
        pagesFound: row.pages_found,
        pagesAnalyzed: row.pages_analyzed,
        pagesFailed: row.pages_failed,
        latestVersion: row.latest_version,
        approvedVersion: row.approved_version,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        usage: {
          inputTokens: cost?.input_tokens ?? 0,
          outputTokens: cost?.output_tokens ?? 0,
          costMicros: cost?.cost_micros ?? 0,
          calls: cost?.calls ?? 0,
        },
      };
    }),
    ai: aiProviderStatus(c.env, await getSettings(c.env)),
    limits: analysisLimits(c.env, await getSettings(c.env)),
  });
});

app.get('/site-analyses/:analysisId', async (c) => {
  const actor = c.get('user');
  const analysis = await first<any>(
    c.env,
    'SELECT * FROM site_analyses WHERE id = ?',
    c.req.param('analysisId')
  );
  if (!analysis) return apiError(c, 404, 'analysis_not_found');

  const pages = await all<any>(
    c.env,
    `SELECT url, status_code, crawl_status, word_count, error_message FROM site_pages
      WHERE analysis_id = ? ORDER BY depth, created_at LIMIT 100`,
    analysis.id
  );
  const approvals = await all<any>(
    c.env,
    `SELECT version, action, user_id, comment, created_at FROM analysis_approvals
      WHERE analysis_id = ? ORDER BY created_at DESC`,
    analysis.id
  );
  const usage = await all<any>(
    c.env,
    `SELECT provider, model, operation, input_tokens, output_tokens, estimated_cost_micros, status,
            error_message, created_at
       FROM ai_usage_events WHERE analysis_id = ? ORDER BY created_at DESC`,
    analysis.id
  );

  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: analysis.company_id,
    action: 'admin.site_analysis.viewed',
    entityType: 'site_analysis',
    entityId: analysis.id,
  });

  // Deliberately excludes result_json and page content: the admin view is
  // technical, not a back door into the customer's private report.
  return c.json({
    analysis: {
      id: analysis.id,
      companyId: analysis.company_id,
      url: analysis.normalized_url,
      status: analysis.status,
      provider: analysis.provider,
      model: analysis.model,
      crawlerProvider: analysis.crawler_provider,
      robotsPolicy: analysis.robots_policy,
      pagesFound: analysis.pages_found,
      pagesAnalyzed: analysis.pages_analyzed,
      pagesFailed: analysis.pages_failed,
      latestVersion: analysis.latest_version,
      approvedVersion: analysis.approved_version,
      errorMessage: analysis.error_message,
      startedAt: analysis.started_at,
      completedAt: analysis.completed_at,
      createdAt: analysis.created_at,
    },
    pages: pages.map((page) => ({
      url: page.url,
      statusCode: page.status_code,
      status: page.crawl_status,
      wordCount: page.word_count,
      errorMessage: page.error_message,
    })),
    approvals,
    usage,
  });
});

app.post('/site-analyses/:analysisId/retry', async (c) => {
  const actor = c.get('user');
  const analysis = await first<any>(
    c.env,
    'SELECT * FROM site_analyses WHERE id = ?',
    c.req.param('analysisId')
  );
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['failed', 'cancelled', 'changes_requested'].includes(analysis.status)) {
    return apiError(c, 409, 'analysis_not_retryable');
  }

  const settings = await getSettings(c.env);
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: analysis.company_id,
    action: 'admin.site_analysis.retried',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { previousStatus: analysis.status },
  });

  const outcome = await startAnalysisJob(
    c.env,
    analysis,
    { id: actor.id, email: actor.email },
    settings
  );
  if (!outcome.ok) return apiError(c, outcome.status, outcome.code);
  const row = await first<any>(c.env, 'SELECT status, error_message FROM site_analyses WHERE id = ?', analysis.id);
  return c.json({ ok: true, analysis: { id: analysis.id, status: row?.status, errorMessage: row?.error_message } });
});

app.post('/site-analyses/:analysisId/cancel', async (c) => {
  const actor = c.get('user');
  const analysis = await first<any>(
    c.env,
    'SELECT * FROM site_analyses WHERE id = ?',
    c.req.param('analysisId')
  );
  if (!analysis) return apiError(c, 404, 'analysis_not_found');
  if (!['draft', 'queued', 'crawling', 'extracting', 'analyzing'].includes(analysis.status)) {
    return apiError(c, 409, 'analysis_not_cancellable');
  }

  await run(
    c.env,
    `UPDATE site_analyses SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?`,
    nowIso(),
    nowIso(),
    analysis.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: analysis.company_id,
    action: 'admin.site_analysis.cancelled',
    entityType: 'site_analysis',
    entityId: analysis.id,
    meta: { previousStatus: analysis.status },
  });
  return c.json({ ok: true });
});

/** Role labels and permission map, used by the admin UI to explain access. */
app.get('/roles', (c) =>
  c.json({
    roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({
      role: role as CompanyRole,
      permissions,
    })),
  })
);

export default app;
