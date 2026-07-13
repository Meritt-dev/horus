/**
 * Tests for the Lens report work-queue core (HOR-CLI). Mocks the cloud auth/link
 * stores + the `LensCloudClient` network methods, but keeps the REAL `buildSignal`
 * (seed resolution) so the detail path is exercised end-to-end.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LensReportSummary } from '@horus/connectors';

const seams = vi.hoisted(() => ({
  readAuth: vi.fn(),
  readCloudConfig: vi.fn(),
  listSites: vi.fn(),
  listReports: vi.fn(),
  getReport: vi.fn(),
}));

vi.mock('../cloud/auth-store.js', () => ({ readAuth: seams.readAuth }));
vi.mock('../cloud/context-store.js', () => ({ readCloudConfig: seams.readCloudConfig }));
vi.mock('@horus/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/connectors')>();
  class FakeLensCloudClient {
    constructor(_opts: unknown) {}
    listSites = seams.listSites;
    listReports = seams.listReports;
    getReport = seams.getReport;
  }
  return { ...actual, LensCloudClient: FakeLensCloudClient };
});

import {
  listLensReports,
  getLensReportDetail,
  resolveLensClient,
  isLensUnavailable,
  isLensNotFound,
} from './reports.js';

const AUTH = {
  apiBaseUrl: 'https://api.horus.sh',
  token: 't0ken',
  account: { userId: 'u', email: 'e' },
};
const LINKED = { context: 'cloud' as const, workspace: { id: 'ws-1', slug: 'maison' } };

function summary(over: Partial<LensReportSummary>): LensReportSummary {
  return {
    id: 'rep_1',
    lensSiteId: 'site-a',
    status: 'submitted',
    createdAt: '2026-07-10T00:00:00.000Z',
    submittedAt: '2026-07-10T00:00:00.000Z',
    externalIssue: null,
    lensIssueId: null,
    issueOccurrenceCount: null,
    errorCount: 0,
    hasReplay: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  seams.readAuth.mockReturnValue(AUTH);
  seams.readCloudConfig.mockReturnValue(LINKED);
  seams.listSites.mockResolvedValue([{ id: 'site-a', name: 'A' }]);
  seams.listReports.mockResolvedValue([]);
});

describe('resolveLensClient', () => {
  it('is unavailable (not-logged-in) with no auth', () => {
    seams.readAuth.mockReturnValue(null);
    const r = resolveLensClient('/repo');
    expect(isLensUnavailable(r) && r.unavailable).toBe('not-logged-in');
  });

  it('is unavailable (not-cloud-linked) when the repo has no workspace', () => {
    seams.readCloudConfig.mockReturnValue({ context: 'local' });
    const r = resolveLensClient('/repo');
    expect(isLensUnavailable(r) && r.unavailable).toBe('not-cloud-linked');
  });

  it('builds a client when logged in + linked', () => {
    const r = resolveLensClient('/repo');
    expect(isLensUnavailable(r)).toBe(false);
  });
});

describe('listLensReports', () => {
  it('propagates the unavailable reason', async () => {
    seams.readAuth.mockReturnValue(null);
    const r = await listLensReports('/repo');
    expect(isLensUnavailable(r) && r.unavailable).toBe('not-logged-in');
  });

  it('defaults the status filter to submitted', async () => {
    await listLensReports('/repo');
    expect(seams.listReports).toHaveBeenCalledWith(
      'site-a',
      expect.objectContaining({ status: 'submitted' }),
    );
  });

  it('drops the status filter under --all', async () => {
    await listLensReports('/repo', { all: true });
    const opts = seams.listReports.mock.calls[0]![1];
    expect(opts.status).toBeUndefined();
  });

  it('maps since → the API from bound', async () => {
    await listLensReports('/repo', { since: '2026-07-01T00:00:00.000Z' });
    expect(seams.listReports).toHaveBeenCalledWith(
      'site-a',
      expect.objectContaining({ from: '2026-07-01T00:00:00.000Z' }),
    );
  });

  it('merges reports across sites, newest first, and derives the route', async () => {
    seams.listSites.mockResolvedValue([
      { id: 'site-a', name: 'A' },
      { id: 'site-b', name: 'B' },
    ]);
    seams.listReports.mockImplementation(async (siteId: string) =>
      siteId === 'site-a'
        ? [
            summary({
              id: 'a1',
              lensSiteId: 'site-a',
              createdAt: '2026-07-10T00:00:00.000Z',
              url: 'https://shop.example/product/x',
            }),
          ]
        : [
            summary({
              id: 'b1',
              lensSiteId: 'site-b',
              createdAt: '2026-07-12T00:00:00.000Z',
              url: 'https://shop.example/cart',
            }),
          ],
    );
    const r = await listLensReports('/repo');
    if (isLensUnavailable(r)) throw new Error('unexpected');
    expect(r.sites).toBe(2);
    expect(r.reports.map((x) => x.id)).toEqual(['b1', 'a1']); // newest first
    expect(r.reports[0]!.route).toBe('/cart');
    expect(r.reports[1]!.route).toBe('/product/x');
  });

  it('applies the merged limit and notes truncation', async () => {
    seams.listReports.mockResolvedValue([
      summary({ id: 'r1', createdAt: '2026-07-10T00:00:03.000Z' }),
      summary({ id: 'r2', createdAt: '2026-07-10T00:00:02.000Z' }),
      summary({ id: 'r3', createdAt: '2026-07-10T00:00:01.000Z' }),
    ]);
    const r = await listLensReports('/repo', { limit: 2 });
    if (isLensUnavailable(r)) throw new Error('unexpected');
    expect(r.reports.map((x) => x.id)).toEqual(['r1', 'r2']);
    expect(r.notes?.[0]).toMatch(/showing 2 of 3/);
  });

  it('hints that more may exist when the result exactly fills the cap', async () => {
    seams.listReports.mockResolvedValue([
      summary({ id: 'r1', createdAt: '2026-07-10T00:00:02.000Z' }),
      summary({ id: 'r2', createdAt: '2026-07-10T00:00:01.000Z' }),
    ]);
    const r = await listLensReports('/repo', { limit: 2 });
    if (isLensUnavailable(r)) throw new Error('unexpected');
    expect(r.reports).toHaveLength(2);
    expect(r.notes?.[0]).toMatch(/first 2 reports/);
  });
});

describe('getLensReportDetail', () => {
  const STACK =
    'Error: boom\n    at handleClick (https://shop.example/assets/app.js:87:12)';

  beforeEach(() => {
    seams.listReports.mockResolvedValue([
      summary({ id: 'rep_seed', errorCount: 1, url: 'https://shop.example/checkout' }),
    ]);
    seams.getReport.mockResolvedValue({
      id: 'rep_seed',
      status: 'submitted',
      createdAt: '2026-07-10T00:00:00.000Z',
      submittedAt: '2026-07-10T00:00:00.000Z',
      metadata: {
        comment: 'pay button vanished',
        env: { url: 'https://shop.example/checkout', route: '/checkout' },
        app: { gitSha: 'abc123', release: 'shop@1.2.3' },
        errors: [{ message: 'boom', stack: STACK, source: '', timestamp: 0 }],
        networkTail: [],
      },
    });
  });

  it('resolves the top stack frame into a code seed', async () => {
    const r = await getLensReportDetail('/repo', 'rep_seed');
    if (isLensUnavailable(r) || isLensNotFound(r)) throw new Error('unexpected');
    expect(r.seed).toEqual({ file: '/assets/app.js', line: 87, symbol: 'handleClick' });
    expect(r.gitSha).toBe('abc123');
    expect(r.route).toBe('/checkout');
    expect(r.comment).toBe('pay button vanished');
  });

  it('returns notFound when the id is in no site', async () => {
    const r = await getLensReportDetail('/repo', 'nope');
    expect(isLensNotFound(r) && r.reportId).toBe('nope');
  });

  it('propagates the unavailable reason', async () => {
    seams.readAuth.mockReturnValue(null);
    const r = await getLensReportDetail('/repo', 'rep_seed');
    expect(isLensUnavailable(r) && r.unavailable).toBe('not-logged-in');
  });
});
