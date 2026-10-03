/** Bounded pages of one frozen snapshot; Cloud publishes only the final page. */
import type { CloudClient } from './api.js';
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
