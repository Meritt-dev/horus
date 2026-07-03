import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SentryClient,
  parseIssue,
  extractTopInAppFrame,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SentryClient.issuesPath (URL building)', () => {
  const client = new SentryClient({ authToken: 't', org: 'acme', project: 'web' });

  it('builds the project-issues path with a default query + statsPeriod window', () => {
    const path = client.issuesPath({ statsPeriod: '24h', limit: 10 });
    expect(path).toContain('/api/0/projects/acme/web/issues/');
    expect(path).toContain('query=is%3Aunresolved');
    expect(path).toContain('statsPeriod=24h');
    expect(path).toContain('limit=10');
  });

  it('prefers an explicit start/end range over statsPeriod', () => {
    const path = client.issuesPath({
      statsPeriod: '24h',
      start: '2026-06-01T00:00:00Z',
      end: '2026-06-02T00:00:00Z',
    });
    expect(path).toContain('start=2026-06-01');
    expect(path).toContain('end=2026-06-02');
    expect(path).not.toContain('statsPeriod');
  });

  it('clamps the limit into 1..100', () => {
    expect(client.issuesPath({ limit: 0 })).toContain('limit=1');
    expect(client.issuesPath({ limit: 9999 })).toContain('limit=100');
  });

  it('url-encodes org/project slugs', () => {
    const c = new SentryClient({ authToken: 't', org: 'a/b', project: 'c d' });
    const path = c.issuesPath();
    expect(path).toContain('/projects/a%2Fb/c%20d/issues/');
  });
});

describe('SentryClient auth + request', () => {
  it('sends a Bearer auth header and an 8s abort signal, against the configured base URL', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response('[]', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new SentryClient({
      authToken: 'secret-token',
      org: 'acme',
      project: 'web',
      baseUrl: 'https://sentry.example.com/',
    });
    await client.listIssues({ statsPeriod: '24h' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/sentry\.example\.com\/api\/0\/projects\/acme\/web\/issues\//);
    expect(init?.method).toBe('GET');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('THROWS when the API responds non-2xx (an outage must not read as "no issues")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'web' });
    await expect(client.listIssues()).rejects.toThrow(/-> 403/);
  });

  it('does not retry a 403 (exactly 1 fetch call)', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'web' });
    await expect(client.listIssues()).rejects.toThrow(/-> 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('THROWS when fetch rejects (timeout/network) — the engine records it as a gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('The operation was aborted'); }));
    // maxRetries: 0 — a rejecting mock would otherwise be retried with real backoff.
    const client = new SentryClient({
      authToken: 't', org: 'acme', project: 'web', http: { maxRetries: 0 },
    });
    await expect(client.listIssues()).rejects.toThrow();
  });

  it('retries a 429 honoring Retry-After (seconds) then succeeds', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Response('[]', { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];
    const client = new SentryClient({
      authToken: 't', org: 'acme', project: 'web',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    await expect(client.listIssues()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2000]);
  });

  it('retries a 500 with exponential backoff then succeeds', async () => {
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify([{ id: '1', title: 'boom', count: '2', userCount: '1' }]), {
          status: 200,
        }),
    );
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const delays: number[] = [];
    const client = new SentryClient({
      authToken: 't', org: 'acme', project: 'web',
      http: { sleep: async (ms) => void delays.push(ms) },
    });
    const issues = await client.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe('boom');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([300]);
  });

  it('health() reports ok=false with detail on failure, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'web' });
    const h = await client.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('401');
  });

  it('health() reports ok=true on a reachable project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const client = new SentryClient({ authToken: 't', org: 'acme', project: 'web' });
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('acme/web');
  });
});

describe('parseIssue (count coercion)', () => {
  it('coerces string counts to numbers and trims to the evidence fields', () => {
    const issue = parseIssue({
      id: '42',
      title: "TypeError: Cannot read properties of undefined (reading 'sku')",
      culprit: 'syncBrandFulfillments(brand.service)',
      level: 'error',
      count: '1234',
      userCount: '56',
      lastSeen: '2026-06-22T10:00:00Z',
      firstSeen: '2026-06-01T10:00:00Z',
      permalink: 'https://sentry.io/acme/web/issues/42/',
    });
    expect(issue.id).toBe('42');
    expect(issue.count).toBe(1234);
    expect(issue.userCount).toBe(56);
    expect(issue.culprit).toBe('syncBrandFulfillments(brand.service)');
    expect(issue.level).toBe('error');
    expect(issue.lastSeen).toBe('2026-06-22T10:00:00Z');
  });

  it('defaults gracefully when fields are missing', () => {
    const issue = parseIssue({ id: 7 });
    expect(issue.id).toBe('7');
    expect(issue.title).toBe('(untitled)');
    expect(issue.count).toBe(0);
    expect(issue.userCount).toBe(0);
    expect(issue.culprit).toBeUndefined();
  });
});

describe('extractTopInAppFrame (top in-app frame from a sample event)', () => {
  // Frames are oldest→newest; the crashing in-app frame is the LAST in_app frame.
  const sampleEvent = {
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value: "Cannot read properties of undefined (reading 'sku')",
              stacktrace: {
                frames: [
                  { filename: 'node_modules/express/lib/router.js', function: 'handle', in_app: false, lineNo: 10 },
                  { filename: 'src/controllers/webhook.ts', function: 'onShopifyWebhook', in_app: true, lineNo: 88 },
                  { filename: 'src/services/brand.ts', function: 'syncBrandFulfillments', in_app: true, lineNo: 142 },
                  { filename: 'node_modules/pg/lib/client.js', function: 'query', in_app: false, lineNo: 5 },
                ],
              },
            },
          ],
        },
      },
    ],
  };

  it('returns the last in-app frame (the raise site)', () => {
    const frame = extractTopInAppFrame(sampleEvent);
    expect(frame).not.toBeNull();
    expect(frame!.filename).toBe('src/services/brand.ts');
    expect(frame!.function).toBe('syncBrandFulfillments');
    expect(frame!.lineno).toBe(142);
  });

  it('reads the SDK/store shape (top-level exception.values[].stacktrace.frames)', () => {
    const frame = extractTopInAppFrame({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'src/a.ts', function: 'a', in_app: true, lineno: 1 },
                { filename: 'src/b.ts', function: 'b', in_app: true, lineno: 2 },
              ],
            },
          },
        ],
      },
    });
    expect(frame!.filename).toBe('src/b.ts');
    expect(frame!.lineno).toBe(2);
  });

  it('falls back to the last frame when no in-app frame exists', () => {
    const frame = extractTopInAppFrame({
      stacktrace: {
        frames: [
          { filename: 'node_modules/x/a.js', function: 'a', in_app: false, lineno: 1 },
          { filename: 'node_modules/x/b.js', function: 'b', in_app: false, lineno: 2 },
        ],
      },
    });
    expect(frame!.filename).toBe('node_modules/x/b.js');
  });

  it('returns null for empty / malformed events', () => {
    expect(extractTopInAppFrame(null)).toBeNull();
    expect(extractTopInAppFrame(undefined)).toBeNull();
    expect(extractTopInAppFrame({})).toBeNull();
    expect(extractTopInAppFrame({ entries: [] })).toBeNull();
  });

  it('handles absPath/abs_path filenames and lineno spelled either way', () => {
    const frame = extractTopInAppFrame({
      stacktrace: { frames: [{ abs_path: '/app/src/x.ts', function: 'x', in_app: true, lineno: 99 }] },
    });
    expect(frame!.filename).toBe('/app/src/x.ts');
    expect(frame!.lineno).toBe(99);
  });
});
