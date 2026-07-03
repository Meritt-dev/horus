/**
 * Tests for `horus init` — the single onboarding command (merger of the old
 * setup/init/index commands).
 *
 * Pins the write-only side effects (local config written, project registered,
 * `.horus/` gitignored), the degradation policy (no backend → config still
 * written, exit 0, install hint; backend present → delegates to the index
 * flow; index failure → exit 1), and the next-steps guidance: init must point
 * users at `horus connect` for credentials, never at hand-editing connectors
 * into `.horus/config.json` (plaintext-secret footgun).
 *
 * The prereq checks and backend probe are mocked so tests never touch the
 * network or a locally-installed horus-source; HOME is redirected to a temp
 * dir so the project registry never touches the real `~/.horus/registry.json`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seams = vi.hoisted(() => ({
  sourceAvailable: vi.fn(async () => false),
  getSourceVersion: vi.fn(async () => null as string | null),
  checkDatabase: vi.fn(async () => ({ reachable: false, schemaReady: false, schemaDetail: '' })),
  runIndex: vi.fn(async () => 0),
}));

vi.mock('@horus/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/connectors')>();
  return {
    ...actual,
    sourceAvailable: seams.sourceAvailable,
    getSourceVersion: seams.getSourceVersion,
  };
});
vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, checkDatabase: seams.checkDatabase };
});
vi.mock('./index-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index-repo.js')>();
  return { ...actual, runIndex: seams.runIndex };
});

import { runInit } from './init.js';

let home: string;
let repo: string;
let origHome: string | undefined;
let logs: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'horus-init-home-'));
  repo = mkdtempSync(join(tmpdir(), 'horus-init-repo-'));
  origHome = process.env['HOME'];
  process.env['HOME'] = home;
  logs = [];
  errs = [];
  seams.sourceAvailable.mockResolvedValue(false);
  seams.runIndex.mockResolvedValue(0);
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('runInit (degraded: no source backend)', () => {
  it('writes .horus/config.json, registers the project, and gitignores .horus/', async () => {
    // ensureProjectGitignore only acts inside a git repo.
    mkdirSync(join(repo, '.git'));
    const code = await runInit({ name: 'demo-project', path: repo });

    expect(code).toBe(0);

    const configPath = join(repo, '.horus', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.version).toBe(1);
    expect(config.project.name).toBe('demo-project');
    expect(config.project.environments).toEqual([
      { name: 'production', readOnly: true, connectors: {} },
    ]);

    const registryPath = join(home, '.horus', 'registry.json');
    expect(existsSync(registryPath)).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.projects['demo-project']).toMatchObject({ configPath });

    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.horus/');

    // Degraded path: indexing skipped with the install hint, never delegated.
    expect(seams.runIndex).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('indexing skipped');
  });

  it('honors --env for the environment name', async () => {
    const code = await runInit({ name: 'demo-project', env: 'staging', path: repo });
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(repo, '.horus', 'config.json'), 'utf8'));
    expect(config.project.environments[0].name).toBe('staging');
  });

  it('next steps recommend `horus connect`, never hand-editing connectors into config.json', async () => {
    const code = await runInit({ name: 'demo-project', path: repo });
    expect(code).toBe(0);

    const out = logs.join('\n');
    expect(out).toContain('horus connect');
    expect(out).not.toMatch(/add .*connectors.* to .*config\.json/);
  });

  it('returns 1 with an error message when the config cannot be written', async () => {
    // A regular file where a directory is expected makes writeLocalConfig throw.
    const notADir = join(repo, 'blocker');
    writeFileSync(notADir, '');

    const code = await runInit({ name: 'demo-project', path: join(notADir, 'nested') });

    expect(code).toBe(1);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('runInit (--source: external host escape hatch)', () => {
  it('records the host URL verbatim and never probes or delegates to the index flow', async () => {
    const code = await runInit({
      name: 'demo-project',
      path: repo,
      source: 'http://127.0.0.1:8420',
    });

    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(repo, '.horus', 'config.json'), 'utf8'));
    expect(config.project.repositories[0].source).toEqual({ hostUrl: 'http://127.0.0.1:8420' });
    expect(seams.sourceAvailable).not.toHaveBeenCalled();
    expect(seams.runIndex).not.toHaveBeenCalled();
  });
});

describe('runInit (backend available: delegates to the index flow)', () => {
  it('delegates to runIndex with the resolved root and passthrough flags', async () => {
    seams.sourceAvailable.mockResolvedValue(true);

    const code = await runInit({ name: 'demo-project', env: 'staging', path: repo, changed: true });

    expect(code).toBe(0);
    expect(seams.runIndex).toHaveBeenCalledTimes(1);
    expect(seams.runIndex).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'demo-project', env: 'staging', changed: true, path: repo }),
    );
  });

  it('propagates a failing index run as a non-zero exit', async () => {
    seams.sourceAvailable.mockResolvedValue(true);
    seams.runIndex.mockResolvedValue(1);

    const code = await runInit({ name: 'demo-project', path: repo });
    expect(code).toBe(1);
  });

  it('prereq check lines are advisory — a red Postgres never gates the exit code', async () => {
    seams.checkDatabase.mockResolvedValue({ reachable: false, schemaReady: false, schemaDetail: '' });
    seams.sourceAvailable.mockResolvedValue(true);

    const code = await runInit({ name: 'demo-project', path: repo });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('Postgres unreachable');
  });
});
