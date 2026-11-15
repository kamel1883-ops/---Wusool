/**
 * Public + session routes: branding, first-run setup, login/logout, profile
 * and password management, password-reset requests and the /me bootstrap.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/auth';
import {
  createSession,
  destroySession,
  hashPassword,
  requireAuth,
  PASSWORD_ITERATIONS,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  loadUserBySession,
} from '../lib/auth';
import type { Env } from '../lib/db';
import {
  all,
  audit,
  first,
  getSettings,
  isEmail,
  newId,
  nowIso,
  randomHex,
  readJson,
  run,
  settingsList,
  str,
  computeSubscription,
} from '../lib/db';
import { ROLE_PERMISSIONS, type CompanyRole } from '../lib/rbac';
import { sha256Hex } from '../lib/auth';
import { ensureSchema } from '../lib/init';

const app = new Hono<AppEnv>();

export const apiError = (
  c: Context<any>,
  status: number,
  code: string,
  extra: Record<string, unknown> = {}
) => c.json({ error: { code, ...extra } }, status as any);

const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILURES = 8;

app.get('/public/branding', async (c) => {
  const settings = await settingsList(c.env);
  const admins = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'`
  );
  return c.json({
    branding: settings.brand,
    support: settings.support,
    platform: {
      defaultLocale: settings.platform.defaultLocale,
      supportedLocales: settings.platform.supportedLocales,
      setupCompleted: Boolean(admins?.n),
    },
  });
});

/**
 * Hosted-database bootstrap. Idempotent and side-effect free beyond creating
 * missing tables/seeds, so the Setup screen calls it before anything else.
 */
app.post('/setup/init', async (c) => {
  const result = await ensureSchema(c.env);
  return c.json({ ok: true, ...result });
});

const SETUP_CODE_MINUTES = 15;
const SETUP_TOKEN_MINUTES = 20;
const SETUP_MAX_ATTEMPTS = 5;

const setupEmailGate = (c: Context<any>, email: string) => {
  // Deployments pin the first admin address through the SETUP_ADMIN_EMAIL
  // secret; when it is set, no other address can claim the bootstrap account.
  const allowedSetupEmail = (c.env.SETUP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (allowedSetupEmail && email !== allowedSetupEmail) return false;
  return true;
};

const randomDigits = (length: number) => {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => String(b % 10))
    .join('');
};

/**
 * Step 1 of first-run bootstrap: the owner proves the address first.
 * Only the pinned owner address (when SETUP_ADMIN_EMAIL is set) receives a
 * code; any other address is refused before anything is stored or sent.
 * No email provider is configured yet, so until one is, the code is returned
 * once in the response and shown on screen — never logged, never stored
 * in plain text (only its SHA-256 hash is persisted).
 */
app.post('/setup/start', async (c) => {
  const admins = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'`
  );
  if ((admins?.n ?? 0) > 0) return apiError(c, 409, 'setup_completed');

  const body = await readJson<{ email?: string }>(c);
  const email = str(body.email, 190).toLowerCase();
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (!setupEmailGate(c, email)) return apiError(c, 403, 'setup_email_not_allowed');

  const code = randomDigits(6);
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + SETUP_CODE_MINUTES * 60_000).toISOString();
  await run(c.env, 'DELETE FROM setup_codes WHERE email = ? AND consumed_at IS NULL', email);
  await run(
    c.env,
    `INSERT INTO setup_codes (id, email, code_hash, expires_at, attempts, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    newId('stc'),
    email,
    await sha256Hex(`setup-code:${email}:${code}`),
    expiresAt,
    timestamp
  );
  await audit(c.env, {
    actorEmail: email,
    action: 'setup.code_issued',
    entityType: 'user',
    entityId: email,
    ip: c.req.header('cf-connecting-ip') ?? null,
  });
  return c.json({ ok: true, delivered: false, code, expiresInMinutes: SETUP_CODE_MINUTES });
});

/** Step 2: the owner types the code; a short-lived token unlocks step 3. */
app.post('/setup/verify', async (c) => {
  const admins = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'`
  );
  if ((admins?.n ?? 0) > 0) return apiError(c, 409, 'setup_completed');

  const body = await readJson<{ email?: string; code?: string }>(c);
  const email = str(body.email, 190).toLowerCase();
  const code = str(body.code, 12).replace(/\D/g, '');
  if (!isEmail(email) || !code) return apiError(c, 422, 'invalid_code');
  if (!setupEmailGate(c, email)) return apiError(c, 403, 'setup_email_not_allowed');

  const row = await first<any>(
    c.env,
    `SELECT * FROM setup_codes WHERE email = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    email
  );
  if (!row) return apiError(c, 410, 'setup_code_expired');
  if (row.attempts >= SETUP_MAX_ATTEMPTS) {
    await run(c.env, 'DELETE FROM setup_codes WHERE id = ?', row.id);
    return apiError(c, 429, 'too_many_attempts');
  }
  if (row.expires_at < nowIso()) {
    await run(c.env, 'DELETE FROM setup_codes WHERE id = ?', row.id);
    return apiError(c, 410, 'setup_code_expired');
  }
  const ok = (await sha256Hex(`setup-code:${email}:${code}`)) === row.code_hash;
  if (!ok) {
    await run(c.env, 'UPDATE setup_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return apiError(c, 422, 'invalid_code');
  }
  const token = randomHex(32);
  const tokenExpiresAt = new Date(Date.now() + SETUP_TOKEN_MINUTES * 60_000).toISOString();
  await run(
    c.env,
    `UPDATE setup_codes SET consumed_at = ?, token_hash = ?, token_expires_at = ? WHERE id = ?`,
    nowIso(),
    await sha256Hex(`setup-token:${email}:${token}`),
    tokenExpiresAt,
    row.id
  );
  return c.json({ ok: true, setupToken: token, expiresInMinutes: SETUP_TOKEN_MINUTES });
});

/** Step 3 (final): verified token + account details creates the Super Admin. */
app.post('/setup', async (c) => {
  const admins = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'`
  );
  if ((admins?.n ?? 0) > 0) return apiError(c, 409, 'setup_completed');

  const body = await readJson<{
    name?: string;
    email?: string;
    password?: string;
    locale?: string;
    setupToken?: string;
  }>(c);
  const name = str(body.name, 120);
  const email = str(body.email, 190).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const setupToken = typeof body.setupToken === 'string' ? body.setupToken : '';

  if (!name) return apiError(c, 422, 'name_required');
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (password.length < MIN_PASSWORD_LENGTH) return apiError(c, 422, 'weak_password');
  if (!setupEmailGate(c, email)) return apiError(c, 403, 'setup_email_not_allowed');
  if (!setupToken) return apiError(c, 422, 'setup_token_required');

  const tokenRow = await first<any>(
    c.env,
    `SELECT * FROM setup_codes WHERE email = ? AND consumed_at IS NOT NULL
      AND token_expires_at > ? ORDER BY consumed_at DESC LIMIT 1`,
    email,
    nowIso()
  );
  const tokenOk =
    tokenRow?.token_hash === (await sha256Hex(`setup-token:${email}:${setupToken}`));
  if (!tokenOk) return apiError(c, 403, 'setup_token_invalid');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const id = newId('usr');
  const timestamp = nowIso();

  await run(
    c.env,
    `INSERT INTO users (id, email, name, password_hash, password_salt, password_iterations,
       locale, platform_role, status, must_change_password, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'super_admin', 'active', 0, ?, ?, ?)`,
    id,
    email,
    name,
    hash,
    salt,
    PASSWORD_ITERATIONS,
    body.locale === 'en' ? 'en' : 'ar',
    timestamp,
    timestamp,
    timestamp
  );

  await audit(c.env, {
    actorUserId: id,
    actorEmail: email,
    action: 'setup.super_admin_created',
    entityType: 'user',
    entityId: id,
    ip: c.req.header('cf-connecting-ip') ?? null,
  });

  await run(c.env, 'DELETE FROM setup_codes WHERE email = ?', email);
  await createSession(c, id);
  return c.json({ ok: true });
});

app.post('/auth/login', async (c) => {
  const body = await readJson<{ email?: string; password?: string }>(c);
  const email = str(body.email, 190).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) return apiError(c, 401, 'invalid_credentials');

  const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000).toISOString();
  const failures = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM audit_logs
      WHERE action = 'auth.login_failed' AND entity_id = ? AND created_at > ?`,
    email,
    since
  );
  if ((failures?.n ?? 0) >= LOGIN_MAX_FAILURES) return apiError(c, 429, 'too_many_attempts');

  const user = await first<any>(c.env, 'SELECT * FROM users WHERE email = ?', email);
  const passwordOk =
    user &&
    (await verifyPassword(
      password,
      user.password_salt,
      user.password_hash,
      user.password_iterations
    ));

  if (!user || !passwordOk) {
    await audit(c.env, {
      actorEmail: email,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: email,
      ip: c.req.header('cf-connecting-ip') ?? null,
    });
    return apiError(c, 401, 'invalid_credentials');
  }

  if (user.status !== 'active') return apiError(c, 403, 'account_disabled');

  await run(c.env, 'UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
  await createSession(c, user.id);
  await audit(c.env, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    ip: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.json({ ok: true, mustChangePassword: Boolean(user.must_change_password) });
});

app.post('/auth/logout', async (c) => {
  const user = await loadUserBySession(c);
  await destroySession(c);
  if (user) {
    await audit(c.env, {
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'auth.logout',
      entityType: 'user',
      entityId: user.id,
    });
  }
  return c.json({ ok: true });
});

app.get('/auth/me', requireAuth, async (c) => {
  const user = c.get('user');
  const settings = await settingsList(c.env);
  const warningDays = settings.platform.warningDays;

  const rows = await first<any>(
    c.env,
    'SELECT locale FROM users WHERE id = ?',
    user.id
  );
  const memberships = await all<any>(
    c.env,
    `SELECT m.role, m.status, c.id, c.name, c.status AS company_status,
            c.subscription_start, c.subscription_end, c.plan_id
       FROM memberships m JOIN companies c ON c.id = m.company_id
      WHERE m.user_id = ? ORDER BY c.name`,
    user.id
  );

  const companies = memberships
    .filter((m) => m.status === 'active')
    .map((m) => {
      const sub = computeSubscription(
        { status: m.company_status, subscription_end: m.subscription_end, subscription_start: m.subscription_start },
        warningDays
      );
      return {
        id: m.id,
        name: m.name,
        role: m.role as CompanyRole,
        planId: m.plan_id,
        permissions: ROLE_PERMISSIONS[m.role as CompanyRole] ?? [],
        subscriptionEnd: m.subscription_end,
        ...sub,
      };
    });

  return c.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: rows?.locale === 'en' ? 'en' : user.locale,
      platformRole: user.platformRole,
      mustChangePassword: user.mustChangePassword,
    },
    companies,
    branding: settings.brand,
    support: settings.support,
    platform: {
      warningDays,
      supportedLocales: settings.platform.supportedLocales,
    },
  });
});

app.patch('/auth/profile', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await readJson<{ name?: string; locale?: string }>(c);
  const name = str(body.name, 120) || user.name;
  const locale = body.locale === 'en' ? 'en' : body.locale === 'ar' ? 'ar' : user.locale;
  await run(
    c.env,
    'UPDATE users SET name = ?, locale = ?, updated_at = ? WHERE id = ?',
    name,
    locale,
    nowIso(),
    user.id
  );
  return c.json({ ok: true, user: { name, locale } });
});

app.post('/auth/password', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(c);
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (newPassword.length < MIN_PASSWORD_LENGTH) return apiError(c, 422, 'weak_password');

  const row = await first<any>(
    c.env,
    'SELECT password_salt, password_hash, password_iterations FROM users WHERE id = ?',
    user.id
  );
  const ok =
    row &&
    (await verifyPassword(
      currentPassword,
      row.password_salt,
      row.password_hash,
      row.password_iterations
    ));
  if (!ok) return apiError(c, 403, 'wrong_password');

  const salt = randomHex(16);
  const hash = await hashPassword(newPassword, salt);
  await run(
    c.env,
    `UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ?,
       must_change_password = 0, updated_at = ? WHERE id = ?`,
    salt,
    hash,
    PASSWORD_ITERATIONS,
    nowIso(),
    user.id
  );
  // Keep the current session, revoke every other one.
  await run(
    c.env,
    'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?',
    user.id,
    user.tokenHash
  );
  await audit(c.env, {
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: user.id,
  });
  return c.json({ ok: true });
});

/**
 * Password resets are recorded for the support team. No email provider is
 * configured in Phase 1, so nothing is sent — the UI explains this explicitly.
 */
app.post('/auth/forgot', async (c) => {
  const body = await readJson<{ email?: string }>(c);
  const email = str(body.email, 190).toLowerCase();
  if (isEmail(email)) {
    await audit(c.env, {
      actorEmail: email,
      action: 'auth.password_reset_requested',
      entityType: 'user',
      entityId: email,
      ip: c.req.header('cf-connecting-ip') ?? null,
    });
  }
  const settings = await getSettings(c.env);
  return c.json({
    ok: true,
    deliveryConfigured: Boolean(settings['support.email']),
    supportEmail: settings['support.email'] || '',
  });
});

const ORDER_MONTHS = [3, 6, 9, 12];

const publicPlanPrices = async (env: Env) => {
  const rows = await all<{ plan_id: string; months: number; price_sar: number }>(
    env,
    'SELECT plan_id, months, price_sar FROM plan_prices'
  );
  const byPlan = new Map<string, Array<{ months: number; price: number }>>();
  for (const row of rows) {
    const list = byPlan.get(row.plan_id) ?? [];
    list.push({ months: row.months, price: row.price_sar });
    byPlan.set(row.plan_id, list);
  }
  return byPlan;
};

/** Public catalogue used by the landing page and the order form. */
app.get('/public/plans', async (c) => {
  const plans = await all<any>(
    c.env,
    'SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order, created_at'
  );
  const prices = await publicPlanPrices(c.env);
  return c.json({
    plans: plans.map((plan) => {
      const list =
        prices.get(plan.id) ??
        ORDER_MONTHS.map((months) => ({
          months,
          price: Math.round(((Number(plan.price_sar) || 0) / 12) * months),
        }));
      return {
        id: plan.id,
        nameAr: plan.name_ar,
        nameEn: plan.name_en,
        priceSar: plan.price_sar,
        billingPeriod: plan.billing_period,
        maxUsers: plan.max_users,
        monthlyAnalyses: plan.monthly_analyses ?? null,
        featuresAr: JSON.parse(plan.features_ar || '[]'),
        featuresEn: JSON.parse(plan.features_en || '[]'),
        prices: list.sort((a, b) => a.months - b.months),
      };
    }),
  });
});

/**
 * Public purchase request. Creates no account, no company and no session —
 * only a `pending_review` row. The customer-chosen password is hashed with
 * PBKDF2 immediately and is never returned by any endpoint.
 */
app.post('/public/purchase-requests', async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const companyName = str(body.companyName, 160);
  const contactName = str(body.contactName, 120) || null;
  const email = str(body.email, 190).toLowerCase();
  const phone = str(body.phone, 40) || null;
  const planId = str(body.planId, 60);
  const months = Number(body.months);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!companyName) return apiError(c, 422, 'name_required');
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (!planId) return apiError(c, 422, 'invalid_plan');
  if (!ORDER_MONTHS.includes(months)) return apiError(c, 422, 'invalid_period');
  if (password.length < MIN_PASSWORD_LENGTH) return apiError(c, 422, 'weak_password');

  const plan = await first<any>(
    c.env,
    'SELECT * FROM plans WHERE id = ? AND is_active = 1',
    planId
  );
  if (!plan) return apiError(c, 422, 'invalid_plan');
  const price = await first<{ price_sar: number }>(
    c.env,
    'SELECT price_sar FROM plan_prices WHERE plan_id = ? AND months = ?',
    planId,
    months
  );
  if (!price) return apiError(c, 422, 'invalid_period');

  const existingUser = await first<any>(c.env, 'SELECT id FROM users WHERE email = ?', email);
  if (existingUser) return apiError(c, 409, 'email_taken');
  const pending = await first<any>(
    c.env,
    `SELECT id FROM purchase_requests WHERE email = ? AND status = 'pending_review'`,
    email
  );
  if (pending) return apiError(c, 409, 'request_pending');

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const id = newId('ord');
  const timestamp = nowIso();
  await run(
    c.env,
    `INSERT INTO purchase_requests (id, company_name, contact_name, email, phone, plan_id, months,
       password_hash, password_salt, password_iterations, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)`,
    id,
    companyName,
    contactName,
    email,
    phone,
    planId,
    months,
    hash,
    salt,
    PASSWORD_ITERATIONS,
    timestamp,
    timestamp
  );
  await audit(c.env, {
    actorEmail: email,
    action: 'purchase_request.created',
    entityType: 'purchase_request',
    entityId: id,
    meta: { planId, months, amountSar: price.price_sar },
    ip: c.req.header('cf-connecting-ip') ?? null,
  });
  return c.json({ ok: true, requestId: id }, 201);
});

/** Let a requester follow their own order by email (status + review note only). */
app.get('/public/purchase-requests', async (c) => {
  const email = str(c.req.query('email'), 190).toLowerCase();
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  const rows = await all<any>(
    c.env,
    `SELECT r.id, r.company_name, r.plan_id, r.months, r.status, r.review_note, r.created_at,
            p.name_ar AS plan_name_ar, p.name_en AS plan_name_en,
            pp.price_sar AS amount_sar
       FROM purchase_requests r
       LEFT JOIN plans p ON p.id = r.plan_id
       LEFT JOIN plan_prices pp ON pp.plan_id = r.plan_id AND pp.months = r.months
      WHERE r.email = ? ORDER BY r.created_at DESC LIMIT 20`,
    email
  );
  return c.json({
    requests: rows.map((row) => ({
      id: row.id,
      companyName: row.company_name,
      planId: row.plan_id,
      planNameAr: row.plan_name_ar,
      planNameEn: row.plan_name_en,
      months: row.months,
      amountSar: row.amount_sar,
      status: row.status,
      reviewNote: row.review_note,
      createdAt: row.created_at,
    })),
  });
});

export default app;
