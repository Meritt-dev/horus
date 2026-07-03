/**
 * Tests for checkPrerequisites — the advisory prereq checks that open
 * `horus init` (formerly the standalone `horus setup` command, now a hidden
 * deprecation stub). The checks print status/fix-it lines and return a status
 * object; they never gate init's exit code, so there is no exit code here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPrerequisites } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capture(
  fn: (write: (line: string) => void) => Promise<Awaited<ReturnType<typeof checkPrerequisites>>>,
): Promise<{ lines: string[]; status: Awaited<ReturnType<typeof checkPrerequisites>> }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((status) => ({ lines, status }));
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@horus/connectors', () => ({
  getSourceVersion: vi.fn(),
}));

vi.mock('@horus/db', () => ({
  checkDatabase: vi.fn(),
}));

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    PINNED_SOURCE_VERSION: '1.0.1',
    SOURCE_PIN_ENFORCED: true,
  };
});

import { getSourceVersion } from '@horus/connectors';
import { checkDatabase } from '@horus/db';
import { loadConfig } from '@horus/core';

const mockGetSourceVersion = vi.mocked(getSourceVersion);
const mockCheckDatabase = vi.mocked(checkDatabase);
const mockLoadConfig = vi.mocked(loadConfig);

const PASSING_DB = {
  reachable: true,
  schemaReady: true,
  schemaDetail: '8 tables',
} as Awaited<ReturnType<typeof checkDatabase>>;

const MINIMAL_CONFIG = {
  projects: [],
  database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
} as unknown as Awaited<ReturnType<typeof loadConfig>>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSourceVersion.mockResolvedValue('1.0.1');
  mockCheckDatabase.mockResolvedValue(PASSING_DB);
  mockLoadConfig.mockResolvedValue(MINIMAL_CONFIG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('checkPrerequisites — all green', () => {
  it('reports every prerequisite as met', async () => {
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status).toEqual({
      backendPresent: true,
      backendVersionOk: true,
      dbReachable: true,
      schemaReady: true,
    });
    const out = lines.join('\n');
    expect(out).toContain('source-intelligence backend');
    expect(out).toContain('Postgres reachable');
  });
});

describe('checkPrerequisites — backend missing', () => {
  it('reports absence with the install hint (advisory, no throw)', async () => {
    mockGetSourceVersion.mockResolvedValue(null);
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.backendPresent).toBe(false);
    expect(status.backendVersionOk).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('backend not found');
    expect(out).toContain('curl -fsSL https://horus.sh/install.sh | bash');
  });

  it('treats a throwing probe as absent', async () => {
    mockGetSourceVersion.mockRejectedValue(new Error('spawn failed'));
    const { status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.backendPresent).toBe(false);
  });
});

describe('checkPrerequisites — backend version mismatch', () => {
  it('reports the drift with the update hint', async () => {
    mockGetSourceVersion.mockResolvedValue('0.9.0');
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.backendPresent).toBe(true);
    expect(status.backendVersionOk).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('version mismatch');
    expect(out).toContain('horus update');
  });
});

describe('checkPrerequisites — Postgres', () => {
  it('unreachable: prints the docker hint and notes it is not needed for init', async () => {
    mockCheckDatabase.mockResolvedValue({
      reachable: false,
      schemaReady: false,
      schemaDetail: '',
    } as Awaited<ReturnType<typeof checkDatabase>>);
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.dbReachable).toBe(false);
    const out = lines.join('\n');
    expect(out).toContain('Postgres unreachable');
    expect(out).toContain('docker run');
    expect(out).toContain('not for init');
  });

  it('reachable but schema missing: prints the migration hint', async () => {
    mockCheckDatabase.mockResolvedValue({
      reachable: true,
      schemaReady: false,
      schemaDetail: 'no tables',
    } as Awaited<ReturnType<typeof checkDatabase>>);
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.dbReachable).toBe(true);
    expect(status.schemaReady).toBe(false);
    expect(lines.join('\n')).toContain('pnpm db migrate');
  });

  it('falls back to the default DB URL when no config is resolvable', async () => {
    mockLoadConfig.mockRejectedValue(new Error('no config'));
    await capture((write) => checkPrerequisites({ write }));
    expect(mockCheckDatabase).toHaveBeenCalledWith('postgresql://horus:horus@localhost:5433/horus');
  });

  it('treats a throwing checkDatabase as unreachable (advisory, no throw)', async () => {
    mockCheckDatabase.mockRejectedValue(new Error('boom'));
    const { status } = await capture((write) => checkPrerequisites({ write }));
    expect(status.dbReachable).toBe(false);
  });
});
