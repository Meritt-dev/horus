import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Workspace root is three directories above apps/horus/src/
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const TSX = resolve(WORKSPACE_ROOT, 'node_modules/.bin/tsx');
const ENTRYPOINT = resolve(__dirname, 'index.ts');
// Built release artifact — `tsup && vitest` in package.json ensures this exists.
const DIST = resolve(__dirname, '../dist/index.cjs');

// Guaranteed-absent config path: a unique temp dir is created, a .json file
// inside it is referenced but never written. Stays absent for the full suite.
let tmpDir: string;
let missingConfig: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'horus-smoke-'));
  missingConfig = join(tmpDir, 'config.json');
  // Deliberately do NOT create config.json — we want the file to be absent.
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function runCLI(...args: string[]) {
  return spawnSync(TSX, [ENTRYPOINT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 15_000,
    cwd: WORKSPACE_ROOT,
  });
}

function runDist(...args: string[]) {
  return spawnSync(process.execPath, [DIST, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 15_000,
    cwd: WORKSPACE_ROOT,
  });
}

// ── Source entrypoint (tsx) ───────────────────────────────────────────────────
// Fast path: catches API/logic regressions without requiring a build step.
describe('source entrypoint via tsx', () => {
  it('--version exits 0 and prints version', () => {
    const result = runCLI('--version');
    expect(result.status).toBe(0);
    // tsx runs the source without tsup's define, so version is 'dev' — the
    // semver format is verified by the dist artifact test below.
    expect(result.stdout).toContain('horus');
  });

  it('--help exits 0 and includes the program name', () => {
    const result = runCLI('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('horus');
  });

  it('--help lists release-critical commands', () => {
    const out = runCLI('--help').stdout;
    for (const cmd of ['init', 'investigate', 'connect', 'stop', 'hosts']) {
      expect(out, `--help should mention "${cmd}"`).toContain(cmd);
    }
    // `init` is the ONLY onboarding/indexing command — the removed names are gone.
    expect(out).not.toMatch(/\n {2}setup\b/);
    expect(out).not.toMatch(/\n {2}index\b/);
  });

  it('setup and index are REMOVED: bare and --help forms all fail nonzero', () => {
    for (const name of ['setup', 'index']) {
      const bare = runCLI(name);
      expect(bare.status, `${name} should be an unknown command`).not.toBe(0);
      expect(bare.stderr).toMatch(/unknown command/i);
      // --help must not resurrect a removed command via top-level help (exit 0).
      const withHelp = runCLI(name, '--help');
      expect(withHelp.status, `${name} --help should fail like ${name}`).not.toBe(0);
      expect(withHelp.stderr).toMatch(/unknown command/i);
      const withH = runCLI(name, '-h');
      expect(withH.status, `${name} -h should fail like ${name}`).not.toBe(0);
    }
  });

  it('investigate --help exits 0 and documents --format', () => {
    const result = runCLI('investigate', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('format');
  });

  it('connect --help exits 0', () => {
    expect(runCLI('connect', '--help').status).toBe(0);
  });

  it('hosts --help exits 0', () => {
    expect(runCLI('hosts', '--help').status).toBe(0);
  });

  it('stop --help exits 0', () => {
    expect(runCLI('stop', '--help').status).toBe(0);
  });

  it('<unknown-command> exits non-zero', () => {
    expect(runCLI('this-command-does-not-exist').status).not.toBe(0);
  });
});

// ── Machine-readable --json (agent contract) ──────────────────────────────────
// stdout under --json must be ONE parseable JSON document — no banner, no human
// text before or after — even on failure. Agents pipe this straight into
// JSON.parse. Local persistence is embedded (pglite): HORUS_DB_DIR points at a
// fresh temp dir so the store is deterministically EMPTY (and never touches the
// developer's real ~/.horus db); cwd is the empty temp dir so no repo config is
// discoverable. DATABASE_URL is deliberately set to a closed port to prove the
// runtime IGNORES it (embedded always).
describe('--json stdout is pure, parseable JSON', () => {
  const CLOSED_DB = 'postgresql://horus:horus@127.0.0.1:9/horus';

  function runJson(...args: string[]) {
    return spawnSync(TSX, [ENTRYPOINT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: CLOSED_DB, // ignored at runtime — embedded persistence always
        HORUS_DB_DIR: join(tmpDir, 'db'),
        HORUS_CONFIG: '',
        HORUS_NO_UPDATE_CHECK: '1',
      },
      timeout: 15_000,
      cwd: tmpDir,
    });
  }

  it('status --json with a missing config emits valid JSON and exits non-zero', () => {
    const result = runJson('status', '--json', '--config', missingConfig);
    expect(result.status).not.toBe(0);
    const out = JSON.parse(result.stdout) as {
      config: { ok: boolean; detail: string };
      healthy: boolean;
    };
    expect(out.config.ok).toBe(false);
    expect(out.config.detail).toContain(missingConfig);
    expect(out.healthy).toBe(false);
  });

  it('investigations --json emits valid JSON (empty embedded store) and exits 0', () => {
    const result = runJson('investigations', '--json', '--config', missingConfig);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { investigations: unknown[]; count: number };
    expect(out.investigations).toEqual([]);
    expect(out.count).toBe(0);
  });

  it('scores --json emits valid JSON (empty embedded store) and exits 0', () => {
    const result = runJson('scores', '--json', '--config', missingConfig);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { scores: unknown[] };
    expect(out.scores).toEqual([]);
  });

  it('outside a configured repo, the error is the exact documented sentence', () => {
    // No --config, no .horus in cwd, no $HORUS_CONFIG: the config/cwd IS the
    // project identity, and the failure must teach exactly that.
    const result = runJson('investigate', 'test-hint');
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'No Horus config found. Run from a configured repo or pass --config <path>.',
    );
  });
});

// ── Release artifact (dist/index.cjs) ────────────────────────────────────────
// Catches bundling, CJS conversion, and missing-dependency regressions that
// only surface in the installed product. The tsup build runs before vitest
// so this file is guaranteed to exist when these tests run.
describe('release artifact dist/index.cjs', () => {
  it('starts with the node shebang', () => {
    const head = readFileSync(DIST, 'utf8').slice(0, 64);
    expect(head).toContain('#!/usr/bin/env node');
  });

  it('--version exits 0 and prints version', () => {
    const result = runDist('--version');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/horus \d+\.\d+\.\d+/);
  });

  it('--help exits 0 and includes the program name', () => {
    const result = runDist('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('horus');
  });

  it('--help lists release-critical commands', () => {
    const out = runDist('--help').stdout;
    for (const cmd of ['init', 'investigate', 'connect', 'stop', 'hosts']) {
      expect(out, `--help should mention "${cmd}"`).toContain(cmd);
    }
    // `init` is the ONLY onboarding/indexing command — the removed names are gone.
    expect(out).not.toMatch(/\n {2}setup\b/);
    expect(out).not.toMatch(/\n {2}index\b/);
  });

  it('setup and index are REMOVED: bare and --help forms all fail nonzero', () => {
    for (const name of ['setup', 'index']) {
      const bare = runDist(name);
      expect(bare.status, `${name} should be an unknown command`).not.toBe(0);
      expect(bare.stderr).toMatch(/unknown command/i);
      // --help must not resurrect a removed command via top-level help (exit 0).
      const withHelp = runDist(name, '--help');
      expect(withHelp.status, `${name} --help should fail like ${name}`).not.toBe(0);
      expect(withHelp.stderr).toMatch(/unknown command/i);
    }
  });

  it('investigate --help exits 0 and documents --format', () => {
    const result = runDist('investigate', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('format');
  });

  it('<unknown-command> exits non-zero', () => {
    expect(runDist('this-command-does-not-exist').status).not.toBe(0);
  });

  // Command-handler routing: verify that routing reached the config-loading
  // path by asserting the output contains the exact config path we passed.
  // A generic crash would not include the path, so this distinguishes
  // "handler was reached and reported the error" from "unrelated exception".
  it('status with missing config exits non-zero and reports the config path', () => {
    const result = runDist('status', '--config', missingConfig);
    expect(result.status).not.toBe(0);
    // runStatus catches the ENOENT and prints via console.log to stdout.
    const output = result.stdout + result.stderr;
    expect(output).toContain(missingConfig);
  });

  it('investigate with missing config exits non-zero and reports the config path', () => {
    const result = runDist('investigate', 'test-hint', '--config', missingConfig);
    expect(result.status).not.toBe(0);
    // runInvestigate's outer catch prints via console.error to stderr.
    const output = result.stdout + result.stderr;
    expect(output).toContain(missingConfig);
  });
});
