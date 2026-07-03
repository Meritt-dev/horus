/**
 * HOR-184 — Regression tests for changeImpact.
 * Pure unit tests — CodeProvider is stubbed, no I/O.
 */

import { describe, it, expect, vi } from 'vitest';
import type { CodeProvider } from '@horus/connectors';
import type { ChangeSet, Symbol, Flow } from '@horus/core';
import { changeImpact } from './changes.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSymbol(name: string, id?: string): Symbol {
  return {
    id: id ?? 'function:' + name,
    name,
    filePath: 'src/' + name + '.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
  };
}

function makeFlow(id: string, name: string): Flow {
  return { id, name, steps: [] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubCode(
  changeSet: ChangeSet,
  flowsMap: Record<string, Flow[]> = {},
): CodeProvider {
  return {
    health: vi.fn(),
    searchSymbols: vi.fn(),
    context: vi.fn(),
    impact: vi.fn(),
    flowsFor: vi.fn(async (symbolId: string) => flowsMap[symbolId] ?? []),
    detectChanges: vi.fn(async () => changeSet),
  } as unknown as CodeProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changeImpact', () => {
  it('returns affectedFlows when changed symbol belongs to a flow', async () => {
    const sym = makeSymbol('OrderProcessor');
    const flow = makeFlow('flow:checkout', 'Checkout flow');

    const code = stubCode(
      { added: [sym], modified: [], removed: [] },
      { 'function:OrderProcessor': [flow] },
    );

    const report = await changeImpact({ base: 'abc123^', compare: 'abc123' }, { code });

    expect(report.affectedFlows).toHaveLength(1);
    expect(report.affectedFlows[0]?.flowId).toBe('flow:checkout');
    expect(report.affectedFlows[0]?.changedSymbols).toContain('OrderProcessor');
  });

  it('returns 0 affectedFlows when no changed symbol is in a flow', async () => {
    const sym = makeSymbol('SomeUtility');

    const code = stubCode(
      { added: [sym], modified: [], removed: [] },
      {},
    );

    const report = await changeImpact({ base: 'abc^', compare: 'abc' }, { code });

    expect(report.affectedFlows).toHaveLength(0);
  });

  it('deduplicates flows when multiple changed symbols belong to the same flow', async () => {
    const sym1 = makeSymbol('OrderProcessor');
    const sym2 = makeSymbol('PaymentService');
    const flow = makeFlow('flow:checkout', 'Checkout flow');

    const code = stubCode(
      { added: [sym1, sym2], modified: [], removed: [] },
      {
        'function:OrderProcessor': [flow],
        'function:PaymentService': [flow],
      },
    );

    const report = await changeImpact({ base: 'a^', compare: 'b' }, { code });

    expect(report.affectedFlows).toHaveLength(1);
    const changedSymbols = report.affectedFlows[0]?.changedSymbols ?? [];
    expect(changedSymbols).toContain('OrderProcessor');
    expect(changedSymbols).toContain('PaymentService');
  });

  it('summary string ends with exactly one period', async () => {
    const code = stubCode({ added: [], modified: [], removed: [] });

    const report = await changeImpact({ base: 'a^', compare: 'b' }, { code });

    expect(report.summary.endsWith('.')).toBe(true);
    expect(report.summary.endsWith('..')).toBe(false);
  });

  it('skips file-label symbols when computing flow impact', async () => {
    const fileSym: Symbol = {
      id: 'file:src/index.ts',
      name: 'index',
      filePath: 'src/index.ts',
      startLine: 0,
      endLine: 0,
      language: 'typescript',
    };
    const flow = makeFlow('flow:main', 'Main flow');
    const code = stubCode(
      { added: [fileSym], modified: [], removed: [] },
      { 'file:src/index.ts': [flow] },
    );

    const report = await changeImpact({ base: 'a^', compare: 'b' }, { code });

    // file: symbols are capped out — flowsFor must never be called for them
    expect(report.affectedFlows).toHaveLength(0);
  });

  it('treats flowsFor errors as no flows (graceful degradation)', async () => {
    const sym = makeSymbol('BrokenService');

    const code: CodeProvider = {
      health: vi.fn(),
      searchSymbols: vi.fn(),
      context: vi.fn(),
      impact: vi.fn(),
      flowsFor: vi.fn(async () => { throw new Error('host unreachable'); }),
      detectChanges: vi.fn(async () => ({ added: [sym], modified: [], removed: [] })),
    } as unknown as CodeProvider;

    const report = await changeImpact({ base: 'a^', compare: 'b' }, { code });

    expect(report.affectedFlows).toHaveLength(0);
  });

  it('includes modified symbols (after) when computing flow impact', async () => {
    const before = makeSymbol('OrderProcessor', 'function:OrderProcessor');
    const after = makeSymbol('OrderProcessor', 'function:OrderProcessor');
    const flow = makeFlow('flow:checkout', 'Checkout flow');

    const code = stubCode(
      { added: [], modified: [{ before, after }], removed: [] },
      { 'function:OrderProcessor': [flow] },
    );

    const report = await changeImpact({ base: 'a^', compare: 'b' }, { code });

    expect(report.affectedFlows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Structural truth: identical refs, derived nodes, test-flow noise
// ---------------------------------------------------------------------------

describe('changeImpact — structural truth hardening', () => {
  it('short-circuits identical base/compare to an empty report (never calls the index)', async () => {
    const code = stubCode({ added: [makeSymbol('Fake')], modified: [], removed: [] });
    const report = await changeImpact({ base: 'HEAD', compare: 'HEAD' }, { code });
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.modified).toEqual([]);
    expect(report.affectedFlows).toEqual([]);
    expect(report.summary).toContain('same ref');
    expect(code.detectChanges).not.toHaveBeenCalled();
    // The implicit compare default (HEAD) short-circuits too.
    const report2 = await changeImpact({ base: 'HEAD' }, { code });
    expect(report2.summary).toContain('same ref');
  });

  it('filters derived/synthetic nodes (community:/process:/folder:/empty filePath) from the changeset', async () => {
    const real = makeSymbol('OrderProcessor');
    const community: Symbol = { id: 'community:12', name: 'cluster-12', filePath: '' };
    const process: Symbol = { id: 'process:emails', name: 'emails', filePath: 'src/x.ts' };
    const folder: Symbol = { id: 'folder:src/services', name: 'services', filePath: 'src/services' };
    const noFile: Symbol = { id: 'function:ghost', name: 'ghost', filePath: '' };

    const code = stubCode({
      added: [real, community, folder],
      modified: [{ before: process, after: process }, { before: real, after: real }],
      removed: [noFile],
    });
    const report = await changeImpact({ base: 'HEAD~3', compare: 'HEAD' }, { code });
    expect(report.added.map((s) => s.name)).toEqual(['OrderProcessor']);
    expect(report.modified.map((m) => m.after.name)).toEqual(['OrderProcessor']);
    expect(report.removed).toEqual([]);
    expect(report.summary).toContain('1 added, 1 modified, 0 removed');
  });

  it('drops test-derived flows for product changes, keeps them for test-scoped changes', async () => {
    const productSym = makeSymbol('OrderProcessor'); // src/OrderProcessor.ts
    const testSym: Symbol = {
      id: 'function:orderSpec',
      name: 'orderSpec',
      filePath: 'src/order.test.ts',
    };
    const productFlow: Flow = {
      id: 'flow:checkout',
      name: 'Checkout',
      steps: [makeSymbol('checkoutEntry')],
    };
    const testFlow: Flow = {
      id: 'flow:test-suite',
      name: 'order.test suite',
      steps: [{ id: 'function:t', name: 't', filePath: 'src/order.test.ts' }],
    };

    const code = stubCode(
      { added: [productSym, testSym], modified: [], removed: [] },
      {
        'function:OrderProcessor': [productFlow, testFlow],
        'function:orderSpec': [testFlow],
      },
    );
    const report = await changeImpact({ base: 'HEAD~1', compare: 'HEAD' }, { code });
    const byId = new Map(report.affectedFlows.map((f) => [f.flowId, f]));
    // The product change contributes only to the product flow…
    expect(byId.get('flow:checkout')?.changedSymbols).toEqual(['OrderProcessor']);
    // …the test flow survives only via the test-scoped changed symbol.
    expect(byId.get('flow:test-suite')?.changedSymbols).toEqual(['orderSpec']);
  });

  it('ranks affected flows by changed-symbol count, name as tie-break', async () => {
    const a = makeSymbol('Alpha');
    const b = makeSymbol('Beta');
    const big = makeFlow('flow:big', 'Big flow');
    const smallB = makeFlow('flow:small-b', 'B small');
    const smallA = makeFlow('flow:small-a', 'A small');

    const code = stubCode(
      { added: [a, b], modified: [], removed: [] },
      {
        'function:Alpha': [big, smallA],
        'function:Beta': [big, smallB],
      },
    );
    const report = await changeImpact({ base: 'HEAD~1', compare: 'HEAD' }, { code });
    expect(report.affectedFlows.map((f) => f.flowId)).toEqual([
      'flow:big',
      'flow:small-a',
      'flow:small-b',
    ]);
  });
});
