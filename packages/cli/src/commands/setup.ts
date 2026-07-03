/**
 * Prerequisite checks for `horus init` (HOR-37, HOR-84): the Horus
 * source-intelligence backend and the Horus Postgres. Advisory only — the
 * checks print status lines and guide fixes, but never gate init's exit code
 * (config write and indexing degrade gracefully instead).
 *
 * The old standalone `horus setup` command was merged into `horus init`; its
 * registration is now a hidden deprecation stub.
 */

import pc from 'picocolors';
import { loadConfig, PINNED_SOURCE_VERSION, SOURCE_PIN_ENFORCED } from '@horus/core';
import { getSourceVersion } from '@horus/connectors';
import { checkDatabase } from '@horus/db';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

export interface PrereqStatus {
  /** horus-source binary responded with a version. */
  backendPresent: boolean;
  /** Version matches the pin (false when absent or drifted). */
  backendVersionOk: boolean;
  dbReachable: boolean;
  schemaReady: boolean;
}

export async function checkPrerequisites(
  opts: { config?: string; write?: (line: string) => void } = {},
): Promise<PrereqStatus> {
  const write = opts.write ?? ((line: string) => console.log(line));
  const status: PrereqStatus = {
    backendPresent: false,
    backendVersionOk: false,
    dbReachable: false,
    schemaReady: false,
  };

  // 1. Source-intelligence backend — presence and version.
  let backendVersion: string | null = null;
  try {
    backendVersion = await getSourceVersion();
  } catch {
    // Probe failure reads as "not found" — advisory either way.
  }
  if (backendVersion === null) {
    write(`  ${pc.red('●')} Horus source-intelligence backend not found`);
    write(
      pc.dim(
        `      install it (Python 3.11+ required):\n` +
        `        curl -fsSL https://horus.sh/install.sh | bash\n` +
        `      ensure ~/.local/bin is on your PATH`,
      ),
    );
  } else if (SOURCE_PIN_ENFORCED && backendVersion !== PINNED_SOURCE_VERSION) {
    status.backendPresent = true;
    write(
      `  ${pc.yellow('●')} Horus source-intelligence backend version mismatch` +
      pc.dim(` (installed: ${backendVersion}, required: ${PINNED_SOURCE_VERSION})`),
    );
    write(
      pc.dim(
        `      update it:\n` +
        `        horus update`,
      ),
    );
  } else {
    status.backendPresent = true;
    status.backendVersionOk = true;
    write(
      `  ${pc.green('●')} Horus source-intelligence backend ` +
      pc.dim(`(${backendVersion})`),
    );
  }

  // 2. Horus's own Postgres.
  let dbUrl = process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  try {
    const config = await loadConfig(opts.config);
    dbUrl = config.database.url;
  } catch {
    // No config resolvable — fall back to the default DB URL.
  }
  let db: { reachable: boolean; schemaReady: boolean; schemaDetail: string };
  try {
    db = await checkDatabase(dbUrl);
  } catch {
    db = { reachable: false, schemaReady: false, schemaDetail: '' };
  }
  if (db.reachable) {
    status.dbReachable = true;
    status.schemaReady = db.schemaReady;
    write(`  ${pc.green('●')} Postgres reachable ${pc.dim(`(${db.schemaDetail})`)}`);
    if (!db.schemaReady) {
      write(
        pc.dim(
          `      schema not applied — run migrations:\n` +
          `        from the Horus repo: pnpm db migrate\n` +
          `        or apply the schema directly: https://github.com/meritt-dev/horus/tree/master/packages/db/drizzle`,
        ),
      );
    }
  } else {
    write(`  ${pc.red('●')} Postgres unreachable ${pc.dim('(needed for `horus investigate`, not for init)')}`);
    write(
      pc.dim(
        `      start a local instance:\n` +
        `        docker run -d --name horus-db \\\n` +
        `          -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n` +
        `          -p 5433:5432 postgres:16\n` +
        `      or set DATABASE_URL to an existing Postgres 16 instance`,
      ),
    );
  }

  return status;
}
