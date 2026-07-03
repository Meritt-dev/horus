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
