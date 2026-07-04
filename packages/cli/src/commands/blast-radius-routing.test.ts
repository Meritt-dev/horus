/**
 * HOR-386 — `horus blast-radius` self-routing surfaces.
 *
 * The shared router (engine `route()`) runs for real; only the connector/DB layer is mocked.
 * Covers: host-down → `horus init`, no-symbol miss → `horus search <query>`, and the same
 * routes carried structurally on `--json`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Symbol, HealthStatus } from '@horus/core';

const mocks = vi.hoisted(() => ({
  searchSymbols: vi.fn<() => Promise<Symbol[]>>(),
  codeHealth: vi.fn<() => Promise<HealthStatus>>(),
  context: vi.fn(),
  impact: vi.fn(),
  listQueueEdges: vi.fn(),
  sqlEnd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({
      database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
      projects: [],
      models: { reasoning: 'claude-opus-4-8', extraction: 'claude-haiku-4-5' },
    }),
  };
});

vi.mock('@horus/connectors', () => ({
  createConnectors: vi.fn(() => ({
    code: {
      health: mocks.codeHealth,
      searchSymbols: mocks.searchSymbols,
      context: mocks.context,
      impact: mocks.impact,
    },
  })),
}));

vi.mock('@horus/db', () => ({
  openDb: vi.fn(async () => ({ db: {}, sql: { end: mocks.sqlEnd } })),
  listQueueEdges: mocks.listQueueEdges,
  // The engine (running for real here) uses this to degrade instead of crash.
  isDbUnavailable: (err: unknown) => err instanceof Error && err.message.startsWith('HORUS_DB_UNAVAILABLE'),
}));

import { runBlastRadius } from './blast-radius.js';

const HEALTHY: HealthStatus = { ok: true, detail: '' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codeHealth.mockResolvedValue(HEALTHY);
  mocks.listQueueEdges.mockResolvedValue([]);
  mocks.sqlEnd.mockResolvedValue(undefined);
});

describe('horus blast-radius — self-routing (HOR-386)', () => {
  it('routes a no-symbol miss to `horus search <query>`', async () => {
    mocks.searchSymbols.mockResolvedValue([]); // → analyzeBlastRadius returns null

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runBlastRadius('NoSuchThing', {});
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    const output = logged.join('\n');
    expect(output).toContain('Suggested next:');
    expect(output).toContain('horus search NoSuchThing');
  });

  it('emits the search route structurally on --json (no symbol)', async () => {
    mocks.searchSymbols.mockResolvedValue([]);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runBlastRadius('NoSuchThing', { json: true });
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    const parsed = JSON.parse(logged.join('\n')) as { symbol: null; nextSteps: { nextTool: string; args: string }[] };
    expect(parsed.symbol).toBeNull();
    expect(parsed.nextSteps).toEqual([
      { nextTool: 'search', args: 'NoSuchThing', reason: expect.any(String) },
    ]);
  });

  it('completes (display-only) when the local db is unavailable — single-file build', async () => {
    // A build without pglite's assets throws HORUS_DB_UNAVAILABLE on any db access. The
    // command must still print the blast radius and a dim note, not crash.
    const seed: Symbol = { id: 'sym:Payments', name: 'Payments', filePath: 'src/pay.ts', startLine: 1, endLine: 9 };
    mocks.searchSymbols.mockResolvedValue([seed]);
    mocks.context.mockResolvedValue({ symbol: seed, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] });
    mocks.impact.mockResolvedValue({ target: seed, affected: 0, byDepth: [] });
    mocks.listQueueEdges.mockRejectedValue(
      new Error('HORUS_DB_UNAVAILABLE: embedded database asset missing (pglite.wasm).'),
    );

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runBlastRadius('Payments', {});
    consoleSpy.mockRestore();

    expect(code).toBe(0); // completes rather than crashing
    expect(logged.join('\n')).toContain('local persistence unavailable in this build');
  });

  it('carries the db-unavailable note structurally on --json', async () => {
    const seed: Symbol = { id: 'sym:Payments', name: 'Payments', filePath: 'src/pay.ts', startLine: 1, endLine: 9 };
    mocks.searchSymbols.mockResolvedValue([seed]);
    mocks.context.mockResolvedValue({ symbol: seed, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] });
    mocks.impact.mockResolvedValue({ target: seed, affected: 0, byDepth: [] });
    mocks.listQueueEdges.mockRejectedValue(
      new Error('HORUS_DB_UNAVAILABLE: embedded database asset missing (pglite.wasm).'),
    );

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runBlastRadius('Payments', { json: true });
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    const parsed = JSON.parse(logged.join('\n')) as { dbUnavailableNote?: string };
    expect(parsed.dbUnavailableNote).toContain('local persistence unavailable in this build');
  });

  it('routes a host-down failure to `horus init`', async () => {
    mocks.codeHealth.mockResolvedValue({ ok: false, detail: 'down' });

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runBlastRadius('anything', {});
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(code).toBe(1);
    expect(logged.join('\n')).toContain('horus init');
  });
});
