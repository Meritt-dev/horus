import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalDb,
  memoryItem,
  investigations,
  incidentMemory,
  memorySyncOutbox,
  eq,
  type DbHandle,
} from '@horus/db';
import { createLocalMemoryStore } from '@horus/engine';
import { synchronizeMemory, restoreMemoryReport, type MemorySyncContext } from './memory-sync.js';
import type { CloudClient, MemoryItemRecord, MemorySyncResult } from './api.js';

const paths: string[] = [];
const handles: DbHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.sql.end();
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
}, 30_000);
const open = async () => {
  const path = await mkdtemp(join(tmpdir(), 'horus-memory-sync-'));
  paths.push(path);
  const h = await createLocalDb({ path: join(path, 'db') });
  handles.push(h);
  return h;
};
const audit = { actor: { kind: 'user' as const } };
it('refreshes restored report annotations on demand without overwriting local reports or duplicating history', async () => {
  const h = await open();
  const remote = cloud();
  const id = 'c2de50b7-267f-4b93-85c8-ef0b906c7b3e';
  let report = {
    id, input: { repo: 'first-machine', hint: 'incident' },
    evidence: [{ id: 'ev1' }], hypotheses: [], seeds: [],
    timeline: { boundaryCrossings: [] }, summary: 'engine report', confidence: 0.3,
    createdAt: '2026-09-21T00:00:00.000Z',
  } as unknown as import('@horus/engine').InvestigationReport;
  const get = vi.fn(async () => ({}));
  const evidence = vi.fn(async () => [{
    source: 'cli', createdAt: new Date().toISOString(),
    payload: { kind: 'horus:report', report },
  }]);
  Object.assign(remote.ctx.client, { getInvestigation: get, listEvidence: evidence });
  await h.db.insert(memoryItem).values({
    id: 'memory-with-report', kind: 'investigation', source: 'investigation',
    scope: 'repo', claim: 'incident', repo: remote.ctx.repo, confidence: 0.3,
    syncScope: remote.ctx.scope, payload: { reportRefs: { [id]: 'cloud-report' } },
  });
  expect((await restoreMemoryReport(h.db, remote.ctx, id))?.aiJudgment).toBeUndefined();
  report = { ...report, aiJudgment: {
    what: 'completed interpretation', why: 'uncertain', whereNext: ['check state'],
    citations: [{ evidenceId: 'ev1' }], confidence: 0.3,
    provider: 'local Claude Code / claude-opus-5-5', generatedAt: new Date().toISOString(),
  } };
  const refreshed = await restoreMemoryReport(h.db, remote.ctx, id);
  expect(refreshed?.aiJudgment?.citations).toEqual([{ evidenceId: 'ev1' }]);
  expect(refreshed?.input.repo).toBe(remote.ctx.repo);
  expect(refreshed?.input).not.toHaveProperty('_horusCloudScope');
  expect(await h.db.select().from(incidentMemory)).toHaveLength(1);
  expect((await h.db.select().from(investigations))[0]?.createdAt.toISOString())
    .toBe('2026-09-21T00:00:00.000Z');
  get.mockRejectedValueOnce(new Error('offline'));
  expect((await restoreMemoryReport(h.db, remote.ctx, id))?.aiJudgment).toEqual(report.aiJudgment);
  const calls = get.mock.calls.length;
  expect(await restoreMemoryReport(h.db, { ...remote.ctx, scope: 'other-account' }, id)).toBeNull();
  expect(get).toHaveBeenCalledTimes(calls);
  const localId = '09a2d40d-c226-47d3-b0c6-a8e685f04e4d';
  await h.db.insert(investigations).values({
    id: localId, title: 'local draft', project: remote.ctx.repo,
    incidentInput: {}, report: { ...report, summary: 'unsynced local work' },
  });
  expect((await restoreMemoryReport(h.db, remote.ctx, localId))?.summary)
    .toBe('unsynced local work');
  expect(get).toHaveBeenCalledTimes(calls);
}, 30_000);
function cloud() {
  let revision = 0;
  let unavailable = false;
  let loseResponse = false;
  const rows = new Map<string, MemoryItemRecord>();
  const receipts = new Map<string, MemorySyncResult>();
  const client = {
    listTeamMemorySince: vi.fn(async () => ({
      items: [],
      hasMore: false,
      nextCursor: null,
    })),
    listMemoryItems: vi.fn(async (_: string, q: { afterRevision: string }) => {
      if (unavailable) throw new Error('offline');
      const items = [...rows.values()].filter(
        (r) => Number(r.revision) > Number(q.afterRevision),
      );
      return { items, nextRevision: String(revision), hasMore: false };
    }),
    syncMemoryItems: vi.fn(
      async (_: string, body: Parameters<CloudClient['syncMemoryItems']>[1]) => {
        if (unavailable) throw new Error('offline');
        const op = body.operation!;
        if (receipts.has(op.id)) return receipts.get(op.id)!;
        const item = body.items![0]!;
        const old = rows.get(item.clientId);
        if (op.baseRevision !== (old?.revision ?? '0'))
          return {
            conflict: {
              reason: 'Concurrent correction',
              currentRevision: old!.revision!,
            },
          };
        const rev = String(++revision);
        rows.set(item.clientId, {
          ...item,
          id: 'cloud-id',
          organizationId: 'org',
          workspaceId: 'workspace',
          projectId: 'project',
          createdByUserId: 'owner',
          revision: rev,
          record: item.record,
          createdAt: new Date().toISOString(),
          links: body.links?.map((l) => ({ ...l, createdAt: new Date().toISOString() })),
          audit: body.audit?.map((a) => ({ ...a, detail: { note: a.note } })),
        } as MemoryItemRecord);
        const result = {
          operationId: op.id,
          revision: rev,
          idMap: { [item.clientId]: 'cloud-id' },
        };
        receipts.set(op.id, result);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('response lost');
        }
        return result;
      },
    ),
  } as unknown as CloudClient;
  const ctx: MemorySyncContext = {
    client,
    scope: 'stable-account-project',
    userId: 'owner',
    repo: 'checkout-one',
    config: {
      context: 'cloud',
      organization: { id: 'org', slug: 'org' },
      workspace: { id: 'workspace', slug: 'workspace' },
      project: { id: 'project', slug: 'project' },
    },
  };
  return {
    ctx,
    rows,
    receipts,
    offline: (v: boolean) => {
      unavailable = v;
    },
    lose: () => {
      loseResponse = true;
    },
  };
}

it('two independent profiles restore an editable private replica and propagate updates/tombstones', async () => {
  const a = await open();
  const b = await open();
  const remote = cloud();
  const first = createLocalMemoryStore(a.db);
  const second = createLocalMemoryStore(b.db);
  const created = await first.add(
    {
      id: 'mem-1',
      kind: 'investigation',
      source: 'investigation',
      scope: 'repo',
      claim: 'EMODA reserve timeout',
      repo: remote.ctx.repo,
      confidence: 0.3,
      createdAt: new Date('2025-01-01'),
      signature: 'reserve',
      tags: ['emoda', 'etimedout'],
      payload: { recurrenceCount: 9, embedding: [1, 2, 3], outcome: {
        disposition: 'unknown', certainty: 'inferred', sourceInvestigation: 'incident', sourceRefs: [],
        applicability: { source: 'elasticsearch', eventId: 'logs:event-a' },
        invalidatingConditions: [], checks: [],
      } },
    },
    audit,
  );
  await first.addLink({
    id: 'l1',
    fromMemoryId: created.id,
    rel: 'about-file',
    toKind: 'node',
    toRef: 'reserve.ts',
  });
  expect((await synchronizeMemory(a.db, remote.ctx)).state).toBe('Synced');
  expect(remote.rows.get(created.id)!.record).not.toHaveProperty('embedding');
  const otherCtx = { ...remote.ctx, repo: 'a-completely-different-checkout' };
  expect((await synchronizeMemory(b.db, otherCtx)).state).toBe('Synced');
  expect(await second.get(created.id)).toMatchObject({
    repo: otherCtx.repo,
    origin: 'local',
    confidence: 0.3,
    payload: { recurrenceCount: 9, outcome: { applicability: { source: 'elasticsearch', eventId: 'logs:event-a' } } },
  });
  expect(await second.links(created.id)).toHaveLength(1);
  await second.update(created.id, { claim: 'Corrected after upstream check' }, { audit });
  expect((await synchronizeMemory(b.db, otherCtx)).state).toBe('Synced');
  await synchronizeMemory(a.db, remote.ctx);
  expect((await first.get(created.id))!.claim).toBe('Corrected after upstream check');
  await second.setStatus(created.id, 'forgotten', audit);
  await synchronizeMemory(b.db, otherCtx);
  await synchronizeMemory(a.db, remote.ctx);
  expect((await first.get(created.id))!.status).toBe('forgotten');
}, 30_000);

it('bounded batches advance past acknowledged items instead of starving later changes', async () => {
  const a = await open();
  const remote = cloud();
  const store = createLocalMemoryStore(a.db);
  for (const id of ['first', 'second'])
    await store.add(
      {
        id,
        kind: 'decision',
        source: 'human',
        scope: 'repo',
        claim: id,
        confidence: 0.5,
        repo: remote.ctx.repo,
      },
      audit,
    );
  expect((await synchronizeMemory(a.db, remote.ctx, { limit: 1 })).pending).toBe(1);
  expect((await synchronizeMemory(a.db, remote.ctx, { limit: 1 })).state).toBe('Synced');
  expect(remote.rows.size).toBe(2);
}, 30_000);

it('durable dirty generation survives restart and retries the same lost acknowledgement operation', async () => {
  let a = await open();
  const remote = cloud();
  await createLocalMemoryStore(a.db).add(
    {
      id: 'offline',
      kind: 'decision',
      source: 'human',
      scope: 'repo',
      claim: 'Keep reserve checks read-only',
      repo: remote.ctx.repo,
      confidence: 0.5,
    },
    audit,
  );
  remote.offline(true);
  expect((await synchronizeMemory(a.db, remote.ctx)).pending).toBe(1);
  const path = join(paths[0]!, 'db');
  await a.sql.end();
  handles.splice(handles.indexOf(a), 1);
  a = await createLocalDb({ path });
  handles.push(a);
  remote.offline(false);
  remote.lose();
  expect((await synchronizeMemory(a.db, remote.ctx)).state).toBe('Pending sync');
  const [pending] = await a.db.select().from(memorySyncOutbox);
  expect(pending?.attempts).toBe(1);
  await a.db
    .update(memorySyncOutbox)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(memorySyncOutbox.id, pending!.id));
  expect((await synchronizeMemory(a.db, remote.ctx)).state).toBe('Synced');
  expect(remote.receipts.size).toBe(1);
  expect(remote.rows.size).toBe(1);
  expect(await a.db.select().from(memorySyncOutbox)).toHaveLength(0);
}, 30_000);

it('keeps a concurrent correction pending instead of overwriting it and isolates another account', async () => {
  const a = await open();
  const b = await open();
  const remote = cloud();
  const first = createLocalMemoryStore(a.db);
  const second = createLocalMemoryStore(b.db);
  await first.add(
    {
      id: 'm',
      kind: 'decision',
      source: 'human',
      scope: 'repo',
      claim: 'original',
      repo: remote.ctx.repo,
      confidence: 0.5,
    },
    audit,
  );
  await synchronizeMemory(a.db, remote.ctx);
  await synchronizeMemory(b.db, remote.ctx);
  await first.update('m', { claim: 'A correction' }, { audit });
  await second.update('m', { claim: 'B correction' }, { audit });
  await synchronizeMemory(a.db, remote.ctx);
  const result = await synchronizeMemory(b.db, remote.ctx);
  expect(result.failed).toBe(1);
  expect(result.error).toContain('Concurrent correction');
  expect((await second.get('m'))!.claim).toBe('B correction');
  const otherAccount = { ...remote.ctx, scope: 'different-account', userId: 'different' };
  expect((await synchronizeMemory(b.db, otherAccount)).error).toContain('scope');
  expect((await b.db.select().from(memoryItem))[0]!.syncScope).toBe(remote.ctx.scope);
}, 30_000);

it('startup status counts eligible legacy reports without backfilling incomplete reports', async () => {
  const h = await open();
  const remote = cloud();
  const reports = [null, {}, { input: { hint: 'legacy incident' }, hypotheses: [] },
    { input: { hint: '' }, hypotheses: [] }, { input: { hint: 'incomplete' }, hypotheses: {} }];
  for (const report of reports) await h.db.insert(investigations).values({
    title: 'saved report', project: remote.ctx.repo, incidentInput: {}, report,
  });
  const result = await synchronizeMemory(h.db, remote.ctx, { pullOnly: true });
  expect(result.state).toBe('Pending sync');
  expect(result.backfill).toEqual({ eligible: 1, indexed: 0, pending: 1, excluded: 4 });
  expect(await h.db.select().from(memoryItem)).toHaveLength(0);
}, 30_000);
