/**
 * HOR-13 — Unit tests for queue-aware rendering in renderReport() and reportToMarkdown().
 * Pure, no I/O. All evidence is synthesised inline.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationReport, CauseCandidate } from './types.js';
import { renderReport, reportToMarkdown, groupQueueEvidence, runtimeSourceCaveat, explainLowConfidence, CONFIDENCE_EXPLAIN_THRESHOLD } from './render.js';
import type { RuntimeSourceReport } from './source-status.js';

function makeCause(title: string, finalScore: number, sourceEvidenceIds: string[]): CauseCandidate {
  const band = finalScore >= 0.85 ? 'highly-likely' as const
    : finalScore >= 0.65 ? 'likely' as const
    : finalScore >= 0.40 ? 'possible' as const
    : 'observation' as const;
  return {
    id: `cause:${title.slice(0, 24).replace(/\s+/g, '-')}`,
    title,
    category: 'other',
    sourceEvidenceIds,
    affectedNodeIds: [],
    baseScore: finalScore,
    finalScore,
    confidence: finalScore,
    band,
    explanations: [],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQueueEv(
  id: string,
  queueName: string,
  title: string,
  relevance: number,
  payload: Record<string, unknown>,
): Evidence {
  return {
    id,
    source: 'queue',
    kind: 'queue-state',
    title,
    relevance,
    payload,
    links: { queueName },
    provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
  };
}

// Summary evidence — has isPaused in payload
const summaryEv = makeQueueEv(
  'ev_qs_0',
  'zoho-sync',
  'zoho-sync: 4382 waiting, 1 active, 12 failed, 0 delayed',
  0.4,
  { queueName: 'zoho-sync', waiting: 4382, active: 1, failed: 12, delayed: 0, completed: 500, isPaused: false },
);

// Backlog anomaly
const backlogEv = makeQueueEv(
  'ev_qs_1',
  'zoho-sync',
  'zoho-sync: 4,382 jobs waiting (severe backlog)',
  0.88,
  { queueName: 'zoho-sync', waiting: 4382, active: 1 },
);

// Worker starvation
const starvationEv = makeQueueEv(
  'ev_qs_2',
  'token-refresh',
  'token-refresh: 423 waiting jobs, 0 active workers — possible starvation',
  0.7,
  { queueName: 'token-refresh', waiting: 423, active: 0 },
);

const starvationSummaryEv = makeQueueEv(
  'ev_qs_3',
  'token-refresh',
  'token-refresh: 423 waiting, 0 active, 0 failed, 0 delayed',
  0.4,
  { queueName: 'token-refresh', waiting: 423, active: 0, failed: 0, delayed: 0, completed: 200, isPaused: false },
);

// Failed breakdown
const failedBreakdownEv = makeQueueEv(
  'ev_qs_4',
  'crm-webhook',
  'crm-webhook: 83% of failed jobs are "TokenRefreshFailed: 401 Unauthorized"',
  0.82,
  {
    queueName: 'crm-webhook',
    topReason: 'TokenRefreshFailed: 401 Unauthorized',
    topCount: 16,
    topPct: 83,
    totalFailed: 120,
    breakdown: [{ reason: 'TokenRefreshFailed: 401 Unauthorized', count: 16 }],
  },
);

const failedSummaryEv = makeQueueEv(
  'ev_qs_5',
  'crm-webhook',
  'crm-webhook: 0 waiting, 1 active, 120 failed, 5 delayed',
  0.4,
  { queueName: 'crm-webhook', waiting: 0, active: 1, failed: 120, delayed: 5, completed: 800, isPaused: false },
);

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'inv-test',
    input: { hint: 'Zoho sync delays' },
    summary: 'Test summary.',
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
    confidence: 0.6,
    nextActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupQueueEvidence
// ---------------------------------------------------------------------------

describe('groupQueueEvidence', () => {
  it('groups by queue name and sorts summary last', () => {
    const evs = [summaryEv, backlogEv, starvationEv, starvationSummaryEv];
    const groups = groupQueueEvidence(evs);
    expect([...groups.keys()]).toEqual(['zoho-sync', 'token-refresh']);

    const zoho = groups.get('zoho-sync')!;
    expect(zoho[0]!.id).toBe('ev_qs_1'); // backlog first
    expect(zoho[zoho.length - 1]!.id).toBe('ev_qs_0'); // summary last

    const token = groups.get('token-refresh')!;
    expect(token[0]!.id).toBe('ev_qs_2'); // starvation first
    expect(token[token.length - 1]!.id).toBe('ev_qs_3'); // summary last
  });

  it('ignores non-queue-state evidence', () => {
    const codeEv: Evidence = {
      id: 'ev-code-1',
      source: 'code',
      kind: 'symbol',
      title: 'SomeService',
      relevance: 0.9,
      payload: {},
      links: {},
      provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
    };
    const groups = groupQueueEvidence([codeEv, backlogEv]);
    expect(groups.size).toBe(1);
    expect(groups.has('zoho-sync')).toBe(true);
  });

  it('returns empty map when no queue evidence', () => {
    expect(groupQueueEvidence([])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// renderReport — Queue runtime section
// ---------------------------------------------------------------------------

describe('renderReport — queue runtime section', () => {
  it('omits the section entirely when no queue evidence and no gap', () => {
    const r = makeReport();
    const output = renderReport(r);
    expect(output).not.toContain('## Queue runtime');
  });

  it('shows gap.why when queue gap exists but no evidence', () => {
    const r = makeReport({
      gapAnalysis: {
        gaps: [{ dimension: 'queue runtime state', why: 'No Redis connector configured for this environment.', nextSource: 'horus queues', confidenceImpact: 0.1 }],
        blindSpots: [],
        confidenceCeiling: 0.9,
      },
    });
    const output = renderReport(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('No Redis connector configured for this environment.');
  });

  it('renders backlog signal with queue name as sub-header', () => {
    const r = makeReport({ evidence: [summaryEv, backlogEv] });
    const output = renderReport(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('zoho-sync');
    expect(output).toContain('4,382 jobs waiting (severe backlog)');
    expect(output).toContain('[0.88]');
  });

  it('renders summary counts inline for summary evidence', () => {
    const r = makeReport({ evidence: [summaryEv] });
    const output = renderReport(r);
    expect(output).toContain('4382 waiting');
    expect(output).toContain('active');
    expect(output).toContain('failed');
    expect(output).toContain('[0.40]');
  });

  it('renders starvation signal and summary for token-refresh', () => {
    const r = makeReport({ evidence: [starvationEv, starvationSummaryEv] });
    const output = renderReport(r);
    expect(output).toContain('token-refresh');
    expect(output).toContain('possible starvation');
    expect(output).toContain('[0.70]');
  });

  it('renders failed breakdown', () => {
    const r = makeReport({ evidence: [failedBreakdownEv, failedSummaryEv] });
    const output = renderReport(r);
    expect(output).toContain('crm-webhook');
    expect(output).toContain('83%');
    expect(output).toContain('TokenRefreshFailed');
    expect(output).toContain('[0.82]');
  });

  it('renders multiple queues each under their own name', () => {
    const r = makeReport({ evidence: [backlogEv, summaryEv, starvationEv, starvationSummaryEv] });
    const output = renderReport(r);
    const zohoIdx = output.indexOf('zoho-sync');
    const tokenIdx = output.indexOf('token-refresh');
    expect(zohoIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// renderReport — suspected causes tagging
// ---------------------------------------------------------------------------

describe('renderReport — queue-backed suspected causes', () => {
  it('adds [↑ queue] to causes with queue evidence ids', () => {
    const r = makeReport({
      evidence: [backlogEv, summaryEv],
      suspectedCauses: [
        makeCause('Queue zoho-sync is backed up', 0.7, ['ev_qs_1']),
        makeCause('Recent deploy broke auth', 0.4, ['ev-code-1']),
      ],
    });
    const output = renderReport(r);
    expect(output).toContain('[↑ queue]');
    const lines = output.split('\n');
    const queueCause = lines.find((l) => l.includes('zoho-sync is backed up'));
    const nonQueueCause = lines.find((l) => l.includes('Recent deploy broke auth'));
    expect(queueCause).toContain('[↑ queue]');
    expect(nonQueueCause).not.toContain('[↑ queue]');
  });

  it('does not add queue tag when cause has no queue evidence', () => {
    const r = makeReport({
      evidence: [backlogEv],
      suspectedCauses: [
        makeCause('Code path X is broken', 0.5, ['ev-other']),
      ],
    });
    const output = renderReport(r);
    expect(output).not.toContain('[↑ queue]');
  });
});

// ---------------------------------------------------------------------------
// reportToMarkdown — Queue runtime section
// ---------------------------------------------------------------------------

describe('reportToMarkdown — queue runtime section', () => {
  it('omits queue section when no evidence and no gap', () => {
    const r = makeReport();
    const output = reportToMarkdown(r);
    expect(output).not.toContain('## Queue runtime');
  });

  it('renders gap.why in markdown when no queue evidence', () => {
    const r = makeReport({
      gapAnalysis: {
        gaps: [{ dimension: 'queue runtime state', why: 'No Redis connector configured.', nextSource: 'horus queues', confidenceImpact: 0.1 }],
        blindSpots: [],
        confidenceCeiling: 0.9,
      },
    });
    const output = reportToMarkdown(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('No Redis connector configured.');
  });

  it('renders queue signals as bullet list with relevance code', () => {
    const r = makeReport({ evidence: [backlogEv, summaryEv] });
    const output = reportToMarkdown(r);
    expect(output).toContain('**zoho-sync**');
    expect(output).toContain('`0.88`');
    expect(output).toContain('4,382 jobs waiting (severe backlog)');
  });

  it('renders summary counts in markdown', () => {
    const r = makeReport({ evidence: [summaryEv] });
    const output = reportToMarkdown(r);
    expect(output).toContain('`0.40`');
    expect(output).toContain('4382 waiting');
  });

  it('tags queue-backed suspected causes with [↑ queue]', () => {
    const r = makeReport({
      evidence: [backlogEv],
      suspectedCauses: [
        makeCause('Queue backed up', 0.7, ['ev_qs_1']),
        makeCause('Other cause', 0.3, []),
      ],
    });
    const output = reportToMarkdown(r);
    const lines = output.split('\n');
    const queueLine = lines.find((l) => l.includes('Queue backed up'));
    const otherLine = lines.find((l) => l.includes('Other cause'));
    expect(queueLine).toContain('[↑ queue]');
    expect(otherLine).not.toContain('[↑ queue]');
  });
});

// ---------------------------------------------------------------------------
// runtimeSourceCaveat — HOR-89
// ---------------------------------------------------------------------------

function makeSourceStatus(
  entries: Array<{ source: 'logs' | 'metrics' | 'state' | 'queue'; status: 'contributed' | 'empty' | 'failed' | 'not-configured' }>,
): RuntimeSourceReport {
  return {
    sources: entries.map(({ source, status }) => ({
      source,
      configured: status !== 'not-configured',
      evidenceCount: status === 'contributed' ? 1 : 0,
      status,
    })),
  };
}

describe('runtimeSourceCaveat', () => {
  it('returns null when sourceStatus is absent', () => {
    const r = makeReport();
    expect(runtimeSourceCaveat(r)).toBeNull();
  });

  it('returns null when at least one source contributed', () => {
    const r = makeReport({
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'contributed' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    expect(runtimeSourceCaveat(r)).toBeNull();
  });

  it('returns caveat string listing not-configured sources', () => {
    const r = makeReport({
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    expect(runtimeSourceCaveat(r)).toBe('no runtime evidence — logs, metrics, state, queue not in this config; findings rest on code, git, and topology');
  });

  it('returns null when all sources are empty (configured but no evidence)', () => {
    const r = makeReport({
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'empty' },
        { source: 'metrics', status: 'empty' },
      ]),
    });
    expect(runtimeSourceCaveat(r)).toBeNull();
  });

  it('lists only not-configured sources, ignores failed/empty', () => {
    const r = makeReport({
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'failed' },
        { source: 'state', status: 'empty' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    expect(runtimeSourceCaveat(r)).toBe('no runtime evidence — logs, queue not in this config; findings rest on code, git, and topology');
  });
});

describe('renderReport — runtime source caveat (HOR-89)', () => {
  it('omits caveat line when sourceStatus is absent', () => {
    const output = renderReport(makeReport({ confidence: 0.6 }));
    const lines = output.split('\n');
    const confLine = lines.find((l) => l.startsWith('Confidence:'));
    expect(confLine).toBe('Confidence: 0.60');
    expect(output).not.toContain('source-only');
  });

  it('omits caveat line when runtime sources contributed', () => {
    const r = makeReport({
      confidence: 0.85,
      sourceStatus: makeSourceStatus([{ source: 'logs', status: 'contributed' }]),
    });
    const output = renderReport(r);
    expect(output).not.toContain('source-only');
    expect(output).not.toContain('↳');
  });

  it('renders caveat line after confidence when all sources not configured', () => {
    const r = makeReport({
      confidence: 0.65,
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    const output = renderReport(r);
    const lines = output.split('\n');
    const confIdx = lines.findIndex((l) => l.startsWith('Confidence:'));
    expect(lines[confIdx]).toBe('Confidence: 0.65');
    expect(lines[confIdx + 1]).toBe('  ↳ no runtime evidence — logs, metrics, state, queue not in this config; findings rest on code, git, and topology');
  });
});

describe('reportToMarkdown — runtime source caveat (HOR-89)', () => {
  it('omits caveat when sourceStatus is absent', () => {
    const output = reportToMarkdown(makeReport({ confidence: 0.6 }));
    expect(output).toContain('**Confidence:** 0.60');
    expect(output).not.toContain('source-only');
  });

  it('omits caveat when runtime sources contributed', () => {
    const r = makeReport({
      confidence: 0.9,
      sourceStatus: makeSourceStatus([{ source: 'logs', status: 'contributed' }]),
    });
    const output = reportToMarkdown(r);
    expect(output).toContain('**Confidence:** 0.90');
    expect(output).not.toContain('source-only');
  });

  it('appends caveat inline after confidence when sources not configured', () => {
    const r = makeReport({
      confidence: 0.65,
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    const output = reportToMarkdown(r);
    expect(output).toContain(
      '**Confidence:** 0.65 _(no runtime evidence — logs, metrics, state, queue not in this config; findings rest on code, git, and topology)_',
    );
  });
});

// ---------------------------------------------------------------------------
// explainLowConfidence — HOR-105
// ---------------------------------------------------------------------------

describe('explainLowConfidence', () => {
  it('returns null when confidence is at the threshold', () => {
    const r = makeReport({ confidence: CONFIDENCE_EXPLAIN_THRESHOLD });
    expect(explainLowConfidence(r)).toBeNull();
  });

  it('returns null when confidence is above the threshold', () => {
    const r = makeReport({ confidence: 0.95 });
    expect(explainLowConfidence(r)).toBeNull();
  });

  it('returns null when confidence is low but nothing explains it', () => {
    const r = makeReport({ confidence: 0.4 });
    expect(explainLowConfidence(r)).toBeNull();
  });

  it('includes unconfigured runtime sources when sourceStatus present', () => {
    const r = makeReport({
      confidence: 0.4,
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    const reasons = explainLowConfidence(r)!;
    expect(reasons).not.toBeNull();
    expect(reasons.some((r) => r.includes('no runtime data'))).toBe(true);
    expect(reasons.some((r) => r.includes('logs'))).toBe(true);
  });

  it('includes top gap by confidence impact', () => {
    const r = makeReport({
      confidence: 0.5,
      gapAnalysis: {
        gaps: [
          { dimension: 'metrics', why: 'Grafana not configured.', nextSource: 'connect grafana', confidenceImpact: 0.1 },
          { dimension: 'logs', why: 'Elasticsearch not configured.', nextSource: 'connect elasticsearch', confidenceImpact: 0.25 },
        ],
        blindSpots: [],
        confidenceCeiling: 0.75,
      },
    });
    const reasons = explainLowConfidence(r)!;
    expect(reasons).not.toBeNull();
    const gapLine = reasons.find((r) => r.startsWith('top gap:'))!;
    expect(gapLine).toBeDefined();
    expect(gapLine).toContain('logs');
    expect(gapLine).toContain('−0.25 conf');
  });

  it('includes confidence ceiling when below 1.0', () => {
    const r = makeReport({
      confidence: 0.5,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Not configured.', nextSource: 'n/a', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 0.7,
      },
    });
    const reasons = explainLowConfidence(r)!;
    expect(reasons.some((r) => r.includes('confidence ceiling: 0.7'))).toBe(true);
  });

  it('omits confidence ceiling when it is 1.0', () => {
    const r = makeReport({
      confidence: 0.5,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Not configured.', nextSource: 'n/a', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 1.0,
      },
    });
    const reasons = explainLowConfidence(r)!;
    expect(reasons.every((r) => !r.includes('confidence ceiling'))).toBe(true);
  });

  it('includes first correlation missing-evidence note', () => {
    const r = makeReport({
      confidence: 0.45,
      correlation: {
        groups: [],
        chains: [],
        missing: [
          { kind: 'change', note: 'No recent commit evidence for the affected file.' },
          { kind: 'change', note: 'Second note should be omitted.' },
        ],
      },
    });
    const reasons = explainLowConfidence(r)!;
    expect(reasons.some((r) => r.includes('No recent commit evidence'))).toBe(true);
    expect(reasons.filter((r) => r.includes('missing evidence:')).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderReport — Why confidence is not higher section (HOR-105)
// ---------------------------------------------------------------------------

describe('renderReport — why confidence is not higher (HOR-105)', () => {
  it('omits section when confidence is at threshold', () => {
    const r = makeReport({
      confidence: CONFIDENCE_EXPLAIN_THRESHOLD,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Not configured.', nextSource: 'n/a', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 0.8,
      },
    });
    expect(renderReport(r)).not.toContain('Why confidence is not higher');
  });

  it('omits section when confidence is high and no explanations', () => {
    const r = makeReport({ confidence: 0.95 });
    expect(renderReport(r)).not.toContain('Why confidence is not higher');
  });

  it('includes section when confidence is low and gaps exist', () => {
    const r = makeReport({
      confidence: 0.45,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Elasticsearch not configured.', nextSource: 'connect elasticsearch', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 0.75,
      },
    });
    const output = renderReport(r);
    expect(output).toContain('## Why confidence is not higher');
    expect(output).toContain('logs');
    expect(output).toContain('confidence ceiling: 0.75');
  });

  it('section appears after Summary and before Similar past incidents', () => {
    const r = makeReport({
      confidence: 0.4,
      gapAnalysis: {
        gaps: [{ dimension: 'metrics', why: 'Grafana missing.', nextSource: 'n/a', confidenceImpact: 0.15 }],
        blindSpots: [],
        confidenceCeiling: 0.8,
      },
    });
    const output = renderReport(r);
    const whyIdx = output.indexOf('## Why confidence is not higher');
    const summaryIdx = output.indexOf('## Summary');
    const similarIdx = output.indexOf('## Similar past incidents');
    expect(whyIdx).toBeGreaterThan(summaryIdx);
    expect(whyIdx).toBeLessThan(similarIdx);
  });
});

// ---------------------------------------------------------------------------
// reportToMarkdown — Why confidence is not higher section (HOR-105)
// ---------------------------------------------------------------------------

describe('reportToMarkdown — why confidence is not higher (HOR-105)', () => {
  it('omits section when confidence meets threshold', () => {
    const r = makeReport({
      confidence: CONFIDENCE_EXPLAIN_THRESHOLD,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Not configured.', nextSource: 'n/a', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 0.8,
      },
    });
    expect(reportToMarkdown(r)).not.toContain('Why confidence is not higher');
  });

  it('includes section for low confidence with sources not configured', () => {
    const r = makeReport({
      confidence: 0.35,
      sourceStatus: makeSourceStatus([
        { source: 'logs', status: 'not-configured' },
        { source: 'metrics', status: 'not-configured' },
        { source: 'state', status: 'not-configured' },
        { source: 'queue', status: 'not-configured' },
      ]),
    });
    const output = reportToMarkdown(r);
    expect(output).toContain('## Why confidence is not higher');
    expect(output).toContain('no runtime data');
  });

  it('renders reasons as bullet list', () => {
    const r = makeReport({
      confidence: 0.4,
      gapAnalysis: {
        gaps: [{ dimension: 'logs', why: 'Not configured.', nextSource: 'n/a', confidenceImpact: 0.2 }],
        blindSpots: [],
        confidenceCeiling: 0.75,
      },
    });
    const output = reportToMarkdown(r);
    const lines = output.split('\n');
    const whyIdx = lines.findIndex((l) => l === '## Why confidence is not higher');
    expect(whyIdx).toBeGreaterThan(-1);
    const bulletLines = lines.slice(whyIdx + 1).filter((l) => l.startsWith('- '));
    expect(bulletLines.length).toBeGreaterThan(0);
  });
});

// ── Source-only hypothesis placeholder note (HOR-183) ─────────────────────────

describe('renderReport — source-only hypothesis placeholder note', () => {
  it('adds a placeholder note when every hypothesis is unconfirmed', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp-1',
          category: 'external-api-latency',
          statement: 'An upstream API is slow.',
          confidence: 0.2,
          priorConfidence: 0.2,
          verdict: 'unconfirmed',
          supportingPresent: 0,
          contradictingPresent: 0,
          rationale: '0 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingEvidence: ['Request latency metrics'],
        },
      ],
    });
    const output = renderReport(r);
    expect(output).toContain('All hypotheses below are unconfirmed placeholders');
  });

  it('omits the placeholder note when at least one hypothesis is supported', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp-1',
          category: 'external-api-latency',
          statement: 'An upstream API is slow.',
          confidence: 0.2,
          priorConfidence: 0.2,
          verdict: 'unconfirmed',
          supportingPresent: 0,
          contradictingPresent: 0,
          rationale: '0 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingEvidence: ['Request latency metrics'],
        },
        {
          id: 'hyp-2',
          category: 'deployment-regression',
          statement: 'A recent change introduced the fault.',
          confidence: 0.65,
          priorConfidence: 0.5,
          verdict: 'supported',
          supportingPresent: 1,
          contradictingPresent: 0,
          rationale: '1 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: ['ev-1'],
          contradictingEvidenceIds: [],
          missingEvidence: [],
        },
      ],
    });
    expect(renderReport(r)).not.toContain('All hypotheses below are unconfirmed placeholders');
  });

  it('omits the placeholder note when there are no hypotheses', () => {
    expect(renderReport(makeReport())).not.toContain('All hypotheses below are unconfirmed placeholders');
  });
});

describe('reportToMarkdown — source-only hypothesis placeholder note', () => {
  it('adds a placeholder note when every hypothesis is unconfirmed', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp-1',
          category: 'retry-storm',
          statement: 'A retry storm is amplifying load.',
          confidence: 0.15,
          priorConfidence: 0.15,
          verdict: 'unconfirmed',
          supportingPresent: 0,
          contradictingPresent: 0,
          rationale: '0 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingEvidence: ['Retry/error logs'],
        },
      ],
    });
    expect(reportToMarkdown(r)).toContain('All hypotheses below are unconfirmed placeholders');
  });

  it('omits the placeholder note when at least one hypothesis is supported', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp-1',
          category: 'retry-storm',
          statement: 'A retry storm is amplifying load.',
          confidence: 0.15,
          priorConfidence: 0.15,
          verdict: 'unconfirmed',
          supportingPresent: 0,
          contradictingPresent: 0,
          rationale: '0 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingEvidence: ['Retry/error logs'],
        },
        {
          id: 'hyp-2',
          category: 'deployment-regression',
          statement: 'A recent change introduced the fault.',
          confidence: 0.65,
          priorConfidence: 0.5,
          verdict: 'supported',
          supportingPresent: 1,
          contradictingPresent: 0,
          rationale: '1 supporting / 0 contradicting evidence present.',
          supportingEvidenceIds: ['ev-1'],
          contradictingEvidenceIds: [],
          missingEvidence: [],
        },
      ],
    });
    expect(reportToMarkdown(r)).not.toContain('All hypotheses below are unconfirmed placeholders');
  });
});

// ── Recent changes rendering (HOR-94) ────────────────────────────────────────

import type { BoundedGitChange } from './git-collector.js';

function makeGitChange(overrides: Partial<BoundedGitChange> = {}): BoundedGitChange {
  return {
    commits: [],
    fileStats: [],
    changedFiles: [],
    totalInsertions: 0,
    totalDeletions: 0,
    window: { since: '24 hours ago', until: undefined },
    truncated: false,
    degenerate: false,
    ...overrides,
  };
}

describe('renderReport — Recent changes section (HOR-94)', () => {
  it('omits Recent changes section when recentChanges is absent', () => {
    const output = renderReport(makeReport());
    expect(output).not.toContain('## Recent changes');
  });

  it('omits Recent changes section when commits array is empty', () => {
    const output = renderReport(makeReport({ recentChanges: makeGitChange({ commits: [] }) }));
    expect(output).not.toContain('## Recent changes');
  });

  it('renders Recent changes section with commits', () => {
    const rc = makeGitChange({
      commits: [
        { sha: 'abc1234def5', shortSha: 'abc1234', author: 'Alice', dateIso: '2026-06-15T12:00:00Z', subject: 'fix: payment timeout', files: [] },
        { sha: 'def5678abc1', shortSha: 'def5678', author: 'Bob',   dateIso: '2026-06-15T10:00:00Z', subject: 'chore: update deps',   files: [] },
      ],
    });
    const output = renderReport(makeReport({ recentChanges: rc }));
    expect(output).toContain('## Recent changes');
    expect(output).toContain('abc1234 fix: payment timeout');
    expect(output).toContain('def5678 chore: update deps');
    expect(output).toContain('Window: 24 hours ago..HEAD');
    expect(output).toContain('Commits: 2');
  });

  it('renders file stats when present', () => {
    const rc = makeGitChange({
      commits: [{ sha: 'abc1234def5', shortSha: 'abc1234', author: 'Alice', dateIso: '', subject: 'fix: x', files: [] }],
      fileStats: [{ path: 'src/payment.ts', insertions: 3, deletions: 1 }],
      changedFiles: ['src/payment.ts'],
    });
    const output = renderReport(makeReport({ recentChanges: rc }));
    expect(output).toContain('+3 -1 src/payment.ts');
    expect(output).toContain('Files: 1');
  });

  it('shows truncation note when truncated', () => {
    const rc = makeGitChange({
      commits: [{ sha: 'abc1234def5', shortSha: 'abc1234', author: 'Alice', dateIso: '', subject: 'fix: x', files: [] }],
      truncated: true,
      truncatedReason: 'commits capped at 50',
    });
    const output = renderReport(makeReport({ recentChanges: rc }));
    expect(output).toContain('truncated: commits capped at 50');
    expect(output).toContain('Commits: 1+');
  });

  it('Recent changes section appears before Next actions', () => {
    const rc = makeGitChange({
      commits: [{ sha: 'abc1234def5', shortSha: 'abc1234', author: 'Alice', dateIso: '', subject: 'fix: x', files: [] }],
    });
    const output = renderReport(makeReport({ recentChanges: rc }));
    const rcIdx = output.indexOf('## Recent changes');
    const nextIdx = output.indexOf('## Next actions');
    expect(rcIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(rcIdx);
  });
});
