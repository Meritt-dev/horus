/**
 * HOR — Tests for the `horus memory` command group (show/add/confirm/forget/pin/list).
 *
 * Offline: the engine renderers (renderMemoryView / memoryViewToJSON) run for real against a
 * fixture MemoryView; the DB, connectors, engine synthesis (buildMemoryView), the MemoryStore
 * (createLocalMemoryStore) and the recall layer (recallMemory) are mocked. We pin: project
 * isolation (unresolved project → hard error, no DB/connectors touched), the pool is always
 * closed, scope+project are threaded into buildMemoryView, --json stays a single parseable
 * document while the default path renders Markdown, the authored-substrate leaves route to the
 * store with the right shapes, the PII gate surfaces as a clean error, soft-forget routes to
 * `forgotten`, and confirmed-outcome stays private + linked to its investigation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryView, RecalledMemory } from '@horus/engine';
import { MemorySecretError } from '@horus/engine';

const sqlEnd = vi.fn(async () => {});
const db = vi.hoisted(() => ({
  openDb: vi.fn(),
  getInvestigation: vi.fn(),
  recordOutcomeLabel: vi.fn(),
  listOutcomeLabels: vi.fn(),
}));
/** The Source-when-available memory vector index (M2). Mocked so we can assert best-effort wiring. */
const vectorIndex = vi.hoisted(() => ({
  upsert: vi.fn(async () => {}),
  search: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
}));
const connectors = vi.hoisted(() => ({
  createConnectors: vi.fn(() => ({ code: { kind: 'fake-code' } })),
  memoryIndexForEnv: vi.fn(() => vectorIndex),
}));
const store = vi.hoisted(() => ({
  add: vi.fn(),
  addLink: vi.fn(),
  removeLink: vi.fn(),
  setStatus: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  buildMemoryView: vi.fn(),
  createLocalMemoryStore: vi.fn(() => store),
  recallMemory: vi.fn(),
  detectMemoryEdges: vi.fn(),
}));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  // Keep summarizeOutcomeLabels + isOutcomeSource REAL so the read path is exercised end-to-end;
  // only the DB-touching calls are mocked.
  return {
    ...actual,
    openDb: db.openDb,
    getInvestigation: db.getInvestigation,
    recordOutcomeLabel: db.recordOutcomeLabel,
    listOutcomeLabels: db.listOutcomeLabels,
  };
});
vi.mock('@horus/connectors', () => connectors);
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return {
    ...actual,
    buildMemoryView: engine.buildMemoryView,
    createLocalMemoryStore: engine.createLocalMemoryStore,
    recallMemory: engine.recallMemory,
    detectMemoryEdges: engine.detectMemoryEdges,
  };
});

import {
  runMemoryShow,
  runMemoryAdd,
  runMemoryConfirm,
  runMemoryForget,
  runMemoryPin,
  runMemoryList,
  runMemoryLink,
  runMemoryUnlink,
  runMemoryDetect,
  runMemoryAccuracy,
} from './memory.js';

/** Build a fixture RecalledMemory (what recallMemory returns) for show/list assertions. */
function recalled(over: {
  item?: Partial<RecalledMemory['item']>;
  freshness?: Partial<RecalledMemory['freshness']>;
} = {}): RecalledMemory {
  const item = {
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
    payload: null,
    ...over.item,
  } as RecalledMemory['item'];
  return {
    item,
    relevance: 0,
    rank: 0.8,
    freshness: {
      status: 'fresh',
      ageDays: 5,
      verified: false,
      decay: 1,
      driftDetected: false,
      label: 'fresh',
      ...over.freshness,
    },
  };
}

const dirs: string[] = [];
function writeSingleProjectConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-memory-'));
  dirs.push(dir);
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
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
  return path;
}

function writeMultiProjectConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-memory-'));
  dirs.push(dir);
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [
    { name: "api-a", repositories: [{ name: "api-a", path: "/repos/api-a" }], environments: [{ name: "production", connectors: {} }] },
    { name: "api-b", repositories: [{ name: "api-b", path: "/repos/api-b" }], environments: [{ name: "production", connectors: {} }] },
  ],
};
`,
    'utf8',
  );
  return path;
}

const FIXTURE: MemoryView = {
  scope: 'payments',
  project: 'my-api',
  area: 'src/payments',
  tokens: ['payments', 'checkout'],
  sourceAvailable: true,
  ownedAreas: {
    subsystems: [
      { name: 'payments', members: 24, testy: false },
      { name: 'payments-tests', members: 9, testy: true },
    ],
    seedSymbol: { name: 'PaymentService', file: 'src/payments/payment.service.ts' },
    ownership: {
      likelyMaintainer: 'alice',
      maintainerShare: 0.6,
      mostActiveRecent: 'bob',
      confidence: 0.7,
      file: 'src/payments/payment.service.ts',
      evidence: [],
    } as unknown as MemoryView['ownedAreas']['ownership'],
  },
  runtimePaths: {
    asyncBoundaries: [
      {
        queueName: 'payment-retry-queue',
        producers: [{ symbol: 'PaymentService', file: 'src/payments/payment.service.ts' }],
        workers: [{ symbol: 'PaymentRetryWorker', file: 'src/workers/payment-retry.worker.ts' }],
      },
    ],
    keyFlows: ['PaymentController → PaymentService → payment-retry-queue → PaymentRetryWorker'],
    queuesSeenInIncidents: ['payment-retry-queue'],
  },
  externalSystems: [{ name: 'stripe', files: 5 }],
  pastInvestigations: [
    {
      investigationId: 'inv-1',
      title: 'Payment retries piling up',
      summary: 'Retry queue backed up after a Stripe timeout.',
      date: '2026-06-01T00:00:00.000Z',
      overlap: 0.5,
      sharedTags: ['payments'],
      suspectedCause: { title: 'Stripe timeout', category: 'external-dependency', band: 'likely' },
      confidence: 0.74,
      confirmedProxy: true,
      sources: ['logs', 'metrics'],
    },
  ],
  recurringPatterns: [{ signature: 'src/payments|external-dependency|payment-retry-queue', count: 3 }],
  evidenceSources: {
    channels: ['logs', 'metrics'],
    alwaysAvailable: ['source-intelligence graph (code structure)', 'git history'],
  },
  weakSpots: {
    fragile: { deadCode: 3, highCouplingPairs: 7, scope: 'repo-wide' },
    testLightSubsystems: ['payments-tests'],
    lowPriorEvidence: false,
    lowPriorEvidenceReason: '',
  },
  summary:
    'Memory for "payments" in my-api: 2 owned subsystem(s), 1 queue boundary(ies), 1 external system(s), 1 past investigation(s), 1 recurring pattern(s).',
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  db.recordOutcomeLabel.mockResolvedValue({ id: 'ol_1' });
  db.listOutcomeLabels.mockResolvedValue([]);
  engine.buildMemoryView.mockResolvedValue(FIXTURE);
  engine.recallMemory.mockResolvedValue([]);
  engine.createLocalMemoryStore.mockReturnValue(store);
  store.add.mockResolvedValue({ id: 'mem_new', kind: 'code-fact', scope: 'repo', visibility: 'private' });
  store.addLink.mockResolvedValue(undefined);
  store.removeLink.mockResolvedValue(1);
  store.setStatus.mockResolvedValue(undefined);
  engine.detectMemoryEdges.mockResolvedValue([]);
  connectors.memoryIndexForEnv.mockReturnValue(vectorIndex);
  vectorIndex.upsert.mockResolvedValue(undefined);
  vectorIndex.search.mockResolvedValue([]);
  vectorIndex.remove.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function stdout(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('runMemoryShow — project isolation (HOR-46)', () => {
  it('errors when the project cannot be resolved, touching neither connectors nor DB', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Could not resolve a project');
    expect(connectors.createConnectors).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
    expect(engine.buildMemoryView).not.toHaveBeenCalled();
  });
});

describe('runMemoryShow — synthesis path', () => {
  it('threads scope + resolved project into buildMemoryView and always closes the pool', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    expect(engine.buildMemoryView).toHaveBeenCalledWith(
      'payments',
      expect.objectContaining({ project: 'my-api', db: expect.anything(), code: expect.anything() }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('closes the pool even when synthesis throws', async () => {
    const config = writeSingleProjectConfig();
    engine.buildMemoryView.mockRejectedValueOnce(new Error('graph host unreachable'));
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(1);
    expect(sqlEnd).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('graph host unreachable');
  });

  it('renders Markdown by default', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('# Memory: payments');
    expect(out).toContain('## Owned areas');
    expect(out).toContain('payment-retry-queue');
    expect(out).toContain('Past investigations');
  });

  it('emits a single parseable JSON document under --json', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.scope).toBe('payments');
    expect(parsed.project).toBe('my-api');
    expect(parsed.pastInvestigations[0].confirmedProxy).toBe(true);
    expect(parsed.weakSpots.fragile.scope).toBe('repo-wide');
  });

  // HOR-386 — self-routing: nothing stored yet → suggest `horus investigate <scope>`.
  it('routes an empty memory (no stored items) to `horus investigate <scope>`', async () => {
    engine.recallMemory.mockResolvedValueOnce([]); // no authored items
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('Suggested next:');
    expect(out).toContain('horus investigate payments');
  });

  it('carries the investigate route structurally on --json when empty', async () => {
    engine.recallMemory.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout()) as { nextSteps: { nextTool: string; args: string }[] };
    expect(parsed.nextSteps).toEqual([
      { nextTool: 'investigate', args: 'payments', reason: expect.any(String) },
    ]);
  });

  it('merges PERSISTED authored items into the view, clearly sectioned (Markdown + JSON)', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    // recall is scoped to the resolved repo with the scope as the relevance text.
    expect(engine.recallMemory).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api', text: 'payments' }),
      expect.objectContaining({ limit: 50 }),
    );
    const out = stdout();
    expect(out).toContain('## Stored memory items');
    expect(out).toContain('Payments use Stripe idempotency keys');
  });

  it('carries storedItems in the --json document', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.scope).toBe('payments');
    expect(Array.isArray(parsed.storedItems)).toBe(true);
    expect(parsed.storedItems[0].id).toBe('mem_1');
    expect(parsed.storedItems[0].effectiveStatus).toBe('fresh');
  });
});

describe('runMemoryAdd', () => {
  it('stores an evidenced inferred disposition privately without confirming cause or accuracy', async () => {
    const config = writeSingleProjectConfig();
    const outcomeFile = join(dirs.at(-1)!, 'inferred.json');
    const outcome = {
      disposition: 'confirmed-incident', certainty: 'inferred', sourceInvestigation: 'inv-1',
      sourceRefs: ['runtime:reserve-response'], actualCause: 'Ambiguous reservation response',
      applicability: { environment: 'production', errorCode: 'ETIMEDOUT' },
      checks: ['Read the existing reservation'], invalidatingConditions: ['Explicit stock rejection'],
    };
    writeFileSync(outcomeFile, JSON.stringify(outcome));
    db.getInvestigation.mockResolvedValueOnce({ id: 'inv-1', project: 'my-api', title: 'Reserve timeout', report: { input: { hint: 'EMODA reserve indeterminate ETIMEDOUT' } } });
    expect(await runMemoryAdd('Reservation result remains unknown', { config, outcomeFile, json: true })).toBe(0);
    expect(store.add.mock.calls[0]![0]).toMatchObject({
      kind: 'incident-pattern', source: 'derived', visibility: 'private', repo: 'my-api',
      claim: 'Inferred confirmed-incident: Reservation result remains unknown',
      payload: { investigationId: 'inv-1', hint: 'EMODA reserve indeterminate ETIMEDOUT', outcome },
    });
    expect(store.add.mock.calls[0]![0].lastVerifiedAt).toBeUndefined();
    expect(store.addLink).toHaveBeenCalledWith(expect.objectContaining({ rel: 'about-incident', toRef: 'inv-1' }));
    expect(db.recordOutcomeLabel).not.toHaveBeenCalled();
    expect(JSON.parse(stdout()).ok).toBe(true);
  });

  it.each([
    { certainty: 'confirmed', attester: 'Operator', verifiedAt: '2026-10-03T00:00:00Z' },
    { sourceRefs: [] }, { sourceRefs: [' '] }, { sourceInvestigation: '' }, { certainty: 'maybe' },
  ])('rejects unsupported disposition provenance before opening the database: %j', async patch => {
    const config = writeSingleProjectConfig();
    const outcomeFile = join(dirs.at(-1)!, 'invalid.json');
    writeFileSync(outcomeFile, JSON.stringify({
      disposition: 'unknown', certainty: 'inferred', sourceInvestigation: 'inv-1',
      sourceRefs: ['runtime:1'], applicability: {}, checks: [], invalidatingConditions: [], ...patch,
    }));
    expect(await runMemoryAdd('Unknown result', { config, outcomeFile })).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(store.add).not.toHaveBeenCalled();
  });

  it.each([null, { id: 'inv-1', project: 'other-api' }, { id: 'inv-1', project: null }])('rejects missing or out-of-project source investigations: %j', async investigation => {
    const config = writeSingleProjectConfig();
    const outcomeFile = join(dirs.at(-1)!, 'inferred.json');
    writeFileSync(outcomeFile, JSON.stringify({
      disposition: 'unknown', certainty: 'inferred', sourceInvestigation: 'inv-1',
      sourceRefs: ['runtime:1'], applicability: {}, checks: [], invalidatingConditions: [],
    }));
    db.getInvestigation.mockResolvedValueOnce(investigation);
    expect(await runMemoryAdd('Unknown result', { config, outcomeFile })).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('routes a human claim to the store with the resolved repo + parsed evidence', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('Payments are idempotent', {
      config,
      scope: 'module:payments',
      kind: 'contract',
      evidence: ['code:src/payments/pay.ts', 'a free note'],
    });
    expect(code).toBe(0);
    expect(store.add).toHaveBeenCalledTimes(1);
    const [item, audit] = store.add.mock.calls[0]!;
    expect(item).toMatchObject({
      kind: 'contract',
      claim: 'Payments are idempotent',
      scope: 'module:payments',
      source: 'human',
      repo: 'my-api',
      confidence: 0.75,
    });
    expect(item.evidence).toEqual([
      expect.objectContaining({ kind: 'code', ref: 'src/payments/pay.ts' }),
      expect.objectContaining({ kind: 'note', ref: 'a free note' }),
    ]);
    expect(audit.actor.kind).toBe('user');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('emits clean JSON under --json', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toEqual({ ok: true, id: 'mem_new', kind: 'code-fact', scope: 'repo' });
  });

  it('rejects an unknown --kind before touching the store', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, kind: 'nonsense' });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Unknown --kind');
  });

  it('rejects an out-of-range --confidence', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, confidence: '5' });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
  });

  it('surfaces the PII/secret gate as a clean error (exit 1)', async () => {
    store.add.mockRejectedValueOnce(new MemorySecretError('aws-access-key-id'));
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('key is AKIA...', { config });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('aws-access-key-id');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('errors on an unresolved project without opening the DB (HOR-46)', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryAdd('A fact', { config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});

describe('runMemoryConfirm — confirmed-outcome flywheel', () => {
  it('an explicit disposition records its actual cause without relabeling Horus accuracy', async () => {
    const config = writeSingleProjectConfig();
    const outcomeFile = join(dirs.at(-1)!, 'disposition.json');
    writeFileSync(outcomeFile, JSON.stringify({ disposition: 'expected-behavior', certainty: 'confirmed', actualCause: 'Intentional stock reservation refusal', sourceInvestigation: 'inv-1', sourceRefs: ['runtime-check:1'], attester: 'Operator', verifiedAt: '2026-09-27T01:00:00Z', applicability: { environment: 'production', errorCode: 'STOCK' }, checks: ['Check current stock'], invalidatingConditions: [] }));
    db.getInvestigation.mockResolvedValueOnce({ id: 'inv-1', title: 'Stock refusal', project: 'my-api', report: { summary: 'Unconfirmed outage', confidence: 0.2 } });
    expect(await runMemoryConfirm('inv-1', { config, outcomeFile })).toBe(0);
    expect(store.add.mock.calls[0]![0].claim).toContain('Intentional stock reservation refusal');
    expect(store.add.mock.calls[0]![0].claim).not.toContain('Unconfirmed outage');
    expect(db.recordOutcomeLabel).not.toHaveBeenCalled();
  });

  it('errors when the investigation is not found', async () => {
    db.getInvestigation.mockResolvedValueOnce(null);
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-x', { config });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
    expect(sqlEnd).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Investigation not found');
  });

  it('writes a PRIVATE confirmed-outcome item and links it to the investigation', async () => {
    db.getInvestigation.mockResolvedValueOnce({
      id: 'inv-1',
      title: 'Payment retries piling up',
      summary: null,
      report: { summary: 'Stripe timeout filled the retry queue', confidence: 0.74 },
    });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config });
    expect(code).toBe(0);

    const [item] = store.add.mock.calls[0]!;
    expect(item).toMatchObject({
      kind: 'confirmed-outcome',
      source: 'confirmed-outcome',
      visibility: 'private',
      repo: 'my-api',
      confidence: 0.74,
    });
    expect(item.claim).toContain('Payment retries piling up');
    expect(item.claim).toContain('Stripe timeout filled the retry queue');

    expect(store.addLink).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMemoryId: 'mem_co',
        rel: 'about-incident',
        toKind: 'incident',
        toRef: 'inv-1',
      }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('ALSO records a converged outcome label (resolved=yes, source=confirm, project-scoped)', async () => {
    db.getInvestigation.mockResolvedValueOnce({
      id: 'inv-1',
      title: 'Payment retries piling up',
      summary: null,
      report: { summary: 'Stripe timeout filled the retry queue', confidence: 0.74 },
    });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config, note: 'verified in prod' });
    expect(code).toBe(0);
    expect(db.recordOutcomeLabel).toHaveBeenCalledTimes(1);
    const [, label] = db.recordOutcomeLabel.mock.calls[0]!;
    expect(label).toMatchObject({
      investigationId: 'inv-1',
      resolved: 'yes',
      source: 'confirm',
      project: 'my-api',
      confirmedCause: 'Stripe timeout filled the retry queue',
      note: 'verified in prod',
    });
  });

  it('emits clean JSON under --json', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: 'inv-1', title: 'X', summary: 'done', report: null });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toEqual({ ok: true, id: 'mem_co', investigationId: 'inv-1', visibility: 'private' });
  });
});

describe('runMemoryForget / runMemoryPin', () => {
  it('soft-forget routes to status=forgotten (row retained, audited)', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('mem_1', { config });
    expect(code).toBe(0);
    expect(store.setStatus).toHaveBeenCalledWith(
      'mem_1',
      'forgotten',
      expect.objectContaining({ actor: { kind: 'user' } }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('pin routes to status=pinned and emits clean JSON', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryPin('mem_1', { config, json: true });
    expect(code).toBe(0);
    expect(store.setStatus).toHaveBeenCalledWith('mem_1', 'pinned', expect.anything());
    expect(JSON.parse(stdout())).toEqual({ ok: true, id: 'mem_1', status: 'pinned' });
  });

  it('errors on a blank id without opening the DB', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('   ', { config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});

describe('runMemoryList', () => {
  it('lists persisted items via recall, scoped to the repo, with clean JSON', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryList({ config, json: true });
    expect(code).toBe(0);
    expect(engine.recallMemory).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api', status: undefined }),
      expect.objectContaining({ limit: 200 }),
    );
    const parsed = JSON.parse(stdout());
    expect(parsed.project).toBe('my-api');
    expect(parsed.items[0].id).toBe('mem_1');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('--all surfaces every status (incl. forgotten)', async () => {
    engine.recallMemory.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryList({ config, all: true });
    expect(code).toBe(0);
    const [, query] = engine.recallMemory.mock.calls[0]!;
    expect(query.status).toEqual(
      expect.arrayContaining(['fresh', 'forgotten', 'deprecated', 'contradicted', 'pinned', 'possibly-stale']),
    );
  });
});

// ---------------------------------------------------------------------------
// memory link / unlink / detect — the memory→memory link graph (FROZEN day-0 rels)
// ---------------------------------------------------------------------------

describe('runMemoryLink', () => {
  it('authors a memory→memory edge with toKind=memory and detection=manual', async () => {
    store.addLink.mockResolvedValueOnce({ id: 'lnk_1', rel: 'supersedes', fromMemoryId: 'mem_a', toRef: 'mem_b' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryLink('mem_a', 'mem_b', { config, rel: 'supersedes', note: 'triage' });
    expect(code).toBe(0);
    expect(store.addLink).toHaveBeenCalledTimes(1);
    const [link, opts] = store.addLink.mock.calls[0]!;
    expect(link).toMatchObject({ fromMemoryId: 'mem_a', rel: 'supersedes', toKind: 'memory', toRef: 'mem_b' });
    expect(opts).toMatchObject({ detection: 'manual', audit: { actor: { kind: 'user' }, note: 'triage' } });
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('emits clean JSON under --json', async () => {
    store.addLink.mockResolvedValueOnce({ id: 'lnk_1', rel: 'recurs-with', fromMemoryId: 'mem_a', toRef: 'mem_b' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryLink('mem_a', 'mem_b', { config, rel: 'recurs-with', json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ ok: true, id: 'lnk_1', rel: 'recurs-with', from: 'mem_a', to: 'mem_b' });
  });

  it('rejects an out-of-vocabulary --rel before touching the store (FROZEN vocab)', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryLink('mem_a', 'mem_b', { config, rel: 'about-symbol' });
    expect(code).toBe(1);
    expect(store.addLink).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('--rel must be one of');
  });

  it('errors on a missing endpoint id without opening the DB', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryLink('mem_a', '  ', { config, rel: 'supersedes' });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });

  it('surfaces a store rejection (e.g. self-link / cross-repo) as a clean error', async () => {
    store.addLink.mockRejectedValueOnce(new Error('memory_link rejects a self-link'));
    const config = writeSingleProjectConfig();
    const code = await runMemoryLink('mem_a', 'mem_a', { config, rel: 'recurs-with' });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('self-link');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });
});

describe('runMemoryUnlink', () => {
  it('removes a memory→memory edge, recording the user actor', async () => {
    store.removeLink.mockResolvedValueOnce(1);
    const config = writeSingleProjectConfig();
    const code = await runMemoryUnlink('mem_a', 'mem_b', { config, rel: 'contradicts', note: 'resolved' });
    expect(code).toBe(0);
    expect(store.removeLink).toHaveBeenCalledWith(
      { fromMemoryId: 'mem_a', rel: 'contradicts', toRef: 'mem_b' },
      { audit: { actor: { kind: 'user' }, note: 'resolved' } },
    );
    // HONESTY: unlink never re-statuses an item.
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('a missing edge is a no-op (exit 0, removed: 0)', async () => {
    store.removeLink.mockResolvedValueOnce(0);
    const config = writeSingleProjectConfig();
    const code = await runMemoryUnlink('mem_a', 'mem_b', { config, rel: 'supersedes', json: true });
    expect(code).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ ok: true, removed: 0, rel: 'supersedes', from: 'mem_a', to: 'mem_b' });
  });

  it('rejects an out-of-vocabulary --rel before touching the store', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryUnlink('mem_a', 'mem_b', { config, rel: 'has-evidence' });
    expect(code).toBe(1);
    expect(store.removeLink).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
  });
});

describe('runMemoryDetect', () => {
  const recurrence = {
    fromMemoryId: 'mem_a',
    toMemoryId: 'mem_b',
    rel: 'recurs-with' as const,
    detection: 'auto:recurrence' as const,
    reason: 'same retry-queue signature',
  };
  const contradiction = {
    fromMemoryId: 'mem_c',
    toMemoryId: 'mem_d',
    rel: 'contradicts' as const,
    detection: 'auto:contradiction' as const,
    reason: 'opposing claims about idempotency',
  };

  it('invokes the detectors scoped to the resolved repo, threading the vector index', async () => {
    engine.detectMemoryEdges.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryDetect({ config });
    expect(code).toBe(0);
    expect(engine.detectMemoryEdges).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api' }),
      expect.objectContaining({ vectorIndex }),
    );
  });

  it('--dry-run PRINTS proposals and writes NOTHING (no addLink, no status flip)', async () => {
    engine.detectMemoryEdges.mockResolvedValueOnce([recurrence, contradiction]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryDetect({ config, dryRun: true });
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('Proposed 2 edge(s)');
    expect(out).toContain('auto:recurrence');
    expect(out).toContain('auto:contradiction');
    // HONESTY: dry-run is read-only — nothing is persisted or re-statused.
    expect(store.addLink).not.toHaveBeenCalled();
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('--dry-run --json carries the proposed edges with applied=0', async () => {
    engine.detectMemoryEdges.mockResolvedValueOnce([recurrence]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryDetect({ config, dryRun: true, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toMatchObject({ ok: true, dryRun: true, proposed: 1, applied: 0 });
    expect(parsed.edges[0]).toMatchObject({ rel: 'recurs-with', detection: 'auto:recurrence' });
    expect(store.addLink).not.toHaveBeenCalled();
  });

  it('without --dry-run persists each edge with its honest auto:* detection label', async () => {
    engine.detectMemoryEdges.mockResolvedValueOnce([recurrence, contradiction]);
    store.addLink.mockResolvedValue({ id: 'lnk_x' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryDetect({ config });
    expect(code).toBe(0);
    expect(store.addLink).toHaveBeenCalledTimes(2);
    const [link0, opts0] = store.addLink.mock.calls[0]!;
    expect(link0).toMatchObject({ fromMemoryId: 'mem_a', rel: 'recurs-with', toKind: 'memory', toRef: 'mem_b' });
    expect(opts0).toMatchObject({ detection: 'auto:recurrence', audit: { actor: { kind: 'system' } } });
    const [link1, opts1] = store.addLink.mock.calls[1]!;
    expect(link1).toMatchObject({ fromMemoryId: 'mem_c', rel: 'contradicts', toKind: 'memory', toRef: 'mem_d' });
    expect(opts1).toMatchObject({ detection: 'auto:contradiction' });
    // HONESTY: a detected contradiction is a FLAG — applying it NEVER re-statuses an item.
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('fails closed when the project cannot be resolved (HOR-46), without opening the DB', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryDetect({ config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(engine.detectMemoryEdges).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// memory accuracy — read the converged outcome-label eval set (HOR-390)
// ---------------------------------------------------------------------------

/** Build a fixture outcome-label row (what listOutcomeLabels returns). */
function labelRow(over: {
  id?: string;
  investigationId?: string | null;
  resolved?: 'yes' | 'partly' | 'no';
  source?: 'feedback' | 'confirm';
  at?: string;
  project?: string | null;
} = {}): Record<string, unknown> {
  return {
    id: over.id ?? 'ol_1',
    investigationId: over.investigationId ?? 'inv-1',
    project: over.project ?? 'my-api',
    resolved: over.resolved ?? 'yes',
    confirmedCause: null,
    note: null,
    source: over.source ?? 'confirm',
    payload: null,
    at: new Date(over.at ?? '2026-06-20T00:00:00.000Z'),
  };
}

describe('runMemoryAccuracy — eval-set read path', () => {
  it('scopes the query to the resolved project (HOR-46) and summarizes the dataset (clean JSON)', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([
      labelRow({ id: 'a', investigationId: 'inv-1', resolved: 'yes', source: 'confirm' }),
      labelRow({ id: 'b', investigationId: 'inv-2', resolved: 'partly', source: 'feedback' }),
      labelRow({ id: 'c', investigationId: 'inv-3', resolved: 'no', source: 'feedback' }),
    ]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, json: true });
    expect(code).toBe(0);
    // Project-scoped read (fail-closed isolation).
    expect(db.listOutcomeLabels).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ project: 'my-api' }),
    );
    const parsed = JSON.parse(stdout());
    expect(parsed.project).toBe('my-api');
    expect(parsed.summary.evaluated).toBe(3);
    expect(parsed.summary.counts).toEqual({ yes: 1, partly: 1, no: 1 });
    expect(parsed.summary.accuracy).toBeCloseTo(1 / 3, 5);
    expect(parsed.summary.weightedScore).toBeCloseTo(1.5 / 3, 5);
    expect(parsed.summary.bySource).toEqual({ feedback: 2, confirm: 1 });
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('dedupes append-only history to the latest verdict per investigation', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([
      // Newest-first: inv-1 was corrected from 'no' → 'yes'; only the latest counts.
      labelRow({ id: 'new', investigationId: 'inv-1', resolved: 'yes', at: '2026-06-25T00:00:00.000Z' }),
      labelRow({ id: 'old', investigationId: 'inv-1', resolved: 'no', at: '2026-06-20T00:00:00.000Z' }),
    ]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.summary.evaluated).toBe(1);
    expect(parsed.summary.attestations).toBe(2);
    expect(parsed.summary.counts).toEqual({ yes: 1, partly: 0, no: 0 });
  });

  it('passes --source and --days through to the query', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, source: 'feedback', days: 7, json: true });
    expect(code).toBe(0);
    const [, query] = db.listOutcomeLabels.mock.calls[0]!;
    expect(query.source).toBe('feedback');
    expect(query.since).toBeInstanceOf(Date);
  });

  it('windows to a default recent range when no time flag is given (HOR-427)', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const before = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const code = await runMemoryAccuracy({ config, json: true });
    const after = Date.now() - 29 * 24 * 60 * 60 * 1000;
    expect(code).toBe(0);
    // The query carries a default lower bound (~30d ago) so pre-fix history can't drag the metric.
    const [, query] = db.listOutcomeLabels.mock.calls[0]!;
    expect(query.since).toBeInstanceOf(Date);
    expect(query.since.getTime()).toBeGreaterThan(before);
    expect(query.since.getTime()).toBeLessThan(after);
    const parsed = JSON.parse(stdout());
    expect(parsed.since).not.toBeNull();
    expect(parsed.window).toContain('default');
  });

  it('--all disables the window (full retained history)', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, all: true, json: true });
    expect(code).toBe(0);
    const [, query] = db.listOutcomeLabels.mock.calls[0]!;
    expect(query.since).toBeUndefined();
    const parsed = JSON.parse(stdout());
    expect(parsed.since).toBeNull();
    expect(parsed.window).toBe('all time');
  });

  it('--since accepts an absolute date and uses it as the lower bound', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, since: '2026-06-01', json: true });
    expect(code).toBe(0);
    const [, query] = db.listOutcomeLabels.mock.calls[0]!;
    expect(query.since).toBeInstanceOf(Date);
    expect(query.since.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('rejects an unparseable --since without opening the DB', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, since: 'not-a-date' });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('--since must be a parseable date');
  });

  it('rejects an invalid --source without opening the DB', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config, source: 'bogus' });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Unknown --source');
  });

  it('fails closed when the project cannot be resolved (HOR-46), without touching the DB', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryAccuracy({ config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Could not resolve a project');
  });

  it('handles an empty eval set without crashing', async () => {
    db.listOutcomeLabels.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryAccuracy({ config });
    expect(code).toBe(0);
    expect(stdout()).toContain('No outcome labels in this window');
  });
});

// ---------------------------------------------------------------------------
// M2 — Source-when-available vector index wiring (best-effort, local-only)
// ---------------------------------------------------------------------------

describe('memory M2 — vector index wiring', () => {
  it('add fires a best-effort vector upsert with the resolved repo + claim + scope', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('Payments are idempotent', {
      config,
      scope: 'module:payments',
    });
    expect(code).toBe(0);
    // The index is resolved Source-when-available for the resolved env (memoryIndexForEnv).
    expect(connectors.memoryIndexForEnv).toHaveBeenCalled();
    expect(vectorIndex.upsert).toHaveBeenCalledWith({
      memoryId: 'mem_new',
      claim: 'Payments are idempotent',
      repo: 'my-api',
      scope: 'module:payments',
    });
  });

  it('add NEVER fails or dirties --json when the vector upsert throws (host down)', async () => {
    vectorIndex.upsert.mockRejectedValueOnce(new Error('source host unreachable'));
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, json: true });
    expect(code).toBe(0);
    // The durable record was still persisted, and --json stays a single parseable document.
    expect(store.add).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout())).toEqual({ ok: true, id: 'mem_new', kind: 'code-fact', scope: 'repo' });
  });

  it('confirm fires a best-effort upsert of the confirmed-outcome claim (repo-scoped)', async () => {
    db.getInvestigation.mockResolvedValueOnce({
      id: 'inv-1',
      title: 'Payment retries piling up',
      summary: null,
      report: { summary: 'Stripe timeout filled the retry queue', confidence: 0.74 },
    });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config });
    expect(code).toBe(0);
    expect(vectorIndex.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: 'mem_co',
        repo: 'my-api',
        scope: 'repo',
        claim: expect.stringContaining('Payment retries piling up'),
      }),
    );
  });

  it('show threads the Source-when-available index into recallMemory (not a hard-coded Noop)', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    expect(engine.recallMemory).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api', text: 'payments' }),
      expect.objectContaining({ limit: 50, vectorIndex }),
    );
  });

  it('forget best-effort removes the derived vector for the soft-forgotten item', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('mem_1', { config });
    expect(code).toBe(0);
    expect(vectorIndex.remove).toHaveBeenCalledWith('mem_1');
  });

  it('forget tolerates a failing vector removal (still exits 0)', async () => {
    vectorIndex.remove.mockRejectedValueOnce(new Error('host down'));
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('mem_1', { config });
    expect(code).toBe(0);
    expect(store.setStatus).toHaveBeenCalledWith('mem_1', 'forgotten', expect.anything());
  });
});
