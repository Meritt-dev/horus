/**
 * ConnectorFactory — wires a `HorusConfig` or a `ResolvedEnvironment` into live
 * provider instances.
 *
 * HOR-34: The primary API is now environment-scoped (`codeForEnv`, `logsForEnv`,
 * `metricsForEnv`). The old global helpers (`codeForRepo`, `logsProviderFromConfig`,
 * `metricsProviderFromConfig`, `repoProviders`, `createConnectors`,
 * `sourceHostUrlForRepo`) are kept as thin compat wrappers so existing commands compile
 * unchanged.
 */

import type {
  HorusConfig,
  ResolvedEnvironment,
  ResolvedElasticsearchFields,
  ResolvedRedisDatabase,
  RedisRole,
} from '@horus/core';
import { resolveEnvironment, redisUrlForDb, REDIS_QUEUE_ROLES } from '@horus/core';
import { SourceHttpClient, SourceCodeProvider, SourceMemoryVectorIndex } from './source/index.js';
import type { MemoryVectorIndexLike } from './source/index.js';
import type { CodeProvider } from './contract.js';
import { ElasticsearchClient } from './elasticsearch/client.js';
import { ElasticsearchLogsProvider } from './elasticsearch/provider.js';
import type { LogsProvider } from './elasticsearch/provider.js';
import {
  type ElasticsearchFieldMapping,
  MERITT_FIELD_MAPPING,
  ECS_FIELD_MAPPING,
} from './elasticsearch/normalize.js';
import { GrafanaClient } from './grafana/client.js';
import { GrafanaMetricsProvider } from './grafana/provider.js';
import type { MetricsProvider } from './grafana/provider.js';
import { MongoStateClient } from './mongodb/client.js';
import { MongoStateProvider } from './mongodb/provider.js';
import type { StateProvider } from './state/provider.js';
import { PostgresStateClient } from './postgres/client.js';
import { PostgresStateProvider } from './postgres/provider.js';
import { SentryClient } from './sentry/client.js';
import { SentryProvider } from './sentry/provider.js';
import { AxiomClient } from './axiom/client.js';
import { AxiomProvider } from './axiom/provider.js';
import { ShopifyAdminClient } from './shopify/client.js';
import { ShopifyProvider } from './shopify/provider.js';
import { BullMQRedisClient } from './bullmq/client.js';
import { BullMQRuntimeProvider } from './bullmq/provider.js';
import type { QueueRuntimeProvider } from './bullmq/provider.js';
import { RedisStateRuntimeProvider } from './redis/state-provider.js';

// ---------------------------------------------------------------------------
// Environment-scoped builders (primary API, HOR-34)
// ---------------------------------------------------------------------------

/**
 * Return a source `CodeProvider` for the given resolved environment, or `null` when
 * no source connector is configured.
 */
export function codeForEnv(renv: ResolvedEnvironment): CodeProvider | null {
  const repo = renv.repositories[0];
  const hostUrl = repo?.sourceHostUrl;
  if (!hostUrl) return null;
  return new SourceCodeProvider(new SourceHttpClient({ baseUrl: hostUrl }));
}

/**
 * Build a source `CodeProvider` pointed at an explicit host URL. Used when host selection
 * resolves a host that differs from the configured default — e.g. HOR-421, where the
 * configured `:8420` is occupied by a host serving a DIFFERENT repo and we must ground on
 * this repo's OWN host on a free port instead.
 */
export function codeForUrl(hostUrl: string): CodeProvider {
  return new SourceCodeProvider(new SourceHttpClient({ baseUrl: hostUrl }));
}

/**
 * Return a source-host-backed `MemoryVectorIndex` for the given resolved environment
 * (M2). Mirrors `codeForEnv`: when the env's repo has a `sourceHostUrl`, returns a
 * `SourceMemoryVectorIndex` pointed at that host (reusing the code provider's baseUrl).
 *
 * The optional `fallback` (typically the engine `NoopVectorIndex`) is composed in BOTH
 * directions:
 *   - host configured  -> Source index that degrades to `fallback` when the host is
 *     unreachable or its index is empty (Jaccard);
 *   - host NOT configured -> the `fallback` itself (so callers get "Source-when-available
 *     else Noop"). When no fallback is supplied, returns `null` and the caller defaults.
 *
 * Memory vectors are LOCAL-ONLY; this never participates in any cloud-sync path.
 */
export function memoryIndexForEnv(
  renv: ResolvedEnvironment,
  fallback?: MemoryVectorIndexLike,
): MemoryVectorIndexLike | null {
  const repo = renv.repositories[0];
  const hostUrl = repo?.sourceHostUrl;
  if (!hostUrl) return fallback ?? null;
  return new SourceMemoryVectorIndex(
    new SourceHttpClient({ baseUrl: hostUrl }),
    fallback ? { fallback } : {},
  );
}

/**
 * Return an Elasticsearch `LogsProvider` for the given resolved environment, or
 * `null` when no (or incomplete) ES connector is configured.
 */
function applyFieldOverrides(
  base: ElasticsearchFieldMapping,
  overrides: ResolvedElasticsearchFields,
): ElasticsearchFieldMapping {
  return {
    ...base,
    ...(overrides.timestamp !== undefined ? { timestampField: overrides.timestamp } : {}),
    ...(overrides.level !== undefined ? { levelField: overrides.level } : {}),
    ...(overrides.levelFormat !== undefined ? { levelFormat: overrides.levelFormat } : {}),
    ...(overrides.service !== undefined ? { serviceField: overrides.service } : {}),
    ...(overrides.serviceKeyword !== undefined ? { serviceKeyword: overrides.serviceKeyword } : {}),
    ...(overrides.message !== undefined ? { messageField: overrides.message } : {}),
    ...(overrides.messageFallback !== undefined ? { messageFallbackField: overrides.messageFallback } : {}),
    ...(overrides.traceId !== undefined ? { traceIdField: overrides.traceId } : {}),
    ...(overrides.requestId !== undefined ? { requestIdField: overrides.requestId } : {}),
    ...(overrides.eventCode !== undefined ? { eventCodeField: overrides.eventCode } : {}),
    ...(overrides.eventCodeKeyword !== undefined ? { eventCodeKeyword: overrides.eventCodeKeyword } : {}),
  };
}

// Query endpoints run heavy work (ES aggregations that auto-widen to 30d,
// Grafana datasource-proxy queries bounded by the engine's 30s metrics budget).
// The shared HTTP helper's 8s default is sized for point requests — before it,
// these clients had NO timeout at all, so an 8s cap would regress slow-but-
// healthy queries into "collection failed". Matched to the engine budget.
const QUERY_TIMEOUT_MS = 30_000;

export function logsForEnv(renv: ResolvedEnvironment): LogsProvider | null {
  const es = renv.connectors.elasticsearch;
  if (!es || !es.url) return null;
  const base = es.preset === 'ecs' ? ECS_FIELD_MAPPING : MERITT_FIELD_MAPPING;
  const fieldMapping = es.fields !== undefined ? applyFieldOverrides(base, es.fields) : base;
  return new ElasticsearchLogsProvider(
    new ElasticsearchClient({
      baseUrl: es.url,
      username: es.username,
      password: es.password,
      http: { timeoutMs: QUERY_TIMEOUT_MS },
    }),
    { indexPattern: es.indexPattern, fieldMapping },
  );
}

/**
 * Return a Grafana `MetricsProvider` for the given resolved environment, or `null`
 * when no (or incomplete) Grafana connector is configured.
 */
export function metricsForEnv(renv: ResolvedEnvironment): MetricsProvider | null {
  const g = renv.connectors.grafana;
  if (!g || !g.url) return null;
  return new GrafanaMetricsProvider(
    new GrafanaClient({
      baseUrl: g.url,
      username: g.username,
      password: g.password,
      http: { timeoutMs: QUERY_TIMEOUT_MS },
    }),
    { defaultStep: 60, dashboardUids: g.dashboards },
  );
}

/** Does `db` carry any of `roles`? */
function dbHasRole(db: ResolvedRedisDatabase, roles: readonly RedisRole[]): boolean {
  return db.roles.some((r) => roles.includes(r));
}

/**
 * Pick the Redis logical DB that holds BullMQ queues (HOR-201). Prefers a DB tagged
 * `bullmq`/`queues`; if none is tagged (legacy single-URL config), falls back to the
 * sole configured DB so existing setups keep working.
 */
export function queueDatabaseForEnv(renv: ResolvedEnvironment): ResolvedRedisDatabase | null {
  const dbs = renv.connectors.redis?.databases;
  if (!dbs || dbs.length === 0) return null;
  return dbs.find((d) => dbHasRole(d, REDIS_QUEUE_ROLES)) ?? (dbs.length === 1 ? dbs[0]! : null);
}

/** Resolved DBs tagged with any state role — cache/state/locks/rate-limit/session/dedupe. */
const STATE_ROLES: readonly RedisRole[] = ['cache', 'state', 'locks', 'rate-limit', 'session', 'dedupe'];
export function stateDatabasesForEnv(renv: ResolvedEnvironment): ResolvedRedisDatabase[] {
  const dbs = renv.connectors.redis?.databases ?? [];
  return dbs.filter((d) => dbHasRole(d, STATE_ROLES));
}

/**
 * Return a Redis state-evidence provider for the env's cache/state/locks/rate-limit
 * DBs, or `null` when none are configured. Feeds the investigation engine `redis-key`
 * evidence (key counts, lock/rate-limit presence) — counts only, never key values.
 */
export function redisStateForEnv(renv: ResolvedEnvironment): RedisStateRuntimeProvider | null {
  const r = renv.connectors.redis;
  if (!r?.url) return null;
  const stateDbs = stateDatabasesForEnv(renv);
  if (stateDbs.length === 0) return null;
  const baseUrl = r.url;
  return new RedisStateRuntimeProvider(
    stateDbs.map((d) => ({
      db: d.db,
      ...(d.name !== undefined ? { name: d.name } : {}),
      roles: d.roles,
      url: redisUrlForDb(baseUrl, d.db),
      ...(d.scan !== undefined
        ? { scan: { sampleLimit: d.scan.sampleLimit, patterns: d.scan.patterns } }
        : {}),
    })),
  );
}

/**
 * Return a BullMQ `QueueRuntimeProvider` for the given resolved environment, or
 * `null` when no Redis connector / queue DB is configured. Targets the queue DB
 * (role `bullmq`/`queues`, or the single legacy DB) with its configured prefix.
 */
export function queueForEnv(renv: ResolvedEnvironment): QueueRuntimeProvider | null {
  const r = renv.connectors.redis;
  if (!r?.url) return null;
  const queueDb = queueDatabaseForEnv(renv);
  if (!queueDb) return null;
  return new BullMQRuntimeProvider(
    new BullMQRedisClient({ url: redisUrlForDb(r.url, queueDb.db), prefix: queueDb.bullmqPrefix }),
  );
}

/**
 * Return a MongoDB `StateProvider` for the given resolved environment, or `null`
 * when no Mongo connector is configured (no URL — e.g. a different cluster whose
 * URL env var is unset). Read-only, allowlisted collections only.
 */
export function mongoForEnv(renv: ResolvedEnvironment): StateProvider | null {
  const m = renv.connectors.mongodb;
  if (!m || !m.url || !m.database) return null;
  return new MongoStateProvider(
    new MongoStateClient({
      url: m.url,
      database: m.database,
      allowlist: m.collections,
    }),
    { database: m.database, collections: m.collections, staleHours: 24 },
  );
}

/**
 * Return a Postgres `StateProvider` for the given resolved environment, or `null`
 * when no Postgres connector is configured (no URL — e.g. its URL env var is unset).
 * Read-only, allowlisted tables only. `tables` maps onto the shared state analyzer's
 * `collections` slot.
 */
export function postgresForEnv(renv: ResolvedEnvironment): StateProvider | null {
  const p = renv.connectors.postgres;
  if (!p || !p.url) return null;
  return new PostgresStateProvider(
    new PostgresStateClient({
      url: p.url,
      schema: p.schema,
      allowlist: p.tables,
    }),
    { database: p.database ?? p.schema ?? 'postgres', collections: p.tables, staleHours: 24 },
  );
}

/**
 * Return a Sentry error-evidence `SentryProvider` for the given resolved environment,
 * or `null` when no Sentry connector is configured (missing auth token / org / project —
 * e.g. its token env var is unset). Read-only; surfaces grouped exceptions as ERROR
 * evidence with a direct code seed (top in-app stack frame).
 */
export function sentryForEnv(renv: ResolvedEnvironment): SentryProvider | null {
  const s = renv.connectors.sentry;
  if (!s || !s.authToken || !s.org || !s.project) return null;
  return new SentryProvider(
    new SentryClient({
      authToken: s.authToken,
      org: s.org,
      project: s.project,
      ...(s.url !== undefined ? { baseUrl: s.url } : {}),
    }),
    { org: s.org, project: s.project },
  );
}

/**
 * Return an Axiom logs-evidence `AxiomProvider` for the given resolved environment,
 * or `null` when no Axiom connector is configured (missing token / dataset — e.g. its
 * token env var is unset). Read-only; surfaces structured log rows as `kind: 'log'`
 * evidence via APL queries.
 */
export function axiomForEnv(renv: ResolvedEnvironment): AxiomProvider | null {
  const a = renv.connectors.axiom;
  if (!a || !a.token || !a.dataset) return null;
  return new AxiomProvider(
    new AxiomClient({
      token: a.token,
      dataset: a.dataset,
      ...(a.url !== undefined ? { baseUrl: a.url } : {}),
    }),
    { dataset: a.dataset },
  );
}

/**
 * Return a Shopify Admin evidence `ShopifyProvider` for the given resolved environment, or
 * `null` when no Shopify connector is configured (missing store or secret — e.g. its
 * `client_secret` env var is unset). Read-only; runs caller-supplied / config-declared
 * GraphQL queries verbatim and surfaces each result as `state` (or `log`/`metric`) evidence.
 * A provider is returned whenever AUTH is present — queries may be supplied per-investigation
 * (`--shopify-query`), so the absence of config `queries` does NOT make the connector absent.
 */
export function shopifyForEnv(renv: ResolvedEnvironment): ShopifyProvider | null {
  const s = renv.connectors.shopify;
  if (!s || !s.store || !s.secret) return null;
  return new ShopifyProvider(
    new ShopifyAdminClient({
      store: s.store,
      secret: s.secret,
      ...(s.accessId !== undefined ? { accessId: s.accessId } : {}),
      ...(s.apiVersion !== undefined ? { apiVersion: s.apiVersion } : {}),
    }),
    {
      store: s.store,
      ...(s.queries !== undefined ? { queries: s.queries } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Legacy Connectors bundle type
// ---------------------------------------------------------------------------

export interface Connectors {
  code: CodeProvider;
}

// ---------------------------------------------------------------------------
// Compat wrappers — keep existing CLI commands compiling unchanged (HOR-34)
// ---------------------------------------------------------------------------

/**
 * Return a `CodeProvider` wired to the source-intelligence host for a specific project
 * (or the default/single project when `repoName` is omitted). `repoName` maps 1:1 to a
 * project name via `resolveEnvironment`.
 *
 * Throws when no source connector is configured for the resolved environment.
 */
export function codeForRepo(config: HorusConfig, repoName?: string): CodeProvider {
  const renv = resolveEnvironment(config, { project: repoName });
  const c = codeForEnv(renv);
  if (!c) {
    throw new Error(
      `No source-intelligence connector configured for project "${renv.project}" / env "${renv.env}".`,
    );
  }
  return c;
}

/**
 * Resolve the source-intelligence host URL for a named project.
 * Falls back to empty string when no source connector is configured.
 */
export function sourceHostUrlForRepo(config: HorusConfig, repoName?: string): string {
  const renv = resolveEnvironment(config, { project: repoName });
  const repo = renv.repositories[0];
  return repo?.sourceHostUrl ?? '';
}

/**
 * Build and return a Connectors bundle for the default (or single) project/env.
 * Throws when no source connector is present.
 */
export function createConnectors(config: HorusConfig): Connectors {
  return { code: codeForRepo(config) };
}

/** A fully-resolved, live-wired descriptor for a single configured project. */
export interface RepoProvider {
  name: string;
  path: string;
  hostUrl: string;
  code: CodeProvider;
}

/**
 * Build a `RepoProvider` for every project in the config. Each provider is pointed
 * at the project's resolved source-intelligence host.
 */
export function repoProviders(config: HorusConfig): RepoProvider[] {
  const out: RepoProvider[] = [];
  for (const p of config.projects) {
    const renv = resolveEnvironment(config, { project: p.name });
    for (const r of renv.repositories) {
      const hostUrl = r.sourceHostUrl ?? '';
      out.push({
        name: r.name,
        path: r.path,
        hostUrl,
        // A missing source host yields a stub that reports unreachable on health().
        code: new SourceCodeProvider(new SourceHttpClient({ baseUrl: hostUrl })),
      });
    }
  }
  return out;
}

/**
 * Build a `LogsProvider` wired to Elasticsearch for the default project/env.
 * No longer reads global env vars directly — secrets come from resolveEnvironment.
 * Returns `null` when Elasticsearch is not configured or the URL is missing.
 */
export function logsProviderFromConfig(config: HorusConfig): LogsProvider | null {
  return logsForEnv(resolveEnvironment(config));
}

/**
 * Build a `MetricsProvider` backed by Grafana for the default project/env.
 * No longer reads global env vars directly — secrets come from resolveEnvironment.
 * Returns `null` when Grafana is not configured or the URL is missing.
 */
export function metricsProviderFromConfig(config: HorusConfig): MetricsProvider | null {
  return metricsForEnv(resolveEnvironment(config));
}
