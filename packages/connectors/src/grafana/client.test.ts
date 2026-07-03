/**
 * Transport tests for GrafanaClient: auth header, getJson error contracts,
 * fetchWithRetry adoption, health(), and the datasource-proxy queries. The
 * engine-abort case guards HOR-339 — a metrics budget abort (custom reason)
 * must reject promptly and never be retried, so the provider's partial-metrics
 * paths keep working. fetch is stubbed and sleep injected — no I/O, no timers
 * (except the tiny real per-attempt timeout in the hung-request case).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GrafanaClient } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const instantSleep = async (): Promise<void> => {};

/** Await a rejection and hand back the Error so multiple assertions can run on it. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!;
}

describe('GrafanaClient auth + request', () => {
  it('sends a Basic auth header formed from username/password', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response('[]', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000/',
      username: 'admin',
      password: 'secret',
    });
    await client.searchDashboards();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://grafana.local:3000/api/search?type=dash-db');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
  });
});

describe('GrafanaClient error contracts + retries', () => {
  it('throws the exact GET message after a persistent 500 exhausts retries', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { maxRetries: 1, sleep: instantSleep },
    });
    await expect(client.searchDashboards()).rejects.toThrow(
      'Grafana GET http://grafana.local:3000/api/search?type=dash-db -> 500: down',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the invalid-JSON message on a 200 with a bad body, without retrying', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('<html>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { sleep: instantSleep },
    });
    await expect(client.searchDashboards()).rejects.toThrow(
      'Grafana GET http://grafana.local:3000/api/search?type=dash-db: response is not valid JSON',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 then succeeds', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify([{ uid: 'u1', title: 'API' }]), { status: 200 }),
    );
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    const dashboards = await client.searchDashboards();
    expect(dashboards).toEqual([{ uid: 'u1', title: 'API', folderTitle: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it('rejects promptly on an engine-style custom-reason abort, without retrying (HOR-339)', async () => {
    // Hang until the composed signal aborts, then reject with its reason —
    // mirrors an in-flight datasource-proxy query when the metrics budget fires.
    const fetchMock = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    const ac = new AbortController();
    const reason = new Error('metrics timeout');
    const pending = client.datasourceRange('ds1', 'up', 0, 60, 15, ac.signal);
    ac.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('throws the Prometheus payload error on a 200 status:error body, without transport retry', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ status: 'error', error: 'bad expr' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { sleep: instantSleep },
    });
    await expect(client.datasourceRange('ds1', 'up{', 0, 60, 15)).rejects.toThrow(
      'Prometheus datasource error: bad expr',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('redacts secrets in and caps the upstream body of the non-2xx message', async () => {
    const body = '{"message":"denied","password":"super-secret-value"}' + 'y'.repeat(400);
    const fetchMock = vi.fn(async (): Promise<Response> => new Response(body, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    const err = await rejection(client.searchDashboards());
    expect(err.message).not.toContain('super-secret-value');
    expect(err.message).toContain('[REDACTED]');
    // Body portion capped at 200 chars of upstream text (403 is non-retryable).
    const marker = ' -> 403: ';
    expect(err.message.slice(err.message.indexOf(marker) + marker.length).length)
      .toBeLessThanOrEqual(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out a hung request after the per-attempt timeoutMs, without retrying', async () => {
    // Hang until the composed per-attempt timeout aborts, then reject with its reason.
    const fetchMock = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];

    const client = new GrafanaClient({
      baseUrl: 'http://grafana.local:3000',
      http: { timeoutMs: 10, sleep: async (ms) => void delays.push(ms) },
    });
    await expect(client.searchDashboards()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe('GrafanaClient health', () => {
  it('is ok on a 200 /api/health', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL): Promise<Response> =>
        new Response('{"database":"ok"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    expect(await client.health()).toEqual({ ok: true, detail: 'grafana ok' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://grafana.local:3000/api/health');
  });

  it('captures a non-2xx as ok:false instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => new Response('nope', { status: 404 })),
    );

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('-> 404: nope');
  });
});

describe('GrafanaClient datasource proxy', () => {
  it('datasourceRange hits the query_range proxy URL and returns the raw payload', async () => {
    const payload = { status: 'success', data: { resultType: 'matrix', result: [] } };
    const fetchMock = vi.fn(
      async (_url: string | URL): Promise<Response> =>
        new Response(JSON.stringify(payload), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    expect(await client.datasourceRange('ds1', 'up', 0, 60, 15)).toEqual(payload);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://grafana.local:3000/api/datasources/proxy/uid/ds1/api/v1/query_range?query=up&start=0&end=60&step=15',
    );
  });

  it('datasourceInstant includes the optional time param and returns the raw payload', async () => {
    const payload = { status: 'success', data: { resultType: 'vector', result: [] } };
    const fetchMock = vi.fn(
      async (_url: string | URL): Promise<Response> =>
        new Response(JSON.stringify(payload), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    expect(await client.datasourceInstant('ds1', 'up', 1234)).toEqual(payload);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://grafana.local:3000/api/datasources/proxy/uid/ds1/api/v1/query?query=up&time=1234',
    );
  });

  it('datasourceInstant throws a redacted Prometheus payload error on status:error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (): Promise<Response> =>
          new Response(
            JSON.stringify({
              status: 'error',
              error: 'unauthorized at https://scraper:s3cret@prom.internal',
            }),
            { status: 200 },
          ),
      ),
    );

    const client = new GrafanaClient({ baseUrl: 'http://grafana.local:3000' });
    const err = await rejection(client.datasourceInstant('ds1', 'up'));
    expect(err.message).not.toContain('s3cret');
    expect(err.message).toBe(
      'Prometheus datasource error: unauthorized at https://[REDACTED]@prom.internal',
    );
  });
});
