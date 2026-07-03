/**
 * HOR-24 — Deterministic competing-hypothesis generation.
 *
 * Generates a fixed set of competing hypotheses so the investigation never
 * anchors on a single explanation. Hypotheses are always emitted (even
 * unsupported ones), with their missing evidence listed so the analyst knows
 * exactly what data would confirm or refute each candidate.
 *
 * Pure and synchronous; no I/O, no randomness beyond the UUID generator.
 */

import type { Evidence } from '@horus/core';
import type { CorrelationResult } from './correlate.js';
import type { InvestigationGraph } from './graph.js';
import { implicatedEvidenceIdsByNodeType } from './graph.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Hypothesis {
  id: string;
  category: string;
  statement: string;
  /** 0–1 prior confidence derived deterministically from available evidence. */
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
}

// ---------------------------------------------------------------------------
// Context supplied by the engine
// ---------------------------------------------------------------------------

export interface HypothesisContext {
  /** Human-readable label for the seed symbol (e.g. "OrderService"). */
  seedLabel: string;
  /** Distinct queue names that appear in the implicated queue-edge evidence. */
  queues: string[];
  /** Metric evidence IDs with latency-spike or error-rate-change anomalies (HOR-40). */
  latencyMetricEvIds?: string[];
  /**
   * Per-queue runtime signal evidence IDs (HOR-45).
   * Using maps rather than flat arrays ensures evidence from one queue cannot
   * appear in a hypothesis that names a different queue.
   */
  queueBacklogEvIdsByQueue?: Map<string, string[]>;
  queueStarvationEvIdsByQueue?: Map<string, string[]>;
  queueMetricEvIdsByQueue?: Map<string, string[]>;
  /**
   * True when the caller already supplied a `--since` value.
   * Suppresses "re-run with --since" from the deployment-regression missing-evidence
   * list — redundant advice when the user already provided a range.
   */
  sinceProvided?: boolean;
  /**
   * HOR-385 (source-impact mode): when true, the runtime/incident hypotheses
   * (deployment-regression, per-queue backlog/worker-slowdown, external-api-latency,
   * retry-storm, infrastructure) are NOT emitted — a "what depends on X / is X isolated"
   * question is structural, so a regression/latency framing would be noise. Default
   * undefined/false ⇒ the full competing set is generated exactly as before.
   */
  suppressRuntimeHypotheses?: boolean;
  /**
   * HOR-406 (round 2): true only when the most-recent in-window change is RELEVANT to the seed —
   * a non-noise commit (not bot/merge/release/pre-commit-autoupdate) that actually touches the
   * seed's file within a non-trivial diff. The deployment-regression hypothesis earns its full
   * 0.5 base AND the commit evidence as support (which the validator lifts toward ~0.8, and which
   * promotes it to `supported` so a cause-chain is narrated) ONLY when this holds. An irrelevant
   * most-recent change (a dependabot bump, a pure merge, a "Prepare release", a pre-commit
   * autoupdate, or a +0/-0 no-op) deflates the hypothesis to the un-boosted 0.15 base with NO
   * supporting commit evidence and an honest statement — so the Hypotheses + Cause-chains sections
   * never contradict the relevance-gated suspected-causes ranking ("none touched <seed>"). Absent
   * (undefined) ⇒ treated as relevant, preserving the legacy commit-present behaviour for callers
   * that do not compute relevance.
   */
  recentChangeRelevant?: boolean;
  /**
   * HOR-451 propagation: the files-touched count of the most-focused seed-touching commit
   * (`seedTouchingCommitFocus`), and whether that makes the change BROAD churn
   * (> BROAD_CHANGE_FILE_THRESHOLD). A relevant-but-broad change (a 22-file integration that
   * incidentally touched the seed) must NOT produce a supported deployment-regression
   * hypothesis while the cause ranking says "no specific cause identified — broad change".
   * The hypothesis deflates to a low-confidence, unsupported statement so the validator
   * cannot promote it and no cause-chain is narrated for it. Absent ⇒ focused (legacy).
   */
  seedChangeFocus?: number | null;
  seedChangeBroad?: boolean;
  /**
   * True when the hint is a vague performance symptom with NO metrics backend and a
   * low-confidence seed — the engine demotes structural causes to "unconfirmed
   * structural guess" for such runs, and this hypothesis must deflate the same way
   * (no commit support, low confidence) so the sections cannot contradict.
   */
  vaguePerfGuess?: boolean;
  /**
   * Typed evidence graph built from all collected evidence.
   * When provided, hypothesis generation consults graph-derived implicated node sets
   * in addition to (not instead of) raw evidence kind checks, so topology links can
   * boost confidence for hypotheses even when per-kind evidence arrays are thin.
   */
  graph?: InvestigationGraph;
  /**
   * HOR-435 (lever #2/#4): evidence ids of per-dimension duration breakdowns
   * (`Duration by region: KSA 2m10s, UAE 19ms`). These SUPPORT the benign-variance
   * hypothesis — one segment slow while another is fast is the fingerprint of expected
   * per-segment variance, not a uniform failure.
   */
  perDimensionDurationEvIds?: string[];
  /**
   * HOR-435 (lever #3/#4): evidence ids of `bimodal-population` metric findings (a
   * high-spike cluster AND a low/zero cluster co-present on one panel). Also SUPPORT the
   * benign-variance hypothesis.
   */
  bimodalMetricEvIds?: string[];
  /**
   * HOR-438: evidence ids of code-detected per-segment queue STRUCTURE (one queue per
   * market/region/tenant/shard, e.g. `MANAGE_SALES:KSA` + `MANAGE_SALES:UAE`). The code
   * SHOWING per-segment processing is a real, code-grounded support for the benign-variance
   * hypothesis — an anomaly on one segment is more likely expected per-segment variance than
   * a uniform failure. It SUPPORTS benign-variance; it is never a verdict.
   */
  perSegmentQueueStructureEvIds?: string[];
  /**
   * HOR-435 (lever #4): emit the benign-variance hypothesis even with no supporting
   * evidence yet, so the competing set still names "this may be expected variance" on a
   * duration/latency/anomaly-themed investigation. When false/undefined the hypothesis is
   * emitted ONLY if per-dimension duration or bimodal-population evidence is present.
   */
  benignVarianceApplicable?: boolean;
  /**
   * HOR-435 (lever #1, de-anchor): hypothesis categories that the alert/hint TEXT merely
   * *suggested* ("could indicate a database issue / may be a retry storm"). Alert text is
   * CONTEXT-ONLY and is NEVER a confidence prior — a suggested category does NOT get a
   * higher prior here; the only effect is an honest annotation on the unsupported ones that
   * confidence must come from independent collected evidence, not the alert wording.
   */
  alertSuggestedCategories?: string[];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate the full competing set of hypotheses.
 *
 * Deterministic: given the same evidence + correlation + ctx, the same
 * hypothesis *objects* are produced (modulo the UUID values which are
 * inherently non-deterministic but do not affect logical content).
 *
 * The returned array is sorted by confidence descending (stable sort).
 */
export function generateHypotheses(
  evidence: Evidence[],
  _correlation: CorrelationResult,
  ctx: HypothesisContext,
): Hypothesis[] {
  // Per-commit timeline detail (`perCommit`) is excluded: the AGGREGATE change-range
  // evidence is the change signal; the bounded per-commit entries exist for the timeline
  // and must not multiply this hypothesis's apparent support.
  const commitEvs = evidence.filter(
    (e) =>
      e.kind === 'commit' &&
      (e.payload as { perCommit?: boolean } | null | undefined)?.perCommit !== true,
  );
  const queueEvs = evidence.filter((e) => e.kind === 'queue-edge');
  const hasCommit = commitEvs.length > 0;
  const { queues } = ctx;

  // HOR-410 (round 2): only name queue-runtime tooling when the repo actually has queue
  // topology. On synchronous / non-queue stacks (0 detected queues — most Python web,
  // Kafka-only, or library repos) the report must not invent a queue subsystem in its
  // missing-evidence/hypothesis phrasing. When topology IS present we still keep the
  // wording stack-neutral (`horus queues`) rather than asserting a specific broker
  // (BullMQ/Redis) we cannot confirm from edge topology alone.
  const hasQueueTopology = queues.length > 0;

  // ── Pre-compute cross-hypothesis signals ─────────────────────────────────────

  // Log spikes (ratio >= 2.0): doubled error rate is consistent with retry
  // amplification — if workers keep retrying failed operations, error counts escalate.
  const logSpikeEvIds = evidence
    .filter((e) => e.kind === 'log' && e.ratio !== undefined && e.ratio >= 2.0)
    .map((e) => e.id);

  // DB / application-state evidence: MongoDB state anomalies indicate infra-level
  // issues (document counts wrong, unexpected state) rather than pure code bugs.
  const stateEvIds = evidence.filter((e) => e.kind === 'state').map((e) => e.id);

  // Queue backlog: all queues accumulating work — consistent with retry amplification.
  const allQueueBacklogEvIds = [
    ...(ctx.queueBacklogEvIdsByQueue?.values() ?? []),
  ].flat();

  // Queue starvation: active === 0 and waiting >= threshold — workers stopped.
  // Starvation indicates infrastructure failure (worker process died, DB unreachable)
  // rather than retry amplification (which requires active workers).
  const allQueueStarvationEvIds = [
    ...(ctx.queueStarvationEvIdsByQueue?.values() ?? []),
  ].flat();

  // Graph-derived signals: evidence IDs attached to implicated node types.
  // These supplement raw evidence kind checks — a collection that is implicated via
  // graph topology (e.g. a MongoDB state anomaly) can contribute to the infrastructure
  // hypothesis even when the raw state evidence array is thin.
  // NOTE: We intentionally do NOT add graph-implicated service evidence to the
  // external-api-latency hypothesis — metric evidence has a service-scope guard in
  // the engine that prevents scope mismatch, and bypassing it via the graph path
  // would surface unscoped metric anomalies as causal evidence incorrectly.
  const graphImplicatedCollectionEvIds = ctx.graph
    ? implicatedEvidenceIdsByNodeType(ctx.graph, 'collection')
    : [];

  const hyps: Hypothesis[] = [];

  // HOR-385: in source-impact mode every hypothesis below is a runtime/incident framing
  // (regression, queue, latency, retry, infra) that is irrelevant to a structural
  // "what depends on X / is X isolated" question — emit none. Default off ⇒ incident path
  // is byte-identical.
  if (ctx.suppressRuntimeHypotheses === true) return hyps;

  // a. deployment-regression — always emitted.
  // HOR-406 (round 2): a present commit is NOT enough to inflate this cause. The 0.5 base + the
  // commit evidence as support (which the validator lifts toward ~0.8 and which promotes the
  // hypothesis to `supported`, narrating a "recent change introduced the fault" cause-chain) is
  // earned ONLY when the recent change is RELEVANT to the seed. An irrelevant most-recent change
  // (a dependabot bump, a pure merge, a "Prepare release", a pre-commit autoupdate, or a +0/-0
  // no-op) deflates to the un-boosted 0.15 base with NO supporting commit evidence and an honest
  // statement — so this section never contradicts the relevance-gated ranking. `undefined` ⇒
  // legacy behaviour (treated as relevant) for callers that do not compute relevance.
  const hasRelevantCommit = hasCommit && ctx.recentChangeRelevant !== false;
  // HOR-451 propagation: a relevant-but-BROAD change (diffuse churn that merely included the
  // seed's file) earns neither the 0.5 base nor the commit evidence as support — otherwise the
  // validator promotes it to `supported` + a narrated cause-chain while the cause ranking says
  // "no specific cause identified (broad change)": the exact internal contradiction this fixes.
  const broadChange = hasRelevantCommit && ctx.seedChangeBroad === true;
  // A vague perf hint (no metrics, low-confidence seed) deflates the same way broad
  // churn does — the cause ranking calls these "unconfirmed structural guess" and this
  // hypothesis must not stay `supported` against it.
  const vagueGuess = hasRelevantCommit && !broadChange && ctx.vaguePerfGuess === true;
  const regressionStatement = broadChange
    ? `A broad recent change (${ctx.seedChangeFocus} files) touched ${ctx.seedLabel}'s file, but breadth alone is weak evidence — not clearly linked to the symptom.`
    : vagueGuess
      ? 'A recent change touching ' +
        ctx.seedLabel +
        ' might relate to the performance symptom — unconfirmed structural guess (no metrics evidence, low-confidence seed).'
      : hasCommit && !hasRelevantCommit
        ? 'Changes shipped in the window but none touched ' +
          ctx.seedLabel +
          ' — a deployment regression of the seed is unlikely.'
        : 'A recent change/deployment touching ' + ctx.seedLabel + ' introduced the fault.';
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'deployment-regression',
    statement: regressionStatement,
    confidence: broadChange ? 0.25 : vagueGuess ? 0.3 : hasRelevantCommit ? 0.5 : 0.15,
    supportingEvidenceIds:
      hasRelevantCommit && !broadChange && !vagueGuess ? commitEvs.map((e) => e.id) : [],
    contradictingEvidenceIds: [],
    missingEvidence: broadChange
      ? ['Runtime evidence (logs/metrics) linking the broad change to the symptom — diff the change directly to narrow it']
      : vagueGuess
        ? ['Metrics evidence for the performance symptom — without it the change link stays an unconfirmed structural guess']
        : hasRelevantCommit
          ? []
          : hasCommit
            ? ['No in-window commit touched ' + ctx.seedLabel + ' — diff the actual change range or check upstream deps/data/config']
            : ctx.sinceProvided
              ? ['No git changes found in the specified range — verify the ref is accessible or use HEAD~N for exact commit ranges']
              : ['A change/deployment range — re-run with --since <ref> to diff what shipped'],
  });

  // b+c. Per-queue hypotheses — one pair (queue-backlog + worker-slowdown) per queue.
  // Evidence is scoped to each queue's own signals so an anomaly on 'orders'
  // cannot produce a supported hypothesis that also claims 'email' is backlogged.
  // Structural queue-edge evidence is intentionally excluded from supporting IDs.
  for (const queueName of queues) {
    const backlogEvIds = ctx.queueBacklogEvIdsByQueue?.get(queueName) ?? [];
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'queue-backlog',
      statement: `A backlog on ${queueName} — producers enqueue faster than the worker drains.`,
      confidence: backlogEvIds.length > 0 ? 0.7 : 0.35,
      supportingEvidenceIds: [...backlogEvIds],
      contradictingEvidenceIds: [],
      missingEvidence: backlogEvIds.length > 0
        ? []
        : ['Live queue depth + failed/delayed counts (`horus queues`)'],
    });

    const metricEvIds = ctx.queueMetricEvIdsByQueue?.get(queueName) ?? [];
    const starvationEvIds = ctx.queueStarvationEvIdsByQueue?.get(queueName) ?? [];
    const slowdownEvIds = [...metricEvIds, ...starvationEvIds];
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'worker-slowdown',
      statement: `The worker(s) consuming ${queueName} are processing slowly or stalling.`,
      confidence: slowdownEvIds.length > 0 ? 0.55 : 0.3,
      supportingEvidenceIds: slowdownEvIds,
      contradictingEvidenceIds: [],
      missingEvidence: slowdownEvIds.length > 0
        ? []
        : ['Worker latency/throughput metrics (Grafana — `horus metrics`)'],
    });
  }

  // d. external-api-latency — always emitted
  // Support: latency/error-rate metric evidence scoped by service (direct only).
  // Graph-derived service implication is intentionally excluded here — metric evidence
  // requires a service-scope match established by the engine before being wired to
  // this hypothesis, and bypassing that guard via graph topology would create false
  // positives when metrics exist but don't match the investigated service.
  const latencyMetricEvIds = ctx.latencyMetricEvIds ?? [];
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'external-api-latency',
    statement:
      'An upstream/external API the implicated code calls is slow or returning errors.',
    confidence: latencyMetricEvIds.length > 0 ? 0.55 : 0.2,
    supportingEvidenceIds: latencyMetricEvIds,
    contradictingEvidenceIds: [],
    missingEvidence: latencyMetricEvIds.length > 0
      ? []
      : ['Request latency metrics + error logs (`horus metrics` / `horus logs`)'],
  });

  // e. retry-storm — always emitted
  // Support: log spikes (escalating error rate is the fingerprint of retry amplification)
  //          + queue backlog (workers keep retrying, so queues fill up).
  // Contradiction: queue starvation (workers are stopped, so they CANNOT be retrying —
  //   starvation means infrastructure failure, not retry amplification).
  const retryStormSupport = [...new Set([...logSpikeEvIds, ...allQueueBacklogEvIds])];
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'retry-storm',
    statement: 'A retry storm is amplifying load on the failing path.',
    confidence: retryStormSupport.length > 0 ? 0.35 : 0.15,
    supportingEvidenceIds: retryStormSupport,
    contradictingEvidenceIds: allQueueStarvationEvIds,
    missingEvidence: retryStormSupport.length > 0
      ? []
      : hasQueueTopology
        ? ['Retry/error logs + queue retry statistics (`horus logs` / `horus queues`)']
        : ['Retry/error logs (`horus logs`)'],
  });

  // f. infrastructure — always emitted
  // Support: DB state anomalies (MongoDB signals), queue starvation (workers died),
  //          latency metric anomalies (slow responses = infra degradation), and
  //          evidence from graph-implicated collection nodes (MongoDB topology).
  const infraSupport = [
    ...new Set([
      ...stateEvIds,
      ...allQueueStarvationEvIds,
      ...(ctx.latencyMetricEvIds ?? []),
      ...graphImplicatedCollectionEvIds,
    ]),
  ];
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'infrastructure',
    statement:
      'An infrastructure issue (database, cache, or network) is degrading processing.',
    confidence: infraSupport.length > 0 ? 0.35 : 0.15,
    supportingEvidenceIds: infraSupport,
    contradictingEvidenceIds: [],
    missingEvidence: infraSupport.length > 0
      ? []
      : ['Infrastructure metrics + datastore/cache state (`horus metrics`)'],
  });

  // g. benign-variance (HOR-435, lever #4) — the anomaly may reflect EXPECTED per-segment/
  // per-region variance (or a skewed average), NOT a failure. This is the de-anchoring
  // counter-hypothesis to "the whole job regressed": when one region runs 2m10s while another
  // runs 19ms, the average is misleading and there may be nothing broken at all. Its base prior
  // is deliberately LOW (0.1) and rises ONLY with real evidence — the per-dimension duration
  // breakdown (#2), a bimodal-population metric signal (#3), and/or a code-detected per-segment
  // queue STRUCTURE (HOR-438: one queue per market/region/tenant ⇒ per-segment processing is
  // expected). It is never auto-confirmed: it competes for confidence, it does not win by default.
  const benignSupport = [
    ...new Set([
      ...(ctx.perDimensionDurationEvIds ?? []),
      ...(ctx.bimodalMetricEvIds ?? []),
      ...(ctx.perSegmentQueueStructureEvIds ?? []),
    ]),
  ];
  if (benignSupport.length > 0 || ctx.benignVarianceApplicable === true) {
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'benign-variance',
      statement:
        'The anomaly may reflect expected per-segment/per-region variance (or a skewed average), not a failure.',
      confidence: 0.1,
      supportingEvidenceIds: benignSupport,
      contradictingEvidenceIds: [],
      missingEvidence:
        benignSupport.length > 0
          ? []
          : [
              'Per-segment duration breakdown (region/market/tenant) or a bimodal metric distribution (`horus logs` / `horus metrics`)',
            ],
    });
  }

  // HOR-435 (lever #1, de-anchor): the alert/hint TEXT may *suggest* causes ("could indicate
  // a database issue / may be a retry storm"). Honesty invariant: alert/memory text is
  // CONTEXT-ONLY and NEVER a confidence prior. So a text-suggested category does NOT receive a
  // higher prior — its confidence is identical to what the collected evidence alone earns.
  // The only effect is an explicit annotation on the still-unsupported ones, so the report
  // makes the de-anchoring visible ("named by the alert, but not yet evidenced") instead of
  // silently letting the alert wording promote a red herring.
  const suggested = new Set(ctx.alertSuggestedCategories ?? []);
  if (suggested.size > 0) {
    for (const h of hyps) {
      if (suggested.has(h.category) && h.supportingEvidenceIds.length === 0) {
        h.missingEvidence = [
          ...h.missingEvidence,
          'Suggested by the alert/hint text — confidence requires independent evidence, not the alert wording itself',
        ];
      }
    }
  }

  // Sort by confidence descending (stable — JS Array.sort is stable in V8 / Node 11+)
  hyps.sort((a, b) => b.confidence - a.confidence);

  return hyps;
}
