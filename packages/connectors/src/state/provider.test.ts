import { describe, it, expect } from 'vitest';
import { analyzeStateWith, type StateClient } from './provider.js';

/** A scripted in-memory StateClient — exercises the shared analysis loop without a datastore. */
function fakeClient(spec: {
  containers: string[];
  counts?: Record<string, number>;
  fields?: Record<string, string[]>;
  dates?: Record<string, string>;
  groups?: Record<string, Array<{ value: string; count: number }>>;
}): StateClient {
  return {
    async listCollections() {
      return spec.containers;
    },
    async count(c) {
      return spec.counts?.[c] ?? 0;
    },
    async sampleFields(c) {
      return spec.fields?.[c] ?? [];
    },
    async maxDate(c) {
      return spec.dates?.[c] ?? null;
    },
    async groupBy(c) {
      return spec.groups?.[c] ?? [];
    },
  };
}

describe('analyzeStateWith (shared by mongo + postgres)', () => {
  const now = Date.parse('2026-06-22T12:00:00Z');

  it('auto-discovers containers when no allowlist is given', async () => {
    const client = fakeClient({ containers: ['orders', 'jobs'], counts: { orders: 5, jobs: 2 } });
    const a = await analyzeStateWith(client, { database: 'db', collections: [], staleHours: 24 }, now);
    expect(a.autoDiscovered).toBe(true);
    expect(a.collections.map((c) => c.collection).sort()).toEqual(['jobs', 'orders']);
  });

  it('flags anomalous status buckets and stale activity', async () => {
    const client = fakeClient({
      containers: ['sync_jobs'],
      counts: { sync_jobs: 100 },
      fields: { sync_jobs: ['id', 'status', 'updatedAt'] },
      dates: { sync_jobs: '2026-06-01T00:00:00Z' }, // ~21d old -> stale at 24h
      groups: { sync_jobs: [{ value: 'ok', count: 80 }, { value: 'failed', count: 20 }] },
    });
    const a = await analyzeStateWith(client, { database: 'db', collections: ['sync_jobs'], staleHours: 24 }, now);
    const cs = a.collections[0]!;
    expect(cs.statusField).toBe('status');
    expect(cs.anomalies).toEqual([{ value: 'failed', count: 20 }]);
    expect(cs.isStale).toBe(true);
    expect(cs.classification).toBe('stale');
  });

  it('skips a container whose query throws without aborting the rest', async () => {
    const base = fakeClient({ containers: ['good', 'bad'], counts: { good: 1 } });
    const client: StateClient = {
      ...base,
      async count(c) {
        if (c === 'bad') throw new Error('permission denied');
        return 1;
      },
    };
    const a = await analyzeStateWith(client, { database: 'db', collections: ['good', 'bad'], staleHours: 24 }, now);
    expect(a.collections.map((c) => c.collection)).toEqual(['good']);
  });

  it('THROWS when EVERY configured container fails — a down DB is a gap, not a clean empty', async () => {
    const base = fakeClient({ containers: ['a', 'b'] });
    const client: StateClient = {
      ...base,
      async count() {
        throw new Error('connection refused');
      },
    };
    await expect(
      analyzeStateWith(client, { database: 'db', collections: ['a', 'b'], staleHours: 24 }, now),
    ).rejects.toThrow(/connection refused/);
  });
});
