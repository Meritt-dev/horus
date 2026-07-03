/**
 * HOR-190 — Unit tests for MongoDB status reporting in `horus status`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStatus } from './status.js';
import type { StateProvider } from '@horus/connectors';

const dirs: string[] = [];

vi.mock('@horus/db', () => ({
  checkDatabase: vi.fn(async () => ({
    reachable: true,
    schemaReady: true,
    reachableDetail: 'connected',
    schemaDetail: 'schema ready',
  })),
}));

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-status-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

const DB = `{ url: "postgresql://horus:horus@localhost:5433/horus" }`;

function writeConfig(dir: string, mongo: string): string {
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { mongodb: ${mongo} },
    }],
  }],
};
`,
    'utf8',
  );
  return path;
}

function makeMongoProvider(opts: { ok: boolean; collections?: string[] }): StateProvider {
  return {
    id: 'mongodb',
    kind: 'state',
    async health() {
      return { ok: opts.ok, detail: opts.ok ? 'ok' : 'unreachable' };
    },
    async analyzeState() {
      throw new Error('not used');
    },
    toEvidence() {
      return [];
    },
    async listCollections() {
      return opts.collections ?? [];
    },
    async close() {},
  };
}

function mongoFactory(provider: StateProvider | null) {
  return () => provider;
}

async function captureStatus(
  configPath: string,
  factory: (() => StateProvider | null) | null,
): Promise<{ output: string; code: number }> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await runStatus(configPath, {
    env: 'production',
    _mongoFactory: factory ?? undefined,
  });
  const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  spy.mockRestore();
  return { output, code };
}

// ---------------------------------------------------------------------------

describe('runStatus — MongoDB (HOR-190)', () => {
  it('shows "not configured" when no MongoDB connector is present', async () => {
    const dir = tempDir();
    const path = join(dir, 'horus.config.js');
    writeFileSync(
      path,
      `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`,
      'utf8',
    );
    const { output } = await captureStatus(path, mongoFactory(null));
    expect(output).toContain('MongoDB');
    expect(output).toContain('not configured');
  });

  it('shows a warning when MongoDB is configured without a URL', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, '{ database: "my-api-prod" }');
    const { output } = await captureStatus(path, mongoFactory(null));
    expect(output).toContain('MongoDB');
    expect(output).toContain('but Mongo URL not set');
  });

  it('shows reachable with discovered count when auto-discovery is enabled', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({
      ok: true,
      collections: ['users', 'orders', 'events'],
    });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('reachable');
    expect(output).toContain('db my-api-prod');
    expect(output).toContain('allowlist: all');
    expect(output).toContain('discovered: 3 collection(s)');
    expect(output).not.toContain('0 collection');
  });

  it('shows reachable with allowlist count when collections are explicit', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod", collections: ["users", "orders"] }',
    );
    const provider = makeMongoProvider({ ok: true, collections: ['users', 'orders'] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('reachable');
    expect(output).toContain('allowlist: 2');
  });

  it('shows unreachable when MongoDB health fails', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({ ok: false });
    const { output, code } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('MongoDB');
    expect(output).toContain('unreachable');
    expect(output).toContain('db my-api-prod');
    expect(code).toBe(1);
  });

  it('does not leak MongoDB connection URL secrets', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://secret-user:secret-pass@mongo.internal:27017", database: "mydb" }',
    );
    const provider = makeMongoProvider({ ok: true, collections: [] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).not.toContain('secret-user');
    expect(output).not.toContain('secret-pass');
    expect(output).not.toContain('mongo.internal');
  });

  it('shows zero collections only when actually discovered as empty', async () => {
    const dir = tempDir();
    const path = writeConfig(
      dir,
      '{ url: "mongodb://localhost:27017", database: "my-api-prod" }',
    );
    const provider = makeMongoProvider({ ok: true, collections: [] });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('allowlist: all');
    expect(output).toContain('discovered: 0 collection(s)');
  });
});


// ---------------------------------------------------------------------------
// Redis multi-DB reporting (HOR-201)
// ---------------------------------------------------------------------------

import type { RedisServerStatus, RedisDbStatus } from '@horus/connectors';

function writeRedisConfig(dir: string, redis: string): string {
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: ${DB},
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{
      name: "production",
      connectors: { redis: ${redis} },
    }],
  }],
};
`,
    'utf8',
  );
  return path;
}

function redisStatusStub(status: RedisServerStatus | null) {
  return async () => status;
}

async function captureRedisStatus(
  configPath: string,
  status: RedisServerStatus | null,
): Promise<{ output: string; code: number }> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await runStatus(configPath, {
    env: 'production',
    _redisStatus: redisStatusStub(status),
  });
  const output = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  spy.mockRestore();
  return { output, code };
}

const queueDb = (db: number, queueCount: number): RedisDbStatus => ({
  db,
  name: 'queues',
  roles: ['bullmq', 'queues'],
  reachable: true,
  queueCount,
  bullmqPrefix: 'bull',
});
const cacheDb = (db: number, keyCount: number): RedisDbStatus => ({
  db,
  name: 'cache',
  roles: ['cache', 'state'],
  reachable: true,
  keyCount,
});

describe('runStatus — Redis multi-DB (HOR-201)', () => {
  it('legacy single URL with DB suffix: one unrolled DB shown reachable', async () => {
    const path = writeRedisConfig(tempDir(), '{ url: "redis://:pw@127.0.0.1:6379/1" }');
    const status: RedisServerStatus = {
      reachable: true,
      authFailed: false,
      databases: [{ db: 1, roles: [], reachable: true, queueCount: 11, bullmqPrefix: 'bull' }],
    };
    const { output } = await captureRedisStatus(path, status);
    expect(output).toMatch(/Redis[\s\S]*reachable · 127\.0\.0\.1:6379/);
    expect(output).toContain('DB 1');
    expect(output).toContain('11 queue(s)');
  });

  it('URL without DB + databases array: cache DB 0 + queues DB 1 both shown', async () => {
    const path = writeRedisConfig(
      tempDir(),
      `{ url: "redis://:pw@127.0.0.1:6379", databases: [
        { db: 0, name: "cache", roles: ["cache","state"] },
        { db: 1, name: "queues", roles: ["bullmq","queues"], bullmq: { prefix: "bull" } }
      ] }`,
    );
    const status: RedisServerStatus = {
      reachable: true,
      authFailed: false,
      databases: [cacheDb(0, 4216), queueDb(1, 11)],
    };
    const { output } = await captureRedisStatus(path, status);
    expect(output).toContain('DB 0');
    expect(output).toContain('4216 key(s)');
    expect(output).toContain('DB 1');
    expect(output).toContain('11 queue(s), prefix bull');
  });

  it('bullmq in DB 1 while cache keys exist in DB 0 — distinct role labels', async () => {
    const path = writeRedisConfig(
      tempDir(),
      `{ url: "redis://127.0.0.1:6379", databases: [
        { db: 0, roles: ["cache","state"] },
        { db: 1, roles: ["bullmq","queues"] }
      ] }`,
    );
    const { output } = await captureRedisStatus(path, {
      reachable: true,
      authFailed: false,
      databases: [cacheDb(0, 500), queueDb(1, 7)],
    });
    expect(output).toMatch(/DB 0[\s\S]*cache\/state/);
    expect(output).toMatch(/DB 1[\s\S]*bullmq\/queues/);
  });

  it('empty DB shows 0 key(s)', async () => {
    const path = writeRedisConfig(tempDir(), '{ url: "redis://127.0.0.1:6379", databases: [{ db: 2, roles: ["cache"] }] }');
    const { output } = await captureRedisStatus(path, {
      reachable: true,
      authFailed: false,
      databases: [cacheDb(2, 0)],
    });
    expect(output).toContain('0 key(s)');
  });

  it('unreachable server fails the env', async () => {
    const path = writeRedisConfig(tempDir(), '{ url: "redis://127.0.0.1:6399", databases: [{ db: 0, roles: ["cache"] }] }');
    const { output, code } = await captureRedisStatus(path, {
      reachable: false,
      authFailed: false,
      databases: [{ db: 0, roles: ['cache'], reachable: false, detail: 'ECONNREFUSED' }],
    });
    expect(output).toMatch(/Redis[\s\S]*unreachable/);
    expect(code).toBe(1);
  });

  it('wrong auth is labeled "auth failed"', async () => {
    const path = writeRedisConfig(tempDir(), '{ url: "redis://:wrong@127.0.0.1:6379", databases: [{ db: 0, roles: ["cache"] }] }');
    const { output, code } = await captureRedisStatus(path, {
      reachable: false,
      authFailed: true,
      databases: [{ db: 0, roles: ['cache'], reachable: false, detail: 'WRONGPASS invalid password' }],
    });
    expect(output).toMatch(/Redis[\s\S]*auth failed/);
    expect(code).toBe(1);
  });

  it('does not leak the Redis password (server label is host:port only)', async () => {
    const path = writeRedisConfig(tempDir(), '{ url: "redis://:supersecret@127.0.0.1:6379", databases: [{ db: 1, roles: ["bullmq"] }] }');
    const { output } = await captureRedisStatus(path, {
      reachable: true,
      authFailed: false,
      databases: [queueDb(1, 3)],
    });
    expect(output).not.toContain('supersecret');
  });
});

// ---------------------------------------------------------------------------
// `status --json` — stdout must be ONE parseable JSON document (agent contract),
// human output untouched when the flag is absent.
// ---------------------------------------------------------------------------

async function captureStatusJson(
  configPath: string,
  factory: (() => StateProvider | null) | null,
): Promise<{ stdout: string; code: number }> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await runStatus(configPath, {
    env: 'production',
    json: true,
    _mongoFactory: factory ?? undefined,
  });
  const stdout = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  spy.mockRestore();
  return { stdout, code };
}

describe('runStatus --json (agent contract)', () => {
  it('emits one parseable document with config, database, and per-connector checks', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, '{ url: "mongodb://localhost:27017", database: "my-api-prod" }');
    const provider = makeMongoProvider({ ok: true, collections: ['users', 'orders'] });
    const { stdout, code } = await captureStatusJson(path, mongoFactory(provider));
    const out = JSON.parse(stdout) as {
      version: string;
      config: { ok: boolean };
      database: { reachable: boolean; schemaReady: boolean };
      environments: Array<{
        project: string;
        env: string;
        healthy: boolean;
        checks: Array<{ name: string; state: string; detail: string }>;
      }>;
      healthy: boolean;
    };
    expect(out.config.ok).toBe(true);
    expect(out.database.reachable).toBe(true);
    expect(out.environments).toHaveLength(1);
    expect(out.environments[0]).toMatchObject({ project: 'my-api', env: 'production' });
    const mongo = out.environments[0]!.checks.find((c) => c.name === 'mongodb');
    expect(mongo?.state).toBe('ok');
    expect(mongo?.detail).toContain('my-api-prod');
    // Unconfigured connectors appear as pending — the matrix is complete, not sparse.
    expect(out.environments[0]!.checks.find((c) => c.name === 'sentry')?.state).toBe('pending');
    expect(out.healthy).toBe(true);
    expect(code).toBe(0);
  });

  it('an unreachable connector marks the environment unhealthy and exits 1 (with --env)', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, '{ url: "mongodb://localhost:27017", database: "my-api-prod" }');
    const provider = makeMongoProvider({ ok: false });
    const { stdout, code } = await captureStatusJson(path, mongoFactory(provider));
    const out = JSON.parse(stdout) as {
      environments: Array<{ healthy: boolean; checks: Array<{ name: string; state: string }> }>;
      healthy: boolean;
    };
    expect(out.environments[0]!.checks.find((c) => c.name === 'mongodb')?.state).toBe('fail');
    expect(out.environments[0]!.healthy).toBe(false);
    expect(out.healthy).toBe(false);
    expect(code).toBe(1);
  });

  it('a missing config still yields one parseable document and exit 1', async () => {
    const dir = tempDir();
    const missing = join(dir, 'nope.config.js');
    const { stdout, code } = await captureStatusJson(missing, null);
    const out = JSON.parse(stdout) as { config: { ok: boolean; detail: string }; healthy: boolean };
    expect(out.config.ok).toBe(false);
    expect(out.config.detail.length).toBeGreaterThan(0);
    expect(out.healthy).toBe(false);
    expect(code).toBe(1);
  });

  it('without --json the human banner still prints (output unchanged)', async () => {
    const dir = tempDir();
    const path = writeConfig(dir, '{ url: "mongodb://localhost:27017", database: "my-api-prod" }');
    const provider = makeMongoProvider({ ok: true });
    const { output } = await captureStatus(path, mongoFactory(provider));
    expect(output).toContain('Horus ');
    expect(output).toContain('MongoDB');
    expect(() => JSON.parse(output)).toThrow(); // human mode is NOT a JSON document
  });
});
