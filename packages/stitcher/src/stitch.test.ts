/**
 * Unit tests for project-scoped stitch() (HOR-38).
 *
 * Mocks both the SourceHttpClient and the DB so no network or database is needed.
 * Verifies that edges carry the project label and that replaceQueueEdges is
 * called with the matching project scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as db from '@horus/db';
import { stitch } from './stitch.js';
import type { SourceHttpClient } from '@horus/connectors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSourceClient(producerContent: string, workerContent: string): SourceHttpClient {
  return {
    contentSearch: vi.fn(async (tokens: string[]) => {
      if (tokens.includes('@InjectQueue(')) {
        return [
          {
            nodeId: 'class:src/notification.service.ts:NotificationService',
            name: 'NotificationService',
            filePath: 'src/notification.service.ts',
            content: producerContent,
          },
        ];
      }
      if (tokens.includes('@Processor(')) {
        return [
          {
            nodeId: 'class:src/email.processor.ts:EmailProcessor',
            name: 'EmailProcessor',
            filePath: 'src/email.processor.ts',
            content: workerContent,
          },
        ];
      }
      return []; // Python task-queue (celery/...) pre-filter — nothing for these fixtures.
    }),
  } as unknown as SourceHttpClient;
}

const PRODUCER_CONTENT = "constructor(@InjectQueue('emails') private q: Queue) {}";
const WORKER_CONTENT = "@Processor('emails')\nexport class EmailProcessor {}";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stitch — project scoping (HOR-38)', () => {
  let replaceSpy: MockInstance;
  const fakeDb = {} as db.HorusDb;

  beforeEach(() => {
    replaceSpy = vi
      .spyOn(db, 'replaceQueueEdges')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the project to replaceQueueEdges', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'leadcall-api' });
    expect(replaceSpy).toHaveBeenCalledOnce();
    const [, , opts] = replaceSpy.mock.calls[0] as [unknown, unknown, { project?: string }];
    expect(opts?.project).toBe('leadcall-api');
  });

  it('sets project on every inserted edge', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'maison-safqa' });
    const [, edges] = replaceSpy.mock.calls[0] as [unknown, Array<{ project: string | null }>];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.project).toBe('maison-safqa');
    }
  });

  it('uses null project when no project is given (back-compat)', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb);
    const [, edges, opts] = replaceSpy.mock.calls[0] as [
      unknown,
      Array<{ project: string | null }>,
      { project?: string },
    ];
    expect(opts?.project).toBeUndefined();
    for (const edge of edges) {
      expect(edge.project).toBeNull();
    }
  });

  it('widened content-search pre-filter fetches and stitches a procrastinate .defer() edge (HOR-380)', () => {
    // The pre-filter must request the new producer verbs / @actor in lockstep with extract.ts,
    // or the candidate nodes are never fetched and the regex never fires.
    const seen: string[][] = [];
    const client = {
      contentSearch: vi.fn(async (tokens: string[]) => {
        seen.push(tokens);
        if (tokens.includes('@InjectQueue(')) return [];
        if (tokens.includes('@Processor(')) return [];
        // The Python task-queue pre-filter: return a procrastinate worker + producer.
        return [
          {
            nodeId: 'function:app/tasks.py:sum_task',
            name: 'sum_task',
            filePath: 'app/tasks.py',
            content: '@app.task\ndef sum_task(a, b):\n    return a + b',
          },
          {
            nodeId: 'function:app/views.py:handler',
            name: 'handler',
            filePath: 'app/views.py',
            content: 'def handler():\n    sum_task.defer(a=1, b=2)',
          },
        ];
      }),
    } as unknown as SourceHttpClient;

    return stitch(client, fakeDb, { project: 'queue-demo' }).then(() => {
      const celeryTokens = seen.find((t) => t.includes('.delay('));
      expect(celeryTokens).toBeDefined();
      for (const needle of ['.defer(', '.defer_async(', '.send(', '.enqueue_job(', '.enqueue(', '@actor']) {
        expect(celeryTokens).toContain(needle);
      }
      const [, edges] = replaceSpy.mock.calls[0] as [
        unknown,
        Array<{ queueName: string; producerSymbol: string | null; workerSymbol: string | null }>,
      ];
      expect(
        edges.some(
          (e) => e.queueName === 'sum_task' && e.producerSymbol === 'handler' && e.workerSymbol === 'sum_task',
        ),
      ).toBe(true);
    });
  });

  it('write-path hygiene: refuses implausible names and fixture-only edges at persist time', async () => {
    // One real queue, one fixture-only queue (both endpoints in test trees), and a
    // template-placeholder literal in product code. Only the real queue may persist,
    // and the summary (which feeds the "Stitched N queue edge(s)…" log line) must
    // count kept edges only.
    const client = {
      contentSearch: vi.fn(async (tokens: string[]) => {
        if (tokens.includes('@InjectQueue(')) {
          return [
            {
              nodeId: 'class:src/webhook.service.ts:WebhookService',
              name: 'WebhookService',
              filePath: 'src/webhook.service.ts',
              content:
                "constructor(@InjectQueue('brand-webhooks') private q: Queue, @InjectQueue('<name>') private t: Queue) {}",
            },
            {
              nodeId: 'class:tests/fixtures/fake.service.ts:FakeService',
              name: 'FakeService',
              filePath: 'tests/fixtures/fake.service.ts',
              content: "constructor(@InjectQueue('fixture-queue') private q: Queue) {}",
            },
          ];
        }
        if (tokens.includes('@Processor(')) {
          return [
            {
              nodeId: 'class:src/webhook.processor.ts:WebhookProcessor',
              name: 'WebhookProcessor',
              filePath: 'src/webhook.processor.ts',
              content: "@Processor('brand-webhooks')\nexport class WebhookProcessor {}",
            },
            {
              nodeId: 'class:__tests__/fake.processor.ts:FakeProcessor',
              name: 'FakeProcessor',
              filePath: '__tests__/fake.processor.ts',
              content: "@Processor('fixture-queue')\nexport class FakeProcessor {}",
            },
          ];
        }
        return [];
      }),
    } as unknown as SourceHttpClient;

    const summary = await stitch(client, fakeDb, { project: 'hygiene-test' });

    const [, edges] = replaceSpy.mock.calls[0] as [unknown, Array<{ queueName: string }>];
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.queueName).toBe('brand-webhooks');
    }
    expect(summary.edges).toBe(edges.length);
    expect(summary.queues).toBe(1);
  });

  it('indexing A then B calls replaceQueueEdges twice with distinct projects', async () => {
    const clientA = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    const clientB = makeSourceClient(
      "constructor(@InjectQueue('reports') private q: Queue) {}",
      "@Processor('reports')\nexport class ReportProcessor {}",
    );
    await stitch(clientA, fakeDb, { project: 'leadcall-api' });
    await stitch(clientB, fakeDb, { project: 'maison-safqa' });

    expect(replaceSpy).toHaveBeenCalledTimes(2);
    const [, , optsA] = replaceSpy.mock.calls[0] as [unknown, unknown, { project?: string }];
    const [, , optsB] = replaceSpy.mock.calls[1] as [unknown, unknown, { project?: string }];
    expect(optsA?.project).toBe('leadcall-api');
    expect(optsB?.project).toBe('maison-safqa');
  });
});
