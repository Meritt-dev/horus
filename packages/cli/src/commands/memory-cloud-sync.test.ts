/**
 * HOR Memory M3 (step 4) — tests for `horus memory sync` (bulk backfill to the linked cloud project).
 *
 * The local DB layer (openDb) and the MemoryStore (createLocalMemoryStore) are mocked so the source
 * items are controllable with no real Postgres; the cloud is exercised through a real `CloudClient`
 * over a mocked `fetch` (mirrors cloud-sync.test.ts). We pin: idempotent push to the sync endpoint;
 * the PRIVACY invariant (NO payload/vector/embedding ever crosses the wire); confirmed-outcome is
 * clamped to `private`; forgotten items are excluded; `--dry-run` uploads nothing; `--json` is a
 * single clean document; and the not-linked / not-logged-in guards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sqlEnd = vi.fn(async () => {});
const store = vi.hoisted(() => ({ query: vi.fn(), links: vi.fn(), history: vi.fn() }));
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

import { runMemorySync } from './memory.js';
import { writeAuth } from '../lib/cloud/auth-store.js';
import { writeCloudConfig } from '../lib/cloud/context-store.js';

const API = 'https://api.test';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A local MemoryItem fixture (drizzle $inferSelect shape: Date objects, all tenancy columns). */
function item(over: Record<string, unknown> = {}) {
  return {
    id: 'mem_1',
    kind: 'code-fact',
    claim: 'Payments use Stripe idempotency keys',
    scope: 'module:payments',
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
    // A vector hiding in payload — MUST never cross the wire.
    payload: { embedding: [0.1, 0.2, 0.3], vector: [1, 2, 3] },
    ...over,
  };
}

/** A local MemoryLink fixture (drizzle $inferSelect shape). */
function memLink(over: Record<string, unknown> = {}) {
  return {
    id: 'lnk_1',
    fromMemoryId: 'mem_1',
    rel: 'about-symbol',
    toKind: 'node',
    toRef: 'Function:src/q.ts:consume',
    toFilePath: 'src/q.ts',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

/** A local MemoryAudit fixture (drizzle $inferSelect shape; Date `at`, jsonb `actor`). */
function memAudit(over: Record<string, unknown> = {}) {
  return {
    id: 'aud_1',
    memoryId: 'mem_1',
    action: 'add',
    actor: { kind: 'user', id: 'u1' },
    fromStatus: null,
    toStatus: 'fresh',
    note: null,
    at: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

let home: string;
let repo: string;
let configPath: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let syncBodies: unknown[];

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

  syncBodies = [];
  fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    if (u.endsWith('/memory-items/sync') && method === 'POST') {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        items?: unknown[];
        links?: unknown[];
        audit?: unknown[];
      };
      syncBodies.push(body);
      return json({
        items: (body.items ?? []).map((it) => ({ ...(it as object), clientId: (it as { clientId: string }).clientId })),
        links: { created: body.links?.length ?? 0, skipped: 0, total: body.links?.length ?? 0 },
        audit: { created: body.audit?.length ?? 0, skipped: 0, total: body.audit?.length ?? 0 },
      });
    }
    return json({ error: { code: 'not_found', message: 'no route' } }, 404);
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  store.query.mockResolvedValue([item()]);
  // Default: items carry no links/audit; individual tests override per item id.
  store.links.mockResolvedValue([]);
  store.history.mockResolvedValue([]);
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

const syncCalls = () =>
  fetchSpy.mock.calls.filter(
    (c: unknown[]) => (c[0] as string).endsWith('/memory-items/sync') && (c[1] as RequestInit)?.method === 'POST',
  );

const has = (b: unknown, key: 'items' | 'links' | 'audit') =>
  ((b as Record<string, unknown[] | undefined>)[key]?.length ?? 0) > 0;
const itemBodies = () => syncBodies.filter((b) => has(b, 'items'));
const linkBodies = () => syncBodies.filter((b) => has(b, 'links'));
const auditBodies = () => syncBodies.filter((b) => has(b, 'audit'));

describe('runMemorySync — bulk backfill', () => {
  it('pushes local items to the cloud project sync endpoint (idempotent)', async () => {
    link();
    const code = await runMemorySync({ config: configPath, cwd: repo, yes: true });
    expect(code).toBe(0);
    expect(syncCalls().length).toBe(1);
    // Hits the linked project's id (p1), not the slug.
    expect(syncCalls()[0]![0]).toContain('/v1/projects/p1/memory-items/sync');
    const body = syncBodies[0] as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.clientId).toBe('mem_1');
  });

  it('NEVER sends payload / vectors / embeddings over the wire (PRIVACY)', async () => {
    link();
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const raw = JSON.stringify(syncBodies);
    expect(raw).not.toContain('payload');
    expect(raw).not.toContain('embedding');
    expect(raw).not.toContain('vector');
    const sent = (syncBodies[0] as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(sent).not.toHaveProperty('payload');
    // The positive allowlist carries only scalar authored fields.
    expect(Object.keys(sent).sort()).toEqual(
      ['claim', 'clientCreatedAt', 'clientId', 'confidence', 'evidence', 'kind', 'lastVerifiedAt', 'lastVerifiedHash', 'scope', 'source', 'status', 'visibility'].sort(),
    );
  });

  it('clamps confirmed-outcome to visibility=private before it leaves the device', async () => {
    link();
    store.query.mockResolvedValueOnce([
      item({ id: 'mem_co', kind: 'confirmed-outcome', source: 'confirmed-outcome', visibility: 'team' }),
    ]);
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const sent = (syncBodies[0] as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(sent.visibility).toBe('private');
  });

  it('excludes forgotten items (queries non-forgotten statuses only)', async () => {
    link();
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const q = store.query.mock.calls[0]![0] as { status: string[] };
    expect(q.status).not.toContain('forgotten');
    expect(q.status).toEqual(expect.arrayContaining(['fresh', 'pinned', 'deprecated', 'contradicted', 'possibly-stale']));
  });

  it('excludes origin=cloud cache rows from the push (queries origin=local only) — HOR-464', async () => {
    link();
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const q = store.query.mock.calls[0]![0] as { origin?: string };
    expect(q.origin).toBe('local');
  });

  it('--dry-run previews without uploading', async () => {
    link();
    const code = await runMemorySync({ config: configPath, cwd: repo, dryRun: true });
    expect(code).toBe(0);
    expect(syncCalls().length).toBe(0);
  });

  it('emits a single clean JSON document under --json (no preview noise)', async () => {
    link();
    const logSpy = console.log as unknown as ReturnType<typeof vi.fn>;
    const code = await runMemorySync({ config: configPath, cwd: repo, json: true });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, synced: 1, failed: 0, total: 1 });
  });

  it('reports nothing to sync when there are no local items', async () => {
    link();
    store.query.mockResolvedValueOnce([]);
    const code = await runMemorySync({ config: configPath, cwd: repo, yes: true });
    expect(code).toBe(0);
    expect(syncCalls().length).toBe(0);
  });

  it('fails when the repo is not linked to a cloud project', async () => {
    writeAuth({ apiBaseUrl: API, token: 'good-token', account: { userId: 'u1', email: 'x' } });
    writeCloudConfig(repo, { context: 'local' });
    const code = await runMemorySync({ config: configPath, cwd: repo, yes: true });
    expect(code).toBe(1);
    expect(syncCalls().length).toBe(0);
  });

  it('fails (and never touches the local DB) when not logged in', async () => {
    writeCloudConfig(repo, {
      context: 'cloud',
      organization: { id: 'o1', slug: 'meritt-dev' },
      workspace: { id: 'w1', slug: 'internal-products' },
      project: { id: 'p1', slug: 'horus' },
    });
    const code = await runMemorySync({ config: configPath, cwd: repo, yes: true });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(syncCalls().length).toBe(0);
  });

  it('also pushes links + audit gathered from the local store (resolving client ids)', async () => {
    link();
    store.links.mockResolvedValueOnce([memLink()]);
    store.history.mockResolvedValueOnce([memAudit()]);
    const code = await runMemorySync({ config: configPath, cwd: repo, yes: true });
    expect(code).toBe(0);

    const lb = linkBodies();
    expect(lb).toHaveLength(1);
    expect((lb[0] as { links: Array<Record<string, unknown>> }).links[0]).toEqual({
      idempotencyKey: 'lnk_1',
      fromClientId: 'mem_1',
      rel: 'about-symbol',
      toKind: 'node',
      toRef: 'Function:src/q.ts:consume',
      toFilePath: 'src/q.ts',
    });

    const ab = auditBodies();
    expect(ab).toHaveLength(1);
    expect((ab[0] as { audit: Array<Record<string, unknown>> }).audit[0]).toEqual({
      clientAuditId: 'aud_1',
      memoryClientId: 'mem_1',
      action: 'add',
      actor: { kind: 'user', id: 'u1' },
      toStatus: 'fresh',
      at: '2026-06-01T00:00:00.000Z',
    });
  });

  it('pushes items BEFORE links and audit (so the server can resolve client ids)', async () => {
    link();
    store.links.mockResolvedValueOnce([memLink()]);
    store.history.mockResolvedValueOnce([memAudit()]);
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const firstItems = syncBodies.findIndex((b) => has(b, 'items'));
    const firstLinks = syncBodies.findIndex((b) => has(b, 'links'));
    const firstAudit = syncBodies.findIndex((b) => has(b, 'audit'));
    expect(firstItems).toBeGreaterThanOrEqual(0);
    expect(firstItems).toBeLessThan(firstLinks);
    expect(firstLinks).toBeLessThan(firstAudit);
  });

  it('never leaks payload / vectors / embeddings through link or audit bodies (PRIVACY)', async () => {
    link();
    store.links.mockResolvedValueOnce([memLink()]);
    store.history.mockResolvedValueOnce([memAudit({ note: 'plain note' })]);
    await runMemorySync({ config: configPath, cwd: repo, yes: true });
    const raw = JSON.stringify(syncBodies);
    expect(raw).not.toContain('payload');
    expect(raw).not.toContain('embedding');
    expect(raw).not.toContain('vector');
  });

  it('reports link + audit counts under --json', async () => {
    link();
    store.links.mockResolvedValueOnce([memLink()]);
    store.history.mockResolvedValueOnce([memAudit()]);
    const logSpy = console.log as unknown as ReturnType<typeof vi.fn>;
    const code = await runMemorySync({ config: configPath, cwd: repo, json: true });
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      ok: true,
      synced: 1,
      links: { synced: 1, total: 1 },
      audit: { synced: 1, total: 1 },
    });
  });

  it('--dry-run uploads neither items nor links nor audit', async () => {
    link();
    store.links.mockResolvedValueOnce([memLink()]);
    store.history.mockResolvedValueOnce([memAudit()]);
    const code = await runMemorySync({ config: configPath, cwd: repo, dryRun: true });
    expect(code).toBe(0);
    expect(syncCalls().length).toBe(0);
  });
});
