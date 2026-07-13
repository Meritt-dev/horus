/**
 * Tests for the MCP Lens work-queue tools. The shared fetch+shape core is mocked;
 * these assert the ToolResult contract (ok/summary/data) and graceful degradation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const seams = vi.hoisted(() => ({
  listLensReports: vi.fn(),
  getLensReportDetail: vi.fn(),
}));

vi.mock('../../lib/lens/reports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/lens/reports.js')>();
  return {
    ...actual,
    listLensReports: seams.listLensReports,
    getLensReportDetail: seams.getLensReportDetail,
  };
});

import { CLOUD_TOOLS } from './cloud-tools.js';

const tool = (name: string) => {
  const t = CLOUD_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

beforeEach(() => vi.clearAllMocks());

describe('list_lens_reports', () => {
  it('returns ok with the backlog', async () => {
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
        },
      ],
      sites: 1,
    });
    const res = await tool('list_lens_reports').handler({}, '/repo');
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/1 client-reported issue/);
    expect((res.data as { reports: unknown[] }).reports).toHaveLength(1);
  });

  it('degrades to ok:false with a remedy when unavailable', async () => {
    seams.listLensReports.mockResolvedValue({
      unavailable: 'not-cloud-linked',
      remedy: 'repo not cloud-linked — run `horus cloud link`',
    });
    const res = await tool('list_lens_reports').handler({}, '/repo');
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/cloud link/);
  });

  it('forwards filter args', async () => {
    seams.listLensReports.mockResolvedValue({ reports: [], sites: 1 });
    await tool('list_lens_reports').handler(
      { status: 'open', limit: 10, all: true, since: '2026-07-01' },
      '/repo',
    );
    expect(seams.listLensReports).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        status: 'open',
        limit: 10,
        all: true,
        since: '2026-07-01',
      }),
    );
  });
});

describe('get_lens_report', () => {
  it('requires reportId', async () => {
    const res = await tool('get_lens_report').handler({}, '/repo');
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/required/);
  });

  it('summarizes the seed on success', async () => {
    seams.getLensReportDetail.mockResolvedValue({
      id: 'rep_1',
      status: 'submitted',
      createdAt: '2026-07-10T00:00:00Z',
      seed: { file: '/assets/app.js', line: 87, symbol: 'onClick' },
    });
    const res = await tool('get_lens_report').handler({ reportId: 'rep_1' }, '/repo');
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/\/assets\/app\.js:87/);
  });

  it('ok:false on notFound', async () => {
    seams.getLensReportDetail.mockResolvedValue({ notFound: true, reportId: 'nope' });
    const res = await tool('get_lens_report').handler({ reportId: 'nope' }, '/repo');
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/No Lens report/);
  });
});
