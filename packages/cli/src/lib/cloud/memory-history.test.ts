import { expect, it } from 'vitest';
import { memoryHistoryPages } from './memory-history.js';
import type { CloudClient } from './api.js';
type Request = Parameters<CloudClient['syncMemoryItems']>[1];
const snapshot = (n: number): Request => ({ operation: { id: 'root', baseRevision: '4' },
  items: [{ clientId: 'memory', record: { confidence: 0.7, evidence: [], reportRefs: { local: 'cloud' } } }],
  links: Array.from({ length: n }, (_, i) => ({ idempotencyKey: `l${i}`, fromClientId: 'memory', rel: 'caused-by', toKind: 'node', toRef: `node${i}` })),
  audit: Array.from({ length: n }, (_, i) => ({ clientAuditId: `a${i}`, memoryClientId: 'memory', action: 'link', actor: { kind: 'system' }, at: '2026-01-01T00:00:00Z' })),
});
it('preserves a previously valid operation for lost-ack replay', () => {
  const req = snapshot(2000);
  expect(memoryHistoryPages(req)).toEqual([req]);
});
it('pages previously invalid outbox snapshots without dropping links, audit or metadata', () => {
  const req = snapshot(2101);
  const pages = memoryHistoryPages(req);
  expect(pages.length).toBeGreaterThan(1);
  expect(memoryHistoryPages(req)).toEqual(pages);
  expect(pages.flatMap(p => p.links!)).toEqual(req.links);
  expect(pages.flatMap(p => p.audit!)).toEqual(req.audit);
  expect(pages.every(p => p.links!.length <= 500 && p.audit!.length <= 500 && Buffer.byteLength(JSON.stringify(p)) < 1024 * 1024 + 512)).toBe(true);
  expect(pages.at(-1)!.operation!.id).toBe('root');
  // Deployed older Cloud accepts only numeric revisions; no page can become a partial snapshot there.
  expect(pages.every(p => p.operation!.baseRevision === 'history:4' && !/^\d+$/.test(p.operation!.baseRevision))).toBe(true);
  expect(pages.map(p => p.history!.page)).toEqual(pages.map((_, i) => i));
  expect(Object.assign({}, ...pages.map(p => p.items![0]!.record!.reportRefs))).toEqual({ local: 'cloud' });
});
