/**
 * `horus scores --json` — stdout must be ONE parseable JSON document (agent
 * contract): scores + count + average, an error document on failure, and the
 * human rendering untouched when the flag is absent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seams = vi.hoisted(() => ({
  openDb: vi.fn(),
  listInvestigationsWithReports: vi.fn(),
  sqlEnd: vi.fn(async () => {}),
}));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return {
    ...actual,
    openDb: seams.openDb,
    listInvestigationsWithReports: seams.listInvestigationsWithReports,
  };
});
vi.mock('../lib/db-url.js', () => ({ resolveDbUrl: vi.fn(async () => 'postgres://local') }));
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return {
    ...actual,
    migrateReport: vi.fn((r: unknown) => r),
    scoreInvestigation: vi.fn((r: { score: number }) => ({ score: r.score })),
  };
});

import { runScores } from './score.js';

const ROWS = [
  { id: 'inv-1', title: 'orders stuck', createdAt: new Date('2026-07-01T10:00:00Z'), report: { score: 80 } },
  { id: 'inv-2', title: null, createdAt: new Date('2026-07-02T10:00:00Z'), report: { score: 61 } },
  { id: 'inv-3', title: 'no report row', createdAt: new Date('2026-07-02T11:00:00Z'), report: null },
];

let logs: string[];
let errs: string[];

beforeEach(() => {
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  seams.openDb.mockResolvedValue({ db: {}, sql: { end: seams.sqlEnd } });
  seams.listInvestigationsWithReports.mockResolvedValue(ROWS);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runScores --json (agent contract)', () => {
  it('stdout is one parseable document: scores, count, average', async () => {
    const code = await runScores({ json: true });
    expect(code).toBe(0);
    const out = JSON.parse(logs.join('\n')) as {
      scores: Array<{ id: string; createdAt: string; score: number; title: string | null }>;
      count: number;
      average: number;
    };
    expect(out.count).toBe(2); // the report-less row is not scored
    expect(out.scores[0]).toEqual({
      id: 'inv-1',
      createdAt: '2026-07-01T10:00:00.000Z',
      score: 80,
      title: 'orders stuck',
    });
    expect(out.average).toBe(Math.round((80 + 61) / 2));
  });

  it('an empty store yields a parseable document with average null', async () => {
    seams.listInvestigationsWithReports.mockResolvedValue([]);
    const code = await runScores({ json: true });
    expect(code).toBe(0);
    const out = JSON.parse(logs.join('\n')) as { scores: unknown[]; count: number; average: null };
    expect(out).toEqual({ scores: [], count: 0, average: null });
  });

  it('an unreachable store yields a parseable error document and exit 1', async () => {
    seams.openDb.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const code = await runScores({ json: true });
    expect(code).toBe(1);
    const out = JSON.parse(logs.join('\n')) as { error: string; scores: unknown[] };
    expect(out.error).toContain('ECONNREFUSED');
    expect(out.scores).toEqual([]);
    expect(errs.join('\n')).toContain('ECONNREFUSED');
  });

  it('without --json the human rendering is unchanged (rows + avg line)', async () => {
    const code = await runScores({});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('inv-1');
    expect(out).toContain('avg ' + Math.round((80 + 61) / 2) + '/100 across 2 investigation(s)');
    expect(() => JSON.parse(out)).toThrow();
  });
});
