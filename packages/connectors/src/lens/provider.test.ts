import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LensCloudClient,
  LensProvider,
  parseStackTopFrame,
  buildTitle,
  computeRelevance,
  inWindow,
  type LensReportSignal,
} from './index.js';
import type { HttpRequestOptions } from '../http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── Client-side window filter ───────────────────────────────────────────── */

// A cloud build that predates the from/to params silently ignores them, so the
// provider must re-apply the window itself — these pin the correctness guarantee.
describe('inWindow (client-side from/to re-filter)', () => {
  it('keeps a report inside the window and drops one outside it', () => {
    expect(inWindow('2026-07-08T12:00:00Z', '2026-07-08T00:00:00Z', '2026-07-09T00:00:00Z')).toBe(true);
    expect(inWindow('2026-07-01T12:00:00Z', '2026-07-08T00:00:00Z', '2026-07-09T00:00:00Z')).toBe(false);
    expect(inWindow('2026-07-10T12:00:00Z', '2026-07-08T00:00:00Z', '2026-07-09T00:00:00Z')).toBe(false);
  });

  it('bounds are inclusive and missing bounds are unbounded', () => {
    expect(inWindow('2026-07-08T00:00:00Z', '2026-07-08T00:00:00Z', '2026-07-08T00:00:00Z')).toBe(true);
    expect(inWindow('2000-01-01T00:00:00Z', undefined, '2026-07-09T00:00:00Z')).toBe(true);
    expect(inWindow('2099-01-01T00:00:00Z', '2026-07-08T00:00:00Z', undefined)).toBe(true);
  });

  it('never drops a report over a malformed timestamp or bound', () => {
    expect(inWindow('not-a-date', '2026-07-08T00:00:00Z', '2026-07-09T00:00:00Z')).toBe(true);
    expect(inWindow('2026-07-01T00:00:00Z', 'garbage', 'garbage')).toBe(true);
  });
});

/* ── Stack parsing ───────────────────────────────────────────────────────── */

describe('parseStackTopFrame (browser stack formats)', () => {
  it('parses a V8 named frame, stripping the URL origin to the pathname', () => {
    const stack = [
      'TypeError: undefined is not an object',
      '    at checkout (https://app.example.com/assets/checkout.js:120:15)',
      '    at onClick (https://app.example.com/assets/app.js:5:1)',
    ].join('\n');
    const f = parseStackTopFrame(stack);
    expect(f).toEqual({ filename: '/assets/checkout.js', function: 'checkout', lineno: 120 });
  });

  it('parses a V8 anonymous frame (no function name)', () => {
    const f = parseStackTopFrame('    at https://app.example.com/assets/main.js:9:2');
    expect(f).toEqual({ filename: '/assets/main.js', lineno: 9 });
  });

  it('parses a Firefox/Safari `fn@url` frame', () => {
    const stack = 'submitOrder@https://app.example.com/build/order.js:42:8\n@https://app.example.com/build/x.js:1:1';
    const f = parseStackTopFrame(stack);
    expect(f).toEqual({ filename: '/build/order.js', function: 'submitOrder', lineno: 42 });
  });

  it('skips node_modules frames and takes the first app frame', () => {
    const stack = [
      '    at dispatch (https://app.example.com/node_modules/react-dom/index.js:200:1)',
      '    at handleSubmit (https://app.example.com/src/Form.tsx:33:9)',
    ].join('\n');
    expect(parseStackTopFrame(stack)).toEqual({
      filename: '/src/Form.tsx',
      function: 'handleSubmit',
      lineno: 33,
    });
  });

  it('skips chrome-extension:// frames', () => {
    const stack = [
      '    at inject (chrome-extension://abcd/content.js:1:1)',
      '    at realCode (https://app.example.com/src/a.js:7:2)',
    ].join('\n');
    expect(parseStackTopFrame(stack)!.filename).toBe('/src/a.js');
  });

  it('returns null when no parseable app frame exists', () => {
    expect(parseStackTopFrame('TypeError: boom\n    at <anonymous>')).toBeNull();
    expect(parseStackTopFrame('')).toBeNull();
  });

  it('handles host:port URLs (colon in the origin) without mis-splitting the line number', () => {
    const f = parseStackTopFrame('    at run (http://localhost:5173/src/index.ts:88:4)');
    expect(f).toEqual({ filename: '/src/index.ts', function: 'run', lineno: 88 });
  });
});

/* ── Provider fetch stubbing ─────────────────────────────────────────────── */

const SITE = { id: 'site-1', name: 'Web' };

function stubLensFetch(reports: unknown[], reportsById: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      const detail = /\/reports\/([^/?]+)$/.exec(u);
      if (detail) {
        return new Response(JSON.stringify(reportsById[detail[1]!] ?? {}), { status: 200 });
      }
      if (u.includes('/reports?') || /\/reports$/.test(u)) {
        return new Response(JSON.stringify({ reports, nextCursor: null }), { status: 200 });
      }
      // sites
      return new Response(JSON.stringify({ sites: [SITE] }), { status: 200 });
    }),
  );
}

function provider(http?: HttpRequestOptions): LensProvider {
  const client = new LensCloudClient({
    apiBaseUrl: 'https://cloud.example.com',
    token: 't',
    workspaceId: 'ws-1',
    ...(http !== undefined ? { http } : {}),
  });
  return new LensProvider(client);
}

const SUMMARY = {
  id: 'r1',
  lensSiteId: 'site-1',
  status: 'submitted',
  createdAt: new Date().toISOString(),
  submittedAt: new Date().toISOString(),
  errorCount: 1,
  comment: 'Checkout button does nothing',
  url: 'https://app.example.com/checkout',
  issueOccurrenceCount: 5,
  hasReplay: true,
};

const FULL_REPORT = {
  id: 'r1',
  status: 'submitted',
  createdAt: SUMMARY.createdAt,
  submittedAt: SUMMARY.submittedAt,
  metadata: {
    comment: 'Checkout button does nothing',
    env: { url: 'https://app.example.com/checkout', route: '/checkout' },
    app: { release: '1.4.0', gitSha: 'abc123', featureFlags: { newCheckout: true } },
    target: { reactComponents: ['CheckoutButton', 'CartSummary'] },
    errors: [
      {
        message: 'TypeError: cannot read submit of undefined',
        source: 'window.onerror',
        timestamp: 1,
        stack: '    at submit (https://app.example.com/src/checkout.ts:88:3)',
      },
    ],
    networkTail: [
      { method: 'POST', url: '/api/checkout', status: 500, ok: false, durationMs: 12, requestType: 'fetch', startedAt: 1 },
      { method: 'GET', url: '/api/ok', status: 200, ok: true, durationMs: 3, requestType: 'fetch', startedAt: 2 },
    ],
    sdk: { name: 'lens', version: '1.0.0' },
    trigger: 'user',
  },
};

describe('LensProvider.queryEvidence', () => {
  it('turns each report into kind:log Evidence carrying the seed fields + failing requests', async () => {
    stubLensFetch([SUMMARY], { r1: FULL_REPORT });
    const ev = await provider().queryEvidence({ collectedAt: '2026-06-22T12:00:00Z' });

    expect(ev).toHaveLength(1);
    const e = ev[0]!;
    expect(e.kind).toBe('log');
    expect(e.source).toBe('logs');
    expect(e.id).toBe('ev_lens_0');
    const p = e.payload as Record<string, unknown>;
    expect(p['source']).toBe('lens');
    expect(p['reportId']).toBe('r1');
    // Direct code seed from the top parseable frame.
    expect(p['filePath']).toBe('/src/checkout.ts');
    expect(p['symbolName']).toBe('submit');
    expect(p['lineStart']).toBe(88);
    expect(p['route']).toBe('/checkout');
    expect(p['release']).toBe('1.4.0');
    expect(p['trigger']).toBe('user');
    expect(p['reactComponents']).toEqual(['CheckoutButton', 'CartSummary']);
    // Only the failing (ok===false / >=500) request survives.
    expect(p['failingRequests']).toEqual([{ method: 'POST', url: '/api/checkout', status: 500 }]);
    // Links carry file/line for jump-to-source.
    expect(e.links.file).toBe('/src/checkout.ts');
    expect(e.links.line).toBe(88);
    expect(e.title).toContain('Lens report:');
    expect(e.timestamp).toBe(SUMMARY.submittedAt);
  });

  it('redacts secrets in the comment + top error message', async () => {
    const dirty = {
      ...FULL_REPORT,
      metadata: {
        ...FULL_REPORT.metadata,
        comment: 'login fails with password=hunter2 in the URL',
        errors: [
          {
            message: 'Error token=Bearer sk_live_abcdef sent to server',
            source: 'console.error',
            timestamp: 1,
            stack: '    at auth (https://app.example.com/src/auth.ts:10:1)',
          },
        ],
      },
    };
    stubLensFetch([{ ...SUMMARY, comment: dirty.metadata.comment }], { r1: dirty });
    const ev = await provider().queryEvidence();
    const p = ev[0]!.payload as Record<string, unknown>;
    expect(String(p['comment'])).toContain('[REDACTED]');
    expect(String(p['comment'])).not.toContain('hunter2');
    expect(String(p['topError'])).toContain('[REDACTED]');
    expect(ev[0]!.title).not.toContain('hunter2');
  });

  it('never leaks the reporter identity (metadata.app.user) or console bodies', async () => {
    const withUser = {
      ...FULL_REPORT,
      metadata: {
        ...FULL_REPORT.metadata,
        app: { ...FULL_REPORT.metadata.app, user: { email: 'jane@corp.com', name: 'Jane' } },
        consoleTail: [{ level: 'log', args: ['secret console body'], timestamp: 1 }],
      },
    };
    stubLensFetch([SUMMARY], { r1: withUser });
    const ev = await provider().queryEvidence();
    const blob = JSON.stringify(ev[0]);
    expect(blob).not.toContain('jane@corp.com');
    expect(blob).not.toContain('Jane');
    expect(blob).not.toContain('secret console body');
  });

  it('still produces evidence from the summary when getReport fails (no seed fields)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (/\/reports\/[^/?]+$/.test(u)) throw new Error('aborted');
        if (u.includes('/reports?')) return new Response(JSON.stringify({ reports: [SUMMARY] }), { status: 200 });
        return new Response(JSON.stringify({ sites: [SITE] }), { status: 200 });
      }),
    );
    const ev = await provider({ maxRetries: 0 }).queryEvidence();
    expect(ev).toHaveLength(1);
    const p = ev[0]!.payload as Record<string, unknown>;
    expect(p['filePath']).toBeUndefined();
    expect(p['errorCount']).toBe(1);
  });

  it('degrades to [] (never throws) when the sites/reports call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().queryEvidence()).resolves.toEqual([]);
  });

  it('collect() PROPAGATES a failing sites list so the engine records a gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(provider().collect()).rejects.toThrow(/-> 403/);
  });
});

/* ── Relevance + title (pure) ────────────────────────────────────────────── */

function sig(overrides: Partial<LensReportSignal> = {}): LensReportSignal {
  return {
    id: 'r1',
    lensSiteId: 'site-1',
    status: 'submitted',
    createdAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    issueOccurrenceCount: 5,
    errorCount: 1,
    hasReplay: false,
    comment: 'checkout button broken',
    route: '/checkout',
    topErrorMessage: 'TypeError in checkout',
    topFrame: { filename: '/src/checkout.ts', function: 'submit', lineno: 88 },
    failingRequests: [],
    ...overrides,
  };
}

describe('computeRelevance (hint match beats non-match)', () => {
  it('boosts when a hint term matches the comment/route/error/frame', () => {
    const matched = computeRelevance(sig(), ['checkout']);
    const unmatched = computeRelevance(sig(), ['payment']);
    expect(matched).toBeGreaterThan(unmatched);
  });

  it('stays within [0.5, 0.95]', () => {
    const r = computeRelevance(sig(), ['checkout', 'submit']);
    expect(r).toBeGreaterThanOrEqual(0.5);
    expect(r).toBeLessThanOrEqual(0.95);
  });
});

describe('buildTitle', () => {
  it('renders a self-contained one-liner with the comment, error count, and location', () => {
    const title = buildTitle(sig({ createdAt: '2026-06-22T10:00:00Z' }));
    expect(title).toContain('Lens report:');
    expect(title).toContain('checkout button broken');
    expect(title).toContain('1 error(s)');
    expect(title).toContain('/checkout');
  });

  it('falls back to (no comment) when the report has no comment', () => {
    const title = buildTitle(sig({ comment: undefined }));
    expect(title).toContain('(no comment)');
  });
});

describe('LensProvider identity + health', () => {
  it('is a logs-kind provider that delegates health to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sites: [SITE] }), { status: 200 })));
    const p = provider();
    expect(p.id).toBe('lens');
    expect(p.kind).toBe('logs');
    const h = await p.health();
    expect(h.ok).toBe(true);
  });
});
