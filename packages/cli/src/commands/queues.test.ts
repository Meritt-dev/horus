/**
 * HOR-213 — AI contract and prompt shape tests for `horus queues --live --ai`.
 * Plus command-level tests: queue-edge hygiene at the read path (garbage edges
 * filtered, empty-state messaging, valid JSON with a note) and config-driven
 * --live guidance (tip gated on a queue-capable Redis connector).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, listQueueEdges, type QueueEdge } from '@horus/db';
import { runQueues, QUEUES_AI_CONTRACT } from './queues.js';

vi.mock('../lib/freshness.js', () => ({
  readIndexMeta: vi.fn(() => ({ lastIndexedAt: '2026-07-03T00:00:00Z' })),
}));
vi.mock('@horus/db', () => ({
  openDb: vi.fn(),
  listQueueEdges: vi.fn(),
  // Real predicate: the command must recognise the display-only fallback's error prefix.
  isDbUnavailable: (err: unknown) => err instanceof Error && err.message.startsWith('HORUS_DB_UNAVAILABLE'),
}));

vi.mock('@horus/core', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@horus/core')>();
  return { ...orig, loadConfig: vi.fn(), resolveEnvironment: vi.fn() };
});

const SAMPLE_LIVE_EVIDENCE = {
  prefix: 'bull',
  collectedAt: '2026-06-17T09:00:00.000Z',
  queues: [
    {
      queueName: 'payment-processing',
      waiting: 312,
      active: 4,
      failed: 89,
      delayed: 12,
      paused: 0,
      isPaused: false,
      runtimeOnly: false,
      failedBreakdown: [{ reason: 'GATEWAY_TIMEOUT', count: 67 }],
    },
    {
      queueName: 'email-dispatch',
      waiting: 0,
      active: 1,
      failed: 0,
      delayed: 0,
      paused: 0,
      isPaused: true,
      runtimeOnly: false,
    },
    {
      queueName: 'legacy-sync',
      waiting: 5,
      active: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
      isPaused: false,
      runtimeOnly: true,
    },
  ],
};

describe('QUEUES_AI_CONTRACT (HOR-213)', () => {
  it('describes all required output sections', () => {
    expect(QUEUES_AI_CONTRACT).toContain('Evidence used');
    expect(QUEUES_AI_CONTRACT).toContain('What stands out');
    expect(QUEUES_AI_CONTRACT).toContain('What this may indicate');
    expect(QUEUES_AI_CONTRACT).toContain('What is not proven');
    expect(QUEUES_AI_CONTRACT).toContain('Next checks');
  });
});

describe('buildInterpretationPrompt for queues (HOR-213)', () => {
  it('prompt serializes live queue state — names, counts, and paused state visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('payment-processing');
    expect(prompt).toContain('email-dispatch');
    expect(prompt).toContain('GATEWAY_TIMEOUT');
    expect(prompt).toContain('312');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
    expect(prompt).toContain('Do not invent files');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('What is not proven');
    expect(prompt).toContain('What stands out');
  });

  it('runtime-only flag is part of the evidence', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('legacy-sync');
    expect(prompt).toContain('runtimeOnly');
  });
});

// ---------------------------------------------------------------------------
// Command-level tests: read-path hygiene + config-driven --live guidance
// ---------------------------------------------------------------------------

function qedge(queueName: string, over: Partial<QueueEdge> = {}): QueueEdge {
  return {
    id: `${queueName}-id`,
    queueName,
    producerSymbol: 'Producer',
    producerFile: 'src/producer.service.ts',
    workerSymbol: 'Worker',
    workerFile: 'src/worker.processor.ts',
    source: 'stitcher',
    project: 'test-project',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as QueueEdge;
}

/** Garbage rows straight from the dogfood list — an OLD database may still hold these. */
const GARBAGE_EDGES: QueueEdge[] = [
  qedge('<name>'),
  qedge('const q = new Queue(\n  "oops"'),
  qedge('SEED_PRODUCTS', { producerFile: null, workerFile: null }),
  qedge('name', {
    producerFile: 'packages/stitcher/src/extract.ts',
    workerSymbol: null,
    workerFile: null,
  }),
  qedge('reports', {
    producerFile: 'packages/engine/src/__fixtures__/queues.ts',
    workerFile: null,
  }),
];

const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('runQueues — read-path hygiene and gated --live guidance', () => {
  let logs: string[];

  function mockEnv(opts: { redis?: boolean } = {}): void {
    vi.mocked(loadConfig).mockResolvedValue({ database: { url: 'postgres://x' } } as never);
    vi.mocked(openDb).mockResolvedValue({
      db: {},
      sql: { end: vi.fn().mockResolvedValue(undefined) },
    } as never);
    vi.mocked(resolveEnvironment).mockReturnValue({
      project: 'test-project',
      env: 'production',
      readOnly: true,
      repositories: [],
      path: '',
      connectors: opts.redis
        ? {
            redis: {
              url: 'redis://localhost:6379',
              databases: [{ db: 0, roles: ['queues'], bullmqPrefix: 'bull' }],
            },
          }
        : {},
    } as never);
  }

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops garbage edges and keeps real queues (human view)', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks'), ...GARBAGE_EDGES]);

    const code = await runQueues(undefined, {});
    const out = stripAnsi(logs.join('\n'));

    expect(code).toBe(0);
    expect(out).toContain('brand-webhooks');
    expect(out).not.toContain('<name>');
    expect(out).not.toContain('SEED_PRODUCTS');
    expect(out).not.toContain('new Queue');
    expect(out).not.toContain('reports');
  });

  it('says plainly that no production queues were detected when everything is filtered out', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([...GARBAGE_EDGES]);

    const code = await runQueues(undefined, {});
    const out = stripAnsi(logs.join('\n'));

    expect(code).toBe(0);
    expect(out).toContain('No production queues detected');
    expect(out).not.toContain('Run: horus init'); // edges WERE indexed — they were garbage
  });

  it('--json emits valid JSON with an empty topology and a note when all edges are garbage', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([...GARBAGE_EDGES]);

    const code = await runQueues(undefined, { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      topology: unknown[];
      note?: string;
    };
    expect(parsed.topology).toEqual([]);
    expect(parsed.note).toContain('No production queues detected');
  });

  it('ZERO rows over a fresh index says "no production queues found", never "Run: horus init"', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([]);
    const code = await runQueues(undefined, {});
    const out = stripAnsi(logs.join('\n'));
    expect(code).toBe(0);
    expect(out).toContain('No production queues found in this repo');
    expect(out).not.toContain('Run: horus init');
  });

  it('--json carries the fresh-and-empty note too', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([]);
    const code = await runQueues(undefined, { json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { topology: unknown[]; note?: string };
    expect(parsed.topology).toEqual([]);
    expect(parsed.note).toContain('No production queues found in this repo');
  });

  it('--json keeps only real queues and omits the note when some survive', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks'), ...GARBAGE_EDGES]);

    const code = await runQueues(undefined, { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      topology: { queueName: string }[];
      note?: string;
    };
    expect(parsed.topology.map((t) => t.queueName)).toEqual(['brand-webhooks']);
    expect(parsed.note).toBeUndefined();
  });

  it('the --live tip only appears when the config has a queue-capable Redis connector', async () => {
    mockEnv({ redis: true });
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks')]);
    await runQueues(undefined, {});
    expect(stripAnsi(logs.join('\n'))).toContain('Tip: run horus queues --live');
  });

  it('no Redis connector in config — no --live tip', async () => {
    mockEnv({ redis: false });
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks')]);
    await runQueues(undefined, {});
    expect(stripAnsi(logs.join('\n'))).not.toContain('Tip: run horus queues --live');
  });

  it('--live without a queue connector states what the config needs — no "horus connect redis" nag', async () => {
    mockEnv({ redis: false });
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks')]);

    const code = await runQueues(undefined, { live: true });
    const out = stripAnsi(logs.join('\n'));

    expect(code).toBe(0);
    expect(out).toContain('queues-role Redis connector in the config');
    expect(out).not.toContain('horus connect redis');
  });

  it('degrades to display-only when the local db is unavailable (single-file build)', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockRejectedValue(
      new Error('HORUS_DB_UNAVAILABLE: embedded database asset missing (pglite.wasm).'),
    );

    const code = await runQueues(undefined, {});
    const out = stripAnsi(logs.join('\n'));

    expect(code).toBe(0); // completes rather than crashing
    expect(out).toContain('local persistence unavailable in this build');
  });

  it('--json carries the db-unavailable note and stays valid JSON', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockRejectedValue(
      new Error('HORUS_DB_UNAVAILABLE: embedded database asset missing (pglite.wasm).'),
    );

    const code = await runQueues(undefined, { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { topology: unknown[]; note?: string };
    expect(parsed.topology).toEqual([]);
    expect(parsed.note).toContain('local persistence unavailable in this build');
  });

  it('a non-db error still fails the command (only HORUS_DB_UNAVAILABLE degrades)', async () => {
    mockEnv();
    vi.mocked(listQueueEdges).mockRejectedValue(new Error('relation "queue_edges" does not exist'));

    const code = await runQueues(undefined, {});

    expect(code).toBe(1);
  });

  it('--live --json without a queue connector keeps stdout valid JSON with the statement', async () => {
    mockEnv({ redis: false });
    vi.mocked(listQueueEdges).mockResolvedValue([qedge('brand-webhooks')]);

    const code = await runQueues(undefined, { live: true, json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { live: { ok: boolean; error: string } };
    expect(parsed.live.ok).toBe(false);
    expect(parsed.live.error).toContain('queues-role Redis connector in the config');
  });
});
