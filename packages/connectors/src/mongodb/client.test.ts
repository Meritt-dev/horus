/**
 * MongoStateClient unit tests (HOR-33). The mongodb driver module is mocked with
 * vi.mock so connection/option handling, the collection allowlist gate, and the
 * StateClient seam (count / sampleFields / maxDate / groupBy) that
 * `analyzeStateWith` relies on are verified without a real server. No I/O here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MongoStateClient } from './index.js';

// Hoisted control state read by the mocked driver — reset before every test.
const driver = vi.hoisted(() => ({
  constructed: [] as Array<{ url: string; options: Record<string, unknown> }>,
  connectCalls: 0,
  closeCalls: 0,
  connectError: null as Error | null,
  pingError: null as Error | null,
  dbNames: [] as string[],
  collectionDocs: [] as Array<{ name?: string }>,
  collections: new Map<string, unknown>(),
}));

vi.mock('mongodb', () => {
  class MongoClient {
    constructor(url: string, options: Record<string, unknown>) {
      driver.constructed.push({ url, options });
    }
    async connect(): Promise<void> {
      driver.connectCalls += 1;
      if (driver.connectError !== null) throw driver.connectError;
    }
    db(name: string) {
      driver.dbNames.push(name);
      return {
        listCollections: () => ({ toArray: async () => driver.collectionDocs }),
        command: async () => {
          if (driver.pingError !== null) throw driver.pingError;
          return { ok: 1 };
        },
        collection: (collName: string) => driver.collections.get(collName),
      };
    }
    async close(): Promise<void> {
      driver.closeCalls += 1;
    }
  }
  return { MongoClient };
});

beforeEach(() => {
  driver.constructed = [];
  driver.connectCalls = 0;
  driver.closeCalls = 0;
  driver.connectError = null;
  driver.pingError = null;
  driver.dbNames = [];
  driver.collectionDocs = [];
  driver.collections.clear();
});

/** Scripted read-only collection covering every driver call the client makes. */
function fakeCollection(spec: {
  count?: number;
  latestDoc?: Record<string, unknown> | null;
  groupRows?: Array<Record<string, unknown>>;
  newestDateDoc?: Record<string, unknown> | null;
}) {
  const calls: {
    countFilter?: unknown;
    findOneOpts?: Record<string, unknown>;
    pipeline?: unknown[];
    findFilter?: unknown;
    sort?: unknown;
  } = {};
  const cursor = {
    project: (_p: unknown) => cursor,
    sort: (s: unknown) => {
      calls.sort = s;
      return cursor;
    },
    limit: (_n: number) => cursor,
    next: async () => spec.newestDateDoc ?? null,
  };
  return {
    calls,
    countDocuments: async (filter: unknown) => {
      calls.countFilter = filter;
      return spec.count ?? 0;
    },
    findOne: async (_f: unknown, opts: Record<string, unknown>) => {
      calls.findOneOpts = opts;
      return spec.latestDoc ?? null;
    },
    aggregate: (pipeline: unknown[]) => {
      calls.pipeline = pipeline;
      return { toArray: async () => spec.groupRows ?? [] };
    },
    find: (filter: unknown) => {
      calls.findFilter = filter;
      return cursor;
    },
  };
}

function makeClient(over: Partial<{ url: string; database: string; allowlist: string[] }> = {}) {
  return new MongoStateClient({
    url: over.url ?? 'mongodb://mongo.local:27017',
    database: over.database ?? 'app',
    allowlist: over.allowlist ?? [],
  });
}

describe('MongoStateClient connection handling', () => {
  it('connects once with a 5s selection timeout + secondaryPreferred and reuses the client', async () => {
    driver.collectionDocs = [{ name: 'orders' }];
    const client = makeClient();
    await client.listCollections();
    await client.listCollections();
    expect(driver.connectCalls).toBe(1);
    expect(driver.constructed).toEqual([
      {
        url: 'mongodb://mongo.local:27017',
        options: { serverSelectionTimeoutMS: 5000, readPreference: 'secondaryPreferred' },
      },
    ]);
    expect(driver.dbNames[0]).toBe('app');
  });

  it('close() shuts the driver down and the next call reconnects', async () => {
    const client = makeClient();
    await client.listCollections();
    await client.close();
    expect(driver.closeCalls).toBe(1);
    await client.listCollections();
    expect(driver.connectCalls).toBe(2);
  });

  it('close() before any query is a no-op', async () => {
    await makeClient().close();
    expect(driver.closeCalls).toBe(0);
  });
});

describe('listCollections', () => {
  it('returns collection names, dropping unnamed entries', async () => {
    driver.collectionDocs = [{ name: 'orders' }, {}, { name: 'sync_jobs' }];
    expect(await makeClient().listCollections()).toEqual(['orders', 'sync_jobs']);
  });
});

describe('allowlist gate', () => {
  it('rejects a non-allowlisted collection before touching the driver', async () => {
    const client = makeClient({ allowlist: ['orders'] });
    await expect(client.count('users')).rejects.toThrow(
      'Collection "users" is not allowlisted for app',
    );
    expect(driver.connectCalls).toBe(0);
  });

  it('permits allowlisted collections, and everything in auto-discover mode (empty allowlist)', async () => {
    driver.collections.set('orders', fakeCollection({ count: 7 }));
    expect(await makeClient({ allowlist: ['orders'] }).count('orders')).toBe(7);
    driver.collections.set('anything', fakeCollection({ count: 3 }));
    expect(await makeClient().count('anything')).toBe(3);
  });
});

describe('StateClient seam (what analyzeStateWith relies on)', () => {
  it('count() forwards the filter to countDocuments', async () => {
    const coll = fakeCollection({ count: 42 });
    driver.collections.set('jobs', coll);
    expect(await makeClient().count('jobs', { status: 'failed' })).toBe(42);
    expect(coll.calls.countFilter).toEqual({ status: 'failed' });
  });

  it('sampleFields() returns the newest document field names (sorted by _id desc)', async () => {
    const coll = fakeCollection({ latestDoc: { _id: 1, status: 'ok', updatedAt: new Date() } });
    driver.collections.set('jobs', coll);
    expect(await makeClient().sampleFields('jobs')).toEqual(['_id', 'status', 'updatedAt']);
    expect(coll.calls.findOneOpts).toEqual({ sort: { _id: -1 }, projection: {} });
  });

  it('sampleFields() is [] for an empty collection', async () => {
    driver.collections.set('empty', fakeCollection({ latestDoc: null }));
    expect(await makeClient().sampleFields('empty')).toEqual([]);
  });

  it('maxDate() queries only date-typed values, newest first, and returns an ISO string', async () => {
    const coll = fakeCollection({ newestDateDoc: { updatedAt: new Date('2026-06-20T10:00:00Z') } });
    driver.collections.set('jobs', coll);
    expect(await makeClient().maxDate('jobs', 'updatedAt')).toBe('2026-06-20T10:00:00.000Z');
    expect(coll.calls.findFilter).toEqual({ updatedAt: { $type: 'date' } });
    expect(coll.calls.sort).toEqual({ updatedAt: -1 });
  });

  it('maxDate() passes string values through and is null when no document matches', async () => {
    driver.collections.set(
      'str',
      fakeCollection({ newestDateDoc: { syncedAt: '2026-06-01T00:00:00Z' } }),
    );
    expect(await makeClient().maxDate('str', 'syncedAt')).toBe('2026-06-01T00:00:00Z');
    driver.collections.set('none', fakeCollection({ newestDateDoc: null }));
    expect(await makeClient().maxDate('none', 'syncedAt')).toBeNull();
  });

  it('groupBy() aggregates by field with the default top-25 limit and normalizes rows', async () => {
    const coll = fakeCollection({
      groupRows: [
        { _id: 'failed', count: 20 },
        { _id: null, count: 3 },
        { _id: 'weird', count: 'NaN' },
      ],
    });
    driver.collections.set('jobs', coll);
    expect(await makeClient().groupBy('jobs', 'status')).toEqual([
      { value: 'failed', count: 20 },
      { value: '(none)', count: 3 },
      { value: 'weird', count: 0 },
    ]);
    expect(coll.calls.pipeline).toEqual([
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 25 },
    ]);
  });
});

describe('health()', () => {
  it('is ok with a database-reachable detail when ping succeeds', async () => {
    expect(await makeClient().health()).toEqual({ ok: true, detail: 'mongodb app reachable' });
  });

  it('is ok:false with a redacted detail when connect echoes URI credentials', async () => {
    driver.connectError = new Error(
      'MongoServerSelectionError: connect ECONNREFUSED mongodb://user:s3cret@mongo.internal:27017/app',
    );
    const health = await makeClient({ url: 'mongodb://user:s3cret@mongo.internal:27017' }).health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain('s3cret');
    expect(health.detail).toContain('mongodb://[REDACTED]@mongo.internal:27017/app');
  });

  it('is ok:false when the ping command fails after connecting', async () => {
    driver.pingError = new Error('not primary');
    expect(await makeClient().health()).toEqual({ ok: false, detail: 'not primary' });
  });
});
