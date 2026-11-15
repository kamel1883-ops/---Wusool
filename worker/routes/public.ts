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

const app = new Hono<AppEnv>();

export const apiError = (
  c: Context<any>,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 402,
  code: string,
  extra: Record<string, unknown> = {}
) => c.json({ error: { code, ...extra } }, status);

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

/** First-run bootstrap: allowed only while no Super Admin exists. */
app.post('/setup', async (c) => {
  const admins = await first<{ n: number }>(
    c.env,
    `SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'`
  );
  if ((admins?.n ?? 0) > 0) return apiError(c, 409, 'setup_completed');

  const body = await readJson<{ name?: string; email?: string; password?: string; locale?: string }>(c);
  const name = str(body.name, 120);
  const email = str(body.email, 190).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name) return apiError(c, 422, 'name_required');
  if (!isEmail(email)) return apiError(c, 422, 'invalid_email');
  if (password.length < MIN_PASSWORD_LENGTH) return apiError(c, 422, 'weak_password');

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

export default app;
