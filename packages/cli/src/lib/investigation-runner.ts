/**
 * Shared investigation runner (HOR-CLI).
 *
 * The wiring that turns a resolved environment into a live engine call is substantial:
 * resolve every connector, self-heal a down source-intelligence host, degrade to
 * runtime-only when it stays down, open the local DB, call `investigate()` under a
 * deadline, and tear every handle back down so the process can exit.
 *
 * This lived inline in `runInvestigate`. Both `horus investigate` and `horus watch`
 * need it, so it is extracted here ONCE: `buildInvestigationContext()` constructs the
 * deps + DB and `runOneInvestigation()` runs a single investigation against them and
 * persists it (the engine writes the report into the local DB via the `db` dep, so it
 * lands in incident memory + `horus ask`). `disposeInvestigationContext()` closes
 * everything. Do NOT duplicate this flow — extend it.
 */

import pc from 'picocolors';
import type { ResolvedEnvironment, ShopifyQuerySpec } from '@horus/core';
import {
  codeForEnv,
  codeForUrl,
  logsForEnv,
  mongoForEnv,
  postgresForEnv,
  sentryForEnv,
  axiomForEnv,
  shopifyForEnv,
  queueForEnv,
  redisStateForEnv,
  metricsForEnv,
} from '@horus/connectors';
import type {
  LogsProvider,
  StateProvider,
  SentryProvider,
  AxiomProvider,
  ShopifyProvider,
  QueueRuntimeProvider,
  RedisStateRuntimeProvider,
  MetricsProvider,
  CodeProvider,
} from '@horus/connectors';
import { openDb } from '@horus/db';
import type { DbHandle } from '@horus/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { investigate, createLocalMemoryStore } from '@horus/engine';
import type { InvestigationReport, CauseCandidate } from '@horus/engine';
import { applyReranker, isRerankerModel } from '@horus/eval';
import { resolveSourceHostUrl } from './ensure-host.js';

/**
 * Everything a single `investigate()` call needs: the resolved env, the live connectors,
 * the open DB handle, and whether the run is degraded to runtime-only (no source host).
 * Built once by `buildInvestigationContext`; reused for many investigations by a watcher.
 */
export interface InvestigationContext {
  renv: ResolvedEnvironment;
  dbHandle: DbHandle;
  /** True when the source-intelligence host was unreachable and could not be self-healed. */
  runtimeOnly: boolean;
  code: CodeProvider | null;
  logs: LogsProvider | null;
  mongo: StateProvider | null;
  postgres: StateProvider | null;
  sentry: SentryProvider | null;
  axiom: AxiomProvider | null;
  shopify: ShopifyProvider | null;
  queue: QueueRuntimeProvider | null;
  redisState: RedisStateRuntimeProvider | null;
  metrics: MetricsProvider | null;
  /** Default service scope: CLI flag > ES connector's serviceName > undefined. */
  service?: string;
}

export interface BuildContextOptions {
  /** Database URL for the investigation store (config.database.url). */
  databaseUrl: string;
  /** Explicit service scope; falls back to the ES connector's configured serviceName. */
  service?: string;
  /** Sink for human-readable status/warning lines (default: console.error). */
  log?: (line: string) => void;
}

/**
 * Build a reusable investigation context for a resolved environment.
 *
 * Mirrors the connector wiring of `runInvestigate`: resolves a source `CodeProvider`,
 * attempts to self-heal a down host (then re-checks), and degrades to RUNTIME-ONLY when
 * the host stays down (HOR-319 layers 1 & 2). Resolves every runtime connector and opens
 * the local DB. Returns a context the caller reuses across one or many investigations.
 *
 * Throws when no source-intelligence connector is configured for the environment — the
 * same hard requirement `runInvestigate` enforces.
 */
export async function buildInvestigationContext(
  renv: ResolvedEnvironment,
  opts: BuildContextOptions,
): Promise<InvestigationContext> {
  const log = opts.log ?? ((l: string) => console.error(l));

  let code = codeForEnv(renv);
  if (!code) {
    throw new Error(
      `No source-intelligence connector configured for project "${renv.project}" / env "${renv.env}".`,
    );
  }

  // `codeForEnv` only returns a provider when the repo has a configured sourceHostUrl.
  const sourceUrl = renv.repositories[0]?.sourceHostUrl;
  let runtimeOnly: boolean;
  if (sourceUrl) {
    // HOR-319 (layer-1) self-heal a down host + HOR-421 verify the host serves THIS repo
    // (never ground on a foreign repo's host occupying the shared :8420 default). The
    // resolved URL may differ from the configured one when we had to start this repo's own
    // host on a free port — rebuild the provider to point at the verified host.
    const resolved = await resolveSourceHostUrl(renv.path, sourceUrl, { log });
    runtimeOnly = !resolved.ok;
    if (resolved.ok && resolved.hostUrl && resolved.hostUrl !== sourceUrl) {
      code = codeForUrl(resolved.hostUrl);
    }
  } else {
    runtimeOnly = !(await code.health()).ok;
  }

  // HOR-319 (layer-2): if no verified source host is available, degrade to a runtime-only
  // investigation — logs/metrics/state/queues are independent of the source host.
  if (runtimeOnly) {
    log(
      pc.yellow(
        `Proceeding in runtime-only mode — no source intelligence. ` +
          `Run ${pc.bold('horus init')} for a full (code-aware) investigation.`,
      ),
    );
  }

  const logs = logsForEnv(renv);
  const mongo = mongoForEnv(renv);
  const postgres = postgresForEnv(renv);
  const sentry = sentryForEnv(renv);
  const axiom = axiomForEnv(renv);
  const shopify = shopifyForEnv(renv);
  const queue = queueForEnv(renv);
  const redisState = redisStateForEnv(renv);
  const metrics = metricsForEnv(renv);

  // Resolve service name: caller flag > connector default > undefined.
  const service = opts.service ?? renv.connectors.elasticsearch?.serviceName;

  const dbHandle = await openDb(databaseUrlOrThrow(opts.databaseUrl));

  return {
    renv,
    dbHandle,
    runtimeOnly,
    // Runtime-only degrade: pass no source provider so the engine skips seed
    // resolution + structural evidence and builds from runtime evidence.
    code: runtimeOnly ? null : code,
    logs,
    mongo,
    postgres,
    sentry,
    axiom,
    shopify,
    queue,
    redisState,
    metrics,
    ...(service !== undefined ? { service } : {}),
  };
}

function databaseUrlOrThrow(url: string): string {
  if (!url) throw new Error('No database URL configured for the investigation store.');
  return url;
}

/** Per-investigation overrides — the hint plus optional scoping/window flags. */
export interface RunInvestigationInput {
  hint: string;
  /** Git ref/range for change-impact (e.g. HEAD~5). */
  since?: string;
  /** Runtime-log window as a duration (e.g. 30d, 24h), independent of `since`. */
  logsSince?: string;
  /** Service scope override; defaults to the context's resolved service. */
  service?: string;
  /** Path scope for seed resolution (e.g. packages/core) — HOR-356. */
  scope?: string;
  /**
   * Shopify Admin GraphQL queries supplied at invocation (e.g. `--shopify-query`). Executed
   * verbatim as evidence this investigation; when omitted the Shopify connector falls back to
   * its config-declared default queries (so `horus watch` still collects).
   */
  shopifyQueries?: ShopifyQuerySpec[];
}

/**
 * HOR-404: load the LOCAL reranker as an engine `rerank` fn, or undefined. OFF by default — active
 * only when `HORUS_RERANK` is truthy AND a saved model beat the baseline on its holdout (delta > 0).
 * Fail-closed: any error (missing/corrupt/under-performing model) → undefined → Horus keeps its
 * deterministic ranking. The model only ever REORDERS the eligible causes the engine hands it.
 */
function loadReranker(): ((causes: readonly CauseCandidate[]) => CauseCandidate[]) | undefined {
  const flag = process.env.HORUS_RERANK;
  if (!flag || flag === '0' || flag.toLowerCase() === 'false') return undefined;
  try {
    const blob: unknown = JSON.parse(readFileSync(join(homedir(), '.horus', 'reranker.json'), 'utf8'));
    if (!isRerankerModel(blob)) return undefined;
    if ((blob.holdout?.delta ?? 0) <= 0) return undefined; // never apply a model that didn't beat baseline
    return (causes) => applyReranker(blob, causes);
  } catch {
    return undefined;
  }
}

/**
 * Run a single investigation against a prepared context and persist it. The engine writes
 * the report into the local DB via the `db` dep, so it lands in incident memory and is
 * resolvable by `horus ask`. Bounded by `timeoutMs` so an unreachable/slow connector can
 * never hang the call forever.
 */
export async function runOneInvestigation(
  input: RunInvestigationInput,
  ctx: InvestigationContext,
  opts: { timeoutMs?: number } = {},
): Promise<InvestigationReport> {
  const { renv } = ctx;
  const rerank = loadReranker();
  const investigation = investigate(
    {
      hint: input.hint,
      repo: renv.project,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.logsSince !== undefined ? { logsSince: input.logsSince } : {}),
      ...((input.service ?? ctx.service) !== undefined
        ? { service: input.service ?? ctx.service }
        : {}),
      // Invocation-time Shopify queries override the connector's config defaults; when
      // omitted the provider falls back to `connectors.shopify.queries` (e.g. under watch).
      ...(input.shopifyQueries !== undefined ? { shopifyQueries: input.shopifyQueries } : {}),
    },
    {
      code: ctx.code,
      db: ctx.dbHandle.db,
      // HOR-432 — the authored-memory store so every investigation auto-captures a recurrence-aware
      // memory. Best-effort + CONTEXT-ONLY in the engine (never feeds scoring, never blocks delivery).
      store: createLocalMemoryStore(ctx.dbHandle.db),
      logs: ctx.logs,
      mongo: ctx.mongo,
      postgres: ctx.postgres,
      sentry: ctx.sentry,
      axiom: ctx.axiom,
      shopify: ctx.shopify,
      queue: ctx.queue,
      redisState: ctx.redisState,
      metrics: ctx.metrics,
      repoPath: renv.path,
      connectors: {
        elasticsearch: !!renv.connectors.elasticsearch?.url,
        grafana: !!renv.connectors.grafana?.url,
        mongodb: !!renv.connectors.mongodb?.url,
        postgres: !!renv.connectors.postgres?.url,
        sentry: !!renv.connectors.sentry,
        axiom: !!renv.connectors.axiom,
        shopify: !!renv.connectors.shopify,
        redis: !!renv.connectors.redis?.url,
        queue: !!ctx.queue,
      },
      // HOR-404: inject the learned reranker only when enabled + proven (loadReranker gates both);
      // CONTEXT-ONLY — it reorders eligible causes, never touches confidence/verdict/ceilings.
      ...(rerank ? { rerank } : {}),
    },
  );

  const timeoutMs =
    opts.timeoutMs ??
    (Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) || 120) * 1000;
  return withDeadline(investigation, timeoutMs);
}

/**
 * Close EVERY connector + the DB. An unclosed pg/ioredis handle keeps the Node event loop
 * alive, so the CLI prints its output but never exits. Idempotent-friendly: each close is
 * guarded and best-effort.
 */
export async function disposeInvestigationContext(ctx: InvestigationContext): Promise<void> {
  await safeClose(() => ctx.dbHandle.sql.end());
  if (ctx.mongo) await safeClose(() => ctx.mongo!.close());
  if (ctx.postgres) await safeClose(() => ctx.postgres!.close());
  if (ctx.redisState) await safeClose(() => ctx.redisState!.close());
  if (ctx.queue) await safeClose(() => ctx.queue!.close());
}

async function safeClose(fn: () => Promise<void> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort teardown — never throw past shutdown
  }
}

/**
 * Resolve `p`, or reject after `ms` with a clear, actionable message. The underlying work
 * is left to be torn down by process exit — this exists so a hung connector (e.g. a dropped
 * tunnel/port-forward, or a stuck source-intelligence query) can never hang the CLI forever.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Investigation exceeded ${Math.round(ms / 1000)}s and was aborted. A runtime connector ` +
            `is likely unreachable (e.g. a dropped SSH tunnel / port-forward) or the source-` +
            `intelligence host is slow. Re-run, or raise --timeout <seconds>.`,
        ),
      );
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
