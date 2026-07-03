/**
 * HOR-19 — Missing-evidence detector.
 *
 * Identifies what Horus does NOT know for a given investigation, why each gap
 * matters, where to obtain the missing data, and the deterministic confidence
 * impact. The resulting `GapAnalysis` caps `report.confidence` in engine.ts.
 */

import type { InvestigationReport, RouteStep } from './types.js';

/** Which connectors are configured for the active project/environment. */
export interface ConnectorFlags {
  elasticsearch?: boolean;
  grafana?: boolean;
  mongodb?: boolean;
  postgres?: boolean;
  /**
   * True when a Sentry error-tracking connector is configured for the env. Sentry is an
   * error source like Elasticsearch (its evidence is `kind: 'log'`), so a configured
   * Sentry that returns issues clears the logs gap. A configured-but-empty Sentry is
   * negative evidence, not a gap.
   */
  sentry?: boolean;
  /**
   * True when an Axiom logs connector is configured for the env. Axiom is a runtime
   * log source like Elasticsearch / Sentry (its evidence is `kind: 'log'`), so a
   * configured Axiom that returns rows clears the logs gap. A configured-but-empty
   * Axiom is negative evidence, not a gap.
   */
  axiom?: boolean;
  /**
   * True when a Shopify Admin connector is configured (auth present) for the env. Shopify
   * evidence is application `state` (orders/inventory/fulfillment), driven by queries the
   * caller supplies (`--shopify-query`) or config declares. A configured Shopify with no
   * queries / that returns nothing is negative evidence, not a gap.
   */
  shopify?: boolean;
  /**
   * True when Shopify query collection ran to completion (even with zero queries/results).
   * False/absent + shopify:true means collection was attempted but failed. Lets the gap
   * detector distinguish "no queries supplied / empty" from "collection failed".
   */
  shopifyCollected?: boolean;
  redis?: boolean;
  /**
   * True when a BullMQ/queues runtime connector is configured for the env — i.e. a
   * Redis DB with role `bullmq`/`queues` (or the single legacy DB) is wired up, the
   * same condition under which `horus queues --live` can read live state (HOR-205).
   * Distinguishes "queue connector not configured" from "configured but no live
   * queue evidence" so source status / caveats don't claim queues are unconfigured
   * when they are readable.
   */
  queue?: boolean;
  /**
   * True when log collection ran to completion (even with zero signatures).
   * False/absent + elasticsearch:true means collection failed or was blocked.
   * Lets the gap detector distinguish "no matching logs" from "collection failed".
   */
  logsCollected?: boolean;
  /**
   * Set when collection was blocked by a field-mapping incompatibility.
   * Short human-readable summary of the error(s). Takes precedence over the
   * generic "collection failed" gap text.
   */
  logsCompatibilityError?: string;
  /**
   * True when Sentry error collection ran to completion (even with zero issues).
   * False/absent + sentry:true means collection was attempted but failed. Lets the gap
   * detector distinguish "no open issues" (negative evidence) from "collection failed".
   */
  sentryCollected?: boolean;
  /**
   * True when Axiom log collection ran to completion (even with zero rows).
   * False/absent + axiom:true means collection was attempted but failed. Lets the gap
   * detector distinguish "no matching rows" (negative evidence) from "collection failed".
   */
  axiomCollected?: boolean;
  /**
   * True when metrics collection ran to completion (even with zero anomalies).
   * False/absent + grafana:true means collection was attempted but failed.
   * Lets the gap detector distinguish "no anomalies" from "collection failed".
   */
  metricsCollected?: boolean;
  /**
   * Short description of why metrics collection failed (e.g. "timeout",
   * "connection failed"). Only set when collection was attempted and failed.
   * Used to surface the exact failure reason in the gap analysis. Like every
   * *FailureReason below, this is a leak-safe CATEGORY (from
   * `connectorFailureReason`), never raw connector error text.
   */
  metricsFailureReason?: string;
  /**
   * Short leak-safe category of why log collection failed (e.g. "timeout",
   * "connection failed"). Only set when collection was attempted and failed.
   * Surfaced in the logs gap `why` alongside the generic failure text.
   */
  logsFailureReason?: string;
  /**
   * Short leak-safe category of why Sentry collection failed. Only set when
   * collection was attempted and failed. Surfaced in the logs gap `why`.
   */
  sentryFailureReason?: string;
  /**
   * Short leak-safe category of why Axiom collection failed. Only set when
   * collection was attempted and failed. Surfaced in the logs gap `why`.
   */
  axiomFailureReason?: string;
  /**
   * Short leak-safe category of why Shopify query collection failed. Only set
   * when collection was attempted and failed. Surfaced in the application-state gap.
   */
  shopifyFailureReason?: string;
  /**
   * True when ALL configured state providers (MongoDB / Postgres / Redis state)
   * ran to completion (even with zero signals). False when at least one threw.
   * Absent when none is configured — old persisted reports and provider-less
   * runs never produce a state gap. A configured-but-empty provider is negative
   * evidence, not a gap (HOR-33).
   */
  stateCollected?: boolean;
  /**
   * Provider-prefixed leak-safe failure categories for the state providers that
   * threw, e.g. "mongodb: connection failed; redis: timeout". Only set when
   * `stateCollected` is false.
   */
  stateFailureReason?: string;
  /**
   * True when live queue collection ran to completion (even with zero queues).
   * False/absent + queue:true means collection was attempted but failed. Lets the
   * gap detector distinguish "no live queue anomalies" from "collection failed".
   */
  queueCollected?: boolean;
  /**
   * Short leak-safe category of why live queue collection failed. Only set when
   * collection was attempted and failed. Surfaced in the queue-runtime-state gap.
   */
  queueFailureReason?: string;
  /**
   * True when the user already supplied a `--since` value.
   * Changes the "deployment records" gap text to avoid redundant "re-run with --since" advice.
   */
  sinceProvided?: boolean;
}

/** A single dimension of missing evidence and its investigation impact. */
export interface EvidenceGap {
  /** Short label for the missing dimension, e.g. 'logs'. */
  dimension: string;
  /** Context-aware sentence explaining why this gap matters for THIS investigation. */
  why: string;
  /** Where / how to obtain the missing data. */
  nextSource: string;
  /** How much this gap shaves off the confidence ceiling (0–1). */
  confidenceImpact: number;
  /**
   * HOR-386 — the REAL command that closes this gap, colocated with `nextSource` so the
   * router never has to maintain a separate dimension→tool table that can drift from the
   * gap text. `nextTool` is always a shipped `horus` command (`connect`, `logs`, `metrics`,
   * `queues`, `what-changed`, `owner`); `reason` mirrors `nextSource`. Omitted when no real
   * command exists for the gap (e.g. the `traces` gap — there is no `tracing` connector),
   * in which case the router simply skips routing for it. The router sorts gaps by
   * `confidenceImpact` and takes the top gap's `routeHint`.
   */
  routeHint?: RouteStep;
}

/** Structured output of the missing-evidence analysis. */
export interface GapAnalysis {
  gaps: EvidenceGap[];
  /** One human sentence per gap, describing what cannot be determined. */
  blindSpots: string[];
  /**
   * The maximum confidence the investigation can claim given the gaps.
   * = Math.max(0.3, 1 − Σ confidenceImpact), rounded to 2 dp.
   */
  confidenceCeiling: number;
}

/**
 * Analyse `r` to find missing evidence dimensions and compute the confidence
 * ceiling. Purely deterministic — same report always produces the same result.
 */
export function detectMissingEvidence(
  r: InvestigationReport,
  connectors: ConnectorFlags = {},
  /**
   * HOR-385: when `'source-impact'`, runtime evidence is irrelevant to the structural
   * question ("what depends on X / is X isolated"), so the runtime gaps (logs, metrics,
   * queue-state, deployment, traces) are NOT pushed and the confidence ceiling is forced
   * to 1.0 — a complete structural answer is not "missing" runtime data. Ownership (a
   * structural gap) is still surfaced for display. Default undefined ⇒ incident path
   * unchanged.
   */
  mode?: 'source-impact',
): GapAnalysis {
  const sourceImpact = mode === 'source-impact';
  // ── Presence flags ──────────────────────────────────────────────────────────
  const hasLog = r.evidence.some((e) => e.kind === 'log');
  const hasMetric = r.evidence.some((e) => e.kind === 'metric');
  const hasQueueState = r.evidence.some((e) => e.kind === 'queue-state');
  const hasCommit = r.evidence.some((e) => e.kind === 'commit');
  const hasTrace = r.evidence.some((e) => e.links != null && e.links.traceId != null);
  const hasQueueTopology = r.timeline.boundaryCrossings.length > 0;
  const ownershipKnown = r.ownership != null && r.ownership.likelyMaintainer != null;

  // HOR-386 — args for the colocated `routeHint` commands. The service scopes the
  // log/metric/what-changed remedies; the seed name targets the ownership remedy.
  const service = r.input.service ?? '';
  const seedName = r.seeds[0]?.name ?? '';

  const gaps: EvidenceGap[] = [];
  const blindSpots: string[] = [];

  // ── Candidate gaps — text reflects what's actually CONFIGURED, not tickets ──

  if (!hasLog && !sourceImpact) {
    let logWhy: string;
    let logNextSource: string;
    // Sentry and Axiom are additional ERROR/LOG sources (their evidence is also
    // `kind: 'log'`). Treat the "no runtime error evidence" gap as cleared/explained
    // by ANY of Elasticsearch / Sentry / Axiom.
    if (!connectors.elasticsearch && !connectors.sentry && !connectors.axiom) {
      logWhy = 'No Elasticsearch connector (nor Sentry / Axiom) configured for this environment — no runtime error evidence.';
      logNextSource = 'Add an `elasticsearch`, `sentry`, and/or `axiom` connector to the project/environment';
    } else if (!connectors.elasticsearch && connectors.sentry) {
      // ES absent but Sentry configured — the gap is purely about Sentry.
      const sentryDetail = connectors.sentryFailureReason
        ? ` (${connectors.sentryFailureReason})`
        : '';
      logWhy = connectors.sentryCollected
        ? 'No open Sentry issues matched in the window — cannot confirm the actual error signatures.'
        : `Sentry collection failed or timed out${sentryDetail} — cannot confirm the actual error signatures.`;
      logNextSource = connectors.sentryCollected
        ? 'Widen the window (--since) or check the Sentry project for open issues'
        : 'Check the Sentry auth token / project, then retry';
    } else if (!connectors.elasticsearch && connectors.axiom) {
      // ES (and Sentry) absent but Axiom configured — the gap is purely about Axiom.
      const axiomDetail = connectors.axiomFailureReason
        ? ` (${connectors.axiomFailureReason})`
        : '';
      logWhy = connectors.axiomCollected
        ? 'No Axiom log rows matched in the window — cannot confirm the actual error signatures.'
        : `Axiom log collection failed or timed out${axiomDetail} — cannot confirm the actual error signatures.`;
      logNextSource = connectors.axiomCollected
        ? 'Widen the window (--since) or check the Axiom dataset for matching rows'
        : 'Check the Axiom API token / dataset, then retry';
    } else if (connectors.logsCompatibilityError) {
      logWhy =
        `Elasticsearch field mapping is incompatible with the index — log collection was blocked. ` +
        connectors.logsCompatibilityError;
      logNextSource =
        'Fix fields.* overrides in your connector config or choose the correct preset (meritt / ecs)';
    } else if (!connectors.logsCollected) {
      const logsDetail = connectors.logsFailureReason
        ? ` (${connectors.logsFailureReason})`
        : '';
      logWhy = `Log collection failed or timed out${logsDetail} — cannot confirm the actual error signatures.`;
      logNextSource =
        'Check Elasticsearch connectivity, then run `horus logs <service>` manually';
    } else {
      logWhy = 'No error logs matched in the window — cannot confirm the actual error signatures.';
      logNextSource = 'Widen the window (--since) or inspect `horus logs <service>`';
    }
    // No error source configured at all → the real remedy is `connect`; otherwise the
    // source exists but returned nothing / failed → re-run `logs <service>`.
    const logRouteHint: RouteStep =
      !connectors.elasticsearch && !connectors.sentry && !connectors.axiom
        ? { nextTool: 'connect', args: 'elasticsearch', reason: logNextSource }
        : { nextTool: 'logs', args: service, reason: logNextSource };
    gaps.push({
      dimension: 'logs',
      why: logWhy,
      nextSource: logNextSource,
      confidenceImpact: 0.1,
      routeHint: logRouteHint,
    });
    blindSpots.push('Cannot see the real error.');
  }

  // Only add a metrics gap when metrics are genuinely missing.
  // Successful collection with no anomalies is negative evidence — not a gap.
  if (!hasMetric && !(connectors.grafana && connectors.metricsCollected) && !sourceImpact) {
    const failureDetail = connectors.metricsFailureReason
      ? ` (${connectors.metricsFailureReason})`
      : '';
    const metricsWhy = !connectors.grafana
      ? 'No Grafana connector configured — cannot see latency/error-rate trends.'
      : `Grafana metrics collection failed or timed out${failureDetail} — metric trends unavailable for this investigation.`;
    const metricsNextSource = !connectors.grafana
      ? 'Add a `grafana` connector to the environment'
      : 'Check Grafana connectivity, then run `horus metrics "<hint>"` manually';
    // No Grafana → `connect grafana`; configured but failed → re-run `metrics "<hint>"`.
    const metricsRouteHint: RouteStep = !connectors.grafana
      ? { nextTool: 'connect', args: 'grafana', reason: metricsNextSource }
      : { nextTool: 'metrics', args: service, reason: metricsNextSource };
    gaps.push({
      dimension: 'metrics',
      why: metricsWhy,
      nextSource: metricsNextSource,
      confidenceImpact: 0.1,
      routeHint: metricsRouteHint,
    });
    blindSpots.push('Cannot validate latency-based hypotheses.');
  }

  // A configured queue connector that threw is a real gap even on repos with no static
  // queue topology. Strict `=== false` — `queueCollected` is absent on old persisted
  // reports and provider-less runs, which must never fabricate a queue gap.
  const queueFailed = connectors.queue === true && connectors.queueCollected === false;
  if ((hasQueueTopology || queueFailed) && !hasQueueState && !sourceImpact) {
    const queueDetail = connectors.queueFailureReason
      ? ` (${connectors.queueFailureReason})`
      : '';
    gaps.push({
      dimension: 'queue runtime state',
      why: queueFailed
        ? `Live queue state collection failed${queueDetail} — depth/failed/delayed counts unavailable.`
        : connectors.redis
          ? 'Queue topology is known but live depth + failed/delayed counts were not collected.'
          : 'Queue topology is known but there is no Redis connector for live queue depth/failures.',
      // Stack-agnostic: the tip names Redis (the connector to add) but NOT a specific queue
      // library — "BullMQ" is Node-only and was leaking onto Python/Redis repos (HOR-428).
      nextSource: connectors.redis
        ? 'Run `horus queues --live` to see real-time queue depths and failed-job counts'
        : 'Add a `redis` connector to read live queue state',
      confidenceImpact: 0.1,
      // Redis wired → read live state with `queues --live`; otherwise `connect redis` first.
      routeHint: connectors.redis
        ? {
            nextTool: 'queues',
            args: '--live',
            reason: 'Run `horus queues --live` to see real-time queue depths and failed-job counts',
          }
        : {
            nextTool: 'connect',
            args: 'redis',
            reason: 'Add a `redis` connector to read live queue state',
          },
    });
    blindSpots.push('Cannot determine if the queue is actually backed up.');
  }

  // Failure-only application-state gap: fires when a configured state provider
  // (Mongo/Postgres/Redis state) or Shopify THREW and no state evidence exists. A
  // configured-but-empty provider is negative evidence, never a gap (HOR-33 / the
  // Shopify docstring). Strict `=== false` — the flags are absent on old persisted
  // reports and provider-less runs, which must stay gap-free.
  const hasState = r.evidence.some((e) => e.kind === 'state' || e.kind === 'redis-key');
  const shopifyFailed = connectors.shopify === true && connectors.shopifyCollected === false;
  const stateFailed = connectors.stateCollected === false || shopifyFailed;
  if (!hasState && stateFailed && !sourceImpact) {
    const stateReasons = [
      ...(connectors.stateFailureReason ? [connectors.stateFailureReason] : []),
      ...(shopifyFailed ? [`shopify: ${connectors.shopifyFailureReason ?? 'request failed'}`] : []),
    ];
    const stateDetail = stateReasons.length > 0 ? ` (${stateReasons.join('; ')})` : '';
    const stateNextSource =
      'Check the failing state connector auth/connectivity (horus connect <type>), then retry';
    // The remedy targets the FIRST failed connector, parsed from the provider-prefixed
    // reasons ("mongodb: connection failed; redis: timeout" → connect mongodb).
    const failedConnector =
      /^(mongodb|postgres|redis|shopify):/.exec(stateReasons[0] ?? '')?.[1] ?? 'mongodb';
    gaps.push({
      dimension: 'application state',
      why: `State collection failed${stateDetail} — cannot check for stuck/failed records behind the symptom.`,
      nextSource: stateNextSource,
      confidenceImpact: 0.08,
      routeHint: { nextTool: 'connect', args: failedConnector, reason: stateNextSource },
    });
    blindSpots.push('Cannot check application state for stuck or failed records.');
  }

  if (!hasCommit && !sourceImpact) {
    gaps.push({
      dimension: 'deployment records',
      why: connectors.sinceProvided
        ? 'No git changes found in the specified range — the ref may not be diffable or no commits fall in this window.'
        : 'No deployment/change data in scope — cannot tell what shipped before the incident.',
      nextSource: connectors.sinceProvided
        ? 'Use HEAD~N or a specific SHA/branch for git diff ranges (e.g. --since HEAD~5)'
        : 'Re-run with --since <ref>, or `horus what-changed <service>`',
      confidenceImpact: 0.08,
      // The real next command for "what shipped" is `what-changed <service>`.
      routeHint: {
        nextTool: 'what-changed',
        args: service,
        reason: connectors.sinceProvided
          ? 'Use HEAD~N or a specific SHA/branch for git diff ranges (e.g. --since HEAD~5)'
          : 'Re-run with --since <ref>, or `horus what-changed <service>`',
      },
    });
    blindSpots.push('Cannot correlate with a recent change.');
  }

  if (!ownershipKnown) {
    gaps.push({
      dimension: 'ownership',
      why: 'The owning team/maintainer of the implicated component is unknown.',
      nextSource: '`horus owner <symbol>` (git history)',
      confidenceImpact: 0.05,
      // Ownership maps to the REAL `owner` command (NOT `readiness`) so tool and reason agree.
      routeHint: {
        nextTool: 'owner',
        args: seedName,
        reason: '`horus owner <symbol>` (git history)',
      },
    });
    blindSpots.push('Cannot route to an owner.');
  }

  if (!hasTrace && !sourceImpact) {
    // HOR-410: only invoke the async queue boundary when the repo actually has queue
    // topology. For synchronous / non-queue codebases (0 detected queues) the boundary
    // a trace would cross is a service/process boundary, not a queue — claiming an "async
    // queue boundary" here is fabricated queue-templating. Gate the phrasing on real topology.
    gaps.push({
      dimension: 'traces',
      why: hasQueueTopology
        ? 'No distributed traces — cannot follow a single request across the async queue boundary.'
        : 'No distributed traces — cannot follow a single request across service boundaries.',
      nextSource: 'Tracing instrumentation',
      confidenceImpact: 0.07,
      // No `routeHint`: there is no `tracing` connector in `connect.ts` (SUPPORTED is
      // elasticsearch/mongodb/postgres/sentry/grafana/redis), so the router must NOT emit a
      // runnable-looking `connect tracing`. The router skips gaps without a routeHint.
    });
    blindSpots.push('Cannot trace the request end-to-end.');
  }

  // ── Confidence ceiling ───────────────────────────────────────────────────────
  let totalImpact = 0;
  for (const gap of gaps) {
    totalImpact += gap.confidenceImpact;
  }
  // HOR-385: a structural source-impact answer is complete — runtime gaps don't cap it.
  const raw = sourceImpact ? 1 : 1 - totalImpact;
  const confidenceCeiling = Math.round(Math.max(0.3, raw) * 100) / 100;

  return { gaps, blindSpots, confidenceCeiling };
}

/**
 * Converts gap `nextSource` hints into recommended next-action strings, sorted
 * by confidence impact (highest first). Safe to append directly to
 * `report.nextActions` — the strings are already action-phrased.
 */
export function gapNextActions(gaps: EvidenceGap[]): string[] {
  return [...gaps]
    .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
    .map((g) => g.nextSource);
}

/**
 * HOR-386 — structured sibling of `gapNextActions`. Sorts the gaps by `confidenceImpact`
 * (highest first — `detectMissingEvidence` pushes in fixed insertion order, NOT impact
 * order, so the router MUST sort here itself) and returns each gap's colocated `routeHint`.
 * Gaps without a real remedy (e.g. `traces`) are dropped — the router never fabricates a
 * command. The first element is the top gap's RouteStep the router routes low-confidence to.
 */
export function gapNextSteps(gaps: EvidenceGap[]): RouteStep[] {
  return [...gaps]
    .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
    .map((g) => g.routeHint)
    .filter((s): s is RouteStep => s != null);
}
