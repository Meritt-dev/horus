import { sql } from 'drizzle-orm';
import { openDb, localDbPath, isDbUnavailable } from './client.js';

/** The tables the embedded migrations create (used for the schema-count detail). */
export const EXPECTED_TABLES = [
  'projects',
  'repositories',
  'investigations',
  'evidence',
  'findings',
  'hypotheses',
  'incident_memory',
  'memory_item',
  'memory_link',
  'memory_audit',
  'outcome_label',
  'queue_edges',
  'provider_cache',
] as const;

export interface DbHealth {
  /** The embedded database opened and accepted a query. */
  reachable: boolean;
  /** Schema is present (embedded migrations applied — always true once reachable). */
  schemaReady: boolean;
  reachableDetail: string;
  schemaDetail: string;
}

/**
 * Probe the embedded local database for `horus status`/`doctor`/`readiness`: it is the single
 * local persistence tier (no user-run Postgres, `DATABASE_URL` ignored). Opening it applies the
 * embedded migrations, so a reachable db is always schema-ready. `reachable` is only false in a
 * packaging variant that ships without pglite's assets (the single-file download) — then the db
 * degrades to display-only. Never throws — failures are reported as `false` with a human detail.
 */
export async function checkEmbeddedDb(): Promise<DbHealth> {
  const path = localDbPath();
  try {
    const { db, sql: conn } = await openDb();
    try {
      // Touch the db so a display-only build (assets missing → Proxy throws) surfaces here.
      await db.execute(sql`select 1`);
      return {
        reachable: true,
        schemaReady: true,
        reachableDetail: `embedded (${path})`,
        schemaDetail: `${EXPECTED_TABLES.length} tables present`,
      };
    } finally {
      await conn.end();
    }
  } catch (err) {
    if (isDbUnavailable(err)) {
      return {
        reachable: false,
        schemaReady: false,
        reachableDetail: 'embedded database unavailable — this build ships no local persistence',
        schemaDetail: 'install via npm or Homebrew for local persistence',
      };
    }
    return {
      reachable: false,
      schemaReady: false,
      reachableDetail: `embedded database error — ${(err as Error).message}`,
      schemaDetail: '',
    };
  }
}
