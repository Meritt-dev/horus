import { describe, it, expect, vi, afterEach } from 'vitest';
import { LensCloudClient, parseSummary, parseReport } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const client = (): LensCloudClient =>
  new LensCloudClient({
    apiBaseUrl: 'https://cloud.example.com/',
    token: 'secret-token',
    workspaceId: 'ws-1',
  });

describe('LensCloudClient.reportsPath (URL building)', () => {
  it('builds the site-reports path with window + filter params', () => {
    const path = client().reportsPath('site-9', {
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
      q: 'checkout',
      status: 'submitted',
      limit: 10,
    });
    expect(path).toContain('/v1/workspaces/ws-1/lens/sites/site-9/reports?');
    expect(path).toContain('from=2026-06-01');
    expect(path).toContain('to=2026-06-02');
    expect(path).toContain('q=checkout');
    expect(path).toContain('status=submitted');
    expect(path).toContain('limit=10');
  });

  it('clamps limit into 1..200 and omits absent params', () => {
    expect(client().reportsPath('s', { limit: 0 })).toContain('limit=1');
    expect(client().reportsPath('s', { limit: 9999 })).toContain('limit=200');
    const bare = client().reportsPath('s');
    expect(bare).not.toContain('from=');
    expect(bare).not.toContain('q=');
  });
});

describe('LensCloudClient auth + requests', () => {
  it('sends a Bearer header + abort signal to listSites, mapping the BARE sites array', async () => {
    // Production returns a bare array (verified 2026-07-11), not an envelope.
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify([{ id: 's1', name: 'Web' }, { id: 's2' }]),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const sites = await client().listSites();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://cloud.example.com/v1/workspaces/ws-1/lens/sites');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Second site falls back name→id.
    expect(sites).toEqual([{ id: 's1', name: 'Web' }, { id: 's2', name: 's2' }]);
  });

  it('listSites tolerates a { sites: [...] } envelope as a fallback shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sites: [{ id: 's9', name: 'Wrapped' }] }), { status: 200 })),
    );
    expect(await client().listSites()).toEqual([{ id: 's9', name: 'Wrapped' }]);
  });

  it('listReports maps { reports } into summaries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            reports: [
              { id: 'r1', status: 'submitted', createdAt: '2026-06-01T00:00:00Z', errorCount: 2, comment: 'broke' },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      ),
    );
    const reports = await client().listReports('s1', { limit: 5 });
    expect(reports).toHaveLength(1);
    expect(reports[0]!.id).toBe('r1');
    expect(reports[0]!.errorCount).toBe(2);
    expect(reports[0]!.lensSiteId).toBe('s1');
  });

  it('getReport fetches one full report by id', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit): Promise<Response> =>
      new Response(
        JSON.stringify({
          id: 'r1',
          status: 'submitted',
          createdAt: '2026-06-01T00:00:00Z',
          submittedAt: '2026-06-01T00:01:00Z',
          metadata: { comment: 'hi', errors: [], networkTail: [], env: { url: 'https://app/x' } },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const report = await client().getReport('s1', 'r1');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://cloud.example.com/v1/workspaces/ws-1/lens/sites/s1/reports/r1',
    );
    expect(report.metadata?.comment).toBe('hi');
    expect(report.metadata?.env?.url).toBe('https://app/x');
  });

  it('THROWS on non-2xx so an outage reads as a gap (not "no reports")', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(client().listSites()).rejects.toThrow(/-> 403/);
  });

  it('does not retry a 403 (exactly 1 fetch call)', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client().listReports('s1')).rejects.toThrow(/-> 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('health() reports ok=false with detail on failure, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const h = await client().health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('401');
  });

  it('health() reports ok=true on a reachable workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [{ id: 's1' }] }), { status: 200 })));
    const h = await client().health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain('ws-1');
  });
});

describe('parseSummary / parseReport (coercion + tolerance)', () => {
  it('defaults gracefully when list fields are missing', () => {
    const s = parseSummary({ id: 7 }, 'site-x');
    expect(s.id).toBe('7');
    expect(s.lensSiteId).toBe('site-x');
    expect(s.errorCount).toBe(0);
    expect(s.hasReplay).toBe(false);
    expect(s.comment).toBeUndefined();
  });

  it('parseReport tolerates a null/absent metadata', () => {
    const r = parseReport({ id: 'r', status: 'submitted', createdAt: '2026-01-01T00:00:00Z', metadata: null });
    expect(r.metadata).toBeNull();
    expect(parseReport({}).id).toBe('');
  });
});
