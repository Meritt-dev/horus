/**
 * HOR-70 — Runtime source status report.
 *
 * Summarises which evidence sources contributed to an investigation:
 * whether each connector was configured, how many evidence items it
 * produced, and whether collection succeeded or failed.
 */

import type { Evidence } from '@horus/core';
import type { ConnectorFlags } from './gaps.js';

export type RuntimeSourceKind = 'logs' | 'metrics' | 'state' | 'queue';
/**
 * `unavailable` = configured in the project config but the provider could not be
 * constructed for this run (missing secret / unset URL env). A different truth from
 * `not-configured` (no stanza) and from `failed` (provider ran and threw).
 */
export type RuntimeSourceStatus = 'contributed' | 'empty' | 'failed' | 'not-configured' | 'unavailable';

export interface RuntimeSourceEntry {
  source: RuntimeSourceKind;
  /** Whether the connector for this source was configured for the investigation. */
  configured: boolean;
  /** Number of runtime evidence items contributed by this source. */
  evidenceCount: number;
  status: RuntimeSourceStatus;
  /** Human-readable failure detail when status is 'failed'. */
  detail?: string;
}

export interface RuntimeSourceReport {
  sources: RuntimeSourceEntry[];
}

function buildEntry(
  source: RuntimeSourceKind,
  configured: boolean,
  evidenceCount: number,
  failed: boolean,
  detail?: string,
  unavailable = false,
): RuntimeSourceEntry {
  let status: RuntimeSourceStatus;
  if (!configured) {
    status = 'not-configured';
  } else if (unavailable && evidenceCount === 0) {
    status = 'unavailable';
  } else if (failed) {
    status = 'failed';
  } else if (evidenceCount > 0) {
    status = 'contributed';
  } else {
    status = 'empty';
  }
  const entry: RuntimeSourceEntry = { source, configured, evidenceCount, status };
  if (detail) entry.detail = detail;
  return entry;
}

/**
 * Build a runtime source status report from the collected evidence and
 * connector flags that were active during the investigation.
 *
 * Queue evidenceCount counts only `kind === 'queue-state'` (operational
 * queue snapshot evidence) — not `queue-edge` which is structural topology
 * produced by the stitcher, not a runtime signal.
 */
export function buildRuntimeSourceStatus(
  evidence: Evidence[],
  connectors: ConnectorFlags,
): RuntimeSourceReport {
  // 'logs' is the runtime ERROR-evidence source — Elasticsearch, Sentry, and/or Axiom
  // all feed it (their evidence is `source: 'logs'`). Configured = ANY is wired up; failed
  // = a configured collector that did not run to completion and produced no evidence.
  // Axiom is credited here exactly like ES/Sentry so the report header can no longer claim
  // "logs not configured" when configured-and-collected Axiom log evidence is present.
  const logsCount = evidence.filter((e) => e.source === 'logs').length;
  const logsConfigured = !!(connectors.elasticsearch || connectors.sentry || connectors.axiom);
  const esFailed = !!connectors.elasticsearch && !connectors.logsCollected;
  const sentryFailed = !!connectors.sentry && !connectors.sentryCollected;
  const axiomFailed = !!connectors.axiom && !connectors.axiomCollected;
  const logsFailed = logsConfigured && logsCount === 0 && (esFailed || sentryFailed || axiomFailed);

  const metricsCount = evidence.filter((e) => e.source === 'metrics').length;
  const metricsConfigured = !!connectors.grafana;
  const metricsFailed = metricsConfigured && !connectors.metricsCollected;

  const stateCount = evidence.filter((e) => e.source === 'state').length;
  // Shopify Admin evidence is application `state` (its default kind), so a configured
  // Shopify credits the state source exactly like Redis/Mongo/Postgres.
  const stateConfigured = !!(
    connectors.redis ||
    connectors.mongodb ||
    connectors.postgres ||
    connectors.shopify
  );
  // Failed only on an EXPLICIT collection failure with nothing contributed — strict
  // `=== false` so old reports lacking the flags (undefined) still read 'empty', and
  // a partial success (one provider threw, another contributed) reads 'contributed'.
  const shopifyFailed = !!connectors.shopify && connectors.shopifyCollected === false;
  const stateFailed =
    stateConfigured && stateCount === 0 && (connectors.stateCollected === false || shopifyFailed);
  const stateDetailParts = [
    ...(connectors.stateFailureReason ? [connectors.stateFailureReason] : []),
    ...(shopifyFailed && connectors.shopifyFailureReason
      ? [`shopify: ${connectors.shopifyFailureReason}`]
      : []),
  ];
  const stateDetail =
    stateFailed && stateDetailParts.length > 0 ? stateDetailParts.join('; ') : undefined;

  // Queue: configured when the BullMQ/queues connector is wired up (HOR-205) —
  // not merely when queue evidence happens to exist. An investigation whose hint
  // matched no static queue edge (and surfaced no live anomaly) would otherwise be
  // reported as "queue not configured" even though `queues --live` can read it.
  // Fall back to evidence presence for pre-HOR-205 reports lacking the flag.
  const queueConfigured = connectors.queue ?? evidence.some((e) => e.source === 'queue');
  const queueCount = evidence.filter((e) => e.kind === 'queue-state').length;
  const queueFailed = !!connectors.queue && queueCount === 0 && connectors.queueCollected === false;

  // Configured-but-unavailable (missing secret/URL env — engine computes the list from
  // config flags vs constructed providers): a source is unavailable when EVERY connector
  // configured for it is unavailable.
  const un = new Set(connectors.unavailable ?? []);
  const logsUnavailable =
    logsConfigured &&
    (!connectors.elasticsearch || un.has('elasticsearch')) &&
    (!connectors.sentry || un.has('sentry')) &&
    (!connectors.axiom || un.has('axiom')) &&
    un.size > 0;
  const metricsUnavailable = metricsConfigured && un.has('grafana');
  const stateUnavailable =
    stateConfigured &&
    (!connectors.redis || un.has('redis')) &&
    (!connectors.mongodb || un.has('mongodb')) &&
    (!connectors.postgres || un.has('postgres')) &&
    (!connectors.shopify || un.has('shopify')) &&
    un.size > 0;

  return {
    sources: [
      // Compatibility error keeps precedence over the generic failure category (its
      // docstring guarantees the more specific mapping diagnosis wins).
      buildEntry(
        'logs',
        logsConfigured,
        logsCount,
        logsFailed,
        connectors.logsCompatibilityError ?? connectors.logsFailureReason,
        logsUnavailable,
      ),
      buildEntry('metrics', metricsConfigured, metricsCount, metricsFailed, connectors.metricsFailureReason, metricsUnavailable),
      buildEntry('state', stateConfigured, stateCount, stateFailed, stateDetail, stateUnavailable),
      buildEntry('queue', queueConfigured, queueCount, queueFailed, queueFailed ? connectors.queueFailureReason : undefined),
    ],
  };
}
