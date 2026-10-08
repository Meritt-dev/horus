import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Evidence } from '@horus/core';
import { recordFieldSchema, stateRecordQuerySchema } from '@horus/connectors';
import type { InvestigationContext } from './investigation-runner.js';
import type { IncidentEvent } from './watch-store.js';
import { redactCloudValue } from './cloud/investigation-sync.js';

export const incidentCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('logs'),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
      text: z.string().min(1).max(512).optional(),
      service: z.string().min(1).max(200).optional(),
      where: z
        .array(
          z
            .object({ field: recordFieldSchema, value: z.string().min(1).max(512) })
            .strict(),
        )
        .max(8)
        .default([]),
    })
    .strict(),
  z.object({ kind: z.literal('state'), query: stateRecordQuerySchema }).strict(),
  z
    .object({
      kind: z.literal('shopify-variants'),
      ids: z
        .array(z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/))
        .min(1)
        .max(10),
      locationId: z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/),
    })
    .strict(),
]);
export type IncidentCheck = z.infer<typeof incidentCheckSchema>;
export const checkKey = (check: IncidentCheck) =>
  createHash('sha256').update(JSON.stringify(check)).digest('hex').slice(0, 24);

/** Provider reads produce citable evidence; model text never does. Empty/error results remain explicit. */
export async function collectIncidentCheck(
  input: IncidentCheck,
  context: InvestigationContext,
  event: IncidentEvent,
): Promise<Evidence> {
  const check = incidentCheckSchema.parse(input);
  const collectedAt = new Date().toISOString();
  let rows: Evidence[] = [];
  let observations = 0;
  let error: string | undefined;
  try {
    if (check.kind === 'logs') {
      const start = Date.parse(check.from),
        end = Date.parse(check.to),
        incident = Date.parse(event.occurredAt);
      if (
        end < start ||
        end - start > 3600_000 ||
        Math.abs(start - incident) > 86400_000 ||
        Math.abs(end - incident) > 86400_000
      )
        throw new Error(
          'Log checks must span at most one hour within one day of the incident',
        );
      if (!context.logs) throw new Error('No configured logs provider');
      const records = await context.logs.searchLogs({
        from: check.from,
        to: check.to,
        service: check.service ?? context.service,
        text: check.text,
        broadText: true,
        where: check.where,
        limit: 100,
        ...(!check.text && !check.where.length ? { level: 'error' as const } : {}),
      });
      rows = context.logs.toEvidence(records);
      observations = records.length;
    } else if (check.kind === 'state') {
      if (!context.mongo?.queryRecords)
        throw new Error('No configured projected-record provider');
      rows = await context.mongo.queryRecords(check.query);
      observations = rows.reduce(
        (count, row) =>
          count + ((row.payload as { records?: unknown[] })?.records?.length ?? 0),
        0,
      );
    } else {
      if (!context.shopify) throw new Error('No configured Shopify provider');
      const records = await context.shopify.collect({
        queries: [
          {
            name: 'incident-variant-location',
            kind: 'state',
            query:
              'query IncidentVariantLocation($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on ProductVariant{id sku product{id title} inventoryItem{id tracked inventoryLevel(locationId:$location){id quantities(names:["available"]){name quantity}}}}}}',
            variables: { ids: check.ids, location: check.locationId },
          },
        ],
      });
      if (records.some((record) => record.errors?.length))
        throw new Error('Shopify query returned GraphQL errors');
      observations = records.reduce(
        (count, record) =>
          count +
          ((record.data as { nodes?: unknown[] })?.nodes?.filter(Boolean).length ?? 0),
        0,
      );
      rows = context.shopify.toEvidence(records, [], collectedAt);
    }
    if (Buffer.byteLength(JSON.stringify(rows)) > 128000)
      throw new Error('Check exceeds evidence budget; narrow the query');
  } catch (cause) {
    error = String(cause instanceof Error ? cause.message : cause).slice(0, 2000);
    rows = [];
    observations = 0;
  }
  return redactCloudValue({
    id: `ev_followup_${checkKey(check)}`,
    source: check.kind === 'logs' ? 'logs' : 'state',
    kind: check.kind === 'logs' ? 'log' : 'state',
    relevance: 0,
    title: `Targeted ${check.kind} check: ${error ? 'unavailable' : rows.length + ' evidence item(s)'}`,
    payload: {
      followup: true,
      observations,
      check,
      evidence: rows,
      ...(error && { error }),
    },
    links: {},
    provenance: { query: JSON.stringify(check), collectedAt },
  } satisfies Evidence);
}

export function incidentWindowCheck(event: IncidentEvent): IncidentCheck {
  const at = Date.parse(event.occurredAt);
  return {
    kind: 'logs',
    from: new Date(at - 10 * 60_000).toISOString(),
    to: new Date(at + 2 * 60_000).toISOString(),
    where: [],
  };
}
