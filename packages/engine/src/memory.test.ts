/**
 * HOR-18 — Unit tests for memory helpers (pure, no I/O, no DB).
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InvestigationReport } from './types.js';
import { createLocalDb, incidentMemory, type HorusDb } from '@horus/db';
import {
  moduleArea,
  tagOverlap,
  deriveTags,
  deriveSignature,
  recallSimilar,
  storeIncidentMemory,
} from './memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal synthetic InvestigationReport for testing. */
function makeReport(overrides?: Partial<InvestigationReport>): InvestigationReport {
  const base: InvestigationReport = {
    id: 'test-id',
    input: { hint: 'test hint' },
    summary: 'Test summary',
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
    confidence: 0.5,
    nextActions: [],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// moduleArea
// ---------------------------------------------------------------------------

describe('moduleArea', () => {
  it('returns the first 3 path segments for a deep path', () => {
    expect(moduleArea('src/modules/zoho/zoho.service.ts')).toBe('src/modules/zoho');
  });

  it('returns the whole path when there are 3 or fewer segments', () => {
    expect(moduleArea('a.ts')).toBe('a.ts');
    expect(moduleArea('src/foo.ts')).toBe('src/foo.ts');
    expect(moduleArea('a/b/c')).toBe('a/b/c');
  });

  it('handles a path with exactly 4 segments', () => {
    expect(moduleArea('a/b/c/d.ts')).toBe('a/b/c');
  });

  it('returns empty string for empty input', () => {
    expect(moduleArea('')).toBe('');
  });

  it('handles a leading slash by stripping it', () => {
    expect(moduleArea('/src/modules/zoho/zoho.service.ts')).toBe('src/modules/zoho');
  });
});

// ---------------------------------------------------------------------------
// tagOverlap
// ---------------------------------------------------------------------------

describe('tagOverlap', () => {
  it('returns 1/3 for ["a","b"] vs ["b","c"]', () => {
    // intersection={b}, union={a,b,c}, Jaccard = 1/3
    expect(tagOverlap(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('returns 0 for disjoint sets', () => {
    expect(tagOverlap(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(tagOverlap(['x', 'y'], ['x', 'y'])).toBe(1);
  });

  it('returns 0 when both arrays are empty', () => {
    expect(tagOverlap([], [])).toBe(0);
  });

  it('returns 0 when one array is empty', () => {
    expect(tagOverlap(['a'], [])).toBe(0);
    expect(tagOverlap([], ['b'])).toBe(0);
  });

  it('handles duplicates within one side gracefully (set semantics)', () => {
    // Sets deduplicate: {a,b} vs {b,c} -> same as base case
    expect(tagOverlap(['a', 'b', 'a'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// deriveTags
// ---------------------------------------------------------------------------

describe('deriveTags', () => {
  it('includes queue names from boundaryCrossings', () => {
    const r = makeReport({
      timeline: {
        events: [],
        boundaryCrossings: [
          {
            queueName: 'orders',
            producer: 'OrderService',
            worker: 'OrderProcessor',
            evidenceId: 'ev1',
          },
        ],
      },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('orders');
  });

  it('includes top hypothesis category', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp1',
          category: 'queue-backlog',
          statement: 'Some statement',
          confidence: 0.8,
          priorConfidence: 0.8,
          verdict: 'supported',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
    });
    const tags = deriveTags(r);
    expect(tags).toContain('queue-backlog');
  });

  it('includes module area from first seed filePath', () => {
    const r = makeReport({
      seeds: [
        {
          id: 'sym1',
          name: 'ZohoService',
          filePath: 'src/modules/zoho/zoho.service.ts',
          startLine: 1,
        },
      ],
    });
    const tags = deriveTags(r);
    expect(tags).toContain('src/modules/zoho');
  });

  it('includes service from input', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'zoho-service' },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('zoho-service');
  });

  it('deduplicates and lowercases tags', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'Orders' },
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'Orders', producer: null, worker: null, evidenceId: 'ev1' },
        ],
      },
    });
    const tags = deriveTags(r);
    const ordersCount = tags.filter((t) => t === 'orders').length;
    expect(ordersCount).toBe(1);
    expect(tags.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it('combines queue, hypothesis category, module area, and service', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'payment-svc' },
      seeds: [
        {
          id: 'sym1',
          name: 'PayService',
          filePath: 'src/modules/payment/pay.service.ts',
          startLine: 10,
        },
      ],
      hypotheses: [
        {
          id: 'hyp1',
          category: 'deployment-regression',
          statement: 'Test',
          confidence: 0.5,
          priorConfidence: 0.5,
          verdict: 'unconfirmed',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
      timeline: {
        events: [],
        boundaryCrossings: [
          {
            queueName: 'payments',
            producer: 'PayService',
            worker: 'PayWorker',
            evidenceId: 'ev1',
          },
        ],
      },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('payments');
    expect(tags).toContain('deployment-regression');
    expect(tags).toContain('src/modules/payment');
    expect(tags).toContain('payment-svc');
  });
});

// ---------------------------------------------------------------------------
// deriveSignature
// ---------------------------------------------------------------------------

describe('deriveSignature', () => {
  it('produces the expected pipe-joined string', () => {
    const r = makeReport({
      seeds: [
        {
          id: 'sym1',
          name: 'OrderService',
          filePath: 'src/modules/orders/order.service.ts',
          startLine: 1,
        },
      ],
      hypotheses: [
        {
          id: 'hyp1',
          category: 'queue-backlog',
          statement: 'Test',
          confidence: 0.5,
          priorConfidence: 0.5,
          verdict: 'unconfirmed',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
      timeline: {
        events: [],
        boundaryCrossings: [
          {
            queueName: 'orders',
            producer: 'OrderService',
            worker: 'OrderWorker',
            evidenceId: 'ev1',
          },
        ],
      },
    });
    const sig = deriveSignature(r);
    // Format: '<area>|<topHypCategory>|<sortedQueues>'
    expect(sig).toBe('src/modules/orders|queue-backlog|orders');
  });

  it('handles empty seeds and hypotheses', () => {
    const r = makeReport({
      seeds: [],
      hypotheses: [],
      timeline: { events: [], boundaryCrossings: [] },
    });
    const sig = deriveSignature(r);
    expect(sig).toBe('||');
  });

  it('sorts multiple queue names alphabetically', () => {
    const r = makeReport({
      seeds: [],
      hypotheses: [],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'zebra', producer: null, worker: null, evidenceId: 'ev1' },
          { queueName: 'alpha', producer: null, worker: null, evidenceId: 'ev2' },
        ],
      },
    });
    const sig = deriveSignature(r);
    // queues should be sorted: 'alpha,zebra'
    expect(sig).toBe('||alpha,zebra');
  });
});

// ---------------------------------------------------------------------------
// recallSimilar — project isolation (HOR-46)
// ---------------------------------------------------------------------------

/** Builds a DB mock that ignores WHERE clauses and always returns the given rows.
 *  This lets isolation tests verify in-memory project filtering even if the
 *  DB layer were to return rows from other projects. */
function makeIsolationDb(
  rows: {
    id: string;
    investigationId: string | null;
    project: string | null;
    title: string;
    summary: string | null;
    signature: string | null;
    tags: string[] | null;
    payload: unknown;
    createdAt: Date;
  }[],
): HorusDb {
  return {
    select() {
      const chain: Record<string, unknown> = {
        from(_table: unknown) {
          return chain;
        },
        where(_cond: unknown) {
          return chain;
        },
        orderBy(..._cols: unknown[]) {
          return chain;
        },
        limit(_n: number) {
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
    insert(_table: unknown) {
      return {
        values(_rows: unknown) {
          return {
            returning(_cols: unknown): Promise<{ id: string }[]> {
              return Promise.resolve([{ id: 'mock-id' }]);
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(_vals: unknown) {
          return {
            where(_cond: unknown): Promise<void> {
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as HorusDb;
}

function makeMemoryRow(project: string | null, title: string, tags: string[]) {
  return {
    id: globalThis.crypto.randomUUID(),
    investigationId: null,
    project,
    title,
    summary: null,
    signature: null,
    tags,
    payload: null,
    createdAt: new Date(),
  };
}

describe('recallSimilar — project isolation (HOR-46)', () => {
  it('never returns memories from a different project', async () => {
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/orders', 'orders']),
      makeMemoryRow('project-b', 'Incident B', ['src/modules/orders', 'orders']),
    ];
    // Mock returns rows from BOTH projects — in-memory filter must exclude project-b.
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(
      db,
      ['src/modules/orders', 'orders'],
      null,
      'project-a',
    );
    expect(results.every((r) => r.title !== 'Incident B')).toBe(true);
    expect(results.some((r) => r.title === 'Incident A')).toBe(true);
  });

  it('project-b sees its own memories but not project-a memories', async () => {
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/payments', 'payments']),
      makeMemoryRow('project-b', 'Incident B', ['src/modules/payments', 'payments']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(
      db,
      ['src/modules/payments', 'payments'],
      null,
      'project-b',
    );
    expect(results.every((r) => r.title !== 'Incident A')).toBe(true);
    expect(results.some((r) => r.title === 'Incident B')).toBe(true);
  });

  it('returns empty when no same-project memories exist', async () => {
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/orders', 'orders']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(
      db,
      ['src/modules/orders', 'orders'],
      null,
      'project-b',
    );
    expect(results).toHaveLength(0);
  });

  it('excludes the current investigation even within the same project', async () => {
    const id = globalThis.crypto.randomUUID();
    const rows = [
      { ...makeMemoryRow('project-a', 'Self', ['orders']), investigationId: id },
      makeMemoryRow('project-a', 'Peer', ['orders']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(db, ['orders'], id, 'project-a');
    expect(results.every((r) => r.title !== 'Self')).toBe(true);
  });

  it('fails closed — null project returns empty without querying the DB', async () => {
    // The mock would return rows if reached; null project must short-circuit.
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/orders', 'orders']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(db, ['src/modules/orders', 'orders'], null, null);
    expect(results).toHaveLength(0);
  });

  it('fails closed — empty string project is treated as missing', async () => {
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/orders', 'orders']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(db, ['src/modules/orders', 'orders'], null, '');
    expect(results).toHaveLength(0);
  });

  it('fails closed — whitespace-only project is treated as missing', async () => {
    const rows = [
      makeMemoryRow('project-a', 'Incident A', ['src/modules/orders', 'orders']),
    ];
    const db = makeIsolationDb(rows);
    const results = await recallSimilar(
      db,
      ['src/modules/orders', 'orders'],
      null,
      '   ',
    );
    expect(results).toHaveLength(0);
  });
});

describe('recallSimilar — bounded scan keeps the newest incidents', () => {
  it('still recalls the latest incident after more than 200 rows exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'horus-recall-order-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    try {
      const base = Date.parse('2026-01-01T00:00:00Z');
      // Oldest rows inserted first, as investigations accumulate in production.
      await handle.db.insert(incidentMemory).values(
        Array.from({ length: 210 }, (_, i) => ({
          project: 'p',
          title: `incident ${i}`,
          tags: i === 209 ? ['src/modules/latest'] : ['src/modules/older'],
          createdAt: new Date(base + i * 60_000),
        })),
      );
      const results = await recallSimilar(handle.db, ['src/modules/latest'], null, 'p');
      expect(results.map((r) => r.title)).toEqual(['incident 209']);
    } finally {
      await handle.sql.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// storeIncidentMemory — project persistence (HOR-46)
// ---------------------------------------------------------------------------

describe('storeIncidentMemory — project persistence (HOR-46)', () => {
  it('persists project from r.input.repo', async () => {
    const inserted: unknown[] = [];
    const db = {
      select() {
        return {
          from() {
            return Promise.resolve([]);
          },
        };
      },
      insert(_table: unknown) {
        return {
          values(row: unknown) {
            inserted.push(row);
            return {
              returning() {
                return Promise.resolve([{ id: 'mock-id' }]);
              },
            };
          },
        };
      },
      update(_table: unknown) {
        return {
          set(_v: unknown) {
            return {
              where() {
                return Promise.resolve();
              },
            };
          },
        };
      },
    } as unknown as HorusDb;

    await storeIncidentMemory(
      db,
      null,
      makeReport({ input: { hint: 'test', repo: 'my-repo' } }),
    );
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { project: string }).project).toBe('my-repo');
  });

  it('skips storage when r.input.repo is blank', async () => {
    const insertSpy = vi.fn();
    const db = {
      select() {
        return {
          from() {
            return Promise.resolve([]);
          },
        };
      },
      insert(_table: unknown) {
        return {
          values(row: unknown) {
            insertSpy(row);
            return {
              returning() {
                return Promise.resolve([{ id: 'mock-id' }]);
              },
            };
          },
        };
      },
      update(_table: unknown) {
        return {
          set(_v: unknown) {
            return {
              where() {
                return Promise.resolve();
              },
            };
          },
        };
      },
    } as unknown as HorusDb;

    await storeIncidentMemory(
      db,
      null,
      makeReport({ input: { hint: 'test', repo: '' } }),
    );
    expect(insertSpy).not.toHaveBeenCalled();

    await storeIncidentMemory(
      db,
      null,
      makeReport({ input: { hint: 'test', repo: '   ' } }),
    );
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('skips storage when r.input.repo is absent', async () => {
    const insertSpy = vi.fn();
    const db = {
      select() {
        return {
          from() {
            return Promise.resolve([]);
          },
        };
      },
      insert(_table: unknown) {
        return {
          values(row: unknown) {
            insertSpy(row);
            return {
              returning() {
                return Promise.resolve([{ id: 'mock-id' }]);
              },
            };
          },
        };
      },
      update(_table: unknown) {
        return {
          set(_v: unknown) {
            return {
              where() {
                return Promise.resolve();
              },
            };
          },
        };
      },
    } as unknown as HorusDb;

    await storeIncidentMemory(db, null, makeReport({ input: { hint: 'test' } }));
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
