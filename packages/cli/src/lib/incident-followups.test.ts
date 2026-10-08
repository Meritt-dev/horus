import { expect, it, vi } from 'vitest';
import { stateRecordQuerySchema } from '@horus/connectors';
import type { Evidence } from '@horus/core';
import type { InvestigationContext } from './investigation-runner.js';
import type { IncidentEvent } from './watch-store.js';
import { collectIncidentCheck, incidentWindowCheck } from './incident-followups.js';
import { validateClaudeResult } from './claude-investigation.js';
import type { InvestigationReport } from '@horus/engine';

const event = {
  occurredAt: '2026-10-07T19:47:49Z',
  source: 'pagerduty',
  service: 'SAFQA GraphQL API',
} as IncidentEvent;
const evidence = {
  id: 'provider-id',
  title: 'Stock update rejected',
  payload: { error: 'Not stocked', token: 'private' },
} as unknown as Evidence;

it('collects narrow runtime logs using configured service, retaining provider payload and new citation identity', async () => {
  const searchLogs = vi.fn().mockResolvedValue([{ message: 'Not stocked' }]);
  const context = {
    service: 'scheduler',
    logs: { searchLogs, toEvidence: () => [evidence] },
  } as unknown as InvestigationContext;
  const check = {
    ...incidentWindowCheck(event),
    where: [{ field: 'context.run_id', value: 'run-1' }],
  } as ReturnType<typeof incidentWindowCheck>;
  const result = await collectIncidentCheck(check, context, event);
  expect(searchLogs).toHaveBeenCalledWith(
    expect.objectContaining({
      service: 'scheduler',
      where: [{ field: 'context.run_id', value: 'run-1' }],
      limit: 100,
    }),
  );
  expect(result.id).not.toBe('provider-id');
  expect(JSON.stringify(result)).toContain('Not stocked');
  expect(JSON.stringify(result)).not.toContain('private');
  expect((await collectIncidentCheck(check, context, event)).id).toBe(result.id);
});

it('records empty and failed reads explicitly, and rejects an unbounded log window before provider access', async () => {
  const searchLogs = vi.fn().mockResolvedValue([]);
  const context = {
    logs: { searchLogs, toEvidence: () => [] },
  } as unknown as InvestigationContext;
  const empty = await collectIncidentCheck(incidentWindowCheck(event), context, event);
  expect(empty.payload).toMatchObject({ evidence: [] });
  const invalid = await collectIncidentCheck(
    { kind: 'logs', from: '2026-10-01T00:00:00Z', to: '2026-10-07T23:00:00Z', where: [] },
    context,
    event,
  );
  expect(invalid.payload).toMatchObject({
    evidence: [],
    error: expect.stringContaining('one hour'),
  });
  expect(searchLogs).toHaveBeenCalledTimes(1);
});

it('requires projected equality reads and refuses operators and sensitive field paths', () => {
  const query = {
    collection: 'workflow_runs',
    where: [{ field: '_id', value: '6ac6a13cdd510965bffb708d' }],
    fields: ['steps.items.error_message'],
  };
  expect(stateRecordQuerySchema.parse(query).limit).toBe(1);
  for (const field of [
    '$where',
    'steps.$[].token',
    'store_access_token.value',
    '__proto__',
  ]) {
    expect(() => stateRecordQuerySchema.parse({ ...query, fields: [field] })).toThrow();
  }
  expect(() =>
    stateRecordQuerySchema.parse({
      ...query,
      where: [{ field: '_id', value: { $ne: '' } }],
    }),
  ).toThrow();
  expect(() => stateRecordQuerySchema.parse({ ...query, where: [] })).toThrow();
});

it('allows a subsequent diagnosis to cite newly persisted evidence and rejects invented IDs or pending checks on supported results', () => {
  const report = {
    id: 'c2de50b7-267f-4b93-85c8-ef0b906c7b3e',
    evidence: [{ id: 'new-read' }],
  } as InvestigationReport;
  const result = {
    reportId: report.id,
    summary: 'Missing activation',
    likelyCause: 'Item is not stocked',
    confidence: 0.8,
    evidenceIds: ['new-read'],
    historicalMemoryIds: [],
    nextChecks: ['Review fix PR'],
    uncertainty: 'Historical location cannot be independently inspected',
    diagnosis: 'supported',
    checks: [],
    codeFix: null,
  };
  const envelope = (value: unknown) =>
    JSON.stringify({
      type: 'result',
      is_error: false,
      session_id: 'session',
      result: JSON.stringify(value),
    });
  expect(validateClaudeResult(envelope(result), report).result.diagnosis).toBe(
    'supported',
  );
  expect(() =>
    validateClaudeResult(envelope({ ...result, evidenceIds: ['invented'] }), report),
  ).toThrow('unknown evidence');
  expect(() =>
    validateClaudeResult(
      envelope({ ...result, checks: [incidentWindowCheck(event)] }),
      report,
    ),
  ).toThrow('pending checks');
});

it('counts provider observations rather than empty wrappers or null Shopify nodes', async () => {
  const context = {
    mongo: { queryRecords: async () => [{ payload: { records: [] } }] },
    shopify: {
      collect: vi.fn().mockResolvedValue([{ data: { nodes: [null, null] } }]),
      toEvidence: () => [{ payload: { data: { nodes: [null, null] } } }],
    },
  } as unknown as InvestigationContext;
  const state = await collectIncidentCheck(
    {
      kind: 'state',
      query: {
        collection: 'workflow_runs',
        where: [{ field: 'status', value: 'FAILED' }],
        fields: ['status'],
        limit: 1,
      },
    },
    context,
    event,
  );
  expect(state.payload).toMatchObject({ observations: 0 });
  const check = {
    kind: 'shopify-variants' as const,
    ids: ['gid://shopify/ProductVariant/123'],
    locationId: 'gid://shopify/Location/456',
  };
  expect((await collectIncidentCheck(check, context, event)).payload).toMatchObject({
    observations: 0,
  });
  vi.mocked(context.shopify!.collect).mockResolvedValue([
    { errors: [{ message: 'Denied' }] },
  ] as never);
  expect((await collectIncidentCheck(check, context, event)).payload).toMatchObject({
    observations: 0,
    evidence: [],
    error: expect.stringContaining('GraphQL errors'),
  });
});
