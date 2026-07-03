import pc from 'picocolors';
import {
  HORUS_VERSION,
  findRepoRoot,
  discoverLocalConfig,
  readLocalConfig,
  loadConfig,
  isHorusGitignored,
  findPlaintextConnectorSecrets,
  type ConnectorsConfig,
} from '@horus/core';
import { checkDatabase, type DbHealth } from '@horus/db';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  next?: string;
}

// ---------------------------------------------------------------------------
// Connector readiness registry (HOR-437)
//
// One descriptor per connector kind, keyed by the SAME connector keys the engine
// resolves and the factory (`@horus/connectors`) instantiates — `keyof ConnectorsConfig`.
// The mapped `ConnectorRegistry` type forces an entry for EVERY connector key, so
// adding a new connector to the config schema is a COMPILE ERROR here until its
// readiness check is added. A connector can never again be silently omitted from
// `horus doctor` — which was the original bug: Axiom (HOR-429) was wired into the
// config schema + factory but never added to doctor's hardcoded check list.
// ---------------------------------------------------------------------------

type ConnectorReadinessCheck<K extends keyof ConnectorsConfig> = (
  cfg: NonNullable<ConnectorsConfig[K]>,
  ctx: string,
) => DoctorCheck;

type ConnectorRegistry = {
  [K in keyof Required<ConnectorsConfig>]: {
    /** Display label shown in the readiness output. */
    label: string;
    /** Next-step hint when this connector is absent from every environment. */
    absentNext: string;
    /** Build the readiness check for a configured (non-null) connector in one env. */
    check: ConnectorReadinessCheck<K>;
  };
};

const CONNECTOR_CHECKS: ConnectorRegistry = {
  // Elasticsearch (runtime logs)
  elasticsearch: {
    label: 'Elasticsearch',
    absentNext:
      'add connectors.elasticsearch to an environment in your Horus config for runtime log evidence',
    check: (es, ctx) =>
      !es.indexPattern
        ? {
            label: 'Elasticsearch',
            status: 'warn',
            detail: `${ctx} — indexPattern not set`,
            next: 'set indexPattern in connectors.elasticsearch',
          }
        : {
            label: 'Elasticsearch',
            status: 'pass',
            detail: `${ctx} — ${es.indexPattern} [runtime ingestion pending]`,
          },
  },
  // Grafana (metrics)
  grafana: {
    label: 'Grafana',
    absentNext: 'add connectors.grafana to an environment for metric evidence',
    check: (g, ctx) =>
      !g.url
        ? {
            label: 'Grafana',
            status: 'warn',
            detail: `${ctx} — URL not set`,
            next: 'set grafana.url or grafana.urlEnv in your Horus config',
          }
        : {
            label: 'Grafana',
            status: 'pass',
            detail: `${ctx} — URL configured${g.dashboard ? ` (${g.dashboard})` : ''} [runtime ingestion pending]`,
          },
  },
  // MongoDB (state)
  mongodb: {
    label: 'MongoDB',
    absentNext: 'add connectors.mongodb to an environment for database state evidence',
    check: (m, ctx) =>
      !m.url
        ? {
            label: 'MongoDB',
            status: 'warn',
            detail: `${ctx} — URL not set`,
            next: 'set mongodb.url or mongodb.urlEnv in your Horus config',
          }
        : {
            label: 'MongoDB',
            status: 'pass',
            detail: `${ctx} — ${m.database} [runtime ingestion pending]`,
          },
  },
  // Postgres (state)
  postgres: {
    label: 'Postgres',
    absentNext: 'add connectors.postgres to an environment for database state evidence',
    check: (p, ctx) =>
      !p.url
        ? {
            label: 'Postgres',
            status: 'warn',
            detail: `${ctx} — URL not set`,
            next: 'set postgres.url or postgres.urlEnv in your Horus config',
          }
        : {
            label: 'Postgres',
            status: 'pass',
            detail: `${ctx} — ${p.database ?? p.schema ?? 'postgres'} [runtime ingestion pending]`,
          },
  },
  // Sentry (error tracking)
  sentry: {
    label: 'Sentry',
    absentNext: 'add connectors.sentry to an environment for error-tracking evidence',
    check: (s, ctx) => {
      const tokenSet = s.authToken || process.env[s.authTokenEnv ?? 'SENTRY_AUTH_TOKEN'];
      return !tokenSet
        ? {
            label: 'Sentry',
            status: 'warn',
            detail: `${ctx} — auth token not set`,
            next: 'set sentry.authToken or sentry.authTokenEnv (default SENTRY_AUTH_TOKEN) in your Horus config',
          }
        : {
            label: 'Sentry',
            status: 'pass',
            detail: `${ctx} — ${s.org}/${s.project} [runtime ingestion pending]`,
          };
    },
  },
  // Axiom (structured logs) — HOR-437: previously omitted from doctor entirely.
  axiom: {
    label: 'Axiom',
    absentNext: 'add connectors.axiom to an environment for structured log evidence',
    check: (a, ctx) => {
      const tokenSet = a.token || process.env[a.tokenEnv ?? 'AXIOM_TOKEN'];
      return !tokenSet
        ? {
            label: 'Axiom',
            status: 'warn',
            detail: `${ctx} — API token not set`,
            next: 'set axiom.token or axiom.tokenEnv (default AXIOM_TOKEN) in your Horus config',
          }
        : {
            label: 'Axiom',
            status: 'pass',
            detail: `${ctx} — ${a.dataset} [runtime ingestion pending]`,
          };
    },
  },
  // Shopify (Admin GraphQL — application state evidence)
  shopify: {
    label: 'Shopify',
    absentNext: 'add connectors.shopify to an environment for Shopify Admin state evidence',
    check: (s, ctx) => {
      const secretSet = s.secret || process.env[s.secretEnv ?? 'SHOPIFY_SECRET'];
      if (!secretSet) {
        return {
          label: 'Shopify',
          status: 'warn',
          detail: `${ctx} — client secret not set`,
          next: 'set shopify.secret or shopify.secretEnv (default SHOPIFY_SECRET), or run horus connect shopify',
        };
      }
      const queryCount = s.queries?.length ?? 0;
      const queryNote =
        queryCount > 0
          ? ` (${queryCount} default quer${queryCount === 1 ? 'y' : 'ies'})`
          : ' (no default queries — supply --shopify-query at investigate time)';
      return {
        label: 'Shopify',
        status: 'pass',
        detail: `${ctx} — ${s.store}${queryNote} [runtime ingestion pending]`,
      };
    },
  },
  // Redis / BullMQ (queue + cache/state)
  redis: {
    label: 'Redis',
    absentNext: 'add connectors.redis to an environment for queue state evidence',
    check: (r, ctx) =>
      !r.url
        ? {
            label: 'Redis',
            status: 'warn',
            detail: `${ctx} — URL not set`,
            next: 'set redis.url or redis.urlEnv in your Horus config',
          }
        : {
            label: 'Redis',
            status: 'pass',
            detail: `${ctx} — URL configured [runtime ingestion pending]`,
          },
  },
};

/** All connector keys covered by the doctor readiness registry. Exported for tests. */
export const DOCTOR_CONNECTOR_KEYS = Object.keys(CONNECTOR_CHECKS) as (keyof ConnectorsConfig)[];

export { CONNECTOR_CHECKS };

export interface DoctorOutput {
  version: string;
  /** True when no check has status 'fail'. Warn-level issues are advisory, not blocking. */
  ready: boolean;
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
}

function mark(status: CheckStatus): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'warn') return pc.yellow('~');
  return pc.red('✗');
}

export async function runDoctor(opts?: {
  cwd?: string;
  config?: string;
  json?: boolean;
  write?: (line: string) => void;
  /** Injectable for tests — defaults to the real checkDatabase. */
  _dbCheck?: (url: string) => Promise<DbHealth>;
}): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd();
  const write = opts?.write ?? ((line: string) => console.log(line));
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'CLI version',
    status: 'pass',
    detail: `horus ${HORUS_VERSION}`,
  });

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    checks.push({ label: 'Git root', status: 'pass', detail: repoRoot });
  } else {
    checks.push({
      label: 'Git root',
      status: 'warn',
      detail: 'not in a git repository',
      next: 'run horus doctor from inside a git repository',
    });
  }

  const configPath = discoverLocalConfig(cwd);
  if (configPath) {
    checks.push({ label: 'Local config', status: 'pass', detail: configPath });

    try {
      const file = readLocalConfig(configPath);
      const project = file.project as Record<string, unknown>;
      const repos = project['repositories'] as Array<Record<string, unknown>> | undefined;
      const hostUrl = repos?.map(
        (r) =>
          (r['source'] as Record<string, unknown> | undefined)?.['hostUrl'] as string | undefined,
      ).find(Boolean);
      if (hostUrl) {
        checks.push({ label: 'Source-intelligence host', status: 'pass', detail: hostUrl });
      } else {
        checks.push({
          label: 'Source-intelligence host',
          status: 'warn',
          detail: 'not configured',
          next: 'run `horus init` to analyze this repo and start a host',
        });
      }
    } catch {
      checks.push({
        label: 'Source-intelligence host',
        status: 'warn',
        detail: 'could not read local config',
        next: 'run `horus init` to recreate .horus/config.json for this repo',
      });
    }
  } else {
    checks.push({
      label: 'Local config',
      status: 'warn',
      detail: '.horus/config.json not found',
      next: 'run `horus init` to create one for this repo',
    });
    checks.push({
      label: 'Source-intelligence host',
      status: 'warn',
      detail: 'not configured (no local config)',
      next: 'run `horus init` to set up source intelligence',
    });
  }

  // Secrets hygiene (HOR-452): `.horus/` must be gitignored, and config.json must
  // not carry plaintext connector credentials.
  {
    if (repoRoot && !isHorusGitignored(repoRoot)) {
      checks.push({
        label: 'Secrets gitignore',
        status: 'warn',
        detail: '.horus/ is NOT gitignored — credentials could be committed',
        next: 'run `horus secrets migrate` (also hardens .gitignore), or add `.horus/` to .gitignore',
      });
    } else if (repoRoot) {
      checks.push({ label: 'Secrets gitignore', status: 'pass', detail: '.horus/ is gitignored' });
    }
    if (configPath) {
      try {
        const plaintext = findPlaintextConnectorSecrets(readLocalConfig(configPath).project);
        if (plaintext.length > 0) {
          checks.push({
            label: 'Secret storage',
            status: 'warn',
            detail: `${plaintext.length} plaintext credential(s) in config.json: ${plaintext.join(', ')}`,
            next: 'run `horus secrets migrate` to encrypt them and strip config.json',
          });
        } else {
          checks.push({
            label: 'Secret storage',
            status: 'pass',
            detail: 'no plaintext credentials in config.json',
          });
        }
      } catch {
        /* config unreadable — already flagged by the Local config check above */
      }
    }
  }

  // Database check — probe Postgres for reachability and schema readiness.
  {
    const dbChecker = opts?._dbCheck ?? checkDatabase;
    let dbUrl = process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
    let globalConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      globalConfig = await loadConfig(opts?.config, { cwd });
      dbUrl = globalConfig.database.url;
    } catch {
      // No global config — use env var or default URL
    }

    const db = await dbChecker(dbUrl);
    if (!db.reachable) {
      checks.push({
        label: 'Database',
        status: 'warn',
        detail: 'Postgres not reachable',
        next:
          'start a local instance:\n' +
          '      docker run -d --name horus-db \\\n' +
          '        -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n' +
          '        -p 5433:5432 postgres:16\n' +
          '    or set DATABASE_URL to an existing Postgres 16 instance',
      });
    } else if (!db.schemaReady) {
      checks.push({
        label: 'Database',
        status: 'warn',
        detail: 'connected but schema not applied',
        next: 'run migrations: pnpm db migrate',
      });
    } else {
      checks.push({
        label: 'Database',
        status: 'pass',
        detail: db.schemaDetail,
      });
    }
  }

  // Runtime connector checks — driven off the connector registry (HOR-437), the same
  // connector key set the engine resolves and the factory instantiates. Every
  // configured connector in every environment gets a readiness line; any connector
  // never configured gets a single "not configured" hint. New connectors are covered
  // automatically (the registry is exhaustive over `keyof ConnectorsConfig`).
  try {
    const globalConfig = await loadConfig(opts?.config, { cwd });
    const configured = new Set<keyof ConnectorsConfig>();

    for (const project of globalConfig.projects) {
      for (const env of project.environments) {
        const ctx = `${project.name}/${env.name}`;
        const c = env.connectors;
        for (const key of DOCTOR_CONNECTOR_KEYS) {
          const cfg = c[key];
          if (cfg === undefined) continue;
          configured.add(key);
          // The mapped registry type guarantees key/cfg correlation; the cast just
          // bridges the per-key generic across the dynamic key loop.
          const run = CONNECTOR_CHECKS[key].check as (cfg: unknown, ctx: string) => DoctorCheck;
          checks.push(run(cfg, ctx));
        }
      }
    }

    for (const key of DOCTOR_CONNECTOR_KEYS) {
      if (configured.has(key)) continue;
      const desc = CONNECTOR_CHECKS[key];
      checks.push({
        label: desc.label,
        status: 'warn',
        detail: 'not configured',
        next: desc.absentNext,
      });
    }
  } catch {
    // No global config loadable — skip connector checks silently.
  }

  const hasFailure = checks.some((c) => c.status === 'fail');

  if (opts?.json) {
    const summary = {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    };
    const output: DoctorOutput = {
      version: HORUS_VERSION,
      ready: !hasFailure,
      checks,
      summary,
    };
    write(JSON.stringify(output, null, 2));
    return hasFailure ? 1 : 0;
  }

  write(pc.bold('\nHorus readiness check\n'));
  for (const check of checks) {
    write(`  ${mark(check.status)} ${pc.bold(check.label.padEnd(26))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`    ${pc.dim('→ ' + check.next)}`);
    }
  }
  write('');
  write(pc.dim('  Hit a bug or a missing capability? Report it:  horus report'));
  write('');

  return hasFailure ? 1 : 0;
}
