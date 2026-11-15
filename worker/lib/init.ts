/**
 * One-shot schema bootstrap for hosted databases.
 * POST /api/setup/init applies every bundled migration idempotently
 * (IF NOT EXISTS / OR IGNORE / seed UPDATEs). Statements that fail only
 * because they were already applied (e.g. ADD COLUMN on a migrated DB)
 * are skipped; any other error aborts the run.
 */
import { SCHEMA_STATEMENTS } from './schema';
import type { Env } from './db';

const ALREADY_APPLIED = /already exists|duplicate column name/i;

export async function ensureSchema(env: Env): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const sql of SCHEMA_STATEMENTS) {
    try {
      await env.DB.prepare(sql).run();
      applied += 1;
    } catch (error) {
      if (error instanceof Error && ALREADY_APPLIED.test(error.message)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { applied, skipped };
}
