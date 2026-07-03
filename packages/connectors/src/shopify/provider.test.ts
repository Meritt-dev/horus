import { describe, it, expect, vi, afterEach } from 'vitest';
import { ShopifyProvider, buildTitle, computeRelevance, type ShopifyRecord } from './provider.js';
import { ShopifyAdminClient } from './client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A client backed by a fetch mock (no accessId → `secret` is used directly, no grant). */
function stubClient(): ShopifyAdminClient {
  return new ShopifyAdminClient({ store: 'acme', secret: 'tok' });
}

describe('ShopifyProvider.collect + toEvidence', () => {
  it('runs supplied queries verbatim, binds the window, and maps results to state evidence', async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init!.body)));
        return new Response(
          JSON.stringify({ data: { orders: { edges: [{ node: { id: '1' } }, { node: { id: '2' } }] } } }),
          { status: 200 },
        );
      }),
    );

    const provider = new ShopifyProvider(stubClient(), { store: 'acme.myshopify.com' });
    const records = await provider.collect({
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-08T00:00:00Z',
      hintTerms: ['orders'],
      queries: [
        {
          name: 'recent-orders',
          query: 'query($from:DateTime){ orders{ edges{ node{ id } } } }',
          kind: 'state',
          bindWindow: true,
        },
      ],
    });

    expect(records).toHaveLength(1);
    // Query forwarded verbatim; window bound into variables.
    expect(bodies[0]!.query).toBe('query($from:DateTime){ orders{ edges{ node{ id } } } }');
    expect(bodies[0]!.variables).toMatchObject({ from: '2026-06-01T00:00:00Z', to: '2026-06-08T00:00:00Z' });

    const evidence = provider.toEvidence(records, ['orders'], '2026-06-08T00:00:00Z');
    expect(evidence[0]!.source).toBe('state');
    expect(evidence[0]!.kind).toBe('state');
    expect(evidence[0]!.title).toContain('recent-orders');
    expect(evidence[0]!.title).toContain('2 results');
    expect((evidence[0]!.payload as { shop: string }).shop).toBe('acme.myshopify.com');
    expect(evidence[0]!.provenance.query).toBe('shopify acme.myshopify.com recent-orders');
  });

  it('maps a per-query kind onto the right evidence source', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    const provider = new ShopifyProvider(stubClient(), { store: 'acme' });
    const records = await provider.collect({
      queries: [{ name: 'm', query: '{ x }', kind: 'metric' }],
    });
    const [ev] = provider.toEvidence(records, [], '2026-06-08T00:00:00Z');
    expect(ev!.kind).toBe('metric');
    expect(ev!.source).toBe('metrics');
  });

  it('falls back to config-declared queries when the caller supplies none (watch path)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { shop: { name: 'Acme' } } }), { status: 200 })),
    );
    const provider = new ShopifyProvider(stubClient(), {
      store: 'acme',
      queries: [{ name: 'shop', query: '{ shop { name } }', kind: 'state' }],
    });
    const records = await provider.collect({});
    expect(records.map((r) => r.name)).toEqual(['shop']);
  });

  it('returns [] when neither supplied nor config queries exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    const provider = new ShopifyProvider(stubClient(), { store: 'acme' });
    expect(await provider.collect({})).toEqual([]);
  });

  it('drops a failing query but keeps the others (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init!.body)) as { query: string };
        if (body.query === 'BAD') return new Response('boom', { status: 500 });
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }),
    );
    const provider = new ShopifyProvider(stubClient(), { store: 'acme' });
    const records = await provider.collect({
      queries: [
        { name: 'bad', query: 'BAD', kind: 'state' },
        { name: 'good', query: 'GOOD', kind: 'state' },
      ],
    });
    expect(records.map((r) => r.name)).toEqual(['good']);
  });

  it('THROWS when EVERY query fails — a total outage must reach the engine as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('boom', { status: 500 })));
    const provider = new ShopifyProvider(stubClient(), { store: 'acme' });
    await expect(
      provider.collect({
        queries: [
          { name: 'a', query: 'A', kind: 'state' },
          { name: 'b', query: 'B', kind: 'state' },
        ],
      }),
    ).rejects.toThrow(/-> 500/);
  });

  it('queryEvidence still degrades to [] when every query fails (CLI-safe entry point)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response('boom', { status: 500 })));
    const provider = new ShopifyProvider(stubClient(), { store: 'acme' });
    await expect(
      provider.queryEvidence({ queries: [{ name: 'a', query: 'A', kind: 'state' }] }),
    ).resolves.toEqual([]);
  });
});

describe('buildTitle', () => {
  it('summarizes an edge count', () => {
    const rec: ShopifyRecord = {
      name: 'orders',
      kind: 'state',
      data: { orders: { edges: [{}, {}, {}] } },
    };
    expect(buildTitle(rec, 'acme')).toContain('3 results');
  });
  it('surfaces the first GraphQL error', () => {
    const rec: ShopifyRecord = { name: 'q', kind: 'state', data: null, errors: [{ message: 'Field not found' }] };
    expect(buildTitle(rec, 'acme')).toContain('error: Field not found');
  });
});

describe('computeRelevance', () => {
  it('bumps on a hint-term match and clamps to [0.5, 0.95]', () => {
    const base: ShopifyRecord = { name: 'q', kind: 'state', data: { note: 'checkout failing' } };
    expect(computeRelevance(base, [])).toBeCloseTo(0.6);
    expect(computeRelevance(base, ['checkout'])).toBeCloseTo(0.8);
    expect(computeRelevance({ ...base, relevance: 0.99 }, [])).toBe(0.95);
    expect(computeRelevance({ ...base, relevance: 0.1 }, [])).toBe(0.5);
  });
});
