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
  memorySyncReplica,
  eq,
  type DbHandle,
} from '@horus/db';
import { createLocalMemoryStore } from '@horus/engine';
import { synchronizeMemory, restoreMemoryReport, type MemorySyncContext } from './memory-sync.js';
import type { CloudClient, MemoryItemRecord, MemorySyncResult } from './api.js';
import * as investigationSync from './investigation-sync.js';

const paths: string[] = [];
const handles: DbHandle[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

it('isolates unreadable history, backfills later readable reports, and retries after recovery', async () => {
  const h = await open();
  const remote = cloud();
  const broken = '93760717-00f9-4811-8b9b-46211f0773a7';
  const good = '93f60d4c-a63d-4b6b-8ee9-c4dcdc22533f';
  for (const id of [broken, good]) await h.db.insert(investigations).values({
    id, title: 'saved incident', project: remote.ctx.repo, incidentInput: {},
    createdAt: new Date('2025-01-01'), report: {
      id, input: { repo: remote.ctx.repo, hint: 'saved incident' },
      seeds: [], evidence: [], hypotheses: [], timeline: { boundaryCrossings: [] },
      summary: 'unconfirmed', confidence: 0.3,
    },
  });
  await h.db.insert(investigations).values({
    title: 'incomplete', project: remote.ctx.repo, incidentInput: {}, report: {},
  });
  await h.db.insert(investigations).values({
    title: 'other project', project: 'other', incidentInput: {}, report: {},
  });
  // Hosted CI: simulate the observed payload-read failure, preserving real PGlite writes/queries.
  const client = (h.db as unknown as { $client: {
    query(sql: string, params?: unknown[], options?: unknown): Promise<unknown>;
  } }).$client;
  const query = client.query.bind(client);
  const fault = vi.spyOn(client, 'query').mockImplementation(async (...args) => {
    if (args[0].includes('jsonb_typeof') &&
      (!args[0].includes(' in (') || args[1]?.includes(broken)))
      throw new Error('unreadable report payload');
    return query(...args);
  });
  const before = await synchronizeMemory(h.db, remote.ctx, { pullOnly: true });
  expect(before).toMatchObject({ state: 'Pending sync', failed: 1,
    backfill: { eligible: 1, indexed: 0, pending: 1, excluded: 1, failed: 1 } });
  expect(before.error).toContain(broken);
  const adopted = await synchronizeMemory(h.db, remote.ctx, { limit: 0 });
  expect(adopted.backfill).toEqual({ eligible: 1, indexed: 1, pending: 0, excluded: 1, failed: 1 });
  const memories = await h.db.select().from(memoryItem);
  expect(memories).toHaveLength(1);
  expect(memories[0]?.payload).toMatchObject({ investigationId: good,
    outcome: { disposition: 'unknown', certainty: 'inferred' } });
  expect(memories[0]?.createdAt.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  expect(adopted.state).toBe('Pending sync');
  await h.db.insert(memorySyncReplica).values({
    scope: remote.ctx.scope, memoryId: memories[0]!.id, revision: '0',
    generation: memories[0]!.syncGeneration,
  });
  const acknowledged = await synchronizeMemory(h.db, remote.ctx, { pullOnly: true });
  expect(acknowledged.pending).toBe(0);
  expect(acknowledged.state).toBe('Pending sync'); // The unreadable report still prevents “Synced”.
  fault.mockRestore();
  const recovered = await synchronizeMemory(h.db, remote.ctx, { limit: 0 });
  expect(recovered.backfill).toEqual({ eligible: 2, indexed: 2, pending: 0, excluded: 1 });
  expect(recovered.failed).toBe(0);
  expect(recovered.error).toBeUndefined();
  expect(await h.db.select().from(memoryItem)).toHaveLength(2);
  expect(await h.db.select().from(investigations)).toHaveLength(4);
}, 30_000);

it('retains completed report uploads in the authorized scope when a recurring memory sync is interrupted', async () => {
  const h = await open();
  const remote = cloud();
  const store = createLocalMemoryStore(h.db);
  const memory = await store.add({
    id: '', kind: 'investigation', source: 'investigation', scope: 'repo', repo: remote.ctx.repo,
    claim: 'recurring incident', confidence: 0.3,
  }, audit);
  const ids = ['0c2ad168-fc56-453c-903e-981623ebcc6f', '93f60d4c-a63d-4b6b-8ee9-c4dcdc22533f'];
  for (const id of ids) {
    await h.db.insert(investigations).values({
      id, title: 'incident', project: remote.ctx.repo, incidentInput: {},
      report: { id, input: { repo: remote.ctx.repo, hint: 'incident' }, hypotheses: [] },
    });
    await store.addLink({ id: '', fromMemoryId: memory.id, rel: 'about-incident',
      toKind: 'incident', toRef: id });
  }
  let interrupted = false;
  const upload = vi.spyOn(investigationSync, 'uploadInvestigationToCloud').mockImplementation(
    async (_client, _config, report) => {
      if (report.id === ids[1] && !interrupted) {
        interrupted = true;
        throw new Error('deadline interrupted the second report');
      }
      return { projectId: remote.ctx.config.project!.id, investigationId: `cloud-${report.id}` };
    },
  );
  const first = await synchronizeMemory(h.db, remote.ctx);
  expect(first.state).toBe('Pending sync');
  expect(first.error).toContain('deadline');
  const partial = await store.get(memory.id);
  expect(partial?.syncScope).toBe(remote.ctx.scope);
  expect(partial?.payload).toMatchObject({ reportRefs: { [ids[0]!]: `cloud-${ids[0]}` } });
  expect(await h.db.select().from(memorySyncOutbox)).toHaveLength(0);
  const result = await synchronizeMemory(h.db, remote.ctx);
  expect(result.state).toBe('Synced');
  expect(upload.mock.calls.map((c) => c[2].id)).toEqual([ids[0], ids[1], ids[1]]);
  expect(remote.rows.get(memory.id)?.record).toMatchObject({ reportRefs: {
    [ids[0]!]: `cloud-${ids[0]}`, [ids[1]!]: `cloud-${ids[1]}`,
  } });
}, 30_000);
