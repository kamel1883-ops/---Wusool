/**
 * Tenant workspace routes. Mounted at /api/company.
 * Every route resolves the company from the caller's membership in
 * `companyContext`, and every permission is checked again on the server.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import {
  companyContext,
  hashPassword,
  PASSWORD_ITERATIONS,
  requireAuth,
} from '../lib/auth';
import {
  all,
  audit,
  computeSubscription,
  first,
  generateTempPassword,
  getSettings,
  isEmail,
  newId,
  nowIso,
  randomHex,
  readJson,
  run,
  str,
} from '../lib/db';
import { can, isCompanyRole, ROLE_PERMISSIONS } from '../lib/rbac';
import { apiError } from './public';

const app = new Hono<AppEnv>();

app.use('*', requireAuth);
// The company id must be captured by the middleware pattern itself, otherwise
// `c.req.param('companyId')` is empty inside a wildcard middleware.
app.use('/:companyId', companyContext);
app.use('/:companyId/*', companyContext);

const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const ALLOWED_PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

const serializeCompany = (company: any) => ({
  id: company.id,
  name: company.name,
  legalName: company.legal_name,
  domain: company.domain,
  industry: company.industry,
  city: company.city,
  country: company.country,
  contactName: company.contact_name,
  contactEmail: company.contact_email,
  contactPhone: company.contact_phone,
  planId: company.plan_id,
  subscriptionStart: company.subscription_start,
  subscriptionEnd: company.subscription_end,
  status: company.status,
  createdAt: company.created_at,
  updatedAt: company.updated_at,
});

app.get('/:companyId', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  const settings = await getSettings(c.env);
  const warningDays = Number(settings['subscription.warning_days'] ?? '30') || 30;
  const subscription = computeSubscription(company, warningDays);

  const plan = company.plan_id
    ? await first<any>(c.env, 'SELECT * FROM plans WHERE id = ?', company.plan_id)
    : null;

  const membersCount = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND status = 'active'`,
    company.id
  );
  const invoiceRows = await first<{ n: number }>(
    c.env,
    'SELECT COUNT(*) AS n FROM invoices WHERE company_id = ?',
    company.id
  );
  const pendingProofs = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM payment_proofs WHERE company_id = ? AND status = 'pending_review'`,
    company.id
  );
  const usageRows = await all<{ kind: string; total: number }>(
    c.env,
    `SELECT kind, SUM(quantity) AS total FROM usage_events WHERE company_id = ? GROUP BY kind`,
    company.id
  );

  const team = can(role, 'team.view')
    ? await all<any>(
        c.env,
        `SELECT m.id, m.role, m.status, m.created_at, u.id AS user_id, u.name, u.email, u.last_login_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.company_id = ? ORDER BY m.created_at`,
        company.id
      )
    : [];

  return c.json({
    company: serializeCompany(company),
    subscription,
    role,
    permissions: ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [],
    plan: plan ? { id: plan.id, nameAr: plan.name_ar, nameEn: plan.name_en, priceSar: plan.price_sar, billingPeriod: plan.billing_period, maxUsers: plan.max_users ?? null, monthlyAnalyses: plan.monthly_analyses ?? null } : null,
    counts: {
      members: membersCount?.n ?? 0,
      invoices: invoiceRows?.n ?? 0,
      pendingProofs: pendingProofs?.n ?? 0,
    },
    usage: Object.fromEntries(usageRows.map((row) => [row.kind, row.total])),
    team: team.map((m) => ({
      id: m.id,
      userId: m.user_id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status,
      lastLoginAt: m.last_login_at,
      createdAt: m.created_at,
    })),
  });
});

app.patch('/:companyId', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  if (!can(role, 'company.edit')) return apiError(c, 403, 'forbidden');

  const body = await readJson<Record<string, unknown>>(c);
  const updates: Record<string, string | null> = {};

  if (role === 'owner' && typeof body.name === 'string' && str(body.name, 160)) {
    updates.name = str(body.name, 160);
  }
  for (const [input, column] of [
    ['legalName', 'legal_name'],
    ['domain', 'domain'],
    ['industry', 'industry'],
    ['city', 'city'],
    ['contactName', 'contact_name'],
    ['contactPhone', 'contact_phone'],
  ] as const) {
    if (typeof body[input] === 'string') updates[column] = str(body[input], 200) || null;
  }
  if (typeof body.contactEmail === 'string') {
    const email = str(body.contactEmail, 190).toLowerCase();
    if (email && !isEmail(email)) return apiError(c, 422, 'invalid_email');
    updates.contact_email = email || null;
  }

  const entries = Object.entries(updates);
  if (!entries.length) return apiError(c, 422, 'no_changes');

  await run(
    c.env,
    `UPDATE companies SET ${entries.map(([column]) => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...entries.map(([, value]) => value),
    nowIso(),
    company.id
  );

  await audit(c.env, {
    actorUserId: c.get('user').id,
    actorEmail: c.get('user').email,
    companyId: company.id,
    action: 'company.updated',
    entityType: 'company',
    entityId: company.id,
    meta: { fields: entries.map(([column]) => column) },
  });

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

const memberRow = (row: any) => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  role: row.role,
  status: row.status,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

app.get('/:companyId/members', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  if (!can(role, 'team.view')) return apiError(c, 403, 'forbidden');
  const rows = await all<any>(
    c.env,
    `SELECT m.id, m.role, m.status, m.created_at, u.id AS user_id, u.name, u.email, u.last_login_at
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.company_id = ? ORDER BY m.created_at`,
    company.id
  );
  return c.json({ members: rows.map(memberRow) });
});

app.post('/:companyId/members', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role')!;
  if (!can(role, 'team.manage')) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const sub = computeSubscription(
    company,
    Number(settings['subscription.warning_days'] ?? '30') || 30
  );
  if (!sub.isActive) return apiError(c, 402, 'subscription_inactive');

  const body = await readJson<Record<string, unknown>>(c);
  const name = str(body.name, 120);
  const email = str(body.email, 190).toLowerCase();
  const memberRole = body.role;

  if (!name) return apiError(c, 422, 'name_required');
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (!isCompanyRole(memberRole)) return apiError(c, 422, 'invalid_role');

  // Package seats are a real limit: the plan caps active members.
  const seatPlan = company.plan_id
    ? await first<any>(c.env, 'SELECT max_users FROM plans WHERE id = ?', company.plan_id)
    : null;
  if (seatPlan && seatPlan.max_users !== null && seatPlan.max_users !== undefined) {
    const seats = await first<{ n: number }>(
      c.env,
      `SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND status = 'active'`,
      company.id
    );
    if ((seats?.n ?? 0) >= Number(seatPlan.max_users)) {
      return apiError(c, 403, 'plan_seats_exceeded');
    }
  }

  const existing = await first<any>(c.env, 'SELECT * FROM users WHERE email = ?', email);
  if (existing) {
    const duplicate = await first<any>(
      c.env,
      'SELECT id FROM memberships WHERE user_id = ? AND company_id = ?',
      existing.id,
      company.id
    );
    if (duplicate) return apiError(c, 409, 'already_member');
    const membershipId = newId('mem');
    await run(
      c.env,
      `INSERT INTO memberships (id, user_id, company_id, role, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      membershipId,
      existing.id,
      company.id,
      memberRole,
      nowIso()
    );
    await audit(c.env, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      companyId: company.id,
      action: 'member.added',
      entityType: 'membership',
      entityId: membershipId,
      meta: { email, role: memberRole, existingUser: true },
    });
    return c.json({
      ok: true,
      existingUser: true,
      member: memberRow({
        id: membershipId,
        user_id: existing.id,
        name: existing.name,
        email: existing.email,
        role: memberRole,
        status: 'active',
        created_at: nowIso(),
        last_login_at: existing.last_login_at,
      }),
    });
  }

  const tempPassword = generateTempPassword();
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);
  const userId = newId('usr');
  const membershipId = newId('mem');
  const timestamp = nowIso();

  await run(
    c.env,
    `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations,
       locale, platform_role, status, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 'active', 1, ?, ?)`,
    userId,
    email,
    name,
    hash,
    salt,
    PASSWORD_ITERATIONS,
    actor.locale,
    timestamp,
    timestamp
  );
  await run(
    c.env,
    `INSERT INTO memberships (id, user_id, company_id, role, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    membershipId,
    userId,
    company.id,
    memberRole,
    timestamp
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'member.created',
    entityType: 'membership',
    entityId: membershipId,
    meta: { email, role: memberRole },
  });

  return c.json({
    ok: true,
    existingUser: false,
    // Returned exactly once so the owner can hand it over securely.
    tempPassword,
    member: memberRow({
      id: membershipId,
      user_id: userId,
      name,
      email,
      role: memberRole,
      status: 'active',
      created_at: timestamp,
      last_login_at: null,
    }),
  });
});

async function activeOwnerCount(env: any, companyId: string) {
  const row = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND role = 'owner' AND status = 'active'`,
    companyId
  );
  return row?.n ?? 0;
}

app.patch('/:companyId/members/:memberId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role')!;
  if (!can(role, 'team.manage')) return apiError(c, 403, 'forbidden');

  const membershipId = c.req.param('memberId');
  const target = await first<any>(
    c.env,
    'SELECT * FROM memberships WHERE id = ? AND company_id = ?',
    membershipId,
    company.id
  );
  if (!target) return apiError(c, 404, 'member_not_found');

  const body = await readJson<{ role?: unknown; status?: unknown }>(c);
  const nextRole = isCompanyRole(body.role) ? body.role : target.role;
  const nextStatus = body.status === 'active' || body.status === 'disabled' ? body.status : target.status;

  const losesOwner =
    target.role === 'owner' &&
    target.status === 'active' &&
    (nextRole !== 'owner' || nextStatus !== 'active');
  if (losesOwner && (await activeOwnerCount(c.env, company.id)) <= 1) {
    return apiError(c, 409, 'last_owner');
  }

  await run(
    c.env,
    'UPDATE memberships SET role = ?, status = ? WHERE id = ? AND company_id = ?',
    nextRole,
    nextStatus,
    membershipId,
    company.id
  );
  if (nextStatus === 'disabled') {
    await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', target.user_id);
  }
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'member.updated',
    entityType: 'membership',
    entityId: membershipId,
    meta: { role: nextRole, status: nextStatus },
  });
  return c.json({ ok: true });
});

app.delete('/:companyId/members/:memberId', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role')!;
  if (!can(role, 'team.manage')) return apiError(c, 403, 'forbidden');

  const membershipId = c.req.param('memberId');
  const target = await first<any>(
    c.env,
    'SELECT * FROM memberships WHERE id = ? AND company_id = ?',
    membershipId,
    company.id
  );
  if (!target) return apiError(c, 404, 'member_not_found');
  if (target.role === 'owner' && (await activeOwnerCount(c.env, company.id)) <= 1) {
    return apiError(c, 409, 'last_owner');
  }

  await run(c.env, 'DELETE FROM memberships WHERE id = ?', membershipId);
  const remaining = await first<{ n: number }>(
    c.env,
    'SELECT COUNT(*) AS n FROM memberships WHERE user_id = ?',
    target.user_id
  );
  if ((remaining?.n ?? 0) === 0) {
    const user = await first<any>(c.env, 'SELECT platform_role FROM users WHERE id = ?', target.user_id);
    if (user?.platform_role === 'none') {
      await run(c.env, 'DELETE FROM users WHERE id = ?', target.user_id);
    }
  }
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'member.removed',
    entityType: 'membership',
    entityId: membershipId,
    meta: { userId: target.user_id },
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Subscription, invoices and transfer proofs
// ---------------------------------------------------------------------------

app.get('/:companyId/invoices', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  if (!can(role, 'billing.manage')) return apiError(c, 403, 'forbidden');

  const settings = await getSettings(c.env);
  const warningDays = Number(settings['subscription.warning_days'] ?? '30') || 30;
  const invoices = await all<any>(
    c.env,
    `SELECT * FROM invoices WHERE company_id = ? ORDER BY issued_at DESC`,
    company.id
  );
  const proofs = await all<any>(
    c.env,
    `SELECT p.*, i.number AS invoice_number FROM payment_proofs p
       JOIN invoices i ON i.id = p.invoice_id
      WHERE p.company_id = ? ORDER BY p.created_at DESC`,
    company.id
  );
  const plan = company.plan_id
    ? await first<any>(c.env, 'SELECT * FROM plans WHERE id = ?', company.plan_id)
    : null;
  const seatsUsed =
    (
      await first<{ n: number }>(
        c.env,
        `SELECT COUNT(*) AS n FROM memberships WHERE company_id = ? AND status = 'active'`,
        company.id
      )
    )?.n ?? 0;
  const monthStart = `${nowIso().slice(0, 7)}-01T00:00:00.000Z`;
  const analysesUsed =
    (
      await first<{ n: number }>(
        c.env,
        `SELECT COUNT(*) AS n FROM site_analyses WHERE company_id = ? AND created_at >= ?`,
        company.id,
        monthStart
      )
    )?.n ?? 0;

  return c.json({
    subscription: computeSubscription(company, warningDays),
    plan: plan
      ? {
          id: plan.id,
          nameAr: plan.name_ar,
          nameEn: plan.name_en,
          priceSar: plan.price_sar,
          billingPeriod: plan.billing_period,
          maxUsers: plan.max_users ?? null,
          monthlyAnalyses: plan.monthly_analyses ?? null,
        }
      : null,
    limits: {
      seatsUsed,
      seatsMax: plan?.max_users ?? null,
      analysesUsed,
      analysesMax: plan?.monthly_analyses ?? null,
    },
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
    bank: {
      bankName: settings['billing.bank_name'] ?? '',
      accountName: settings['billing.account_name'] ?? '',
      iban: settings['billing.iban'] ?? '',
      accountNumber: settings['billing.account_number'] ?? '',
      notes: c.get('user').locale === 'ar' ? settings['billing.notes_ar'] ?? '' : settings['billing.notes_en'] ?? '',
      currency: settings['billing.currency'] ?? 'SAR',
      configured: Boolean(settings['billing.bank_name'] && settings['billing.iban']),
    },
  });
});

app.post('/:companyId/invoices/:invoiceId/proofs', async (c) => {
  const company = c.get('company');
  const actor = c.get('user');
  const role = c.get('role')!;
  if (!can(role, 'billing.manage')) return apiError(c, 403, 'forbidden');

  const invoice = await first<any>(
    c.env,
    'SELECT * FROM invoices WHERE id = ? AND company_id = ?',
    c.req.param('invoiceId'),
    company.id
  );
  if (!invoice) return apiError(c, 404, 'invoice_not_found');
  if (invoice.status === 'paid') return apiError(c, 409, 'invoice_already_paid');
  if (invoice.status === 'void') return apiError(c, 409, 'invoice_void');

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return apiError(c, 422, 'file_required');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return apiError(c, 422, 'file_required');
  if (file.size > MAX_PROOF_BYTES) return apiError(c, 422, 'file_too_large');
  if (!ALLOWED_PROOF_TYPES.includes(file.type)) return apiError(c, 422, 'file_type_not_allowed');

  const proofId = newId('proof');
  const extension = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const fileKey = `payment-proofs/${company.id}/${invoice.id}/${proofId}.${extension}`;
  await c.env.FILES.put(fileKey, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  const reference = str(form.get('reference'), 120) || null;
  const note = str(form.get('note'), 500) || null;
  await run(
    c.env,
    `INSERT INTO payment_proofs (id, invoice_id, company_id, uploaded_by, file_key, file_name,
       mime_type, size_bytes, reference, note, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`,
    proofId,
    invoice.id,
    company.id,
    actor.id,
    fileKey,
    file.name.slice(0, 200),
    file.type,
    file.size,
    reference,
    note,
    nowIso()
  );
  await run(
    c.env,
    `UPDATE invoices SET status = 'pending_review' WHERE id = ? AND status = 'issued'`,
    invoice.id
  );
  await audit(c.env, {
    actorUserId: actor.id,
    actorEmail: actor.email,
    companyId: company.id,
    action: 'payment_proof.uploaded',
    entityType: 'payment_proof',
    entityId: proofId,
    meta: { invoiceNumber: invoice.number, sizeBytes: file.size, mimeType: file.type },
  });

  return c.json({ ok: true, proofId });
});

app.get('/:companyId/proofs/:proofId/file', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  if (!can(role, 'billing.manage')) return apiError(c, 403, 'forbidden');
  const proof = await first<any>(
    c.env,
    'SELECT * FROM payment_proofs WHERE id = ? AND company_id = ?',
    c.req.param('proofId'),
    company.id
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

app.get('/:companyId/activity', async (c) => {
  const company = c.get('company');
  const role = c.get('role')!;
  if (!can(role, 'team.manage')) return apiError(c, 403, 'forbidden');
  const logs = await all<any>(
    c.env,
    `SELECT action, actor_email, entity_type, entity_id, meta, created_at
       FROM audit_logs WHERE company_id = ? ORDER BY created_at DESC LIMIT 100`,
    company.id
  );
  return c.json({
    activity: logs.map((log) => ({
      action: log.action,
      actorEmail: log.actor_email,
      entityType: log.entity_type,
      entityId: log.entity_id,
      meta: log.meta ? JSON.parse(log.meta) : null,
      createdAt: log.created_at,
    })),
  });
});

export default app;
