/** Durable replication of the existing memory store; no background work survives CLI exit. */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or, sql } from '@horus/db';
import {
  memoryItem,
  memoryLink,
  memoryAudit,
  memorySyncState,
  memorySyncReplica,
  memorySyncOutbox,
  investigations,
  outcomeLabel,
  type HorusDb,
  type MemoryItem,
} from '@horus/db';
import { redactErrorMessage } from '@horus/core';
import {
  createLocalMemoryStore,
  createInvestigationMemory,
  storeIncidentMemory,
  readIncidentDisposition,
  type InvestigationReport,
} from '@horus/engine';
import { CloudClient, CloudError, type MemoryItemRecord } from './api.js';
import { readAuth } from './auth-store.js';
import { readCloudConfig, type CloudConfig } from './context-store.js';
import { toSyncInput, toLinkSyncInput, toAuditSyncInput } from './memory-store.js';
import {
  uploadInvestigationToCloud,
  fetchInvestigationReportFromCloud,
  redactCloudValue,
} from './investigation-sync.js';

type Request = Parameters<CloudClient['syncMemoryItems']>[1];
export interface MemorySyncStatus {
  state: 'Synced' | 'Pending sync' | 'Sign-in required' | 'Local only';
  eligible: number;
  synced: number;
  pending: number;
  excluded: number;
  failed: number;
  lastPull?: string;
  lastPush?: string;
  oldestPending?: string;
  error?: string;
  conflicts?: Array<{ memoryId: string; operationId: string; detail: unknown }>;
  backfill?: { eligible: number; indexed: number; pending: number; excluded: number };
}
export interface MemorySyncContext {
  client: CloudClient;
  config: CloudConfig;
  scope: string;
  repo: string;
  userId: string;
}
export function memorySyncContext(
  root: string,
  repo: string,
  signal?: AbortSignal,
): MemorySyncContext | null {
  const config = readCloudConfig(root);
  const auth = readAuth();
  if (!config?.project || config.context !== 'cloud' || !auth) return null;
  return {
    client: new CloudClient(auth.apiBaseUrl, auth.token, signal),
    config,
    repo,
    userId: auth.account.userId,
    scope: JSON.stringify([
      auth.apiBaseUrl.replace(/\/$/, ''),
      config.organization?.id,
      config.workspace?.id,
      config.project.id,
      auth.account.userId,
    ]),
  };
}
const payloadOf = (item: MemoryItem) => (item.payload ?? {}) as Record<string, unknown>;
const iso = (date: Date | null) => date?.toISOString();
function coveredReports(
  memories: MemoryItem[],
  links: Array<{ toKind: string; toRef: string }>,
) {
  const covered = new Set(
    links.filter((l) => l.toKind === 'incident').map((l) => l.toRef),
  );
  for (const item of memories) {
    const p = payloadOf(item);
    if (typeof p.investigationId === 'string') covered.add(p.investigationId);
    if (Array.isArray(p.investigationIds))
      p.investigationIds.forEach((id) => covered.add(String(id)));
  }
  return covered;
}
const canBackfill = (value: unknown): value is InvestigationReport => {
  const report = value as InvestigationReport | null;
  return !!report?.input?.hint && Array.isArray(report.hypotheses);
};

/** Only named scalar/incident fields leave the device. Unknown payload keys are excluded. */
export function memoryRecord(item: MemoryItem): Record<string, unknown> {
  const payload = payloadOf(item);
  const record: Record<string, unknown> = {
    confidence: item.confidence,
    signature: item.signature,
    evidence: Array.isArray(item.evidence)
      ? item.evidence.map((value) => {
          const e = value as Record<string, unknown>;
          return Object.fromEntries(
            ['kind', 'ref', 'shortId', 'capturedAt']
              .filter((k) => typeof e[k] === 'string')
              .map((k) => [k, e[k]]),
          );
        })
      : [],
    tags: item.tags,
    clientCreatedAt: iso(item.createdAt),
    lastVerifiedAt: iso(item.lastVerifiedAt) ?? null,
    lastVerifiedHash: item.lastVerifiedHash,
  };
  for (const key of ['hint', 'topHypothesis', 'lastSeenAt', 'investigationId'])
    if (typeof payload[key] === 'string') record[key] = payload[key];
  if (typeof payload.recurrenceCount === 'number')
    record.recurrenceCount = payload.recurrenceCount;
  if (Array.isArray(payload.investigationIds))
    record.investigationIds = payload.investigationIds.filter(
      (id) => typeof id === 'string',
    );
  if (payload.reportRefs && typeof payload.reportRefs === 'object')
    record.reportRefs = Object.fromEntries(
      Object.entries(payload.reportRefs).filter(([, v]) => typeof v === 'string'),
    );
  const outcome = readIncidentDisposition(payload.outcome);
  if (outcome) record.outcome = outcome;
  return record;
}

async function status(db: HorusDb, ctx: MemorySyncContext): Promise<MemorySyncStatus> {
  const [state] = await db
    .select()
    .from(memorySyncState)
    .where(eq(memorySyncState.scope, ctx.scope));
  const rows = await db.select().from(memoryItem).where(eq(memoryItem.repo, ctx.repo));
  // Status needs eligibility, not megabytes of historical evidence on every refresh.
  const reports = await db
    .select({
      id: investigations.id,
      eligible: sql<boolean>`coalesce(jsonb_typeof(${investigations.report}->'hypotheses') = 'array'
        AND ${investigations.report}->'input'->>'hint' <> '', false)`,
    })
    .from(investigations)
    .where(eq(investigations.project, ctx.repo));
  const covered = coveredReports(rows, await db.select().from(memoryLink));
  const eligibleReports = reports.filter((r) => r.eligible);
  const indexed = eligibleReports.filter((r) => covered.has(r.id)).length;
  const backfill = {
    eligible: eligibleReports.length,
    indexed,
    pending: eligibleReports.length - indexed,
    excluded: reports.length - eligibleReports.length,
  };
  const replicas = await db
    .select()
    .from(memorySyncReplica)
    .where(eq(memorySyncReplica.scope, ctx.scope));
  const ack = new Map(replicas.map((r) => [r.memoryId, r.generation]));
  const eligible = rows.filter(
    (r) => r.origin !== 'cloud' && (r.syncScope === ctx.scope || r.syncScope === null),
  );
  const pending = eligible.filter((r) => ack.get(r.id) !== r.syncGeneration);
  const outbox = await db
    .select()
    .from(memorySyncOutbox)
    .where(eq(memorySyncOutbox.scope, ctx.scope));
  return {
    state: state?.error?.startsWith('Sign-in required')
      ? 'Sign-in required'
      : pending.length || backfill.pending || state?.error
        ? 'Pending sync'
        : 'Synced',
    eligible: eligible.length,
    synced: eligible.length - pending.length,
    pending: pending.length,
    excluded: rows.length - eligible.length,
    failed: outbox.filter((r) => r.error || r.conflict).length,
    backfill,
    lastPull: iso(state?.lastPull ?? null),
    lastPush: iso(state?.lastPush ?? null),
    oldestPending:
      outbox.map((r) => r.createdAt.toISOString()).sort()[0] ??
      pending.map((r) => r.createdAt.toISOString()).sort()[0],
    conflicts: outbox
      .filter((r) => r.conflict)
      .map((r) => ({ memoryId: r.memoryId, operationId: r.id, detail: r.conflict })),
    error: state?.error ?? outbox.find((r) => r.error)?.error ?? undefined,
  };
}

async function applyRemote(
  db: HorusDb,
  ctx: MemorySyncContext,
  row: MemoryItemRecord,
): Promise<void> {
  if (
    !row.revision ||
    row.projectId !== ctx.config.project!.id ||
    row.organizationId !== ctx.config.organization?.id ||
    row.workspaceId !== ctx.config.workspace?.id ||
    (row.visibility === 'private' && row.createdByUserId !== ctx.userId)
  ) {
    throw new Error('Cloud memory scope or revision mismatch');
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('horus.sync_pull', '1', true)`);
    const [local] = await tx
      .select()
      .from(memoryItem)
      .where(eq(memoryItem.id, row.clientId));
    const [replica] = await tx
      .select()
      .from(memorySyncReplica)
      .where(
        and(
          eq(memorySyncReplica.scope, ctx.scope),
          eq(memorySyncReplica.memoryId, row.clientId),
        ),
      );
    if (local && local.syncScope && local.syncScope !== ctx.scope)
      throw new Error('Memory id belongs to another synchronization scope');
    if (local && (!replica || replica.generation !== local.syncGeneration)) {
      // Adopt legacy mirror revisions without discarding richer local history.
      if (!replica)
        await tx.insert(memorySyncReplica).values({
          scope: ctx.scope,
          memoryId: local.id,
          revision: row.revision!,
          generation: 0,
        });
      // A remote tombstone suppresses recall immediately, while the competing correction remains local.
      if (row.status === 'forgotten')
        await tx
          .update(memoryItem)
          .set({ status: 'forgotten' })
          .where(eq(memoryItem.id, local.id));
      return;
    }
    const record = row.record ?? {};
    const own = row.createdByUserId === ctx.userId;
    const values = {
      id: row.clientId,
      kind: row.kind,
      claim: row.claim,
      scope: row.scope,
      source: row.source,
      status: row.status,
      visibility: row.visibility,
      confidence: typeof record.confidence === 'number' ? record.confidence : 0,
      createdAt: new Date(
        typeof record.clientCreatedAt === 'string'
          ? record.clientCreatedAt
          : row.createdAt,
      ),
      lastVerifiedAt:
        typeof record.lastVerifiedAt === 'string'
          ? new Date(record.lastVerifiedAt)
          : null,
      lastVerifiedHash:
        typeof record.lastVerifiedHash === 'string' ? record.lastVerifiedHash : null,
      signature: typeof record.signature === 'string' ? record.signature : null,
      tags: Array.isArray(record.tags) ? (record.tags as string[]) : null,
      repo: ctx.repo,
      orgId: row.organizationId,
      workspaceId: row.workspaceId,
      userId: row.createdByUserId,
      origin: own ? 'local' : 'cloud',
      syncScope: ctx.scope,
      syncGeneration: local?.syncGeneration ?? 1,
      cloudId: row.id,
      pulledAt: new Date(),
      payload: record,
      evidence: record.evidence ?? [],
    };
    await tx
      .insert(memoryItem)
      .values(values)
      .onConflictDoUpdate({ target: memoryItem.id, set: values });
    await tx.delete(memoryLink).where(eq(memoryLink.fromMemoryId, row.clientId));
    for (const link of row.links ?? [])
      await tx
        .insert(memoryLink)
        .values({
          id: link.idempotencyKey,
          fromMemoryId: row.clientId,
          rel: link.rel,
          toKind: link.toKind,
          toRef: link.toRef,
          toFilePath: link.toFilePath,
          createdAt: new Date(link.createdAt),
        })
        .onConflictDoNothing();
    for (const audit of row.audit ?? [])
      await tx
        .insert(memoryAudit)
        .values({
          id: audit.clientAuditId,
          memoryId: row.clientId,
          action: audit.action,
          actor: audit.actor,
          at: new Date(audit.at),
          fromStatus: (audit.detail?.fromStatus as string) ?? null,
          toStatus: (audit.detail?.toStatus as string) ?? null,
          note: (audit.detail?.note as string) ?? null,
          detail: audit.detail,
        })
        .onConflictDoNothing();
    for (const label of (record.accuracyFeedback ?? []) as Array<
      Record<string, unknown>
    >) {
      const [report] = await tx
        .select({ id: investigations.id })
        .from(investigations)
        .where(
          and(
            eq(investigations.id, String(label.investigationId)),
            eq(investigations.project, ctx.repo),
          ),
        );
      if (report)
        await tx
          .insert(outcomeLabel)
          .values({
            id: String(label.id),
            investigationId: report.id,
            project: ctx.repo,
            resolved: String(label.resolved),
            source: String(label.source),
            at: new Date(String(label.at)),
            note: label.note as string | null,
            confirmedCause: label.confirmedCause as string | null,
          })
          .onConflictDoNothing();
    }
    await tx
      .insert(memorySyncReplica)
      .values({
        scope: ctx.scope,
        memoryId: row.clientId,
        revision: row.revision!,
        generation: values.syncGeneration,
      })
      .onConflictDoUpdate({
        target: [memorySyncReplica.scope, memorySyncReplica.memoryId],
        set: { revision: row.revision!, generation: values.syncGeneration },
      });
  });
}

async function pullTeamMemory(
  db: HorusDb,
  ctx: MemorySyncContext,
  deadline: number,
): Promise<void> {
  const [state] = await db
    .select()
    .from(memorySyncState)
    .where(eq(memorySyncState.scope, ctx.scope));
  let cursor = state!.teamCursor;
  const store = createLocalMemoryStore(db);
  while (Date.now() < deadline) {
    const page = await ctx.client.listTeamMemorySince(ctx.config.project!.id, {
      since: cursor,
      limit: 25,
      includeDeleted: true,
    });
    for (const item of page.items) {
      if (Date.now() >= deadline) return;
      if (
        item.organizationId !== ctx.config.organization?.id ||
        item.workspaceId !== ctx.config.workspace?.id
      )
        throw new Error('Shared memory scope mismatch');
      // Workspace promotion is unchanged; investigation startup only imports this project's records.
      if (item.sourceProjectId === ctx.config.project!.id) {
        const existing = await store.get(item.originClientId);
        if (
          !existing ||
          (existing.origin === 'cloud' &&
            (!existing.syncScope || existing.syncScope === ctx.scope))
        ) {
          await store.upsertCached(
            {
              id: item.originClientId,
              repo: ctx.repo,
              kind: item.kind,
              claim: item.claim,
              scope: item.scope,
              source: item.source,
              status: item.deletedAt ? 'forgotten' : item.status,
              confidence: item.confidence ?? 0,
              visibility: 'team',
              evidence: [],
              cloudId: item.id,
              orgId: item.organizationId,
              workspaceId: item.workspaceId,
              syncScope: ctx.scope,
              authorName: item.authorName,
              createdAt: new Date(item.promotedAt),
            },
            { actor: { kind: 'system' }, note: 'Automatic team memory refresh' },
          );
        }
      }
      cursor = item.seq;
      await db
        .update(memorySyncState)
        .set({ teamCursor: cursor })
        .where(eq(memorySyncState.scope, ctx.scope));
    }
    if (!page.hasMore) return;
  }
}

/** Resolve a restored local report id through its authorized Cloud mapping, never a dangling stub. */
export async function restoreMemoryReport(
  db: HorusDb,
  ctx: MemorySyncContext,
  localId: string,
): Promise<InvestigationReport | null> {
  const [existing] = await db
    .select()
    .from(investigations)
    .where(eq(investigations.id, localId));
  const cached = existing?.project === ctx.repo && existing.report
    ? existing.report as InvestigationReport : null;
  const replicaScope = (existing?.incidentInput as { _horusCloudScope?: unknown } | undefined)
    ?._horusCloudScope;
  if (existing && (!cached || (replicaScope !== undefined && replicaScope !== ctx.scope)))
    return null;
  // Locally authored reports remain authoritative; only imported copies refresh.
  if (cached && replicaScope === undefined) return cached;
  const memories = await db
    .select()
    .from(memoryItem)
    .where(and(eq(memoryItem.syncScope, ctx.scope), eq(memoryItem.repo, ctx.repo)));
  let cloudId: string | undefined;
  for (const item of memories) {
    const refs = payloadOf(item).reportRefs as Record<string, string> | undefined;
    if (typeof refs?.[localId] === 'string') {
      cloudId = refs[localId];
      break;
    }
  }
  if (!cloudId) return cached;
  let report: InvestigationReport | null;
  try {
    report = await fetchInvestigationReportFromCloud(ctx.client, ctx.config, cloudId);
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
  if (
    !report?.input?.hint ||
    !Array.isArray(report.evidence) ||
    !Array.isArray(report.hypotheses)
  )
    return cached;
  const restored = {
    ...report,
    id: localId,
    input: { ...report.input, repo: ctx.repo },
    persisted: true,
  };
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(investigations)
      .values({
        id: localId,
        title: report.input.hint,
        incidentInput: { ...restored.input, _horusCloudScope: ctx.scope },
        project: ctx.repo,
        ...(report.createdAt ? { createdAt: new Date(report.createdAt) } : {}),
        status: 'completed',
        summary: report.summary,
        report: restored,
      })
      .onConflictDoUpdate({
        target: investigations.id,
        set: {
          title: report.input.hint,
          incidentInput: { ...restored.input, _horusCloudScope: ctx.scope },
          report: restored, summary: report.summary, updatedAt: new Date(),
        },
      })
      .returning();
    if (!existing && inserted.length)
      await storeIncidentMemory(tx as unknown as HorusDb, localId, restored);
  });
  const feedback = memories.flatMap(
    (item) => (payloadOf(item).accuracyFeedback ?? []) as Array<Record<string, unknown>>,
  );
  for (const label of feedback)
    if (label.investigationId === localId)
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('horus.sync_pull', '1', true)`);
        await tx
          .insert(outcomeLabel)
          .values({
            id: String(label.id),
            investigationId: localId,
            project: ctx.repo,
            resolved: String(label.resolved),
            source: String(label.source),
            at: new Date(String(label.at)),
            note: label.note as string | null,
            confirmedCause: label.confirmedCause as string | null,
          })
          .onConflictDoNothing();
      });
  return restored;
}

/** Rebuild missing rich entries from saved reports, preserving original dates and inferred findings. */
async function backfill(
  db: HorusDb,
  ctx: MemorySyncContext,
  deadline: number,
): Promise<void> {
  const store = createLocalMemoryStore(db);
  const reports = await db
    .select()
    .from(investigations)
    .where(eq(investigations.project, ctx.repo));
  const memories = await db
    .select()
    .from(memoryItem)
    .where(eq(memoryItem.repo, ctx.repo));
  const links = await db.select().from(memoryLink);
  const covered = coveredReports(memories, links);
  for (const row of reports) {
    if (Date.now() >= deadline) break;
    if (!canBackfill(row.report) || covered.has(row.id)) continue;
    const report = row.report;
    const item = await createInvestigationMemory(
      store,
      row.id,
      { ...report, input: { ...report.input, repo: ctx.repo } },
      {
        actor: { kind: 'system' },
        note: 'Imported from saved investigation; outcome unconfirmed',
      },
    );
    if (item)
      await db
        .update(memoryItem)
        .set({ createdAt: row.createdAt })
        .where(eq(memoryItem.id, item.id));
  }
}

export interface MemorySyncOptions {
  limit?: number;
  pullOnly?: boolean;
  backfill?: boolean;
  deadline?: number;
  resolve?: string;
  choice?: 'local' | 'cloud';
  restore?: string;
}

async function resolveConflict(
  db: HorusDb,
  ctx: MemorySyncContext,
  id: string,
  choice: 'local' | 'cloud',
): Promise<void> {
  const [op] = await db
    .select()
    .from(memorySyncOutbox)
    .where(and(eq(memorySyncOutbox.scope, ctx.scope), eq(memorySyncOutbox.memoryId, id)));
  if (!op?.conflict) throw new Error('No unresolved conflict for this memory');
  let cursor = '0';
  let remote: MemoryItemRecord | undefined;
  do {
    const page = await ctx.client.listMemoryItems(ctx.config.project!.id, {
      afterRevision: cursor,
      limit: 100,
    });
    remote = page.items.find((item) => item.clientId === id);
    if (remote || !page.hasMore || !page.nextRevision) break;
    cursor = page.nextRevision;
  } while (true);
  if (!remote?.revision)
    throw new Error('Cannot resolve a conflict without the current server revision');
  const [local] = await db.select().from(memoryItem).where(eq(memoryItem.id, id));
  if (!local || local.syncScope !== ctx.scope) throw new Error('Memory scope mismatch');
  if (choice === 'local' && remote.status === 'forgotten' && local.status !== 'forgotten')
    throw new Error(
      'Remote memory was forgotten; accept Cloud and use --restore explicitly',
    );
  await db.transaction(async (tx) => {
    await tx.delete(memorySyncOutbox).where(eq(memorySyncOutbox.id, op.id));
    await tx
      .update(memorySyncReplica)
      .set({
        revision: remote!.revision!,
        generation: choice === 'cloud' ? local.syncGeneration : 0,
      })
      .where(
        and(eq(memorySyncReplica.scope, ctx.scope), eq(memorySyncReplica.memoryId, id)),
      );
  });
  if (choice === 'cloud') await applyRemote(db, ctx, remote);
  await db.insert(memoryAudit).values({
    id: randomUUID(),
    memoryId: id,
    action: 'resolve-conflict',
    actor: { kind: 'user', id: ctx.userId },
    note: `Explicitly selected ${choice} after operation ${op.id}; rejected correction retained in Cloud operation history`,
  });
}

/** Pull first, then freeze each dirty snapshot before sending it. Retry preserves the exact operation. */
export async function synchronizeMemory(
  db: HorusDb,
  ctx: MemorySyncContext,
  opts: MemorySyncOptions = {},
): Promise<MemorySyncStatus> {
  const deadline = opts.deadline ?? Date.now() + 15_000;
  await db
    .insert(memorySyncState)
    .values({ scope: ctx.scope, repo: ctx.repo })
    .onConflictDoNothing();
  try {
    let [state] = await db
      .select()
      .from(memorySyncState)
      .where(eq(memorySyncState.scope, ctx.scope));
    while (Date.now() < deadline) {
      const page = await ctx.client.listMemoryItems(ctx.config.project!.id, {
        afterRevision: state!.cursor,
        limit: 25,
      });
      if (page.nextRevision === undefined)
        throw new Error(
          'Cloud does not support durable memory sync; upgrade Cloud first',
        );
      let appliedRevision = state!.cursor;
      for (const row of page.items) {
        if (Date.now() >= deadline) break;
        await applyRemote(db, ctx, row);
        appliedRevision = row.revision!;
      }
      await db
        .update(memorySyncState)
        .set({ cursor: appliedRevision, lastPull: new Date(), error: null })
        .where(eq(memorySyncState.scope, ctx.scope));
      if (!page.hasMore) break;
      state = { ...state!, cursor: appliedRevision };
    }
    await pullTeamMemory(db, ctx, deadline);
    if (opts.pullOnly) return status(db, ctx);
    if (opts.resolve) {
      if (!opts.choice) throw new Error('--resolve requires --choice local|cloud');
      await resolveConflict(db, ctx, opts.resolve, opts.choice);
    }
    if (opts.restore) {
      const local = await createLocalMemoryStore(db).get(opts.restore);
      if (!local || local.syncScope !== ctx.scope || local.status !== 'forgotten')
        throw new Error('Restore requires a forgotten memory in this Cloud scope');
      await createLocalMemoryStore(db).setStatus(opts.restore, 'fresh', {
        actor: { kind: 'user', id: ctx.userId },
        note: 'Explicit restore',
      });
    }
    if (opts.backfill !== false && Date.now() < deadline)
      await backfill(db, ctx, deadline);
    const rows = await db
      .select()
      .from(memoryItem)
      .where(
        and(
          eq(memoryItem.repo, ctx.repo),
          eq(memoryItem.origin, 'local'),
          or(eq(memoryItem.syncScope, ctx.scope), isNull(memoryItem.syncScope)),
          sql`NOT EXISTS (SELECT 1 FROM memory_sync_replica r WHERE r.scope = ${ctx.scope}
            AND r.memory_id = ${memoryItem.id} AND r.generation = ${memoryItem.syncGeneration})`,
        ),
      );
    for (const item of rows.slice(0, opts.limit)) {
      if (Date.now() >= deadline) break;
      for (const id of Object.keys((payloadOf(item).reportRefs as object) ?? {})) {
        if (Date.now() >= deadline) break;
        await restoreMemoryReport(db, ctx, id);
      }
      let [op] = await db
        .select()
        .from(memorySyncOutbox)
        .where(
          and(
            eq(memorySyncOutbox.scope, ctx.scope),
            eq(memorySyncOutbox.memoryId, item.id),
          ),
        );
      if (!op) {
        const [replica] = await db
          .select()
          .from(memorySyncReplica)
          .where(
            and(
              eq(memorySyncReplica.scope, ctx.scope),
              eq(memorySyncReplica.memoryId, item.id),
            ),
          );
        if (replica?.generation === item.syncGeneration) continue;
        const record = item.status === 'forgotten' ? {} : memoryRecord(item);
        const reportRefs = { ...((record.reportRefs as Record<string, string>) ?? {}) };
        const links = await db
          .select()
          .from(memoryLink)
          .where(eq(memoryLink.fromMemoryId, item.id));
        // Upload references before publishing memory; retries use existing stable report keys.
        for (const link of links.filter(
          (l) => l.toKind === 'incident' && item.status !== 'forgotten',
        )) {
          if (reportRefs[link.toRef]) continue;
          const [saved] = await db
            .select()
            .from(investigations)
            .where(eq(investigations.id, link.toRef));
          if (saved?.project === ctx.repo && saved.report) {
            const result = await uploadInvestigationToCloud(
              ctx.client,
              ctx.config,
              {
                ...(saved.report as InvestigationReport),
                createdAt: saved.createdAt.toISOString(),
              },
              { db },
            );
            reportRefs[link.toRef] = result.investigationId;
          }
        }
        record.reportRefs = reportRefs;
        const reportIds = links
          .filter((l) => l.toKind === 'incident' && item.status !== 'forgotten')
          .map((l) => l.toRef);
        const labels = reportIds.length
          ? await db
              .select()
              .from(outcomeLabel)
              .where(inArray(outcomeLabel.investigationId, reportIds))
          : [];
        record.accuracyFeedback = labels.map(
          ({ id, investigationId, resolved, source, at, confirmedCause, note }) => ({
            id,
            investigationId,
            resolved,
            source,
            at: at.toISOString(),
            confirmedCause,
            note,
          }),
        );
        const audit = await db
          .select()
          .from(memoryAudit)
          .where(eq(memoryAudit.memoryId, item.id));
        const id = randomUUID();
        const request: Request = {
          operation: {
            id,
            baseRevision: replica?.revision ?? '0',
            ...(opts.restore === item.id ? { restore: true } : {}),
          },
          items: [
            {
              ...toSyncInput(item),
              evidence: record.evidence as never,
              ...(item.status === 'forgotten'
                ? { claim: '[Forgotten memory]', evidence: [] }
                : {}),
              record,
            },
          ],
          links: item.status === 'forgotten' ? [] : links.map(toLinkSyncInput),
          audit: (item.status === 'forgotten'
            ? audit.filter((a) => a.action === 'forget').slice(-1)
            : audit
          ).map(toAuditSyncInput),
        };
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('horus.sync_pull', '1', true)`);
          await tx
            .update(memoryItem)
            .set({
              syncScope: ctx.scope,
              orgId: ctx.config.organization?.id,
              workspaceId: ctx.config.workspace?.id,
              userId: ctx.userId,
            })
            .where(eq(memoryItem.id, item.id));
          await tx.insert(memorySyncOutbox).values({
            id,
            scope: ctx.scope,
            memoryId: item.id,
            generation: item.syncGeneration,
            request: redactCloudValue(request),
          });
        });
        [op] = await db
          .select()
          .from(memorySyncOutbox)
          .where(eq(memorySyncOutbox.id, id));
      }
      if (!op || op.conflict || op.nextAttemptAt.getTime() > Date.now()) continue;
      try {
        const result = await ctx.client.syncMemoryItems(
          ctx.config.project!.id,
          op.request as Request,
        );
        if (result.conflict) {
          await db
            .update(memorySyncOutbox)
            .set({ conflict: result.conflict, error: result.conflict.reason })
            .where(eq(memorySyncOutbox.id, op.id));
          continue;
        }
        if (result.operationId !== op.id || !result.revision)
          throw new Error('Cloud did not acknowledge the durable operation');
        await db.transaction(async (tx) => {
          await tx
            .insert(memorySyncReplica)
            .values({
              scope: ctx.scope,
              memoryId: item.id,
              revision: result.revision!,
              generation: op!.generation,
            })
            .onConflictDoUpdate({
              target: [memorySyncReplica.scope, memorySyncReplica.memoryId],
              set: { revision: result.revision!, generation: op!.generation },
            });
          await tx.delete(memorySyncOutbox).where(eq(memorySyncOutbox.id, op!.id));
          await tx
            .update(memorySyncState)
            .set({ lastPush: new Date(), error: null })
            .where(eq(memorySyncState.scope, ctx.scope));
        });
      } catch (error) {
        const message =
          error instanceof CloudError && error.status === 401
            ? 'Sign-in required: run horus login'
            : redactErrorMessage(error);
        await db
          .update(memorySyncOutbox)
          .set({
            attempts: op.attempts + 1,
            error: message,
            nextAttemptAt: new Date(
              Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(op.attempts, 6)),
            ),
          })
          .where(eq(memorySyncOutbox.id, op.id));
        throw new Error(message);
      }
    }
  } catch (error) {
    const message =
      error instanceof CloudError && error.status === 401
        ? 'Sign-in required: run horus login'
        : redactErrorMessage(error);
    await db
      .update(memorySyncState)
      .set({ error: message })
      .where(eq(memorySyncState.scope, ctx.scope));
  }
  return status(db, ctx);
}

export async function syncLinkedMemory(
  db: HorusDb,
  root: string,
  repo: string,
  opts: MemorySyncOptions & { startup?: boolean } = {},
): Promise<MemorySyncStatus> {
  const budget = opts.startup ? 1800 : 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  try {
    const ctx = memorySyncContext(root, repo, controller.signal);
    if (!ctx)
      return {
        state:
          readCloudConfig(root)?.context === 'cloud' ? 'Sign-in required' : 'Local only',
        eligible: 0,
        synced: 0,
        pending: 0,
        excluded: 0,
        failed: 0,
      };
    return await synchronizeMemory(db, ctx, {
      ...opts,
      pullOnly: opts.startup,
      deadline: Date.now() + budget,
    });
  } finally {
    clearTimeout(timer);
  }
}
