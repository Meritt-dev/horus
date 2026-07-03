/**
 * HOR-62 — Tests for the --ai flag and narrative input builder in runInvestigate.
 *
 * All tests are offline: no connectors, no live API calls.
 * We verify:
 *   - buildNarrativeInput maps InvestigationReport fields correctly
 *   - the --ai path is a boolean flag registered on the investigate command
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildNarrativeInput,
  classifyAIFailure,
  runInvestigate,
  withDeadline,
} from './investigate.js';

describe('withDeadline (investigation timeout safety)', () => {
  it('resolves with the value when the promise settles before the deadline', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('rejects with an actionable message when the deadline passes (never hangs)', async () => {
    const neverSettles = new Promise<number>(() => {});
    await expect(withDeadline(neverSettles, 20)).rejects.toThrow(/was aborted/);
  });
});
import type { InvestigationReport } from '@horus/engine';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

function writeSingleEnvConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-investigate-'));
  dirs.push(dir);
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`,
    'utf8',
  );
  return path;
}

// ---------------------------------------------------------------------------
// Minimal fixture — enough to exercise buildNarrativeInput without connectors
// ---------------------------------------------------------------------------

const MINIMAL_REPORT: InvestigationReport = {
  id: 'test-report-001',
  input: { hint: 'BullMQ workers stalling', service: 'leadcall-api' },
  summary: 'Workers stalled after a concurrency bump.',
  seeds: [],
  evidence: [
    {
      id: 'ev-001',
      source: 'logs',
      kind: 'log',
      title: 'Worker stalled: job exceeded lockDuration',
      relevance: 0.9,
      payload: {},
      links: {},
      provenance: { query: 'es:*', collectedAt: '2026-06-15T10:00:00.000Z' },
      priority: 'critical',
    },
    {
      id: 'ev-002',
      source: 'history',
      kind: 'commit',
      title: 'Increase worker concurrency from 2 to 10',
      relevance: 0.8,
      payload: {},
      links: {},
      provenance: { query: 'git log', collectedAt: '2026-06-15T10:00:00.000Z' },
      priority: 'high',
    },
  ],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [
    { kind: 'correlation', title: 'Concurrency bump correlates with stalls', confidence: 0.88, evidenceIds: ['ev-001', 'ev-002'] },
  ],
  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Redis pool exhausted',
      category: 'queue-backlog',
      sourceEvidenceIds: ['ev-001', 'ev-002'],
      affectedNodeIds: [],
      baseScore: 0.7,
      finalScore: 0.82,
      confidence: 0.82,
      band: 'likely',
      explanations: [],
    },
  ],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1.0 },
  graph: { nodes: [], edges: [] },
  confidence: 0.78,
  nextActions: ['Roll back concurrency'],
};

// ---------------------------------------------------------------------------
// buildNarrativeInput
// ---------------------------------------------------------------------------

describe('buildNarrativeInput', () => {
  it('sets investigationId from report.id', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.investigationId).toBe('test-report-001');
  });

  it('sets hint from report.input.hint', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.hint).toBe('BullMQ workers stalling');
  });

  it('sets reportConfidence from report.confidence', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.reportConfidence).toBe(0.78);
  });

  it('maps all evidence items with id, kind, title', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.evidence).toHaveLength(2);
    expect(input.evidence[0]).toMatchObject({ id: 'ev-001', kind: 'log', title: 'Worker stalled: job exceeded lockDuration' });
    expect(input.evidence[1]).toMatchObject({ id: 'ev-002', kind: 'commit', title: 'Increase worker concurrency from 2 to 10' });
  });

  it('includes knownServices when report.input.service is set', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.knownServices).toEqual(['leadcall-api']);
  });

  it('returns empty knownServices when report.input.service is absent', () => {
    const report = { ...MINIMAL_REPORT, input: { ...MINIMAL_REPORT.input, service: undefined } };
    const input = buildNarrativeInput(report);
    expect(input.knownServices).toHaveLength(0);
  });

  it('maps suspectedCauses with label from title, score from finalScore', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.suspectedCauses).toHaveLength(1);
    expect(input.suspectedCauses[0]).toMatchObject({
      label: 'Redis pool exhausted',
      score: 0.82,
      evidenceIds: ['ev-001', 'ev-002'],
    });
  });

  it('sets deterministicSummary from report.summary', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.deterministicSummary).toBe('Workers stalled after a concurrency bump.');
  });

  it('maps findings with title and evidenceIds', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    expect(input.findings).toHaveLength(1);
    expect(input.findings[0]).toMatchObject({
      title: 'Concurrency bump correlates with stalls',
      evidenceIds: ['ev-001', 'ev-002'],
    });
  });

  it('all narrative evidence IDs exist in the report evidence', () => {
    const input = buildNarrativeInput(MINIMAL_REPORT);
    const reportIds = new Set(MINIMAL_REPORT.evidence.map((e) => e.id));
    for (const ev of input.evidence) {
      expect(reportIds.has(ev.id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyAIFailure (HOR-199)
// ---------------------------------------------------------------------------

describe('classifyAIFailure', () => {
  it('returns generic message when no error is given', () => {
    expect(classifyAIFailure()).toBe('provider unavailable');
  });

  it('returns generic message for undefined', () => {
    expect(classifyAIFailure(undefined)).toBe('provider unavailable');
  });

  it('classifies 401 Unauthorized as missing API key', () => {
    const reason = classifyAIFailure('Anthropic API error: 401 Unauthorized');
    expect(reason).toContain('API key');
    expect(reason).toContain('ANTHROPIC_API_KEY');
  });

  it('classifies ECONNREFUSED as network error', () => {
    const reason = classifyAIFailure('ECONNREFUSED');
    expect(reason).toContain('network error');
  });

  it('passes through unclassified error messages verbatim', () => {
    const reason = classifyAIFailure('some unexpected provider message');
    expect(reason).toBe('some unexpected provider message');
  });
});

// ---------------------------------------------------------------------------
// Unknown environment exits non-zero (scripts must be able to detect the error)
// ---------------------------------------------------------------------------

describe('runInvestigate — unknown environment', () => {
  it('returns a non-zero code (1) when --env names an unconfigured environment', async () => {
    const config = writeSingleEnvConfig();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // `staging` is not configured (only `production` exists) — resolveEnvironment
    // throws before any connector/DB access, so this stays fully offline.
    const code = await runInvestigate('some hint', { config, env: 'staging' });

    expect(code).toBe(1);
    const stderr = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(stderr).toContain('Unknown environment: staging');
  });
});

describe('runInvestigate — output format validation (dogfood: --format xml fell back silently)', () => {
  it('rejects an unknown format with exit 1 before doing any work', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runInvestigate('some hint', { format: 'xml' });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Unknown format "xml"');
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// `investigate --json` compact size budget (dogfood: ~105 KB default output,
// recentChanges alone ~52 KB — unusable for agents).
// ---------------------------------------------------------------------------

import { compactInvestigateJSON } from './investigate.js';

describe('compactInvestigateJSON — size budget', () => {
  function fatReportJSON(): Record<string, unknown> {
    return {
      id: 'inv-1',
      input: { hint: 'runOneInvestigation timeout' },
      summary: 'x'.repeat(500),
      evidence: Array.from({ length: 40 }, (_, i) => ({
        id: `ev-${i}`,
        kind: 'symbol',
        title: `evidence ${i}`,
        payload: { raw: 'src'.repeat(2000) }, // fat raw-source payload
      })),
      recentChanges: {
        window: { since: '2026-06-01', until: undefined },
        commits: Array.from({ length: 200 }, (_, i) => ({
          sha: 'a'.repeat(40),
          shortSha: `aaaa${i}`,
          author: 'Dev',
          dateIso: '2026-07-01T10:00:00Z',
          subject: `feat: change ${i} touching lots of files in the service layer`,
          files: Array.from({ length: 30 }, (_, j) => `src/modules/mod-${j}/file-${i}.ts`),
        })),
        fileStats: Array.from({ length: 400 }, (_, i) => ({
          path: `src/modules/mod-${i % 30}/file-${i}.ts`,
          insertions: i,
          deletions: i % 7,
        })),
        changedFiles: Array.from({ length: 400 }, (_, i) => `src/modules/f-${i}.ts`),
        totalInsertions: 90000,
        totalDeletions: 2000,
        truncated: false,
        degenerate: false,
      },
      graph: {
        nodes: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, kind: 'symbol', label: `node ${i}` })),
        edges: Array.from({ length: 500 }, (_, i) => ({ from: `n${i % 300}`, to: `n${(i * 7) % 300}`, kind: 'calls' })),
      },
      gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
      confidence: 0.4,
      nextSteps: [{ nextTool: 'explain', args: 'x', reason: 'walk it' }],
    };
  }

  it('keeps the default JSON under the byte budget on a fat report', () => {
    const obj = fatReportJSON();
    expect(Buffer.byteLength(JSON.stringify(obj))).toBeGreaterThan(150 * 1024); // fat for real
    compactInvestigateJSON(obj);
    expect(Buffer.byteLength(JSON.stringify(obj, null, 2))).toBeLessThan(48 * 1024);
  });

  it('recentChanges compacts to counts + bounded tops with truncation metadata', () => {
    const obj = fatReportJSON();
    compactInvestigateJSON(obj);
    const rc = obj['recentChanges'] as Record<string, unknown>;
    expect(rc['commitCount']).toBe(200);
    expect(rc['changedFileCount']).toBe(400);
    expect((rc['commits'] as unknown[]).length).toBe(10);
    expect((rc['commits'] as Array<Record<string, unknown>>)[0]!['files']).toBeUndefined();
    expect((rc['commits'] as Array<Record<string, unknown>>)[0]!['fileCount']).toBe(30);
    expect((rc['topChangedFiles'] as unknown[]).length).toBe(15);
    expect(rc['truncated']).toBe(true);
    expect(rc['truncatedCount']).toBe(190);
    // The graph collapses to counts.
    const graph = obj['graph'] as Record<string, unknown>;
    expect(graph['nodeCount']).toBe(300);
    expect(graph['edgeCount']).toBe(500);
    // Evidence keeps citable metadata, drops payloads.
    const ev = (obj['evidence'] as Array<Record<string, unknown>>)[0]!;
    expect(ev['title']).toBe('evidence 0');
    expect(ev['payload']).toContain('omitted');
  });
});
