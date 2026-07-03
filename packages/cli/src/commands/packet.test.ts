/**
 * HOR-384 — Tests for `horus packet`.
 *
 * Fully offline: the engine packet projection (buildPacket/renderPacketMarkdown/packetToJSON)
 * runs for real against a fixture report; only the DB, investigation runner and db-url layers
 * are mocked. We pin input disambiguation (UUID → saved-id load, no re-run; otherwise hint →
 * run), `--for` validation, mandatory context teardown, and that `--json` stays clean (a single
 * parseable JSON document).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvestigationReport } from '@horus/engine';

const db = vi.hoisted(() => ({
  openDb: vi.fn(async () => ({ db: {}, sql: { end: vi.fn(async () => {}) } })),
  getInvestigation: vi.fn(),
}));
const runner = vi.hoisted(() => ({
  buildInvestigationContext: vi.fn(async () => ({})),
  runOneInvestigation: vi.fn(),
  disposeInvestigationContext: vi.fn(async () => {}),
}));
// Memory recall is the only async I/O the packet adds. Stub the store + recall so the test stays
// fully offline; buildPacket/packetToJSON/migrateReport remain the REAL engine projection.
const engineMocks = vi.hoisted(() => ({
  createLocalMemoryStore: vi.fn((..._args: unknown[]) => ({})),
  recallMemory: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}));

vi.mock('@horus/db', () => db);
vi.mock('@horus/engine', async (importActual) => {
  const actual = await importActual<typeof import('@horus/engine')>();
  return {
    ...actual,
    createLocalMemoryStore: engineMocks.createLocalMemoryStore,
    recallMemory: engineMocks.recallMemory,
  };
});
vi.mock('../lib/db-url.js', () => ({ resolveDbUrl: vi.fn(async () => 'postgres://x') }));
vi.mock('../lib/investigation-runner.js', () => runner);
// Pin repoRoot so freshness reads no real files / git — deterministic + offline.
vi.mock('../lib/cloud/session.js', () => ({ repoRootOrCwd: vi.fn(() => '/no-such-repo') }));

import { runPacket } from './packet.js';

const UUID = '11111111-1111-4111-8111-111111111111';

const dirs: string[] = [];
function writeSingleEnvConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-packet-'));
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

const FIXTURE: InvestigationReport = {
  id: UUID,
  input: { hint: 'checkout latency spike', service: 'checkout-api' },
  summary: 'Latency spike resolved to the checkout handler (payments area).',
  seeds: [
    {
      id: 'sym-1',
      name: 'handleCheckout',
      filePath: 'src/checkout.ts',
      startLine: 10,
      endLine: 40,
      score: 0.9,
    } as unknown as InvestigationReport['seeds'][number],
  ],
  evidence: [
    {
      id: 'ev-001',
      source: 'logs',
      kind: 'log',
      title: 'Timeout calling payments provider',
      relevance: 0.9,
      payload: {},
      links: { file: 'src/checkout.ts', line: 22 },
      provenance: { query: 'es:*', collectedAt: '2026-06-20T10:00:00.000Z' },
      priority: 'critical',
      timestamp: '2026-06-20T10:00:00.000Z',
    } as unknown as InvestigationReport['evidence'][number],
  ],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [],
  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Payments provider timeout',
      category: 'external-dependency',
      sourceEvidenceIds: ['ev-001'],
      affectedNodeIds: [],
      baseScore: 0.7,
      finalScore: 0.74,
      confidence: 0.74,
      band: 'likely',
      explanations: [],
    } as unknown as InvestigationReport['suspectedCauses'][number],
  ],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1.0 },
  graph: { nodes: [], edges: [] },
  sourceStatus: {
    sources: [
      { source: 'logs', status: 'contributed' },
      { source: 'metrics', status: 'empty' },
    ],
  } as unknown as InvestigationReport['sourceStatus'],
  confidence: 0.74,
  nextActions: ['Check payments provider status page', 'Inspect checkout handler retries'],
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function stdout(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('runPacket — --for validation', () => {
  it('rejects an unknown preset and never touches the DB or runner', async () => {
    const code = await runPacket('some hint', { for: 'bogus' });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(runner.runOneInvestigation).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Unknown --for preset');
  });
});

describe('runPacket — saved-id path', () => {
  it('returns 1 when the saved investigation is not found (no re-run)', async () => {
    db.getInvestigation.mockResolvedValueOnce(null);
    const code = await runPacket(UUID, {});
    expect(code).toBe(1);
    expect(db.getInvestigation).toHaveBeenCalledWith(expect.anything(), UUID);
    expect(runner.runOneInvestigation).not.toHaveBeenCalled();
  });

  it('returns 1 when the saved row has no stored report', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: null });
    const code = await runPacket(UUID, {});
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('no stored report');
  });

  it('projects a saved report to clean JSON under --json (single parseable document)', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: FIXTURE });
    const code = await runPacket(UUID, { json: true });
    expect(code).toBe(0);
    // Never re-queries source intelligence for a saved id.
    expect(runner.runOneInvestigation).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdout());
    expect(parsed.meta.investigationId).toBe(UUID);
    expect(parsed.problem.hint).toBe('checkout latency spike');
    expect(parsed.honesty.band).toBe('likely');
    // sourceStatus honesty is preserved (empty vs contributed distinction).
    expect(parsed.honesty.sources).toEqual([
      { source: 'logs', status: 'contributed' },
      { source: 'metrics', status: 'empty' },
    ]);
    // Clean arrays for machine consumers + sibling truncation counts.
    expect(Array.isArray(parsed.evidence.items)).toBe(true);
    expect(parsed.evidence).toHaveProperty('truncatedCount');
  });

  it('carries top-level repo identity {name, branch, commit} (dogfood A1)', async () => {
    db.getInvestigation.mockResolvedValueOnce({
      id: UUID,
      report: { ...FIXTURE, input: { ...FIXTURE.input, repo: 'my-api' } },
    });
    const code = await runPacket(UUID, { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    // repo is a top-level sibling of honesty/problem (NOT buried in meta). name comes from the
    // resolved project; branch/commit are git truth (null here — repoRootOrCwd is a fake path).
    expect(parsed.repo).toEqual({ name: 'my-api', branch: null, commit: null });
  });

  it('renders Markdown by default', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: FIXTURE });
    const code = await runPacket(UUID, {});
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('# Agent Packet — checkout latency spike');
    expect(out).toContain('## Suggested next steps');
  });
});

describe('runPacket — hint path', () => {
  it('runs a fresh investigation, projects it, and always tears the context down', async () => {
    const config = writeSingleEnvConfig();
    runner.runOneInvestigation.mockResolvedValueOnce(FIXTURE);
    const code = await runPacket('checkout latency spike', { config, json: true });
    expect(code).toBe(0);
    expect(runner.buildInvestigationContext).toHaveBeenCalledTimes(1);
    expect(runner.runOneInvestigation).toHaveBeenCalledTimes(1);
    expect(runner.disposeInvestigationContext).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdout());
    expect(parsed.problem.hint).toBe('checkout latency spike');
  });

  it('tears the context down even when the investigation throws', async () => {
    const config = writeSingleEnvConfig();
    runner.runOneInvestigation.mockRejectedValueOnce(new Error('connector exploded'));
    const code = await runPacket('checkout latency spike', { config });
    expect(code).toBe(1);
    expect(runner.disposeInvestigationContext).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('connector exploded');
  });

  it('threads --scope/--service/--since into the runner input', async () => {
    const config = writeSingleEnvConfig();
    runner.runOneInvestigation.mockResolvedValueOnce(FIXTURE);
    await runPacket('checkout latency spike', {
      config,
      json: true,
      scope: 'packages/checkout',
      service: 'checkout-api',
      since: 'HEAD~5',
    });
    expect(runner.runOneInvestigation).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: 'checkout latency spike',
        scope: 'packages/checkout',
        service: 'checkout-api',
        since: 'HEAD~5',
      }),
      expect.anything(),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});

describe('runPacket — remembered context (memory)', () => {
  // A recalled item shaped as the engine's RecalledMemory (what recallMemory returns).
  function recalled(over: { id?: string; claim?: string } = {}) {
    return {
      item: {
        id: over.id ?? 'mem_1',
        kind: 'pitfall',
        claim: over.claim ?? 'payments retries are not idempotent',
        scope: 'repo',
        confidence: 0.9,
        status: 'fresh',
      },
      relevance: 0,
      freshness: { status: 'fresh', label: 'recent', ageDays: 12, verified: true, decay: 0.8, driftDetected: false },
      rank: 0.7,
    };
  }

  it('recalls memory scoped to the report project and surfaces it in --json (clean memory field)', async () => {
    const reportWithRepo = { ...FIXTURE, input: { ...FIXTURE.input, repo: 'my-api' } };
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: reportWithRepo });
    engineMocks.recallMemory.mockResolvedValueOnce([recalled({ claim: 'queue is at-least-once' })]);

    const code = await runPacket(UUID, { json: true });
    expect(code).toBe(0);
    // Recall was scoped by repo (HOR-46) + a relevance text built from the hint/seed/cause.
    expect(engineMocks.recallMemory).toHaveBeenCalledTimes(1);
    const query = engineMocks.recallMemory.mock.calls[0]?.[1] as { repo: string; text: string };
    expect(query.repo).toBe('my-api');
    expect(query.text).toContain('checkout latency spike');

    const parsed = JSON.parse(stdout());
    expect(parsed.memory.items).toHaveLength(1);
    expect(parsed.memory.items[0].claim).toBe('queue is at-least-once');
    expect(parsed.memory).toHaveProperty('truncatedCount');
  });

  it('renders the remembered-context section in Markdown, clearly marked as not live evidence', async () => {
    const reportWithRepo = { ...FIXTURE, input: { ...FIXTURE.input, repo: 'my-api' } };
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: reportWithRepo });
    engineMocks.recallMemory.mockResolvedValueOnce([recalled({ claim: 'consumers must dedupe' })]);

    const code = await runPacket(UUID, {});
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('## Remembered context (not live evidence)');
    expect(out).toContain('- consumers must dedupe');
  });

  it('does not recall (and emits no memory) when the report has no project — fail-closed', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: FIXTURE }); // FIXTURE has no input.repo
    const code = await runPacket(UUID, { json: true });
    expect(code).toBe(0);
    expect(engineMocks.recallMemory).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdout());
    expect(parsed.memory.items).toEqual([]);
  });

  it('is best-effort: a recall failure never breaks the packet', async () => {
    const reportWithRepo = { ...FIXTURE, input: { ...FIXTURE.input, repo: 'my-api' } };
    db.getInvestigation.mockResolvedValueOnce({ id: UUID, report: reportWithRepo });
    engineMocks.recallMemory.mockRejectedValueOnce(new Error('store down'));

    const code = await runPacket(UUID, { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.memory.items).toEqual([]);
    expect(parsed.problem.hint).toBe('checkout latency spike');
  });
});
