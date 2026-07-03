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
import { checkDatabase } from '@horus/db';

interface Check {
  label: string;
  ok: boolean | 'pending';
  detail: string;
  /** A failed `fatal` check sets a non-zero exit code; non-fatal failures are warnings. */
  fatal?: boolean;
}

function mark(ok: boolean | 'pending'): string {
  if (ok === 'pending') return pc.yellow('○');
  return ok ? pc.green('●') : pc.red('●');
}

/** Print health status for one resolved environment. Returns true when healthy. */
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
): Promise<boolean> {
  const header =
    `  ${pc.bold(renv.project)} / ${pc.bold(renv.env)}` +
    (renv.readOnly ? pc.dim('  (read-only)') : '');
  console.log(header);

  let allOk = true;

  // Source intelligence — code intelligence, belongs to the project's repositories.
  if (renv.repositories.length === 0) {
    console.log(
      `    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim('no repositories configured')}`,
    );
  }
  for (const repo of renv.repositories) {
    const sourceHostUrl = repo.sourceHostUrl;
    if (!sourceHostUrl) {
      console.log(
        `    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim(`${repo.name}: not configured`)}`,
      );
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
    console.log(
      `    ${mark(health.ok)} ${pc.bold('Source')}          ${pc.dim(sourceDetail)}`,
    );
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
      console.log(`    ${mark(h.ok)} ${pc.bold('Elasticsearch')}   ${pc.dim(detail)}`);
      if (!h.ok) allOk = false;
    } else {
      const idxDisplay = esCfg.indexPatterns
        ? esCfg.indexPatterns.join(', ')
        : esCfg.indexPattern;
      console.log(
        `    ${mark(false)} ${pc.bold('Elasticsearch')}   ${pc.dim(`configured (index ${idxDisplay}) but ES_URL not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Elasticsearch')}   ${pc.dim('not configured')}`,
    );
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
      console.log(`    ${mark(h.ok)} ${pc.bold('Grafana')}         ${pc.dim(detail)}`);
      if (!h.ok) allOk = false;
    } else {
      console.log(
        `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim('configured but GRAFANA_URL not set')}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim('not configured')}`,
    );
  }

  // MongoDB
  const mongoCfg = renv.connectors.mongodb;
  if (mongoCfg) {
    const mongo = (deps?.mongoFactory ?? mongoForEnv)(renv);
    if (mongo) {
      try {
        const h = await mongo.health();
        if (!h.ok) {
          console.log(
            `    ${mark(false)} ${pc.bold('MongoDB')}        ${pc.dim(`unreachable · db ${mongoCfg.database}`)}`,
          );
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
          console.log(
            `    ${mark(true)} ${pc.bold('MongoDB')}         ${pc.dim(detail)}`,
          );
        }
      } finally {
        await mongo.close();
      }
    } else {
      console.log(
        `    ${mark(false)} ${pc.bold('MongoDB')}        ${pc.dim(`configured (db ${mongoCfg.database}) but Mongo URL not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('MongoDB')}         ${pc.dim('not configured')}`,
    );
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
          console.log(
            `    ${mark(false)} ${pc.bold('Postgres')}       ${pc.dim(`unreachable · db ${dbName}`)}`,
          );
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
          console.log(
            `    ${mark(true)} ${pc.bold('Postgres')}        ${pc.dim(detail)}`,
          );
        }
      } finally {
        await pg.close();
      }
    } else {
      console.log(
        `    ${mark(false)} ${pc.bold('Postgres')}       ${pc.dim(`configured (db ${dbName}) but Postgres URL not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Postgres')}        ${pc.dim('not configured')}`,
    );
  }

  // Sentry (error tracking) — probe reachability against the configured org/project.
  const sentryCfg = renv.connectors.sentry;
  if (sentryCfg) {
    const label = `${sentryCfg.org}/${sentryCfg.project}`;
    const sentry = (deps?.sentryFactory ?? sentryForEnv)(renv);
    if (sentry) {
      const h = await sentry.health();
      if (!h.ok) {
        console.log(
          `    ${mark(false)} ${pc.bold('Sentry')}         ${pc.dim(`unreachable · ${label}`)}`,
        );
        allOk = false;
      } else {
        console.log(
          `    ${mark(true)} ${pc.bold('Sentry')}          ${pc.dim(`reachable · ${label}`)}`,
        );
      }
    } else {
      console.log(
        `    ${mark(false)} ${pc.bold('Sentry')}         ${pc.dim(`configured (${label}) but auth token not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Sentry')}          ${pc.dim('not configured')}`,
    );
  }

  // Axiom (structured logs) — probe reachability against the configured dataset.
  const axiomCfg = renv.connectors.axiom;
  if (axiomCfg) {
    const label = axiomCfg.dataset ?? '(no dataset)';
    const axiom = (deps?.axiomFactory ?? axiomForEnv)(renv);
    if (axiom) {
      const h = await axiom.health();
      if (!h.ok) {
        console.log(
          `    ${mark(false)} ${pc.bold('Axiom')}          ${pc.dim(`unreachable · ${label}`)}`,
        );
        allOk = false;
      } else {
        console.log(
          `    ${mark(true)} ${pc.bold('Axiom')}           ${pc.dim(`reachable · ${label}`)}`,
        );
      }
    } else {
      console.log(
        `    ${mark(false)} ${pc.bold('Axiom')}          ${pc.dim(`configured (${label}) but API token not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Axiom')}           ${pc.dim('not configured')}`,
    );
  }

  // Shopify (Admin GraphQL) — probe auth reachability (Client-Credentials grant); no query.
  const shopifyCfg = renv.connectors.shopify;
  if (shopifyCfg) {
    const label = shopifyCfg.store ?? '(no store)';
    const shopify = (deps?.shopifyFactory ?? shopifyForEnv)(renv);
    if (shopify) {
      const h = await shopify.health();
      if (!h.ok) {
        console.log(
          `    ${mark(false)} ${pc.bold('Shopify')}        ${pc.dim(`unreachable · ${label}`)}`,
        );
        allOk = false;
      } else {
        console.log(
          `    ${mark(true)} ${pc.bold('Shopify')}         ${pc.dim(`reachable · ${label}`)}`,
        );
      }
    } else {
      console.log(
        `    ${mark(false)} ${pc.bold('Shopify')}        ${pc.dim(`configured (${label}) but client secret not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Shopify')}         ${pc.dim('not configured')}`,
    );
  }

  // Redis — probe the server and each configured logical DB (HOR-201). Redis is a
  // general runtime connector: one server commonly holds queues in one DB and cache/
  // state in others, so we show a server line plus a per-DB breakdown.
  const redisCfg = renv.connectors.redis;
  if (redisCfg?.url) {
    const server = redisServerLabel(redisCfg.url);
    const status = await (deps?.redisStatus ?? redisServerStatus)(renv);
    if (!status) {
      console.log(`    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim(`configured · ${server}`)}`);
    } else if (!status.reachable) {
      const state = status.authFailed ? 'auth failed' : 'unreachable';
      console.log(`    ${mark(false)} ${pc.bold('Redis')}           ${pc.dim(`${state} · ${server}`)}`);
      allOk = false;
    } else {
      console.log(`    ${mark(true)} ${pc.bold('Redis')}           ${pc.dim(`reachable · ${server}`)}`);
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
        console.log(
          `      ${mark(d.reachable)} ${pc.bold(`DB ${d.db}`)}${name} ${pc.dim(`${roleLabel} · ${detail}`)}`,
        );
      }
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim('not configured')}`,
    );
  }

  console.log('');
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
  console.log(pc.bold(`\nHorus ${HORUS_VERSION}`));
  console.log(
    pc.dim(`pinned backend: ${PINNED_SOURCE_VERSION} · transport: HTTP/MCP only\n`),
  );

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

  // Print config check before going further
  for (const c of checks) {
    console.log(`  ${mark(c.ok)} ${pc.bold(c.label)}  ${pc.dim(c.detail)}`);
  }

  if (!config) {
    console.log('');
    return 1;
  }

  // --- Postgres (always shown, not project-scoped) ---
  const dbUrl = config.database.url;
  const h = await checkDatabase(dbUrl);
  console.log(
    `  ${mark(h.reachable)} ${pc.bold('Postgres')}  ${pc.dim(h.reachableDetail)}`,
  );
  console.log(
    `  ${mark(h.schemaReady)} ${pc.bold('Schema')}    ${pc.dim(h.schemaDetail)}`,
  );
  console.log('');

  // --- Project / environment matrix ---
  const envList = listEnvironments(config);
  if (envList.length === 0) {
    console.log(pc.dim('  No projects configured.\n'));
    return 0;
  }

  if (opts?.env !== undefined) {
    // Focused: single env
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }
    const ok = await checkEnv(renv, { mongoFactory: opts?._mongoFactory, postgresFactory: opts?._postgresFactory, sentryFactory: opts?._sentryFactory, redisStatus: opts?._redisStatus });
    return ok ? 0 : 1;
  }

  // Matrix: all environments
  let allHealthy = true;
  for (const { project, env } of envList) {
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { project, env });
    } catch (err) {
      console.error(pc.red(`  ${project}/${env}: ${(err as Error).message}`));
      allHealthy = false;
      continue;
    }
    const ok = await checkEnv(renv, { mongoFactory: opts?._mongoFactory, postgresFactory: opts?._postgresFactory, sentryFactory: opts?._sentryFactory, redisStatus: opts?._redisStatus });
    if (!ok) allHealthy = false;
  }

  // Exit non-zero only on a fatal failure (bad config). Unreachable providers are
  // warnings in matrix mode; exit 1 only when --env was given.
  return checks.some((c) => c.ok === false && c.fatal) ? 1 : 0;
}
