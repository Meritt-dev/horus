import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AxiomClient,
  AxiomProvider,
  buildTitle,
  computeRelevance,
  type AxiomLogRecord,
} from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function provider(): AxiomProvider {
  const client = new AxiomClient({ token: 't', dataset: 'logs' });
  return new AxiomProvider(client, { dataset: 'logs' });
}

describe('AxiomProvider.queryEvidence', () => {
  it('turns each row into kind:log Evidence with the row fields on the payload', async () => {
    // Recent-error query yields the row; signature query is empty → exactly one evidence.
    stubAplRouter(
      (apl) =>
        apl.includes('summarize')
          ? []
          : [
              {
                _time: '2026-06-22T10:00:00Z',
                level: 'error',
                message: 'checkout failed: timeout',
                service: 'payments',
              },
            ],
      [],
    );
    const ev = await provider().queryEvidence({ collectedAt: '2026-06-22T12:00:00Z' });

    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    expect(e.id).toBe('ev_axiom_0');
    expect(e.kind).toBe('log');
    expect(e.source).toBe('logs'); // folds into the engine's log evidence path
    const p = e.payload as Record<string, unknown>;
    expect(p['source']).toBe('axiom');
    expect(p['dataset']).toBe('logs');
    expect(p['message']).toBe('checkout failed: timeout');
    expect(p['service']).toBe('payments');
    expect(e.title).toContain('checkout failed');
    expect(e.timestamp).toBe('2026-06-22T10:00:00Z');
    expect(e.provenance.collectedAt).toBe('2026-06-22T12:00:00Z');
    // priority/category/subject are NOT set by the provider.
    expect(e.priority).toBeUndefined();
    expect(e.category).toBeUndefined();
    expect(e.subject).toBeUndefined();
  });

  it('degrades to [] (never throws) when the query call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().queryEvidence()).resolves.toEqual([]);
  });

  it('collect() PROPAGATES a transport failure so the engine records a gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().collect()).rejects.toThrow(/-> 403/);
  });
});

/**
 * Stub `fetch` capturing every APL body, returning a per-query response chosen by a
 * matcher over the APL string. Lets a test assert the incident-aware query SHAPE and
 * the merge/fallback behaviour of collect().
 */
function stubAplRouter(
  respond: (apl: string) => Array<Record<string, unknown>>,
  sink: string[],
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const apl = String(JSON.parse(String(init?.body)).apl);
      sink.push(apl);
      const rows = respond(apl);
      const names = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const fields = names.map((name) => ({ name, type: 'string' }));
      const columns = names.map((name) => rows.map((r) => r[name]));
      const tables = rows.length > 0 ? [{ name: '0', fields, columns }] : [];
      return new Response(JSON.stringify({ tables }), { status: 200 });
    }),
  );
}

describe('AxiomProvider.collect (incident-aware error query)', () => {
  it('fires top-error-signature + recent-error queries biased to error levels and hint terms', async () => {
    const apls: string[] = [];
    stubAplRouter(
      (apl) =>
        apl.includes('summarize')
          ? [{ message: 'Klaviyo API request failed', level: 'error', count: 3302 }]
          : [{ _time: '2026-06-22T10:00:00Z', message: 'Klaviyo API request failed', level: 'error' }],
      apls,
    );
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    const recs = await new AxiomProvider(client, { dataset: 'logs' }).collect({
      hintTerms: ['klaviyo', 'failed'],
    });

    // Two incident-aware queries (signatures + recent), no broad fallback.
    expect(apls).toHaveLength(2);
    const sig = apls.find((a) => a.includes('summarize'))!;
    expect(sig).toContain("where tolower(tostring(level)) in ('error', 'warn', 'fatal')");
    expect(sig).toContain('count()');
    expect(sig).toContain('max(_time)');
    expect(sig).toContain('by message, level');
    expect(sig).toContain('search "klaviyo" or "failed"');
    const recent = apls.find((a) => !a.includes('summarize'))!;
    expect(recent).toContain("where tolower(tostring(level)) in");
    expect(recent).toContain('sort by _time desc');

    // High-volume signature leads (surfaced, not crowded out by newest info rows).
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs[0]!.fields['message']).toBe('Klaviyo API request failed');
    expect(recs[0]!.fields['count']).toBe(3302);
  });

  it('broadens to an all-levels fallback query when no error-level row matches', async () => {
    const apls: string[] = [];
    stubAplRouter(
      (apl) =>
        apl.includes('where tolower')
          ? [] // error-biased queries return nothing
          : [{ _time: '2026-06-22T10:00:00Z', message: 'cron heartbeat ok', level: 'info' }],
      apls,
    );
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    const recs = await new AxiomProvider(client, { dataset: 'logs' }).collect({
      hintTerms: ['klaviyo'],
    });

    // 2 incident-aware (empty) + 1 broad fallback.
    expect(apls).toHaveLength(3);
    const broad = apls[2]!;
    expect(broad).not.toContain('where tolower');
    expect(broad).toContain('sort by _time desc');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.fields['message']).toBe('cron heartbeat ok');
  });
});

describe('computeRelevance (hint-term match + recency + level)', () => {
  const fresh: AxiomLogRecord = {
    timestamp: new Date().toISOString(),
    fields: { level: 'error', message: 'BrandService sync failed', service: 'brand' },
  };

  it('boosts when a hint term matches a field', () => {
    const matched = computeRelevance(fresh, ['brand']);
    const unmatched = computeRelevance(fresh, ['payment']);
    expect(matched).toBeGreaterThan(unmatched);
  });

  it('weights recent error rows higher than stale info ones', () => {
    const stale: AxiomLogRecord = {
      timestamp: '2020-01-01T00:00:00Z',
      fields: { level: 'info', message: 'ok' },
    };
    expect(computeRelevance(fresh, [])).toBeGreaterThan(computeRelevance(stale, []));
  });

  it('stays within [0.5, 0.95]', () => {
    const r = computeRelevance(fresh, ['brand', 'service']);
    expect(r).toBeGreaterThanOrEqual(0.5);
    expect(r).toBeLessThanOrEqual(0.95);
  });
});

describe('buildTitle', () => {
  it('renders a self-contained one-liner with level, message, and timestamp', () => {
    const title = buildTitle(
      { timestamp: '2026-06-22T10:00:00Z', fields: { level: 'error', message: 'boom' } },
      'logs',
    );
    expect(title).toContain('Axiom logs');
    expect(title).toContain('[error]');
    expect(title).toContain('boom');
    // A raw example row (no `count`) is NOT a rollup — no "×N" suffix.
    expect(title).not.toContain('×');
  });

  it('folds the COUNT into the title for an aggregated signature row (×N + latest)', () => {
    const title = buildTitle(
      {
        timestamp: '2026-06-22T17:16:00Z',
        fields: { level: 'error', message: 'Klaviyo API request failed', count: 3302 },
      },
      'logs',
    );
    expect(title).toContain('Klaviyo API request failed');
    // Volume folded into the title with a thousands separator…
    expect(title).toContain('×3,302');
    // …and the max(_time) surfaced as the latest occurrence.
    expect(title).toContain('latest');
  });

  it('falls back to a placeholder when no message field exists', () => {
    const title = buildTitle({ fields: { foo: 'bar' } }, 'logs');
    expect(title).toContain('(log event)');
  });
});

describe('AxiomProvider identity + health', () => {
  it('is a logs-kind provider that delegates health to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const p = provider();
    expect(p.id).toBe('axiom');
    expect(p.kind).toBe('logs');
    const h = await p.health();
    expect(h.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// analyzeDurations — INFO-level duration-by-dimension (HOR-434)
// ---------------------------------------------------------------------------

function providerWithRows(rows: AxiomLogRecord[]): AxiomProvider {
  const client = new AxiomClient({ token: 't', dataset: 'logs' });
  client.query = async () => rows;
  return new AxiomProvider(client, { dataset: 'logs' });
}

describe('AxiomProvider.analyzeDurations', () => {
  it('aggregates completion-row durations by a regex-extracted region', async () => {
    const p = providerWithRows([
      { fields: { message: 'Completed MANAGE_SALES:KSA ~2m10s' } },
      { fields: { message: 'Completed MANAGE_SALES:KSA ~2m0s' } },
      { fields: { message: 'Completed MANAGE_SALES:UAE ~19ms' } },
    ]);
    const result = await p.analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(result!.byValue['KSA']!.count).toBe(2);
    expect(result!.byValue['KSA']!.avg).toBe(125_000);
    expect(result!.byValue['UAE']!.avg).toBe(19);
  });

  it('aggregates by structured market + duration_ms fields', async () => {
    const p = providerWithRows([
      { fields: { message: 'done', market: 'KSA', duration_ms: 130_000 } },
      { fields: { message: 'done', market: 'UAE', duration_ms: 19 } },
    ]);
    const result = await p.analyzeDurations({
      dimension: { name: 'market', field: 'market' },
      durationField: 'duration_ms',
    });
    expect(result!.byValue['KSA']!.avg).toBe(130_000);
    expect(result!.byValue['UAE']!.avg).toBe(19);
  });

  it('returns null when nothing usable matches (graceful)', async () => {
    const p = providerWithRows([{ fields: { message: 'heartbeat' } }]);
    const result = await p.analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
      completionText: 'Completed',
    });
    expect(result).toBeNull();
  });

  it('never throws — degrades to null when the query fails', async () => {
    const client = new AxiomClient({ token: 't', dataset: 'logs' });
    client.query = async () => {
      throw new Error('boom');
    };
    const p = new AxiomProvider(client, { dataset: 'logs' });
    const result = await p.analyzeDurations({
      dimension: { name: 'region', pattern: ':([A-Z]{2,})\\b' },
    });
    expect(result).toBeNull();
  });
});
