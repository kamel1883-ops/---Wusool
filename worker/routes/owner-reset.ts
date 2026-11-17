/**
 * One-time owner recovery.
 *
 * There is no email provider in this deployment, so a forgotten `super_admin`
 * password cannot be reset by mail. This page exists only for that case: it is
 * gated by `OWNER_RESET_SECRET`, a value the operator sets in the hosting
 * secrets, and it stops working as soon as that secret has been used once —
 * changing the secret in the hosting panel is what re-arms it.
 *
 * It never reveals whether an email exists, never returns a password, keeps the
 * audit trail, and forces the owner to sign in again afterwards.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../lib/auth';
import { MIN_PASSWORD_LENGTH, hashPassword, sha256Hex } from '../lib/auth';
import { audit, first, nowIso, randomHex, run, setSettings } from '../lib/db';

const app = new Hono<AppEnv>();

const USED_KEY = 'auth.owner_reset_secret_hash';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sameSecret = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, "Segoe UI", Tahoma, sans-serif; margin: 0; min-height: 100vh;
    display: grid; place-items: center; background: #0f172a; color: #e2e8f0; }
  main { width: min(420px, 92vw); background: #111827; border: 1px solid #1f2937;
    border-radius: 14px; padding: 26px; }
  h1 { font-size: 1.25rem; margin: 0 0 6px; }
  p { color: #94a3b8; font-size: .9rem; line-height: 1.7; margin: 0 0 18px; }
  label { display: block; font-size: .85rem; margin: 14px 0 6px; color: #cbd5f5; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #334155; background: #0b1220; color: #e2e8f0; font-size: .95rem; }
  button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px;
    background: #2563eb; color: #fff; font-size: 1rem; cursor: pointer; }
  .error { background: #451a1a; color: #fecaca; padding: 10px 12px; border-radius: 8px;
    font-size: .88rem; margin-bottom: 14px; }
  .ok { background: #10291c; color: #bbf7d0; padding: 10px 12px; border-radius: 8px;
    font-size: .88rem; margin-bottom: 14px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

const headers = (c: any) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
};

type Payload = { email?: string; secret?: string; password?: string; confirm?: string };

const readPayload = async (c: any): Promise<Payload> => {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      const body = await c.req.json();
      return body && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  }
  try {
    const form = await c.req.parseBody();
    return form as Payload;
  } catch {
    return {};
  }
};

const form = (error?: string) =>
  page(
    'استعادة حساب المالك',
    `<h1>استعادة حساب المالك</h1>
     <p>هذه الصفحة تعمل مرة واحدة بسر الاستعادة، ثم تتوقف حتى تغيّر السر من إعدادات الاستضافة.</p>
     ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
     <form method="post" action="/reset-owner">
       <label for="email">بريد المالك (اتركه فارغًا لاستخدام أول حساب مالك)</label>
       <input id="email" name="email" type="email" autocomplete="username">
       <label for="secret">سر الاستعادة (OWNER_RESET_SECRET)</label>
       <input id="secret" name="secret" type="password" autocomplete="off" required>
       <label for="password">كلمة المرور الجديدة (${MIN_PASSWORD_LENGTH} أحرف على الأقل)</label>
       <input id="password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
       <label for="confirm">تأكيد كلمة المرور</label>
       <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>
       <button type="submit">تعيين كلمة المرور</button>
     </form>`
  );

/** A recovery page that is not armed must look like it does not exist. */
const configuredSecret = (c: any) => String((c.env as any).OWNER_RESET_SECRET ?? '');

const missing = (c: any) => c.text('Not Found', 404);

app.get('/reset-owner', (c) => {
  if (!configuredSecret(c)) return missing(c);
  headers(c);
  return c.html(form());
});

app.post('/reset-owner', async (c) => {
  const secret = configuredSecret(c);
  if (!secret) return missing(c);
  headers(c);

  const body = await readPayload(c);
  const email = String(body.email ?? '').trim().toLowerCase();
  const submitted = String(body.secret ?? '');
  const password = String(body.password ?? '');
  const confirm = String(body.confirm ?? '');
  const ip = c.req.header('cf-connecting-ip') ?? null;

  if (!sameSecret(submitted, secret)) {
    await audit(c.env, {
      actorEmail: email || 'unknown',
      action: 'auth.owner_reset_failed',
      entityType: 'user',
      entityId: email || 'unknown',
      ip,
    });
    return c.html(form('السر غير صحيح.'), 403);
  }

  const usedHash = await sha256Hex(`owner-reset:${secret}`);
  const settings = await first<any>(
    c.env,
    'SELECT value FROM platform_settings WHERE key = ?',
    USED_KEY
  );
  if (settings?.value === usedHash) {
    return c.html(
      form('هذا السر استُخدم من قبل. غيّر OWNER_RESET_SECRET من إعدادات الاستضافة لتفعيل الصفحة مرة أخرى.'),
      409
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.html(form(`كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`), 422);
  }
  if (password !== confirm) {
    return c.html(form('كلمتا المرور غير متطابقتين.'), 422);
  }

  // An empty email means "the deployment's owner": useful when the operator
  // no longer remembers which address the first-run setup used. The secret is
  // the gate in both cases.
  const target = email
    ? await first<any>(
        c.env,
        `SELECT id, email FROM users WHERE lower(email) = ? AND platform_role = 'super_admin' LIMIT 1`,
        email
      )
    : await first<any>(
        c.env,
        `SELECT id, email FROM users WHERE platform_role = 'super_admin' ORDER BY created_at LIMIT 1`
      );
  if (!target) {
    // Same answer as a bad secret: the page never confirms which emails exist.
    return c.html(form('تعذّر إكمال الاستعادة بهذه البيانات.'), 403);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await run(
    c.env,
    `UPDATE users SET password_salt = ?, password_hash = ?, password_iterations = ?,
       must_change_password = 0, updated_at = ? WHERE id = ?`,
    salt,
    hash,
    100_000,
    nowIso(),
    target.id
  );
  await run(c.env, 'DELETE FROM sessions WHERE user_id = ?', target.id);
  await setSettings(c.env, { [USED_KEY]: usedHash });
  await audit(c.env, {
    actorUserId: target.id,
    actorEmail: target.email,
    action: 'auth.owner_reset',
    entityType: 'user',
    entityId: target.id,
    ip,
  });

  return c.html(
    page(
      'تم تعيين كلمة المرور',
      `<div class="ok">تم تعيين كلمة مرور جديدة لحساب المالك، وأُنهيت كل الجلسات السابقة.</div>
       <p>بريد الحساب: <strong>${escapeHtml(target.email)}</strong></p>
       <p>افتح صفحة الدخول وسجّل بهذا البريد وكلمة المرور الجديدة. غيّر <code>OWNER_RESET_SECRET</code> من إعدادات الاستضافة أو أزله، فالصفحة معطّلة بعده.</p>
       <p><a href="/login" style="color:#93c5fd">الانتقال إلى الدخول</a></p>`
    )
  );
});

export default app;
