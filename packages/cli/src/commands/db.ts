/**
 * `horus db import` — one-time cutover from a legacy user-run Postgres into the embedded
 * local database (pglite). Horus no longer runs a local Postgres tier: local persistence is
 * always embedded and DATABASE_URL is ignored at runtime. This command is the ONLY consumer
 * of a Postgres URL left in the CLI — it copies a team's existing investigation history,
 * cause scores, incident memory and outcome labels forward so the old Postgres can be
 * decommissioned. Teams that need shared state going forward use Horus Cloud.
 *
 * `--from` defaults to $DATABASE_URL when set, so a user whose old setup exported
 * DATABASE_URL cuts over with a bare `horus db import`.
 */

import pc from 'picocolors';
import { openDb, importFromPostgres, localDbPath, CloudDatabaseUrlError } from '@horus/db';

export interface DbImportOptions {
  /** Source Postgres URL. Defaults to $DATABASE_URL when omitted. */
  from?: string;
}

/** Mask any credentials in a Postgres URL before printing it. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***'; // keep the user, hide only the secret
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//***@');
  }
}

export async function runDbImport(opts: DbImportOptions): Promise<number> {
  const from = opts.from ?? process.env['DATABASE_URL'];
  if (!from || from.trim() === '') {
    console.error(
      pc.red('No source database to import from.') +
        pc.dim('  Pass --from <postgres-url> (or set DATABASE_URL).'),
    );
    return 1;
  }

  const { db, sql } = await openDb();
  try {
    console.log(
      pc.dim(`Importing from ${redactUrl(from)} into the embedded database (${localDbPath()})…`),
    );
    const counts = await importFromPostgres(from, db);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [table, n] of Object.entries(counts)) {
      console.log(`  ${pc.bold(String(n).padStart(6))}  ${table}`);
    }
    console.log(
      pc.green(`✓ Imported ${total} row(s) from Postgres into the embedded database.`),
    );
    if (total === 0) {
      console.log(pc.dim('  (nothing to copy — the source had no investigation/memory rows)'));
    }
    return 0;
  } catch (err) {
    if (err instanceof CloudDatabaseUrlError) {
      console.error(pc.red(err.message));
      return 1;
    }
    // Connection/read failures (unreachable host, bad credentials, missing db) exit non-zero.
    console.error(pc.red(`Import failed: ${(err as Error).message}`));
    return 1;
  } finally {
    await sql.end();
  }
}
