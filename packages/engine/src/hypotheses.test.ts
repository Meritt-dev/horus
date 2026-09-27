/**
 * HOR-24 — Unit tests for generateHypotheses (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { CorrelationResult } from './correlate.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(kind: Evidence['kind'], id?: string): Evidence {
  const source: Evidence['source'] =
    kind === 'commit' ? 'history'
    : kind === 'queue-edge' || kind === 'queue-state' ? 'queue'
    : kind === 'log' ? 'logs'
    : kind === 'metric' ? 'metrics'
    : kind === 'state' || kind === 'redis-key' ? 'state'
    : 'code';
  return {
    id: id ?? globalThis.crypto.randomUUID(),
    source,
    kind,
    title: `Test evidence (${kind})`,
    relevance: 0.5,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

const emptyCorrelation: CorrelationResult = {
  groups: [],
  chains: [],
  missing: [],
};

// ---------------------------------------------------------------------------
// Main tests
// ---------------------------------------------------------------------------

describe('generateHypotheses', () => {
  it('returns at least 6 hypotheses when both queue-edge and commit evidence are present', () => {
    const commitEv = makeEvidence('commit');
    const queueEv = makeEvidence('queue-edge');
    const evidence: Evidence[] = [commitEv, queueEv];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    expect(hyps.length).toBeGreaterThanOrEqual(6);
  });

  it('covers all required categories', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const categories = new Set(hyps.map((h) => h.category));
    expect(categories.has('deployment-regression')).toBe(true);
    expect(categories.has('queue-backlog')).toBe(true);
    expect(categories.has('worker-slowdown')).toBe(true);
    expect(categories.has('external-api-latency')).toBe(true);
    expect(categories.has('retry-storm')).toBe(true);
    expect(categories.has('infrastructure')).toBe(true);
  });

  it('deployment-regression includes the commit evidence id and has confidence 0.5 when commit exists', () => {
    const commitId = globalThis.crypto.randomUUID();
    const commitEv = makeEvidence('commit', commitId);
    const queueEv = makeEvidence('queue-edge');
    const evidence: Evidence[] = [commitEv, queueEv];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.supportingEvidenceIds).toContain(commitId);
    expect(dr!.confidence).toBe(0.5);
  });

  it('every hypothesis has a non-empty statement and confidence in [0, 1]', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    for (const h of hyps) {
      expect(h.statement.length).toBeGreaterThan(0);
      expect(h.confidence).toBeGreaterThanOrEqual(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('hypotheses are sorted by confidence descending', () => {
    const evidence: Evidence[] = [makeEvidence('commit'), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    for (let i = 0; i < hyps.length - 1; i++) {
      const a = hyps[i];
      const b = hyps[i + 1];
      // Guard noUncheckedIndexedAccess
      if (a !== undefined && b !== undefined) {
        expect(a.confidence).toBeGreaterThanOrEqual(b.confidence);
      }
    }
  });

  it('no-commit case: deployment-regression confidence is 0.15 and missingEvidence is non-empty', () => {
    // Only a queue-edge, no commit
    const evidence: Evidence[] = [makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.confidence).toBe(0.15);
    expect(dr!.missingEvidence.length).toBeGreaterThan(0);
    expect(dr!.missingEvidence[0]).toContain('--since');
  });

  it('HOR-406: an IRRELEVANT recent commit deflates deployment-regression (0.15, no support, unconfirmed, honest statement)', () => {
    const commitId = globalThis.crypto.randomUUID();
    const evidence: Evidence[] = [makeEvidence('commit', commitId), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      recentChangeRelevant: false,
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    // Even though commit evidence is present, an irrelevant change must NOT inflate the cause.
    expect(dr!.confidence).toBe(0.15);
    expect(dr!.supportingEvidenceIds).not.toContain(commitId);
    expect(dr!.supportingEvidenceIds).toHaveLength(0);
    // Honest statement — never "introduced the fault" off an irrelevant change.
    expect(dr!.statement).toContain('none touched X');
    expect(dr!.statement).not.toContain('introduced the fault');
    // The validator must leave it unconfirmed (no supporting evidence to boost / promote).
    const [validatedDr] = validateHypotheses([dr!], evidence);
    expect(validatedDr!.confidence).toBe(0.15);
    expect(validatedDr!.verdict).toBe('unconfirmed');
  });

  it('HOR-406: a RELEVANT recent commit still earns the boost (confidence 0.5, commit support)', () => {
    const commitId = globalThis.crypto.randomUUID();
    const evidence: Evidence[] = [makeEvidence('commit', commitId), makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      recentChangeRelevant: true,
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.confidence).toBe(0.5);
    expect(dr!.supportingEvidenceIds).toContain(commitId);
    expect(dr!.statement).toContain('introduced the fault');
    const [validatedDr] = validateHypotheses([dr!], evidence);
    expect(validatedDr!.confidence).toBeGreaterThan(0.5);
    expect(validatedDr!.verdict).toBe('supported');
  });

  it('sinceProvided suppresses "re-run with --since" message in favour of a ref guidance message', () => {
    const evidence: Evidence[] = [makeEvidence('queue-edge')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      sinceProvided: true,
    });

    const dr = hyps.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.missingEvidence.length).toBeGreaterThan(0);
    // Should not ask to re-run with --since when it was already supplied.
    expect(dr!.missingEvidence[0]).not.toContain('re-run with --since');
  });

  it('retry-storm is supported when spiked log evidence is present (ratio >= 2.0)', () => {
    const spikedLog: Evidence = {
      ...makeEvidence('log'),
      ratio: 3.5,
    };
    const hyps = generateHypotheses([spikedLog], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });
    const rs = hyps.find((h) => h.category === 'retry-storm');
    expect(rs).toBeDefined();
    expect(rs!.confidence).toBeGreaterThan(0.15);
    expect(rs!.supportingEvidenceIds).toContain(spikedLog.id);
    expect(rs!.missingEvidence).toHaveLength(0);
  });

  it('retry-storm is weakened when queue starvation evidence is present (workers stopped)', () => {
    const queueId = 'q-starvation-ev';
    const starvationEv: Evidence = makeEvidence('queue-state', queueId);
    const hyps = generateHypotheses([starvationEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      queueStarvationEvIdsByQueue: new Map([['orders', [queueId]]]),
    });
    const rs = hyps.find((h) => h.category === 'retry-storm');
    expect(rs).toBeDefined();
    expect(rs!.contradictingEvidenceIds).toContain(queueId);
  });

  it('infrastructure is supported by DB state evidence', () => {
    const stateEv = makeEvidence('state');
    const hyps = generateHypotheses([stateEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });
    const infra = hyps.find((h) => h.category === 'infrastructure');
    expect(infra).toBeDefined();
    expect(infra!.confidence).toBeGreaterThan(0.15);
    expect(infra!.supportingEvidenceIds).toContain(stateEv.id);
    expect(infra!.missingEvidence).toHaveLength(0);
  });

  it('infrastructure is supported by latency metric evidence', () => {
    const latencyMetricId = 'latency-metric-ev';
    const hyps = generateHypotheses([], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      latencyMetricEvIds: [latencyMetricId],
    });
    const infra = hyps.find((h) => h.category === 'infrastructure');
    expect(infra).toBeDefined();
    expect(infra!.supportingEvidenceIds).toContain(latencyMetricId);
  });

  it('retry-storm and infrastructure have no support when no matching evidence is present', () => {
    const evidence: Evidence[] = [makeEvidence('symbol'), makeEvidence('commit')];
    const hyps = generateHypotheses(evidence, emptyCorrelation, { seedLabel: 'X', queues: [] });
    const rs = hyps.find((h) => h.category === 'retry-storm');
    const infra = hyps.find((h) => h.category === 'infrastructure');
    expect(rs!.confidence).toBe(0.15);
    expect(rs!.supportingEvidenceIds).toHaveLength(0);
    expect(infra!.confidence).toBe(0.15);
    expect(infra!.supportingEvidenceIds).toHaveLength(0);
  });

  it('queue-backlog and worker-slowdown are absent when no queue-edge evidence is provided', () => {
    const evidence: Evidence[] = [makeEvidence('commit')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });

    const categories = hyps.map((h) => h.category);
    expect(categories).not.toContain('queue-backlog');
    expect(categories).not.toContain('worker-slowdown');
  });

  // HOR-410 (round 2): a 0-queue (e.g. synchronous Python) repo must not surface
  // Node-stack queue/log backends (BullMQ / Redis / Elasticsearch) in any hypothesis
  // statement or missing-evidence line — that fabricates infrastructure the repo lacks.
  it('(HOR-410) 0-queue repo → no BullMQ/Redis/Elasticsearch literals in statements or missing evidence', () => {
    const evidence: Evidence[] = [makeEvidence('symbol')];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'UserService',
      queues: [],
    });

    const stackRe = /bullmq|redis|elasticsearch/i;
    for (const h of hyps) {
      expect(h.statement).not.toMatch(stackRe);
      for (const m of h.missingEvidence) {
        expect(m).not.toMatch(stackRe);
      }
    }

    // Sanity: the always-emitted runtime hypotheses are still present (just stack-neutral).
    const categories = new Set(hyps.map((h) => h.category));
    expect(categories.has('retry-storm')).toBe(true);
    expect(categories.has('infrastructure')).toBe(true);
    expect(categories.has('external-api-latency')).toBe(true);
  });

  it('returns at least 4 hypotheses even with no queue evidence (always-emitted ones)', () => {
    const evidence: Evidence[] = [makeEvidence('symbol')];

    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'Y',
      queues: [],
    });

    // deployment-regression, external-api-latency, retry-storm, infrastructure
    expect(hyps.length).toBeGreaterThanOrEqual(4);
  });

  // ── Verdict correctness (HOR-45) ───────────────────────────────────────────

  it('queue-backlog has empty supportingEvidenceIds — structural queue-edge evidence is not runtime confirmation', () => {
    const queueEv = makeEvidence('queue-edge');
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const qb = hyps.find((h) => h.category === 'queue-backlog');
    expect(qb).toBeDefined();
    expect(qb!.supportingEvidenceIds).toHaveLength(0);
  });

  it('queue-backlog verdict is unconfirmed when only structural evidence is present', () => {
    const queueEv = makeEvidence('queue-edge');
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const validated = validateHypotheses(hyps, [queueEv]);
    const qb = validated.find((h) => h.category === 'queue-backlog');
    expect(qb?.verdict).toBe('unconfirmed');
  });

  it('worker-slowdown supportingEvidenceIds contains only metric IDs, not queue-edge IDs', () => {
    const queueEv = makeEvidence('queue-edge');
    const metricId = globalThis.crypto.randomUUID();
    const hyps = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      queueMetricEvIdsByQueue: new Map([['orders', [metricId]]]),
    });
    const ws = hyps.find((h) => h.category === 'worker-slowdown');
    expect(ws).toBeDefined();
    expect(ws!.supportingEvidenceIds).toContain(metricId);
    expect(ws!.supportingEvidenceIds).not.toContain(queueEv.id);
  });

  // ── HOR-435 lever #4: benign-variance hypothesis ───────────────────────────

  it('(HOR-435) benign-variance appears and is SUPPORTED by per-dimension duration evidence', () => {
    const durEvId = 'dur-by-region-ev';
    const evidence: Evidence[] = [makeEvidence('log', durEvId)];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'SyncJob',
      queues: [],
      perDimensionDurationEvIds: [durEvId],
    });
    const bv = hyps.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    // Low base prior — rises only with the real per-dimension evidence.
    expect(bv!.confidence).toBe(0.1);
    expect(bv!.supportingEvidenceIds).toContain(durEvId);
    expect(bv!.missingEvidence).toHaveLength(0);
    // Validation lifts it (evidence present) but never to certainty.
    const [validated] = validateHypotheses([bv!], evidence);
    expect(validated!.verdict).toBe('supported');
    expect(validated!.confidence).toBeGreaterThan(0.1);
    expect(validated!.confidence).toBeLessThan(1);
  });

  it('(HOR-435) benign-variance is also supported by a bimodal-population metric signal', () => {
    const bimodalId = 'bimodal-metric-ev';
    const evidence: Evidence[] = [makeEvidence('metric', bimodalId)];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      bimodalMetricEvIds: [bimodalId],
    });
    const bv = hyps.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    expect(bv!.supportingEvidenceIds).toContain(bimodalId);
  });

  it('(HOR-438) benign-variance RISES when code-detected per-segment queue structure is present', () => {
    const segId = 'per-segment-queue-ev';
    const evidence: Evidence[] = [makeEvidence('queue-edge', segId)];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'ManageSalesWorker',
      queues: ['MANAGE_SALES:KSA', 'MANAGE_SALES:UAE'],
      perSegmentQueueStructureEvIds: [segId],
    });
    const bv = hyps.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    // Base prior stays LOW (honesty) — the per-segment structure is support, not a verdict.
    expect(bv!.confidence).toBe(0.1);
    expect(bv!.supportingEvidenceIds).toContain(segId);
    expect(bv!.missingEvidence).toHaveLength(0);
    // Validation lifts it above the base prior (real support present) but never to certainty.
    const [validated] = validateHypotheses([bv!], evidence);
    expect(validated!.verdict).toBe('supported');
    expect(validated!.confidence).toBeGreaterThan(0.1);
    expect(validated!.confidence).toBeLessThan(1);
  });

  it('(HOR-438) per-segment queue support does NOT let benign-variance outrank a genuine failure', () => {
    // A genuine deployment regression (relevant commit) co-present with a per-segment
    // queue structure: benign-variance must NOT win — the real failure outranks it.
    const commitId = 'real-regression-commit';
    const segId = 'per-segment-queue-ev';
    const commitEv = makeEvidence('commit', commitId);
    const segEv = makeEvidence('queue-edge', segId);
    const evidence: Evidence[] = [commitEv, segEv];
    const hyps = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'ManageSalesWorker',
      queues: ['MANAGE_SALES:KSA', 'MANAGE_SALES:UAE'],
      perSegmentQueueStructureEvIds: [segId],
    });
    const validated = validateHypotheses(hyps, evidence);
    const bv = validated.find((h) => h.category === 'benign-variance')!;
    const dr = validated.find((h) => h.category === 'deployment-regression')!;
    expect(bv).toBeDefined();
    expect(dr).toBeDefined();
    // The genuine failure outranks benign-variance.
    expect(dr.confidence).toBeGreaterThan(bv.confidence);
    // ...and the top-ranked hypothesis is not benign-variance.
    expect(validated[0]!.category).not.toBe('benign-variance');
  });

  it('(HOR-435) benign-variance is emitted (unsupported) when the investigation is anomaly-themed, but stays low', () => {
    const hyps = generateHypotheses([makeEvidence('symbol')], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      benignVarianceApplicable: true,
    });
    const bv = hyps.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    expect(bv!.confidence).toBe(0.1);
    expect(bv!.supportingEvidenceIds).toHaveLength(0);
    expect(bv!.missingEvidence.length).toBeGreaterThan(0);
  });

  it('(HOR-435) benign-variance is NOT emitted on a non-anomaly investigation with no duration/bimodal evidence', () => {
    const hyps = generateHypotheses([makeEvidence('commit')], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });
    expect(hyps.find((h) => h.category === 'benign-variance')).toBeUndefined();
  });

  // ── HOR-435 lever #1: de-anchor alert-suggested causes ─────────────────────

  it('(HOR-435) an alert-suggested category does NOT auto-promote — confidence is identical with/without the suggestion', () => {
    const evidence: Evidence[] = [makeEvidence('symbol')];
    const withoutSuggestion = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
    });
    const withSuggestion = generateHypotheses(evidence, emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      alertSuggestedCategories: ['infrastructure', 'retry-storm'],
    });
    for (const cat of ['infrastructure', 'retry-storm']) {
      const a = withoutSuggestion.find((h) => h.category === cat);
      const b = withSuggestion.find((h) => h.category === cat);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Alert text is CONTEXT-ONLY — the prior is unchanged by being named in the alert.
      expect(b!.confidence).toBe(a!.confidence);
      // ...but the de-anchoring is made explicit on the still-unsupported hypothesis.
      expect(b!.missingEvidence.some((m) => /independent evidence/i.test(m))).toBe(true);
    }
  });

  it('(HOR-435) a suggested category that HAS independent evidence is not annotated (it earned support honestly)', () => {
    const stateEv = makeEvidence('state');
    const hyps = generateHypotheses([stateEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: [],
      alertSuggestedCategories: ['infrastructure'],
    });
    const infra = hyps.find((h) => h.category === 'infrastructure');
    expect(infra).toBeDefined();
    expect(infra!.supportingEvidenceIds).toContain(stateEv.id);
    // No "needs independent evidence" annotation — it already has it.
    expect(infra!.missingEvidence.some((m) => /independent evidence/i.test(m))).toBe(false);
  });

  it('worker-slowdown verdict is unconfirmed without metric evidence, supported with it', () => {
    const queueEv = makeEvidence('queue-edge');

    // Without metric evidence → unconfirmed
    const hypsNoMetrics = generateHypotheses([queueEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
    });
    const validatedNoMetrics = validateHypotheses(hypsNoMetrics, [queueEv]);
    const wsNoMetrics = validatedNoMetrics.find((h) => h.category === 'worker-slowdown');
    expect(wsNoMetrics?.verdict).toBe('unconfirmed');

    // With metric evidence → supported
    const metricId = globalThis.crypto.randomUUID();
    const metricEv: Evidence = {
      id: metricId,
      source: 'metrics',
      kind: 'metric',
      title: 'Queue growth spike',
      relevance: 0.8,
      payload: {},
      links: {},
      provenance: { query: 'test', collectedAt: new Date().toISOString() },
    };
    const hypsWithMetrics = generateHypotheses([queueEv, metricEv], emptyCorrelation, {
      seedLabel: 'X',
      queues: ['orders'],
      queueMetricEvIdsByQueue: new Map([['orders', [metricId]]]),
    });
    const validatedWithMetrics = validateHypotheses(hypsWithMetrics, [queueEv, metricEv]);
    const wsWithMetrics = validatedWithMetrics.find((h) => h.category === 'worker-slowdown');
    expect(wsWithMetrics?.verdict).toBe('supported');
  });
});

it('live EMODA regression: many bimodal series cannot explain away a direct runtime error', () => {
  const metrics=Array.from({length:12},(_,i)=>makeEvidence('metric',`metric-${i}`));
  const error={...makeEvidence('log','reserve-error'),payload:{level:'error',relevanceClass:'direct'}};
  const run=(e:Evidence)=>validateHypotheses(generateHypotheses([...metrics,e],emptyCorrelation,{seedLabel:'reserve',queues:[],bimodalMetricEvIds:metrics.map(m=>m.id)}),[...metrics,e]).find(h=>h.category==='benign-variance')!;
  expect(run(error).confidence).toBeLessThanOrEqual(0.1);
  expect(run(error).contradictingEvidenceIds).toEqual(['reserve-error']);
  expect(run({...error,payload:{level:'error',relevanceClass:'ambient'}}).contradictingEvidenceIds).toEqual([]);
  expect(run({...error,payload:{level:'info',relevanceClass:'direct'}}).contradictingEvidenceIds).toEqual([]);
});
