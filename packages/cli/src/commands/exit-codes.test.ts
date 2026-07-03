/**
 * HOR-129 — CLI exit code contract tests.
 *
 * Documents and guards the exit code behaviour of key Horus commands:
 *
 *   0 — success
 *   1 — known failure (not found, already exists, config error, write error)
 *
 * Tests are offline — no live Postgres, no API calls, no source-intelligence host.
 *
 * Pattern: heavy infrastructure (loadConfig, openDb, getInvestigation) is
 * mocked at the module level. File-system calls in `runInit` are real, using
 * temp directories that are cleaned up in afterEach.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    // Override only what crosses a network or writes global state:
    loadConfig: vi.fn().mockResolvedValue({
      database: { url: 'postgresql://horus:horus@localhost:5432/horus' },
      projects: [],
    }),
    // Prevent real writes to ~/.horus/registry.json in CI / local runs
    registerProject: vi.fn(),
  };
});

vi.mock('@horus/db', () => ({
  openDb: vi.fn().mockResolvedValue({
    db: {},
    sql: { end: vi.fn().mockResolvedValue(undefined) },
  }),
  getInvestigation: vi.fn(),
  assertLocalDatabaseUrl: () => {},
  // init's advisory prereq check — offline: unreachable, never gates exit codes.
  checkDatabase: vi
    .fn()
    .mockResolvedValue({ reachable: false, schemaReady: false, schemaDetail: '' }),
}));

// init's backend probe — offline: absent, so init stays on the write-only path.
vi.mock('@horus/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/connectors')>();
  return {
    ...actual,
    sourceAvailable: vi.fn().mockResolvedValue(false),
    getSourceVersion: vi.fn().mockResolvedValue(null),
  };
});

import { runInit } from './init.js';
import { runReplay } from './replay.js';
import { runPostmortem } from './postmortem.js';
import { getInvestigation } from '@horus/db';
import type { InvestigationReport } from '@horus/engine';

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-exit-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const d of tmpDirs) {
    try {
      // Ensure writable before removal (in case a test made it read-only)
      chmodSync(d, 0o755);
    } catch {
      // ignore
    }
    rmSync(d, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// Minimal valid InvestigationReport for postmortem success injection
const FIXTURE_REPORT: InvestigationReport = {
  id: 'inv-exit-test',
  input: { hint: 'smoke' },
  summary: 'smoke test summary',
  seeds: [],
  evidence: [],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { chains: [], groups: [], missing: [] },
  findings: [],
  suspectedCauses: [],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
  graph: { nodes: [], edges: [] },
  confidence: 0.5,
  nextActions: [],
};

// ── horus init ────────────────────────────────────────────────────────────────

describe('runInit exit codes', () => {
  it('exits 0 when config is written successfully', async () => {
    const dir = makeTempDir();
    const code = await runInit({ name: 'exit-test-ok', path: dir });
    expect(code).toBe(0);
  });

  it('exits 1 when the target directory is not writable', async () => {
    const dir = makeTempDir();
    // Make the directory read-only so writeLocalConfig fails with EACCES
    chmodSync(dir, 0o555);
    const code = await runInit({ name: 'exit-test-fail', path: dir });
    expect(code).toBe(1);
  });

  it('exits 0 regardless of missing source-intelligence host (optional — not a failure)', async () => {
    const dir = makeTempDir();
    const code = await runInit({ name: 'exit-test-no-source', path: dir });
    expect(code).toBe(0);
  });

  it('exits 0 with an explicit env name', async () => {
    const dir = makeTempDir();
    const code = await runInit({ name: 'exit-test-env', env: 'staging', path: dir });
    expect(code).toBe(0);
  });

  it('exits 0 with an explicit source host URL', async () => {
    const dir = makeTempDir();
    const code = await runInit({
      name: 'exit-test-source',
      path: dir,
      source: 'http://127.0.0.1:8420',
    });
    expect(code).toBe(0);
  });
});

// ── horus replay ──────────────────────────────────────────────────────────────

describe('runReplay exit codes', () => {
  it('exits 1 when the investigation is not found', async () => {
    vi.mocked(getInvestigation).mockResolvedValueOnce(null);
    const code = await runReplay('nonexistent-id', {});
    expect(code).toBe(1);
  });

  it('exits 1 when the investigation row has no stored report', async () => {
    vi.mocked(getInvestigation).mockResolvedValueOnce({
      id: 'no-report-id',
      status: 'completed',
      title: '',
      updatedAt: new Date(),
      createdAt: new Date(),
      summary: null,
      incidentInput: null,
      narrative: null,
      report: null,
    });
    const code = await runReplay('no-report-id', {});
    expect(code).toBe(1);
  });

  it('exits 1 for any unknown investigation id', async () => {
    vi.mocked(getInvestigation).mockResolvedValueOnce(null);
    const lines: string[] = [];
    const origError = console.error;
    console.error = (msg: string) => lines.push(msg);
    const code = await runReplay('00000000-0000-0000-0000-000000000000', {});
    console.error = origError;
    expect(code).toBe(1);
    expect(lines.join(' ')).toContain('No investigation found');
  });
});

// ── horus postmortem ──────────────────────────────────────────────────────────

describe('runPostmortem exit codes', () => {
  it('exits 1 when the investigation is not found', async () => {
    vi.mocked(getInvestigation).mockResolvedValueOnce(null);
    const lines: string[] = [];
    const code = await runPostmortem('nonexistent-id', {
      write: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join(' ')).toContain('No investigation found');
  });

  it('exits 1 when the investigation has no stored report', async () => {
    vi.mocked(getInvestigation).mockResolvedValueOnce({
      id: 'no-report-pm',
      status: 'completed',
      title: '',
      updatedAt: new Date(),
      createdAt: new Date(),
      summary: null,
      incidentInput: null,
      narrative: null,
      report: null,
    });
    const lines: string[] = [];
    const code = await runPostmortem('no-report-pm', {
      write: (l) => lines.push(l),
    });
    expect(code).toBe(1);
  });

  it('exits 0 when a report is injected directly (_report bypass)', async () => {
    const lines: string[] = [];
    const code = await runPostmortem('irrelevant-id', {
      _report: FIXTURE_REPORT,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('## Summary');
  });

  it('exits 1 when output file exists and --force is not set', async () => {
    const dir = makeTempDir();
    const outputPath = join(dir, 'postmortem.md');
    // Create the file so it already exists
    mkdirSync(dir, { recursive: true });
    const fs = await import('node:fs');
    fs.writeFileSync(outputPath, 'existing content');
    const lines: string[] = [];
    const code = await runPostmortem('irrelevant-id', {
      _report: FIXTURE_REPORT,
      output: outputPath,
      force: false,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines.join(' ')).toContain('already exists');
  });

  it('exits 0 when output file exists and --force is set', async () => {
    const dir = makeTempDir();
    const outputPath = join(dir, 'postmortem.md');
    const fs = await import('node:fs');
    fs.writeFileSync(outputPath, 'existing content');
    const lines: string[] = [];
    const code = await runPostmortem('irrelevant-id', {
      _report: FIXTURE_REPORT,
      output: outputPath,
      force: true,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join(' ')).toContain('Saved');
  });
});
