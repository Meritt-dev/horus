/**
 * Unit tests for the version-pin guard that keeps a drifted `horus-source` backend from
 * analyzing or hosting a repo. A mismatch re-corrupts the Kùzu graph identically on every
 * rebuild, so we must refuse to launch it rather than fail silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PINNED_SOURCE_VERSION } from '@horus/core';

// The pin is HORUS_VERSION, which is 'dev' (unenforced) in unbundled test runs —
// enforce it here so the guard's throw paths are actually exercised. The dev-mode
// no-op is covered separately in lifecycle.devpin.test.ts.
vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return { ...actual, PINNED_SOURCE_VERSION: '1.2.3', SOURCE_PIN_ENFORCED: true };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import {
  assertSourceVersionPinned,
  SourceVersionMismatchError,
  getSourceVersion,
  reconcileSpawnedHost,
  readSpawnedHost,
  waitForOwnHost,
  analyzeRepo,
  indexNeedsReanalyze,
} from './lifecycle.js';

describe('analyzeRepo — surfaces the real failure (HOR-381)', () => {
  // resolveSourceBin runs `--version` (succeeds → bin found); the `analyze` call fails.
  function stubAnalyzeFailure(makeErr: () => Error): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: ExecFileCb) => {
        if (Array.isArray(args) && (args as string[]).includes('analyze')) {
          cb(makeErr(), undefined);
        } else {
          cb(null, { stdout: 'horus-source 1.5.4', stderr: '' });
        }
      },
    );
  }

  it('reports a timeout instead of a bare command-failed', async () => {
    stubAnalyzeFailure(() => {
      const e = new Error('Command failed: horus-source analyze .') as Error & Record<string, unknown>;
      e.killed = true;
      e.signal = 'SIGTERM';
      e.stderr = 'embedding 10000 symbols…';
      return e;
    });
    await expect(analyzeRepo('/repo')).rejects.toThrow(/timed out after 900s/);
  });

  it('surfaces horus-source stderr on a non-timeout failure', async () => {
    stubAnalyzeFailure(() => {
      const e = new Error('Command failed') as Error & Record<string, unknown>;
      e.stderr = 'ModuleNotFoundError: no module named tree_sitter';
      return e;
    });
    await expect(analyzeRepo('/repo')).rejects.toThrow(/ModuleNotFoundError: no module named tree_sitter/);
  });
});

const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Stub `horus-source --version` to print `stdout`, or fail (binary not found) when null. */
function stubVersion(stdout: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: ExecFileCb) => {
      if (stdout === null) cb(new Error('command not found'), undefined);
      else cb(null, { stdout, stderr: '' });
    },
  );
}

beforeEach(() => vi.clearAllMocks());

// A semver guaranteed to differ from whatever the pin currently is (and to survive the
// \d+.\d+.\d+ parse in getSourceVersion), so this suite stays correct across pin bumps.
const DRIFTED = '99.99.99';

describe('getSourceVersion', () => {
  it('parses the semver out of the --version output', async () => {
    stubVersion('horus-source 1.4.0\n');
    expect(await getSourceVersion()).toBe('1.4.0');
  });

  it('returns null when the binary is not on PATH', async () => {
    stubVersion(null);
    expect(await getSourceVersion()).toBeNull();
  });
});

describe('assertSourceVersionPinned', () => {
  it('throws SourceVersionMismatchError when the installed version drifts from the pin', async () => {
    stubVersion(`horus-source ${DRIFTED}\n`);
    await expect(assertSourceVersionPinned()).rejects.toBeInstanceOf(SourceVersionMismatchError);
    await expect(assertSourceVersionPinned()).rejects.toThrow(DRIFTED);
    await expect(assertSourceVersionPinned()).rejects.toThrow(PINNED_SOURCE_VERSION);
  });

  it('blocks with a recovery path that recommends `horus update` (and the pinned install as fallback)', async () => {
    stubVersion(`horus-source ${DRIFTED}\n`);
    let msg = '';
    try {
      await assertSourceVersionPinned();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('horus update');
    // The backend ships inside the bundle — the remediation is `horus update`,
    // never a PyPI install.
    expect(msg).toContain('bundled');
    expect(msg).not.toContain('uv tool install');
  });

  it('resolves when the installed version matches the pin', async () => {
    stubVersion(`horus-source ${PINNED_SOURCE_VERSION}\n`);
    await expect(assertSourceVersionPinned()).resolves.toBeUndefined();
  });

  it('allows an unreadable version through (treated as unknown, like `horus status`)', async () => {
    stubVersion(null);
    await expect(assertSourceVersionPinned()).resolves.toBeUndefined();
  });
});

describe('reconcileSpawnedHost', () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'horus-recon-'));
    mkdirSync(join(root, '.horus', 'source'), { recursive: true });
    return root;
  }
  function writeSpawned(root: string, pid: number, port = 8420): void {
    writeFileSync(
      join(root, '.horus', 'spawned-host.json'),
      JSON.stringify({ pid, port, root, startedAt: new Date(Date.now() - 1000).toISOString() }),
    );
  }
  function writeHostJson(root: string, pid: number, port = 8420): void {
    writeFileSync(
      join(root, '.horus', 'source', 'host.json'),
      JSON.stringify({ pid, port, repo_path: root, host_url: `http://127.0.0.1:${port}` }),
    );
  }

  it('rewrites the ownership pid to the backend server pid (preserving port/root)', () => {
    const root = makeRoot();
    try {
      writeSpawned(root, 1111);
      writeHostJson(root, 2222);
      reconcileSpawnedHost(root, 8420);
      const rec = readSpawnedHost(root)!;
      expect(rec.pid).toBe(2222);
      expect(rec.port).toBe(8420);
      expect(rec.root).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adopts the backend ACTUAL port when the host fell back from the requested one (HOR-409)', () => {
    const root = makeRoot();
    try {
      // Requested 8420, but the host fell back to 8421 (recorded by the backend in host.json).
      writeSpawned(root, 1111, 8420);
      writeHostJson(root, 2222, 8421);
      reconcileSpawnedHost(root, 8420);
      const rec = readSpawnedHost(root)!;
      // The ownership record must now reflect the ACTUAL pid + port, so a scoped `horus stop`
      // recognizes the host it really spawned instead of refusing on a port mismatch.
      expect(rec.pid).toBe(2222);
      expect(rec.port).toBe(8421);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the passed actualPort when the backend record is absent', () => {
    const root = makeRoot();
    try {
      writeSpawned(root, 1111, 8420);
      reconcileSpawnedHost(root, 8421); // no host.json — keep pid, record the resolved port
      const rec = readSpawnedHost(root)!;
      expect(rec.pid).toBe(1111);
      expect(rec.port).toBe(8421);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when there is no ownership record to refine', () => {
    const root = makeRoot();
    try {
      writeHostJson(root, 2222);
      reconcileSpawnedHost(root, 8420); // must not throw, must not create a record
      expect(readSpawnedHost(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('waitForOwnHost — never grounds on a foreign repo (HOR-409)', () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'horus-own-'));
    mkdirSync(join(root, '.horus', 'source'), { recursive: true });
    return root;
  }
  function writeHostUrl(root: string, hostUrl: string): void {
    writeFileSync(
      join(root, '.horus', 'source', 'host.json'),
      JSON.stringify({ pid: 4242, port: 0, repo_path: root, host_url: hostUrl }),
    );
  }
  /** Route fetch by URL: `serves[hostBase]` is the repoPath that base reports, or null. */
  function stubFetch(serves: Record<string, string | null>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        const base = url.replace(/\/api\/(health|host)$/, '');
        const known = base in serves;
        if (url.endsWith('/api/health')) {
          return { ok: known } as unknown as Response;
        }
        const repoPath = serves[base];
        return {
          ok: known,
          json: async () => (repoPath ? { repoPath } : {}),
        } as unknown as Response;
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('returns the requested URL when it is healthy and serves THIS repo', async () => {
    const root = makeRoot();
    try {
      const requested = 'http://127.0.0.1:8420';
      stubFetch({ [requested]: root });
      expect(await waitForOwnHost(root, requested, 2000)).toBe(requested);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves to the ACTUAL fallback port, never the requested foreign one', async () => {
    const root = makeRoot();
    try {
      const requested = 'http://127.0.0.1:8420'; // a DIFFERENT repo now occupies this
      const fallback = 'http://127.0.0.1:8421'; // our host actually bound here
      writeHostUrl(root, fallback); // backend recorded the actual bound URL
      stubFetch({ [requested]: '/some/other/repo', [fallback]: root });
      const resolved = await waitForOwnHost(root, requested, 2000);
      expect(resolved).toBe(fallback);
      expect(resolved).not.toBe(requested);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null (never the foreign URL) when only a foreign host answers', async () => {
    const root = makeRoot();
    try {
      const requested = 'http://127.0.0.1:8420';
      // No host.json recorded; the requested port is a foreign repo's host.
      stubFetch({ [requested]: '/repos/healthchecks' });
      // Short timeout: one poll round rejects the foreign host, then times out.
      expect(await waitForOwnHost(root, requested, 50)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('indexNeedsReanalyze — detect a stale/legacy/incompatible index (HOR-433)', () => {
  function makeRepo(): string {
    return mkdtempSync(join(tmpdir(), 'horus-stale-'));
  }
  function writeMeta(root: string, meta: Record<string, unknown>): void {
    const dir = join(root, '.horus', 'source');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
  }

  it('returns null when there is no index (handled as "not analyzed", not "stale")', () => {
    const root = makeRepo();
    try {
      expect(indexNeedsReanalyze(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a legacy KùzuDB store dir as needing re-analyze', () => {
    const root = makeRepo();
    try {
      writeMeta(root, {
        store_backend: 'sqlite',
        stats: { symbols: 50, embeddings: 50 },
      });
      mkdirSync(join(root, '.horus', 'source', 'kuzu'), { recursive: true });
      expect(indexNeedsReanalyze(root)).toMatch(/legacy KùzuDB/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a mismatched store_backend stamp as needing re-analyze', () => {
    const root = makeRepo();
    try {
      writeMeta(root, { store_backend: 'kuzu', stats: { symbols: 50, embeddings: 50 } });
      expect(indexNeedsReanalyze(root)).toMatch(/store backend changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a 0-embedding index (symbols present) as needing re-analyze', () => {
    const root = makeRepo();
    try {
      writeMeta(root, { store_backend: 'sqlite', stats: { symbols: 50, embeddings: 0 } });
      expect(indexNeedsReanalyze(root)).toMatch(/no semantic embeddings/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags an explicit embeddings_complete:false index as needing re-analyze', () => {
    const root = makeRepo();
    try {
      writeMeta(root, {
        store_backend: 'sqlite',
        embeddings_complete: false,
        stats: { symbols: 50, embeddings: 0 },
      });
      expect(indexNeedsReanalyze(root)).toMatch(/no semantic embeddings/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for a healthy, matching, embedded index (no spurious re-index)', () => {
    const root = makeRepo();
    try {
      writeMeta(root, {
        store_backend: 'sqlite',
        store_format_version: 1,
        embeddings_complete: true,
        stats: { symbols: 50, embeddings: 50 },
      });
      expect(indexNeedsReanalyze(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for a healthy pre-stamp index (absent store_backend is backfilled, not stale)', () => {
    const root = makeRepo();
    try {
      writeMeta(root, { embeddings_complete: true, stats: { symbols: 50, embeddings: 50 } });
      expect(indexNeedsReanalyze(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
