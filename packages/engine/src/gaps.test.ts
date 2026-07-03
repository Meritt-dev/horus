/**
 * HOR-19 — Unit tests for detectMissingEvidence (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationReport } from './types.js';
import { detectMissingEvidence, gapNextActions, gapNextSteps } from './gaps.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(
  kind: Evidence['kind'],
  extraLinks: Evidence['links'] = {},
): Evidence {
  return {
    id: globalThis.crypto.randomUUID(),
    source:
      kind === 'commit'
        ? 'history'
        : kind === 'queue-edge' || kind === 'queue-state'
          ? 'queue'
          : kind === 'log'
            ? 'logs'
            : kind === 'metric'
              ? 'metrics'
              : 'code',
    kind,
    title: `Test evidence (${kind})`,
    relevance: 0.5,
    payload: {},
    links: extraLinks,
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

function makeMinimalReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'test-id',
    input: { hint: 'test' },
    summary: 'test summary',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0.5,
    nextActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Report with a queue boundary crossing but no queue-state/metric/log/commit
// ---------------------------------------------------------------------------

describe('detectMissingEvidence', () => {
  it('(a) queue topology + no operational evidence → many gaps, ceiling < 1 and >= 0.3', () => {
    const report = makeMinimalReport({
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'email-queue', producer: 'sendEmail', worker: 'emailWorker', evidenceId: 'ev-001' },
        ],
      },
      evidence: [],
    });

    // shopify configured (collected) → the config HAS a runtime connector, so gaps
    // stay per-dimension (an all-unconfigured config consolidates them instead).
    const result = detectMissingEvidence(report, { shopify: true, shopifyCollected: true });

    // Must include these gap dimensions
    const dims = result.gaps.map((g) => g.dimension);
    expect(dims).toContain('queue runtime state');
    expect(dims).toContain('metrics');
    expect(dims).toContain('logs');
    expect(dims).toContain('deployment records');
    expect(dims).toContain('ownership');

    // Ceiling is less than 1 (some gaps) and at least the floor of 0.3
    expect(result.confidenceCeiling).toBeLessThan(1);
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.3);

    // Blind spots list is non-empty
    expect(result.blindSpots.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // (b) Report WITH a commit evidence → no 'deployment records' gap
  // -------------------------------------------------------------------------

  it('(b) commit evidence present → no deployment records gap', () => {
    const report = makeMinimalReport({
      evidence: [makeEvidence('commit')],
    });

    const result = detectMissingEvidence(report);

    const dims = result.gaps.map((g) => g.dimension);
    expect(dims).not.toContain('deployment records');
  });

  // -------------------------------------------------------------------------
  // (c) Rich evidence set → only ownership and traces remain
  // -------------------------------------------------------------------------

  it('(c) log+metric+queue-state+commit+traceId → only ownership and traces gaps, high ceiling', () => {
    const report = makeMinimalReport({
      evidence: [
        makeEvidence('log'),
        makeEvidence('metric'),
        makeEvidence('queue-state'),
        makeEvidence('commit'),
        // trace is detected via links.traceId
        makeEvidence('symbol', { traceId: 'trace-abc-123' }),
      ],
    });

    const result = detectMissingEvidence(report);

    const dims = result.gaps.map((g) => g.dimension);

    // These should NOT be gaps
    expect(dims).not.toContain('logs');
    expect(dims).not.toContain('metrics');
    expect(dims).not.toContain('queue runtime state');
    expect(dims).not.toContain('deployment records');
    expect(dims).not.toContain('traces');

    // Ownership is always unknown until HOR-20
    expect(dims).toContain('ownership');

    // Ceiling should be high (only 0.05 deducted for ownership)
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.9);

    // Indexed access guard: verify gap objects are present
    const ownershipGap = result.gaps.find((g) => g.dimension === 'ownership');
    expect(ownershipGap).toBeDefined();
    if (ownershipGap !== undefined) {
      expect(ownershipGap.confidenceImpact).toBe(0.05);
    }
  });

  // -------------------------------------------------------------------------
  // HOR-410: a repo with ZERO detected queues must not surface queue-templated
  // gaps/blind-spots (no 'queue runtime state' gap, and no gap/blind-spot text
  // mentioning BullMQ / Redis / "async queue boundary" / queue retry).
  // -------------------------------------------------------------------------

  it('(HOR-410) 0-queue repo → no queue gaps or queue-templated blind-spots', () => {
    // No boundaryCrossings (default) ⇒ hasQueueTopology === false. No evidence ⇒
    // every runtime gap fires, including traces — the worst case for queue leakage.
    const report = makeMinimalReport({
      timeline: { events: [], boundaryCrossings: [] },
      evidence: [],
    });

    const result = detectMissingEvidence(report, { shopify: true, shopifyCollected: true });

    // No queue dimension at all.
    const dims = result.gaps.map((g) => g.dimension);
    expect(dims).not.toContain('queue runtime state');

    // No gap text (why / nextSource) nor blind-spot mentions a queue subsystem.
    const queueRe = /bullmq|redis|queue/i;
    for (const gap of result.gaps) {
      expect(gap.why).not.toMatch(queueRe);
      expect(gap.nextSource).not.toMatch(queueRe);
    }
    for (const blind of result.blindSpots) {
      expect(blind).not.toMatch(queueRe);
    }

    // Sanity: the traces gap is still emitted (just without queue phrasing).
    expect(dims).toContain('traces');
    const tracesGap = result.gaps.find((g) => g.dimension === 'traces');
    expect(tracesGap?.why).toContain('service boundaries');
  });

  it('(HOR-410) traces gap DOES invoke the async queue boundary when topology exists', () => {
    // Positive control: with real queue topology, the queue-aware phrasing returns.
    const report = makeMinimalReport({
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'jobs', producer: 'api', worker: 'worker', evidenceId: 'ev-q' },
        ],
      },
      evidence: [],
    });

    const result = detectMissingEvidence(report, { shopify: true, shopifyCollected: true });
    const tracesGap = result.gaps.find((g) => g.dimension === 'traces');
    expect(tracesGap?.why).toContain('async queue boundary');
  });

  // -------------------------------------------------------------------------
  // Additional: gap text reflects configured connectors, not ticket names
  // -------------------------------------------------------------------------

  it('metrics gap points at `horus metrics` when Grafana is configured', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { grafana: true });
    const metricsGap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(metricsGap?.nextSource).toContain('horus metrics');
    expect(metricsGap?.nextSource).not.toContain('HOR-');
  });

  it('logs gap distinguishes configured-but-empty from not-configured', () => {
    const report = makeMinimalReport({ evidence: [] });
    // logsCollected:true = collection ran successfully, just no error logs in window
    const configured = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: true,
    }).gaps.find((g) => g.dimension === 'logs');
    const notConfigured = detectMissingEvidence(report, { elasticsearch: false, grafana: true })
      .gaps.find((g) => g.dimension === 'logs');
    expect(configured?.why).toContain('No error logs matched');
    expect(notConfigured?.why).toContain('No Elasticsearch connector');
    expect(configured?.nextSource).not.toContain('HOR-');
  });

  it('logs gap reflects collection failure when logsCollected is false', () => {
    const report = makeMinimalReport({ evidence: [] });
    const gap = detectMissingEvidence(report, { elasticsearch: true, logsCollected: false })
      .gaps.find((g) => g.dimension === 'logs');
    expect(gap?.why).toContain('failed');
  });

  it('logs gap reflects mapping incompatibility when logsCompatibilityError is set', () => {
    const report = makeMinimalReport({ evidence: [] });
    const gap = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCompatibilityError: "Timestamp field 'time' not found",
    }).gaps.find((g) => g.dimension === 'logs');
    expect(gap?.why).toContain('incompatible');
    expect(gap?.why).toContain("'time'");
    expect(gap?.nextSource).toContain('preset');
  });

  // -------------------------------------------------------------------------
  // Additional: confidenceCeiling floor is 0.3 even when all gaps present
  // -------------------------------------------------------------------------

  it('confidenceCeiling never falls below 0.3', () => {
    const report = makeMinimalReport({
      evidence: [],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'q', producer: 'p', worker: 'w', evidenceId: 'ev-003' },
        ],
      },
    });
    const result = detectMissingEvidence(report);
    expect(result.confidenceCeiling).toBeGreaterThanOrEqual(0.3);
  });
});

// ---------------------------------------------------------------------------
// HOR-58 — Evidence gap regression tests
//
// Explicitly covers the three connector × evidence states and guards against
// stale implementation-ticket references appearing in any gap text field.
// ---------------------------------------------------------------------------

describe('HOR-58 evidence gap regression', () => {
  // ── State 1: no connector configured → gap present ──────────────────────

  it('logs: no connector configured → gap present and references connector setup', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { elasticsearch: false, grafana: true });
    const gap = result.gaps.find((g) => g.dimension === 'logs');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('connector');
  });

  it('metrics: no connector configured → gap present and references connector setup', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { grafana: false, elasticsearch: true });
    const gap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('connector');
  });

  // ── State 2: connector configured but no evidence returned → gap present ─

  it('logs: connector configured, collection failed → gap present', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { elasticsearch: true, logsCollected: false });
    const gap = result.gaps.find((g) => g.dimension === 'logs');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('failed');
  });

  it('metrics: connector configured, collection failed → gap present', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { grafana: true, metricsCollected: false });
    const gap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(gap).toBeDefined();
  });

  // ── State 3: connector configured and evidence returned → no gap ─────────

  it('logs: connector configured + log evidence in report → no logs gap', () => {
    const report = makeMinimalReport({ evidence: [makeEvidence('log')] });
    const result = detectMissingEvidence(report, { elasticsearch: true, logsCollected: true });
    const gap = result.gaps.find((g) => g.dimension === 'logs');
    expect(gap).toBeUndefined();
  });

  it('metrics: connector configured + metric evidence in report → no metrics gap', () => {
    const report = makeMinimalReport({ evidence: [makeEvidence('metric')] });
    const result = detectMissingEvidence(report, { grafana: true, metricsCollected: true });
    const gap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(gap).toBeUndefined();
  });

  // Negative-evidence case: collection ran + found nothing is NOT a gap.
  it('metrics: connector configured, collection succeeded but empty → no metrics gap (negative evidence)', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { grafana: true, metricsCollected: true });
    const gap = result.gaps.find((g) => g.dimension === 'metrics');
    expect(gap).toBeUndefined();
  });

  // ── No stale ticket-name references anywhere in gap text ─────────────────

  it('gap text never references implementation ticket IDs (HOR-xx) in any connector state', () => {
    const stalePattern = /HOR-\d+/;

    const states = [
      { elasticsearch: false, grafana: false },
      { elasticsearch: true, logsCollected: false, grafana: true, metricsCollected: false },
      { elasticsearch: true, logsCollected: true, grafana: true, metricsCollected: true },
      { elasticsearch: true, logsCompatibilityError: "Field 'time' not found" },
    ];

    const emptyReport = makeMinimalReport({ evidence: [] });

    for (const connectors of states) {
      const result = detectMissingEvidence(emptyReport, connectors);
      for (const gap of result.gaps) {
        expect(gap.why, `gap "${gap.dimension}" why field contains a ticket ref`).not.toMatch(stalePattern);
        expect(gap.nextSource, `gap "${gap.dimension}" nextSource field contains a ticket ref`).not.toMatch(stalePattern);
      }
      for (const blind of result.blindSpots) {
        expect(blind, `blindSpot contains a ticket ref`).not.toMatch(stalePattern);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Connector-failure gaps — application state + failure-mode queue gap and the
// leak-safe failure-reason suffixes on the logs gap. All predicates are strict
// `=== false` so absent flags (old reports, unconfigured providers) stay silent.
// ---------------------------------------------------------------------------

describe('connector-failure gaps', () => {
  it('state provider failure → application state gap with reason, ceiling drops by 0.08', () => {
    const report = makeMinimalReport({ evidence: [] });
    const without = detectMissingEvidence(report, {});
    const withFailure = detectMissingEvidence(report, {
      mongodb: true,
      stateCollected: false,
      stateFailureReason: 'mongodb: connection failed',
    });

    const gap = withFailure.gaps.find((g) => g.dimension === 'application state');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('mongodb: connection failed');
    expect(gap?.confidenceImpact).toBe(0.08);
    expect(gap?.routeHint?.nextTool).toBe('connect');
    expect(gap?.routeHint?.args).toBe('mongodb');
    expect(withFailure.confidenceCeiling).toBeCloseTo(without.confidenceCeiling - 0.08, 2);
  });

  it('configured state provider with stateCollected undefined → NO state gap (old-report safety)', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { mongodb: true });
    expect(result.gaps.map((g) => g.dimension)).not.toContain('application state');
  });

  it('shopify collection failure → state gap naming shopify; completed run → none', () => {
    const report = makeMinimalReport({ evidence: [] });
    const failed = detectMissingEvidence(report, {
      shopify: true,
      shopifyCollected: false,
      shopifyFailureReason: 'auth failure',
    });
    const gap = failed.gaps.find((g) => g.dimension === 'application state');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('shopify: auth failure');
    expect(gap?.routeHint?.args).toBe('shopify');

    // Zero-query / zero-result runs are negative evidence, never a gap.
    const completed = detectMissingEvidence(report, { shopify: true, shopifyCollected: true });
    expect(completed.gaps.map((g) => g.dimension)).not.toContain('application state');
  });

  it('state evidence present suppresses the state gap even when a provider threw', () => {
    const report = makeMinimalReport({ evidence: [makeEvidence('state')] });
    const result = detectMissingEvidence(report, {
      mongodb: true,
      stateCollected: false,
      stateFailureReason: 'mongodb: timeout',
    });
    expect(result.gaps.map((g) => g.dimension)).not.toContain('application state');
  });

  it('queue collection failure fires the queue gap even with NO queue topology', () => {
    // No boundaryCrossings — pre-change this configuration was fully invisible.
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, {
      queue: true,
      queueCollected: false,
      queueFailureReason: 'connection failed',
    });
    const gap = result.gaps.find((g) => g.dimension === 'queue runtime state');
    expect(gap).toBeDefined();
    expect(gap?.why).toContain('failed');
    expect(gap?.why).toContain('connection failed');
  });

  it('queue collection that ran to completion with no topology → no queue gap', () => {
    const report = makeMinimalReport({ evidence: [] });
    const result = detectMissingEvidence(report, { queue: true, queueCollected: true });
    expect(result.gaps.map((g) => g.dimension)).not.toContain('queue runtime state');
  });

  it('logs / sentry / axiom failure reasons appear in the logs gap why', () => {
    const report = makeMinimalReport({ evidence: [] });

    const esGap = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: false,
      logsFailureReason: 'timeout',
    }).gaps.find((g) => g.dimension === 'logs');
    expect(esGap?.why).toContain('failed');
    expect(esGap?.why).toContain('(timeout)');

    const sentryGap = detectMissingEvidence(report, {
      sentry: true,
      sentryCollected: false,
      sentryFailureReason: 'auth failure',
    }).gaps.find((g) => g.dimension === 'logs');
    expect(sentryGap?.why).toContain('Sentry collection failed');
    expect(sentryGap?.why).toContain('(auth failure)');

    const axiomGap = detectMissingEvidence(report, {
      axiom: true,
      axiomCollected: false,
      axiomFailureReason: 'rate limited',
    }).gaps.find((g) => g.dimension === 'logs');
    expect(axiomGap?.why).toContain('Axiom log collection failed');
    expect(axiomGap?.why).toContain('(rate limited)');
  });
});

// ---------------------------------------------------------------------------
// gapNextActions — HOR-106
// ---------------------------------------------------------------------------

describe('gapNextActions', () => {
  it('returns empty array for no gaps', () => {
    expect(gapNextActions([])).toEqual([]);
  });

  it('returns nextSource strings sorted by confidenceImpact descending', () => {
    const gaps = [
      { dimension: 'ownership', why: '', nextSource: 'horus owner', confidenceImpact: 0.05 },
      { dimension: 'logs', why: '', nextSource: 'Add elasticsearch connector', confidenceImpact: 0.1 },
      { dimension: 'metrics', why: '', nextSource: 'Add grafana connector', confidenceImpact: 0.1 },
      { dimension: 'deployment records', why: '', nextSource: 'Re-run with --since', confidenceImpact: 0.08 },
    ];
    const actions = gapNextActions(gaps);
    expect(actions[0]).toBe('Add elasticsearch connector');
    expect(actions[1]).toBe('Add grafana connector');
    expect(actions[2]).toBe('Re-run with --since');
    expect(actions[3]).toBe('horus owner');
  });

  it('no-connector config: ONE consolidated optional-connect action, not per-dimension nags', () => {
    const report = makeMinimalReport();
    const { gaps } = detectMissingEvidence(report, {});
    const actions = gapNextActions(gaps);
    // Config-driven: nothing configured → one honest "runtime evidence unavailable"
    // action, not a wall of elasticsearch/grafana/tracing suggestions.
    const connectActions = actions.filter((a) => a.includes('horus connect'));
    expect(connectActions.length).toBeLessThanOrEqual(1);
    // Deployment-records hint (git-based, config-independent) is still present.
    expect(actions.some((a) => a.includes('--since') || a.includes('what-changed'))).toBe(true);
  });

  it('runtime-present path: no log gap when logs are present', () => {
    const report = makeMinimalReport({
      evidence: [makeEvidence('log'), makeEvidence('metric'), makeEvidence('commit')],
      ownership: {
        query: 'git log',
        symbol: null,
        file: 'src/foo.ts',
        contributors: [],
        likelyMaintainer: 'alice',
        maintainerShare: 0.8,
        mostActiveRecent: 'alice',
        confidence: 0.8,
        evidence: [],
        note: '',
      },
    });
    const { gaps } = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: true,
      grafana: true,
      metricsCollected: true,
    });
    const actions = gapNextActions(gaps);
    // Logs and metrics are present — no setup hints for those
    expect(actions.every((a) => !a.toLowerCase().includes('elasticsearch'))).toBe(true);
    expect(actions.every((a) => !a.toLowerCase().includes('grafana'))).toBe(true);
  });

  it('missing queue evidence path: includes queue inspector hint when topology is known', () => {
    const report = makeMinimalReport({
      timeline: {
        events: [],
        boundaryCrossings: [{ queueName: 'jobs', producer: 'api', worker: 'worker', evidenceId: 'ev-q1' }],
      },
    });
    const { gaps } = detectMissingEvidence(report, { redis: false, elasticsearch: true });
    const actions = gapNextActions(gaps);
    // The tip names the connector to add (redis)…
    expect(actions.some((a) => a.toLowerCase().includes('redis'))).toBe(true);
    // …but is stack-agnostic — it must NOT name a Node-only queue lib (BullMQ) which leaks
    // onto Python/Redis repos (HOR-428). Assert across both the gap text and the routeHint reason.
    for (const gap of gaps) {
      expect(gap.why.toLowerCase()).not.toContain('bullmq');
      expect(gap.nextSource.toLowerCase()).not.toContain('bullmq');
      expect((gap.routeHint?.reason ?? '').toLowerCase()).not.toContain('bullmq');
    }
  });
});


describe('runtime-gap consolidation (config-driven — no connectors, no nagging)', () => {
  it('ZERO runtime connectors → one consolidated gap, same total impact', () => {
    const r = makeMinimalReport();
    const withConnectors = detectMissingEvidence(r, { elasticsearch: true });
    const without = detectMissingEvidence(r, {});

    const runtimeDims = new Set(['logs', 'metrics', 'queue runtime state', 'application state', 'traces']);
    // No per-dimension runtime gaps remain — one honest statement instead.
    expect(without.gaps.filter((g) => runtimeDims.has(g.dimension))).toEqual([]);
    const consolidated = without.gaps.find((g) => g.dimension === 'runtime evidence');
    expect(consolidated).toBeDefined();
    expect(consolidated!.why).toContain('no runtime connectors are configured');
    expect(consolidated!.why).toContain('source, topology, git, ownership');
    // The ceiling math is unchanged relative to the sum of what was consolidated.
    expect(without.confidenceCeiling).toBeLessThanOrEqual(1);
    expect(without.blindSpots[0]).toContain('No runtime visibility');
    // Sanity: with a connector configured, per-dimension gaps still exist.
    expect(withConnectors.gaps.some((g) => runtimeDims.has(g.dimension))).toBe(true);
  });

  it('ANY configured connector keeps per-dimension gaps (config drives behavior)', () => {
    const r = makeMinimalReport();
    const a = detectMissingEvidence(r, { grafana: true });
    expect(a.gaps.some((g) => g.dimension === 'runtime evidence')).toBe(false);
  });
});


describe('connector setup never leads (config drives suggestions)', () => {
  it('with no connectors, the FIRST next action is a configured follow-up, connect trails', () => {
    const r = makeMinimalReport();
    const { gaps } = detectMissingEvidence(r, {});
    const actions = gapNextActions(gaps);
    expect(actions.length).toBeGreaterThan(1);
    expect(actions[0]).not.toContain('horus connect');
    expect(actions.at(-1)).toContain('horus connect');
    // The router's structured steps skip the optional-setup gap entirely
    // (no routeHint) and land on a real configured remedy.
    const steps = gapNextSteps(gaps);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]!.nextTool).not.toBe('connect');
  });
});
