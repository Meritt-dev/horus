/**
 * HOR-207 — architecture async boundaries must be scoped to the active project.
 * A shared Horus DB holds queue edges for multiple projects; discoverArchitecture
 * must only surface the active project's queues, never another project's.
 */
import { describe, it, expect, vi } from 'vitest';
import type { QueueEdge } from '@horus/db';
import type { CodeProvider } from '@horus/connectors';

const now = new Date();
function edge(queueName: string, project: string, producer: string, worker: string): QueueEdge {
  return {
    id: `${project}-${queueName}`,
    queueName,
    producerSymbol: producer,
    producerFile: `src/${producer}.ts`,
    workerSymbol: worker,
    workerFile: `src/${worker}.ts`,
    source: 'stitcher',
    project,
    createdAt: now,
    updatedAt: now,
  };
}

const ALL_EDGES: QueueEdge[] = [
  edge('POST_SEED_PRODUCT_SYNC', 'maison-safqa', 'PostSeed', 'postSeedWorker'),
  edge('brand-webhooks', 'maison-safqa', 'webhookQueue', 'webhookWorker'),
  edge('zoho-sync-batch', 'leadcall-api', 'ZohoCron', 'ZohoBatchProcessor'),
  edge('zoho-sync-realtime', 'leadcall-api', 'ZohoService', 'ZohoRealtimeProcessor'),
];

// Simulate the shared DB: filter by project exactly like the real listQueueEdges.
vi.mock('@horus/db', () => ({
  listQueueEdges: vi.fn(async (_db: unknown, opts?: { project?: string }) =>
    ALL_EDGES.filter((e) => opts?.project === undefined || e.project === opts.project),
  ),
}));

const { discoverArchitecture } = await import('./architecture.js');

// Minimal CodeProvider with NO typed read-path methods — every section must degrade
// to its empty default, so the async boundaries come solely from the (mocked) queue
// edges. Also documents that the engine never requires the optional methods.
const fakeCode = { cypher: async () => ({ rows: [] }) } as unknown as CodeProvider;
const fakeDb = {} as never;

describe('discoverArchitecture — detects Python async DB drivers (HOR-379)', () => {
  it('surfaces asyncpg, aiomysql, sqlite as external systems', async () => {
    const code = {
      filesContaining: async (tokens: string[]) => {
        const matches: Record<string, string[]> = {};
        for (const t of tokens) matches[t] = [];
        for (const m of ['asyncpg', 'aiomysql', 'sqlite']) {
          if (tokens.includes(m)) matches[m] = [`src/backends/${m}_backend.py`];
        }
        return matches;
      },
    } as unknown as CodeProvider;
    const model = await discoverArchitecture({ code, db: fakeDb });
    const names = model.externalSystems.map((e) => e.name);
    expect(names).toContain('asyncpg');
    expect(names).toContain('aiomysql');
    expect(names).toContain('sqlite');
  });
});

describe('discoverArchitecture — typed read path (dogfood P1: architecture rendered empty)', () => {
  // REGRESSION: discoverArchitecture used to emit raw Cypher through code.cypher();
  // the SQLite console rejects Cypher, so every section silently caught into its
  // empty default and `horus architecture` showed "0 subsystems" on every real repo
  // (hono: 34 clusters computed, 0 rendered). The model must be populated from the
  // typed methods WITHOUT touching cypher() at all.
  const richCode = {
    cypher: async () => {
      throw new Error('Cypher not supported on this backend');
    },
    overview: async () => ({
      nodesByLabel: { method: 1128, function: 783, file: 450, embedding: 99 },
    }),
    communities: async () => [
      { name: 'Routes+core', memberCount: 320 },
      { name: 'Tests+flask', memberCount: 1638 },
      { name: 'Connectors', memberCount: 210 },
    ],
    processes: async () => [{ name: 'checkout → charge → receipt' }, { name: 'auth → session' }],
    deadCode: async () => ({ total: 42, byFile: {} }),
    coupling: async () => [
      { fileA: 'a.ts', fileB: 'b.ts', strength: 0.9, coChanges: 5 },
      { fileA: 'c.ts', fileB: 'd.ts', strength: 0.2, coChanges: 1 },
    ],
    filesContaining: async (tokens: string[]) =>
      Object.fromEntries(
        tokens.map((t) => [
          t,
          t === 'redis' ? ['src/queue/redis.ts', 'tests/redis.test.ts'] : [],
        ]),
      ),
  } as unknown as CodeProvider;

  it('populates every section from the typed methods, never cypher()', async () => {
    const m = await discoverArchitecture({ code: richCode, db: fakeDb });
    // Subsystems exist and real ones outrank the (larger) test cluster.
    expect(m.subsystems.length).toBe(3);
    expect(m.subsystems[0]?.name).toBe('Routes+core');
    expect(m.subsystems.at(-1)?.name).toBe('Tests+flask');
    // Node stats sorted by count, embeddings filtered.
    expect(m.nodeStats[0]).toEqual({ label: 'method', count: 1128 });
    expect(m.nodeStats.some((s) => s.label === 'embedding')).toBe(false);
    // Flows, fragility, external systems all flow through.
    expect(m.keyFlows).toContain('auth → session');
    expect(m.fragile.deadCode).toBe(42);
    expect(m.fragile.highCouplingPairs).toBe(1); // only the coChanges>=3 pair
    expect(m.externalSystems).toEqual([{ name: 'redis', files: 1 }]); // test path excluded
    expect(m.summary).toContain('3 subsystems');
  });

  it('degrades per-section when the provider lacks the typed methods (old hosts)', async () => {
    const m = await discoverArchitecture({ code: fakeCode, db: fakeDb });
    expect(m.subsystems).toEqual([]);
    expect(m.nodeStats).toEqual([]);
    expect(m.externalSystems).toEqual([]);
    expect(m.fragile).toEqual({ deadCode: 0, highCouplingPairs: 0 });
  });
});

describe('cleanSubsystemName (HOR-377)', () => {
  it('collapses redundant X+x, strips leading underscores, leaves real names', async () => {
    const { cleanSubsystemName } = await import('./architecture.js');
    expect(cleanSubsystemName('Sqs+sqs')).toBe('Sqs');
    expect(cleanSubsystemName('_ext')).toBe('ext');
    expect(cleanSubsystemName('.cache')).toBe('cache');
    expect(cleanSubsystemName('Auth+Data')).toBe('Auth+Data'); // distinct halves preserved
    expect(cleanSubsystemName('Routes+core')).toBe('Routes+core');
  });
});

describe('renderArchitecture — test clusters tagged so "largest" is not contradicted (HOR-377)', () => {
  it('marks testy subsystems with (tests)', async () => {
    const { renderArchitecture } = await import('./render-architecture.js');
    const out = renderArchitecture({
      nodeStats: [],
      subsystems: [
        { name: 'Ext', members: 17 },
        { name: 'Tests+scrapy', members: 1638 },
      ],
      asyncBoundaries: [],
      keyFlows: [],
      externalSystems: [],
      fragile: { deadCode: 0, highCouplingPairs: 0 },
      summary: '2 subsystems (largest: Ext with 17 symbols), ...',
    });
    expect(out).toContain('Tests+scrapy — 1638 members (tests)');
    expect(out).toContain('Ext — 17 members');
    expect(out).not.toContain('Ext — 17 members (tests)');
  });
});

describe('isTestyCommunity (HOR-365)', () => {
  it('flags test/example/docs communities, not real subsystems', async () => {
    const { isTestyCommunity } = await import('./architecture.js');
    expect(isTestyCommunity('Tests+flask')).toBe(true);
    expect(isTestyCommunity('Api-docs+metrics')).toBe(true);
    expect(isTestyCommunity('Examples+webservice')).toBe(true);
    expect(isTestyCommunity('Tutorial+models')).toBe(true);
    expect(isTestyCommunity('Channels+jobs')).toBe(false);
    expect(isTestyCommunity('Routes+core')).toBe(false);
  });

  it('isTestOrExamplePath flags test/example/docs file paths (HOR-366)', async () => {
    const { isTestOrExamplePath } = await import('./architecture.js');
    for (const p of [
      'tests/test_login.py',
      'src/__tests__/a.ts',
      'examples/web/index.js',
      'docs_src/tutorial/x.py',
      'pkg/fixtures/data.py',
    ]) {
      expect(isTestOrExamplePath(p)).toBe(true);
    }
    for (const p of ['sqlmodel/main.py', 'lib/response.js', 'src/app/handler.ts']) {
      expect(isTestOrExamplePath(p)).toBe(false);
    }
  });
});

describe('discoverArchitecture — project scoping (HOR-207)', () => {
  it('returns only the active project queues, never another project (no Zoho leak)', async () => {
    const m = await discoverArchitecture({ code: fakeCode, db: fakeDb, project: 'maison-safqa' });
    const queues = m.asyncBoundaries.map((b) => b.queueName);
    expect(queues.sort()).toEqual(['POST_SEED_PRODUCT_SYNC', 'brand-webhooks']);
    expect(queues.some((q) => q.toLowerCase().includes('zoho'))).toBe(false);
    // Worker classes from the other project must not appear either.
    const workers = m.asyncBoundaries.flatMap((b) => b.workers.map((w) => w.symbol));
    expect(workers).not.toContain('ZohoBatchProcessor');
    expect(workers).not.toContain('ZohoRealtimeProcessor');
  });

  it('the other project sees only its own queues', async () => {
    const m = await discoverArchitecture({ code: fakeCode, db: fakeDb, project: 'leadcall-api' });
    expect(m.asyncBoundaries.map((b) => b.queueName).sort()).toEqual(['zoho-sync-batch', 'zoho-sync-realtime']);
  });

  it('REGRESSION: unscoped (no project) leaks all projects — callers MUST pass project', async () => {
    const m = await discoverArchitecture({ code: fakeCode, db: fakeDb });
    expect(m.asyncBoundaries.map((b) => b.queueName)).toContain('zoho-sync-batch');
  });
});

describe('dogfood cycle-2 architecture quality (N2/N3/N4)', () => {
  it('N2: manifest-derived own packages are excluded from external systems', async () => {
    const code = {
      filesContaining: async (tokens: string[]) =>
        Object.fromEntries(
          tokens.map((t) => [
            t,
            t === 'fastapi' || t === 'redis' ? [`src/uses_${t}.py`] : [],
          ]),
        ),
    } as unknown as CodeProvider;
    // Project label is df2-prefixed — only ownPackages can identify "fastapi" as self.
    const m = await discoverArchitecture({
      code,
      db: fakeDb,
      project: 'df2-fastapi',
      ownPackages: ['fastapi'],
    });
    const names = m.externalSystems.map((e) => e.name);
    expect(names).not.toContain('fastapi');
    expect(names).toContain('redis');
  });

  it('N3: key flows rank real long flows above docs_src one-liners (not alphabetical)', async () => {
    const code = {
      processes: async () => [
        // Alphabetically-first docs one-liner (the fastapi failure mode).
        { name: 'aaa_get_path_param → Path', stepCount: 2, steps: [{ nodeId: 'function:docs_src/tutorial/params.py:aaa_get_path_param' }] },
        { name: 'zz_checkout → charge → receipt', stepCount: 7, steps: [{ nodeId: 'function:src/checkout.py:zz_checkout' }] },
        { name: 'mm_auth → session', stepCount: 3, steps: [{ nodeId: 'function:src/auth.py:mm_auth' }] },
      ],
    } as unknown as CodeProvider;
    const m = await discoverArchitecture({ code, db: fakeDb });
    expect(m.keyFlows[0]).toBe('zz_checkout → charge → receipt'); // longest real flow first
    expect(m.keyFlows.at(-1)).toBe('aaa_get_path_param → Path'); // docs flow last
  });

  it('N4: a community whose MEMBERS are mostly docs/example paths ranks as testy', async () => {
    const docsMembers = Array.from({ length: 10 }, (_, i) => `function:docs_src/tutorial/t${i}.py:f${i}`);
    const realMembers = Array.from({ length: 4 }, (_, i) => `function:src/core/c${i}.py:g${i}`);
    const code = {
      communities: async () => [
        // Bigger docs cluster with a name NO token list flags.
        { name: 'Path_params_numeric_validations+Scripts', memberCount: 10, members: docsMembers },
        { name: 'Routing+Core', memberCount: 4, members: realMembers },
      ],
    } as unknown as CodeProvider;
    const m = await discoverArchitecture({ code, db: fakeDb });
    expect(m.subsystems[0]?.name).toBe('Routing+Core'); // real subsystem leads despite fewer members
  });
});

describe('async-boundary hygiene (dogfood: fixture + code-fragment queue names)', () => {
  it('drops malformed queue names and fixture-only edges; keeps real ones', async () => {
    const { discoverArchitecture: discover } = await import('./architecture.js');
    const EDGES: QueueEdge[] = [
      edge('real-queue', 'p', 'Producer', 'Worker'),
      // Malformed: multiline code fragment captured as a "queue name".
      { ...edge('x', 'p', 'A', 'B'), queueName: 'const q = new Queue(\n  "oops"' },
      // Fixture-only: both endpoints in test trees.
      {
        ...edge('fixture-queue', 'p', 'FakeProducer', 'FakeWorker'),
        producerFile: 'tests/fixtures/queues.ts',
        workerFile: '__tests__/worker.test.ts',
      },
    ];
    vi.mocked((await import('@horus/db')).listQueueEdges).mockResolvedValueOnce(EDGES as never);
    const m = await discover({ code: fakeCode, db: fakeDb, project: 'p' });
    expect(m.asyncBoundaries.map((b) => b.queueName)).toEqual(['real-queue']);
  });
});
