/**
 * createLocalMemoryStore — drizzle/Postgres impl of the MemoryStore seam (M1, spec §6).
 *
 * Exercised against the embedded pglite db (as the @horus/db-backed tests do) so the bundled
 * EMBEDDED_MIGRATIONS supplying memory_item/_link/_audit are proven end-to-end. Covers CRUD, the
 * status lifecycle + audit trail, soft-forget reversibility, link create/traverse, and the §7
 * PII/secret + confirmed-outcome privacy gates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, type HorusDb, type NewMemoryItem } from '@horus/db';
import {
  createLocalMemoryStore,
  detectClaimSecret,
  MemorySecretError,
  MemoryCacheReadonlyError,
} from './memory.js';
import type { LocalMemoryStore, AuditCtx } from './memory-store.js';

const actor = { kind: 'user' as const, id: 'u1', name: 'Alice' };

describe('createLocalMemoryStore (embedded pglite)', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: LocalMemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-mem-store-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });

  // Pass a blank id so the store mints one (exercising genId); keeps call sites terse.
  const add = (item: Omit<NewMemoryItem, 'id'>, auditCtx: AuditCtx) =>
    store.add({ ...item, id: '' }, auditCtx);

  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('add: inserts, returns the row, defaults status/visibility, appends an `add` audit row', async () => {
    const item = await add(
      { kind: 'decision', claim: 'consumers must ack before processing', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor, note: 'created' },
    );
    expect(item.id).toMatch(/^mem_/);
    expect(item.status).toBe('fresh'); // default
    expect(item.visibility).toBe('private'); // default
    expect(item.evidence).toEqual([]); // jsonb default

    const back = await store.get(item.id);
    expect(back?.claim).toBe('consumers must ack before processing');

    const history = await store.history(item.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toBe('add');
    expect(history[0]!.toStatus).toBe('fresh');
    expect(history[0]!.actor).toEqual(actor);
    expect(history[0]!.note).toBe('created');
  }, 30_000);

  it('get: returns null for a missing id', async () => {
    expect(await store.get('mem_nope')).toBeNull();
  }, 30_000);

  it('query: filters by scope/status/visibility and is repo fail-closed (HOR-46)', async () => {
    const a = await add(
      { kind: 'code-fact', claim: 'alpha symbol fact', scope: 'symbol:Function:src/a.ts:f', source: 'derived', confidence: 0.5, repo: 'r' },
      { actor },
    );
    await add(
      { kind: 'decision', claim: 'repo wide decision', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' },
      { actor },
    );
    // Another repo — must never surface for repo 'r'.
    await add(
      { kind: 'decision', claim: 'other repo decision', scope: 'repo', source: 'human', confidence: 0.9, repo: 'other' },
      { actor },
    );

    expect((await store.query({ repo: 'r' }))).toHaveLength(2);
    expect((await store.query({ repo: 'r', scope: 'repo' }))).toHaveLength(1);
    expect((await store.query({ repo: 'other' })).map((i) => i.claim)).toEqual(['other repo decision']);

    // fail-closed: a blank repo identity sees nothing.
    expect(await store.query({ repo: '   ' })).toEqual([]);

    // status filter
    await store.setStatus(a.id, 'forgotten', { actor });
    expect((await store.query({ repo: 'r', status: ['fresh'] }))).toHaveLength(1);
    expect((await store.query({ repo: 'r', status: ['fresh', 'forgotten'] }))).toHaveLength(2);
  }, 30_000);

  it('setStatus + soft-forget: status flips, the row is retained and reversible, audit records from/to', async () => {
    const item = await add(
      { kind: 'pitfall', claim: 'beware retry storm', scope: 'repo', source: 'human', confidence: 0.7, repo: 'r' },
      { actor },
    );

    await store.setStatus(item.id, 'forgotten', { actor, note: 'no longer relevant' });
    const forgotten = await store.get(item.id);
    expect(forgotten).not.toBeNull(); // SOFT: row retained
    expect(forgotten!.status).toBe('forgotten');

    // reversible
    await store.setStatus(item.id, 'fresh', { actor });
    expect((await store.get(item.id))!.status).toBe('fresh');

    const history = await store.history(item.id);
    // most-recent-first: confirm(fresh) → forget → add
    expect(history.map((h) => h.action)).toEqual(['confirm', 'forget', 'add']);
    const forget = history.find((h) => h.action === 'forget')!;
    expect(forget.fromStatus).toBe('fresh');
    expect(forget.toStatus).toBe('forgotten');
    expect(forget.note).toBe('no longer relevant');
  }, 30_000);

  it('setStatus/verify/setVisibility throw for a missing id', async () => {
    await expect(store.setStatus('mem_x', 'pinned', { actor })).rejects.toThrow(/not found/);
    await expect(store.verify('mem_x', { lastVerifiedHash: 'h' }, { actor })).rejects.toThrow(/not found/);
    await expect(store.setVisibility('mem_x', 'team', { actor })).rejects.toThrow(/not found/);
  }, 30_000);

  it('verify: refreshes the staleness snapshot and resets possibly-stale -> fresh', async () => {
    const item = await add(
      { kind: 'code-fact', claim: 'f returns a promise', scope: 'symbol:Function:src/a.ts:f', source: 'derived', confidence: 0.6, repo: 'r' },
      { actor },
    );
    await store.setStatus(item.id, 'possibly-stale', { actor });

    await store.verify(item.id, { lastVerifiedHash: 'sha256:abc' }, { actor, note: 'rechecked' });
    const verified = await store.get(item.id);
    expect(verified!.status).toBe('fresh'); // possibly-stale -> fresh
    expect(verified!.lastVerifiedHash).toBe('sha256:abc');
    expect(verified!.lastVerifiedAt).toBeInstanceOf(Date);

    const verifyAudit = (await store.history(item.id)).find((h) => h.action === 'verify')!;
    expect(verifyAudit.fromStatus).toBe('possibly-stale');
    expect(verifyAudit.toStatus).toBe('fresh');
  }, 30_000);

  it('verify: leaves a pinned item pinned (does not resurrect non-stale statuses)', async () => {
    const item = await add(
      { kind: 'decision', claim: 'keep this pinned', scope: 'repo', source: 'human', confidence: 0.9, repo: 'r' },
      { actor },
    );
    await store.setStatus(item.id, 'pinned', { actor });
    await store.verify(item.id, { lastVerifiedHash: 'h2' }, { actor });
    expect((await store.get(item.id))!.status).toBe('pinned');
  }, 30_000);

  it('setVisibility: updates visibility and audits the change', async () => {
    const item = await add(
      { kind: 'decision', claim: 'shareable decision', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor },
    );
    await store.setVisibility(item.id, 'team', { actor });
    expect((await store.get(item.id))!.visibility).toBe('team');
    expect((await store.history(item.id)).some((h) => h.action === 'set-visibility')).toBe(true);
  }, 30_000);

  it('privacy gate: add rejects an obvious secret in the claim (spec §7)', async () => {
    await expect(
      add(
        { kind: 'pitfall', claim: 'the api_key=sk_live_supersecretvalue must be rotated', scope: 'repo', source: 'human', confidence: 0.5, repo: 'r' },
        { actor },
      ),
    ).rejects.toBeInstanceOf(MemorySecretError);

    // nothing persisted
    expect(await store.query({ repo: 'r' })).toEqual([]);
  }, 30_000);

  it('privacy gate: confirmed-outcome is forced to private even if team is requested', async () => {
    const item = await add(
      { kind: 'confirmed-outcome', claim: 'root cause was a missing index', scope: 'repo', source: 'confirmed-outcome', confidence: 0.9, repo: 'r', visibility: 'team' },
      { actor },
    );
    expect(item.visibility).toBe('private'); // never auto-team
  }, 30_000);

  it('detectClaimSecret: flags credentials, passes clean prose', () => {
    expect(detectClaimSecret('plain decision about queue acking')).toBeNull();
    expect(detectClaimSecret('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')).toBe('private-key');
    expect(detectClaimSecret('AKIAABCDEFGHIJKLMNOP')).toBe('aws-key');
    expect(detectClaimSecret('Authorization: Bearer abc.def.ghi')).toBe('auth-header');
  });

  it('links: creates, restricts to M1 rels, and traverses with a rel filter', async () => {
    const item = await add(
      { kind: 'code-fact', claim: 'consume acks the message', scope: 'symbol:Function:src/queue.ts:consume', source: 'derived', confidence: 0.6, repo: 'r' },
      { actor },
    );
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'about-symbol', toKind: 'node', toRef: 'Function:src/queue.ts:consume', toFilePath: 'src/queue.ts' });
    await store.addLink({ id: '', fromMemoryId: item.id, rel: 'has-evidence', toKind: 'evidence', toRef: 'ev_123' });

    const all = await store.links(item.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.id).toMatch(/^lnk_/);

    const onlySymbol = await store.links(item.id, { rels: ['about-symbol'] });
    expect(onlySymbol).toHaveLength(1);
    expect(onlySymbol[0]!.toFilePath).toBe('src/queue.ts');

    // A memory rel with the wrong toKind is rejected at the store boundary (memory rels require
    // toKind:'memory'). The memory→memory graph itself is covered in memory-link-graph.test.ts.
    await expect(
      store.addLink({ id: '', fromMemoryId: item.id, rel: 'supersedes', toKind: 'node', toRef: 'mem_other' }),
    ).rejects.toThrow(/unsupported memory_link rel/);
  }, 30_000);

  // ---- HOR-464 / M4: disposable team-memory read-cache ----

  const cacheItem = (over: Partial<NewMemoryItem> = {}): NewMemoryItem => ({
    id: 'mem_team_1',
    kind: 'decision',
    claim: 'team: register blueprints before first request',
    scope: 'repo',
    source: 'human',
    confidence: 0.6,
    repo: 'r',
    visibility: 'team',
    cloudId: 'cloud-uuid-1',
    authorName: 'Bob',
    ...over,
  });

  it('upsertCached: inserts then overwrites scalar+provenance and stamps origin=cloud', async () => {
    const first = await store.upsertCached(cacheItem(), { actor });
    expect(first.origin).toBe('cloud');
    expect(first.visibility).toBe('team');
    expect(first.cloudId).toBe('cloud-uuid-1');
    expect(first.authorName).toBe('Bob');
    expect(first.pulledAt).toBeInstanceOf(Date);
    expect(first.confidence).toBeCloseTo(0.6);

    // Upsert-on-id: a refresh overwrites the SAME row in place (never a duplicate).
    const second = await store.upsertCached(
      cacheItem({ claim: 'team: updated claim', confidence: 0.9, authorName: 'Carol' }),
      { actor },
    );
    expect(second.id).toBe(first.id);
    expect(second.claim).toBe('team: updated claim');
    expect(second.confidence).toBeCloseTo(0.9);
    expect(second.authorName).toBe('Carol');
    expect(second.origin).toBe('cloud');

    expect(await store.query({ repo: 'r' })).toHaveLength(1); // one row, overwritten in place
  }, 30_000);

  it('upsertCached: re-pulling into a different repo re-scopes the cache row to that repo', async () => {
    // A team item's id is stable across the workspace; pulling it from repo `r` then repo `r2`
    // must move the disposable cache row to the repo being pulled — so "pull here" shows it here.
    const first = await store.upsertCached(cacheItem({ repo: 'r' }), { actor });
    expect(await store.query({ repo: 'r' })).toHaveLength(1);

    const moved = await store.upsertCached(cacheItem({ repo: 'r2' }), { actor });
    expect(moved.id).toBe(first.id); // same row (same id)
    expect(moved.repo).toBe('r2');
    expect(await store.query({ repo: 'r2' })).toHaveLength(1); // now visible in r2
    expect(await store.query({ repo: 'r' })).toHaveLength(0); // and no longer in r (single row moved)
  }, 30_000);

  it('upsertCached: appends exactly one `pulled` audit row per refresh (not a replayed trail)', async () => {
    const row = await store.upsertCached(cacheItem(), { actor, note: 'memory pull' });
    const history = await store.history(row.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toBe('pulled');
    expect(history[0]!.toStatus).toBe('fresh');
    expect(history[0]!.note).toBe('memory pull');
  }, 30_000);

  it('reconcileCache: deletes only stale origin=cloud rows and never origin=local rows', async () => {
    // One locally-authored row + two cloud-cache rows.
    const local = await add(
      { kind: 'decision', claim: 'local authored', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor },
    );
    await store.upsertCached(cacheItem({ id: 'mem_keep', cloudId: 'c-keep' }), { actor });
    await store.upsertCached(cacheItem({ id: 'mem_stale', cloudId: 'c-stale' }), { actor });

    // The latest pull returned only `mem_keep`.
    const removed = await store.reconcileCache('r', ['mem_keep']);
    expect(removed).toBe(1);

    const ids = (await store.query({ repo: 'r' })).map((i) => i.id).sort();
    expect(ids).toEqual(['mem_keep', local.id].sort()); // stale cloud row gone; local row untouched
  }, 30_000);

  it('reconcileCache: an empty keep set drops every cloud row but keeps local rows', async () => {
    const local = await add(
      { kind: 'decision', claim: 'local authored', scope: 'repo', source: 'human', confidence: 0.8, repo: 'r' },
      { actor },
    );
    await store.upsertCached(cacheItem({ id: 'mem_c1', cloudId: 'c1' }), { actor });
    await store.upsertCached(cacheItem({ id: 'mem_c2', cloudId: 'c2' }), { actor });

    const removed = await store.reconcileCache('r', []);
    expect(removed).toBe(2);
    expect((await store.query({ repo: 'r' })).map((i) => i.id)).toEqual([local.id]);
  }, 30_000);

  it('setStatus/setVisibility/update throw MemoryCacheReadonlyError on an origin=cloud row', async () => {
    const row = await store.upsertCached(cacheItem(), { actor });
    await expect(store.setStatus(row.id, 'pinned', { actor })).rejects.toBeInstanceOf(
      MemoryCacheReadonlyError,
    );
    await expect(store.setVisibility(row.id, 'private', { actor })).rejects.toBeInstanceOf(
      MemoryCacheReadonlyError,
    );
    await expect(store.update(row.id, { claim: 'hijack' }, { audit: { actor } })).rejects.toBeInstanceOf(
      MemoryCacheReadonlyError,
    );
    // The row is unchanged after the rejected mutations.
    const back = await store.get(row.id);
    expect(back!.status).toBe('fresh');
    expect(back!.visibility).toBe('team');
  }, 30_000);

  it('markPromoted: flips a local row to a server-owned team item with a single `promote` audit', async () => {
    const local = await add(
      { kind: 'pitfall', claim: 'promote me', scope: 'repo', source: 'human', confidence: 0.7, repo: 'r' },
      { actor },
    );
    const promoted = await store.markPromoted(local.id, { cloudId: 'cloud-9', authorName: 'Alice' }, { actor });
    expect(promoted.visibility).toBe('team');
    expect(promoted.origin).toBe('cloud');
    expect(promoted.cloudId).toBe('cloud-9');

    const actions = (await store.history(local.id)).map((h) => h.action);
    expect(actions).toEqual(['promote', 'add']); // one promote row on top of the original add

    // Post-promote the row is server-owned → local mutation is refused.
    await expect(store.setStatus(local.id, 'forgotten', { actor })).rejects.toBeInstanceOf(
      MemoryCacheReadonlyError,
    );
  }, 30_000);
});
