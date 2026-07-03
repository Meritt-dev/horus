/**
 * HOR-108 — Connector failure fallback tests.
 *
 * Proves that investigations keep working when runtime connectors throw,
 * timeout, return malformed data, or are simply unavailable. All tests
 * are deterministic and service-free (mocked providers, no live sockets).
 *
 * Failure modes covered:
 *   A. Logs connector: analyzeErrors throws (service unavailable, network error)
 *   B. Logs connector: analyzeErrors returns empty analysis (no error signatures)
 *   C. Logs connector: auth/permission failure during analyzeErrors
 *   D. Queue connector: analyzeQueues throws (Redis unreachable)
 *   E. Queue connector: analyzeQueues returns empty queue list (malformed/no data)
 *   F. MongoDB state connector: analyzeState throws
 *   G. Multiple connectors fail simultaneously
 *
 * In every case:
 *   - investigate() must return a valid InvestigationReport (never throw)
 *   - Failed connector contributes no evidence
 *   - Source status or gap analysis reflects what was unavailable
 *   - No sensitive error detail leaks to the report
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { LogsProvider, LogRecord, LogAnalysis } from '@horus/connectors';
import type { MetricsProvider } from '@horus/connectors';
import type { QueueRuntimeProvider, QueueRuntimeState } from '@horus/connectors';
import type { StateProvider, StateAnalysis } from '@horus/connectors';
import type { RedisStateProvider } from '@horus/connectors';
import type { HorusDb, QueueEdge } from '@horus/db';
import { connectorFailureReason, investigate } from './engine.js';

// ---------------------------------------------------------------------------
// Shared fake code provider
// ---------------------------------------------------------------------------

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:ZohoSyncWorker',
  name: 'ZohoSyncWorker',
  filePath: 'src/workers/zoho-sync.worker.ts',
  startLine: 10,
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [FAKE_SYMBOL]; },
  async context(): Promise<SymbolContext> {
    return { symbol: FAKE_SYMBOL, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] };
  },
  async impact(): Promise<ImpactResult> {
    return { target: FAKE_SYMBOL, affected: 0, byDepth: [] };
  },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> {
    return { added: [], removed: [], modified: [] };
  },
  async cypher(): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

// ---------------------------------------------------------------------------
// Shared fake DB stubs
// ---------------------------------------------------------------------------

function makeDb(edges: QueueEdge[] = []): HorusDb {
  return {
    select() {
      return {
        from(_table: unknown) {
          return Promise.resolve(edges);
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(_rows: unknown) {
          return {
            returning(_cols: unknown): Promise<{ id: string }[]> {
              return Promise.resolve([{ id: 'test-id' }]);
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(_vals: unknown) {
          return {
            where(_cond: unknown): Promise<void> {
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as HorusDb;
}

const fakeDb = makeDb([]);

const FAKE_QUEUE_EDGE: QueueEdge = {
  id: 'edge-001',
  queueName: 'orders',
  producerSymbol: 'ZohoSyncWorker',
  producerFile: 'src/workers/zoho-sync.worker.ts',
  workerSymbol: 'OrderWorker',
  workerFile: 'src/workers/order.worker.ts',
  source: 'stitcher',
  project: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeDbWithQueues = makeDb([FAKE_QUEUE_EDGE]);

// ---------------------------------------------------------------------------
// Logs provider factories
// ---------------------------------------------------------------------------

const okCompat = { ok: true, indexCount: 1, issues: [] };

const baseLogsProvider: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',
  async health() { return { ok: true, detail: 'ok' }; },
  async searchLogs() { return [] as LogRecord[]; },
  async aggregateErrors() { return []; },
  async errorDeltas() { return []; },
  async analyzeErrors(): Promise<LogAnalysis> {
    return { window: { from: 'x', to: 'y' }, totalErrors: 0, signatures: [], newSignatures: [], affectedServices: [] };
  },
  async checkCompatibility() { return okCompat; },
  toEvidence() { return []; },
  async queryEvidence() { return []; },
  async analyzeDurations() { return null; },
};

// ---------------------------------------------------------------------------
// Scenario A: Logs connector throws during analyzeErrors
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario A: logs analyzeErrors throws', () => {
  const unavailableLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() {
      throw new Error('ECONNREFUSED: Elasticsearch at es.internal:9200 refused connection');
    },
  };

  it('investigate() does not throw when logs.analyzeErrors throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: unavailableLogs }),
    ).resolves.toBeDefined();
  });

  it('report has no log evidence when analyzeErrors throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    const logEv = report.evidence.filter((e) => e.kind === 'log');
    expect(logEv).toHaveLength(0);
  });

  it('logs gap is present when analyzeErrors throws (collection failed)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap!.why).toContain('failed');
  });

  it('confidence is defined and in 0–1 range even with logs failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Logs connector returns empty analysis (no error signatures)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario B: logs analyzeErrors returns empty', () => {
  const emptyLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors(): Promise<LogAnalysis> {
      return { window: { from: 'x', to: 'y' }, totalErrors: 0, signatures: [], newSignatures: [], affectedServices: [] };
    },
  };

  it('investigate() resolves normally when analyzeErrors returns no signatures', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: emptyLogs }),
    ).resolves.toBeDefined();
  });

  it('report has no log evidence when no signatures returned', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: emptyLogs },
    );
    expect(report.evidence.filter((e) => e.kind === 'log')).toHaveLength(0);
  });

  it('logs gap reason is "no error logs matched" (not "failed") when analyzeErrors returns empty', async () => {
    // logsCollected=true but no signatures → gap with "no error logs matched" reason.
    // This is accurate: collection ran but found nothing in the window.
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: emptyLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap!.why).not.toContain('failed');
    expect(logsGap!.why).toContain('No error logs matched');
  });
});

// ---------------------------------------------------------------------------
// Scenario C: Auth/permission failure during analyzeErrors (403-like error)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario C: logs auth failure', () => {
  const authFailureLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() {
      throw new Error('ResponseError: [security_exception] missing authentication credentials');
    },
  };

  it('investigate() does not throw on auth failure', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: authFailureLogs }),
    ).resolves.toBeDefined();
  });

  it('auth error message does not appear in report summary or evidence titles', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: authFailureLogs },
    );
    const allText = JSON.stringify(report);
    expect(allText).not.toContain('security_exception');
    expect(allText).not.toContain('missing authentication credentials');
  });

  it('logs gap is present after auth failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: authFailureLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario D: Queue connector throws during analyzeQueues (Redis unreachable)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario D: queue analyzeQueues throws', () => {
  const throwingQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: false, detail: 'Redis unreachable' }; },
    async analyzeQueues() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    },
    async discoverQueues() { return []; },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() does not throw when queue provider throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue }),
    ).resolves.toBeDefined();
  });

  it('report has no queue-state evidence when analyzeQueues throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    const queueStateEv = report.evidence.filter((e) => e.kind === 'queue-state');
    expect(queueStateEv).toHaveLength(0);
  });

  it('queue hypotheses are unconfirmed when provider throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    for (const h of report.hypotheses.filter((h) => h.category === 'queue-backlog' || h.category === 'worker-slowdown')) {
      expect(h.verdict).toBe('unconfirmed');
    }
  });

  it('connection URL does not leak into report when queue throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    expect(JSON.stringify(report)).not.toContain('127.0.0.1:6379');
  });

  it('queue gap reports the FAILURE (with leak-safe reason), not just missing collection', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    const queueGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'queue runtime state');
    expect(queueGap).toBeDefined();
    expect(queueGap!.why).toContain('failed');
    expect(queueGap!.why).toContain('connection failed');
    // The classified reason must never carry the raw connection string.
    expect(JSON.stringify(report)).not.toContain('127.0.0.1:6379');
  });
});

// ---------------------------------------------------------------------------
// Scenario E: Queue connector returns empty / malformed state
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario E: queue returns empty state', () => {
  const emptyQueueState: QueueRuntimeState = {
    prefix: 'bull',
    collectedAt: new Date().toISOString(),
    queues: [],
  };

  const emptyQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: true, detail: 'connected' }; },
    async analyzeQueues() { return emptyQueueState; },
    async discoverQueues() { return []; },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() resolves normally when analyzeQueues returns no queues', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDbWithQueues, queue: emptyQueue }),
    ).resolves.toBeDefined();
  });

  it('no queue-state evidence when provider returns empty queue list', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: emptyQueue },
    );
    expect(report.evidence.filter((e) => e.kind === 'queue-state')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario F: MongoDB state connector throws
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario F: MongoDB analyzeState throws', () => {
  const throwingMongo: StateProvider = {
    id: 'mongodb',
    kind: 'state',
    async health() { return { ok: false, detail: 'MongoDB unreachable' }; },
    async analyzeState(): Promise<StateAnalysis> {
      throw new Error('MongoServerSelectionError: connect ECONNREFUSED mongo.internal:27017');
    },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() does not throw when MongoDB throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, mongo: throwingMongo }),
    ).resolves.toBeDefined();
  });

  it('report has no state evidence when MongoDB throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(report.evidence.filter((e) => e.kind === 'state')).toHaveLength(0);
  });

  it('MongoDB connection detail does not leak into report on failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(JSON.stringify(report)).not.toContain('mongo.internal');
    expect(JSON.stringify(report)).not.toContain('27017');
  });

  it('report confidence is defined and valid when MongoDB throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });

  it('surfaces an application-state gap naming mongodb and marks the state source failed', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    const stateGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'application state');
    expect(stateGap).toBeDefined();
    expect(stateGap!.why).toContain('mongodb');
    const stateEntry = report.sourceStatus?.sources.find((s) => s.source === 'state');
    expect(stateEntry?.status).toBe('failed');
    // Reason is a category only — never the raw connection detail.
    expect(JSON.stringify(report)).not.toContain('mongo.internal');
    expect(JSON.stringify(report)).not.toContain('27017');
  });
});

// ---------------------------------------------------------------------------
// Scenario F2: Postgres state connector throws — same state dimension, its own prefix
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario F2: Postgres analyzeState throws', () => {
  const throwingPostgres: StateProvider = {
    id: 'postgres',
    kind: 'state',
    async health() { return { ok: false, detail: 'Postgres unreachable' }; },
    async analyzeState(): Promise<StateAnalysis> {
      throw new Error('ETIMEDOUT connecting to pg.internal:5432');
    },
    toEvidence() { return []; },
    async close() {},
  };

  it('surfaces an application-state gap with a postgres-prefixed reason, no leak', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, postgres: throwingPostgres },
    );
    const stateGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'application state');
    expect(stateGap).toBeDefined();
    expect(stateGap!.why).toContain('postgres: timeout');
    expect(JSON.stringify(report)).not.toContain('pg.internal');
    expect(JSON.stringify(report)).not.toContain('5432');
  });
});

// ---------------------------------------------------------------------------
// Scenario F3: Redis state provider throws — folds into the same state dimension
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario F3: Redis analyzeRedisState throws', () => {
  const throwingRedisState = {
    async analyzeRedisState() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    },
  } as unknown as RedisStateProvider;

  it('surfaces an application-state gap with a redis-prefixed reason, no leak', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, redisState: throwingRedisState },
    );
    const stateGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'application state');
    expect(stateGap).toBeDefined();
    expect(stateGap!.why).toContain('redis: connection failed');
    expect(JSON.stringify(report)).not.toContain('127.0.0.1:6379');
  });
});

// ---------------------------------------------------------------------------
// Scenario G: Multiple connectors fail simultaneously
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario G: multiple simultaneous failures', () => {
  const throwingLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() { throw new Error('ES unreachable'); },
  };

  const throwingQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: false, detail: 'Redis unreachable' }; },
    async analyzeQueues() { throw new Error('Redis ECONNREFUSED'); },
    async discoverQueues() { return []; },
    toEvidence() { return []; },
    async close() {},
  };

  const throwingMongo: StateProvider = {
    id: 'mongodb',
    kind: 'state',
    async health() { return { ok: false, detail: 'Mongo unreachable' }; },
    async analyzeState(): Promise<StateAnalysis> { throw new Error('Mongo ECONNREFUSED'); },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() resolves when all runtime connectors fail', async () => {
    await expect(
      investigate(
        { hint: 'zoho' },
        {
          code: fakeCode,
          db: fakeDbWithQueues,
          logs: throwingLogs,
          queue: throwingQueue,
          mongo: throwingMongo,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('report has no runtime evidence when all connectors fail', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const runtimeKinds = new Set(['log', 'metric', 'queue-state', 'state', 'redis-key']);
    const runtimeEv = report.evidence.filter((e) => runtimeKinds.has(e.kind));
    expect(runtimeEv).toHaveLength(0);
  });

  it('logs gap is present when all connectors fail', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });

  it('report confidence ceiling is below 1.0 when all connectors fail (multiple gaps)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    expect(report.gapAnalysis.confidenceCeiling).toBeLessThan(1.0);
  });

  it('error connection strings do not appear in the report', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('logs, queue, and application-state gaps coexist when every connector fails', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const dims = report.gapAnalysis.gaps.map((g) => g.dimension);
    expect(dims).toContain('logs');
    expect(dims).toContain('queue runtime state');
    expect(dims).toContain('application state');
    expect(report.gapAnalysis.confidenceCeiling).toBeLessThan(1.0);
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// connectorFailureReason — the leak-safe classifier every failure flag routes
// through. Category-only output: raw messages carry hosts/ports/URLs that must
// never reach the persisted report.
// ---------------------------------------------------------------------------

describe('connectorFailureReason', () => {
  it('classifies connection errors', () => {
    expect(connectorFailureReason(new Error('connect ECONNREFUSED 127.0.0.1:6379'))).toBe(
      'connection failed',
    );
    expect(connectorFailureReason(new Error('getaddrinfo ENOTFOUND es.internal'))).toBe(
      'connection failed',
    );
  });

  it('classifies timeouts (including the metrics abort)', () => {
    expect(connectorFailureReason(new Error('metrics timeout'))).toBe('timeout');
    expect(connectorFailureReason(new Error('This operation was aborted'))).toBe('timeout');
    expect(connectorFailureReason(new Error('request timed out after 30s'))).toBe('timeout');
  });

  it('classifies auth failures', () => {
    expect(connectorFailureReason(new Error('HTTP 401 Unauthorized'))).toBe('auth failure');
    expect(connectorFailureReason(new Error('missing authentication credentials'))).toBe(
      'auth failure',
    );
  });

  it('classifies rate limiting and server errors', () => {
    expect(connectorFailureReason(new Error('429 rate limit exceeded'))).toBe('rate limited');
    expect(connectorFailureReason(new Error('GET /api/query -> HTTP 502'))).toBe('server error');
  });

  it('falls back to a generic category for unknown errors', () => {
    expect(connectorFailureReason(new Error('something odd happened'))).toBe('request failed');
    expect(connectorFailureReason('not-an-error')).toBe('request failed');
    expect(connectorFailureReason(null)).toBe('request failed');
  });

  it('never echoes host/port fragments from the input message', () => {
    const reason = connectorFailureReason(
      new Error('MongoServerSelectionError: connect ECONNREFUSED mongo.prod.internal:27017'),
    );
    expect(reason).not.toContain('mongo.prod.internal');
    expect(reason).not.toContain('27017');
  });

  it('classifies from the anchored HTTP status, never from URL/path/body content', () => {
    // The clients' own `-> <status>: <body>` contract wins over keyword noise.
    expect(
      connectorFailureReason(new Error('Elasticsearch POST /logs-*/_search -> 503: shard fail')),
    ).toBe('server error');
    // "auth" inside a PromQL expr must not read as an auth failure.
    expect(
      connectorFailureReason(
        new Error('Grafana GET /api/ds/query?expr=rate(auth_requests_total[5m]) -> 500: boom'),
      ),
    ).toBe('server error');
    // "401" inside an index/path name must not read as an auth failure.
    expect(
      connectorFailureReason(new Error('Elasticsearch GET /logs-401-prod/_count -> 502: bad')),
    ).toBe('server error');
    expect(connectorFailureReason(new Error('Sentry GET /issues/ -> 401: unauthorized'))).toBe(
      'auth failure',
    );
    expect(connectorFailureReason(new Error('Shopify GraphQL -> 429: throttled'))).toBe(
      'rate limited',
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario H (HOR-445): a SOURCE query throws — e.g. the impact endpoint 404s on a
// #private-method seed. investigate() must degrade (no impact evidence), never abort.
// ---------------------------------------------------------------------------

describe('HOR-445 source-query fallback — code.impact throws (impact 404)', () => {
  const impactThrowsCode: CodeProvider = {
    ...fakeCode,
    async impact(): Promise<ImpactResult> {
      throw new Error('Source request failed: GET /api/impact/method:source/core/Ky.ts:Ky.#x?depth=2 -> HTTP 404');
    },
  };

  it('investigate() degrades and does not throw when the impact query fails', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: impactThrowsCode, db: fakeDb }),
    ).resolves.toBeDefined();
  });

  it('produces a complete report with valid confidence after an impact failure', async () => {
    const report = await investigate({ hint: 'zoho' }, { code: impactThrowsCode, db: fakeDb });
    expect(typeof report.summary).toBe('string');
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });

  it('does not leak the raw source request path into the report', async () => {
    const report = await investigate({ hint: 'zoho' }, { code: impactThrowsCode, db: fakeDb });
    expect(JSON.stringify(report)).not.toContain('/api/impact');
  });

  it('a partial source failure never fabricates a source-intelligence gap dimension', async () => {
    // Source-intel health is owned by HOR-445 degradation + report.degraded, NOT the gap
    // detector — a thrown impact query must not add a new gap dimension (one-owner rule).
    const report = await investigate({ hint: 'zoho' }, { code: impactThrowsCode, db: fakeDb });
    const knownDimensions = new Set([
      'logs',
      'metrics',
      'queue runtime state',
      'application state',
      'deployment records',
      'ownership',
      'traces',
    ]);
    for (const gap of report.gapAnalysis.gaps) {
      expect(knownDimensions.has(gap.dimension), `unexpected gap dimension: ${gap.dimension}`).toBe(true);
    }
    // Partial degradation (impact only) is not total source absence.
    expect(report.degraded).toBeUndefined();
  });
});
