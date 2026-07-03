/**
 * Unit tests for the shared fetchWithRetry transport helper.
 * fetch is stubbed and sleep is injected — no real timers, no I/O.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithRetry, DEFAULT_MAX_BACKOFF_MS } from './http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Injected sleep that records each requested delay and resolves instantly. */
function makeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

/** Stub fetch to return the given responses in order (or throw Error entries). */
function stubFetchSequence(...outcomes: Array<Response | Error>) {
  let i = 0;
  const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    const outcome = outcomes[Math.min(i++, outcomes.length - 1)]!;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Stub fetch to hang until the composed signal aborts, then reject with its reason. */
function stubHangingFetch() {
  const fetchMock = vi.fn(
    (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchWithRetry (happy path + status handling)', () => {
  it('returns the Response as-is on a first-attempt 200 (1 call, no sleeps)', async () => {
    const ok = new Response('body', { status: 200 });
    const fetchMock = stubFetchSequence(ok);
    const { delays, sleep } = makeSleep();

    const res = await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(res).toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('returns 404/403 immediately — other 4xx are never retried', async () => {
    for (const status of [404, 403]) {
      const fetchMock = stubFetchSequence(new Response('nope', { status }));
      const { delays, sleep } = makeSleep();
      const res = await fetchWithRetry('https://x.test/', {}, { sleep });
      expect(res.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    }
  });

  it('passes method/headers/body through to fetch unchanged and attaches a signal', async () => {
    const fetchMock = stubFetchSequence(new Response('{}', { status: 200 }));
    await fetchWithRetry('https://x.test/api', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
      body: '{"q":1}',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://x.test/api');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer t');
    expect(init?.body).toBe('{"q":1}');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchWithRetry (429/5xx retry + backoff)', () => {
  it('retries a 429 honoring a numeric Retry-After (seconds)', async () => {
    const fetchMock = stubFetchSequence(
      new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('ok', { status: 200 }),
    );
    const { delays, sleep } = makeSleep();

    const res = await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
  });

  it('clamps an oversized Retry-After to maxBackoffMs', async () => {
    stubFetchSequence(
      new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      new Response('ok', { status: 200 }),
    );
    const { delays, sleep } = makeSleep();

    await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(delays).toEqual([DEFAULT_MAX_BACKOFF_MS]);
  });

  it('falls back to exponential backoff when Retry-After is an HTTP-date', async () => {
    stubFetchSequence(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      }),
      new Response('ok', { status: 200 }),
    );
    const { delays, sleep } = makeSleep();

    await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(delays).toEqual([300]);
  });

  it('retries 5xx with exponential backoff (backoffBaseMs * 2^attempt)', async () => {
    const fetchMock = stubFetchSequence(
      new Response('err', { status: 500 }),
      new Response('err', { status: 500 }),
      new Response('ok', { status: 200 }),
    );
    const { delays, sleep } = makeSleep();

    const res = await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([300, 600]);
  });

  it('returns the LAST 5xx Response (never throws on status) once retries are exhausted', async () => {
    // Distinct Response per attempt — retried bodies get cancelled by the helper.
    const fetchMock = stubFetchSequence(
      new Response('down', { status: 503 }),
      new Response('down', { status: 503 }),
      new Response('down', { status: 503 }),
    );
    const { sleep } = makeSleep();

    const res = await fetchWithRetry('https://x.test/', {}, { maxRetries: 2, sleep });
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toBe('down'); // last body left undrained for the caller
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('fetchWithRetry (network errors)', () => {
  it('retries via the default sleep (real timer) when none is injected', async () => {
    stubFetchSequence(new Response('err', { status: 500 }), new Response('ok', { status: 200 }));
    const res = await fetchWithRetry('https://x.test/', {}, { backoffBaseMs: 1 });
    expect(res.status).toBe(200);
  });

  it('retries a network error then succeeds', async () => {
    const fetchMock = stubFetchSequence(
      new TypeError('fetch failed'),
      new Response('ok', { status: 200 }),
    );
    const { delays, sleep } = makeSleep();

    const res = await fetchWithRetry('https://x.test/', {}, { sleep });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it('rethrows the last network error unchanged after exhausting retries', async () => {
    const boom = new TypeError('fetch failed');
    const fetchMock = stubFetchSequence(boom);
    const { sleep } = makeSleep();

    await expect(fetchWithRetry('https://x.test/', {}, { maxRetries: 2, sleep })).rejects.toBe(boom);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('fetchWithRetry (aborts are never retried)', () => {
  it('rejects immediately on a pre-aborted caller signal (no retries, no sleeps)', async () => {
    const fetchMock = stubHangingFetch();
    const { delays, sleep } = makeSleep();
    const reason = new Error('already aborted');

    await expect(
      fetchWithRetry('https://x.test/', {}, { signal: AbortSignal.abort(reason), sleep }),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('rejects on per-attempt timeout without retrying', async () => {
    const fetchMock = stubHangingFetch();
    const { delays, sleep } = makeSleep();

    await expect(fetchWithRetry('https://x.test/', {}, { timeoutMs: 5, sleep })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('rejects with the caller CUSTOM abort reason mid-attempt, no retry (HOR-339 shape)', async () => {
    const fetchMock = stubHangingFetch();
    const { delays, sleep } = makeSleep();
    const ac = new AbortController();
    const reason = new Error('metrics timeout');

    const pending = fetchWithRetry('https://x.test/', {}, { signal: ac.signal, sleep });
    ac.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('default sleep resolves early on caller abort — no long real wait', async () => {
    stubFetchSequence(new Response('err', { status: 500 }));
    const ac = new AbortController();
    const reason = new Error('metrics timeout');

    // A huge backoff would hang the test unless the default sleep is abort-aware.
    const pending = fetchWithRetry(
      'https://x.test/',
      {},
      { signal: ac.signal, backoffBaseMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 10)); // let the backoff sleep start
    ac.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('rethrows the caller abort reason when the abort lands mid-backoff', async () => {
    const fetchMock = stubFetchSequence(new Response('err', { status: 500 }));
    const ac = new AbortController();
    const reason = new Error('metrics timeout');

    await expect(
      fetchWithRetry(
        'https://x.test/',
        {},
        {
          signal: ac.signal,
          // Abort while the backoff sleep is in flight.
          sleep: async () => void ac.abort(reason),
        },
      ),
    ).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
