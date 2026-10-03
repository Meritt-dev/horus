/** Bounded pages of one frozen snapshot; Cloud publishes only the final page. */
import { and, asc, eq, memorySyncState, memorySyncPullPage, type HorusDb } from '@horus/db';
import { CloudError, type CloudClient, type MemoryItemRecord } from './api.js';
import type { MemorySyncContext } from './memory-sync.js';
type Request = Parameters<CloudClient['syncMemoryItems']>[1];
const ROWS = 500;
const BYTES = 1024 * 1024;
export function memoryHistoryPages(request: Request): Request[] {
  const item = request.items?.[0];
  if (!item || !request.operation) throw new Error('History requires one revisioned memory');
  const { reportRefs = {}, accuracyFeedback = [], evidence = [], ...record } = item.record ?? {};
  // Keep any previously valid request byte-for-byte: its operation may already
  // have a receipt whose response was lost. Only previously rejected snapshots split.
  if ((request.links?.length ?? 0) <= 2000 && (request.audit?.length ?? 0) <= 2000 &&
      (accuracyFeedback as unknown[]).length <= 2000 && (evidence as unknown[]).length <= 2000 &&
      Buffer.byteLength(JSON.stringify(request)) <= 6 * 1024 * 1024) return [request];
  const base = { ...request, items: [{ ...item, evidence: undefined, record }], links: [], audit: [] } as Request;
  const pages: Request[] = [];
  let page: Request = structuredClone(base);
  const add = (field: string, values: unknown[]) => {
    for (const value of values) {
      const append = (target: Request) => {
        if (field === 'links') target.links!.push(value as never);
        else if (field === 'audit') target.audit!.push(value as never);
        else {
          const rec = target.items![0]!.record!;
          if (field === 'reportRefs') {
            const [key, ref] = value as [string, string];
            (rec.reportRefs ??= {} as Record<string, string>);
            (rec.reportRefs as Record<string, string>)[key] = ref;
          } else ((rec[field] ??= []) as unknown[]).push(value);
        }
      };
      const candidate = structuredClone(page);
      append(candidate);
      const count = field === 'links' ? candidate.links!.length : field === 'audit' ? candidate.audit!.length
        : field === 'reportRefs' ? Object.keys(candidate.items![0]!.record!.reportRefs as object).length
        : (candidate.items![0]!.record![field] as unknown[]).length;
      if (count > ROWS || Buffer.byteLength(JSON.stringify(candidate)) > BYTES) {
        pages.push(page); page = structuredClone(base); append(page);
        if (Buffer.byteLength(JSON.stringify(page)) > BYTES) throw new Error('Memory field exceeds bounded sync page size');
      } else page = candidate;
    }
  };
  add('links', request.links ?? []); add('audit', request.audit ?? []);
  add('reportRefs', Object.entries(reportRefs as object));
  add('accuracyFeedback', accuracyFeedback as unknown[]); add('evidence', evidence as unknown[]);
  pages.push(page);
  if (pages.length === 1) return [request]; // Retain the existing wire contract for small records.
  if (pages.length > 4096) throw new Error('Memory history exceeds 4096 sync pages');
  return pages.map((body, i) => ({ ...body,
    operation: { ...request.operation!, baseRevision: `history:${request.operation!.baseRevision}`, id: i === pages.length - 1 ? request.operation!.id : `${request.operation!.id}/history/${i}` },
    history: { operationId: request.operation!.id, page: i, pages: pages.length },
  }));
}

interface PullProgress {
  memoryId: string; revision: string; linkCursor?: string; auditCursor?: string;
  linkPage: number; auditPage: number; linksDone: boolean; auditDone: boolean;
}
/** Every downloaded page and its cursor commit together. Deadlines never discard progress. */
export async function hydrateMemoryHistory(db: HorusDb, ctx: MemorySyncContext,
  row: MemoryItemRecord, deadline: number): Promise<MemoryItemRecord> {
  if (!row.historyPaged) return row;
  const [state] = await db.select().from(memorySyncState).where(eq(memorySyncState.scope, ctx.scope));
  const saved = state?.pullProgress as PullProgress | null;
  let progress: PullProgress = saved && saved.memoryId === row.id && saved.revision === row.revision
    ? saved : { memoryId: row.id, revision: row.revision!, linkPage: 0, auditPage: 0, linksDone: false, auditDone: false };
  if (progress !== saved) {
    await db.transaction(async tx => {
      await tx.delete(memorySyncPullPage).where(eq(memorySyncPullPage.scope, ctx.scope));
      await tx.update(memorySyncState).set({ pullProgress: progress }).where(eq(memorySyncState.scope, ctx.scope));
    });
  }
  try {
    for (const stream of ['links', 'audit'] as const) {
      const done = stream === 'links' ? 'linksDone' : 'auditDone';
      const cursor = stream === 'links' ? 'linkCursor' : 'auditCursor';
      const pageKey = stream === 'links' ? 'linkPage' : 'auditPage';
      while (!progress[done]) {
        if (Date.now() >= deadline) throw new Error('Memory history pull paused; resume from saved page');
        const query = { memoryItemId: row.id, expectedRevision: row.revision!, cursor: progress[cursor] };
        const result = stream === 'links'
          ? await ctx.client.listMemoryLinks(ctx.config.project!.id, query)
          : await ctx.client.listMemoryAudit(ctx.config.project!.id, query);
        const rows = 'links' in result ? result.links : result.audit;
        const next: PullProgress = { ...progress, [cursor]: result.nextCursor, [done]: !result.nextCursor, [pageKey]: progress[pageKey] + 1 };
        await db.transaction(async tx => {
          await tx.insert(memorySyncPullPage).values({ scope: ctx.scope, memoryId: row.id,
            revision: row.revision!, stream, page: progress![pageKey], rows });
          await tx.update(memorySyncState).set({ pullProgress: next }).where(eq(memorySyncState.scope, ctx.scope));
        });
        progress = next;
      }
    }
  } catch (e) {
    if (e instanceof CloudError && e.status === 409) await db.transaction(async tx => {
      await tx.delete(memorySyncPullPage).where(eq(memorySyncPullPage.scope, ctx.scope));
      await tx.update(memorySyncState).set({ pullProgress: null }).where(eq(memorySyncState.scope, ctx.scope));
    });
    throw e;
  }
  const pages = await db.select().from(memorySyncPullPage).where(and(eq(memorySyncPullPage.scope, ctx.scope),
    eq(memorySyncPullPage.memoryId, row.id), eq(memorySyncPullPage.revision, row.revision!)))
    .orderBy(asc(memorySyncPullPage.page));
  return { ...row,
    links: pages.filter(p => p.stream === 'links').flatMap(p => p.rows as NonNullable<MemoryItemRecord['links']>),
    audit: pages.filter(p => p.stream === 'audit').flatMap(p => p.rows as NonNullable<MemoryItemRecord['audit']>),
  };
}
