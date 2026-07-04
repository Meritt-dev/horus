import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT, PgTable, PgColumn } from 'drizzle-orm/pg-core';
import { getTableColumns, sql as drizzleSql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, openSync, writeSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { assertLocalDatabaseUrl } from './guard.js';
import { EMBEDDED_MIGRATIONS } from './migrations-bundle.js';

/**
 * Horus's Drizzle handle, typed as the common Postgres base. Horus persists ONLY to an
 * embedded, file-backed pglite database (the single local persistence tier — teams that
 * need shared state use Horus Cloud's REST API, never a self-run Postgres). Typing on the
 * base `PgDatabase` (rather than the concrete `PgliteDatabase`) keeps every
 * `.select()/.insert()/.update()/.returning()` overload intact and lets `importFromPostgres`
 * reuse the same query surface against a postgres-js source during a one-time import.
 */
export type HorusDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A closeable handle around the active database. `sql.end()` closes the embedded pglite
 * instance, so the one-shot-CLI shutdown path (`await handle.sql.end()`) stays uniform.
 */
export interface DbHandle {
  db: HorusDb;
  /** Release the underlying resources. Call once on shutdown. */
  sql: { end: () => Promise<void> };
}

/** Default location for the embedded local database (override with HORUS_DB_DIR). */
export function localDbPath(): string {
  const dir = process.env['HORUS_DB_DIR'] || join(homedir(), '.horus');
  return join(dir, 'horus.db');
}

/**
 * Stable prefix on every error thrown by the display-only fallback db (the Proxy in
 * `unavailableDbHandle`) and by the bundle asset pre-check (`assertEmbeddedAssetsPresent`).
 * Commands match on this — via `isDbUnavailable` — to degrade gracefully instead of
 * crashing when a build ships without pglite's assets. Keep it in sync with both throw
 * sites below.
 */
export const DB_UNAVAILABLE_PREFIX = 'HORUS_DB_UNAVAILABLE';

/**
 * True when an error originated from the display-only fallback db — i.e. this build ships
 * without pglite's embedded assets (the single-file GitHub download). A command that only
 * uses the db for optional enrichment (queue topology, incident memory) catches THIS to
 * skip the db-backed part and complete, rather than surfacing a hard failure. Any other
 * error is a genuine fault and must still propagate.
 */
export function isDbUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith(DB_UNAVAILABLE_PREFIX);
}

/**
 * A `DbHandle` that does no persistence. Returned when the embedded pglite database
 * cannot be opened — e.g. a packaging variant that ships the bundle WITHOUT pglite's
 * WASM/FS assets next to it (the GitHub single-file download), so `new PGlite()` fails.
 *
 * The `db` is a `Proxy` that throws `HORUS_DB_UNAVAILABLE` on ANY property access, so
 * the engine's persistence helpers (`persist` / `recallSimilar` / `storeIncidentMemory`)
 * — which already swallow DB errors — degrade to display-only rather than crashing the
 * command. `sql.end()` is a no-op so the normal one-shot shutdown path stays uniform.
 */
function unavailableDbHandle(): DbHandle {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error(
          'HORUS_DB_UNAVAILABLE: the embedded local database is not available in this build ' +
            '(pglite assets are missing). Install via npm or Homebrew for local persistence. ' +
            'Results are display-only.',
        );
      },
    },
  ) as unknown as HorusDb;
  return { db, sql: { end: async () => {} } };
}

/**
 * Open Horus's local database. This is ALWAYS the embedded, file-backed pglite database
 * (default `~/.horus/horus.db`, overridable via `HORUS_DB_DIR`) — the single local
 * persistence tier. There is no user-run Postgres runtime and `DATABASE_URL` is ignored;
 * teams that need shared state use Horus Cloud (an API mirror). A legacy `url` argument is
 * still accepted for call-site compatibility while the `database` config block is
 * deprecated, but it is never consulted.
 *
 * Wrapped in try/catch: if pglite can't initialize (its WASM/FS assets aren't shipped next
 * to the bundle), returns a no-op handle so the command degrades to display-only instead
 * of crashing. This is the single chokepoint CLI commands use so the driver is consistent.
 */
export async function openDb(_url?: string, _opts?: { max?: number }): Promise<DbHandle> {
  try {
    return await createLocalDb();
  } catch {
    return unavailableDbHandle();
  }
}

const migrationsApplied = new WeakSet<PGlite>();

/**
 * Apply the embedded migrations to a pglite instance idempotently. Tracks applied
 * migration tags in `__horus_migrations` so re-opening an existing DB is a no-op, and a
 * partially-applied DB resumes from where it left off. Statements are wrapped in IF
 * (NOT) EXISTS-style guards where drizzle doesn't emit them, by skipping any whole
 * migration tag that has already been recorded.
 */
async function applyEmbeddedMigrations(client: PGlite): Promise<void> {
  if (migrationsApplied.has(client)) return;
  await client.exec(
    `CREATE TABLE IF NOT EXISTS "__horus_migrations" (
       "tag" text PRIMARY KEY,
       "applied_at" timestamptz NOT NULL DEFAULT now()
     );`,
  );
  const doneRes = await client.query<{ tag: string }>(`SELECT tag FROM "__horus_migrations";`);
  const done = new Set(doneRes.rows.map((r) => r.tag));

  for (const migration of EMBEDDED_MIGRATIONS) {
    if (done.has(migration.tag)) continue;
    // Each migration is its own transaction: either the whole tag applies or none of it,
    // so the recorded tag always reflects a fully-applied migration.
    await client.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.exec(statement);
      }
      await tx.query(`INSERT INTO "__horus_migrations" (tag) VALUES ($1);`, [migration.tag]);
    });
  }
  migrationsApplied.add(client);
}

/**
 * Create a Drizzle client bound to the **embedded, file-backed pglite database**
 * (default `~/.horus/horus.db`, overridable via `HORUS_DB_DIR`). This activates
 * incident memory, `horus ask`, `score`, and `feedback` with zero setup.
 *
 * Migrations are embedded in the bundle and applied idempotently on first use, so the
 * file is created and brought to schema on demand. The returned `sql.end()` closes the
 * pglite instance.
 */
export async function createLocalDb(opts?: { path?: string }): Promise<DbHandle> {
  const dataDir = opts?.path ?? localDbPath();
  // pglite persists into a directory; ensure the parent exists.
  try {
    mkdirSync(dataDir.replace(/[^/]+$/, ''), { recursive: true });
  } catch {
    // best-effort; pglite will surface a clear error if the path is unusable.
  }
  // pglite loads its WASM/FS assets (pglite.wasm, pglite.data, initdb.wasm) at runtime,
  // resolved via `new URL('./<asset>', import.meta.url)` relative to the running module —
  // i.e. siblings of the bundled binary. When an asset is ABSENT (e.g. the single-file
  // download that ships only index.cjs), pglite's emscripten loader fails on a deferred
  // task and surfaces an *unhandled rejection* that escapes `await client.waitReady` —
  // crashing the process. Pre-check the assets the same way pglite resolves them so a
  // missing asset becomes a synchronous, catchable error and `openDb` can fall back to a
  // display-only handle instead of crashing.
  assertEmbeddedAssetsPresent();
  // Serialise concurrent CLI runs (single-writer file DB — gap 7): overlapping investigations
  // could otherwise race a write, lose it, and still print an `ask <id>` hint that won't resolve.
  const releaseLock = await acquireDbLock(dataDir);
  try {
    const client = new PGlite(dataDir);
    await client.waitReady;
    await applyEmbeddedMigrations(client);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      sql: {
        end: async () => {
          await client.close();
          releaseLock();
        },
      },
    };
  } catch (e) {
    releaseLock();
    throw e;
  }
}

/**
 * Tables copied by {@link importFromPostgres}, in FK-safe order (parents before children):
 * an investigation and its evidence/findings/hypotheses (the cause scores), the incident
 * and outcome-label records keyed off it, then the authored memory items and their
 * link/audit rows. Registry (`projects`/`repositories`) and derived caches
 * (`queue_edges`/`provider_cache`) are intentionally excluded — they are rebuilt locally.
 */
const IMPORT_TABLES: ReadonlyArray<{ name: string; table: PgTable }> = [
  { name: 'investigations', table: schema.investigations },
  { name: 'evidence', table: schema.evidence },
  { name: 'findings', table: schema.findings },
  { name: 'hypotheses', table: schema.hypotheses },
  { name: 'incident_memory', table: schema.incidentMemory },
  { name: 'outcome_label', table: schema.outcomeLabel },
  { name: 'memory_item', table: schema.memoryItem },
  { name: 'memory_link', table: schema.memoryLink },
  { name: 'memory_audit', table: schema.memoryAudit },
];

/** Rows inserted per batch — keeps a large export from exceeding the bind-parameter limit. */
const IMPORT_CHUNK = 500;

/**
 * Build the `SET` clause for an idempotent upsert: every non-`id` column takes the value
 * from the row being inserted (`excluded.<col>`), so re-importing the same source updates
 * changed rows in place rather than duplicating or erroring on the id primary key.
 */
function upsertSetFromExcluded(table: PgTable): Record<string, ReturnType<typeof drizzleSql>> {
  const cols = getTableColumns(table);
  const set: Record<string, ReturnType<typeof drizzleSql>> = {};
  for (const key of Object.keys(cols)) {
    if (key === 'id') continue;
    const columnName = cols[key]!.name;
    set[key] = drizzleSql`excluded.${drizzleSql.identifier(columnName)}`;
  }
  return set;
}

/** The `id` primary-key column of a table (every imported table is keyed on `id`). */
function idColumn(table: PgTable): PgColumn {
  return getTableColumns(table)['id'] as PgColumn;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * One-time import of a legacy user-run Postgres into the embedded database. Copies the
 * investigation, cause-score, incident-memory and outcome tables (see {@link IMPORT_TABLES})
 * from `sourceUrl` into `db`, upserting by primary key so it is fully idempotent (re-running
 * refreshes rather than duplicates). The source is opened READ-ONLY (only SELECTs are
 * issued) and closed before returning; `db` is the caller's already-open embedded handle.
 *
 * Returns the number of source rows processed per table. This is the migration path for a
 * team cutting over from the removed local-Postgres tier — after `horus db import` their
 * history lives in the embedded db and the old Postgres can be decommissioned.
 */
export async function importFromPostgres(
  sourceUrl: string,
  db: HorusDb,
): Promise<Record<string, number>> {
  // Guardrail (HOR-298): never open a direct connection to the Horus Cloud database — cloud
  // state is reached through the /v1 REST API, so importing from it directly is refused.
  assertLocalDatabaseUrl(sourceUrl);
  const sql = postgres(sourceUrl, { max: 1, onnotice: () => {} });
  const source = drizzlePostgres(sql, { schema });
  const counts: Record<string, number> = {};
  try {
    for (const { name, table } of IMPORT_TABLES) {
      counts[name] = 0;
      let rows: Record<string, unknown>[];
      try {
        rows = (await source.select().from(table)) as Record<string, unknown>[];
      } catch {
        // A source that predates a table (older schema) simply has nothing to copy for it.
        continue;
      }
      if (rows.length === 0) continue;
      const set = upsertSetFromExcluded(table);
      const target = idColumn(table);
      for (const batch of chunk(rows, IMPORT_CHUNK)) {
        await db.insert(table).values(batch).onConflictDoUpdate({ target, set });
      }
      counts[name] = rows.length;
    }
  } finally {
    await sql.end();
  }
  return counts;
}

/**
 * Acquire a best-effort exclusive cross-process lock on the embedded DB directory so concurrent
 * CLI runs serialise their pglite writes. Returns a release function. Resilient: a stale lock
 * left by a crashed run is reclaimed after STALE_MS, and after TIMEOUT_MS we proceed UNLOCKED
 * rather than hang — so the lock can only improve the concurrent case, never make it worse.
 */
async function acquireDbLock(dataDir: string): Promise<() => void> {
  const lockPath = `${dataDir}.lock`;
  const STALE_MS = 60_000;
  const TIMEOUT_MS = 30_000;
  const start = Date.now();
  const noop = (): void => {};
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx'); // O_CREAT | O_EXCL — throws EEXIST if already held
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already removed */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return noop; // unusable path — proceed unlocked
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
          unlinkSync(lockPath); // reclaim a stale lock from a crashed run
          continue;
        }
      } catch {
        continue; // lock vanished between checks — retry immediately
      }
      if (Date.now() - start > TIMEOUT_MS) return noop; // give up waiting — better than hanging
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** pglite's runtime assets, resolved relative to this module exactly as pglite does. */
const EMBEDDED_PGLITE_ASSETS = ['pglite.wasm', 'pglite.data', 'initdb.wasm'] as const;

/**
 * `true` only in the packaged single-file CLI bundle (tsup injects it via `define`);
 * `undefined` when running from unbundled source or tests.
 */
declare const __HORUS_BUNDLED__: boolean | undefined;

/**
 * Throw a clear, catchable error if pglite's runtime assets are missing — but ONLY in the
 * packaged bundle, where it matters.
 *
 * pglite resolves its assets via `new URL('./asset', import.meta.url)` relative to ITS OWN
 * module. Unbundled (dev/tests) pglite is a separate node_modules package that loads the
 * assets adjacent in its own dist (always present) — nothing to verify, and a check
 * resolved against THIS module's source dir would be wrong. In the bundle pglite is inlined
 * alongside this code, so both share the bundle's `import.meta.url` and pglite loads the
 * assets as siblings of `index.cjs` — exactly where we check. If they're absent (the
 * single-file download that ships only index.cjs), we fail fast and catchably here so
 * `openDb` degrades to display-only instead of letting pglite crash the process.
 */
function assertEmbeddedAssetsPresent(): void {
  if (typeof __HORUS_BUNDLED__ === 'undefined' || !__HORUS_BUNDLED__) return;
  const selfDir = dirname(fileURLToPath(import.meta.url));
  for (const asset of EMBEDDED_PGLITE_ASSETS) {
    if (!existsSync(join(selfDir, asset))) {
      throw new Error(
        `HORUS_DB_UNAVAILABLE: embedded database asset missing (${asset}). This build does ` +
          `not ship local persistence — install via npm or Homebrew.`,
      );
    }
  }
}
