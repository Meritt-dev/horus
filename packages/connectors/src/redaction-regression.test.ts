/**
 * Connectors-wide secret-redaction regression tests (phase-1 trust hardening;
 * companion to elasticsearch/redaction-regression.test.ts / HOR-109).
 *
 * Proves, per driver family, that auth failures never echo credentials:
 *   - HTTP connectors (ES, Grafana, Sentry, Axiom, Shopify): a 401 body carrying
 *     a fake token + connection string never reaches thrown messages or
 *     health() details unredacted, and the body portion is capped at 200 chars.
 *   - Driver connectors (MongoDB, Postgres, Redis scan, BullMQ): driver errors
 *     embedding credential-bearing URLs are redacted in health() details, while
 *     redis/status.ts's WRONGPASS/NOAUTH auth-failure classification keeps
 *     matching the redacted detail.
 *   - Evidence titles/payloads built from raw upstream strings are redacted.
 *
 * The driver tests monkey-patch private seams ((client as any).db / .conn /
 * .redis) — refactors that move those seams must update these tests. All
 * fixtures use synthetic/fake values only. No real credentials here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElasticsearchClient } from './elasticsearch/client.js';
import { logsToEvidence, type LogRecord } from './elasticsearch/normalize.js';
import { GrafanaClient } from './grafana/client.js';
import { SentryClient } from './sentry/client.js';
import { AxiomClient } from './axiom/client.js';
import { ShopifyAdminClient } from './shopify/client.js';
import { ShopifyProvider } from './shopify/provider.js';
import { MongoStateClient } from './mongodb/client.js';
import { PostgresStateClient } from './postgres/client.js';
import { RedisScanClient } from './redis/scan-client.js';
import { BullMQRedisClient } from './bullmq/client.js';
import { analyzeQueueSignals, type QueueCounts } from './bullmq/analyze.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_TOKEN = 'sk_fake_token_1234567890';
const CONN_STRING = 'postgres://dbuser:s3cretpass@db.internal:5432/app';
/** 401 body embedding a token + conn string, padded past the 200-char cap. */
const LEAKY_BODY =
  `{"error":"unauthorized","api_key":"${FAKE_TOKEN}","url":"${CONN_STRING}"}` + 'x'.repeat(400);

function stub401(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (): Promise<Response> => new Response(LEAKY_BODY, { status: 401 })),
  );
}

/** The portion of a thrown message after the `-> <status>: ` prefix (the upstream body). */
function bodyPortion(msg: string, marker: string): string {
  const idx = msg.indexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  return msg.slice(idx + marker.length);
}

function expectClean(text: string): void {
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain('s3cretpass');
  expect(text).not.toContain('s3cret');
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!;
}

// ---------------------------------------------------------------------------
// 1. HTTP connectors — 401 bodies never leak into thrown messages / health()
// ---------------------------------------------------------------------------

describe('Elasticsearch — 401 with secrets in body', () => {
  it('redacts + caps the thrown request() message', async () => {
    stub401();
    const client = new ElasticsearchClient({ baseUrl: 'http://es.local:9200' });
    const err = await rejection(client.request('GET', '/secure'));
    expectClean(err.message);
    expect(err.message).toContain('Elasticsearch GET /secure -> 401: ');
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);
  });

  it('health() returns ok:false with a redacted detail', async () => {
    stub401();
    const client = new ElasticsearchClient({ baseUrl: 'http://es.local:9200' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
    expect(health.detail).toContain('401');
  });
});

describe('Grafana — 401 with secrets in body', () => {
  it('redacts + caps the thrown getJson() message', async () => {
    stub401();
    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    const err = await rejection(client.searchDashboards());
    expectClean(err.message);
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);
  });

  it('health() returns ok:false with a redacted detail', async () => {
    stub401();
    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
  });

  it('never echoes baseUrl userinfo in the thrown message (full URL is interpolated)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('', { status: 401 })));
    const client = new GrafanaClient({ baseUrl: 'https://user:s3cret@grafana.local' });
    const err = await rejection(client.searchDashboards());
    expect(err.message).not.toContain('s3cret');
    expect(err.message).toContain('https://[REDACTED]@grafana.local');
  });

  it('a secret straddling the 200-char body cap never survives truncated', async () => {
    // Redaction must run BEFORE the cap: a conn string starting near char 200
    // would otherwise be sliced mid-password and escape the redaction regex.
    const body = 'x'.repeat(190) + ' redis://:supersecretpassword@cache.internal:6379 trailing';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => new Response(body, { status: 502 })),
    );
    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { maxRetries: 0 },
    });
    const err = await rejection(client.searchDashboards());
    expect(err.message).not.toContain('supersecret');
    expect(err.message).not.toContain('supers');
    // The cap may truncate the [REDACTED] token itself; what matters is that
    // redaction already replaced the userinfo before the slice.
    expect(err.message).toContain('redis://[');
  });
});

describe('Sentry — 401 with secrets in body', () => {
  it('redacts + caps the thrown request() message', async () => {
    stub401();
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'api' });
    const request = (client as unknown as { request(path: string): Promise<unknown> }).request.bind(
      client,
    );
    const err = await rejection(request('/api/0/projects/acme/api/issues/'));
    expectClean(err.message);
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);
  });

  it('health() returns ok:false with a redacted detail', async () => {
    stub401();
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'api' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
  });
});

describe('Axiom — 401 with secrets in body', () => {
  it('redacts + caps the thrown request() message', async () => {
    stub401();
    const client = new AxiomClient({ token: 't', dataset: 'prod' });
    const request = (
      client as unknown as { request(method: string, path: string): Promise<unknown> }
    ).request.bind(client);
    const err = await rejection(request('GET', '/v1/datasets'));
    expectClean(err.message);
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);
  });

  it('health() returns ok:false with a redacted detail', async () => {
    stub401();
    const client = new AxiomClient({ token: 't', dataset: 'prod' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
  });
});

describe('Shopify — auth failures never echo credentials', () => {
  it('token-exchange failure body is redacted + capped (ensureToken path)', async () => {
    // The OAuth endpoint's response to a request carrying client_id + client_secret.
    const echoBody =
      `{"error":"invalid_client","client_secret":"${FAKE_TOKEN}","url":"${CONN_STRING}"}` +
      'x'.repeat(400);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => new Response(echoBody, { status: 401 })),
    );
    const client = new ShopifyAdminClient({
      store: 'test-store',
      accessId: 'client-id-1',
      secret: FAKE_TOKEN,
      baseUrl: 'http://mock',
    });
    const err = await rejection(client.graphql('{ shop { name } }'));
    expectClean(err.message);
    expect(err.message).toContain('Shopify token exchange -> 401: ');
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);

    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
  });

  it('redacts + caps the thrown GraphQL HTTP error message', async () => {
    stub401();
    // 401 with a direct token triggers one refresh then falls through to !res.ok.
    const client = new ShopifyAdminClient({ store: 'test-store', secret: 't', baseUrl: 'http://mock' });
    const err = await rejection(client.graphql('{ shop { name } }'));
    expectClean(err.message);
    expect(err.message).toContain('Shopify GraphQL -> 401: ');
    expect(bodyPortion(err.message, ' -> 401: ').length).toBeLessThanOrEqual(200);
  });

  it('health() redacts a secret-bearing GraphQL errors[0].message', async () => {
    const body = JSON.stringify({
      errors: [{ message: `access denied for token=${FAKE_TOKEN} at ${CONN_STRING}` }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => new Response(body, { status: 200 })),
    );
    const client = new ShopifyAdminClient({ store: 'test-store', secret: 't', baseUrl: 'http://mock' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expectClean(health.detail);
    expect(health.detail).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// 2. Driver connectors — health() details never echo connection-URL creds
// ---------------------------------------------------------------------------

describe('MongoDB — health() detail', () => {
  it('redacts a driver error embedding the mongodb:// URI', async () => {
    const client = new MongoStateClient({
      url: 'mongodb://user:s3cret@mongo.internal:27017',
      database: 'app',
      allowlist: [],
    });
    (client as unknown as { db(): Promise<never> }).db = async () => {
      throw new Error(
        'MongoServerSelectionError: connect ECONNREFUSED mongodb://user:s3cret@mongo.internal:27017/app',
      );
    };
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain('s3cret');
    expect(health.detail).toContain('mongodb://[REDACTED]@mongo.internal:27017/app');
  });
});

describe('Postgres — health() detail', () => {
  it('redacts a driver error embedding the postgres:// URL', async () => {
    const client = new PostgresStateClient({
      url: 'postgres://user:s3cret@pg.internal:5432/app',
      allowlist: [],
    });
    (client as unknown as { conn(): Promise<never> }).conn = async () => {
      throw new Error('connection refused: postgres://user:s3cret@pg.internal:5432/app');
    };
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain('s3cret');
    expect(health.detail).toContain('postgres://[REDACTED]@pg.internal:5432/app');
  });

  it('keeps the useful "password authentication failed" diagnostic intact', async () => {
    const client = new PostgresStateClient({
      url: 'postgres://user:s3cret@pg.internal:5432/app',
      allowlist: [],
    });
    (client as unknown as { conn(): Promise<never> }).conn = async () => {
      throw new Error('password authentication failed for user "horus"');
    };
    const health = await client.health();
    // No "=/:" follows "password" — the KV pattern must not mangle this.
    expect(health.detail).toBe('password authentication failed for user "horus"');
  });
});

describe('Redis scan / BullMQ — health() detail + auth-failure classification pin', () => {
  it('scan-client: WRONGPASS survives redaction so redis/status.ts keeps classifying auth failures', async () => {
    const client = new RedisScanClient({ url: 'redis://:s3cret@localhost:6390', db: 0 });
    (client as unknown as { redis: { ping(): Promise<string> } }).redis.ping = async () => {
      throw new Error('WRONGPASS invalid username-password pair');
    };
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('WRONGPASS');
    // Pin: the EXACT regex redis/status.ts:53 uses must still match the redacted detail.
    expect(/WRONGPASS|NOAUTH|invalid password/i.test(health.detail)).toBe(true);
    await client.close();
  });

  it('scan-client: redacts an error embedding the redis://:pass@ URL (empty username)', async () => {
    const client = new RedisScanClient({ url: 'redis://:s3cret@localhost:6390', db: 0 });
    (client as unknown as { redis: { ping(): Promise<string> } }).redis.ping = async () => {
      throw new Error('connect ETIMEDOUT redis://:s3cret@localhost:6390');
    };
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain('s3cret');
    expect(health.detail).toContain('redis://[REDACTED]@localhost:6390');
    await client.close();
  });

  it('bullmq client: redacts and keeps NOAUTH classification working', async () => {
    const client = new BullMQRedisClient({ url: 'redis://:s3cret@localhost:6390' });
    (client as unknown as { redis: { ping(): Promise<string> } }).redis.ping = async () => {
      throw new Error('NOAUTH Authentication required. redis://:s3cret@localhost:6390');
    };
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).not.toContain('s3cret');
    expect(/WRONGPASS|NOAUTH|invalid password/i.test(health.detail)).toBe(true);
    (client as unknown as { redis: { disconnect(): void } }).redis.disconnect();
  });
});

// ---------------------------------------------------------------------------
// 3. Evidence titles / payloads built from raw upstream strings
// ---------------------------------------------------------------------------

describe('Evidence titles and payloads', () => {
  it('bullmq failed-breakdown title redacts a conn string in the top failedReason', () => {
    const q: QueueCounts = {
      queueName: 'emails',
      waiting: 0,
      active: 1,
      failed: 40,
      delayed: 0,
      completed: 0,
      paused: 0,
      isPaused: false,
      failedBreakdown: [
        { reason: 'connect failed: redis://:pw@h', count: 30, lastFailedAgeMs: 60_000 },
        { reason: 'other', count: 2 },
      ],
    };
    const breakdown = analyzeQueueSignals(q).find((s) => s.kind === 'failed-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown!.title).not.toContain('pw@h');
    expect(breakdown!.title).toContain('redis://[REDACTED]@h');
    // The payload ships the same reason (engine reads payload.topReason into cause
    // titles) — every copy must be redacted, not just the display title.
    const payload = breakdown!.payload as {
      topReason: string;
      breakdown: Array<{ reason: string }>;
    };
    expect(payload.topReason).not.toContain('pw@h');
    expect(payload.topReason).toContain('redis://[REDACTED]@h');
    for (const b of payload.breakdown) expect(b.reason).not.toContain('pw@h');
  });

  it('logsToEvidence title redacts a conn string in the log message', () => {
    const records: LogRecord[] = [
      {
        timestamp: '2026-06-15T10:00:00Z',
        level: 'error',
        levelValue: 50,
        message: 'connection refused: postgres://u:pw@h',
        service: 'api',
        index: 'logs-2026.06.15',
        raw: {},
      },
    ];
    const evidence = logsToEvidence(records, 'test-query', '2026-06-15T10:05:00Z');
    expect(evidence[0]!.title).not.toContain('pw@h');
    expect(evidence[0]!.title).toContain('postgres://[REDACTED]@h');
    // The payload persists the record — its message/detail/context copies must be
    // clean too, and the raw ES _source (unredactable shape) must be dropped.
    const payload = evidence[0]!.payload as Record<string, unknown>;
    expect(payload['message']).not.toContain('pw@h');
    expect(payload['raw']).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('pw@h');
  });

  it('logsToEvidence payload redacts detail and string context values', () => {
    const records: LogRecord[] = [
      {
        timestamp: '2026-06-15T10:00:00Z',
        level: 'error',
        levelValue: 50,
        message: 'sync failed',
        detail: 'AxiosError: connect to mongodb://u:pw@mongo.internal failed',
        context: { attempt: 3, lastError: 'redis://:pw@cache refused' },
        service: 'api',
        index: 'logs-2026.06.15',
        raw: { message: 'sync failed' },
      },
    ];
    const evidence = logsToEvidence(records, 'test-query', '2026-06-15T10:05:00Z');
    const payload = evidence[0]!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('pw@');
    expect(payload['detail']).toContain('mongodb://[REDACTED]@');
    expect((payload['context'] as Record<string, unknown>)['lastError']).toContain(
      'redis://[REDACTED]@',
    );
    expect((payload['context'] as Record<string, unknown>)['attempt']).toBe(3);
  });

  it('logsToEvidence payload redacts secrets NESTED in context objects and arrays', () => {
    // Real logger context is nested (`context.error.url`, request config, driver
    // details); a top-level-only pass leaves these secrets in the persisted payload.
    const records: LogRecord[] = [
      {
        timestamp: '2026-06-15T10:00:00Z',
        level: 'error',
        levelValue: 50,
        message: 'db connect failed',
        context: {
          requestId: 'req-1',
          error: { url: 'postgres://user:supersecret@db.internal:5432/app' },
          retries: [{ dsn: 'redis://:hunter2@cache:6379' }],
        },
        service: 'api',
        index: 'logs-2026.06.15',
        raw: { message: 'db connect failed' },
      },
    ];
    const evidence = logsToEvidence(records, 'test-query', '2026-06-15T10:05:00Z');
    const payload = evidence[0]!.payload as Record<string, unknown>;
    const serialized = JSON.stringify(payload);

    // Secrets one/two levels deep (and inside an array) must not survive.
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('hunter2');
    const context = payload['context'] as Record<string, unknown>;
    expect((context['error'] as Record<string, unknown>)['url']).toContain(
      'postgres://[REDACTED]@',
    );
    expect(((context['retries'] as Record<string, unknown>[])[0]!)['dsn']).toContain(
      'redis://[REDACTED]@',
    );
    // Non-secret structure and scalars are preserved.
    expect(context['requestId']).toBe('req-1');
  });

  it('shopify queryEvidence redacts secret-bearing GraphQL error messages in the payload', async () => {
    const client = {
      graphql: async () => ({
        data: {},
        errors: [{ message: `access denied token=${FAKE_TOKEN}` }],
      }),
    } as unknown as ShopifyAdminClient;
    const provider = new ShopifyProvider(client, { store: 'test-store.myshopify.com' });
    const evidence = await provider.queryEvidence({
      queries: [{ name: 'orders', kind: 'state', query: '{ orders { edges { node { id } } } }' }],
    });
    expect(evidence).toHaveLength(1);
    const payload = evidence[0]!.payload as Record<string, unknown>;
    const errors = payload['errors'] as Array<{ message: string }>;
    expect(errors[0]!.message).not.toContain(FAKE_TOKEN);
    expect(errors[0]!.message).toContain('[REDACTED]');
    // The title is built from the same error text — must be clean too.
    expect(evidence[0]!.title).not.toContain(FAKE_TOKEN);
  });
});
