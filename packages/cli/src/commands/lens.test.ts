/**
 * Tests for `horus lens` (list/show). The fetch+shape core is mocked; these assert the
 * command's rendering contract: valid JSON always (incl. when the queue is unavailable),
 * and correct exit codes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seams = vi.hoisted(() => ({
  listLensReports: vi.fn(),
  getLensReportDetail: vi.fn(),
}));

vi.mock('../lib/cloud/session.js', () => ({ repoRootOrCwd: vi.fn(() => '/repo') }));
vi.mock('../lib/lens/reports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/lens/reports.js')>();
  return {
    ...actual,
    listLensReports: seams.listLensReports,
    getLensReportDetail: seams.getLensReportDetail,
  };
});

import { runLensList, runLensShow } from './lens.js';

let out: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  out = [];
  logSpy = vi
    .spyOn(console, 'log')
    .mockImplementation((s?: unknown) => void out.push(String(s)));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const parseJson = () => JSON.parse(out.join('\n'));

describe('runLensList', () => {
  it('emits reports/count/sites as JSON', async () => {
    seams.listLensReports.mockResolvedValue({
      reports: [
        {
          id: 'rep_1',
          siteId: 's',
          status: 'submitted',
          createdAt: '2026-07-10T00:00:00Z',
          submittedAt: null,
          errorCount: 1,
          hasReplay: false,
          route: '/checkout',
        },
      ],
      sites: 1,
    });
    const code = await runLensList({ json: true });
    expect(code).toBe(0);
    const j = parseJson();
    expect(j.count).toBe(1);
    expect(j.sites).toBe(1);
    expect(j.reports[0].id).toBe('rep_1');
  });

  it('emits valid JSON with a remedy when unavailable (exit 0 under --json)', async () => {
    seams.listLensReports.mockResolvedValue({
      unavailable: 'not-cloud-linked',
      remedy: 'repo not cloud-linked — run `horus cloud link`',
    });
    const code = await runLensList({ json: true });
    expect(code).toBe(0);
    const j = parseJson();
    expect(j.reports).toEqual([]);
    expect(j.notes[0]).toMatch(/cloud link/);
  });

  it('returns 1 in human mode when unavailable', async () => {
    seams.listLensReports.mockResolvedValue({
      unavailable: 'not-logged-in',
      remedy: 'not logged into Horus Cloud — run `horus login`',
    });
    const code = await runLensList({});
    expect(code).toBe(1);
    expect(out.join('\n')).toMatch(/unavailable/);
  });

  it('passes through filter options', async () => {
    seams.listLensReports.mockResolvedValue({ reports: [], sites: 1 });
    await runLensList({
      status: 'open',
      limit: 100,
      since: '2026-07-01',
      site: 'site-x',
      json: true,
    });
    expect(seams.listLensReports).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        status: 'open',
        limit: 100,
        since: '2026-07-01',
        siteId: 'site-x',
      }),
    );
  });
});

describe('runLensShow', () => {
  it('prints the full detail as JSON', async () => {
    seams.getLensReportDetail.mockResolvedValue({
      id: 'rep_1',
      status: 'submitted',
      createdAt: '2026-07-10T00:00:00Z',
      submittedAt: null,
      errorCount: 1,
      hasReplay: false,
      topFrame: null,
      failingRequests: [],
      lensSiteId: 's',
      issueOccurrenceCount: null,
      seed: { file: '/assets/app.js', line: 87, symbol: 'onClick' },
    });
    const code = await runLensShow('rep_1', { json: true });
    expect(code).toBe(0);
    expect(parseJson().seed.file).toBe('/assets/app.js');
  });

  it('returns 1 on notFound', async () => {
    seams.getLensReportDetail.mockResolvedValue({ notFound: true, reportId: 'nope' });
    const code = await runLensShow('nope', { json: true });
    expect(code).toBe(1);
    expect(parseJson().notFound).toBe(true);
  });
});
