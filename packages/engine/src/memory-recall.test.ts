/**
 * recallMemory — deterministic recall + read-time freshness (M1, spec §4 + §5 + §8).
 *
 * Covers the three load-bearing behaviours of the read path:
 *   - freshness-decay derived at READ time from `lastVerifiedAt` age (pure, no DB);
 *   - stale-on-mismatch: a pull re-hash of an `about-symbol` link downgrades a changed-underneath
 *     item to `possibly-stale` for DISPLAY (and pinned surfaces drift WITHOUT flipping status);
 *   - status filtering: hidden statuses are dropped by default, an explicit allow-list opts in.
 *
 * The DB-backed cases run against embedded pglite (as the store tests do) so the seam + links work
 * end-to-end. The honesty invariant is structural: `recallMemory` lives outside the scoring path and
 * the read-time downgrade is never persisted (asserted below).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, type HorusDb, type MemoryItem, type NewMemoryItem } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import type { LocalMemoryStore, AuditCtx } from './memory-store.js';
import {
  recallMemory,
  deriveFreshness,
  hashNodeContent,
  FRESHNESS_HALF_LIFE_DAYS,
  type RecallCodeProvider,
} from './memory-recall.js';

const actor: AuditCtx['actor'] = { kind: 'user', id: 'u1', name: 'Alice' };

// A complete MemoryItem literal for the pure (DB-free) freshness tests.
function makeItem(p: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'mem_1',
    kind: 'decision',
    claim: 'a claim',
    scope: 'repo',
    source: 'human',
    evidence: [],
    confidence: 0.8,
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
    signature: null,
    tags: null,
    ...p,
  };
}

const NOW = new Date('2026-06-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Pure: read-time freshness-decay
// ---------------------------------------------------------------------------

describe('deriveFreshness (read-time decay)', () => {
  it('decay is ~1 right after verification and halves every half-life', () => {
    const justVerified = makeItem({ lastVerifiedAt: NOW });
    const f0 = deriveFreshness(justVerified, NOW, FRESHNESS_HALF_LIFE_DAYS, 'fresh', false);
    expect(f0.ageDays).toBe(0);
    expect(f0.verified).toBe(true);
    expect(f0.decay).toBeCloseTo(1, 5);
    expect(f0.label).toBe('fresh');

    const oneHalfLife = new Date(NOW.getTime() - FRESHNESS_HALF_LIFE_DAYS * 86_400_000);
    const aged = makeItem({ lastVerifiedAt: oneHalfLife });
    const f1 = deriveFreshness(aged, NOW, FRESHNESS_HALF_LIFE_DAYS, 'fresh', false);
    expect(f1.ageDays).toBeCloseTo(FRESHNESS_HALF_LIFE_DAYS, 5);
    expect(f1.decay).toBeCloseTo(0.5, 5);

    const twoHalfLives = new Date(NOW.getTime() - 2 * FRESHNESS_HALF_LIFE_DAYS * 86_400_000);
    const older = makeItem({ lastVerifiedAt: twoHalfLives });
    const f2 = deriveFreshness(older, NOW, FRESHNESS_HALF_LIFE_DAYS, 'fresh', false);
    expect(f2.decay).toBeCloseTo(0.25, 5);
  });

  it('ages from createdAt when never verified, and labels it `unverified` only if no anchor', () => {
    // Never verified but created 10 days ago → ages from createdAt, label by age (recent).
    const created = new Date(NOW.getTime() - 10 * 86_400_000);
    const f = deriveFreshness(makeItem({ createdAt: created }), NOW, FRESHNESS_HALF_LIFE_DAYS, 'fresh', false);
    expect(f.verified).toBe(false);
    expect(f.ageDays).toBeCloseTo(10, 5);
    expect(f.decay).toBeLessThan(1);
    expect(f.label).toBe('recent');
  });

  it('labels track age bands and the effective status wins for pinned/possibly-stale', () => {
    const ageDaysBack = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
    expect(deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(3) }), NOW, 30, 'fresh', false).label).toBe('fresh');
    expect(deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(20) }), NOW, 30, 'fresh', false).label).toBe('recent');
    expect(deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(60) }), NOW, 30, 'fresh', false).label).toBe('aging');
    expect(deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(200) }), NOW, 30, 'fresh', false).label).toBe('stale');
    // Effective status overrides the age band for display.
    expect(deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(3) }), NOW, 30, 'pinned', false).label).toBe('pinned');
    expect(
      deriveFreshness(makeItem({ lastVerifiedAt: ageDaysBack(3) }), NOW, 30, 'possibly-stale', true).label,
    ).toBe('possibly-stale');
  });
});

// ---------------------------------------------------------------------------
// DB-backed: status filtering + stale-on-mismatch pull re-hash
// ---------------------------------------------------------------------------

describe('recallMemory (embedded pglite)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: LocalMemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-recall-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });

  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (item: Omit<NewMemoryItem, 'id'>) => store.add({ ...item, id: '' }, { actor });

  it('fails closed on a blank repo (HOR-46)', async () => {
    await add({ kind: 'decision', claim: 'x', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });
    expect(await recallMemory(store, { repo: '   ' })).toEqual([]);
  }, 30_000);

  it('status filtering: hides forgotten/deprecated/contradicted by default; allow-list opts in', async () => {
    const fresh = await add({ kind: 'decision', claim: 'fresh one', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });
    const stale = await add({ kind: 'decision', claim: 'stale one', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });
    const forgotten = await add({ kind: 'decision', claim: 'gone', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });
    const deprecated = await add({ kind: 'decision', claim: 'old', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });
    const contradicted = await add({ kind: 'decision', claim: 'wrong', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' });

    await store.setStatus(stale.id, 'possibly-stale', { actor });
    await store.setStatus(forgotten.id, 'forgotten', { actor });
    await store.setStatus(deprecated.id, 'deprecated', { actor });
    await store.setStatus(contradicted.id, 'contradicted', { actor });

    // Default recall: fresh + possibly-stale survive; the three hidden statuses are dropped.
    const ids = (await recallMemory(store, { repo: 'r' }, { now: NOW })).map((r) => r.item.id);
    expect(new Set(ids)).toEqual(new Set([fresh.id, stale.id]));

    // Explicit allow-list opts the hidden status back in.
    const forgottenOnly = await recallMemory(store, { repo: 'r', status: ['forgotten'] }, { now: NOW });
    expect(forgottenOnly.map((r) => r.item.id)).toEqual([forgotten.id]);
  }, 30_000);

  it('possibly-stale is downranked below an equally-confident fresh item, never hidden', async () => {
    const a = await add({ kind: 'decision', claim: 'alpha', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' });
    const b = await add({ kind: 'decision', claim: 'beta', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' });
    await store.setStatus(b.id, 'possibly-stale', { actor });

    const out = await recallMemory(store, { repo: 'r' }, { now: NOW });
    expect(out.map((r) => r.item.id)).toEqual([a.id, b.id]);
    expect(out[1]!.rank).toBeLessThan(out[0]!.rank);
  }, 30_000);

  it('stale-on-mismatch: a changed symbol downgrades the item to possibly-stale for DISPLAY only', async () => {
    const item = await add({
      kind: 'code-fact',
      claim: 'f guards the queue ack',
      scope: 'symbol:Function:src/a.ts:f',
      source: 'derived',
      confidence: 0.9,
      repo: 'r',
    });
    const nodeId = 'Function:src/a.ts:f';
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'about-symbol', toKind: 'node', toRef: nodeId, toFilePath: 'src/a.ts' });

    // Snapshot the hash of the ORIGINAL content at verify time.
    const original = 'function f() { ack(); }';
    await store.verify(item.id, { lastVerifiedHash: hashNodeContent(original) }, { actor });

    // (a) content unchanged → stays fresh, no drift.
    const unchanged: RecallCodeProvider = { getNodeContent: async () => original };
    const same = await recallMemory(store, { repo: 'r' }, { now: NOW, code: unchanged });
    expect(same[0]!.freshness.status).toBe('fresh');
    expect(same[0]!.freshness.driftDetected).toBe(false);

    // (b) content changed underneath → downgraded to possibly-stale + driftDetected.
    const changed: RecallCodeProvider = { getNodeContent: async () => 'function f() { /* no ack */ }' };
    const drifted = await recallMemory(store, { repo: 'r' }, { now: NOW, code: changed });
    expect(drifted[0]!.freshness.status).toBe('possibly-stale');
    expect(drifted[0]!.freshness.driftDetected).toBe(true);

    // The downgrade is DISPLAY-ONLY — the STORED status is untouched (no setStatus write).
    expect((await store.get(item.id))!.status).toBe('fresh');
  }, 30_000);

  it('pinned item surfaces driftDetected but is NEVER auto-flipped (spec §5/§8)', async () => {
    const item = await add({
      kind: 'code-fact',
      claim: 'pinned fact about g',
      scope: 'symbol:Function:src/b.ts:g',
      source: 'human',
      confidence: 0.9,
      repo: 'r',
    });
    const nodeId = 'Function:src/b.ts:g';
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'about-symbol', toKind: 'node', toRef: nodeId, toFilePath: 'src/b.ts' });
    await store.verify(item.id, { lastVerifiedHash: hashNodeContent('orig') }, { actor });
    await store.setStatus(item.id, 'pinned', { actor });

    const changed: RecallCodeProvider = { getNodeContent: async () => 'changed' };
    const out = await recallMemory(store, { repo: 'r' }, { now: NOW, code: changed });
    expect(out[0]!.freshness.status).toBe('pinned'); // not flipped
    expect(out[0]!.freshness.driftDetected).toBe(true); // but drift IS surfaced
    expect((await store.get(item.id))!.status).toBe('pinned');
  }, 30_000);

  it('no drift asserted when there is no baseline hash or the node is unresolved', async () => {
    // No baseline hash (never verified) → never claims drift.
    const noHash = await add({ kind: 'code-fact', claim: 'unverified', scope: 'symbol:Function:src/c.ts:h', source: 'derived', confidence: 0.7, repo: 'r' });
    await store.addLink({ id: '', fromMemoryId: noHash.id, rel: 'about-symbol', toKind: 'node', toRef: 'Function:src/c.ts:h', toFilePath: 'src/c.ts' });
    const anyContent: RecallCodeProvider = { getNodeContent: async () => 'whatever' };
    const out1 = await recallMemory(store, { repo: 'r' }, { now: NOW, code: anyContent });
    expect(out1[0]!.freshness.driftDetected).toBe(false);
    expect(out1[0]!.freshness.label).toBe('fresh'); // verified-at null but created just now → ages from createdAt

    // Verified, but the node no longer resolves (renamed/host down) → skip, do not assert drift.
    await store.verify(noHash.id, { lastVerifiedHash: hashNodeContent('orig') }, { actor });
    const unresolved: RecallCodeProvider = { getNodeContent: async () => null };
    const out2 = await recallMemory(store, { repo: 'r' }, { now: NOW, code: unresolved });
    expect(out2[0]!.freshness.driftDetected).toBe(false);
    expect(out2[0]!.freshness.status).toBe('fresh');
  }, 30_000);

  // ---- HOR-464 / M4: merged local + cloud-cache recall + teammate attribution ----

  const cache = (over: Partial<NewMemoryItem>) =>
    store.upsertCached(
      {
        id: 'mem_c',
        kind: 'decision',
        claim: 'team claim',
        scope: 'repo',
        source: 'human',
        confidence: 0.8,
        repo: 'r',
        visibility: 'team',
        cloudId: 'cloud-1',
        authorName: 'Bob',
        ...over,
      },
      { actor: { kind: 'system' } },
    );

  it('recall merges local-private and cloud-cache rows from one query', async () => {
    const localRow = await add({ kind: 'decision', claim: 'local one', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' });
    const cached = await cache({ id: 'mem_team', claim: 'team one' });

    const out = await recallMemory(store, { repo: 'r' }, { now: NOW });
    const ids = new Set(out.map((r) => r.item.id));
    expect(ids).toEqual(new Set([localRow.id, cached.id]));
  }, 30_000);

  it('a pulled item ranks by its OWN confidence, not 0 (server must persist confidence)', async () => {
    await add({ kind: 'decision', claim: 'weak local', scope: 'repo', source: 'human', confidence: 0.2, repo: 'r' });
    const strong = await cache({ id: 'mem_strong', claim: 'strong team', confidence: 0.95 });

    const out = await recallMemory(store, { repo: 'r' }, { now: NOW });
    // The high-confidence pulled item outranks the weak local one — proof its confidence survives.
    expect(out[0]!.item.id).toBe(strong.id);
    expect(out[0]!.rank).toBeGreaterThan(0);
  }, 30_000);

  it('authorName attribution is present but DOES NOT change rank/order (honesty invariant)', async () => {
    // Two equally-confident items: one local (no author), one cloud (attributed). Order must be the
    // deterministic tie-break (by id), NOT influenced by the presence of an author name.
    const localRow = await add({ kind: 'decision', claim: 'aaa local', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' });
    const cached = await cache({ id: 'zzz_team', claim: 'zzz team', confidence: 0.8, authorName: 'Bob' });

    const out = await recallMemory(store, { repo: 'r' }, { now: NOW });
    // Attribution surfaces on the cached row…
    const cachedOut = out.find((r) => r.item.id === cached.id)!;
    expect(cachedOut.item.authorName).toBe('Bob');
    expect(cachedOut.item.origin).toBe('cloud');
    const localOut = out.find((r) => r.item.id === localRow.id)!;
    expect(localOut.item.authorName).toBeNull();
    // …but ranks are identical (author never feeds the score).
    expect(cachedOut.rank).toBeCloseTo(localOut.rank);
  }, 30_000);
});
