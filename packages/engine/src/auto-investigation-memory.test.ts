/**
 * HOR-432 — auto-capture a recurrence-CONSOLIDATING memory from EVERY investigation.
 *
 * Exercised against the embedded pglite db (so the bundled memory_item/_link/_audit migrations and the
 * incident-family signature/tags write-gate are proven end-to-end) plus an `investigate()` integration
 * pass that proves the capture is NON-BLOCKING and CONTEXT-ONLY.
 *
 * Cases:
 *   (a) a first investigation creates ONE `investigation` memory with the HONEST confidence +
 *       signature/tags + payload.recurrenceCount = 1 + an about-incident link;
 *   (b) a RECURRING investigation (same fingerprint) UPDATES the existing memory IN PLACE — count
 *       increments, exactly ONE item remains, the latest finding/confidence is reflected, and NO new
 *       item + NO `recurs-with` edge are created;
 *   (c) a genuinely different incident CREATES a new item (two items, each count 1);
 *   (d) recall surfaces the SINGLE consolidated item with its count (N recurrences ⇒ one item, count N);
 *   (e) HONESTY — a consolidation refreshes confidence to the LATEST report VERBATIM (never inflated);
 *   (f) a blank repo ⇒ NO memory (HOR-46 fail-closed);
 *   (g) the capture touches only add/update/query/addLink — never a status/scoring mutation;
 *   (h) a store error is swallowed and the investigation still returns (non-blocking);
 *   (i) the memory is never consulted by scoring (confidence identical with/without the store).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import { createLocalDb, type HorusDb, type QueueEdge } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import { recallMemory } from './memory-recall.js';
import {
  autoInvestigationMemoryEnabled,
  captureInvestigationMemory,
  createInvestigationMemory,
  consolidateRecurrence,
  detectRecurrence,
  deriveInvestigationFields,
  recurrenceCountOf,
} from './auto-investigation-memory.js';
import { investigate } from './engine.js';
import type { AuditCtx, MemoryItem, MemoryStore } from './memory-store.js';
import type { InvestigationReport } from './types.js';

const actor = { kind: 'system' as const };
const audit: AuditCtx = { actor, note: 'test' };
const REPORT_TIME = new Date('2026-06-28T12:00:00.000Z');

// ---------------------------------------------------------------------------
// Minimal InvestigationReport factory (only the fields the capture path reads)
// ---------------------------------------------------------------------------

function makeReport(over: {
  repo?: string | undefined;
  hint?: string;
  confidence?: number;
  seedFile?: string;
  topCategory?: string;
  service?: string;
  statement?: string;
} = {}): InvestigationReport {
  return {
    id: 'inv_test',
    input: {
      hint: over.hint ?? 'orders are failing',
      repo: 'repo' in over ? over.repo : 'r',
      ...(over.service !== undefined ? { service: over.service } : {}),
    },
    summary: 'a deterministic summary',
    seeds: [
      {
        id: 'sym:x',
        name: 'X',
        filePath: over.seedFile ?? 'src/modules/orders/orders.service.ts',
        startLine: 1,
      },
    ],
    evidence: [],
    timeline: { boundaryCrossings: [] },
    correlation: {},
    findings: [],
    suspectedCauses: [],
    hypotheses: [
      {
        id: 'h1',
        category: over.topCategory ?? 'orders-stall',
        statement: over.statement ?? 'the orders worker stalls on a slow downstream call',
        confidence: 0.7,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        verdict: 'supported',
        priorConfidence: 0.6,
        supportingPresent: 1,
        contradictingPresent: 0,
        rationale: 'r',
      },
    ],
    similarIncidents: [],
    gapAnalysis: { gaps: [] },
    graph: {},
    confidence: over.confidence ?? 0.42,
    nextActions: [],
  } as unknown as InvestigationReport;
}

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

describe('autoInvestigationMemoryEnabled — default ON, explicit off disables', () => {
  const prev = process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
  afterEach(() => {
    if (prev === undefined) delete process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
    else process.env.HORUS_AUTO_INVESTIGATION_MEMORY = prev;
  });

  it('is ON when unset (every investigation contributes to memory)', () => {
    delete process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
    expect(autoInvestigationMemoryEnabled()).toBe(true);
  });

  it('is OFF only for an explicit 0/false/off/no escape hatch', () => {
    for (const v of ['0', 'false', 'FALSE', 'off', 'no']) {
      process.env.HORUS_AUTO_INVESTIGATION_MEMORY = v;
      expect(autoInvestigationMemoryEnabled()).toBe(false);
    }
    for (const v of ['1', 'true', 'yes', '']) {
      process.env.HORUS_AUTO_INVESTIGATION_MEMORY = v; // anything but the off-list ⇒ default-ON
      expect(autoInvestigationMemoryEnabled()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (a)-(f) against the real local store (embedded pglite)
// ---------------------------------------------------------------------------

describe('auto-investigation-memory — local store (consolidation)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-auto-mem-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) a first investigation creates ONE memory: honest confidence, signature/tags, count=1, link', async () => {
    const report = makeReport({ confidence: 0.31, service: 'orders' });
    const res = await captureInvestigationMemory(store, 'inv_a', report, REPORT_TIME, audit);

    expect(res.action).toBe('created');
    expect(res.recurrenceCount).toBe(1);
    expect(res.memoryId).not.toBeNull();

    const all = await store.query({ repo: 'r', kind: ['investigation'] });
    expect(all).toHaveLength(1);
    const mem = all[0]!;
    expect(mem.kind).toBe('investigation');
    expect(mem.source).toBe('investigation');
    expect(mem.scope).toBe('repo');
    expect(mem.visibility).toBe('private');
    // HONEST confidence — the report's own value, never inflated.
    expect(mem.confidence).toBeCloseTo(0.31, 5);
    expect(mem.claim).toContain('Investigation:');
    expect(mem.claim).toContain('orders are failing');
    // Incident-family recall keys persisted (NOT nulled) for the investigation kind.
    expect(mem.signature).toBe('src/modules/orders|orders-stall|');
    expect(mem.tags).toEqual(expect.arrayContaining(['orders-stall', 'src/modules/orders', 'orders']));
    // First sighting ⇒ recurrenceCount = 1.
    expect(recurrenceCountOf(mem.payload)).toBe(1);

    // about-incident link back to the source investigation (structural).
    const links = await store.links(mem.id, { direction: 'both' });
    const back = links.find((l) => l.rel === 'about-incident' && l.toKind === 'incident');
    expect(back?.toRef).toBe('inv_a');
  });

  it('(b) a recurrence UPDATES the existing item in place: count++, ONE item, latest finding, no new item, no recurs-with', async () => {
    const first = await captureInvestigationMemory(
      store,
      'inv_a',
      makeReport({ confidence: 0.7, hint: 'orders are failing' }),
      REPORT_TIME,
      audit,
    );
    expect(first.action).toBe('created');

    // Same incident fingerprint (seedFile/topCategory unchanged ⇒ same signature/tags), newer finding.
    const second = await captureInvestigationMemory(
      store,
      'inv_b',
      makeReport({
        confidence: 0.55,
        hint: 'orders failing AGAIN',
        statement: 'the orders worker stalls — now confirmed on the downstream call',
      }),
      new Date('2026-06-29T09:30:00.000Z'),
      audit,
    );

    expect(second.action).toBe('consolidated');
    expect(second.recurrenceCount).toBe(2);
    // The consolidation reused the SAME memory id — no twin minted.
    expect(second.memoryId).toBe(first.memoryId);

    // Exactly ONE investigation memory exists (the recurrence did NOT add a row).
    const all = await store.query({ repo: 'r', kind: ['investigation'] });
    expect(all).toHaveLength(1);
    const mem = all[0]!;

    // Count bumped + last-seen + investigation ids rolled forward in the payload (additive, no schema change).
    expect(recurrenceCountOf(mem.payload)).toBe(2);
    const payload = mem.payload as Record<string, unknown>;
    expect(payload.lastSeenAt).toBe('2026-06-29T09:30:00.000Z');
    expect(payload.investigationIds).toEqual(['inv_a', 'inv_b']);

    // Latest finding reflected (claim + confidence refreshed to the most recent report).
    expect(mem.claim).toContain('orders failing AGAIN');
    expect(mem.claim).toContain('now confirmed on the downstream call');
    expect(mem.confidence).toBeCloseTo(0.55, 5);

    // NO recurs-with edge between duplicates (there are no duplicates to link).
    const links = await store.links(mem.id, { direction: 'both' });
    expect(links.some((l) => l.rel === 'recurs-with')).toBe(false);
    // An about-incident link to EACH source investigation (latest one added on consolidation).
    const incidents = links.filter((l) => l.rel === 'about-incident').map((l) => l.toRef).sort();
    expect(incidents).toEqual(['inv_a', 'inv_b']);

    // A recurrence audit row was appended with the honest consolidation provenance.
    const trail = await store.history(mem.id);
    const recurrence = trail.find((a) => a.action === 'recurrence');
    expect(recurrence).toBeDefined();
    expect((recurrence!.detail as Record<string, unknown>).detection).toBe('auto:recurrence-consolidate');
  });

  it('(c) a genuinely different incident CREATES a new item (two items, each count 1)', async () => {
    const orders = await captureInvestigationMemory(store, 'inv_a', makeReport(), REPORT_TIME, audit);
    const billing = await captureInvestigationMemory(
      store,
      'inv_b',
      makeReport({
        hint: 'invoices not generated',
        seedFile: 'src/modules/billing/billing.service.ts',
        topCategory: 'billing-stuck',
      }),
      REPORT_TIME,
      audit,
    );

    expect(orders.action).toBe('created');
    expect(billing.action).toBe('created');
    expect(billing.memoryId).not.toBe(orders.memoryId);

    const all = await store.query({ repo: 'r', kind: ['investigation'] });
    expect(all).toHaveLength(2);
    for (const m of all) expect(recurrenceCountOf(m.payload)).toBe(1);
  });

  it('(d) recall surfaces the SINGLE consolidated item with its count (3 recurrences ⇒ one item, count 3)', async () => {
    await captureInvestigationMemory(store, 'inv_a', makeReport(), REPORT_TIME, audit);
    await captureInvestigationMemory(store, 'inv_b', makeReport({ hint: 'orders failing #2' }), REPORT_TIME, audit);
    await captureInvestigationMemory(store, 'inv_c', makeReport({ hint: 'orders failing #3' }), REPORT_TIME, audit);

    const recalled = await recallMemory(store, { repo: 'r', kind: ['investigation'] });
    expect(recalled).toHaveLength(1);
    expect(recurrenceCountOf(recalled[0]!.item.payload)).toBe(3);
    // The single item shows the LATEST finding.
    expect(recalled[0]!.item.claim).toContain('orders failing #3');
  });

  it('(e) HONESTY — a consolidation refreshes confidence to the LATEST report verbatim (never inflated)', async () => {
    // First run is HIGH confidence; the recurrence is LOWER. The stored value must follow the latest,
    // never keep/raise to the prior maximum.
    await captureInvestigationMemory(store, 'inv_a', makeReport({ confidence: 0.9 }), REPORT_TIME, audit);
    await captureInvestigationMemory(store, 'inv_b', makeReport({ confidence: 0.2 }), REPORT_TIME, audit);

    const all = await store.query({ repo: 'r', kind: ['investigation'] });
    expect(all).toHaveLength(1);
    expect(all[0]!.confidence).toBeCloseTo(0.2, 5); // latest verbatim, NOT max(0.9, 0.2)
  });

  it('(f) a blank repo creates NO memory (HOR-46 fail-closed)', async () => {
    expect((await captureInvestigationMemory(store, 'inv_a', makeReport({ repo: '' }), REPORT_TIME, audit)).action).toBe('skipped');
    expect((await captureInvestigationMemory(store, 'inv_a', makeReport({ repo: '   ' }), REPORT_TIME, audit)).action).toBe('skipped');
    expect(await createInvestigationMemory(store, 'inv_a', makeReport({ repo: undefined }), audit)).toBeNull();
    // Nothing landed (a blank repo query fails closed and returns nothing anyway).
    expect(await store.query({ repo: 'r', kind: ['investigation'] })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (g) seam-only: the capture never touches a status/scoring mutation
// ---------------------------------------------------------------------------

describe('auto-investigation-memory — context-only seam usage (g)', () => {
  function makeItem(over: Partial<MemoryItem> = {}): MemoryItem {
    return {
      id: 'mem_new',
      kind: 'investigation',
      claim: 'Investigation: x -> y',
      scope: 'repo',
      source: 'investigation',
      evidence: [],
      confidence: 0.5,
      status: 'fresh',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastVerifiedAt: null,
      lastVerifiedHash: null,
      orgId: null,
      workspaceId: null,
      repo: 'r',
      userId: null,
      visibility: 'private',
      origin: 'local',
      cloudId: null,
      authorName: null,
      pulledAt: null,
      payload: { recurrenceCount: 1, investigationId: 'inv_prior' },
      signature: 'src/modules/orders|orders-stall|',
      tags: ['orders-stall', 'src/modules/orders'],
      ...over,
    };
  }

  function spyStore(queryResult: MemoryItem[]): MemoryStore {
    return {
      recall: vi.fn(),
      record: vi.fn(),
      loadScoped: vi.fn(),
      add: vi.fn(async (item) => makeItem({ id: 'mem_new', ...(item as Partial<MemoryItem>) })),
      update: vi.fn(async (id, patch) => makeItem({ id, ...(patch as Partial<MemoryItem>) })),
      get: vi.fn(),
      query: vi.fn(async () => queryResult),
      setStatus: vi.fn(),
      setVisibility: vi.fn(),
      verify: vi.fn(),
      addLink: vi.fn(async (link) => ({ ...(link as object), createdAt: new Date() })),
      removeLink: vi.fn(),
      links: vi.fn(async () => []),
      history: vi.fn(),
    } as unknown as MemoryStore;
  }

  it('a recurrence path calls ONLY query/update/addLink — never a status/scoring mutation', async () => {
    const prior = makeItem({ id: 'mem_prior' });
    const store = spyStore([prior]);
    const fields = deriveInvestigationFields(makeReport());

    const existing = await detectRecurrence(store, fields, 'r');
    expect(existing?.id).toBe('mem_prior');
    await consolidateRecurrence(store, existing!, 'inv_a', fields, REPORT_TIME, audit);

    // Read/refresh/link seam only.
    expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ repo: 'r', kind: ['investigation'] }));
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(store.addLink).toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled(); // a recurrence never inserts a new row
    // NEVER a status/visibility/verify/remove mutation — the capture cannot touch scoring/verdict.
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(store.setVisibility).not.toHaveBeenCalled();
    expect(store.verify).not.toHaveBeenCalled();
    expect(store.removeLink).not.toHaveBeenCalled();
  });

  it('a fresh fingerprint path creates (add) without update', async () => {
    const store = spyStore([]); // nothing to recur with
    await captureInvestigationMemory(store, 'inv_a', makeReport(), REPORT_TIME, audit);
    expect(store.add).toHaveBeenCalledTimes(1);
    expect(store.update).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (h)+(i) engine integration — non-blocking + scoring untouched
// ---------------------------------------------------------------------------

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:ZohoSyncWorker',
  name: 'ZohoSyncWorker',
  filePath: 'src/workers/zoho-sync.worker.ts',
  startLine: 10,
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [FAKE_SYMBOL]; },
  async context(): Promise<SymbolContext> {
    return { symbol: FAKE_SYMBOL, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] };
  },
  async impact(): Promise<ImpactResult> {
    return { target: FAKE_SYMBOL, affected: 0, byDepth: [] };
  },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> {
    return { added: [], removed: [], modified: [] };
  },
  async cypher(): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

function makeDb(): HorusDb {
  return {
    select() {
      return { from() { return Promise.resolve([] as QueueEdge[]); } };
    },
    insert() {
      return {
        values() {
          return { returning(): Promise<{ id: string }[]> { return Promise.resolve([{ id: 'test-id' }]); } };
        },
      };
    },
    update() {
      return { set() { return { where(): Promise<void> { return Promise.resolve(); } }; } };
    },
  } as unknown as HorusDb;
}

function noopStore(): MemoryStore {
  return {
    recall: vi.fn(async () => []),
    record: vi.fn(),
    loadScoped: vi.fn(async () => []),
    add: vi.fn(async (item) => ({
      ...(item as object),
      id: 'mem_x',
      status: 'fresh',
      createdAt: new Date(),
    })),
    update: vi.fn(async (id, patch) => ({ ...(patch as object), id, status: 'fresh', createdAt: new Date() })),
    get: vi.fn(),
    query: vi.fn(async () => []),
    setStatus: vi.fn(),
    setVisibility: vi.fn(),
    verify: vi.fn(),
    addLink: vi.fn(async (link) => ({ ...(link as object), createdAt: new Date() })),
    removeLink: vi.fn(),
    links: vi.fn(async () => []),
    history: vi.fn(),
  } as unknown as MemoryStore;
}

describe('auto-investigation-memory — engine integration', () => {
  it('(h) a store error is swallowed — investigate() still returns a report (non-blocking)', async () => {
    const throwing = noopStore();
    (throwing.add as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('memory store down'));

    const report = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb(), store: throwing },
    );

    expect(report).toBeDefined();
    expect(report.id).toBeTruthy();
    // The capture WAS attempted (default-ON) and its failure did not propagate.
    expect(throwing.add).toHaveBeenCalled();
  });

  it('(i) the memory is never consulted by scoring — confidence is identical with/without the store', async () => {
    const withoutStore = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb() },
    );
    const store = noopStore();
    const withStore = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb(), store },
    );

    // Adding the memory store changes nothing about the scored verdict.
    expect(withStore.confidence).toBe(withoutStore.confidence);
    // The memory WAS written (capture ran) yet it never fed back into the score.
    expect(store.add).toHaveBeenCalled();
  });

  it('(i) the escape hatch disables capture entirely', async () => {
    const prev = process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
    process.env.HORUS_AUTO_INVESTIGATION_MEMORY = '0';
    try {
      const store = noopStore();
      await investigate({ hint: 'zoho', repo: 'r' }, { code: fakeCode, db: makeDb(), store });
      expect(store.add).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
      else process.env.HORUS_AUTO_INVESTIGATION_MEMORY = prev;
    }
  });
});
