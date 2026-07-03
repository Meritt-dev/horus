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
