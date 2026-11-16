/**
 * Password hashing (PBKDF2/SHA-256 via Web Crypto), opaque session tokens,
 * session cookies and the request authentication middleware.
 *
 * Sessions are random 32-byte tokens stored only as a SHA-256 hash in D1,
 * so a database dump cannot be replayed as a live session. Passwords are
 * salted per user and never logged or returned by any endpoint.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from './db';
import { nowIso, first, randomHex, run } from './db';

export const SESSION_COOKIE = 'ws_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
// Cloudflare Workers caps PBKDF2 at 100,000 iterations at runtime: anything
// above it throws NotSupportedError instead of hashing (workerd enforces the
// limit before spending CPU). 100,000 is therefore the strongest setting that
// works in production; local `wrangler dev` does not enforce the cap, so a
// higher value only fails once deployed.
export const PASSWORD_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 10;

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  locale: 'ar' | 'en';
  platformRole: 'none' | 'super_admin';
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
  tokenHash: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    company?: any;
    role?: string;
    membershipId?: string;
  };
};

const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const hexToBytes = (hex: string) => {
  const clean = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hashPassword(
  password: string,
  saltHex: string,
  iterations = PASSWORD_ITERATIONS
) {
  // Clamp so a row written by an older build (or hand-edited) can still be
  // verified rather than throwing on the runtime's iteration cap.
  const rounds = Math.min(Math.max(iterations, 1), MAX_PBKDF2_ITERATIONS);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: rounds },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function verifyPassword(
  password: string,
  saltHex: string,
  expectedHash: string,
  iterations = PASSWORD_ITERATIONS
) {
  const hash = await hashPassword(password, saltHex, iterations || PASSWORD_ITERATIONS);
  return timingSafeEqual(hash, expectedHash);
}

export async function createSession(c: Context<AppEnv>, userId: string) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await run(
    c.env,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    tokenHash,
    userId,
    nowIso(),
    expiresAt,
    c.req.header('cf-connecting-ip') ?? null,
    (c.req.header('user-agent') ?? '').slice(0, 300) || null
  );
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
    secure: new URL(c.req.url).protocol === 'https:',
  });
  return tokenHash;
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await run(c.env, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function loadUserBySession(c: Context<AppEnv>): Promise<AuthUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await first<any>(
    c.env,
    `SELECT s.expires_at, u.id, u.email, u.name, u.locale, u.platform_role, u.status, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenHash
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now() || row.status !== 'active') {
    await run(c.env, 'DELETE FROM sessions WHERE token_hash = ?', tokenHash);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale === 'en' ? 'en' : 'ar',
    platformRole: row.platform_role === 'super_admin' ? 'super_admin' : 'none',
    status: 'active',
    mustChangePassword: Boolean(row.must_change_password),
    tokenHash,
  };
}

/** Routes an account with a temporary password may still call. */
const PASSWORD_EXEMPT_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/profile',
  '/api/auth/password',
  '/api/auth/logout',
]);

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUserBySession(c);
  if (!user) return c.json({ error: { code: 'unauthorized' } }, 401);
  c.set('user', user);

  // Accounts created with a one-time password cannot use the product until
  // they set their own password (enforced server-side, not only in the UI).
  if (user.mustChangePassword && !PASSWORD_EXEMPT_PATHS.has(c.req.path)) {
    return c.json({ error: { code: 'password_change_required' } }, 403);
  }

  await next();
};

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.platformRole !== 'super_admin') {
    return c.json({ error: { code: 'forbidden' } }, 403);
  }
  await next();
};

/** Company workspace context resolved from membership, never from client input. */
export const companyContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  const companyId = c.req.param('companyId');
  if (!companyId) return c.json({ error: { code: 'company_not_found' } }, 404);

  const membership = await first<any>(
    c.env,
    `SELECT id, role, status FROM memberships WHERE user_id = ? AND company_id = ?`,
    user.id,
    companyId
  );
  const company = await first<any>(c.env, 'SELECT * FROM companies WHERE id = ?', companyId);
  if (!company) return c.json({ error: { code: 'company_not_found' } }, 404);
  if (!membership || membership.status !== 'active') {
    return c.json({ error: { code: 'forbidden' } }, 403);
  }

  c.set('company', company);
  c.set('role', membership.role);
  c.set('membershipId', membership.id);
  await next();
};
