/**
 * Unit tests for the canonical queue-edge hygiene module — the ONE place the
 * engine (architecture), the CLI (`horus queues`) and the stitcher (write path)
 * all filter queue edges through. Garbage names come straight from the dogfood
 * list observed on this repo: `<name>`, `name`, multiline code snippets,
 * `SEED_PRODUCTS`, `emails`, `reports`.
 */
import { describe, it, expect } from 'vitest';
import {
  GENERIC_QUEUE_NAMES,
  isPlausibleQueueName,
  isGenericQueueName,
  isConstantShapedQueueName,
  isFixtureQueueEdge,
  shouldKeepQueueEdge,
  filterQueueEdges,
  type QueueEdgeLike,
} from './queue-hygiene.js';

function edge(overrides: Partial<QueueEdgeLike> & { queueName: string }): QueueEdgeLike {
  return {
    producerSymbol: 'Producer',
    producerFile: 'src/producer.service.ts',
    workerSymbol: 'Worker',
    workerFile: 'src/worker.processor.ts',
    ...overrides,
  };
}

describe('isPlausibleQueueName', () => {
  it('rejects the dogfood garbage names', () => {
    expect(isPlausibleQueueName('<name>')).toBe(false);
    expect(isPlausibleQueueName('${queueName}')).toBe(false);
    expect(isPlausibleQueueName('{name}')).toBe(false);
    expect(isPlausibleQueueName('const q = new Queue(\n  "oops"')).toBe(false);
    expect(isPlausibleQueueName('two words')).toBe(false);
    expect(isPlausibleQueueName('tab\tname')).toBe(false);
    expect(isPlausibleQueueName('')).toBe(false);
    expect(isPlausibleQueueName('x'.repeat(101))).toBe(false);
    expect(isPlausibleQueueName("it('does a thing';")).toBe(false);
  });

  it('accepts real production queue names', () => {
    for (const name of [
      'payment-processing',
      'brand-webhooks',
      'POST_SEED_PRODUCT_SYNC',
      'zoho-sync-batch',
      'sum_task',
      'email-dispatch',
      'default', // generic, but PLAUSIBLE — genericness is a separate rule
    ]) {
      expect(isPlausibleQueueName(name), name).toBe(true);
    }
  });
});

describe('isGenericQueueName / GENERIC_QUEUE_NAMES', () => {
  it('flags bare generic words case-insensitively', () => {
    expect(isGenericQueueName('name')).toBe(true);
    expect(isGenericQueueName('SEED_PRODUCTS')).toBe(true);
    expect(isGenericQueueName('ALPHA')).toBe(true);
    expect(isGenericQueueName('emails')).toBe(true);
    expect(isGenericQueueName('reports')).toBe(true);
    expect(GENERIC_QUEUE_NAMES.has('jobs')).toBe(true);
  });

  it('does not flag distinctive names', () => {
    expect(isGenericQueueName('zoho-sync-batch')).toBe(false);
    expect(isGenericQueueName('payment-processing')).toBe(false);
  });
});

describe('isFixtureQueueEdge / shouldKeepQueueEdge', () => {
  it('drops edges whose producer AND worker live outside product code', () => {
    expect(
      isFixtureQueueEdge(
        edge({
          queueName: 'fixture-queue',
          producerFile: 'tests/fixtures/queues.ts',
          workerFile: '__tests__/worker.test.ts',
        }),
      ),
    ).toBe(true);
    // Co-located *.test.ts counts as non-product too.
    expect(
      isFixtureQueueEdge(
        edge({
          queueName: 'emails',
          producerFile: 'apps/horus/src/entrypoint.test.ts',
          workerFile: 'apps/horus/src/entrypoint.test.ts',
        }),
      ),
    ).toBe(true);
  });

  it('keeps edges with at least one product file', () => {
    expect(
      isFixtureQueueEdge(
        edge({
          queueName: 'brand-webhooks',
          producerFile: 'src/webhooks/producer.ts',
          workerFile: 'src/webhooks/producer.test.ts',
        }),
      ),
    ).toBe(false);
  });

  it('with NO file evidence: drops generic names, keeps distinctive ones', () => {
    expect(
      isFixtureQueueEdge(edge({ queueName: 'SEED_PRODUCTS', producerFile: null, workerFile: null })),
    ).toBe(true);
    expect(
      isFixtureQueueEdge(edge({ queueName: 'zoho-sync-batch', producerFile: null, workerFile: null })),
    ).toBe(false);
  });

  it('shouldKeepQueueEdge combines name plausibility and fixture rules', () => {
    expect(shouldKeepQueueEdge(edge({ queueName: '<name>' }))).toBe(false);
    expect(shouldKeepQueueEdge(edge({ queueName: 'payment-processing' }))).toBe(true);
  });
});

describe('filterQueueEdges (edge set)', () => {
  it('filters the dogfood garbage set down to real queues only', () => {
    const edges: QueueEdgeLike[] = [
      edge({ queueName: 'payment-processing' }),
      edge({ queueName: '<name>' }),
      edge({ queueName: 'const q = new Queue(\n  "oops"' }),
      edge({ queueName: 'SEED_PRODUCTS', producerFile: null, workerFile: null }),
      edge({
        queueName: 'reports',
        producerFile: 'packages/engine/src/__fixtures__/queues.ts',
        workerFile: null,
      }),
    ];
    expect(filterQueueEdges(edges).map((e) => e.queueName)).toEqual(['payment-processing']);
  });

  it('producer-only GENERIC groups drop even from product code (self-matching extractor)', () => {
    const edges: QueueEdgeLike[] = [
      // Dogfood: the stitcher's own X_QUEUE_NAME literals produced queue "name"
      // from packages/stitcher/src/extract.ts with zero workers.
      edge({
        queueName: 'name',
        producerSymbol: 'extractQueueGraph',
        producerFile: 'packages/stitcher/src/extract.ts',
        workerSymbol: null,
        workerFile: null,
      }),
      // A generic word WITH a real crossing survives…
      edge({ queueName: 'emails' }),
      // …and a distinctive producer-only edge survives (workers may be off-repo).
      edge({ queueName: 'zoho-sync-batch', workerSymbol: null, workerFile: null }),
    ];
    expect(
      filterQueueEdges(edges)
        .map((e) => e.queueName)
        .sort(),
    ).toEqual(['emails', 'zoho-sync-batch']);
  });

  it('worker-only GENERIC queues with product files are REAL (dogfood: maison-safqa SEED_PRODUCTS)', () => {
    // Enum-registered queues often have no statically-visible producer — but a
    // worker registration in product code is real consuming code, not residue.
    const edges: QueueEdgeLike[] = [
      edge({
        queueName: 'SEED_PRODUCTS',
        producerSymbol: null,
        producerFile: null,
        workerSymbol: 'runSeedProductsForBullMq',
        workerFile: 'src/controllers/scheduler.controller.ts',
      }),
    ];
    expect(filterQueueEdges(edges).map((e) => e.queueName)).toEqual(['SEED_PRODUCTS']);
  });

  it('generic crossing may span separate producer-only and worker-only edges of the same queue', () => {
    const edges: QueueEdgeLike[] = [
      edge({ queueName: 'emails', workerSymbol: null, workerFile: null }),
      edge({
        queueName: 'emails',
        producerSymbol: null,
        producerFile: null,
        workerSymbol: 'EmailWorker',
        workerFile: 'src/email.processor.ts',
      }),
    ];
    expect(filterQueueEdges(edges)).toHaveLength(2);
  });

  it('preserves the input element type and order of kept edges', () => {
    const tagged = [
      { ...edge({ queueName: 'a-queue' }), tag: 1 },
      { ...edge({ queueName: '<name>' }), tag: 2 },
      { ...edge({ queueName: 'b-queue' }), tag: 3 },
    ];
    expect(filterQueueEdges(tagged).map((e) => e.tag)).toEqual([1, 3]);
  });
});

describe('generic names need a REAL worker to vouch (module-level literals cannot)', () => {
  it('drops a generic queue whose only worker is a module-level string match', () => {
    // Dogfood on horus itself: the queue-hygiene stoplist literal registered as
    // queue "SEED_PRODUCTS"'s worker — symbol == file stem, producers test-only.
    const edges = [
      {
        queueName: 'SEED_PRODUCTS',
        producerSymbol: 'extract.test.ts',
        producerFile: 'packages/stitcher/src/extract.test.ts',
        workerSymbol: 'queue-hygiene',
        workerFile: 'packages/core/src/queue-hygiene.ts',
      },
    ];
    expect(filterQueueEdges(edges)).toEqual([]);
  });

  it('keeps a generic queue vouched by a NAMED worker function in product code (maison)', () => {
    const edges = [
      {
        queueName: 'SEED_PRODUCTS',
        producerSymbol: null,
        producerFile: null,
        workerSymbol: 'runSeedProductsForBullMq',
        workerFile: 'src/controllers/scheduler.controller.ts',
      },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(1);
  });

  it('a test-file worker cannot vouch for a generic name', () => {
    const edges = [
      {
        queueName: 'emails',
        producerSymbol: 'sendEmail',
        producerFile: 'src/mailer.ts',
        workerSymbol: 'fakeWorker',
        workerFile: 'src/mailer.test.ts',
      },
    ];
    expect(filterQueueEdges(edges)).toEqual([]);
  });

  it('distinctive names never need worker vouching', () => {
    const edges = [
      {
        queueName: 'zoho-sync-batch',
        producerSymbol: 'ZohoScheduler',
        producerFile: 'src/zoho/scheduler.ts',
        workerSymbol: null,
        workerFile: null,
      },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(1);
  });
});

// ── dogfood 0.21: enum/constant string literals extracted as queues ─────────────────
describe('enum/constant string constants are not queues (dogfood 0.21)', () => {
  it('isPlausibleQueueName rejects dotted attribute keys (bullmq OpenTelemetry constants)', () => {
    for (const n of ['bullmq.job.id', 'bullmq.queue.name', 'bullmq.worker.options', 'a.b.c']) {
      expect(isPlausibleQueueName(n), n).toBe(false);
    }
    // A single dot is still a plausible queue segment (`email.send`).
    expect(isPlausibleQueueName('email.send')).toBe(true);
  });

  it('isConstantShapedQueueName flags SCREAMING_SNAKE enum members only', () => {
    for (const n of ['GLOBAL_MOUNT', 'INSTANCE_DESTROY', 'CONFIG_DEVTOOLS', 'POST_SEED_PRODUCT_SYNC']) {
      expect(isConstantShapedQueueName(n), n).toBe(true);
    }
    for (const n of ['GZIP', 'payment-processing', 'emailQueue', 'sum_task']) {
      // single ALLCAPS word / kebab / camel / lower_snake are not multi-segment SCREAMING_SNAKE
      expect(isConstantShapedQueueName(n), n).toBe(false);
    }
  });

  it('drops the bullmq telemetry-attribute "queues" (dotted keys + accessor "workers")', () => {
    const edges = [
      { queueName: 'bullmq.job.id', producerSymbol: 'JobId', producerFile: 'src/enums/telemetry-attributes.ts', workerSymbol: 'id', workerFile: 'src/classes/job.ts' },
      { queueName: 'bullmq.queue.name', producerSymbol: 'QueueName', producerFile: 'src/enums/telemetry-attributes.ts', workerSymbol: 'name', workerFile: 'src/classes/queue.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('drops a same-file enum self-match (Nest Kafka compression GZIP↔Snappy)', () => {
    const edges = [
      { queueName: 'GZIP', producerSymbol: 'GZIP', producerFile: 'src/enums/kafka-compression.enum.ts', workerSymbol: 'Snappy', workerFile: 'src/enums/kafka-compression.enum.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('drops an unvouched SCREAMING_SNAKE enum member (Vue lifecycle flags)', () => {
    const edges = [
      { queueName: 'GLOBAL_MOUNT', producerSymbol: 'GLOBAL_MOUNT', producerFile: 'packages/runtime-core/src/enums.ts', workerSymbol: 'INSTANCE_DESTROY', workerFile: 'packages/runtime-core/src/enums.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('KEEPS a real SCREAMING_SNAKE queue vouched by a named worker (maison POST_SEED_PRODUCT_SYNC)', () => {
    const edges = [
      { queueName: 'POST_SEED_PRODUCT_SYNC', producerSymbol: 'enqueueSeedSync', producerFile: 'src/products/seed.service.ts', workerSymbol: null, workerFile: null },
      { queueName: 'POST_SEED_PRODUCT_SYNC', producerSymbol: null, producerFile: null, workerSymbol: 'runSeedProductsForBullMq', workerFile: 'src/products/seed.worker.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(2);
  });
});

// ── dogfood 0.21: queue evidence living only in type-declaration files ──────────────
describe('type-declaration-only edges are not queues (dogfood 0.21)', () => {
  it('drops a kafkajs GZIP↔Snappy edge whose producer AND worker are in types/index.d.ts', () => {
    // A `CompressionTypes` enum in an ambient `.d.ts` — types cannot produce or consume.
    const edges = [
      { queueName: 'GZIP', producerSymbol: 'GZIP', producerFile: 'types/index.d.ts', workerSymbol: 'Snappy', workerFile: 'types/index.d.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('drops a Nest GZIP↔Snappy edge in kafka.interface.ts (also caught by the same-file enum rule)', () => {
    const edges = [
      { queueName: 'GZIP', producerSymbol: 'GZIP', producerFile: 'packages/microservices/external/kafka.interface.ts', workerSymbol: 'Snappy', workerFile: 'packages/microservices/external/kafka.interface.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('drops even when the two type-decl files differ (.d.mts producer, .interfaces.cts worker)', () => {
    const edges = [
      { queueName: 'order-events', producerSymbol: 'OrderEvent', producerFile: 'src/types/index.d.mts', workerSymbol: 'OrderConsumer', workerFile: 'src/kafka.interfaces.cts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(0);
  });

  it('KEEPS an edge with producer in src/queue.ts and worker null', () => {
    const edges = [
      { queueName: 'order-events', producerSymbol: 'OrderProducer', producerFile: 'src/queue.ts', workerSymbol: null, workerFile: null },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(1);
  });

  it('KEEPS a real queue with producer in types/index.d.ts BUT worker in src/worker.ts', () => {
    // One real product file alongside a type-decl file is enough — do not drop.
    const edges = [
      { queueName: 'order-events', producerSymbol: 'OrderProducer', producerFile: 'types/index.d.ts', workerSymbol: 'OrderWorker', workerFile: 'src/worker.ts' },
    ];
    expect(filterQueueEdges(edges)).toHaveLength(1);
  });
});
