/**
 * HOR-464 / M4 — tests for `horus memory promote <id>` (one-way local → shared team memory).
 *
 * The local DB layer (openDb) and the LocalMemoryStore (createLocalMemoryStore) are mocked so the
 * source row is controllable with no real Postgres; the cloud is exercised through a real
 * `CloudClient` over a mocked `fetch`. We pin: the promote POSTs exactly ONE allowlisted item to the
 * team-memory promote endpoint; the PRIVACY invariant (NO payload/vector/embedding ever crosses the
 * wire); confirmed-outcome is refused (never leaves as team); on success the local row is flipped to
 * a server-owned cache row (origin=cloud, cloudId); and the not-linked / not-logged-in guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sqlEnd = vi.fn(async () => {});
const store = vi.hoisted(() => ({ get: vi.fn(), markPromoted: vi.fn() }));
const db = vi.hoisted(() => ({ openDb: vi.fn() }));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, openDb: db.openDb };
});
vi.mock('@horus/connectors', () => ({
  createConnectors: vi.fn(() => ({ code: {} })),
  memoryIndexForEnv: vi.fn(() => ({ upsert: vi.fn(), search: vi.fn(), remove: vi.fn() })),
}));
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return { ...actual, createLocalMemoryStore: vi.fn(() => store) };
});

import { runMemoryPromote } from './memory.js';
import { writeAuth } from '../lib/cloud/auth-store.js';
import { writeCloudConfig } from '../lib/cloud/context-store.js';

const API = 'https://api.test';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A local MemoryItem fixture (drizzle $inferSelect shape), origin=local by default. */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'mem_1',
    kind: 'pitfall',
    claim: 'Blueprints must be registered before first request',
    scope: 'repo',
    source: 'human',
    evidence: [],
    confidence: 0.8,
    status: 'fresh',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    lastVerifiedAt: null,
    lastVerifiedHash: null,
    orgId: null,
    workspaceId: null,
    repo: 'my-api',
    userId: null,
    visibility: 'private',
    origin: 'local',
    cloudId: null,
    authorName: null,
    pulledAt: null,
    // A vector hiding in payload — MUST never cross the wire.
    payload: { embedding: [0.1, 0.2, 0.3], vector: [1, 2, 3] },
    signature: null,
    tags: null,
    ...over,
  };
}

/** A TeamMemoryItem as the server echoes it from the promote endpoint. */
function teamItem(over: Record<string, unknown> = {}) {
  return {
    id: 'team-uuid-1',
    organizationId: 'o1',
    workspaceId: 'w1',
    sourceProjectId: 'p1',
    originClientId: 'mem_1',
    authorName: 'Alice',
    promotedByUserId: 'u1',
    kind: 'pitfall',
    claim: 'Blueprints must be registered before first request',
    scope: 'repo',
    source: 'human',
    status: 'fresh',
    confidence: 0.8,
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
let promoteBodies: unknown[];

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

  promoteBodies = [];
  fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (u.endsWith('/team-memory/promote') && method === 'POST') {
      const body = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ originClientId: string }> };
      promoteBodies.push(body);
      const items = (body.items ?? []).map((it) => teamItem({ originClientId: it.originClientId }));
      return json({ promoted: items.length, skipped: 0, total: items.length, items });
    }
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  store.get.mockResolvedValue(item());
  store.markPromoted.mockImplementation(async (id: string, prov: { cloudId: string; authorName?: string | null }) =>
    item({ id, visibility: 'team', origin: 'cloud', cloudId: prov.cloudId, authorName: prov.authorName ?? null }),
  );
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

const promoteCalls = () =>
  fetchSpy.mock.calls.filter(
    (c: unknown[]) => (c[0] as string).endsWith('/team-memory/promote') && (c[1] as RequestInit)?.method === 'POST',
  );

describe('runMemoryPromote', () => {
  it('POSTs one allowlisted item to the linked project team-memory promote endpoint', async () => {
    link();
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(0);
    expect(promoteCalls().length).toBe(1);
    expect(promoteCalls()[0]![0]).toContain('/v1/projects/p1/team-memory/promote');
    const body = promoteBodies[0] as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.originClientId).toBe('mem_1');
  });

  it('flips the local row to a server-owned team item (origin=cloud, cloudId)', async () => {
    link();
    await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(store.markPromoted).toHaveBeenCalledTimes(1);
    const [id, prov] = store.markPromoted.mock.calls[0]! as [string, { cloudId: string; authorName: string }];
    expect(id).toBe('mem_1');
    expect(prov.cloudId).toBe('team-uuid-1');
    expect(prov.authorName).toBe('Alice');
  });

  it('NEVER sends payload / vectors / embeddings over the wire (PRIVACY)', async () => {
    link();
    await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    const raw = JSON.stringify(promoteBodies);
    expect(raw).not.toContain('payload');
    expect(raw).not.toContain('embedding');
    expect(raw).not.toContain('vector');
    const sent = (promoteBodies[0] as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(sent).not.toHaveProperty('payload');
    expect(Object.keys(sent).sort()).toEqual(
      ['claim', 'confidence', 'contentHash', 'kind', 'originClientId', 'provenance', 'scope', 'source', 'status'].sort(),
    );
  });

  it('refuses a confirmed-outcome item (privacy) — no POST, no local flip', async () => {
    link();
    store.get.mockResolvedValueOnce(item({ kind: 'confirmed-outcome', source: 'confirmed-outcome' }));
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(promoteCalls().length).toBe(0);
    expect(store.markPromoted).not.toHaveBeenCalled();
  });

  it('is a no-op when the row is already a cloud-owned team item', async () => {
    link();
    store.get.mockResolvedValueOnce(item({ origin: 'cloud', visibility: 'team', cloudId: 'team-uuid-1' }));
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(0);
    expect(promoteCalls().length).toBe(0);
    expect(store.markPromoted).not.toHaveBeenCalled();
  });

  it('does not flip local state when the server skips the promote', async () => {
    link();
    fetchSpy.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/team-memory/promote')) {
        void init;
        return json({ promoted: 0, skipped: 1, total: 1, items: [] });
      }
      return json({ error: { code: 'not_found', message: 'no route' } }, 404);
    });
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(store.markPromoted).not.toHaveBeenCalled();
  });

  it('fails when the repo is not linked to a cloud project', async () => {
    writeAuth({ apiBaseUrl: API, token: 'good-token', account: { userId: 'u1', email: 'x' } });
    writeCloudConfig(repo, { context: 'local' });
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(promoteCalls().length).toBe(0);
  });

  it('fails (and never touches the local DB) when not logged in', async () => {
    writeCloudConfig(repo, {
      context: 'cloud',
      organization: { id: 'o1', slug: 'meritt-dev' },
      workspace: { id: 'w1', slug: 'internal-products' },
      project: { id: 'p1', slug: 'horus' },
    });
    const code = await runMemoryPromote('mem_1', { config: configPath, cwd: repo });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});
