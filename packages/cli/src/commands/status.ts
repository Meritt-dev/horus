import pc from 'picocolors';
import {
  HORUS_VERSION,
  PINNED_SOURCE_VERSION,
  loadConfig,
  listEnvironments,
  resolveEnvironment,
  type HorusConfig,
  type ResolvedEnvironment,
} from '@horus/core';
import {
  SourceHttpClient,
  checkSourceCompatibility,
  codeForEnv,
  logsForEnv,
  metricsForEnv,
  mongoForEnv,
  postgresForEnv,
  sentryForEnv,
  axiomForEnv,
  shopifyForEnv,
  redisServerStatus,
  type StateProvider,
  type SentryProvider,
  type AxiomProvider,
  type ShopifyProvider,
  type RedisServerStatus,
} from '@horus/connectors';
import { checkEmbeddedDb } from '@horus/db';

interface Check {
  label: string;
  ok: boolean | 'pending';
  detail: string;
  /** A failed `fatal` check sets a non-zero exit code; non-fatal failures are warnings. */
  fatal?: boolean;
}

/** One structured connector check for `--json` — small, stable, agent-facing. */
interface EnvCheckJSON {
  name: string;
  /** Repository name, only on per-repo checks (source). */
  repo?: string;
  state: 'ok' | 'fail' | 'pending';
  detail: string;
  /** Per-logical-DB breakdown, only on the redis check. */
  databases?: Array<{
    db: number;
    name?: string;
    roles: string[];
    reachable: boolean;
    queueCount?: number;
    keyCount?: number;
  }>;
}

function mark(ok: boolean | 'pending'): string {
  if (ok === 'pending') return pc.yellow('○');
  return ok ? pc.green('●') : pc.red('●');
}

function toState(ok: boolean | 'pending'): 'ok' | 'fail' | 'pending' {
  if (ok === 'pending') return 'pending';
  return ok ? 'ok' : 'fail';
}

/**
 * Print health status for one resolved environment (or, in `--json` mode, collect
 * structured checks into `collect` and print nothing). Returns true when healthy.
 */
async function checkEnv(
  renv: ResolvedEnvironment,
  deps?: {
    mongoFactory?: (renv: ResolvedEnvironment) => StateProvider | null;
    postgresFactory?: (renv: ResolvedEnvironment) => StateProvider | null;
    sentryFactory?: (renv: ResolvedEnvironment) => SentryProvider | null;
    axiomFactory?: (renv: ResolvedEnvironment) => AxiomProvider | null;
    shopifyFactory?: (renv: ResolvedEnvironment) => ShopifyProvider | null;
    redisStatus?: (renv: ResolvedEnvironment) => Promise<RedisServerStatus | null>;
  },
  collect?: EnvCheckJSON[],
): Promise<boolean> {
  // stdout must stay VALID JSON under --json: human lines are suppressed, the
  // same probe results land in `collect` instead.
  const log = (line: string): void => {
    if (collect === undefined) console.log(line);
  };
  const record = (c: EnvCheckJSON): void => {
    collect?.push(c);
  };

  const header =
    `  ${pc.bold(renv.project)} / ${pc.bold(renv.env)}` +
    (renv.readOnly ? pc.dim('  (read-only)') : '');
  log(header);

  let allOk = true;

  // Source intelligence — code intelligence, belongs to the project's repositories.
  if (renv.repositories.length === 0) {
    log(
      `    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim('no repositories configured')}`,
    );
    record({ name: 'source', state: 'pending', detail: 'no repositories configured' });
  }
  for (const repo of renv.repositories) {
    const sourceHostUrl = repo.sourceHostUrl;
    if (!sourceHostUrl) {
      log(
        `    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim(`${repo.name}: not configured`)}`,
      );
      record({ name: 'source', repo: repo.name, state: 'pending', detail: 'not configured' });
      continue;
    }
    const source = new SourceHttpClient({ baseUrl: sourceHostUrl });
    const [health, compat] = await Promise.all([
      source.health(),
      checkSourceCompatibility(source),
    ]);

    let versionPart: string;
    if (compat.version === null) {
      versionPart = 'version unknown';
    } else if (compat.matches) {
      versionPart = `v${compat.version} (pinned ✓)`;
    } else {
      versionPart = `v${compat.version} (pinned ${compat.pinned} — MISMATCH)`;
    }

    const sourceDetail = health.ok
      ? `${repo.name} · responded ${health.status} · ${versionPart} at ${sourceHostUrl}`
      : `${repo.name} · unreachable at ${sourceHostUrl}`;
    log(
      `    ${mark(health.ok)} ${pc.bold('Source')}          ${pc.dim(sourceDetail)}`,
    );
    record({ name: 'source', repo: repo.name, state: toState(health.ok), detail: sourceDetail });
    if (!health.ok) allOk = false;
  }

  // Elasticsearch
  const esCfg = renv.connectors.elasticsearch;
  if (esCfg) {
    const logsProvider = logsForEnv(renv);
    if (logsProvider) {
      const h = await logsProvider.health();
      const idxDisplay = esCfg.indexPatterns
        ? esCfg.indexPatterns.join(', ')
        : esCfg.indexPattern;
      const detail = h.ok
        ? `reachable · index ${idxDisplay}`
        : `unreachable · index ${idxDisplay}`;
      log(`    ${mark(h.ok)} ${pc.bold('Elasticsearch')}   ${pc.dim(detail)}`);
      record({ name: 'elasticsearch', state: toState(h.ok), detail });
      if (!h.ok) allOk = false;
    } else {
      const idxDisplay = esCfg.indexPatterns
        ? esCfg.indexPatterns.join(', ')
        : esCfg.indexPattern;
      const detail = `configured (index ${idxDisplay}) but ES_URL not set`;
      log(
        `    ${mark(false)} ${pc.bold('Elasticsearch')}   ${pc.dim(detail)}`,
      );
      record({ name: 'elasticsearch', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Elasticsearch')}   ${pc.dim('not configured')}`,
    );
    record({ name: 'elasticsearch', state: 'pending', detail: 'not configured' });
  }

  // Grafana
  const grafanaCfg = renv.connectors.grafana;
  if (grafanaCfg) {
    const metricsProvider = metricsForEnv(renv);
    if (metricsProvider) {
      const h = await metricsProvider.health();
      const dashDisplay = grafanaCfg.dashboards
        ? grafanaCfg.dashboards.join(', ')
        : grafanaCfg.dashboard;
      const dashSuffix = dashDisplay ? ` · dashboards: ${dashDisplay}` : '';
      const detail = h.ok ? `reachable${dashSuffix}` : `unreachable${dashSuffix}`;
      log(`    ${mark(h.ok)} ${pc.bold('Grafana')}         ${pc.dim(detail)}`);
      record({ name: 'grafana', state: toState(h.ok), detail });
      if (!h.ok) allOk = false;
    } else {
      const detail = 'configured but GRAFANA_URL not set';
      log(
        `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim(detail)}`,
      );
      record({ name: 'grafana', state: 'pending', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim('not configured')}`,
    );
    record({ name: 'grafana', state: 'pending', detail: 'not configured' });
  }

  // MongoDB
  const mongoCfg = renv.connectors.mongodb;
  if (mongoCfg) {
    const mongo = (deps?.mongoFactory ?? mongoForEnv)(renv);
    if (mongo) {
      try {
        const h = await mongo.health();
        if (!h.ok) {
          const detail = `unreachable · db ${mongoCfg.database}`;
          log(
            `    ${mark(false)} ${pc.bold('MongoDB')}        ${pc.dim(detail)}`,
          );
          record({ name: 'mongodb', state: 'fail', detail });
          allOk = false;
        } else {
          const allowlist = mongoCfg.collections;
          const allowlistPart =
            allowlist.length === 0 ? 'allowlist: all' : `allowlist: ${allowlist.length}`;
          const discovered = mongo.listCollections
            ? await mongo.listCollections()
            : undefined;
          const discoveredPart = discovered
            ? ` · discovered: ${discovered.length} collection(s)`
            : '';
          const detail = `reachable · db ${mongoCfg.database} · ${allowlistPart}${discoveredPart}`;
          log(
            `    ${mark(true)} ${pc.bold('MongoDB')}         ${pc.dim(detail)}`,
          );
          record({ name: 'mongodb', state: 'ok', detail });
        }
      } finally {
        await mongo.close();
      }
    } else {
      const detail = `configured (db ${mongoCfg.database}) but Mongo URL not set`;
      log(
        `    ${mark(false)} ${pc.bold('MongoDB')}        ${pc.dim(detail)}`,
      );
      record({ name: 'mongodb', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('MongoDB')}         ${pc.dim('not configured')}`,
    );
    record({ name: 'mongodb', state: 'pending', detail: 'not configured' });
  }

  // Postgres (state)
  const postgresCfg = renv.connectors.postgres;
  if (postgresCfg) {
    const dbName = postgresCfg.database ?? postgresCfg.schema ?? 'postgres';
    const pg = (deps?.postgresFactory ?? postgresForEnv)(renv);
    if (pg) {
      try {
        const h = await pg.health();
        if (!h.ok) {
          const detail = `unreachable · db ${dbName}`;
          log(
            `    ${mark(false)} ${pc.bold('Postgres')}       ${pc.dim(detail)}`,
          );
          record({ name: 'postgres', state: 'fail', detail });
          allOk = false;
        } else {
          const allowlist = postgresCfg.tables;
          const allowlistPart =
            allowlist.length === 0 ? 'allowlist: all' : `allowlist: ${allowlist.length}`;
          const discovered = pg.listCollections
            ? await pg.listCollections()
            : undefined;
          const discoveredPart = discovered
            ? ` · discovered: ${discovered.length} table(s)`
            : '';
          const detail = `reachable · db ${dbName} · ${allowlistPart}${discoveredPart}`;
          log(
            `    ${mark(true)} ${pc.bold('Postgres')}        ${pc.dim(detail)}`,
          );
          record({ name: 'postgres', state: 'ok', detail });
        }
      } finally {
        await pg.close();
      }
    } else {
      const detail = `configured (db ${dbName}) but Postgres URL not set`;
      log(
        `    ${mark(false)} ${pc.bold('Postgres')}       ${pc.dim(detail)}`,
      );
      record({ name: 'postgres', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Postgres')}        ${pc.dim('not configured')}`,
    );
    record({ name: 'postgres', state: 'pending', detail: 'not configured' });
  }

  // Sentry (error tracking) — probe reachability against the configured org/project.
  const sentryCfg = renv.connectors.sentry;
  if (sentryCfg) {
    const label = `${sentryCfg.org}/${sentryCfg.project}`;
    const sentry = (deps?.sentryFactory ?? sentryForEnv)(renv);
    if (sentry) {
      const h = await sentry.health();
      if (!h.ok) {
        const detail = `unreachable · ${label}`;
        log(
          `    ${mark(false)} ${pc.bold('Sentry')}         ${pc.dim(detail)}`,
        );
        record({ name: 'sentry', state: 'fail', detail });
        allOk = false;
      } else {
        const detail = `reachable · ${label}`;
        log(
          `    ${mark(true)} ${pc.bold('Sentry')}          ${pc.dim(detail)}`,
        );
        record({ name: 'sentry', state: 'ok', detail });
      }
    } else {
      const detail = `configured (${label}) but auth token not set`;
      log(
        `    ${mark(false)} ${pc.bold('Sentry')}         ${pc.dim(detail)}`,
      );
      record({ name: 'sentry', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Sentry')}          ${pc.dim('not configured')}`,
    );
    record({ name: 'sentry', state: 'pending', detail: 'not configured' });
  }

  // Axiom (structured logs) — probe reachability against the configured dataset.
  const axiomCfg = renv.connectors.axiom;
  if (axiomCfg) {
    const label = axiomCfg.dataset ?? '(no dataset)';
    const axiom = (deps?.axiomFactory ?? axiomForEnv)(renv);
    if (axiom) {
      const h = await axiom.health();
      if (!h.ok) {
        const detail = `unreachable · ${label}`;
        log(
          `    ${mark(false)} ${pc.bold('Axiom')}          ${pc.dim(detail)}`,
        );
        record({ name: 'axiom', state: 'fail', detail });
        allOk = false;
      } else {
        const detail = `reachable · ${label}`;
        log(
          `    ${mark(true)} ${pc.bold('Axiom')}           ${pc.dim(detail)}`,
        );
        record({ name: 'axiom', state: 'ok', detail });
      }
    } else {
      const detail = `configured (${label}) but API token not set`;
      log(
        `    ${mark(false)} ${pc.bold('Axiom')}          ${pc.dim(detail)}`,
      );
      record({ name: 'axiom', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Axiom')}           ${pc.dim('not configured')}`,
    );
    record({ name: 'axiom', state: 'pending', detail: 'not configured' });
  }

  // Shopify (Admin GraphQL) — probe auth reachability (Client-Credentials grant); no query.
  const shopifyCfg = renv.connectors.shopify;
  if (shopifyCfg) {
    const label = shopifyCfg.store ?? '(no store)';
    const shopify = (deps?.shopifyFactory ?? shopifyForEnv)(renv);
    if (shopify) {
      const h = await shopify.health();
      if (!h.ok) {
        const detail = `unreachable · ${label}`;
        log(
          `    ${mark(false)} ${pc.bold('Shopify')}        ${pc.dim(detail)}`,
        );
        record({ name: 'shopify', state: 'fail', detail });
        allOk = false;
      } else {
        const detail = `reachable · ${label}`;
        log(
          `    ${mark(true)} ${pc.bold('Shopify')}         ${pc.dim(detail)}`,
        );
        record({ name: 'shopify', state: 'ok', detail });
      }
    } else {
      const detail = `configured (${label}) but client secret not set`;
      log(
        `    ${mark(false)} ${pc.bold('Shopify')}        ${pc.dim(detail)}`,
      );
      record({ name: 'shopify', state: 'fail', detail });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Shopify')}         ${pc.dim('not configured')}`,
    );
    record({ name: 'shopify', state: 'pending', detail: 'not configured' });
  }

  // Redis — probe the server and each configured logical DB (HOR-201). Redis is a
  // general runtime connector: one server commonly holds queues in one DB and cache/
  // state in others, so we show a server line plus a per-DB breakdown.
  const redisCfg = renv.connectors.redis;
  if (redisCfg?.url) {
    const server = redisServerLabel(redisCfg.url);
    const status = await (deps?.redisStatus ?? redisServerStatus)(renv);
    if (!status) {
      log(`    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim(`configured · ${server}`)}`);
      record({ name: 'redis', state: 'pending', detail: `configured · ${server}` });
    } else if (!status.reachable) {
      const state = status.authFailed ? 'auth failed' : 'unreachable';
      log(`    ${mark(false)} ${pc.bold('Redis')}           ${pc.dim(`${state} · ${server}`)}`);
      record({ name: 'redis', state: 'fail', detail: `${state} · ${server}` });
      allOk = false;
    } else {
      const databases: NonNullable<EnvCheckJSON['databases']> = [];
      log(`    ${mark(true)} ${pc.bold('Redis')}           ${pc.dim(`reachable · ${server}`)}`);
      for (const d of status.databases) {
        const roleLabel = d.roles.length > 0 ? d.roles.join('/') : 'unrolled';
        const name = d.name ? ` ${d.name}` : '';
        let detail: string;
        if (!d.reachable) {
          detail = `${/WRONGPASS|NOAUTH/i.test(d.detail ?? '') ? 'auth failed' : 'unreachable'}`;
        } else if (d.queueCount !== undefined) {
          detail = `${d.queueCount} queue(s), prefix ${d.bullmqPrefix}`;
        } else {
          detail = `${d.keyCount ?? 0} key(s)`;
        }
        log(
          `      ${mark(d.reachable)} ${pc.bold(`DB ${d.db}`)}${name} ${pc.dim(`${roleLabel} · ${detail}`)}`,
        );
        databases.push({
          db: d.db,
          ...(d.name !== undefined ? { name: d.name } : {}),
          roles: d.roles,
          reachable: d.reachable,
          ...(d.queueCount !== undefined ? { queueCount: d.queueCount } : {}),
          ...(d.keyCount !== undefined ? { keyCount: d.keyCount } : {}),
        });
      }
      record({ name: 'redis', state: 'ok', detail: `reachable · ${server}`, databases });
    }
  } else {
    log(
      `    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim('not configured')}`,
    );
    record({ name: 'redis', state: 'pending', detail: 'not configured' });
  }

  log('');
  return allOk;
}

/** Mask password in a Redis URL for safe display. */
function redactRedisUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) {
      u.password = '***';
    }
    if (u.username) {
      u.username = u.username === '' ? '' : '***';
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/:?[^@]*@/, '//:***@');
  }
}

/** `host:port` for a Redis URL — never includes credentials. */
function redisServerLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || '6379'}`;
  } catch {
    return redactRedisUrl(raw);
  }
}

export async function runStatus(
  configPath?: string,
  opts?: {
    env?: string;
    /** Emit compact machine-readable JSON on stdout instead of human text. */
    json?: boolean;
    /** Inject a MongoDB provider factory for tests. */
    _mongoFactory?: (renv: ResolvedEnvironment) => StateProvider | null;
    /** Inject a Postgres provider factory for tests. */
    _postgresFactory?: (renv: ResolvedEnvironment) => StateProvider | null;
    /** Inject a Sentry provider factory for tests. */
    _sentryFactory?: (renv: ResolvedEnvironment) => SentryProvider | null;
    /** Inject a Redis server-status prober for tests. */
    _redisStatus?: (renv: ResolvedEnvironment) => Promise<RedisServerStatus | null>;
  },
): Promise<number> {
  const json = opts?.json === true;
  const envDeps = {
    mongoFactory: opts?._mongoFactory,
    postgresFactory: opts?._postgresFactory,
    sentryFactory: opts?._sentryFactory,
    redisStatus: opts?._redisStatus,
  };

  if (!json) {
    console.log(pc.bold(`\nHorus ${HORUS_VERSION}`));
    console.log(
      pc.dim(`pinned backend: ${PINNED_SOURCE_VERSION} · transport: HTTP/MCP only\n`),
    );
  }

  let config: HorusConfig | undefined;
  const checks: Check[] = [];

  try {
    config = await loadConfig(configPath);
    checks.push({ label: 'Config', ok: true, detail: 'loaded & valid' });
  } catch (err) {
    checks.push({
      label: 'Config',
      ok: false,
      detail: (err as Error).message,
      fatal: true,
    });
  }

  // Compact JSON contract (agents): stdout is ONE JSON object, always parseable,
  // even when the config is missing or an environment fails to resolve.
  const jsonOut: {
    version: string;
    pinnedSource: string;
    config: { ok: boolean; detail: string };
    database?: { reachable: boolean; schemaReady: boolean; detail: string; schemaDetail: string };
    environments: Array<{
      project: string;
      env: string;
      readOnly?: boolean;
      healthy: boolean;
      error?: string;
      checks?: EnvCheckJSON[];
    }>;
    healthy: boolean;
  } = {
    version: HORUS_VERSION,
    pinnedSource: PINNED_SOURCE_VERSION,
    config: { ok: config !== undefined, detail: checks[0]?.detail ?? '' },
    environments: [],
    healthy: true,
  };

  // Print config check before going further
  if (!json) {
    for (const c of checks) {
      console.log(`  ${mark(c.ok)} ${pc.bold(c.label)}  ${pc.dim(c.detail)}`);
    }
  }

  if (!config) {
    if (json) {
      jsonOut.healthy = false;
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      console.log('');
    }
    return 1;
  }

  // --- Embedded local database (always shown, not project-scoped) ---
  const h = await checkEmbeddedDb();
  if (json) {
    jsonOut.database = {
      reachable: h.reachable,
      schemaReady: h.schemaReady,
      detail: h.reachableDetail,
      schemaDetail: h.schemaDetail,
    };
  } else {
    console.log(
      `  ${mark(h.reachable)} ${pc.bold('Database')}  ${pc.dim(h.reachableDetail)}`,
    );
    console.log('');
  }

  // --- Project / environment matrix ---
  const envList = listEnvironments(config);
  if (envList.length === 0) {
    if (json) {
      console.log(JSON.stringify(jsonOut, null, 2));
    } else {
      console.log(pc.dim('  No projects configured.\n'));
    }
    return 0;
  }

  if (opts?.env !== undefined) {
    // Focused: single env
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { env: opts.env });
    } catch (err) {
      if (json) {
        jsonOut.healthy = false;
        jsonOut.environments.push({
          project: '',
          env: opts.env,
          healthy: false,
          error: (err as Error).message,
        });
        console.log(JSON.stringify(jsonOut, null, 2));
      } else {
        console.error(pc.red((err as Error).message));
      }
      return 1;
    }
    const collect: EnvCheckJSON[] | undefined = json ? [] : undefined;
    const ok = await checkEnv(renv, envDeps, collect);
    if (json) {
      jsonOut.environments.push({
        project: renv.project,
        env: renv.env,
        ...(renv.readOnly ? { readOnly: true } : {}),
        healthy: ok,
        checks: collect,
      });
      jsonOut.healthy = ok;
      console.log(JSON.stringify(jsonOut, null, 2));
    }
    return ok ? 0 : 1;
  }

  // Matrix: all environments
  let allHealthy = true;
  for (const { project, env } of envList) {
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { project, env });
    } catch (err) {
      if (json) {
        jsonOut.environments.push({
          project,
          env,
          healthy: false,
          error: (err as Error).message,
        });
      } else {
        console.error(pc.red(`  ${project}/${env}: ${(err as Error).message}`));
      }
      allHealthy = false;
      continue;
    }
    const collect: EnvCheckJSON[] | undefined = json ? [] : undefined;
    const ok = await checkEnv(renv, envDeps, collect);
    if (json) {
      jsonOut.environments.push({
        project: renv.project,
        env: renv.env,
        ...(renv.readOnly ? { readOnly: true } : {}),
        healthy: ok,
        checks: collect,
      });
    }
    if (!ok) allHealthy = false;
  }

  if (json) {
    jsonOut.healthy = allHealthy;
    console.log(JSON.stringify(jsonOut, null, 2));
  }

  // Exit non-zero only on a fatal failure (bad config). Unreachable providers are
  // warnings in matrix mode; exit 1 only when --env was given.
  return checks.some((c) => c.ok === false && c.fatal) ? 1 : 0;
}
