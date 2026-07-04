/**
 * Tests for `horus db import` — the one-time cutover from a legacy Postgres into the
 * embedded database. Fully offline: openDb + importFromPostgres are mocked, so we pin the
 * --from/$DATABASE_URL resolution, the summary output, the row-count total, and the
 * non-zero exit on a connection failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const seams = vi.hoisted(() => {
  class FakeCloudError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CloudDatabaseUrlError';
    }
  }
  return {
    openDb: vi.fn(async () => ({ db: {}, sql: { end: vi.fn(async () => {}) } })),
    importFromPostgres: vi.fn(),
    localDbPath: vi.fn(() => '/home/u/.horus/horus.db'),
    FakeCloudError,
  };
});

vi.mock('@horus/db', () => ({
  openDb: seams.openDb,
  importFromPostgres: seams.importFromPostgres,
  localDbPath: seams.localDbPath,
  CloudDatabaseUrlError: seams.FakeCloudError,
}));

import { runDbImport } from './db.js';

const savedDbUrl = process.env['DATABASE_URL'];
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['DATABASE_URL'];
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((l?: unknown) => void logs.push(String(l)));
  errSpy = vi.spyOn(console, 'error').mockImplementation((l?: unknown) => void errs.push(String(l)));
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = savedDbUrl;
});

describe('runDbImport', () => {
  it('imports from --from, prints per-table counts + total, and exits 0', async () => {
    seams.importFromPostgres.mockResolvedValue({ investigations: 3, outcome_label: 2, evidence: 0 });
    const code = await runDbImport({ from: 'postgresql://horus@localhost:5433/horus' });
    expect(code).toBe(0);
    expect(seams.importFromPostgres).toHaveBeenCalledWith(
      'postgresql://horus@localhost:5433/horus',
      expect.anything(),
    );
    const out = logs.join('\n');
    expect(out).toContain('investigations');
    expect(out).toContain('Imported 5 row(s)');
  });

  it('defaults --from to $DATABASE_URL', async () => {
    process.env['DATABASE_URL'] = 'postgresql://horus@localhost:5433/horus';
    seams.importFromPostgres.mockResolvedValue({ investigations: 1 });
    const code = await runDbImport({});
    expect(code).toBe(0);
    expect(seams.importFromPostgres).toHaveBeenCalledWith(
      'postgresql://horus@localhost:5433/horus',
      expect.anything(),
    );
  });

  it('masks the password in the printed source URL', async () => {
    seams.importFromPostgres.mockResolvedValue({ investigations: 0 });
    await runDbImport({ from: 'postgresql://horus:supersecret@localhost:5433/horus' });
    const out = logs.join('\n');
    expect(out).not.toContain('supersecret');
    expect(out).toContain('***');
  });

  it('exits 1 when no --from and no DATABASE_URL', async () => {
    const code = await runDbImport({});
    expect(code).toBe(1);
    expect(seams.importFromPostgres).not.toHaveBeenCalled();
    expect(errs.join('\n')).toContain('No source database');
  });

  it('exits 1 on a connection/read failure', async () => {
    seams.importFromPostgres.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const code = await runDbImport({ from: 'postgresql://horus@nope:5433/horus' });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('Import failed');
  });

  it('exits 1 and surfaces the guard message when --from points at the Cloud database', async () => {
    seams.importFromPostgres.mockRejectedValue(new seams.FakeCloudError('Refusing to connect: Cloud'));
    const code = await runDbImport({ from: 'postgres://u:p@localhost:5434/horus_cloud' });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('Refusing to connect');
  });
});
