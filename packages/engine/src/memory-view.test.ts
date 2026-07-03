/**
 * HOR — Unit tests for buildMemoryView + renderMemoryView over injected fakes.
 * No real DB, no real source-intelligence host, no git.
 */

import { describe, it, expect } from 'vitest';
import type { CodeProvider } from '@horus/connectors';
import {
  incidentMemory,
  investigations,
  queueEdges,
  type HorusDb,
} from '@horus/db';
import { buildMemoryView } from './memory-view.js';
import { renderMemoryView, memoryViewToJSON } from './render-memory.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeData {
  queueEdges?: unknown[];
  incidentMemory?: unknown[];
  investigations?: unknown[];
}

/** A thenable drizzle-query stub that resolves based on the table passed to from(). */
function makeDb(data: FakeData): HorusDb {
  const resolveFor = (table: unknown): unknown[] => {
    if (table === queueEdges) return data.queueEdges ?? [];
    if (table === incidentMemory) return data.incidentMemory ?? [];
    if (table === investigations) return data.investigations ?? [];
    return [];
  };
  function makeChain() {
    let table: unknown;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(onF: (rows: unknown[]) => unknown, onR?: (e: unknown) => unknown) {
        return Promise.resolve(resolveFor(table)).then(onF, onR);
      },
    };
    return chain;
  }
  return {
    select() {
      return makeChain();
    },
  } as unknown as HorusDb;
}

/** Drives discoverArchitecture through its typed read-path methods (the Cypher seam is dead). */
function makeCode(opts: {
  subsystems?: [string, number][];
  keyFlows?: string[];
  deadCode?: number;
  highCoupling?: number;
  externalFiles?: Record<string, number>;
  symbols?: { id: string; name: string; filePath: string }[];
  hostDown?: boolean;
}): CodeProvider {
  return {
    async health() {
      return { ok: opts.hostDown !== true };
    },
    async overview() {
      return { nodesByLabel: { file: 10 } };
    },
    async communities() {
      return (opts.subsystems ?? []).map(([name, memberCount]) => ({ name, memberCount }));
    },
    async processes() {
      return (opts.keyFlows ?? []).map((name) => ({ name }));
    },
    async deadCode() {
      return { total: opts.deadCode ?? 0, byFile: {} };
    },
    async coupling() {
      return Array.from({ length: opts.highCoupling ?? 0 }, (_, i) => ({
        fileA: `a${i}.ts`,
        fileB: `b${i}.ts`,
        strength: 1,
        coChanges: 3,
      }));
    },
    async filesContaining(tokens: string[]) {
      return Object.fromEntries(
        tokens.map((t) => [
          t,
          Array.from({ length: opts.externalFiles?.[t] ?? 0 }, (_, i) => `src/${t}/f${i}.ts`),
        ]),
      );
    },
    async searchSymbols() {
      return opts.symbols ?? [];
    },
  } as unknown as CodeProvider;
}

function memRow(over: Record<string, unknown>) {
  return {
    id: globalThis.crypto.randomUUID(),
    investigationId: null,
    project: 'proj',
    title: 'untitled',
    summary: null,
    signature: null,
    tags: [],
    payload: null,
    createdAt: new Date('2024-04-01T00:00:00.000Z'),
    ...over,
  };
}

const DEPS_BASE = { repoPath: '/tmp/repo', project: 'proj' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildMemoryView — primary recall path', () => {
  function setup() {
    const code = makeCode({
      subsystems: [
        ['payments-core', 12],
        ['billing-core', 18],
      ],
      keyFlows: ['payments-checkout-flow', 'billing-renewal-flow'],
      deadCode: 3,
      highCoupling: 5,
      symbols: [], // keep ownership/git out of the test
    });
    const report = {
      summary: 'Payments queue backed up.',
      confidence: 0.9,
      evidence: [
        { id: 'e1', source: 'logs' },
        { id: 'e2', source: 'code' },
      ],
      suspectedCauses: [
        { title: 'Queue backlog', category: 'queue-backlog', band: 'highly-likely' },
      ],
      hypotheses: [{ verdict: 'supported' }],
    };
    const db = makeDb({
      queueEdges: [
        {
          queueName: 'payments',
          producerSymbol: 'PayService',
          producerFile: 'src/pay.ts',
          workerSymbol: 'PayWorker',
          workerFile: 'src/payw.ts',
        },
      ],
      incidentMemory: [
        memRow({
          investigationId: 'inv-1',
          title: 'Payments stalled',
          summary: 'first',
          signature: 'src/modules/payments|queue-backlog|payments',
          tags: ['payments', 'src/modules/payments'],
          payload: { queues: ['payments'], confidence: 0.9, topHypothesis: 'queue-backlog' },
        }),
        memRow({
          investigationId: 'inv-2',
          title: 'Payments stalled again',
          summary: 'second',
          signature: 'src/modules/payments|queue-backlog|payments',
          tags: ['payments', 'src/modules/payments'],
          payload: { queues: ['payments'], confidence: 0.9, topHypothesis: 'queue-backlog' },
        }),
      ],
      investigations: [
        {
          id: 'inv-1',
          title: 'Payments stalled',
          createdAt: new Date('2024-04-01T00:00:00.000Z'),
          report,
        },
      ],
    });
    return { code, db };
  }

  it('narrows owned subsystems to the scope and carries the testy flag', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.ownedAreas.subsystems.map((s) => s.name)).toEqual(['payments-core']);
    expect(view.ownedAreas.subsystems[0]!.testy).toBe(false);
  });

  it('scopes runtime paths and surfaces queues seen in past incidents', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.runtimePaths.asyncBoundaries.map((b) => b.queueName)).toEqual(['payments']);
    expect(view.runtimePaths.keyFlows).toEqual(['payments-checkout-flow']);
    expect(view.runtimePaths.queuesSeenInIncidents).toEqual(['payments']);
  });

  it('hydrates past investigations with cause, confidence and confirmed proxy', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.pastInvestigations.length).toBeGreaterThan(0);
    const p = view.pastInvestigations[0]!;
    expect(p.suspectedCause).toEqual({
      title: 'Queue backlog',
      category: 'queue-backlog',
      band: 'highly-likely',
    });
    expect(p.confidence).toBe(0.9);
    expect(p.confirmedProxy).toBe(true);
    expect(p.sources).toEqual(['code', 'logs']);
    expect(p.date).toBe('2024-04-01T00:00:00.000Z');
  });

  it('aggregates recurring patterns by signature', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.recurringPatterns).toEqual([
      { signature: 'src/modules/payments|queue-backlog|payments', count: 2 },
    ]);
  });

  it('aggregates distinct evidence channels and always-available planes', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.evidenceSources.channels).toEqual(['code', 'logs']);
    expect(view.evidenceSources.alwaysAvailable.length).toBe(2);
  });

  it('reports repo-wide fragility and NOT-low prior evidence when a cause is confirmed', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.weakSpots.fragile).toEqual({
      deadCode: 3,
      highCouplingPairs: 5,
      scope: 'repo-wide',
    });
    expect(view.weakSpots.lowPriorEvidence).toBe(false);
  });

  it('renders all section headers and the proxy disclaimer', async () => {
    const { code, db } = setup();
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    const md = renderMemoryView(view);
    expect(md).toContain('# Memory: payments');
    expect(md).toContain('## Owned areas');
    expect(md).toContain('## Runtime paths & queues');
    expect(md).toContain('## External systems');
    expect(md).toContain('## Past investigations');
    expect(md).toContain('## Useful evidence sources');
    expect(md).toContain('## Weak spots');
    expect(md).toContain('display proxy');
    expect(JSON.parse(memoryViewToJSON(view)).project).toBe('proj');
  });
});

describe('buildMemoryView — broader-recall fallback + low prior evidence', () => {
  it('falls back to title-matched investigations when recall is empty', async () => {
    const code = makeCode({ subsystems: [['payments-core', 4]], symbols: [] });
    const db = makeDb({
      queueEdges: [],
      incidentMemory: [], // no scoped memory -> recallSimilar returns []
      investigations: [
        {
          id: 'inv-9',
          title: 'payments incident postmortem',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          report: { summary: 'old one', confidence: 0.3, evidence: [], hypotheses: [] },
        },
      ],
    });
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.pastInvestigations.map((p) => p.title)).toContain('payments incident postmortem');
    // A prior investigation IS shown (via fallback) but was never confirmed → low prior evidence,
    // and the reason must reflect that, not the contradictory "no prior investigations".
    expect(view.weakSpots.lowPriorEvidence).toBe(true);
    expect(view.weakSpots.lowPriorEvidenceReason).toContain('never with a confirmed cause');
  });

  it('isolates by project — never returns another project memory', async () => {
    const code = makeCode({ symbols: [] });
    const db = makeDb({
      incidentMemory: [
        memRow({
          project: 'other',
          title: 'Other project incident',
          signature: 'a|b|c',
          tags: ['payments', 'src/modules/payments'],
          investigationId: 'x',
        }),
      ],
      investigations: [],
    });
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.pastInvestigations).toHaveLength(0);
    expect(view.recurringPatterns).toHaveLength(0);
  });
});

describe('buildMemoryView — honesty: source-host reachability + accurate low-prior reason', () => {
  it('flags sourceAvailable=false and the render says WHY when the host is unreachable', async () => {
    const code = makeCode({ hostDown: true, subsystems: [['payments-core', 4]], symbols: [] });
    const db = makeDb({ incidentMemory: [], investigations: [] });
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.sourceAvailable).toBe(false);
    const md = renderMemoryView(view);
    expect(md).toContain('host unreachable');
    expect(md).toContain('incident memory only');
  });

  it('uses the "no prior investigations" reason ONLY when nothing is displayed', async () => {
    const code = makeCode({ symbols: [] });
    const db = makeDb({ incidentMemory: [], investigations: [] }); // truly empty
    const view = await buildMemoryView('payments', { ...DEPS_BASE, code, db });
    expect(view.pastInvestigations).toHaveLength(0);
    expect(view.sourceAvailable).toBe(true);
    expect(view.weakSpots.lowPriorEvidence).toBe(true);
    expect(view.weakSpots.lowPriorEvidenceReason).toContain('No prior investigations');
  });
});
