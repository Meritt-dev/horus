/**
 * `horus search --json` machine contract (dogfood 0.21.1 A1).
 *
 * Two guarantees agents rely on:
 *  - the payload is an OBJECT (`{ results: [...] }`), not a bare top-level array — parity with
 *    every other command's --json, so agents need not special-case search.
 *  - a no-config failure routes through the shared clean path (one-liner on stderr, and a
 *    parseable `{ ok:false }` object on stdout under --json) instead of a raw stack trace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchAcrossRepos: vi.fn(),
}));

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    loadConfig: vi.fn().mockResolvedValue({
      database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
      projects: [],
    }),
  };
});

vi.mock('@horus/connectors', () => ({
  repoProviders: vi.fn(() => []),
}));

vi.mock('@horus/engine', () => ({
  searchAcrossRepos: mocks.searchAcrossRepos,
}));

import { runSearch } from './search.js';
import { loadConfig } from '@horus/core';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe('search --json — object contract', () => {
  it('wraps results as { results: [...] } (an object, not a bare array)', async () => {
    mocks.searchAcrossRepos.mockResolvedValue([
      { repo: 'api', hostUrl: 'http://127.0.0.1:8420', reachable: true, symbols: [] },
    ]);

    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    const code = await runSearch('processOrder', { json: true });

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { results: unknown[] };
    expect(Array.isArray(parsed)).toBe(false);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toHaveLength(1);
  });

  it('routes a no-config failure to a clean { ok:false } JSON object (no stack trace)', async () => {
    vi.mocked(loadConfig).mockRejectedValueOnce(
      new Error('No Horus config found. Run from a configured repo or pass --config <path>.'),
    );

    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(String(a[0])));
    vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(String(a[0])));

    const code = await runSearch('x', { json: true });

    expect(code).toBe(1);
    const parsed = JSON.parse(out.join('\n')) as { ok: boolean; detail: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain('No Horus config found');
    expect(err.join('\n')).toContain('No Horus config found');
  });
});
