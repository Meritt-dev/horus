import { z } from 'zod';
import { runtimeSchemas, redactErrorMessage, type RuntimeConfig } from '@horus/core';
import { nativeOutput } from '../cloud-logs/native-cli.js';
import { fetchWithRetry } from '../http.js';
import { DATE_FIELDS, STATUS_FIELDS } from '../state/analyze.js';
import type { StateClient } from '../state/provider.js';
const valueSchema = z
  .object({
    stringValue: z.string().optional(),
    timestampValue: z.string().optional(),
    integerValue: z.string().optional(),
  })
  .passthrough();
const rowsSchema = z.array(
  z.object({
    document: z.object({ fields: z.record(valueSchema).optional() }).optional(),
    result: z.object({ aggregateFields: z.record(valueSchema) }).optional(),
  }),
);
/** Explicit collection paths, aggregates and date/status projections; no customer document export. */
export class FirestoreStateClient implements StateClient {
  readonly config: RuntimeConfig['firestore'];
  private token?: { value: string; until: number };
  constructor(config: RuntimeConfig['firestore']) {
    this.config = runtimeSchemas.firestore.parse(config);
  }
  private scope(collection: string) {
    if (!this.config.collections.includes(collection))
      throw new Error('Collection is not allowlisted');
    const parts = collection.split('/');
    const collectionId = parts.pop()!;
    return {
      parent: `https://firestore.googleapis.com/v1/projects/${this.config.project}/databases/${this.config.database}/documents${parts.length ? '/' + parts.map(encodeURIComponent).join('/') : ''}`,
      from: [{ collectionId }],
    };
  }
  private async request(
    collection: string,
    query: Record<string, unknown>,
    aggregate = false,
  ) {
    const { parent, from } = this.scope(collection);
    if (!this.token || this.token.until < Date.now())
      this.token = {
        value: await nativeOutput(this.config.executable, [
          'auth',
          'print-access-token',
          '--quiet',
        ]),
        until: Date.now() + 5 * 60000,
      };
    const structuredQuery = { from, ...query };
    const body = aggregate
      ? {
          structuredAggregationQuery: {
            structuredQuery,
            aggregations: [{ alias: 'count', count: {} }],
          },
        }
      : { structuredQuery };
    const r = await fetchWithRetry(
      parent + (aggregate ? ':runAggregationQuery' : ':runQuery'),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token.value}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: 15000 },
    );
    if (!r.ok) {
      if (r.status === 401) this.token = undefined;
      throw new Error(`Firestore HTTP ${r.status}`);
    }
    return rowsSchema.parse(await r.json());
  }
  async listCollections() {
    return [...this.config.collections];
  }
  private async aggregate(collection: string, where?: unknown) {
    const rows = await this.request(collection, where ? { where } : {}, true);
    const n = Number(
      rows.find((x) => x.result)?.result?.aggregateFields.count?.integerValue,
    );
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error('Invalid Firestore aggregate count');
    return n;
  }
  count(collection: string) {
    return this.aggregate(collection);
  }
  async sampleFields(collection: string) {
    const fields = [...DATE_FIELDS, ...STATUS_FIELDS];
    const rows = await this.request(collection, {
      select: { fields: fields.map((fieldPath) => ({ fieldPath })) },
      limit: 20,
    });
    return [...new Set(rows.flatMap((x) => Object.keys(x.document?.fields ?? {})))];
  }
  private field(field: string) {
    if (![...DATE_FIELDS, ...STATUS_FIELDS].includes(field))
      throw new Error('Unsupported state field');
    return { fieldPath: field };
  }
  async maxDate(collection: string, field: string) {
    const f = this.field(field);
    const rows = await this.request(collection, {
      select: { fields: [f] },
      orderBy: [{ field: f, direction: 'DESCENDING' }],
      limit: 1,
    });
    const v = rows.find((x) => x.document)?.document?.fields?.[field];
    const date = v?.timestampValue ?? v?.stringValue;
    if (!date) return null;
    const ms = Date.parse(date);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  async groupBy(collection: string, field: string) {
    const f = this.field(field);
    // ponytail: discover at most 25 statuses from 200 projected documents; add explicit status filters if exhaustive coverage is needed.
    const rows = await this.request(collection, { select: { fields: [f] }, limit: 200 });
    const values = [
      ...new Set(
        rows.flatMap((x) => {
          const v = x.document?.fields?.[field]?.stringValue;
          return v === undefined ? [] : [v];
        }),
      ),
    ].slice(0, 25);
    const out = [];
    for (const value of values)
      out.push({
        value,
        count: await this.aggregate(collection, {
          fieldFilter: { field: f, op: 'EQUAL', value: { stringValue: value } },
        }),
      });
    return out;
  }
  async health() {
    try {
      await this.request(this.config.collections[0]!, {
        select: { fields: [] },
        limit: 1,
      });
      return { ok: true, detail: 'Firestore collection read access verified' };
    } catch (e) {
      return { ok: false, detail: redactErrorMessage(e) };
    }
  }
  async close() {
    this.token = undefined;
  }
}
