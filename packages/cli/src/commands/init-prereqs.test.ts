/**
 * Tests for checkPrerequisites — the advisory prereq check that opens
 * `horus init` (the single onboarding command; the old `horus setup` was
 * removed). It prints a status/fix-it line for the source-intelligence backend
 * and returns a status object; it never gates init's exit code, so there is no
 * exit code here. Local persistence is embedded (pglite) — there is no Postgres
 * prerequisite to check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPrerequisites } from './init-prereqs.js';

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

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    PINNED_SOURCE_VERSION: '1.0.1',
    SOURCE_PIN_ENFORCED: true,
  };
});

import { getSourceVersion } from '@horus/connectors';

const mockGetSourceVersion = vi.mocked(getSourceVersion);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSourceVersion.mockResolvedValue('1.0.1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('checkPrerequisites — all green', () => {
  it('reports the backend prerequisite as met (no Postgres tier)', async () => {
    const { lines, status } = await capture((write) => checkPrerequisites({ write }));
    expect(status).toEqual({
      backendPresent: true,
      backendVersionOk: true,
    });
    const out = lines.join('\n');
    expect(out).toContain('source-intelligence backend');
    // No Postgres line — local persistence is embedded.
    expect(out).not.toMatch(/Postgres/i);
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
