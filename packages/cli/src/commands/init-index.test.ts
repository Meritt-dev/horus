/**
 * Tests for runIndex's host-reuse gate: a healthy host serving the repo is
 * reused ONLY when it runs the pinned backend version. A drifted host (left
 * running across a `horus update`) serves a graph this CLI may mis-map — the
 * reuse path must refuse it and stop it (it holds the repo's single-writer
 * store lock) so the spawn path can start a pinned replacement. Regression for
 * the dogfood finding where init silently reused a v2.0.2 host under a 2.1.0
 * pin and only `horus status` flagged the mismatch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seams = vi.hoisted(() => ({
  isHostHealthy: vi.fn(async () => true),
  checkSourceCompatibility: vi.fn(),
  killSpawnedHost: vi.fn(async () => {}),
  sourceAvailable: vi.fn(async () => true),
  assertSourceVersionPinned: vi.fn(async (): Promise<void> => {
    throw new Error('SPAWN-PATH-SENTINEL');
  }),
  isAnalyzed: vi.fn(() => false),
  indexNeedsReanalyze: vi.fn(() => null as string | null),
  indexEmbeddingsPending: vi.fn(() => false),
  analyzeRepo: vi.fn(async () => {}),
  findFreePort: vi.fn(async () => 8420),
  startHost: vi.fn(() => {}),
  waitForOwnHost: vi.fn(async (_root: string, hostUrl: string) => hostUrl),
  reconcileSpawnedHost: vi.fn(() => {}),
  hostInfo: vi.fn(),
  loadConfig: vi.fn(async () => {
    throw new Error('no config');
  }),
}));

vi.mock('@horus/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/connectors')>();
  return {
    ...actual,
    isHostHealthy: seams.isHostHealthy,
    checkSourceCompatibility: seams.checkSourceCompatibility,
    killSpawnedHost: seams.killSpawnedHost,
    sourceAvailable: seams.sourceAvailable,
    assertSourceVersionPinned: seams.assertSourceVersionPinned,
    isAnalyzed: seams.isAnalyzed,
    indexNeedsReanalyze: seams.indexNeedsReanalyze,
    indexEmbeddingsPending: seams.indexEmbeddingsPending,
    analyzeRepo: seams.analyzeRepo,
    findFreePort: seams.findFreePort,
    startHost: seams.startHost,
    waitForOwnHost: seams.waitForOwnHost,
    reconcileSpawnedHost: seams.reconcileSpawnedHost,
    // hostServesRepo probes the candidate via hostInfo(); point it at our repo.
    SourceHttpClient: class {
      hostInfo = seams.hostInfo;
    },
  };
});
vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return { ...actual, loadConfig: seams.loadConfig, registerProject: vi.fn() };
});
// The stitch/knowledge stages degrade gracefully; keep them inert.
vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return {
    ...actual,
    openDb: vi.fn(async () => {
      throw new Error('no db in test');
    }),
  };
});

import { runIndex } from './init-index.js';

let repo: string;
let logs: string[];
let errs: string[];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'horus-index-repo-'));
  // A recorded host for the repo so the reuse loop has a candidate.
  mkdirSync(join(repo, '.horus', 'source'), { recursive: true });
  writeFileSync(
    join(repo, '.horus', 'source', 'host.json'),
    JSON.stringify({ host_url: 'http://127.0.0.1:9999' }),
  );
  seams.hostInfo.mockResolvedValue({ repoPath: repo });
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('runIndex host-reuse version gate', () => {
  it('reuses a healthy host running the pinned backend', async () => {
    seams.checkSourceCompatibility.mockResolvedValue({
      version: '9.9.9',
      pinned: '9.9.9',
      matches: true,
    });

    const code = await runIndex({ path: repo });

    expect(logs.join('\n')).toContain('Reusing source-intelligence host');
    expect(seams.killSpawnedHost).not.toHaveBeenCalled();
    // Reuse path continues (stitch/knowledge degrade on the inert mocks) and succeeds.
    expect(code).toBe(0);
  });

  it('REGRESSION: refuses a version-drifted host, stops it, and falls through to spawn', async () => {
    seams.checkSourceCompatibility.mockResolvedValue({
      version: '2.0.2',
      pinned: '9.9.9',
      matches: false,
    });

    const code = await runIndex({ path: repo });

    const out = logs.join('\n');
    expect(out).not.toContain('Reusing source-intelligence host');
    expect(out).toContain('v2.0.2');
    expect(out).toContain('restarting it with the pinned backend');
    // The drifted host holds the single-writer lock — it must be stopped first.
    expect(seams.killSpawnedHost).toHaveBeenCalledTimes(1);
    // Spawn path engaged (our sentinel assert fires there).
    expect(errs.join('\n')).toContain('SPAWN-PATH-SENTINEL');
    expect(code).toBe(1);
  });

  it('an UNKNOWN host version does not block reuse (matches the spawn-path policy)', async () => {
    seams.checkSourceCompatibility.mockResolvedValue({
      version: null,
      pinned: '9.9.9',
      matches: false,
    });

    const code = await runIndex({ path: repo });

    expect(logs.join('\n')).toContain('Reusing source-intelligence host');
    expect(seams.killSpawnedHost).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });
});

describe('runIndex structural-only readiness gate (B1.1)', () => {
  it('a structural-complete/embeddings-pending index passes the gate, starts a host, writes config, returns 0', async () => {
    // The crown-jewel durability fix: `analyze --defer-embeddings` returns a COMPLETE
    // structural index with 0 vectors. indexNeedsReanalyze() returns null for it, so init
    // must NOT abort — it starts the host (which warms embeddings) and writes config.
    seams.isHostHealthy.mockResolvedValue(false); // force the spawn path
    seams.assertSourceVersionPinned.mockResolvedValue(undefined);
    seams.isAnalyzed.mockReturnValue(true);
    // Stale before analyze (enter the analyze branch), structural-complete after (null).
    seams.indexNeedsReanalyze
      .mockReturnValueOnce('legacy KùzuDB store present')
      .mockReturnValue(null);
    seams.analyzeRepo.mockResolvedValue(undefined);

    const code = await runIndex({ path: repo });

    expect(code).toBe(0);
    // Did NOT trip the old "did not finish / no embeddings" fatal gate.
    expect(errs.join('\n')).not.toContain('did not finish');
    // Proceeded to start a host on the structural index.
    expect(seams.startHost).toHaveBeenCalledTimes(1);
    expect(seams.analyzeRepo).toHaveBeenCalledTimes(1);
    // And wrote a local config so later commands can load one.
    expect(logs.join('\n')).toContain('Indexed');
  });

  it('B1.4: surfaces "semantic search warming up" when the host is structural-ready + embeddings-pending', async () => {
    // Force the spawn path onto a structural-complete/embeddings-pending index (as B1.1 leaves
    // it), then have the host advertise the degraded-mode fields. init should print the warming
    // notice so the user knows search works now while semantic ranking catches up.
    seams.isHostHealthy.mockResolvedValue(false);
    seams.assertSourceVersionPinned.mockResolvedValue(undefined);
    seams.isAnalyzed.mockReturnValue(true);
    seams.indexNeedsReanalyze
      .mockReturnValueOnce('legacy KùzuDB store present')
      .mockReturnValue(null);
    seams.analyzeRepo.mockResolvedValue(undefined);
    // B1.4 reads the DURABLE meta (deterministic), not the host's transient flags: a
    // structural-complete/embeddings-pending index prints the warming notice.
    seams.indexEmbeddingsPending.mockReturnValue(true);

    const code = await runIndex({ path: repo });

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('semantic search warming up');
  });

  it('B1.4: stays silent once embeddings have landed (no false warming notice)', async () => {
    seams.isHostHealthy.mockResolvedValue(false);
    seams.assertSourceVersionPinned.mockResolvedValue(undefined);
    seams.isAnalyzed.mockReturnValue(true);
    seams.indexNeedsReanalyze
      .mockReturnValueOnce('legacy KùzuDB store present')
      .mockReturnValue(null);
    seams.analyzeRepo.mockResolvedValue(undefined);
    // Embeddings already landed → meta reports not-pending → no warming notice.
    seams.indexEmbeddingsPending.mockReturnValue(false);

    const code = await runIndex({ path: repo });

    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('semantic search warming up');
  });

  it('REGRESSION: a 0-embedding index with NO structural marker (HOR-433 kùzu) still aborts', async () => {
    // The genuine kùzu-era empty store: indexNeedsReanalyze() keeps returning a reason even
    // after analyze, so init must still fail loudly and never register a host on it.
    seams.isHostHealthy.mockResolvedValue(false); // force the spawn path
    seams.assertSourceVersionPinned.mockResolvedValue(undefined);
    seams.isAnalyzed.mockReturnValue(true);
    seams.indexNeedsReanalyze.mockReturnValue(
      'index has no semantic embeddings (symbols present but 0 vectors)',
    );
    seams.analyzeRepo.mockResolvedValue(undefined);

    const code = await runIndex({ path: repo });

    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('source analysis did not finish');
    // Never started a host on the broken index.
    expect(seams.startHost).not.toHaveBeenCalled();
  });
});

describe('runIndex leaves a clean tree even when init fails', () => {
  it('REGRESSION: writes .horus/ to .git/info/exclude BEFORE analyze, so a mid-index abort stays clean', async () => {
    // A git repo whose `.horus/` must never dirty `git status` — even on failure.
    mkdirSync(join(repo, '.git'));
    // Force the spawn path (no reusable host) and fail inside analyze.
    seams.isHostHealthy.mockResolvedValue(false);
    seams.assertSourceVersionPinned.mockResolvedValue(undefined);
    seams.isAnalyzed.mockReturnValue(false);
    seams.analyzeRepo.mockRejectedValue(new Error('analyze timed out'));

    const code = await runIndex({ path: repo });

    // The index failed…
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('source analysis failed');
    // …but the exclude write happened up front, so the tree is still clean.
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.horus/');
  });
});
