/**
 * MongoStateProvider wiring tests (HOR-33). The shared analysis loop itself is
 * covered in ../state/provider.test.ts — these verify only the mongo-specific
 * wiring: provider identity, configured collections/staleHours reaching
 * `analyzeStateWith`, evidence provenance, and delegation to the underlying
 * client. A scripted client stands in for MongoDB.
 */

import { describe, it, expect } from 'vitest';
import { MongoStateProvider, type MongoStateClient } from './index.js';
import type { StateAnalysis } from '../state/analyze.js';

/** Scripted client: a failed status bucket, last active ~3h before the test runs. */
function fakeAnalysisClient(): MongoStateClient {
  return {
    async listCollections() {
      return ['discovered'];
    },
    async count() {
      return 10;
    },
    async sampleFields() {
      return ['status', 'updatedAt'];
    },
    async maxDate() {
      return new Date(Date.now() - 3 * 3_600_000).toISOString();
    },
    async groupBy() {
      return [{ value: 'failed', count: 2 }];
    },
  } as unknown as MongoStateClient;
}

describe('MongoStateProvider', () => {
  it('is a state provider with the expected identity', () => {
    const p = new MongoStateProvider(fakeAnalysisClient(), {
      database: 'app',
      collections: [],
      staleHours: 24,
    });
    expect(p.id).toBe('mongodb');
    expect(p.kind).toBe('state');
  });

  it('analyzeState runs the shared loop over the configured collections + staleHours', async () => {
    const p = new MongoStateProvider(fakeAnalysisClient(), {
      database: 'app',
      collections: ['sync_jobs'],
      staleHours: 24,
    });
    const a = await p.analyzeState();
    expect(a.database).toBe('app');
    expect(a.staleHours).toBe(24);
    expect(a.collections.map((c) => c.collection)).toEqual(['sync_jobs']);
    expect(a.collections[0]?.anomalies).toEqual([{ value: 'failed', count: 2 }]);
    expect(a.collections[0]?.isStale).toBe(false); // ~3h old, under the 24h threshold
  });

  it('forwards a per-call staleHours override into the loop', async () => {
    const p = new MongoStateProvider(fakeAnalysisClient(), {
      database: 'app',
      collections: ['sync_jobs'],
      staleHours: 24,
    });
    const a = await p.analyzeState({ staleHours: 1 });
    expect(a.staleHours).toBe(1);
    expect(a.collections[0]?.isStale).toBe(true); // ~3h old, over the 1h override
  });

  it('toEvidence emits state evidence with mongo.analyzeState provenance', () => {
    const analysis: StateAnalysis = {
      database: 'app',
      staleHours: 24,
      legacyHours: 2160,
      collections: [
        {
          collection: 'sync_jobs',
          count: 10,
          classification: 'active',
          statusField: 'status',
          anomalies: [{ value: 'failed', count: 2 }],
        },
      ],
    };
    const p = new MongoStateProvider(fakeAnalysisClient(), {
      database: 'app',
      collections: [],
      staleHours: 24,
    });
    const evidence = p.toEvidence(analysis);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.source).toBe('state');
    expect(evidence[0]?.title).toBe('sync_jobs: 2 record(s) in state "failed"');
    expect(evidence[0]?.provenance.query).toBe('mongo.analyzeState');
  });

  it('health / listCollections / close delegate to the client', async () => {
    let closed = false;
    const client = {
      async health() {
        return { ok: false, detail: 'down' };
      },
      async listCollections() {
        return ['a', 'b'];
      },
      async close() {
        closed = true;
      },
    } as unknown as MongoStateClient;
    const p = new MongoStateProvider(client, { database: 'app', collections: [], staleHours: 24 });
    expect(await p.health()).toEqual({ ok: false, detail: 'down' });
    expect(await p.listCollections()).toEqual(['a', 'b']);
    await p.close();
    expect(closed).toBe(true);
  });
});
