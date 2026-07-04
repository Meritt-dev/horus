/**
 * Horus Memory M3 — conservative auto-detection of memory→memory edges (Stage 1b).
 *
 * Two detectors, exercised against the embedded pglite db (so the bundled migrations incl.
 * memory_item.signature/tags are proven end-to-end) plus pure-helper + seam-spy tests:
 *   - recurrence (`recurs-with`): rejects empty / all-delimiter / generic-only signatures, honors the
 *     signature / tag-overlap thresholds, and a claim-text Jaccard fallback that NEVER authors alone.
 *   - contradiction (`contradicts`): fires ONLY between two confirmed-outcome items in the SAME
 *     incident family (shared signature — NEVER grouped by scope), with materially-conflicting confirmed
 *     labels, and NEVER fabricates (a missing label on either side ⇒ no edge).
 *
 * HONESTY INVARIANTS asserted here (spec §8):
 *   - the detectors are EDGES-ONLY: detection never flips status / forgets / re-statuses an item;
 *   - the detectors are CONTEXT-ONLY: detection touches only the read seam (query/links) — it never
 *     calls add/setStatus/setVisibility/verify (the confidence/verdict path is untouched);
 *   - precedent (`supersedes`) is NEVER auto-detected; private targets never leak (repo-scoped).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, type HorusDb, type NewMemoryItem } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import {
  detectMemoryEdges,
  usableSignature,
  sharedNonGenericTags,
  outcomeConflict,
  recurrenceEdgeId,
  type OutcomeVerdict,
  type DetectMemoryDeps,
} from './memory-detect.js';
import type { MemoryStore, MemoryItem, AuditCtx } from './memory-store.js';

const actor = { kind: 'system' as const };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('usableSignature', () => {
  it('rejects blank / all-delimiter signatures (empty, "|", "||")', () => {
    expect(usableSignature('')).toBeNull();
    expect(usableSignature('   ')).toBeNull();
    expect(usableSignature('|')).toBeNull();
    expect(usableSignature('||')).toBeNull();
    expect(usableSignature(null)).toBeNull();
    expect(usableSignature(undefined)).toBeNull();
  });

  it('rejects a signature whose every component is generic (env/hypothesis labels)', () => {
    expect(usableSignature('queue-backlog')).toBeNull();
    expect(usableSignature('|queue-backlog|prod')).toBeNull();
    expect(usableSignature('deployment-regression,worker-slowdown')).toBeNull();
  });

  it('accepts a signature with ≥1 non-generic component', () => {
    expect(usableSignature('src/modules/zoho|external-api-latency|')).toBe(
      'src/modules/zoho|external-api-latency|',
    );
    expect(usableSignature('src/auth|deployment-regression|emails')).toBe(
      'src/auth|deployment-regression|emails',
    );
  });
});

describe('sharedNonGenericTags', () => {
  it('returns only the deduped, non-generic shared tags (HOR-39)', () => {
    expect(sharedNonGenericTags(['src/auth', 'prod', 'queue-x'], ['src/auth', 'prod', 'queue-y'])).toEqual([
      'src/auth',
    ]);
    // generic-only intersection => no specific overlap
    expect(sharedNonGenericTags(['prod', 'queue-backlog'], ['prod', 'queue-backlog'])).toEqual([]);
  });
});

describe('outcomeConflict', () => {
  const v = (resolved: OutcomeVerdict['resolved'], cause: string | null): OutcomeVerdict => ({
    investigationId: 'inv',
    resolved,
    confirmedCause: cause,
  });

  it('flags opposite verdicts (yes vs no)', () => {
    expect(outcomeConflict(v('yes', null), v('no', null))).toMatch(/disagree/);
    expect(outcomeConflict(v('no', null), v('yes', null))).toMatch(/disagree/);
  });

  it('does NOT treat partly as the opposite of yes/no', () => {
    expect(outcomeConflict(v('yes', null), v('partly', null))).toBeNull();
    expect(outcomeConflict(v('partly', null), v('no', null))).toBeNull();
  });

  it('flags materially-different confirmed causes', () => {
    expect(outcomeConflict(v('yes', 'redis timeout'), v('yes', 'bad migration'))).toMatch(/causes differ/);
  });

  it('does NOT flag when a cause is missing on either side (no fabrication)', () => {
    expect(outcomeConflict(v('yes', 'redis timeout'), v('yes', null))).toBeNull();
    expect(outcomeConflict(v('yes', null), v('yes', 'redis timeout'))).toBeNull();
  });

  it('does NOT flag identical (whitespace-insensitive) causes + same verdict', () => {
    expect(outcomeConflict(v('yes', 'Redis  timeout'), v('yes', 'redis timeout'))).toBeNull();
  });
});

describe('recurrenceEdgeId', () => {
  it('is order-independent + deterministic (resync-stable canonical pair hash)', () => {
    expect(recurrenceEdgeId('mem_b', 'mem_a')).toBe(recurrenceEdgeId('mem_a', 'mem_b'));
    expect(recurrenceEdgeId('mem_a', 'mem_b')).toMatch(/^lnk_recurs_[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Detector — against the real embedded pglite store
// ---------------------------------------------------------------------------

describe('detectMemoryEdges — recurrence (recurs-with)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-detect-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (over: Partial<NewMemoryItem>, ctx: AuditCtx = { actor }): Promise<MemoryItem> =>
    store.add(
      {
        id: '',
        kind: 'incident-pattern',
        claim: over.claim ?? 'an incident',
        scope: 'repo',
        source: 'derived',
        confidence: 0.8,
        repo: 'r',
        ...over,
      },
      ctx,
    );

  it('populates signature/tags at WRITE for incident-derived kinds, and NULLs them for others', async () => {
    const inc = await add({
      kind: 'incident-pattern',
      claim: 'derived',
      signature: 'src/auth|x|',
      tags: ['Src/Auth', 'src/auth', 'EMAILS'], // normalized: lowercased + deduped
    });
    expect(inc.signature).toBe('src/auth|x|');
    expect(inc.tags).toEqual(['src/auth', 'emails']);

    // A non-incident kind never carries recall keys, even if a caller supplies them.
    const dec = await add({
      kind: 'decision',
      source: 'human',
      claim: 'a decision',
      signature: 'src/auth|x|',
      tags: ['src/auth'],
    });
    expect(dec.signature).toBeNull();
    expect(dec.tags).toBeNull();
  });

  it('authors recurs-with for two items with an IDENTICAL usable signature', async () => {
    const a = await add({ claim: 'first', signature: 'src/auth|deployment-regression|emails' });
    const b = await add({ claim: 'second', signature: 'src/auth|deployment-regression|emails' });

    const edges = await detectMemoryEdges(store, { repo: 'r' });
    expect(edges).toHaveLength(1);
    const e = edges[0]!;
    expect(e.rel).toBe('recurs-with');
    expect(e.detection).toBe('auto:recurrence');
    expect(e.reason).toMatch(/identical incident signature/);
    // resync-stable, canonicalized id + endpoints.
    expect(e.id).toBe(recurrenceEdgeId(a.id, b.id));
    const [lo, hi] = a.id <= b.id ? [a.id, b.id] : [b.id, a.id];
    expect(e.fromMemoryId).toBe(lo);
    expect(e.toMemoryId).toBe(hi);
  });

  it('REJECTS an empty signature: no recurrence with "" + no tags', async () => {
    await add({ claim: 'first', signature: '' });
    await add({ claim: 'second', signature: '||' });
    expect(await detectMemoryEdges(store, { repo: 'r' })).toEqual([]);
  });

  it('REJECTS a generic-only signature (queue-backlog) with no specific tag', async () => {
    await add({ claim: 'first', signature: 'queue-backlog' });
    await add({ claim: 'second', signature: 'queue-backlog' });
    expect(await detectMemoryEdges(store, { repo: 'r' })).toEqual([]);
  });

  it('authors recurs-with on tag overlap ≥0.6 with ≥1 non-generic shared tag', async () => {
    await add({ claim: 'first', tags: ['src/auth', 'emails'] });
    await add({ claim: 'second', tags: ['src/auth', 'emails'] });
    const edges = await detectMemoryEdges(store, { repo: 'r' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.reason).toMatch(/tag overlap/);
  });

  it('does NOT author on tag overlap BELOW 0.6 (conservative threshold)', async () => {
    await add({ claim: 'alpha beta gamma', tags: ['src/auth', 'a', 'b', 'c'] });
    await add({ claim: 'delta epsilon zeta', tags: ['src/auth', 'd', 'e', 'f'] });
    expect(await detectMemoryEdges(store, { repo: 'r' })).toEqual([]);
  });

  it('claim-text Jaccard fallback NEVER authors alone — needs a non-generic shared tag', async () => {
    // Identical claims, but NO shared tags ⇒ no edge (the fallback may not stand alone).
    const claim = 'the worker crashed because the redis connection pool was exhausted at peak load';
    await add({ claim, tags: ['a', 'b'] });
    await add({ claim, tags: ['c', 'd'] });
    expect(await detectMemoryEdges(store, { repo: 'r' })).toEqual([]);
  });

  it('claim-text Jaccard fallback authors when corroborated by a non-generic shared tag', async () => {
    const claim = 'the worker crashed because the redis connection pool was exhausted at peak load';
    await add({ claim, tags: ['src/worker', 'a', 'b'] });
    await add({ claim, tags: ['src/worker', 'c', 'd'] }); // overlap 1/5 = 0.2 (<0.6) ⇒ tag path off
    const edges = await detectMemoryEdges(store, { repo: 'r' });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.reason).toMatch(/claim similarity/);
  });

  it('is idempotent: applying a proposal then re-running proposes nothing new', async () => {
    await add({ claim: 'first', signature: 'src/auth|x|' });
    await add({ claim: 'second', signature: 'src/auth|x|' });

    const first = await detectMemoryEdges(store, { repo: 'r' });
    expect(first).toHaveLength(1);
    const p = first[0]!;
    await store.addLink(
      { id: p.id, fromMemoryId: p.fromMemoryId, rel: p.rel, toKind: 'memory', toRef: p.toMemoryId },
      { detection: p.detection, audit: { actor }, detail: p.detail },
    );
    expect(await detectMemoryEdges(store, { repo: 'r' })).toEqual([]);
  });

  it('NEVER proposes supersedes (precedent is never auto-detected)', async () => {
    await add({ claim: 'first', signature: 'src/auth|x|' });
    await add({ claim: 'second', signature: 'src/auth|x|' });
    const edges = await detectMemoryEdges(store, { repo: 'r' });
    expect(edges.every((e) => e.rel !== 'supersedes')).toBe(true);
  });

  it('fails closed on a blank repo (HOR-46)', async () => {
    await add({ signature: 'src/auth|x|' });
    await add({ signature: 'src/auth|x|' });
    expect(await detectMemoryEdges(store, { repo: '  ' })).toEqual([]);
  });
});

describe('detectMemoryEdges — contradiction (contradicts)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-contra-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A confirmed-outcome item linked (about-incident) to `inv`, in incident family `sig`.
  const addConfirmed = async (sig: string, inv: string, claim: string): Promise<MemoryItem> => {
    const item = await store.add(
      {
        id: '',
        kind: 'confirmed-outcome',
        claim,
        scope: 'repo',
        source: 'confirmed-outcome',
        confidence: 0.9,
        repo: 'r',
        visibility: 'private',
        signature: sig,
      },
      { actor },
    );
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'about-incident', toKind: 'incident', toRef: inv });
    return item;
  };

  // outcomeFor backed by an in-memory verdict map.
  const depsFor = (map: Record<string, OutcomeVerdict>): DetectMemoryDeps => ({
    outcomeFor: async (id) => map[id] ?? null,
  });

  it('flags two confirmed outcomes of the SAME incident family with conflicting labels', async () => {
    const a = await addConfirmed('src/auth|x|', 'inv_a', 'cause was redis timeout');
    const b = await addConfirmed('src/auth|x|', 'inv_b', 'cause was bad migration');
    const deps = depsFor({
      inv_a: { investigationId: 'inv_a', resolved: 'yes', confirmedCause: 'redis timeout' },
      inv_b: { investigationId: 'inv_b', resolved: 'yes', confirmedCause: 'bad migration' },
    });

    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    const contra = edges.filter((e) => e.rel === 'contradicts');
    expect(contra).toHaveLength(1);
    const e = contra[0]!;
    expect(e.detection).toBe('auto:contradiction');
    expect(e.reason).toMatch(/causes differ/);
    // audit detail carries BOTH source investigationIds.
    expect(new Set((e.detail!.investigationIds as string[]))).toEqual(new Set(['inv_a', 'inv_b']));
    expect(new Set([e.fromMemoryId, e.toMemoryId])).toEqual(new Set([a.id, b.id]));
  });

  it('is idempotent: re-running detect after applying the contradicts edge proposes nothing new (HOR-417)', async () => {
    // Ids + timestamps are chosen so the store's query order (newest-first) is the REVERSE of the
    // canonical lo→hi order the detector stores the edge as. That is exactly the ordering that made
    // the pre-fix directional dedup key miss the stored edge, so a second `detect` re-inserted a
    // duplicate contradicts edge. With edgeKey canonicalized this pass must propose nothing new.
    const older = await store.add(
      {
        id: 'mem_aaaa',
        kind: 'confirmed-outcome',
        claim: 'cause was redis timeout',
        scope: 'repo',
        source: 'confirmed-outcome',
        confidence: 0.9,
        repo: 'r',
        visibility: 'private',
        signature: 'src/auth|x|',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      { actor },
    );
    await store.addLink({ id: '', fromMemoryId: older.id, rel: 'about-incident', toKind: 'incident', toRef: 'inv_a' });
    const newer = await store.add(
      {
        id: 'mem_zzzz',
        kind: 'confirmed-outcome',
        claim: 'cause was bad migration',
        scope: 'repo',
        source: 'confirmed-outcome',
        confidence: 0.9,
        repo: 'r',
        visibility: 'private',
        signature: 'src/auth|x|',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      { actor },
    );
    await store.addLink({ id: '', fromMemoryId: newer.id, rel: 'about-incident', toKind: 'incident', toRef: 'inv_b' });

    const deps = depsFor({
      inv_a: { investigationId: 'inv_a', resolved: 'yes', confirmedCause: 'redis timeout' },
      inv_b: { investigationId: 'inv_b', resolved: 'yes', confirmedCause: 'bad migration' },
    });

    // First pass proposes exactly one contradicts edge.
    const first = await detectMemoryEdges(store, { repo: 'r' }, deps);
    const firstContra = first.filter((e) => e.rel === 'contradicts');
    expect(firstContra).toHaveLength(1);

    // Apply it (store mints the directional id), exactly as `memory detect` persists a proposal.
    const p = firstContra[0]!;
    await store.addLink(
      { id: p.id, fromMemoryId: p.fromMemoryId, rel: p.rel, toKind: 'memory', toRef: p.toMemoryId },
      { detection: p.detection, audit: { actor }, detail: p.detail },
    );

    // Re-running detect must propose NO new contradicts edge — idempotent (HOR-417).
    const second = await detectMemoryEdges(store, { repo: 'r' }, deps);
    expect(second.filter((e) => e.rel === 'contradicts')).toEqual([]);
  });

  it('NEVER groups by scope: same scope but DIFFERENT signatures ⇒ no contradiction', async () => {
    await addConfirmed('src/auth|x|', 'inv_a', 'redis timeout'); // scope repo
    await addConfirmed('src/billing|y|', 'inv_b', 'bad migration'); // scope repo, different family
    const deps = depsFor({
      inv_a: { investigationId: 'inv_a', resolved: 'yes', confirmedCause: 'redis timeout' },
      inv_b: { investigationId: 'inv_b', resolved: 'no', confirmedCause: 'bad migration' },
    });
    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    expect(edges.filter((e) => e.rel === 'contradicts')).toEqual([]);
  });

  it('NEVER fabricates: a missing label on either side ⇒ no contradiction', async () => {
    await addConfirmed('src/auth|x|', 'inv_a', 'redis timeout');
    await addConfirmed('src/auth|x|', 'inv_b', 'bad migration');
    const deps = depsFor({
      inv_a: { investigationId: 'inv_a', resolved: 'yes', confirmedCause: 'redis timeout' },
      // inv_b deliberately absent (no confirmed label)
    });
    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    expect(edges.filter((e) => e.rel === 'contradicts')).toEqual([]);
  });

  it('does nothing without the outcome join (no outcomeFor dep)', async () => {
    await addConfirmed('src/auth|x|', 'inv_a', 'redis timeout');
    await addConfirmed('src/auth|x|', 'inv_b', 'bad migration');
    const edges = await detectMemoryEdges(store, { repo: 'r' });
    expect(edges.filter((e) => e.rel === 'contradicts')).toEqual([]);
  });

  it('only between confirmed-outcome items: incident-patterns recur but never contradict', async () => {
    // Same usable signature, but kind=incident-pattern ⇒ recurrence yes, contradiction no.
    await store.add(
      { id: '', kind: 'incident-pattern', claim: 'p1', scope: 'repo', source: 'derived', confidence: 0.7, repo: 'r', signature: 'src/auth|x|' },
      { actor },
    );
    await store.add(
      { id: '', kind: 'incident-pattern', claim: 'p2', scope: 'repo', source: 'derived', confidence: 0.7, repo: 'r', signature: 'src/auth|x|' },
      { actor },
    );
    const deps = depsFor({}); // even with a join wired, incident-patterns are not confirmed outcomes
    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    expect(edges.some((e) => e.rel === 'recurs-with')).toBe(true);
    expect(edges.some((e) => e.rel === 'contradicts')).toBe(false);
  });

  it('HONESTY: detection is EDGES-ONLY — neither item is forgotten or status-flipped', async () => {
    const a = await addConfirmed('src/auth|x|', 'inv_a', 'redis timeout');
    const b = await addConfirmed('src/auth|x|', 'inv_b', 'bad migration');
    const deps = depsFor({
      inv_a: { investigationId: 'inv_a', resolved: 'yes', confirmedCause: 'redis timeout' },
      inv_b: { investigationId: 'inv_b', resolved: 'yes', confirmedCause: 'bad migration' },
    });

    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    // Running detection changes NOTHING (read-only).
    expect((await store.get(a.id))!.status).toBe('fresh');
    expect((await store.get(b.id))!.status).toBe('fresh');

    // Even after APPLYING the contradiction edge, both items stay fresh (flag, not a deletion).
    const p = edges.find((e) => e.rel === 'contradicts')!;
    await store.addLink(
      { id: p.id, fromMemoryId: p.fromMemoryId, rel: p.rel, toKind: 'memory', toRef: p.toMemoryId },
      { detection: p.detection, audit: { actor }, detail: p.detail },
    );
    expect((await store.get(a.id))!.status).toBe('fresh');
    expect((await store.get(b.id))!.status).toBe('fresh');
    // confidence (the verdict-path input) is untouched too.
    expect((await store.get(a.id))!.confidence).toBe(0.9);
    expect((await store.get(b.id))!.confidence).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Seam-spy: CONTEXT-ONLY — detection touches only the read seam (no write methods)
// ---------------------------------------------------------------------------

describe('detectMemoryEdges — CONTEXT-ONLY seam contract', () => {
  function makeItem(over: Partial<MemoryItem>): MemoryItem {
    return {
      id: 'mem_x',
      kind: 'confirmed-outcome',
      claim: 'a claim',
      scope: 'repo',
      source: 'confirmed-outcome',
      evidence: [],
      confidence: 0.9,
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
      payload: null,
      signature: 'src/auth|x|',
      tags: null,
      ...over,
    };
  }

  function spyStore(items: MemoryItem[], linksByItem: Record<string, unknown[]>): MemoryStore {
    return {
      recall: vi.fn(),
      record: vi.fn(),
      loadScoped: vi.fn(),
      add: vi.fn(),
      get: vi.fn(),
      query: vi.fn(async () => items),
      setStatus: vi.fn(),
      setVisibility: vi.fn(),
      verify: vi.fn(),
      addLink: vi.fn(),
      removeLink: vi.fn(),
      links: vi.fn(async (id: string) => (linksByItem[id] ?? []) as never),
      history: vi.fn(),
    } as unknown as MemoryStore;
  }

  it('reads ONLY query+links and NEVER calls a write/scoring method', async () => {
    const a = makeItem({ id: 'mem_a' });
    const b = makeItem({ id: 'mem_b' });
    const store = spyStore([a, b], {
      mem_a: [{ rel: 'about-incident', toKind: 'incident', fromMemoryId: 'mem_a', toRef: 'inv_a' }],
      mem_b: [{ rel: 'about-incident', toKind: 'incident', fromMemoryId: 'mem_b', toRef: 'inv_b' }],
    });
    const deps: DetectMemoryDeps = {
      outcomeFor: async (id) => ({
        investigationId: id,
        resolved: 'yes',
        confirmedCause: id === 'inv_a' ? 'redis' : 'migration',
      }),
    };

    const edges = await detectMemoryEdges(store, { repo: 'r' }, deps);
    expect(edges.length).toBeGreaterThan(0); // it DID find conflicting context

    // READ seam only.
    expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ repo: 'r' }));
    expect(store.links).toHaveBeenCalled();
    // NO write / status / scoring methods — detection is edges-only + context-only.
    expect(store.add).not.toHaveBeenCalled();
    expect(store.addLink).not.toHaveBeenCalled();
    expect(store.removeLink).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(store.setVisibility).not.toHaveBeenCalled();
    expect(store.verify).not.toHaveBeenCalled();
  });
});
