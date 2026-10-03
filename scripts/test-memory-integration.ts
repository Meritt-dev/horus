/** Run explicitly against a disposable Cloud test database; never reads the user's Horus profile. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createLocalDb,
  investigations,
  outcomeLabel,
  recordOutcomeLabel,
  memoryLink,
  memoryAudit,
  memorySyncOutbox,
  memoryItem,
  eq,
  type DbHandle,
} from '../packages/db/src/index.js';
import {
  createLocalMemoryStore,
  investigate,
  recallStartupIncidents,
} from '../packages/engine/src/index.js';
import { CloudClient } from '../packages/cli/src/lib/cloud/api.js';
import {
  synchronizeMemory,
  syncLinkedMemory,
  restoreMemoryReport,
  type MemorySyncContext,
} from '../packages/cli/src/lib/cloud/memory-sync.js';

import { writeAuth } from '../packages/cli/src/lib/cloud/auth-store.js';
import { writeCloudConfig } from '../packages/cli/src/lib/cloud/context-store.js';
import { createServer } from 'node:http';

const url = process.env.HORUS_CLOUD_TEST_DATABASE_URL;
assert(url, 'Set HORUS_CLOUD_TEST_DATABASE_URL to a disposable, migrated local database');
assert(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
assert(new URL(url).pathname.endsWith('_test'), 'Database name must end in _test');
if (process.env.HORUS_RECALL_HISTORY && process.env.STORAGE_BUCKET) {
  assert(
    process.env.STORAGE_ENDPOINT,
    'Historical test storage must use an explicit local endpoint',
  );
  assert(
    ['localhost', '127.0.0.1'].includes(new URL(process.env.STORAGE_ENDPOINT).hostname),
  );
}
process.env.HORUS_CLOUD_DATABASE_URL = url;
const cloudRoot = resolve(process.env.HORUS_CLOUD_REPO ?? '../horus-cloud');
const cloudImport = (path: string) => import(pathToFileURL(join(cloudRoot, path)).href);
const { createDatabase, cliTokens, organizations, users } = await cloudImport(
  'packages/db/src/index.ts',
);
const { seedTenant } = await cloudImport('packages/core/src/test-helpers.ts');
const { buildServer } = await cloudImport('apps/api/src/server.ts');
const { generateCliToken } = await cloudImport('apps/api/src/auth/tokens.ts');
const db = createDatabase(url);
const tenant = await seedTenant(db, 'memory-contract');
const token = generateCliToken();
await db.insert(cliTokens).values({
  userId: tenant.userId,
  name: 'isolated contract test',
  tokenHash: token.hash,
  tokenPrefix: token.prefix,
});
process.env.LOG_LEVEL = 'silent';
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const dir = await mkdtemp(join(tmpdir(), 'horus-memory-contract-'));
const handles: DbHandle[] = [];
const originalHome = process.env.HORUS_HOME;
try {
  let a = await createLocalDb({ path: join(dir, 'first') });
  handles.push(a);
  const b = await createLocalDb({ path: join(dir, 'second') });
  handles.push(b);
  const ctx: MemorySyncContext = {
    client: new CloudClient(base, token.plaintext),
    userId: tenant.userId,
    repo: 'checkout-a',
    scope: JSON.stringify([
      base,
      tenant.orgId,
      tenant.workspaceId,
      tenant.projectId,
      tenant.userId,
    ]),
    config: {
      context: 'cloud',
      organization: { id: tenant.orgId, slug: 'org' },
      workspace: { id: tenant.workspaceId, slug: 'ws' },
      project: { id: tenant.projectId, slug: 'project' },
    },
  };
  const report = await investigate(
    {
      hint: 'EMODA reserve ETIMEDOUT 503',
      repo: ctx.repo,
      environment: 'production',
      incident: { errorCode: 'ETIMEDOUT', eventCode: 'EMODA_017D',
        fingerprint: 'EMODA_017D:ETIMEDOUT:indeterminate:503', source: 'elasticsearch', eventId: 'logs:reserve-a' },
    },
    { code: null, db: a.db, store: createLocalMemoryStore(a.db) },
  );
  assert.equal(report.persisted, true);
  // Simulate an older saved investigation without the later rich-memory record.
  await a.db.delete(memoryItem);
  const deferred = await synchronizeMemory(a.db, ctx, { backfill: false });
  assert.equal(deferred.state, 'Pending sync');
  assert.deepEqual(deferred.backfill, {
    eligible: 1,
    indexed: 0,
    pending: 1,
    excluded: 0,
  });
  await recordOutcomeLabel(a.db, {
    investigationId: report.id,
    project: ctx.repo,
    resolved: 'partly',
    source: 'feedback',
    note: 'Horus accuracy; not a harmless-alert attestation',
  });
  const uploaded = await synchronizeMemory(a.db, ctx, { deadline: Date.now() + 30_000 });
  assert.equal(uploaded.state, 'Synced', JSON.stringify(uploaded));
  assert.deepEqual(uploaded.backfill, {
    eligible: 1,
    indexed: 1,
    pending: 0,
    excluded: 0,
  });
  const second = { ...ctx, repo: 'different-path-and-name' };
  const restored = await synchronizeMemory(b.db, second, {
    deadline: Date.now() + 30_000,
  });
  assert.equal(restored.state, 'Synced', JSON.stringify(restored));
  const candidates = await recallStartupIncidents(
    createLocalMemoryStore(b.db),
    { ...report.input, repo: second.repo },
    { syncScope: ctx.scope },
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.outcome?.certainty, 'inferred');
  assert.equal(candidates[0]!.outcome?.applicability.source, 'elasticsearch');
  assert.equal(candidates[0]!.outcome?.applicability.eventId, 'logs:reserve-a');
  assert.equal(candidates[0]!.outcome?.applicability.eventCode, 'EMODA_017D');
  assert.equal(candidates[0]!.outcome?.applicability.errorCode, 'ETIMEDOUT');
  assert(Object.keys(candidates[0]!.reportRefs).includes(report.id));
  assert(await restoreMemoryReport(b.db, second, report.id));
  assert.equal(
    (await b.db.select().from(investigations).where(eq(investigations.id, report.id)))
      .length,
    1,
  );
  assert.equal(
    (
      await b.db
        .select()
        .from(outcomeLabel)
        .where(eq(outcomeLabel.investigationId, report.id))
    ).length,
    1,
  );
  const memId = candidates[0]!.memoryId;
  await createLocalMemoryStore(b.db).update(
    memId,
    { claim: 'EMODA reserve is still indeterminate; verify upstream' },
    { audit: { actor: { kind: 'user' } } },
  );
  // Simulate a server-accepted request whose HTTP response never reached this laptop.
  const realSync = second.client.syncMemoryItems.bind(second.client);
  let drop = true;
  second.client.syncMemoryItems = async (...args) => {
    const result = await realSync(...args);
    if (drop) {
      drop = false;
      throw new Error('lost HTTP response');
    }
    return result;
  };
  assert.equal((await synchronizeMemory(b.db, second)).state, 'Pending sync');
  second.client.syncMemoryItems = realSync;
  await b.db.update(memorySyncOutbox).set({ nextAttemptAt: new Date(0) });
  assert.equal((await synchronizeMemory(b.db, second)).state, 'Synced');
  await a.sql.end();
  handles.splice(handles.indexOf(a), 1);
  a = await createLocalDb({ path: join(dir, 'first') });
  handles.push(a);
  assert.equal((await synchronizeMemory(a.db, ctx)).state, 'Synced');
  assert.equal(
    (await createLocalMemoryStore(a.db).get(memId))!.claim,
    'EMODA reserve is still indeterminate; verify upstream',
  );
  await createLocalMemoryStore(a.db).update(
    memId,
    { claim: 'Correction A' },
    { audit: { actor: { kind: 'user' } } },
  );
  await createLocalMemoryStore(b.db).update(
    memId,
    { claim: 'Correction B' },
    { audit: { actor: { kind: 'user' } } },
  );
  await synchronizeMemory(a.db, ctx);
  assert.equal((await synchronizeMemory(b.db, second)).failed, 1);
  assert.equal(
    (await synchronizeMemory(b.db, second, { resolve: memId, choice: 'local' })).state,
    'Synced',
  );
  await synchronizeMemory(a.db, ctx);
  assert.equal((await createLocalMemoryStore(a.db).get(memId))!.claim, 'Correction B');
  await createLocalMemoryStore(b.db).setStatus(memId, 'forgotten', {
    actor: { kind: 'user' },
  });
  await synchronizeMemory(b.db, second);
  await synchronizeMemory(a.db, ctx);
  assert.equal((await createLocalMemoryStore(a.db).get(memId))!.status, 'forgotten');
  assert.equal(
    (await synchronizeMemory(b.db, second, { restore: memId })).state,
    'Synced',
  );
  await synchronizeMemory(a.db, ctx);
  assert.equal((await createLocalMemoryStore(a.db).get(memId))!.status, 'fresh');
  // A mature recurrence exceeds the old per-request array cap. Freeze it in
  // the existing outbox, lose a page response, then restore every row on a clean machine.
  const mature = await createLocalMemoryStore(a.db).add({
    id: 'mature-history', kind: 'investigation', source: 'investigation', scope: 'repo',
    claim: 'Mature recurring incident', repo: ctx.repo, confidence: 0.4,
  }, { actor: { kind: 'user' } });
  for (let offset = 0; offset < 2101; offset += 500) {
    const indices = Array.from({ length: Math.min(500, 2101 - offset) }, (_, i) => offset + i);
    await a.db.insert(memoryLink).values(indices.map(i => ({ id: `large-link-${i}`,
      fromMemoryId: mature.id, rel: 'about-file', toKind: 'node', toRef: `file-${i}.ts` })));
    await a.db.insert(memoryAudit).values(indices.map(i => ({ id: `large-audit-${i}`,
      memoryId: mature.id, action: 'link', actor: { kind: 'system' }, at: new Date('2026-01-01T00:00:00Z') })));
  }
  const sync = ctx.client.syncMemoryItems.bind(ctx.client);
  let lostPage = false;
  ctx.client.syncMemoryItems = async (...args) => {
    const result = await sync(...args);
    if (result.staged && !lostPage) { lostPage = true; throw new Error('lost page response'); }
    return result;
  };
  await synchronizeMemory(a.db, ctx, { backfill: false, deadline: Date.now() + 60000 });
  const [frozen] = await a.db.select().from(memorySyncOutbox).where(eq(memorySyncOutbox.memoryId, mature.id));
  assert(frozen && frozen.request.links.length === 2101, 'oversized snapshot remains durable');
  ctx.client.syncMemoryItems = sync;
  await a.db.update(memorySyncOutbox).set({ nextAttemptAt: new Date(0) });
  assert.equal((await synchronizeMemory(a.db, ctx, { backfill: false, deadline: Date.now() + 60000 })).state, 'Synced');
  const clean = await createLocalDb({ path: join(dir, 'large-history-clean') }); handles.push(clean);
  const cleanCtx = { ...ctx, repo: 'clean-large-history' };
  assert.equal((await synchronizeMemory(clean.db, cleanCtx, { backfill: false, deadline: Date.now() + 60000 })).state, 'Synced');
  assert.equal((await clean.db.select().from(memoryLink).where(eq(memoryLink.fromMemoryId, mature.id))).length, 2101);
  assert.equal((await clean.db.select().from(memoryAudit).where(eq(memoryAudit.memoryId, mature.id))).length, 2102);
  console.log('PASS: 2101 links and 2102 audit rows restored through bounded pages after a lost page acknowledgement');
  if (process.env.HORUS_RECALL_HISTORY) {
    const history = JSON.parse(await readFile(process.env.HORUS_RECALL_HISTORY, 'utf8'));
    assert(Array.isArray(history.reports) && history.reports.length <= 1000);
    const reports = history.reports.filter(
      (r) => r?.report?.input?.hint && Array.isArray(r.report.hypotheses),
    );
    assert(reports.length);
    for (const row of reports) {
      const imported = { ...row.report, input: { ...row.report.input, repo: ctx.repo } };
      await a.db.insert(investigations).values({
        id: row.id,
        title: row.title,
        incidentInput: imported.input,
        report: imported,
        project: ctx.repo,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      });
    }
    process.env.HORUS_HOME = join(dir, 'auth');
    const root = join(dir, 'checkout');
    const auth = {
      apiBaseUrl: base,
      token: token.plaintext,
      account: { userId: tenant.userId, email: 'memory-test@example.invalid' },
    };
    writeAuth(auth);
    writeCloudConfig(root, ctx.config);
    const startupMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await syncLinkedMemory(a.db, root, ctx.repo, { startup: true });
      await recallStartupIncidents(createLocalMemoryStore(a.db), report.input);
      startupMs.push(performance.now() - started);
    }
    const importedAt = performance.now();
    let synced;
    let passes = 0;
    do {
      synced = await syncLinkedMemory(a.db, root, ctx.repo);
      console.log(
        JSON.stringify({
          pass: ++passes,
          state: synced.state,
          pending: synced.pending,
          backfill: synced.backfill,
          error: synced.error,
        }),
      );
      assert(
        !synced.error || synced.error.includes('This operation was aborted'),
        synced.error,
      );
    } while (synced.state !== 'Synced' && passes < 30);
    assert.equal(synced.state, 'Synced');
    assert.equal(synced.backfill?.pending, 0);
    const backfillMs = performance.now() - importedAt;
    const clean = await createLocalDb({ path: join(dir, 'historical-clean-profile') });
    handles.push(clean);
    const restoredHistory = await synchronizeMemory(clean.db, second, {
      deadline: Date.now() + 30_000,
    });
    assert.equal(restoredHistory.state, 'Synced', JSON.stringify(restoredHistory));
    const restoredItems = await createLocalMemoryStore(clean.db).query({
      repo: second.repo,
      limit: 1000,
    });
    const referencedIds = new Set(
      restoredItems.flatMap((item) =>
        Object.keys(
          (item.payload as { reportRefs?: Record<string, string> }).reportRefs ?? {},
        ),
      ),
    );
    for (const row of reports)
      assert(referencedIds.has(row.id), `Missing restored reference: ${row.id}`);
    for (const row of reports) {
      const memory = restoredItems.find(
        (item) => item.payload?.investigationId === row.id,
      );
      assert(memory, `Missing historical memory: ${row.id}`);
      assert.equal(memory.createdAt.toISOString(), row.createdAt);
      // The existing memory column is PostgreSQL real (float32); report JSON stays exact.
      assert(Math.abs(memory.confidence - row.report.confidence) < 1e-6);
      const hydrated = await restoreMemoryReport(clean.db, second, row.id);
      assert(hydrated, `Report not restored: ${row.id}`);
      assert.equal(hydrated.evidence.length, row.report.evidence.length);
      assert.equal(hydrated.confidence, row.report.confidence);
    }
    const ackMs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      await createLocalMemoryStore(a.db).update(
        memId,
        { claim: `Measured correction ${i}` },
        { audit: { actor: { kind: 'user' } } },
      );
      assert.equal((await syncLinkedMemory(a.db, root, ctx.repo)).state, 'Synced');
      ackMs.push(performance.now() - started);
    }
    // An actual hanging HTTP endpoint must not consume the investigation's time budget.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    let outageMs: number;
    try {
      writeAuth({ ...auth, apiBaseUrl: `http://127.0.0.1:${hanging.address().port}` });
      const started = performance.now();
      const offline = await syncLinkedMemory(a.db, root, ctx.repo, { startup: true });
      outageMs = performance.now() - started;
      assert.equal(offline.state, 'Pending sync');
      assert(offline.error);
      assert(outageMs < 2200, `Startup abort exceeded tolerance: ${outageMs}ms`);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
      writeAuth(auth);
    }
    const p95 = (values: number[]) =>
      [...values].sort((x, y) => x - y)[Math.ceil(values.length * 0.95) - 1];
    console.log(
      JSON.stringify({
        historicalReports: reports.length,
        restoredReportReferences: referencedIds.size,
        hydratedHistoricalReports: reports.length,
        backfillMs,
        passes,
        startupSamples: startupMs.length,
        startupP95Ms: p95(startupMs),
        acknowledgementSamples: ackMs.length,
        acknowledgementP95Ms: p95(ackMs),
        outageMs,
        scope:
          'Readable real-history export, disposable profiles and localhost Cloud; not production latency or full original-history recovery',
      }),
    );
  }
  console.log(
    'PASS: real authenticated Cloud API + two PGlite profiles; report hydration, startup recall, corrections, lost acknowledgement, restart, competing corrections, deletion and explicit restoration',
  );
} finally {
  for (const h of handles) await h.sql.end();
  await app.close();
  await db.delete(organizations).where(eq(organizations.id, tenant.orgId));
  await db.delete(users).where(eq(users.id, tenant.userId));
  await db.$client.end();
  const { getDb } = await cloudImport('apps/api/src/db.ts');
  await getDb().$client.end();
  await rm(dir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HORUS_HOME;
  else process.env.HORUS_HOME = originalHome;
}
