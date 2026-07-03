/**
 * The source-intelligence backend ships INSIDE the horus bundle as a Python
 * wheel (one bundle, one version — no PyPI, no separate repo). tsup places
 * `horus_source.whl` next to the packaged `index.cjs` (same mechanism as the
 * pglite assets); `horus init` and `horus update` install the backend from it
 * via `uv tool install`.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { PINNED_SOURCE_VERSION } from '@horus/core';

const execFileAsync = promisify(execFile);

/**
 * Path to the wheel bundled next to the packaged CLI, or null when absent
 * (unbundled dev run, or a single-file download without the wheel asset).
 */
export function resolveBundledWheel(): string | null {
  // The packaged CLI is CJS (dist/index.cjs), so __dirname is the bundle dir.
  if (typeof __dirname === 'undefined') return null;
  const wheel = join(__dirname, 'horus_source.whl');
  return existsSync(wheel) ? wheel : null;
}

/**
 * The wheel's ACTUAL package version, read from its `*.dist-info/` directory
 * name (zip member paths are stored verbatim, so a raw byte scan is reliable
 * without a zip library). Returns null for a torn/corrupt/non-wheel file.
 *
 * This is what makes the bundled install TRUST-FREE: a sibling wheel is never
 * assumed to match the pin (a partial self-update can leave a NEW binary next
 * to an OLD wheel — PR #35 review, discussion_r3513795163); the content is
 * verified and a mismatch is refused.
 */
export function readWheelDistVersion(wheelPath: string): string | null {
  try {
    const raw = readFileSync(wheelPath).toString('latin1');
    const m = /horus_source-([0-9][A-Za-z0-9.+!-]*?)\.dist-info\//.exec(raw);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Install the backend from the bundled wheel. Returns true on success.
 * Best-effort: failures print the installer fallback and return false —
 * callers degrade, they never abort on this. The wheel's dist-info version
 * must equal the target version — stale/torn wheels are refused, never
 * installed under a version they aren't.
 */
export async function installBundledBackend(
  write: (line: string) => void,
  opts: { label?: string; version?: string; _wheelPath?: string } = {},
): Promise<boolean> {
  // The wheel version defaults to the compiled-in pin, but a self-update installs
  // a freshly-downloaded release wheel whose version is NOT this old process's pin
  // — callers pass `version` so the staged PEP 427 name matches the real wheel.
  const version = opts.version ?? PINNED_SOURCE_VERSION;
  // _wheelPath is an injectable seam for tests (vitest runs unbundled, where
  // the resolver is always null); production callers never pass it.
  const wheel = opts._wheelPath ?? resolveBundledWheel();
  if (wheel === null) {
    write(
      `  ${pc.dim('Bundled backend wheel not found — install via: curl -fsSL https://horus.sh/install.sh | bash')}`,
    );
    return false;
  }
  const actual = readWheelDistVersion(wheel);
  if (actual === null) {
    write(`  ${pc.yellow('!')} Bundled backend wheel is unreadable/corrupt — skipping install.`);
    write(`    ${pc.dim('Re-run the installer: curl -fsSL https://horus.sh/install.sh | bash')}`);
    return false;
  }
  if (actual !== version) {
    write(
      `  ${pc.yellow('!')} Bundled backend wheel is ${actual} but ${version} is required — refusing the stale wheel.`,
    );
    write(`    ${pc.dim('Re-run `horus update`, or: curl -fsSL https://horus.sh/install.sh | bash')}`);
    return false;
  }
  write(`  ${opts.label ?? `Installing source backend ${version} from the bundle…`}`);
  // uv/pip REQUIRE a PEP 427 wheel filename (name-version-tags.whl) and reject
  // the flat bundle name, so stage a canonically-named copy first. The stamped
  // wheel version always equals the release number (release writes both from one).
  let staging: string | null = null;
  try {
    staging = mkdtempSync(join(tmpdir(), 'horus-wheel-'));
    const canonical = join(staging, `horus_source-${version}-py3-none-any.whl`);
    copyFileSync(wheel, canonical);
    // Local wheel — no package index involved for our code; uv still resolves
    // the wheel's third-party dependencies as a normal package install.
    await execFileAsync('uv', ['tool', 'install', '--force', canonical], { timeout: 300_000 });
    write(`  ${pc.green('✓')} Source backend on ${version} (bundled).`);
    return true;
  } catch {
    write(`  ${pc.yellow('!')} Couldn't install the bundled source backend (is uv installed?).`);
    write(`    ${pc.dim('Re-run the installer: curl -fsSL https://horus.sh/install.sh | bash')}`);
    return false;
  } finally {
    if (staging !== null) rmSync(staging, { recursive: true, force: true });
  }
}
