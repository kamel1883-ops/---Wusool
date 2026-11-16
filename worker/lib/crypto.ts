/**
 * Server-side encryption for provider tokens.
 *
 * Tokens are sealed with AES-256-GCM using a key that exists only in the
 * Worker environment (`SOCIAL_TOKEN_KEY`, 32 bytes base64). A database dump
 * therefore contains ciphertext, not usable credentials. The sealed string is
 * self-describing (`v1:<iv>:<cipher>`) so the key can be rotated later by
 * adding v2 without guessing what an old value was.
 *
 * Nothing in this module ever returns plaintext to a caller that can reach an
 * HTTP response; routes only use `open()` immediately before calling a
 * provider, and never serialise the result.
 */

const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

let cachedKey: { raw: string; key: CryptoKey } | null = null;

async function keyFrom(env: { SOCIAL_TOKEN_KEY?: string }): Promise<CryptoKey> {
  const raw = String(env.SOCIAL_TOKEN_KEY ?? '').trim();
  if (!raw) throw new Error('token_key_not_configured');
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new Error('token_key_invalid');
  }
  if (bytes.length !== 32) throw new Error('token_key_invalid');
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  cachedKey = { raw, key };
  return key;
}

/** True when token storage is usable; routes surface this as a setup state. */
export const tokenKeyConfigured = (env: { SOCIAL_TOKEN_KEY?: string }) =>
  String(env.SOCIAL_TOKEN_KEY ?? '').trim().length > 0;

export async function seal(
  env: { SOCIAL_TOKEN_KEY?: string },
  plaintext: string
): Promise<string> {
  const key = await keyFrom(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

export async function open(
  env: { SOCIAL_TOKEN_KEY?: string },
  sealed: string
): Promise<string> {
  const [version, ivPart, cipherPart] = String(sealed ?? '').split(':');
  if (version !== 'v1' || !ivPart || !cipherPart) throw new Error('token_cipher_invalid');
  const key = await keyFrom(env);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivPart) },
    key,
    fromBase64(cipherPart)
  );
  return new TextDecoder().decode(plain);
}

/** Only for mistakes in logs: never echo a token, only its shape. */
export const maskToken = (value: string | null | undefined) => {
  const text = String(value ?? '');
  if (!text) return null;
  if (text.length <= 6) return '••••';
  return `${text.slice(0, 2)}••••${text.slice(-2)}`;
};
