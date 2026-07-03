/**
 * HOR-104 — Evidence quality scoring regression cases.
 *
 * Proves that confidence and evidence quality behave honestly across four
 * named scenarios. Tests are deterministic — no connectors, no network, no AI.
 *
 * Scenarios:
 *   A. Source-only      — only code-graph structural evidence (symbols, flows)
 *   B. Change-present   — source + a recent git commit
 *   C. Runtime-present  — source + live runtime logs
 *   D. Full-stack       — source + change + runtime
 *   E. Missing          — empty evidence
 *
 * Acceptance:
 *   • Confidence cannot silently inflate when evidence is missing.
 *   • Runtime/change evidence improves confidence only when explicitly present.
 *   • Missing evidence produces a clear gap and a confidence ceiling < 1.0.
 *   • Ordering: missing < source-only < (change | runtime) < full-stack
 */

import { describe, it, expect } from 'vitest';
import type { Evidence, ProviderKind, EvidenceKind } from '@horus/core';
import { computeWeightedEvidenceConfidence } from './confidence.js';
import { detectMissingEvidence } from './gaps.js';
import { INCIDENT_001_FIXTURE } from './replay-fixture.js';
import type { InvestigationReport } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function ev(
  kind: EvidenceKind,
  source: ProviderKind,
  relevance: number,
): Evidence {
  return {
    id: `reg-ev-${++_seq}`,
    source,
    kind,
    title: `regression ${kind} from ${source}`,
    relevance,
    payload: {},
    links: {},
    provenance: { query: 'regression-test', collectedAt: '2026-06-15T10:00:00.000Z' },
  };
}

/** Minimal InvestigationReport stub for detectMissingEvidence. */
function stubReport(evidence: Evidence[], withTraceId = false): InvestigationReport {
  const adjustedEvidence = withTraceId
    ? evidence.map((e, i) => (i === 0 ? { ...e, links: { ...e.links, traceId: 'trace-001' } } : e))
    : evidence;
  return {
    ...INCIDENT_001_FIXTURE,
    evidence: adjustedEvidence,
    timeline: { events: [], boundaryCrossings: [] },
    ownership: null,
  };
}

// ---------------------------------------------------------------------------
// Band constants (mirrors confidence.ts / score-cause.ts thresholds)
// ---------------------------------------------------------------------------

const BAND_HIGHLY_LIKELY = 0.85;
const BAND_LIKELY        = 0.65;
const BAND_POSSIBLE      = 0.40;
const BAND_LOW           = 0.25;

// ---------------------------------------------------------------------------
// Scenario A: Source-only (code-graph symbols + flows — no commits, no logs)
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — Scenario A: source-only', () => {
  // symbol at 0.80 → structural['code'] += 0.40
  // flow   at 0.60 → structural['code'] += 0.30 → total 0.70, capped at 0.60
  // result = 0.60 / 6 = 0.10
  const sourceOnlyEvidence: Evidence[] = [
    ev('symbol', 'code', 0.80),
    ev('flow',   'code', 0.60),
  ];

  it('source-only confidence is below the "possible" band (< 0.40)', () => {
    const conf = computeWeightedEvidenceConfidence(sourceOnlyEvidence);
    expect(conf).toBeLessThan(BAND_POSSIBLE);
  });

  it('source-only confidence is above zero (structural evidence contributes)', () => {
    const conf = computeWeightedEvidenceConfidence(sourceOnlyEvidence);
    expect(conf).toBeGreaterThan(0);
  });

  it('source-only confidence cannot reach the "likely" band — structural cap prevents inflation', () => {
    // Even saturating the code source with 10 symbols cannot reach likely.
    const saturated = Array.from({ length: 10 }, () => ev('symbol', 'code', 1.0));
    expect(computeWeightedEvidenceConfidence(saturated)).toBeLessThan(BAND_LIKELY);
  });

  it('source-only exact value: capped structural sum / 6 = 0.60 / 6 ≈ 0.10', () => {
    const conf = computeWeightedEvidenceConfidence(sourceOnlyEvidence);
    expect(conf).toBeCloseTo(0.60 / 6, 5);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Change-present (source + recent commit)
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — Scenario B: change-present', () => {
  // commit at 0.85 → runtime['history'] += 1.5*0.85 = 1.275
  // symbol at 0.80 → structural['code'] += 0.5*0.80 = 0.40
  // result = (1.275 + 0.40) / 6 ≈ 0.279
  const changePresentEvidence: Evidence[] = [
    ev('commit', 'history', 0.85),
    ev('symbol', 'code',    0.80),
  ];

  it('change-present confidence is above source-only (commit is a runtime kind)', () => {
    const sourceOnly = computeWeightedEvidenceConfidence([
      ev('symbol', 'code', 0.80),
      ev('flow',   'code', 0.60),
    ]);
    const withChange = computeWeightedEvidenceConfidence(changePresentEvidence);
    expect(withChange).toBeGreaterThan(sourceOnly);
  });

  it('change-present confidence is above the "low" threshold', () => {
    const conf = computeWeightedEvidenceConfidence(changePresentEvidence);
    expect(conf).toBeGreaterThan(BAND_LOW);
  });

  it('change-present confidence is below "likely" — a single commit is not enough', () => {
    const conf = computeWeightedEvidenceConfidence(changePresentEvidence);
    expect(conf).toBeLessThan(BAND_LIKELY);
  });

  it('change-present exact value: (1.275 + 0.40) / 6 ≈ 0.279', () => {
    const conf = computeWeightedEvidenceConfidence(changePresentEvidence);
    expect(conf).toBeCloseTo((1.275 + 0.40) / 6, 5);
  });
});

// ---------------------------------------------------------------------------
// Scenario C: Runtime-present (source + live log evidence)
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — Scenario C: runtime-present', () => {
  // log    at 0.90 → runtime['logs'] += 1.5*0.90 = 1.35
  // symbol at 0.80 → structural['code'] = 0.40
  // result = (1.35 + 0.40) / 6 ≈ 0.292
  const runtimePresentEvidence: Evidence[] = [
    ev('log',    'logs', 0.90),
    ev('symbol', 'code', 0.80),
  ];

  it('runtime-present confidence is above source-only', () => {
    const sourceOnly = computeWeightedEvidenceConfidence([ev('symbol', 'code', 0.80)]);
    const withRuntime = computeWeightedEvidenceConfidence(runtimePresentEvidence);
    expect(withRuntime).toBeGreaterThan(sourceOnly);
  });

  it('runtime-present confidence is above the "low" threshold', () => {
    const conf = computeWeightedEvidenceConfidence(runtimePresentEvidence);
    expect(conf).toBeGreaterThan(BAND_LOW);
  });

  it('runtime-present confidence is below "likely" — a single log source is not enough', () => {
    const conf = computeWeightedEvidenceConfidence(runtimePresentEvidence);
    expect(conf).toBeLessThan(BAND_LIKELY);
  });

  it('a second independent runtime source pushes confidence toward "likely"', () => {
    const singleSource = computeWeightedEvidenceConfidence(runtimePresentEvidence);
    const twoSources = computeWeightedEvidenceConfidence([
      ...runtimePresentEvidence,
      ev('metric', 'metrics', 0.80),
    ]);
    expect(twoSources).toBeGreaterThan(singleSource);
  });

  it('runtime-present exact value: (1.35 + 0.40) / 6 ≈ 0.292', () => {
    const conf = computeWeightedEvidenceConfidence(runtimePresentEvidence);
    expect(conf).toBeCloseTo((1.35 + 0.40) / 6, 5);
  });
});

// ---------------------------------------------------------------------------
// Scenario D: Full-stack (source + change + runtime)
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — Scenario D: full-stack', () => {
  // commit at 0.85 → runtime['history'] = 1.275
  // log    at 0.90 → runtime['logs'] = 1.35
  // symbol at 0.80 → structural['code'] = 0.40
  // result = (1.275 + 1.35 + 0.40) / 6 ≈ 0.504
  const fullStackEvidence: Evidence[] = [
    ev('commit', 'history', 0.85),
    ev('log',    'logs',    0.90),
    ev('symbol', 'code',    0.80),
  ];

  it('full-stack confidence is above both change-only and runtime-only', () => {
    const changeOnly = computeWeightedEvidenceConfidence([
      ev('commit', 'history', 0.85),
      ev('symbol', 'code',    0.80),
    ]);
    const runtimeOnly = computeWeightedEvidenceConfidence([
      ev('log',    'logs', 0.90),
      ev('symbol', 'code', 0.80),
    ]);
    const full = computeWeightedEvidenceConfidence(fullStackEvidence);
    expect(full).toBeGreaterThan(changeOnly);
    expect(full).toBeGreaterThan(runtimeOnly);
  });

  it('full-stack confidence is in the "possible" to "likely" range', () => {
    const conf = computeWeightedEvidenceConfidence(fullStackEvidence);
    expect(conf).toBeGreaterThanOrEqual(BAND_POSSIBLE);
    expect(conf).toBeLessThan(BAND_LIKELY);
  });

  it('full-stack exact value: (1.275 + 1.35 + 0.40) / 6 ≈ 0.504', () => {
    const conf = computeWeightedEvidenceConfidence(fullStackEvidence);
    expect(conf).toBeCloseTo((1.275 + 1.35 + 0.40) / 6, 5);
  });

  it('adding a third runtime source (metric) pushes full-stack into "likely" band', () => {
    const withMetric = computeWeightedEvidenceConfidence([
      ...fullStackEvidence,
      ev('metric', 'metrics', 0.80),
    ]);
    expect(withMetric).toBeGreaterThanOrEqual(BAND_LIKELY);
  });
});

// ---------------------------------------------------------------------------
// Scenario E: Missing evidence — empty and stripped sets
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — Scenario E: missing evidence', () => {
  it('empty evidence array produces exactly 0', () => {
    expect(computeWeightedEvidenceConfidence([])).toBe(0);
  });

  it('irrelevance (relevance=0) produces 0 even with multiple items', () => {
    const zeroes = [
      ev('log',    'logs',    0),
      ev('commit', 'history', 0),
      ev('symbol', 'code',    0),
    ];
    expect(computeWeightedEvidenceConfidence(zeroes)).toBe(0);
  });

  it('negative relevance is clamped to 0 — cannot deflate confidence below 0', () => {
    const negative = [
      ev('log', 'logs', -0.5),
      ev('log', 'logs',  1.0),
    ];
    const withNegative = computeWeightedEvidenceConfidence(negative);
    const positive = computeWeightedEvidenceConfidence([ev('log', 'logs', 1.0)]);
    // Negative item is clamped to 0 and contributes nothing — same as positive-only.
    expect(withNegative).toBeCloseTo(positive, 5);
  });

  it('super-high relevance is clamped to 1.0 — cannot inflate confidence above ceiling', () => {
    const clamped = computeWeightedEvidenceConfidence([ev('log', 'logs', 999)]);
    const unit    = computeWeightedEvidenceConfidence([ev('log', 'logs', 1.0)]);
    expect(clamped).toBeCloseTo(unit, 5);
  });
});

// ---------------------------------------------------------------------------
// Gap analysis — missing evidence produces explicit gaps
// ---------------------------------------------------------------------------

describe('HOR-104 gap analysis — missing log evidence', () => {
  it('no log evidence → logs gap reported (per-dimension when a connector is configured)', () => {
    const report = stubReport([ev('commit', 'history', 0.85)]);
    // grafana configured → per-dimension gaps apply (a zero-connector config
    // consolidates them into one 'runtime evidence' gap instead).
    const { gaps } = detectMissingEvidence(report, { grafana: true });
    const logsGap = gaps.find((g) => g.dimension === 'logs');
    expect(logsGap, 'expected a logs gap when no log evidence is present').toBeDefined();
  });

  it('no log evidence → confidence ceiling reduced by at least 0.1', () => {
    const report = stubReport([ev('commit', 'history', 0.85)]);
    const { confidenceCeiling } = detectMissingEvidence(report, {});
    expect(confidenceCeiling).toBeLessThan(1.0);
    // At minimum: logs gap alone shaves 0.1 off the ceiling.
    expect(confidenceCeiling).toBeLessThanOrEqual(0.9);
  });

  it('log evidence present → no logs gap', () => {
    const report = stubReport([
      ev('commit', 'history', 0.85),
      ev('log',    'logs',    0.90),
    ]);
    const { gaps } = detectMissingEvidence(report, { elasticsearch: true, logsCollected: true });
    const logsGap = gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeUndefined();
  });
});

describe('HOR-104 gap analysis — missing commit (no deployment record)', () => {
  it('no commit evidence → deployment records gap reported', () => {
    const report = stubReport([ev('log', 'logs', 0.90)]);
    const { gaps } = detectMissingEvidence(report, {});
    const deployGap = gaps.find((g) => g.dimension === 'deployment records');
    expect(deployGap, 'expected a deployment records gap when no commit is present').toBeDefined();
  });

  it('commit evidence present → no deployment records gap', () => {
    const report = stubReport([
      ev('commit', 'history', 0.85),
      ev('log',    'logs',    0.90),
    ]);
    const { gaps } = detectMissingEvidence(report, {});
    const deployGap = gaps.find((g) => g.dimension === 'deployment records');
    expect(deployGap).toBeUndefined();
  });

  it('missing commit gap has a positive confidenceImpact', () => {
    const report = stubReport([ev('log', 'logs', 0.90)]);
    const { gaps } = detectMissingEvidence(report, {});
    const deployGap = gaps.find((g) => g.dimension === 'deployment records');
    expect(deployGap!.confidenceImpact).toBeGreaterThan(0);
  });
});

describe('HOR-104 gap analysis — confidence ceiling behavior', () => {
  it('all evidence missing → multiple gaps → ceiling is below 0.7', () => {
    // No logs, no metrics, no commit, no traces, no ownership
    const report = stubReport([]);
    const { confidenceCeiling } = detectMissingEvidence(report, {});
    // Many gaps stack: logs(0.1) + metrics(0.1) + deployment(0.08) + ownership(0.05) + traces(0.07) = 0.40 off
    expect(confidenceCeiling).toBeLessThan(0.7);
  });

  it('full evidence set → no mandatory gaps → ceiling remains high', () => {
    // logs + commit + trace + ownership all present
    const evidenceWithTrace: Evidence[] = [
      ev('log',    'logs',    0.90),
      ev('metric', 'metrics', 0.80),
      ev('commit', 'history', 0.85),
    ];
    const report: InvestigationReport = {
      ...INCIDENT_001_FIXTURE,
      evidence: evidenceWithTrace.map((e, i) =>
        i === 0 ? { ...e, links: { ...e.links, traceId: 'trace-001' } } : e,
      ),
      timeline: { events: [], boundaryCrossings: [] },
      ownership: {
        query: 'test',
        symbol: null,
        file: 'test.ts',
        contributors: [{ author: 'Alice', commits: 5, firstDate: '2025-01-01T00:00:00.000Z', lastDate: '2026-01-01T00:00:00.000Z' }],
        likelyMaintainer: 'Alice',
        maintainerShare: 0.9,
        mostActiveRecent: 'Alice',
        confidence: 0.9,
        evidence: ['5 commits'],
        note: 'Likely maintainer based on commit frequency.',
      },
    };
    const { confidenceCeiling } = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: true,
      grafana: true,
      metricsCollected: true,
    });
    // Only deployment-records and traces might be missing.
    // Here commit is present (no deploy gap) and trace is present (no traces gap).
    expect(confidenceCeiling).toBeGreaterThanOrEqual(0.7);
  });

  it('confidence ceiling is always >= 0.3 regardless of how many gaps exist', () => {
    const report = stubReport([]);
    const { confidenceCeiling } = detectMissingEvidence(report, {});
    expect(confidenceCeiling).toBeGreaterThanOrEqual(0.3);
  });

  it('confidence ceiling with no gaps is exactly 1.0', () => {
    // Provide every evidence kind that the gap detector checks:
    // log + metric + commit + trace + owned
    const evidenceAll: Evidence[] = [
      ev('log',    'logs',    0.90),
      ev('metric', 'metrics', 0.80),
      ev('commit', 'history', 0.85),
    ];
    const report: InvestigationReport = {
      ...INCIDENT_001_FIXTURE,
      evidence: [
        evidenceAll[0]!,
        evidenceAll[1]!,
        evidenceAll[2]!,
        { ...evidenceAll[0]!, links: { traceId: 'trace-001' } },
      ],
      timeline: { events: [], boundaryCrossings: [] },
      ownership: {
        query: 'test',
        symbol: null,
        file: 'test.ts',
        contributors: [{ author: 'Alice', commits: 5, firstDate: '2025-01-01T00:00:00.000Z', lastDate: '2026-01-01T00:00:00.000Z' }],
        likelyMaintainer: 'Alice',
        maintainerShare: 0.9,
        mostActiveRecent: 'Alice',
        confidence: 0.9,
        evidence: ['5 commits'],
        note: 'Likely maintainer based on commit frequency.',
      },
    };
    const { confidenceCeiling } = detectMissingEvidence(report, {
      elasticsearch: true,
      logsCollected: true,
      grafana: true,
      metricsCollected: true,
    });
    expect(confidenceCeiling).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Monotonic ordering — the fundamental regression invariant
// ---------------------------------------------------------------------------

describe('HOR-104 evidence quality — strict confidence ordering', () => {
  it('missing < source-only < change-present < full-stack', () => {
    const missing    = computeWeightedEvidenceConfidence([]);
    const sourceOnly = computeWeightedEvidenceConfidence([ev('symbol', 'code', 0.80)]);
    const withChange = computeWeightedEvidenceConfidence([
      ev('symbol', 'code',    0.80),
      ev('commit', 'history', 0.85),
    ]);
    const full = computeWeightedEvidenceConfidence([
      ev('symbol', 'code',    0.80),
      ev('commit', 'history', 0.85),
      ev('log',    'logs',    0.90),
    ]);
    expect(missing).toBe(0);
    expect(sourceOnly).toBeGreaterThan(missing);
    expect(withChange).toBeGreaterThan(sourceOnly);
    expect(full).toBeGreaterThan(withChange);
  });

  it('runtime evidence provides strictly more signal than structural-only from same-source cap', () => {
    // Saturate structural cap.
    const maxStructural = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => ev('symbol', 'code', 1.0)),
    );
    // One runtime item at the same relevance.
    const oneRuntime = computeWeightedEvidenceConfidence([ev('log', 'logs', 1.0)]);
    // Runtime item alone outweighs a saturated structural pool.
    expect(oneRuntime).toBeGreaterThan(maxStructural);
  });
});
