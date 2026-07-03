import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AxiomClient,
  buildApl,
  buildErrorSignatureApl,
  buildRecentErrorsApl,
  parseTabular,
  parseDataset,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildApl (APL query building)', () => {
  it('builds a newest-first, capped query over the dataset', () => {
    const apl = buildApl('logs', [], 50);
    expect(apl).toBe("['logs'] | sort by _time desc | limit 50");
  });

  it('adds an OR-joined full-text search for domain hint terms (length > 2)', () => {
    const apl = buildApl('logs', ['checkout', 'sku', 'a'], 10);
    expect(apl).toContain('| search "checkout" or "sku"');
    // short terms are dropped
    expect(apl).not.toContain('"a"');
    expect(apl).toContain('| sort by _time desc | limit 10');
  });

  it('clamps the limit into 1..1000', () => {
    expect(buildApl('logs', [], 0)).toContain('limit 1');
    expect(buildApl('logs', [], 99999)).toContain('limit 1000');
  });
});

describe('buildErrorSignatureApl (incident-aware top error signatures)', () => {
  it('restricts to error/warn/fatal and summarizes count() + max(_time) by message+level, count desc', () => {
    const apl = buildErrorSignatureApl('logs', ['klaviyo', 'failed'], 8);
    expect(apl).toContain("['logs']");
    expect(apl).toContain("| where tolower(tostring(level)) in ('error', 'warn', 'fatal')");
    // hint terms still bias the window (search scans message + error.* / errorMessage fields)
    expect(apl).toContain('| search "klaviyo" or "failed"');
    expect(apl).toContain("summarize ['count'] = count(), ['_time'] = max(_time) by message, level");
    expect(apl).toContain("| sort by ['count'] desc | limit 8");
  });

  it('works without hint terms (level-only error bias) and clamps the limit', () => {
    const apl = buildErrorSignatureApl('logs', [], 0);
    expect(apl).not.toContain('| search');
    expect(apl).toContain("| where tolower(tostring(level)) in ('error', 'warn', 'fatal')");
    expect(apl).toContain('limit 1');
  });
});

describe('buildRecentErrorsApl (incident-aware recent raw errors)', () => {
  it('restricts to error levels (AND hint terms), newest-first, capped', () => {
    const apl = buildRecentErrorsApl('logs', ['klaviyo'], 5);
    expect(apl).toContain("| where tolower(tostring(level)) in ('error', 'warn', 'fatal')");
    expect(apl).toContain('| search "klaviyo"');
    expect(apl).toContain('| sort by _time desc | limit 5');
    expect(apl).not.toContain('summarize');
  });
});

describe('parseTabular (tabular response -> records)', () => {
  it('parses a column-oriented response into flat records with hoisted _time', () => {
    const raw = {
      tables: [
        {
          name: '0',
          fields: [
            { name: '_time', type: 'datetime' },
            { name: 'level', type: 'string' },
            { name: 'message', type: 'string' },
          ],
          columns: [
            ['2026-06-22T10:00:00Z', '2026-06-22T11:00:00Z'],
            ['error', 'info'],
            ['boom', 'ok'],
          ],
        },
      ],
    };
    const recs = parseTabular(raw);
    expect(recs).toHaveLength(2);
    expect(recs[0]!.timestamp).toBe('2026-06-22T10:00:00Z');
    expect(recs[0]!.fields['level']).toBe('error');
    expect(recs[0]!.fields['message']).toBe('boom');
    expect(recs[1]!.fields['message']).toBe('ok');
  });

  it('parses a row-oriented response', () => {
    const raw = {
      tables: [
        {
          fields: [{ name: '_time' }, { name: 'msg' }],
          rows: [
            ['2026-06-22T10:00:00Z', 'hi'],
            ['2026-06-22T11:00:00Z', 'bye'],
          ],
        },
      ],
    };
    const recs = parseTabular(raw);
    expect(recs).toHaveLength(2);
    expect(recs[1]!.fields['msg']).toBe('bye');
    expect(recs[1]!.timestamp).toBe('2026-06-22T11:00:00Z');
  });

  it('returns [] for empty / malformed responses', () => {
    expect(parseTabular(null)).toEqual([]);
    expect(parseTabular(undefined)).toEqual([]);
    expect(parseTabular({})).toEqual([]);
    expect(parseTabular({ tables: [] })).toEqual([]);
    expect(parseTabular({ tables: [{ fields: [{ name: 'x' }] }] })).toEqual([]);
  });
});

describe('parseDataset', () => {
  it('trims to name + optional description', () => {
    expect(parseDataset({ name: 'logs', description: 'prod logs' })).toEqual({
      name: 'logs',
      description: 'prod logs',
    });
    expect(parseDataset({ name: 'logs', description: '' })).toEqual({ name: 'logs' });
  });
});

describe('AxiomClient auth + request', () => {
  it('sends a Bearer auth header and posts the _apl query body, against the configured base URL', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ tables: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new AxiomClient({
      token: 'secret-token',
      dataset: 'logs',
      baseUrl: 'https://api.eu.axiom.co/',
    });
    await client.query("['logs'] | limit 1", '2026-06-22T00:00:00Z', '2026-06-22T12:00:00Z');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.eu.axiom.co/v1/datasets/_apl?format=tabular');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body.apl).toBe("['logs'] | limit 1");
    expect(body.startTime).toBe('2026-06-22T00:00:00Z');
    expect(body.endTime).toBe('2026-06-22T12:00:00Z');
  });

  it('query() THROWS when the API responds non-2xx (an outage must not read as "no rows")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    await expect(client.query('q', 'a', 'b')).rejects.toThrow(/-> 403/);
  });

  it('listDatasets() returns [] (never throws) when fetch rejects (timeout/network)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted'); }));
    // maxRetries: 0 — a rejecting mock would otherwise be retried with real backoff.
    const client = new AxiomClient({ token: 't', dataset: 'logs', http: { maxRetries: 0 } });
    await expect(client.listDatasets()).resolves.toEqual([]);
  });

  it('retries a 500 with exponential backoff then succeeds', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify([{ name: 'logs' }]), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];
    const client = new AxiomClient({
      token: 't', dataset: 'logs',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    const ds = await client.listDatasets();
    expect(ds.map((d) => d.name)).toEqual(['logs']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it('listDatasets() parses the datasets array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ name: 'logs' }, { name: 'traces' }]), { status: 200 })),
    );
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    const ds = await client.listDatasets();
    expect(ds.map((d) => d.name)).toEqual(['logs', 'traces']);
  });

  it('health() reports ok=false with detail on failure, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    const h = await client.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('401');
  });

  it('health() reports ok=true on a reachable dataset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('logs');
  });
});
