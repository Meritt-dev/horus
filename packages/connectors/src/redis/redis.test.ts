/**
 * HOR-201 — Redis multi-DB connector: scan client, factory DB selection, and the
 * state-evidence provider. Uses fakes (no real Redis) so the logic is verified in CI.
 */
import { describe, it, expect } from 'vitest';
import type { ResolvedEnvironment } from '@horus/core';
import { RedisScanClient, type KeyPrefixSample } from './scan-client.js';
import { RedisStateRuntimeProvider, type RedisStateDb, type ScanLike } from './state-provider.js';
import { queueDatabaseForEnv, stateDatabasesForEnv, queueForEnv, redisStateForEnv } from '../factory.js';

// --- RedisScanClient (fake ioredis via the private field) ------------------

function withScan(client: RedisScanClient, keysFor: (pattern: string) => string[]): void {
  (client as unknown as { redis: unknown }).redis = {
    scan: async (_c: string, _m: string, pattern: string) => ['0', keysFor(pattern)],
  };
}

describe('RedisScanClient', () => {
  it('detectBullmqQueues scans :meta and extracts names', async () => {
    const c = new RedisScanClient({ url: 'redis://h:6379', db: 1 });
    let seen = '';
    withScan(c, (p) => {
      seen = p;
      return ['bull:SEED_INSTA:meta', 'bull:GAIA_FULL_SYNC:meta'];
    });
    expect((await c.detectBullmqQueues('bull')).sort()).toEqual(['GAIA_FULL_SYNC', 'SEED_INSTA']);
    expect(seen).toBe('bull:*:meta');
  });

  it('samplePrefixes groups keys by leading segment', async () => {
    const c = new RedisScanClient({ url: 'redis://h:6379', db: 0 });
    withScan(c, () => ['shopify:1', 'shopify:2', 'lock:a', 'metrics:x', 'metrics:y', 'metrics:z']);
    const prefixes = await c.samplePrefixes(100);
    const top = prefixes[0];
    expect(top?.prefix).toBe('metrics');
    expect(top?.count).toBe(3);
    expect(prefixes.find((p) => p.prefix === 'shopify')?.count).toBe(2);
    expect(prefixes.find((p) => p.prefix === 'lock')?.count).toBe(1);
  });
});

// --- Factory DB selection (pure logic on ResolvedEnvironment) ---------------

function envWith(databases: unknown): ResolvedEnvironment {
  return {
    connectors: { redis: { url: 'redis://:pw@h:6379', databases } },
  } as unknown as ResolvedEnvironment;
}

describe('factory DB selection', () => {
  const cacheDb = { db: 0, name: 'cache', roles: ['cache', 'state'], bullmqPrefix: 'bull' };
  const queueDb = { db: 1, name: 'queues', roles: ['bullmq', 'queues'], bullmqPrefix: 'bull' };

  it('queueDatabaseForEnv picks the bullmq/queues-role DB', () => {
    const renv = envWith([cacheDb, queueDb]);
    expect(queueDatabaseForEnv(renv)?.db).toBe(1);
  });

  it('queueDatabaseForEnv falls back to the sole DB when none is role-tagged (legacy)', () => {
    const renv = envWith([{ db: 1, roles: [], bullmqPrefix: 'bull' }]);
    expect(queueDatabaseForEnv(renv)?.db).toBe(1);
  });

  it('queueDatabaseForEnv returns null when multiple DBs and none tagged', () => {
    const renv = envWith([
      { db: 0, roles: [], bullmqPrefix: 'bull' },
      { db: 1, roles: [], bullmqPrefix: 'bull' },
    ]);
    expect(queueDatabaseForEnv(renv)).toBeNull();
  });

  it('stateDatabasesForEnv returns only state-role DBs', () => {
    const renv = envWith([cacheDb, queueDb]);
    expect(stateDatabasesForEnv(renv).map((d) => d.db)).toEqual([0]);
  });

  it('queueForEnv targets the queue DB URL with its prefix', () => {
    const provider = queueForEnv(envWith([cacheDb, queueDb]));
    expect(provider).not.toBeNull();
  });

  it('redisStateForEnv is null when no state DBs are configured', () => {
    expect(redisStateForEnv(envWith([queueDb]))).toBeNull();
  });
});

// --- RedisStateRuntimeProvider (injected fake scan client) ------------------

function fakeClient(opts: {
  ok?: boolean;
  detail?: string;
  keyCount: number;
  prefixes: KeyPrefixSample[];
}): ScanLike {
  return {
    async health() {
      return { ok: opts.ok ?? true, detail: opts.detail ?? 'ok' };
    },
    async dbSize() {
      return opts.keyCount;
    },
    async samplePrefixes() {
      return opts.prefixes;
    },
    async close() {},
  };
}

describe('RedisStateRuntimeProvider', () => {
  const db = (over: Partial<RedisStateDb>): RedisStateDb => ({
    db: 0,
    roles: ['cache', 'state'],
    url: 'redis://h:6379',
    ...over,
  });

  it('emits a summary signal per non-empty state DB', async () => {
    const provider = new RedisStateRuntimeProvider(
      [db({ db: 0 })],
      () => fakeClient({ keyCount: 4216, prefixes: [{ prefix: 'shopify', count: 100 }, { prefix: 'metrics', count: 50 }] }),
    );
    const a = await provider.analyzeRedisState();
    expect(a.databases[0]).toMatchObject({ db: 0, keyCount: 4216 });
    expect(a.signals.some((s) => /4216 key/.test(s.title))).toBe(true);
  });

  it('skips empty DBs (no signals)', async () => {
    const provider = new RedisStateRuntimeProvider(
      [db({ db: 2 })],
      () => fakeClient({ keyCount: 0, prefixes: [] }),
    );
    const a = await provider.analyzeRedisState();
    expect(a.signals).toHaveLength(0);
  });

  it('raises a lock signal when lock keys are present', async () => {
    const provider = new RedisStateRuntimeProvider(
      [db({ db: 0, roles: ['locks'] })],
      () => fakeClient({ keyCount: 10, prefixes: [{ prefix: 'lock', count: 7 }] }),
    );
    const a = await provider.analyzeRedisState();
    expect(a.signals.some((s) => /lock key/.test(s.title))).toBe(true);
  });

  it('THROWS when EVERY configured DB fails its health check (total outage is a gap, not empty)', async () => {
    const provider = new RedisStateRuntimeProvider(
      [db({ db: 0 })],
      () => fakeClient({ ok: false, detail: 'WRONGPASS', keyCount: 0, prefixes: [] }),
    );
    await expect(provider.analyzeRedisState()).rejects.toThrow(/redis state collection failed/);
  });

  it('skips an unhealthy DB but keeps results when another DB is healthy', async () => {
    const provider = new RedisStateRuntimeProvider(
      [db({ db: 0 }), db({ db: 1 })],
      (d) =>
        d.db === 0
          ? fakeClient({ ok: false, detail: 'WRONGPASS', keyCount: 0, prefixes: [] })
          : fakeClient({ ok: true, detail: 'ok', keyCount: 3, prefixes: [] }),
    );
    const a = await provider.analyzeRedisState();
    expect(a.databases).toHaveLength(1);
    expect(a.databases[0]!.db).toBe(1);
  });
});
