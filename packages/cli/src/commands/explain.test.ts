/**
 * HOR-181 — Regression tests for `horus explain` async-boundary detection.
 *
 * Covers:
 *  - query matching an async boundary with no exact symbol → redirect to horus queues
 *  - query matching an async boundary with fuzzy symbol only → redirect (not wrong symbol)
 *  - exact symbol name match → show symbol details (not redirect)
 *  - DB unavailable → fall through to normal fuzzy-match behaviour
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Symbol, HealthStatus } from '@horus/core';

const mocks = vi.hoisted(() => ({
  searchSymbols: vi.fn<() => Promise<Symbol[]>>(),
  codeHealth: vi.fn<() => Promise<HealthStatus>>(),
  context: vi.fn(),
  impact: vi.fn(),
  flowsFor: vi.fn(),
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
  codeForRepo: vi.fn(() => ({
    health: mocks.codeHealth,
    searchSymbols: mocks.searchSymbols,
    context: mocks.context,
    impact: mocks.impact,
    flowsFor: mocks.flowsFor,
  })),
}));

vi.mock('@horus/db', () => ({
  openDb: vi.fn(async () => ({ db: {}, sql: { end: mocks.sqlEnd } })),
  listQueueEdges: mocks.listQueueEdges,
}));

import { runExplain } from './explain.js';

const HEALTHY: HealthStatus = { ok: true, detail: '' };

const makeSymbol = (name: string, id?: string): Symbol => ({
  id: id ?? `function:${name}`,
  name,
  filePath: `src/${name}.ts`,
  startLine: 1,
  endLine: 10,
  language: 'typescript',
});

const CONTEXT = {
  symbol: makeSymbol('ZohoRealtimeProcessor'),
  community: null,
  isDead: false,
  callers: [],
  callees: [],
};

const IMPACT = {
  affected: 0,
  byDepth: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.codeHealth.mockResolvedValue(HEALTHY);
  mocks.context.mockResolvedValue(CONTEXT);
  mocks.impact.mockResolvedValue(IMPACT);
  mocks.flowsFor.mockResolvedValue([]);
  mocks.sqlEnd.mockResolvedValue(undefined);
});

describe('horus explain — async boundary redirect (HOR-181)', () => {
  it('redirects to horus queues when query matches a boundary and no symbols found', async () => {
    mocks.searchSymbols.mockResolvedValue([]);
    mocks.listQueueEdges.mockResolvedValue([{ queueName: 'zoho-sync-realtime', id: 1 }]);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])); });
    const code = await runExplain('zoho-sync-realtime', {});
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    const output = logged.join('\n');
    expect(output).toContain('horus queues zoho-sync-realtime');
    expect(output).not.toContain('ShopifyWebhook');
  });

  it('redirects to horus queues when query matches a boundary and only fuzzy symbol found', async () => {
    // searchSymbols returns an unrelated fuzzy result (different name)
    const unrelated = makeSymbol('ShopifyWebhookCatalogFieldsMongo');
    mocks.searchSymbols.mockResolvedValue([unrelated]);
    mocks.listQueueEdges.mockResolvedValue([{ queueName: 'zoho-sync-realtime', id: 1 }]);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])); });
    const code = await runExplain('zoho-sync-realtime', {});
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    const output = logged.join('\n');
    expect(output).toContain('horus queues zoho-sync-realtime');
    // Must NOT fall through to showing the wrong symbol
    expect(output).not.toContain('ShopifyWebhookCatalogFieldsMongo');
  });

  it('shows exact symbol details (no redirect) when name matches exactly', async () => {
    const sym = makeSymbol('ZohoRealtimeProcessor');
    mocks.searchSymbols.mockResolvedValue([sym]);
    // Even if a queue edge exists for the name, exact symbol wins
    mocks.listQueueEdges.mockResolvedValue([{ queueName: 'ZohoRealtimeProcessor', id: 1 }]);
    mocks.context.mockResolvedValue({ ...CONTEXT, symbol: sym });

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])); });
    const code = await runExplain('ZohoRealtimeProcessor', {});
    consoleSpy.mockRestore();

    expect(code).toBe(0);
    const output = logged.join('\n');
    expect(output).toContain('ZohoRealtimeProcessor');
    // Should not redirect
    expect(output).not.toContain('horus queues');
  });

  // HOR-386 — self-routing surfaces.
  it('routes a no-symbol miss to `horus search <query>` (no queue boundary)', async () => {
    mocks.searchSymbols.mockResolvedValue([]);
    mocks.listQueueEdges.mockResolvedValue([]); // not a queue boundary

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runExplain('NoSuchThing', {});
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    const output = logged.join('\n');
    expect(output).toContain('Suggested next:');
    expect(output).toContain('horus search NoSuchThing');
  });

  it('emits the search route in --json on a no-symbol miss (clean JSON)', async () => {
    mocks.searchSymbols.mockResolvedValue([]);
    mocks.listQueueEdges.mockResolvedValue([]);

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(String(a[0])); });
    const code = await runExplain('NoSuchThing', { json: true });
    consoleSpy.mockRestore();

    expect(code).toBe(1);
    // A single parseable JSON document with the structured nextSteps.
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
    const code = await runExplain('anything', {});
    logSpy.mockRestore();
    errSpy.mockRestore();

    expect(code).toBe(1);
    expect(logged.join('\n')).toContain('horus init');
  });

  it('falls through to fuzzy warning when DB is unavailable', async () => {
    const unrelated = makeSymbol('ShopifyWebhookCatalogFieldsMongo');
    mocks.searchSymbols.mockResolvedValue([unrelated]);
    // Simulate DB error — openDb itself throws (not listQueueEdges)
    const { openDb } = await import('@horus/db');
    vi.mocked(openDb).mockRejectedValueOnce(new Error('DB connection refused'));

    const logged: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(String(args[0])); });
    mocks.context.mockResolvedValue({ ...CONTEXT, symbol: unrelated });
    await runExplain('zoho-sync-realtime', {});
    consoleSpy.mockRestore();

    const output = logged.join('\n');
    // Falls through to fuzzy match warning
    expect(output).toContain('fuzzy match');
    expect(output).not.toContain('horus queues');
  });
});
