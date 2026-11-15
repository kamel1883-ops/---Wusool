import { first } from './db';

/** Sequential human-readable invoice number, unique across the platform. */
export async function nextInvoiceNumber(env: any) {
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
