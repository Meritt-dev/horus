/**
 * HOR-91 — Mocked tests for ElasticsearchLogsProvider.queryEvidence().
 * No live Elasticsearch instance required.
 */

import { describe, it, expect } from 'vitest';
import { ElasticsearchClient } from './client.js';
import { ElasticsearchLogsProvider } from './provider.js';
import { redactSensitiveString } from './analyze.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function makeClient(...responses: unknown[]): ElasticsearchClient {
  const client = new ElasticsearchClient({ baseUrl: 'http://mock' });
  let idx = 0;
  client.search = async () => responses[idx++] ?? {};
  return client;
}

function makeProvider(client: ElasticsearchClient): ElasticsearchLogsProvider {
  return new ElasticsearchLogsProvider(client, { indexPattern: 'test-*' });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANALYSIS_RESPONSE = {
  hits: { total: { value: 12 } },
  aggregations: {
    by_sig: {
      buckets: [
        {
          key: 'AUTH001',
          doc_count: 10,
          first_seen: { value_as_string: '2026-06-13T10:00:00Z' },
          last_seen: { value_as_string: '2026-06-13T11:00:00Z' },
          services: { buckets: [{ key: 'my-api' }] },
          sample: {
            hits: { hits: [{ _source: { message: 'Token expired' } }] },
          },
        },
      ],
    },
    affected_services: { buckets: [{ key: 'my-api' }] },
  },
};

const EMPTY_RESPONSE = {
  hits: { total: { value: 0 } },
  aggregations: {
    by_sig: { buckets: [] },
    affected_services: { buckets: [] },
  },
};

const SENSITIVE_RESPONSE = {
  hits: { total: { value: 1 } },
  aggregations: {
    by_sig: {
      buckets: [
        {
          key: 'LEAK001',
          doc_count: 1,
          first_seen: { value_as_string: '2026-06-13T10:00:00Z' },
          last_seen: { value_as_string: '2026-06-13T10:00:01Z' },
          services: { buckets: [] },
          sample: {
            hits: {
              hits: [
                {
                  _source: {
                    message: 'Request failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret',
                  },
                },
              ],
            },
          },
        },
      ],
    },
    affected_services: { buckets: [] },
  },
};

// ---------------------------------------------------------------------------
// queryEvidence — success
// ---------------------------------------------------------------------------

describe('queryEvidence — success', () => {
  it('finds a native code stored separately from the message through broad search', async () => {
    const client = makeClient();
    client.search = async (_index, body) => {
      const query = (body as { query: { bool: { must: Array<{ multi_match: { fields: string[]; query: string } }> } } }).query.bool;
      expect(query.must[0]!.multi_match.query).toBe('AUTH001');
      expect(query.must[0]!.multi_match.fields).toContain('event_code');
      return ANALYSIS_RESPONSE; // message is "Token expired", not "AUTH001".
    };
    const evidence = await makeProvider(client).queryEvidence({ text: 'AUTH001', broadText: true });
    expect(evidence.some(e => e.title.includes('AUTH001'))).toBe(true);
  });

  it('returns Evidence[] from a mocked analysis response', async () => {
    // analyzeErrors makes 2 calls (current + baseline); provide both
    const client = makeClient(ANALYSIS_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({ service: 'my-api' }, '2026-06-13T12:00:00Z');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]!.source).toBe('logs');
    expect(evidence[0]!.kind).toBe('log');
  });

  it('includes the signature key in the evidence title', async () => {
    const client = makeClient(ANALYSIS_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({ service: 'my-api' });
    const titles = evidence.map((e) => e.title);
    expect(titles.some((t) => t.includes('AUTH001'))).toBe(true);
  });

  it('sets provenance.collectedAt to the provided timestamp', async () => {
    const client = makeClient(ANALYSIS_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({}, '2026-06-13T09:00:00Z');
    expect(evidence[0]!.provenance.collectedAt).toBe('2026-06-13T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// queryEvidence — no results
// ---------------------------------------------------------------------------

describe('queryEvidence — no results', () => {
  it('returns empty array when no errors are found', async () => {
    const client = makeClient(EMPTY_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({ service: 'quiet-api' });
    expect(evidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryEvidence — connection failure
// ---------------------------------------------------------------------------

describe('queryEvidence — connection failure', () => {
  it('returns empty array when the client throws', async () => {
    const client = new ElasticsearchClient({ baseUrl: 'http://mock' });
    client.search = async () => { throw new Error('ECONNREFUSED'); };
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({ service: 'my-api' });
    expect(evidence).toEqual([]);
  });

  it('does not throw to the caller on network error', async () => {
    const client = new ElasticsearchClient({ baseUrl: 'http://mock' });
    client.search = async () => { throw new Error('timeout'); };
    const provider = makeProvider(client);
    await expect(provider.queryEvidence({})).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryEvidence — malformed response
// ---------------------------------------------------------------------------

describe('queryEvidence — malformed response', () => {
  it('returns empty array for a completely empty object', async () => {
    const client = makeClient({});
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({});
    expect(evidence).toEqual([]);
  });

  it('returns empty array when aggregations block is null', async () => {
    const client = makeClient({ hits: { total: { value: 0 } }, aggregations: null });
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({});
    expect(evidence).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// queryEvidence — redaction
// ---------------------------------------------------------------------------

describe('queryEvidence — redaction', () => {
  it('redacts Bearer tokens from sampleMessage in payload', async () => {
    const client = makeClient(SENSITIVE_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({}, '2026-06-13T10:00:00Z');
    const sigEv = evidence.find((e) => (e.payload as Record<string, unknown>)?.['key'] === 'LEAK001');
    expect(sigEv).toBeDefined();
    const msg = (sigEv!.payload as Record<string, unknown>)['sampleMessage'] as string;
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(msg).toContain('[REDACTED]');
  });

  it('does not redact the evidence title (only payload)', async () => {
    const client = makeClient(SENSITIVE_RESPONSE, EMPTY_RESPONSE);
    const provider = makeProvider(client);
    const evidence = await provider.queryEvidence({});
    const sigEv = evidence.find((e) => (e.payload as Record<string, unknown>)?.['key'] === 'LEAK001');
    expect(sigEv!.title).toContain('LEAK001');
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveString — unit tests
// ---------------------------------------------------------------------------

describe('redactSensitiveString', () => {
  it('redacts Bearer token', () => {
    const result = redactSensitiveString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts password= key-value pairs', () => {
    const result = redactSensitiveString('login failed: password=SuperSecret123');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('SuperSecret123');
  });

  it('redacts JSON "token" field', () => {
    const result = redactSensitiveString('payload: {"token": "abc123xyz"}');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('abc123xyz');
  });

  it('does not modify strings with no sensitive content', () => {
    const clean = 'User login failed: invalid email format';
    expect(redactSensitiveString(clean)).toBe(clean);
  });

  it('redacts 16-digit card numbers', () => {
    const result = redactSensitiveString('charge failed for card 4111 1111 1111 1111');
    expect(result).toContain('[REDACTED-CARD]');
    expect(result).not.toContain('4111');
  });
});

// ---------------------------------------------------------------------------
// analyzeDurations — INFO-level duration-by-dimension (HOR-434)
// ---------------------------------------------------------------------------

function hit(source: Record<string, unknown>): Record<string, unknown> {
  return { _index: 'test-1', _source: source };
}

describe('ElasticsearchLogsProvider.analyzeDurations', () => {
  it('aggregates INFO completion durations by a regex-extracted region', async () => {
    const client = makeClient({
      hits: {
        total: { value: 3 },
        hits: [
          hit({ level: 30, message: 'Completed MANAGE_SALES:KSA ~2m10s' }),
          hit({ level: 30, message: 'Completed MANAGE_SALES:KSA ~2m0s' }),
          hit({ level: 30, message: 'Completed MANAGE_SALES:UAE ~19ms' }),
        ],
      },
    });
    const result = await makeProvider(client).analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(result).not.toBeNull();
    expect(result!.dimension).toBe('region');
    expect(result!.byValue['KSA']!.count).toBe(2);
    expect(result!.byValue['KSA']!.avg).toBe(125_000);
    expect(result!.byValue['UAE']!.count).toBe(1);
    expect(result!.byValue['UAE']!.avg).toBe(19);
  });

  it('aggregates by a structured dimension + duration field', async () => {
    const client = makeClient({
      hits: {
        total: { value: 2 },
        hits: [
          hit({ level: 30, message: 'done', context: { market: 'KSA' }, duration_ms: 130_000 }),
          hit({ level: 30, message: 'done', context: { market: 'UAE' }, duration_ms: 19 }),
        ],
      },
    });
    const result = await makeProvider(client).analyzeDurations({
      dimension: { name: 'market', field: 'context.market' },
      durationField: 'duration_ms',
    });
    expect(result!.byValue['KSA']!.avg).toBe(130_000);
    expect(result!.byValue['UAE']!.avg).toBe(19);
  });

  it('returns null when no completion/duration lines match (graceful)', async () => {
    const client = makeClient({ hits: { total: { value: 0 }, hits: [] } });
    const result = await makeProvider(client).analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(result).toBeNull();
  });

  it('never throws — degrades to null when the client search fails', async () => {
    const client = new ElasticsearchClient({ baseUrl: 'http://mock' });
    client.search = async () => {
      throw new Error('boom');
    };
    const result = await makeProvider(client).analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
    });
    expect(result).toBeNull();
  });
});
