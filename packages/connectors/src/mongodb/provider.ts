import { MongoStateClient } from './client.js';
import { DatabaseStateProvider } from '../state/database-provider.js';
import { stateRecordQuerySchema, type StateRecordQuery } from '../state/record-query.js';
import type { Evidence } from '@horus/core';
export class MongoStateProvider extends DatabaseStateProvider {
  constructor(
    private readonly recordClient: MongoStateClient,
    opts: { database: string; collections: string[]; staleHours: number },
  ) {
    super('mongodb', recordClient, opts);
  }
  async queryRecords(input: StateRecordQuery): Promise<Evidence[]> {
    const query = stateRecordQuerySchema.parse(input);
    const records = await this.recordClient.records(query);
    const collectedAt = new Date().toISOString();
    return [
      {
        id: 'ev_mongo_records',
        source: 'state',
        kind: 'state',
        relevance: 0,
        title: `Targeted ${query.collection} lookup: ${records.length} record(s)`,
        payload: { collection: query.collection, records },
        links: {},
        provenance: { query: JSON.stringify(query), collectedAt },
      },
    ];
  }
}
