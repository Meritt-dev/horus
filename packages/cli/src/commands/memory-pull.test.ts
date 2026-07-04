/**
 * HOR-464 / M4 — tests for `horus memory pull` (refresh the local team-memory read-cache).
 *
 * The local DB layer (openDb), the LocalMemoryStore (createLocalMemoryStore), and the local vector
 * index (memoryIndexForEnv) are mocked; the cloud is a real `CloudClient` over a mocked `fetch`. We
 * pin: a FULL pull paginates the team list to hasMore=false; each item is upserted as a cache row AND
 * re-embedded into the LOCAL vector index; stale cache rows are reconcile-deleted (only after a
 * successful pull); a tombstone drops the cached row + its vector; and an OFFLINE pull serves the
 * existing cache with a stale note and NEVER reconciles (no partial wipe).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sqlEnd = vi.fn(async () => {});
const store = vi.hoisted(() => ({ upsertCached: vi.fn(), reconcileCache: vi.fn(), query: vi.fn() }));
const vectorIndex = vi.hoisted(() => ({ upsert: vi.fn(), search: vi.fn(), remove: vi.fn() }));
const db = vi.hoisted(() => ({ openDb: vi.fn() }));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, openDb: db.openDb };
});
vi.mock('@horus/connectors', () => ({
  createConnectors: vi.fn(() => ({ code: {} })),
  memoryIndexForEnv: vi.fn(() => vectorIndex),
}));
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return { ...actual, createLocalMemoryStore: vi.fn(() => store) };
});

import { runMemoryPull } from './memory.js';
import { writeAuth } from '../lib/cloud/auth-store.js';
import { writeCloudConfig } from '../lib/cloud/context-store.js';

const API = 'https://api.test';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A TeamMemoryItem fixture as the server returns it from the team-memory list. */
function teamItem(over: Record<string, unknown> = {}) {
  return {
    id: 'team-uuid-1',
    organizationId: 'o1',
    workspaceId: 'w1',
    sourceProjectId: 'p1',
    originClientId: 'mem_team_1',
    authorName: 'Alice',
    promotedByUserId: 'u1',
    kind: 'pitfall',
    claim: 'Blueprints must be registered before first request',
    scope: 'repo',
    source: 'human',
    status: 'fresh',
    confidence: 0.9,
    contentHash: null,
    provenance: {},
    seq: '1',
    deletedAt: null,
    promotedAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

let home: string;
let repo: string;
let configPath: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let teamPages: Array<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'horus-home-'));
  repo = mkdtempSync(join(tmpdir(), 'horus-repo-'));
  process.env.HORUS_HOME = home;
  process.env.HORUS_CLOUD_API_URL = API;

  configPath = join(repo, 'horus.config.js');
  writeFileSync(
    configPath,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`,
    'utf8',
  );

  // Default: a single page with one team item.
  teamPages = [{ items: [teamItem()], nextCursor: null, hasMore: false }];
  let page = 0;
  fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (u.includes('/team-memory?') && method === 'GET') {
      const body = teamPages[Math.min(page, teamPages.length - 1)]!;
      page += 1;
      return json(body);
    }
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  store.upsertCached.mockResolvedValue({ id: 'mem_team_1' });
  store.reconcileCache.mockResolvedValue(0);
  store.query.mockResolvedValue([]);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  delete process.env.HORUS_HOME;
  delete process.env.HORUS_CLOUD_API_URL;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function link() {
  writeAuth({ apiBaseUrl: API, token: 'good-token', account: { userId: 'u1', email: 'dev@meritt.dev' } });
  writeCloudConfig(repo, {
    context: 'cloud',
    organization: { id: 'o1', slug: 'meritt-dev' },
    workspace: { id: 'w1', slug: 'internal-products' },
    project: { id: 'p1', slug: 'horus' },
  });
}

const listCalls = () =>
  fetchSpy.mock.calls.filter((c: unknown[]) => (c[0] as string).includes('/team-memory?'));

describe('runMemoryPull', () => {
  it('pulls team items, upserts them as cache rows, and reconciles with the pulled ids', async () => {
    link();
    const code = await runMemoryPull({ config: configPath, cwd: repo });
    expect(code).toBe(0);
    // Hits the linked project's team-memory list (since=0 full pull, includeDeleted).
    expect(listCalls().length).toBe(1);
    expect(listCalls()[0]![0]).toContain('/v1/projects/p1/team-memory?');
    expect(listCalls()[0]![0]).toContain('since=0');
    expect(listCalls()[0]![0]).toContain('includeDeleted=true');

    expect(store.upsertCached).toHaveBeenCalledTimes(1);
    const [cacheRow] = store.upsertCached.mock.calls[0]! as [Record<string, unknown>];
    expect(cacheRow.id).toBe('mem_team_1'); // keyed by the origin client id (cross-device stable)
    expect(cacheRow.cloudId).toBe('team-uuid-1');
    expect(cacheRow.authorName).toBe('Alice');
    expect(cacheRow.visibility).toBe('team');
    expect(cacheRow.confidence).toBe(0.9);

    // Reconcile runs AFTER a successful pull, keeping exactly the pulled ids.
    expect(store.reconcileCache).toHaveBeenCalledWith('my-api', ['mem_team_1']);
  });

  it('re-embeds each pulled claim into the LOCAL vector index', async () => {
    link();
    await runMemoryPull({ config: configPath, cwd: repo });
    expect(vectorIndex.upsert).toHaveBeenCalledTimes(1);
    expect(vectorIndex.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 'mem_team_1', claim: expect.any(String), repo: 'my-api' }),
    );
  });

  it('paginates the team list until hasMore is false', async () => {
    link();
    teamPages = [
      { items: [teamItem({ id: 't1', originClientId: 'mem_a' })], nextCursor: '5', hasMore: true },
      { items: [teamItem({ id: 't2', originClientId: 'mem_b' })], nextCursor: null, hasMore: false },
    ];
    const code = await runMemoryPull({ config: configPath, cwd: repo });
    expect(code).toBe(0);
    expect(listCalls().length).toBe(2);
    // Second page requests since=<nextCursor> of the first.
    expect(listCalls()[1]![0]).toContain('since=5');
    expect(store.upsertCached).toHaveBeenCalledTimes(2);
    expect(store.reconcileCache).toHaveBeenCalledWith('my-api', ['mem_a', 'mem_b']);
  });

  it('a tombstone (deletedAt) drops the cached row + its vector, and is excluded from keepIds', async () => {
    link();
    teamPages = [
      {
        items: [
          teamItem({ id: 't1', originClientId: 'mem_live' }),
          teamItem({ id: 't2', originClientId: 'mem_dead', deletedAt: '2026-06-02T00:00:00.000Z' }),
        ],
        nextCursor: null,
        hasMore: false,
      },
    ];
    await runMemoryPull({ config: configPath, cwd: repo });
    // Only the live item is upserted; the tombstone is not.
    expect(store.upsertCached).toHaveBeenCalledTimes(1);
    expect((store.upsertCached.mock.calls[0]![0] as { id: string }).id).toBe('mem_live');
    // The tombstone's vector is removed, and it is NOT in keepIds.
    expect(vectorIndex.remove).toHaveBeenCalledWith('mem_dead');
    expect(store.reconcileCache).toHaveBeenCalledWith('my-api', ['mem_live']);
  });

  it('OFFLINE: serves the existing cache with a stale note and NEVER reconciles', async () => {
    link();
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('fetch failed'); // network down → CloudClient throws CloudOfflineError
    });
    store.query.mockResolvedValueOnce([
      { id: 'mem_team_1', origin: 'cloud', pulledAt: new Date('2026-06-01T00:00:00.000Z') },
    ]);
    const code = await runMemoryPull({ config: configPath, cwd: repo, json: true });
    expect(code).toBe(0); // never blocks
    expect(store.reconcileCache).not.toHaveBeenCalled(); // no partial wipe
    expect(store.upsertCached).not.toHaveBeenCalled();
    // Read the cache scoped to origin=cloud.
    expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ repo: 'my-api', origin: 'cloud' }));
  });

  it('only touches the team-memory endpoint (never the private memory-items list)', async () => {
    link();
    await runMemoryPull({ config: configPath, cwd: repo });
    const hitMemoryItems = fetchSpy.mock.calls.some((c: unknown[]) =>
      (c[0] as string).includes('/memory-items'),
    );
    expect(hitMemoryItems).toBe(false);
  });

  it('fails when the repo is not linked to a cloud project', async () => {
    writeAuth({ apiBaseUrl: API, token: 'good-token', account: { userId: 'u1', email: 'x' } });
    writeCloudConfig(repo, { context: 'local' });
    const code = await runMemoryPull({ config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(listCalls().length).toBe(0);
  });

  it('fails (and never touches the local DB) when not logged in', async () => {
    writeCloudConfig(repo, {
      context: 'cloud',
      organization: { id: 'o1', slug: 'meritt-dev' },
      workspace: { id: 'w1', slug: 'internal-products' },
      project: { id: 'p1', slug: 'horus' },
    });
    const code = await runMemoryPull({ config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});
