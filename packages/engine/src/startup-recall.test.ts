import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalDb, type DbHandle } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import { recallStartupIncidents, type IncidentContext } from './memory-recall.js';
import { investigate } from './engine.js';
import type { LogsProvider } from '@horus/connectors';
let dir: string;
let handle: DbHandle;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recall-test-'));
  handle = await createLocalDb({ path: join(dir, 'db') });
});
afterEach(async () => {
  await handle.sql.end();
  await rm(dir, { recursive: true, force: true });
});
const audit = { actor: { kind: 'user' as const } };
async function seed(id: string, hint: string, errorCode: string, environment?: string, origin?: Partial<IncidentContext>) {
  return createLocalMemoryStore(handle.db).add(
    {
      id,
      kind: 'investigation',
      source: 'investigation',
      scope: 'repo',
      repo: 'shop',
      claim: hint,
      confidence: 0.9,
      payload: {
        hint,
        investigationId: id,
        outcome: {
          disposition: 'unknown',
          certainty: 'inferred',
          sourceInvestigation: id,
          sourceRefs: [],
          applicability: { errorCode, environment, ...origin },
          checks: ['Check reservation state and idempotency key'],
          invalidatingConditions: ['reservation already exists upstream'],
        },
      },
    },
    audit,
  );
}
it('separates stock/reserve families, labels unknown environments and rejects unrelated, wrong-scope and future history', async () => {
  await seed('stock', 'EMODA stock shortage dispatch retry', 'STOCK', 'production');
  await seed('reserve', 'EMODA reserve ETIMEDOUT 503', 'ETIMEDOUT');
  const store = createLocalMemoryStore(handle.db);
  const q = {
    repo: 'shop',
    hint: 'EMODA reserve ETIMEDOUT 503',
    environment: 'production',
    incident: { errorCode: 'ETIMEDOUT' },
  };
  const candidates = await recallStartupIncidents(store, q);
  expect(candidates.map((c) => c.memoryId)).toEqual(['reserve']);
  expect(candidates[0]!.environment).toContain('unknown');
  expect(candidates[0]!.outcome?.certainty).toBe('inferred');
  expect(await recallStartupIncidents(store, { ...q, repo: 'other' })).toEqual([]);
  expect(
    await recallStartupIncidents(store, {
      repo: 'shop',
      hint: 'payment token authentication rejected',
    }),
  ).toEqual([]);
  expect(await recallStartupIncidents(store, q, { now: new Date('2000-01-01') })).toEqual(
    [],
  );
  await store.setStatus('reserve', 'forgotten', audit);
  expect(await recallStartupIncidents(store, q)).toEqual([]);
});
it('repeated reports for the same provider event cannot crowd out another occurrence', async () => {
  const hint = 'EMODA reserve ETIMEDOUT 503';
  const origin = { source: 'elasticsearch', eventId: 'logs:event-a' };
  await seed('a-first', hint, 'ETIMEDOUT', 'production', origin);
  await seed('b-repeat', hint, 'ETIMEDOUT', 'production', origin);
  await seed('c-other', hint, 'ETIMEDOUT', 'production', { ...origin, eventId: 'logs:event-b' });
  const candidates = await recallStartupIncidents(createLocalMemoryStore(handle.db), {
    repo: 'shop', hint, environment: 'production', incident: { errorCode: 'ETIMEDOUT' },
  });
  expect(candidates.map(c => c.memoryId)).toEqual(['a-first', 'c-other']);
});
it('recalls the same specific logger message across codes without relaxing actual failure or outcome guards', async () => {
  await seed('catalog', 'EMODA_011_03 Fetch products error', 'EMODA_011_03', 'production', {
    source: 'elasticsearch', eventId: 'logs:catalog-a', fingerprint: 'EMODA_011_03', operation: 'catalog',
  });
  const store = createLocalMemoryStore(handle.db);
  const q = {
    repo: 'shop', environment: 'production', hint: 'EMODA_011_04 Fetch products error',
    incident: { source: 'elasticsearch', eventId: 'logs:catalog-b', eventCode: 'EMODA_011_04', fingerprint: 'EMODA_011_04', operation: 'catalog' },
  };
  const recalled = await recallStartupIncidents(store, q);
  expect(recalled.map(c => c.memoryId)).toEqual(['catalog']);
  expect(recalled[0]!.validation).toBe('unverified');
  expect(recalled[0]!.matchingFields).not.toContain('errorCode');
  expect(recalled[0]!.matchingFields).not.toContain('fingerprint');
  expect((await recallStartupIncidents(store, { ...q, incident: { ...q.incident, eventCode: undefined, errorCode: 'EMODA_011_04' } })).map(c => c.memoryId)).toEqual(['catalog']);
  for (const incident of [
    { ...q.incident, errorCode: 'STOCK' },
    { ...q.incident, fingerprint: 'EMODA_011_04:503' },
    { ...q.incident, operation: 'reserve' },
    { ...q.incident, source: 'pagerduty' },
    { ...q.incident, eventId: undefined },
  ]) expect(await recallStartupIncidents(store, { ...q, incident })).toEqual([]);
  expect(await recallStartupIncidents(store, { ...q, environment: 'staging' })).toEqual([]);
  await seed('wrapper', 'ERR243_07 Store client error.', 'ERR243_07', 'production', {
    source: 'elasticsearch', eventId: 'logs:wrapper-a', fingerprint: 'ERR243_07',
  });
  expect(await recallStartupIncidents(store, { ...q, hint: 'ERR243_05 Store client error.',
    incident: { source: 'elasticsearch', eventId: 'logs:wrapper-b', errorCode: 'ERR243_05', fingerprint: 'ERR243_05' } })).toEqual([]);
  const item = await store.get('catalog');
  const payload = item!.payload as Record<string, unknown>;
  await store.update('catalog', { payload: { ...payload, outcome: {
    ...(payload.outcome as object), disposition: 'confirmed-incident', certainty: 'confirmed',
    attester: 'Fixture', verifiedAt: '2026-09-27T00:00:00Z', sourceRefs: ['fixture:verification'],
  } } }, { audit });
  expect(await recallStartupIncidents(store, q)).toEqual([]);
});
it('runs a prior check before broad collection and current contradiction never confirms a historical explanation', async () => {
  await seed('reserve', 'EMODA reserve ETIMEDOUT 503', 'ETIMEDOUT', 'production');
  const order: string[] = [];
  const logs = {
    queryEvidence: vi.fn(async (query: import('@horus/connectors').LogQuery) => {
      // A supplier error code is not necessarily the logger's native event_code.
      expect(query).toMatchObject({ text: 'ETIMEDOUT', broadText: true });
      expect(query).not.toHaveProperty('eventCode');
      order.push('prior-check');
      return [
        {
          id: 'live-1',
          source: 'logs',
          kind: 'log',
          title: 'reservation already exists upstream',
          payload: {},
          links: {},
          provenance: {},
        },
      ];
    }),
    checkCompatibility: async () => ({ issues: [] }),
    analyzeErrors: async () => {
      order.push('broad');
      return { signatures: [], totalErrors: 0, window: {}, baseline: {} };
    },
  } as unknown as LogsProvider;
  const report = await investigate(
    {
      repo: 'shop',
      hint: 'EMODA reserve ETIMEDOUT 503',
      environment: 'production',
      incident: { errorCode: 'ETIMEDOUT' },
    },
    {
      db: handle.db,
      code: null,
      logs,
      store: createLocalMemoryStore(handle.db),
      onStartupRecall: () => {
        order.push('recall');
      },
    },
  );
  expect(order.slice(0, 3)).toEqual(['recall', 'prior-check', 'broad']);
  expect(report.recallTrace?.[0]?.stage).toBe('before-broad-collection');
  expect(report.recallTrace?.[0]?.evidenceIds).toHaveLength(1);
  expect(
    report.evidence.some((e) => e.id === report.recallTrace?.[0]?.evidenceIds[0]),
  ).toBe(true);
  expect(report.startupRecall?.[0]?.validation).toBe('contradicted');
  expect(report.confidence).toBeLessThan(0.9);
  expect(report.persisted).toBe(true);
});
