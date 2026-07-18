import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeNodePath, SourceHttpClient } from './client.js';

describe('encodeNodePath (HOR-445)', () => {
  it('escapes # so a #private-method seed id does not truncate the URL at the fragment', () => {
    const id = 'method:source/core/Ky.ts:Ky.#consumeReturnedResponseFromBeforeRetryHook';
    const out = encodeNodePath(id);
    expect(out).not.toContain('#'); // the bug: encodeURI left this literal → fragment → 404
    expect(out).toContain('%23');
    // path-shaped delimiters stay literal so the backend route still matches the node id
    expect(out).toContain('/core/Ky.ts');
    expect(out).toContain(':');
  });

  it('escapes a literal ? too (would otherwise start the query string)', () => {
    expect(encodeNodePath('a?b')).toBe('a%3Fb');
  });

  it('leaves an ordinary path-shaped node id (/ and :) intact', () => {
    expect(encodeNodePath('method:source/foo.ts:Bar.baz')).toBe('method:source/foo.ts:Bar.baz');
  });
});

describe('impact / flows — include_tests plumbing (product-only default)', () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify({}), { status: 200 });
  });

  afterEach(() => {
    urls.length = 0;
    vi.unstubAllGlobals();
  });

  function client(): SourceHttpClient {
    vi.stubGlobal('fetch', fetchMock);
    return new SourceHttpClient({ baseUrl: 'http://127.0.0.1:8420', maxRetries: 0 });
  }

  it('impact omits include_tests by default (host stays product-only)', async () => {
    await client().impact('function:src/app.ts:run', 3);
    expect(urls[0]).toContain('/api/impact/function:src/app.ts:run?depth=3');
    expect(urls[0]).not.toContain('include_tests');
  });

  it('impact maps includeTests to the include_tests query param', async () => {
    await client().impact('function:src/app.ts:run', 2, { includeTests: true });
    expect(urls[0]).toContain('?depth=2&include_tests=true');
  });

  it('flows omits include_tests by default and maps the opt-in', async () => {
    const c = client();
    await c.flows('function:src/app.ts:run');
    await c.flows('function:src/app.ts:run', { includeTests: true });
    expect(urls[0]).toContain('/api/flows/function:src/app.ts:run');
    expect(urls[0]).not.toContain('include_tests');
    expect(urls[1]).toContain('/api/flows/function:src/app.ts:run?include_tests=true');
  });
});

describe('hostInfo — symbol-only degraded-mode fields (B1.4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function clientReturning(body: unknown): SourceHttpClient {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    return new SourceHttpClient({ baseUrl: 'http://127.0.0.1:8420', maxRetries: 0 });
  }

  it('parses structuralReady + embeddingsPending from /api/host', async () => {
    const info = await clientReturning({
      repoPath: '/repos/app',
      hostUrl: 'http://127.0.0.1:8420',
      mcpUrl: 'http://127.0.0.1:8420/mcp',
      watch: false,
      mode: 'host',
      indexing: true,
      structuralReady: true,
      embeddingsPending: true,
    }).hostInfo();
    expect(info.structuralReady).toBe(true);
    expect(info.embeddingsPending).toBe(true);
    expect(info.repoPath).toBe('/repos/app');
  });

  it('tolerates an older backend that omits the fields (undefined, not a crash)', async () => {
    const info = await clientReturning({
      repoPath: '/repos/app',
      hostUrl: 'http://127.0.0.1:8420',
      mcpUrl: 'http://127.0.0.1:8420/mcp',
      watch: false,
      mode: 'host',
    }).hostInfo();
    expect(info.structuralReady).toBeUndefined();
    expect(info.embeddingsPending).toBeUndefined();
  });
});

describe('trace — relationship path query', () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ found: true, hops: 1, path: [], segments: [] }), {
      status: 200,
    });
  });

  afterEach(() => {
    urls.length = 0;
    vi.unstubAllGlobals();
  });

  function client(): SourceHttpClient {
    vi.stubGlobal('fetch', fetchMock);
    return new SourceHttpClient({ baseUrl: 'http://127.0.0.1:8420', maxRetries: 0 });
  }

  it('sends from/to as query params against /api/trace', async () => {
    await client().trace('funcA', 'ClassC');
    expect(urls[0]).toContain('/api/trace?');
    expect(urls[0]).toContain('from=funcA');
    expect(urls[0]).toContain('to=ClassC');
    expect(urls[0]).not.toContain('max_depth');
    expect(urls[0]).not.toContain('relations');
  });

  it('maps maxDepth and relations to query params', async () => {
    await client().trace('funcA', 'ClassC', { maxDepth: 4, relations: ['calls', 'imports'] });
    expect(urls[0]).toContain('max_depth=4');
    // URLSearchParams encodes the comma in the joined relations list.
    expect(urls[0]).toContain('relations=calls%2Cimports');
  });

  it('returns the parsed structured result', async () => {
    const res = await client().trace('funcA', 'ClassC');
    expect(res.found).toBe(true);
    expect(res.hops).toBe(1);
  });
});

describe('insights — graph-shape report', () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ hubs: [], bridges: [], questions: [] }), {
      status: 200,
    });
  });

  afterEach(() => {
    urls.length = 0;
    vi.unstubAllGlobals();
  });

  function client(): SourceHttpClient {
    vi.stubGlobal('fetch', fetchMock);
    return new SourceHttpClient({ baseUrl: 'http://127.0.0.1:8420', maxRetries: 0 });
  }

  it('hits /api/insights with no params by default', async () => {
    await client().insights();
    expect(urls[0]).toContain('/api/insights');
    expect(urls[0]).not.toContain('?');
  });

  it('maps hubLimit/bridgeLimit to query params', async () => {
    await client().insights({ hubLimit: 5, bridgeLimit: 3 });
    expect(urls[0]).toContain('hub_limit=5');
    expect(urls[0]).toContain('bridge_limit=3');
  });

  it('returns the parsed structured result', async () => {
    const res = await client().insights();
    expect(res.hubs).toEqual([]);
    expect(res.bridges).toEqual([]);
    expect(res.questions).toEqual([]);
  });
});
