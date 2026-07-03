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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seams = vi.hoisted(() => ({
  isHostHealthy: vi.fn(async () => true),
  checkSourceCompatibility: vi.fn(),
  killSpawnedHost: vi.fn(async () => {}),
  sourceAvailable: vi.fn(async () => true),
  assertSourceVersionPinned: vi.fn(async () => {
    throw new Error('SPAWN-PATH-SENTINEL');
  }),
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

import { runIndex } from './index-repo.js';

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

    const code = await runIndex({ name: 'reuse-test', path: repo });

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

    const code = await runIndex({ name: 'drift-test', path: repo });

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

    const code = await runIndex({ name: 'unknown-test', path: repo });

    expect(logs.join('\n')).toContain('Reusing source-intelligence host');
    expect(seams.killSpawnedHost).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });
});
