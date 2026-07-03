/**
 * HOR-384 — Unit tests for the Agent Packet projection.
 *
 * Pure, no I/O. Covers honesty propagation (capped / fuzzy-seed / stale-index /
 * single-source / degraded), the hard compact cap + "+N more" truncation, and the
 * conservative Lower-priority section (gating + wording).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence, Symbol } from '@horus/core';
import type { MemoryItem } from '@horus/db';
import type { InvestigationReport } from './types.js';
import type { CauseCandidate } from './score-cause.js';
import type { RecalledMemory, MemoryFreshness } from './memory-recall.js';
import {
  buildPacket,
  renderPacketMarkdown,
  packetToJSON,
  LOWER_PRIORITY_TITLE,
} from './packet.js';

const NOW = '2026-06-28T00:00:00.000Z';

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'inv-test',
    input: { hint: 'payments failing' },
    summary: 'Investigation of "payments failing" resolved to PaymentService (payments). Top suspected cause: queue backlog.',
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

function makeSeed(over: Partial<Symbol> = {}): Symbol {
  return {
    id: 'sym:PaymentService.charge',
    name: 'PaymentService.charge',
    filePath: 'src/payments/payment.service.ts',
    startLine: 10,
    endLine: 40,
    score: 0.9,
    ...over,
  };
}

function makeEv(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev_1',
    source: 'logs',
    kind: 'log',
    title: 'Error log',
    relevance: 0.8,
    priority: 'high',
    payload: {},
    links: {},
    provenance: { query: 'q', collectedAt: NOW },
    ...over,
  };
}

function makeCause(over: Partial<CauseCandidate> = {}): CauseCandidate {
  return {
    id: 'cause:1',
    title: 'queue backlog',
    category: 'queue-backlog',
    sourceEvidenceIds: [],
    affectedNodeIds: [],
    baseScore: 0.6,
    finalScore: 0.6,
    confidence: 0.6,
    band: 'possible',
    explanations: [],
    ...over,
  };
}

// ── Honesty header ─────────────────────────────────────────────────────────

describe('buildPacket — honesty header', () => {
  it('derives the band from report.confidence (same thresholds as getBand)', () => {
    expect(buildPacket(makeReport({ confidence: 0.9 }), { now: NOW }).honesty.band).toBe('highly-likely');
    expect(buildPacket(makeReport({ confidence: 0.7 }), { now: NOW }).honesty.band).toBe('likely');
    expect(buildPacket(makeReport({ confidence: 0.5 }), { now: NOW }).honesty.band).toBe('possible');
    expect(buildPacket(makeReport({ confidence: 0.2 }), { now: NOW }).honesty.band).toBe('observation');
  });

  it('flags working hypothesis + caveat when the headline is not seed-linked (CAP A)', () => {
    const seedEv = makeEv({ id: 'ev_seed', kind: 'symbol', priority: 'info', links: { symbolId: 'sym:PaymentService.charge', file: 'src/payments/payment.service.ts' } });
    const otherEv = makeEv({ id: 'ev_other', links: { file: 'src/other.ts' } });
    const report = makeReport({
      seeds: [makeSeed()],
      evidence: [seedEv, otherEv],
      // headline cites only unrelated evidence → not seed-linked
      suspectedCauses: [makeCause({ sourceEvidenceIds: ['ev_other'], finalScore: 0.6 })],
      confidence: 0.6,
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.workingHypothesis).toBe(true);
    expect(p.honesty.caveats[0]).toBe('Working hypothesis, not a root-cause conclusion.');
    expect(p.honesty.caveats).toContain(
      'No cause is structurally linked to the seed; the strongest signal is a lead to verify, not a diagnosis.',
    );
    expect(p.problem.headlineCause?.seedLinked).toBe(false);
  });

  it('does not flag working hypothesis when seed-linked and highly-likely', () => {
    const seedEv = makeEv({ id: 'ev_seed', kind: 'symbol', priority: 'info', links: { symbolId: 'sym:PaymentService.charge', file: 'src/payments/payment.service.ts' } });
    const report = makeReport({
      seeds: [makeSeed()],
      evidence: [seedEv, makeEv({ id: 'ev_log' })],
      suspectedCauses: [makeCause({ sourceEvidenceIds: ['ev_seed', 'ev_log'], finalScore: 0.9, band: 'highly-likely' })],
      confidence: 0.9,
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.problem.headlineCause?.seedLinked).toBe(true);
    expect(p.honesty.workingHypothesis).toBe(false);
    expect(p.honesty.caveats).not.toContain('Working hypothesis, not a root-cause conclusion.');
  });

  it('surfaces the fuzzy-seed disclaimer (CAP C) from the summary', () => {
    const report = makeReport({
      summary:
        '⚠ No symbol closely matched "payments failing" — "charge" is a low-confidence closest match (semantic). Refine with an exact symbol or error code to target precisely. Investigation of "payments failing" could not be confidently localized from source alone.',
      seeds: [makeSeed({ score: 0.2 })],
      confidence: 0.45,
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.workingHypothesis).toBe(true);
    expect(p.honesty.caveats.some((c) => c.startsWith('⚠ No symbol closely matched'))).toBe(true);
  });

  it('surfaces the gap-ceiling caveat (CAP B) when confidence sits at the ceiling', () => {
    const report = makeReport({
      seeds: [makeSeed()],
      confidence: 0.7,
      gapAnalysis: {
        gaps: [
          { dimension: 'logs', why: 'no logs', nextSource: 'add elasticsearch', confidenceImpact: 0.1 },
          { dimension: 'metrics', why: 'no metrics', nextSource: 'add grafana', confidenceImpact: 0.2 },
        ],
        blindSpots: ['Cannot see the real error.'],
        confidenceCeiling: 0.7,
      },
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.caveats).toContain('Confidence is capped at 0.7 until evidence gaps are filled.');
    // blind spots are carried through verbatim
    expect(p.honesty.caveats).toContain('Cannot see the real error.');
    // toRaiseConfidence is sorted by impact desc and never truncated
    expect(p.honesty.toRaiseConfidence).toEqual(['add grafana', 'add elasticsearch']);
  });

  it('surfaces the single-source ceiling caveat (CAP E)', () => {
    const report = makeReport({
      seeds: [makeSeed()],
      confidence: 0.84,
      suspectedCauses: [
        makeCause({
          sourceEvidenceIds: ['ev_seed'],
          finalScore: 0.84,
          explanations: [{ factor: 'single-source-ceiling', delta: -0.05, reason: 'capped' }],
        }),
      ],
      evidence: [makeEv({ id: 'ev_seed', kind: 'symbol', priority: 'info', links: { symbolId: 'sym:PaymentService.charge', file: 'src/payments/payment.service.ts' } })],
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.caveats).toContain('Headline rests on a single provider — no multi-source corroboration.');
  });

  it('appends freshness caveats and the semantic-search-off caveat', () => {
    const report = makeReport({ seeds: [makeSeed()], confidence: 0.6 });
    const p = buildPacket(report, {
      now: NOW,
      freshness: {
        indexStale: true,
        caveats: ['code index is 9d old — re-run `horus init` so analysis reflects current code'],
        semanticSearchReady: false,
      },
    });
    expect(p.honesty.caveats).toContain('code index is 9d old — re-run `horus init` so analysis reflects current code');
    expect(p.honesty.caveats.some((c) => c.startsWith('semantic search degraded to keyword/FTS'))).toBe(true);
  });

  it('adds the degraded banner caveat for runtime-only runs', () => {
    const report = makeReport({
      confidence: 0.4,
      degraded: { sourceIntelligence: true, reason: 'code host unreachable' },
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.caveats).toContain('Runtime-only (source intelligence unavailable)');
  });

  it('maps sourceStatus preserving empty-vs-failed-vs-not-configured', () => {
    const report = makeReport({
      seeds: [makeSeed()],
      sourceStatus: {
        sources: [
          { source: 'logs', configured: true, evidenceCount: 3, status: 'contributed' },
          { source: 'metrics', configured: true, evidenceCount: 0, status: 'empty' },
          { source: 'state', configured: true, evidenceCount: 0, status: 'failed' },
          { source: 'queue', configured: false, evidenceCount: 0, status: 'not-configured' },
        ],
      },
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.honesty.sources).toEqual([
      { source: 'logs', status: 'contributed' },
      { source: 'metrics', status: 'empty' },
      { source: 'state', status: 'failed' },
      { source: 'queue', status: 'not-configured' },
    ]);
  });
});

// ── Relevant files / evidence projection ─────────────────────────────────────

describe('buildPacket — files and evidence', () => {
  it('puts the seed file first with its provenance and excludes structural evidence', () => {
    const seedEv = makeEv({ id: 'ev_seed', kind: 'symbol', priority: 'info', links: { symbolId: 'sym:PaymentService.charge', file: 'src/payments/payment.service.ts' } });
    const impactEv = makeEv({ id: 'ev_impact', kind: 'impact', priority: 'info', title: 'Blast radius', links: {} });
    const logEv = makeEv({ id: 'ev_log', kind: 'log', priority: 'critical', title: 'Charge failed', relevance: 0.95, links: { file: 'src/payments/charge.ts', line: 5 } });
    const report = makeReport({
      seeds: [makeSeed()],
      evidence: [seedEv, impactEv, logEv],
      suspectedCauses: [makeCause({ sourceEvidenceIds: ['ev_log'] })],
    });
    const p = buildPacket(report, { now: NOW });

    expect(p.relevantFiles[0]).toEqual({
      path: 'src/payments/payment.service.ts',
      symbol: 'PaymentService.charge',
      line: 10,
      why: 'seed symbol resolved from hint',
    });
    expect(p.relevantFiles.some((f) => f.path === 'src/payments/charge.ts')).toBe(true);

    // structural symbol/impact evidence is excluded; the runtime log remains
    expect(p.evidence.map((e) => e.title)).toEqual(['Charge failed']);
    expect(p.evidence[0]!.link).toEqual({ file: 'src/payments/charge.ts', line: 5 });
  });

  it('ranks evidence by priority tier then relevance', () => {
    const report = makeReport({
      evidence: [
        makeEv({ id: 'a', priority: 'low', relevance: 0.9, title: 'low' }),
        makeEv({ id: 'b', priority: 'critical', relevance: 0.4, title: 'critical' }),
        makeEv({ id: 'c', priority: 'high', relevance: 0.95, title: 'high-a' }),
        makeEv({ id: 'd', priority: 'high', relevance: 0.5, title: 'high-b' }),
      ],
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.evidence.map((e) => e.title)).toEqual(['critical', 'high-a', 'high-b', 'low']);
  });
});

// ── Hard compact cap ─────────────────────────────────────────────────────────

describe('buildPacket — hard compact cap', () => {
  it('caps each section at top-N, records drop counts, and sets meta.truncated', () => {
    const evidence = Array.from({ length: 9 }, (_, i) =>
      makeEv({ id: `ev_${i}`, priority: 'high', relevance: 1 - i * 0.01, title: `e${i}` }),
    );
    const report = makeReport({
      seeds: [makeSeed()],
      evidence,
      nextActions: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
    });
    const p = buildPacket(report, { now: NOW, topEvidence: 5, topSteps: 5 });
    expect(p.evidence).toHaveLength(5);
    expect(p.truncation.evidence).toBe(4);
    expect(p.nextSteps).toHaveLength(5);
    expect(p.truncation.nextSteps).toBe(2);
    expect(p.meta.truncated).toBe(true);

    const md = renderPacketMarkdown(p);
    expect(md).toContain('+4 more');
    expect(md).toContain('+2 more');
  });

  it('a preset only lowers caps, never raises them', () => {
    const evidence = Array.from({ length: 6 }, (_, i) => makeEv({ id: `ev_${i}`, priority: 'high', title: `e${i}` }));
    const report = makeReport({ evidence });
    const p = buildPacket(report, { now: NOW, preset: 'cursor', topEvidence: 10 });
    // cursor preset caps evidence at 3 even though topEvidence asked for 10
    expect(p.evidence).toHaveLength(3);
  });

  it('never truncates the honesty header', () => {
    const gaps = Array.from({ length: 6 }, (_, i) => ({
      dimension: `d${i}`,
      why: 'w',
      nextSource: `next-${i}`,
      confidenceImpact: 0.05,
    }));
    const report = makeReport({
      seeds: [makeSeed()],
      gapAnalysis: { gaps, blindSpots: ['bs1', 'bs2', 'bs3', 'bs4', 'bs5', 'bs6'], confidenceCeiling: 0.7 },
      confidence: 0.7,
    });
    const p = buildPacket(report, { now: NOW, topSteps: 2 });
    expect(p.honesty.toRaiseConfidence).toHaveLength(6);
    expect(p.honesty.caveats.filter((c) => c.startsWith('bs')).length).toBe(6);
  });
});

// ── Lower-priority (conservative anti-context) ──────────────────────────────

describe('buildPacket — lower-priority section', () => {
  const externalNode = {
    id: 'external_system:StripeAPI',
    type: 'external_system' as const,
    label: 'StripeAPI',
    evidenceIds: ['ev_ext'],
    implicated: false,
    implicationScore: 0,
  };

  function lowerEnabledReport(over: Partial<InvestigationReport> = {}): InvestigationReport {
    return makeReport({
      seeds: [makeSeed()],
      evidence: [makeEv({ id: 'ev_ext', kind: 'state', source: 'state', priority: 'info', relevance: 0.1, links: { file: 'src/integrations/stripe.ts' } })],
      graph: { nodes: [externalNode], edges: [] },
      recentChanges: {
        commits: [],
        fileStats: [],
        changedFiles: ['src/payments/payment.service.ts'],
        totalInsertions: 0,
        totalDeletions: 0,
        window: { since: 'HEAD~14', until: undefined },
        truncated: false,
      },
      sourceStatus: {
        sources: [
          { source: 'logs', configured: true, evidenceCount: 2, status: 'contributed' },
          { source: 'metrics', configured: true, evidenceCount: 0, status: 'empty' },
          { source: 'state', configured: true, evidenceCount: 1, status: 'contributed' },
          { source: 'queue', configured: true, evidenceCount: 0, status: 'empty' },
        ],
      },
      confidence: 0.8,
      gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 0.8 },
      ...over,
    });
  }

  it('emits an off-path, no-evidence, out-of-window area with conservative wording', () => {
    const p = buildPacket(lowerEnabledReport(), { now: NOW });
    expect(p.lowerPriority).toHaveLength(1);
    const area = p.lowerPriority[0]!;
    expect(area.area).toBe('StripeAPI');
    expect(area.reasons).toContain(
      'the component reporting an error is often not the cause; static reachability misses dynamic dispatch, event buses, and cross-service calls.',
    );
    // never uses prohibited verdict wording
    const blob = JSON.stringify(p.lowerPriority).toLowerCase();
    expect(blob).not.toContain('ruled out');
    expect(blob).not.toContain('safe to ignore');
    expect(blob).not.toContain('not affected');
  });

  it('uses the fixed, conservative section title in markdown', () => {
    const md = renderPacketMarkdown(buildPacket(lowerEnabledReport(), { now: NOW }));
    expect(md).toContain(`## ${LOWER_PRIORITY_TITLE}`);
    expect(md.toLowerCase()).not.toContain('ruled out');
  });

  it('suppresses the list when source intelligence is degraded', () => {
    const p = buildPacket(
      lowerEnabledReport({ degraded: { sourceIntelligence: true, reason: 'no code host' } }),
      { now: NOW },
    );
    expect(p.lowerPriority).toEqual([]);
  });

  it('suppresses the list when recentChanges is undefined', () => {
    const p = buildPacket(lowerEnabledReport({ recentChanges: undefined }), { now: NOW });
    expect(p.lowerPriority).toEqual([]);
  });

  it('suppresses the list when the seed is fuzzy / low-confidence', () => {
    const p = buildPacket(
      lowerEnabledReport({ seeds: [makeSeed({ score: 0.2 })], summary: '⚠ No symbol closely matched "x" — precisely.' }),
      { now: NOW },
    );
    expect(p.lowerPriority).toEqual([]);
  });

  it('suppresses an area whose file changed in the window (leg 3 fails)', () => {
    const report = lowerEnabledReport();
    report.recentChanges!.changedFiles = ['src/integrations/stripe.ts'];
    const p = buildPacket(report, { now: NOW });
    expect(p.lowerPriority).toEqual([]);
  });

  it('suppresses an implicated area (leg 2 fails)', () => {
    const report = lowerEnabledReport();
    report.graph.nodes[0]!.implicated = true;
    const p = buildPacket(report, { now: NOW });
    expect(p.lowerPriority).toEqual([]);
  });

  it('shrinks the list as the confidence ceiling drops', () => {
    // ceiling 0.6 → effectiveTopLower 1; with a single candidate this stays 1, but ceiling 0.4 → 0
    const report = lowerEnabledReport({
      confidence: 0.4,
      gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 0.4 },
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.lowerPriority).toEqual([]);
  });

  it('never lower-prioritises a protected "Candidate areas (ranked)" alternative seed', () => {
    const report = lowerEnabledReport({
      findings: [
        {
          kind: 'observation',
          title: 'Candidate areas (ranked): StripeAPI [service], Other [worker]',
          confidence: 0.5,
          evidenceIds: [],
        },
      ],
    });
    const p = buildPacket(report, { now: NOW });
    expect(p.lowerPriority).toEqual([]);
  });
});

// ── Remembered context (memory) ────────────────────────────────────────────────

function makeMemItem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem_1',
    kind: 'pitfall',
    claim: 'PaymentService retries are not idempotent',
    scope: 'repo',
    source: 'human',
    evidence: [],
    confidence: 0.9,
    status: 'fresh',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastVerifiedAt: null,
    lastVerifiedHash: null,
    orgId: null,
    workspaceId: null,
    repo: 'r',
    userId: null,
    visibility: 'private',
    payload: null,
    ...over,
  } as MemoryItem;
}

function makeFreshness(over: Partial<MemoryFreshness> = {}): MemoryFreshness {
  return {
    status: 'fresh',
    ageDays: 12,
    verified: true,
    decay: 0.8,
    driftDetected: false,
    label: 'recent',
    ...over,
  };
}

function makeRecalled(
  item: Partial<MemoryItem> = {},
  freshness: Partial<MemoryFreshness> = {},
  rank = 0.7,
): RecalledMemory {
  return { item: makeMemItem(item), relevance: 0, freshness: makeFreshness(freshness), rank };
}

describe('buildPacket — remembered context (memory)', () => {
  it('projects recalled memory into the packet, carrying claim/kind/scope/status/freshness/confidence', () => {
    const recalled = makeRecalled(
      { id: 'mem_a', claim: 'retries not idempotent', kind: 'pitfall', scope: 'symbol:charge', confidence: 0.9 },
      { status: 'fresh', label: 'recent', ageDays: 12, driftDetected: false },
    );
    const p = buildPacket(makeReport(), { now: NOW, memory: [recalled] });
    expect(p.memory).toHaveLength(1);
    expect(p.memory[0]).toEqual({
      id: 'mem_a',
      claim: 'retries not idempotent',
      kind: 'pitfall',
      scope: 'symbol:charge',
      confidence: 0.9,
      status: 'fresh',
      freshness: 'recent',
      ageDays: 12,
      driftDetected: false,
    });
  });

  it('uses the EFFECTIVE (display) status + the claim\'s OWN confidence — never the report confidence', () => {
    // report confidence is low; memory claim confidence is high + recall downgraded it to stale.
    const recalled = makeRecalled(
      { confidence: 0.95 },
      { status: 'possibly-stale', label: 'possibly-stale', driftDetected: true },
    );
    const p = buildPacket(makeReport({ confidence: 0.2 }), { now: NOW, memory: [recalled] });
    expect(p.honesty.confidence).toBe(0.2); // memory NEVER moves the headline confidence
    expect(p.memory[0]?.confidence).toBe(0.95);
    expect(p.memory[0]?.status).toBe('possibly-stale');
    expect(p.memory[0]?.driftDetected).toBe(true);
  });

  it('preserves recall order verbatim (the packet never re-ranks remembered context)', () => {
    const a = makeRecalled({ id: 'a', claim: 'A' }, {}, 0.9);
    const b = makeRecalled({ id: 'b', claim: 'B' }, {}, 0.1);
    const p = buildPacket(makeReport(), { now: NOW, memory: [a, b] });
    expect(p.memory.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('caps the surfaced subset at topMemory and records the truncated count', () => {
    const items = Array.from({ length: 7 }, (_, i) => makeRecalled({ id: `m${i}`, claim: `c${i}` }));
    const p = buildPacket(makeReport(), { now: NOW, memory: items, topMemory: 5 });
    expect(p.memory).toHaveLength(5);
    expect(p.truncation.memory).toBe(2);
    expect(p.meta.truncated).toBe(true);
  });

  it('with no recalled memory, the section is empty and not truncated', () => {
    const p = buildPacket(makeReport(), { now: NOW });
    expect(p.memory).toEqual([]);
    expect(p.truncation.memory).toBe(0);
  });

  it('renders a clearly-labelled "not live evidence" section with an honesty disclaimer', () => {
    const recalled = makeRecalled({ claim: 'queue is at-least-once; consumers must dedupe' });
    const md = renderPacketMarkdown(buildPacket(makeReport(), { now: NOW, memory: [recalled] }));
    expect(md).toContain('## Remembered context (not live evidence)');
    expect(md).toContain("never overrides the current run's evidence");
    expect(md).toContain('- queue is at-least-once; consumers must dedupe');
  });

  it('omits the memory section from Markdown entirely when there is nothing remembered', () => {
    const md = renderPacketMarkdown(buildPacket(makeReport(), { now: NOW }));
    expect(md).not.toContain('Remembered context');
  });

  it('serialises memory as a clean PacketSection with a sibling truncatedCount', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeRecalled({ id: `m${i}`, claim: `c${i}` }));
    const json = packetToJSON(buildPacket(makeReport(), { now: NOW, memory: items, topMemory: 4 }));
    expect(json.memory.items).toHaveLength(4);
    expect(json.memory.truncatedCount).toBe(2);
    expect(Array.isArray(json.memory.items)).toBe(true);
  });

  it('a preset lowers the memory cap (claude → 4) without dropping data from the section count', () => {
    const items = Array.from({ length: 6 }, (_, i) => makeRecalled({ id: `m${i}`, claim: `c${i}` }));
    const p = buildPacket(makeReport(), { now: NOW, memory: items, preset: 'claude' });
    expect(p.memory).toHaveLength(4);
    expect(p.truncation.memory).toBe(2);
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe('packetToJSON', () => {
  it('keeps arrays clean and attaches truncatedCount per section', () => {
    const evidence = Array.from({ length: 7 }, (_, i) => makeEv({ id: `ev_${i}`, priority: 'high', title: `e${i}` }));
    const report = makeReport({ evidence });
    const json = packetToJSON(buildPacket(report, { now: NOW, topEvidence: 5 }));
    expect(json.evidence.items).toHaveLength(5);
    expect(json.evidence.truncatedCount).toBe(2);
    expect(Array.isArray(json.relevantFiles.items)).toBe(true);
    expect(json.meta.generatedAt).toBe(NOW);
  });

  it('round-trips deterministically (stable JSON)', () => {
    const report = makeReport({ seeds: [makeSeed()], evidence: [makeEv()] });
    const a = JSON.stringify(packetToJSON(buildPacket(report, { now: NOW })));
    const b = JSON.stringify(packetToJSON(buildPacket(report, { now: NOW })));
    expect(a).toBe(b);
  });
});
