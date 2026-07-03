import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SentryClient,
  SentryProvider,
  buildTitle,
  computeRelevance,
  type SentryIssue,
} from './index.js';
import type { HttpRequestOptions } from '../http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Stub `fetch` so the project-issues call returns `issues` and every
 * `/events/latest/` call returns the matching event JSON keyed by issue id.
 */
function stubSentryFetch(issues: unknown[], eventsById: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      const eventMatch = /\/issues\/([^/]+)\/events\/latest\//.exec(u);
      if (eventMatch) {
        const id = eventMatch[1]!;
        return new Response(JSON.stringify(eventsById[id] ?? {}), { status: 200 });
      }
      // Project issues listing.
      return new Response(JSON.stringify(issues), { status: 200 });
    }),
  );
}

const ISSUE_BRAND = {
  id: '100',
  title: "TypeError: Cannot read properties of undefined (reading 'sku')",
  culprit: 'syncBrandFulfillments(brand.service)',
  level: 'error',
  count: '1500',
  userCount: '40',
  lastSeen: new Date().toISOString(),
  firstSeen: '2026-06-01T00:00:00Z',
  permalink: 'https://sentry.io/acme/web/issues/100/',
};

const EVENT_BRAND = {
  entries: [
    {
      type: 'exception',
      data: {
        values: [
          {
            stacktrace: {
              frames: [
                { filename: 'node_modules/express/lib/router.js', function: 'handle', in_app: false, lineNo: 1 },
                { filename: 'src/services/brand.service.ts', function: 'syncBrandFulfillments', in_app: true, lineNo: 142 },
              ],
            },
          },
        ],
      },
    },
  ],
};

function provider(http?: HttpRequestOptions): SentryProvider {
  const client = new SentryClient({
    authToken: 't',
    org: 'acme',
    project: 'web',
    ...(http !== undefined ? { http } : {}),
  });
  return new SentryProvider(client, { org: 'acme', project: 'web' });
}

describe('SentryProvider.queryEvidence', () => {
  it('turns each issue into kind:log Evidence carrying filePath/symbolName/lineStart from the top in-app frame', async () => {
    stubSentryFetch([ISSUE_BRAND], { '100': EVENT_BRAND });
    const ev = await provider().queryEvidence({ collectedAt: '2026-06-22T12:00:00Z' });

    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    expect(e.kind).toBe('log');
    expect(e.source).toBe('logs'); // folds into the engine's error/log evidence path
    const p = e.payload as Record<string, unknown>;
    expect(p['source']).toBe('sentry');
    // Direct code seed — the engine reads these off the payload to seed the investigation.
    expect(p['filePath']).toBe('src/services/brand.service.ts');
    expect(p['symbolName']).toBe('syncBrandFulfillments');
    expect(p['lineStart']).toBe(142);
    expect(p['count']).toBe(1500);
    expect(p['culprit']).toBe('syncBrandFulfillments(brand.service)');
    // Links also carry the file/line for human jump-to-source.
    expect(e.links.file).toBe('src/services/brand.service.ts');
    expect(e.links.line).toBe(142);
    expect(e.title).toContain('TypeError');
    expect(e.timestamp).toBe(ISSUE_BRAND.lastSeen);
  });

  it('degrades to [] (never throws) when the issues call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().queryEvidence()).resolves.toEqual([]);
  });

  it('collect() PROPAGATES a failing issue list so the engine records a gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().collect()).rejects.toThrow(/-> 403/);
  });

  it('still produces evidence when the frame fetch fails (frame omitted, no seed fields)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/events/latest/')) throw new Error('aborted');
        return new Response(JSON.stringify([ISSUE_BRAND]), { status: 200 });
      }),
    );
    // maxRetries: 0 — the always-throwing frame mock would otherwise hit real backoff.
    const ev = await provider({ maxRetries: 0 }).queryEvidence();
    expect(ev).toHaveLength(1);
    const p = ev[0]!.payload as Record<string, unknown>;
    expect(p['filePath']).toBeUndefined();
    expect(p['count']).toBe(1500);
  });
});

describe('computeRelevance (hint-term match + recency + frequency)', () => {
  const fresh: SentryIssue = {
    id: '1',
    title: "TypeError in BrandService",
    culprit: 'syncBrandFulfillments',
    count: 1500,
    userCount: 10,
    lastSeen: new Date().toISOString(),
  };

  it('boosts when a hint term matches the title/culprit/frame', () => {
    const matched = computeRelevance(fresh, { filename: 'src/brand.ts', function: 'syncBrand' }, ['brand']);
    const unmatched = computeRelevance(fresh, { filename: 'src/brand.ts', function: 'syncBrand' }, ['payment']);
    expect(matched).toBeGreaterThan(unmatched);
  });

  it('weights recent + frequent issues higher than stale low-volume ones', () => {
    const stale: SentryIssue = {
      id: '2',
      title: 'TypeError in BrandService',
      count: 3,
      userCount: 0,
      lastSeen: '2020-01-01T00:00:00Z',
    };
    const hot = computeRelevance(fresh, { filename: 'src/brand.ts' }, []);
    const cold = computeRelevance(stale, null, []);
    expect(hot).toBeGreaterThan(cold);
  });

  it('stays within [0.5, 0.95]', () => {
    const r = computeRelevance({ ...fresh, count: 100000 }, { filename: 'src/brand.ts' }, ['brand', 'service']);
    expect(r).toBeGreaterThanOrEqual(0.5);
    expect(r).toBeLessThanOrEqual(0.95);
  });
});

describe('buildTitle', () => {
  it('renders a self-contained one-liner with count, culprit, and the raise-site frame', () => {
    const title = buildTitle(
      {
        id: '1',
        title: 'TypeError: x',
        culprit: 'syncBrandFulfillments',
        count: 1500,
        userCount: 40,
        lastSeen: '2026-06-22T10:00:00Z',
      },
      { filename: 'src/brand.ts', lineno: 142 },
    );
    expect(title).toContain('Sentry TypeError: x');
    expect(title).toContain('1500x');
    expect(title).toContain('40 user(s)');
    expect(title).toContain('syncBrandFulfillments');
    expect(title).toContain('@ src/brand.ts:142');
  });
});

describe('SentryProvider identity + health', () => {
  it('is a logs-kind provider that delegates health to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
    const p = provider();
    expect(p.id).toBe('sentry');
    expect(p.kind).toBe('logs');
    const h = await p.health();
    expect(h.ok).toBe(true);
  });
});
