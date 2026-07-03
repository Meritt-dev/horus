/**
 * Transport tests for ElasticsearchClient: auth header, the exact error-message
 * contract on non-ok responses, and fetchWithRetry adoption (retry on 5xx, no
 * retry on 4xx/abort). fetch is stubbed and sleep injected — no I/O, no timers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElasticsearchClient } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const instantSleep = async (): Promise<void> => {};

describe('ElasticsearchClient auth + request', () => {
  it('sends a Basic auth header formed from username/password', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ElasticsearchClient({
      baseUrl: 'http://es.local:9200/',
      username: 'elastic',
      password: 'changeme',
    });
    await client.request('GET', '/_cluster/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://es.local:9200/_cluster/health');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('elastic:changeme').toString('base64')}`,
    );
  });

  it('attaches a default AbortSignal (timeout) when the caller passes none', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new ElasticsearchClient({ baseUrl: 'http://es.local:9200' });
    await client.request('GET', '/_cluster/health');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('ElasticsearchClient error contract + retries', () => {
  it('throws the exact message after a persistent 500 exhausts retries', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ElasticsearchClient({
      baseUrl: 'http://es.local:9200',
      http: { maxRetries: 1, sleep: instantSleep },
    });
    await expect(client.search('idx', { query: {} })).rejects.toThrow(
      'Elasticsearch POST /idx/_search -> 500: boom',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404 and keeps the message contract', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ElasticsearchClient({
      baseUrl: 'http://es.local:9200',
      http: { sleep: instantSleep },
    });
    await expect(client.request('GET', '/missing')).rejects.toThrow(
      'Elasticsearch GET /missing -> 404: nope',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 502 then returns the parsed JSON on 200', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> => new Response('{"count": 7}', { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const client = new ElasticsearchClient({
      baseUrl: 'http://es.local:9200',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    await expect(client.count('idx', {})).resolves.toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it('rejects without retrying when the caller-supplied signal is already aborted', async () => {
    const reason = new Error('probe timed out');
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      (init?.signal as AbortSignal).throwIfAborted();
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const client = new ElasticsearchClient({
      baseUrl: 'http://es.local:9200',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    await expect(
      client.request('GET', '/_cluster/health', undefined, AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});
