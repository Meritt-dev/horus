/**
 * The bundled wheel ships under the flat name `horus_source.whl`, but uv/pip
 * REJECT non-PEP-427 wheel filenames ("Must have a version"). install must
 * stage a canonically-named copy (horus_source-<version>-py3-none-any.whl)
 * and hand THAT to `uv tool install` — regression for the flat-name failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const seams = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileError: null as Error | null,
  /** Captured at exec time — the staging dir is cleaned up after install. */
  wheelArgExistedAtExec: false,
  wheelArgBytes: '',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      seams.execFile(cmd, args, opts);
      const wheelArg = args[args.length - 1]!;
      seams.wheelArgExistedAtExec = existsSync(wheelArg);
      seams.wheelArgBytes = seams.wheelArgExistedAtExec ? readFileSync(wheelArg, 'utf8') : '';
      cb(seams.execFileError, { stdout: '', stderr: '' });
    },
  };
});
vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return { ...actual, PINNED_SOURCE_VERSION: '9.9.9' };
});

import { installBundledBackend, resolveBundledWheel } from './bundled-backend.js';

let bundleDir: string;
let flatWheel: string;
let lines: string[];

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'horus-bundle-'));
  flatWheel = join(bundleDir, 'horus_source.whl');
  writeFileSync(flatWheel, 'fake-wheel-bytes');
  lines = [];
  seams.execFileError = null;
  seams.wheelArgExistedAtExec = false;
  seams.wheelArgBytes = '';
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(bundleDir, { recursive: true, force: true });
});

describe('installBundledBackend', () => {
  it('REGRESSION: hands uv a PEP 427-named staged copy, never the flat bundle name', async () => {
    const ok = await installBundledBackend((l) => lines.push(l), { _wheelPath: flatWheel });

    expect(ok).toBe(true);
    expect(seams.execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = seams.execFile.mock.calls[0]! as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args.slice(0, 3)).toEqual(['tool', 'install', '--force']);
    const wheelArg = args[args.length - 1]!;
    expect(basename(wheelArg)).toBe('horus_source-9.9.9-py3-none-any.whl');
    // The staged copy really existed (same bytes) when uv ran…
    expect(seams.wheelArgExistedAtExec).toBe(true);
    expect(seams.wheelArgBytes).toBe('fake-wheel-bytes');
    // …and the staging dir is cleaned up afterwards.
    expect(existsSync(wheelArg)).toBe(false);
  });

  it('cleans up staging and degrades gracefully when uv fails', async () => {
    seams.execFileError = new Error('uv not found');
    const ok = await installBundledBackend((l) => lines.push(l), { _wheelPath: flatWheel });

    expect(ok).toBe(false);
    const wheelArg = (seams.execFile.mock.calls[0]![1] as string[]).at(-1)!;
    expect(existsSync(wheelArg)).toBe(false);
    expect(lines.join('\n')).toContain('install.sh');
  });

  it('degrades with the installer hint when no wheel is bundled (dev runs)', async () => {
    expect(resolveBundledWheel()).toBeNull(); // unbundled test env
    const ok = await installBundledBackend((l) => lines.push(l));
    expect(ok).toBe(false);
    expect(seams.execFile).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('install.sh');
  });

  it('stages under the caller-provided version, not the compiled-in pin (self-update)', async () => {
    // After a self-update the freshly-downloaded wheel is the NEW release version,
    // while PINNED_SOURCE_VERSION (mocked 9.9.9) is this old process's stale pin.
    const ok = await installBundledBackend((l) => lines.push(l), {
      _wheelPath: flatWheel,
      version: '1.2.3',
    });

    expect(ok).toBe(true);
    const args = seams.execFile.mock.calls[0]![1] as string[];
    const wheelArg = args[args.length - 1]!;
    expect(basename(wheelArg)).toBe('horus_source-1.2.3-py3-none-any.whl');
    expect(basename(wheelArg)).not.toContain('9.9.9');
    expect(lines.join('\n')).toContain('1.2.3');
  });
});
