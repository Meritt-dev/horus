import {
  writeFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { HORUS_VERSION, PINNED_SOURCE_VERSION } from '@horus/core';
import { getSourceVersion } from '@horus/connectors';
import { installBundledBackend } from '../lib/bundled-backend.js';

const execFileAsync = promisify(execFile);

/**
 * Keep the source-intelligence backend in lockstep with the CLI (HOR-350). The backend
 * ships as a wheel inside this bundle — one bundle, one version (no PyPI). A CLI that is
 * newer than its pinned backend builds a graph it cannot map (and refuses to index), so
 * after updating the CLI we install the bundled wheel via `uv tool`. Best-effort: never
 * fails the update — falls back to pointing at the installer.
 */
async function ensureBackendPinned(
  write: (line: string) => void,
  // After a self-update the binary is replaced but THIS process is still the old
  // one, so the compiled-in PINNED_SOURCE_VERSION is stale. Callers past a binary
  // swap must pass the freshly-downloaded release version instead (HOR-350).
  targetVersion: string = PINNED_SOURCE_VERSION,
  // A wheel CONFIRMED to be `targetVersion` (e.g. just downloaded from that
  // release). Required whenever targetVersion differs from the compiled-in pin:
  // the sibling horus_source.whl is only trustworthy for THIS binary's own pin —
  // staging it under any other version would install stale backend bits that
  // then wrongly PASS the pin check (PR #35 review, discussion_r3513589546).
  confirmedWheelPath?: string,
): Promise<void> {
  let installed: string | null = null;
  try {
    installed = await getSourceVersion();
  } catch {
    installed = null;
  }
  if (installed === targetVersion) {
    write(`  ${pc.green('✓')} Source backend already on pinned ${targetVersion}.`);
    return;
  }
  if (targetVersion !== PINNED_SOURCE_VERSION && confirmedWheelPath === undefined) {
    // No wheel confirmed for that release — never reuse the old sibling wheel.
    write(`  ${pc.yellow('!')} Backend wheel for ${targetVersion} wasn't downloaded — skipping backend install.`);
    write(`    ${pc.dim('Re-run `horus update`, or: curl -fsSL https://horus.sh/install.sh | bash')}`);
    return;
  }
  await installBundledBackend(write, {
    version: targetVersion,
    ...(confirmedWheelPath !== undefined ? { _wheelPath: confirmedWheelPath } : {}),
    label:
      installed === null
        ? undefined
        : `Upgrading source backend ${installed} → ${targetVersion} (bundled wheel)…`,
  });
}

const RELEASES_API = 'https://api.github.com/repos/meritt-dev/horus/releases/latest';

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export function parseVersion(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Cannot parse version: ${v}`);
  return [+m[1]!, +m[2]!, +m[3]!];
}

export function isNewer(candidate: string, current: string): boolean {
  const [cam, can, cap] = parseVersion(candidate);
  const [cum, cun, cup] = parseVersion(current);
  if (cam !== cum) return cam > cum;
  if (can !== cun) return can > cun;
  return cap > cup;
}

async function fetchLatestRelease(
  _fetch = fetch,
): Promise<GitHubRelease> {
  const res = await _fetch(RELEASES_API, {
    headers: {
      'User-Agent': `horus/${HORUS_VERSION}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  return res.json() as Promise<GitHubRelease>;
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function resolveBinaryPath(): string {
  const raw = process.argv[1];
  if (!raw) throw new Error('Cannot determine binary path from process.argv[1]');
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

export async function runUpdate(opts: {
  check?: boolean;
  force?: boolean;
  write?: (line: string) => void;
  _fetch?: typeof fetch;
  /** Injectable for tests — defaults to the build-time HORUS_VERSION. */
  _currentVersion?: string;
}): Promise<number> {
  const write = opts.write ?? ((l: string) => console.log(l));
  const _fetch = opts._fetch ?? fetch;
  const currentVersion = opts._currentVersion ?? HORUS_VERSION;

  write(`\n${pc.bold('Horus update')}\n`);
  write(`  Current version: ${pc.cyan(currentVersion)}`);

  let release: GitHubRelease;
  try {
    release = await fetchLatestRelease(_fetch);
  } catch (e) {
    write(`  ${pc.red('✗')} Could not reach GitHub: ${(e as Error).message}`);
    return 1;
  }

  const latest = release.tag_name.replace(/^v/, '');
  write(`  Latest version:  ${pc.cyan(latest)}`);

  const newer = isNewer(latest, currentVersion);

  if (opts.check) {
    if (newer) {
      write(`\n  ${pc.yellow('→')} ${pc.bold(latest)} is available.`);
      write(`    Run ${pc.bold('horus update')} to upgrade.`);
    } else {
      write(`\n  ${pc.green('✓')} Already on the latest version.`);
    }
    return 0;
  }

  if (!newer && !opts.force) {
    write(`\n  ${pc.green('✓')} Already on the latest version.`);
    // Even when the CLI is current, the backend can have drifted — keep it pinned.
    await ensureBackendPinned(write);
    return 0;
  }

  const tag = release.tag_name;
  const assetName = `horus-${tag}`;
  const checksumName = `${assetName}.sha256`;

  const binaryAsset = release.assets.find(a => a.name === assetName);
  const checksumAsset = release.assets.find(a => a.name === checksumName);

  if (!binaryAsset) {
    write(`  ${pc.red('✗')} Release ${tag} has no binary asset named '${assetName}'.`);
    write(`    Fallback: ${pc.dim('curl -fsSL https://horus.sh/install.sh | bash')}`);
    return 1;
  }

  write(`\n  Downloading ${assetName}...`);
  const binRes = await _fetch(binaryAsset.browser_download_url, {
    headers: { 'User-Agent': `horus/${HORUS_VERSION}` },
    redirect: 'follow',
  });
  if (!binRes.ok || !binRes.body) {
    write(`  ${pc.red('✗')} Download failed: ${binRes.status}`);
    return 1;
  }
  const binBuf = Buffer.from(await binRes.arrayBuffer());

  if (checksumAsset) {
    const csRes = await _fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': `horus/${HORUS_VERSION}` },
      redirect: 'follow',
    });
    if (csRes.ok) {
      const csText = await csRes.text();
      const expectedHash = csText.trim().split(/\s+/)[0]!;
      const actualHash = sha256hex(binBuf);
      if (expectedHash !== actualHash) {
        write(`  ${pc.red('✗')} Checksum mismatch — download may be corrupt.`);
        write(`    Expected: ${expectedHash}`);
        write(`    Got:      ${actualHash}`);
        return 1;
      }
      write(`  ${pc.green('✓')} Checksum verified.`);
    }
  }

  let binaryPath: string;
  try {
    binaryPath = resolveBinaryPath();
  } catch (e) {
    write(`  ${pc.red('✗')} ${(e as Error).message}`);
    return 1;
  }

  if (!existsSync(binaryPath)) {
    write(`  ${pc.red('✗')} Binary not found at ${binaryPath}`);
    return 1;
  }

  const tmpPath = join(tmpdir(), `horus-update-${tag}-${process.pid}`);
  const backupPath = `${binaryPath}.bak`;

  try {
    writeFileSync(tmpPath, binBuf, { mode: 0o755 });
  } catch (e) {
    write(`  ${pc.red('✗')} Could not write to temp dir: ${(e as Error).message}`);
    return 1;
  }

  try {
    renameSync(binaryPath, backupPath);
    try {
      renameSync(tmpPath, binaryPath);
      chmodSync(binaryPath, 0o755);
    } catch (e) {
      // Rollback: restore backup
      try { renameSync(backupPath, binaryPath); } catch { /* ignore */ }
      throw e;
    }
    try { unlinkSync(backupPath); } catch { /* backup removal is best-effort */ }
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    const msg = (e as NodeJS.ErrnoException).message ?? String(e);
    const needsSudo = (e as NodeJS.ErrnoException).code === 'EACCES'
      || (e as NodeJS.ErrnoException).code === 'EPERM';
    write(`  ${pc.red('✗')} Could not replace binary at ${binaryPath}: ${msg}`);
    if (needsSudo) {
      write(`\n  Try with sudo:`);
      write(
        `    ${pc.dim(`sudo curl -fsSL https://github.com/meritt-dev/horus/releases/download/${tag}/${assetName} -o ${binaryPath} && sudo chmod +x ${binaryPath}`)}`,
      );
    }
    return 1;
  }

  write(`  ${pc.green('✓')} Updated: ${pc.bold(currentVersion)} → ${pc.bold(latest)}`);
  write(`  ${pc.dim(binaryPath)}`);

  // Refresh the bundled backend wheel from the same release so the sibling
  // horus_source.whl matches the new binary (one bundle, one version). The
  // running (old) process resolves the wheel from the binary's directory, so
  // writing it there lets ensureBackendPinned install the NEW backend below.
  const wheelAsset = release.assets.find((a) => a.name === 'horus_source.whl');
  const siblingWheel = join(dirname(binaryPath), 'horus_source.whl');
  let refreshedWheelPath: string | undefined;
  try {
    if (!wheelAsset) throw new Error('release has no horus_source.whl asset');
    const whlRes = await _fetch(wheelAsset.browser_download_url, {
      headers: { 'User-Agent': `horus/${HORUS_VERSION}` },
      redirect: 'follow',
    });
    if (!whlRes.ok) throw new Error(`wheel download failed: ${whlRes.status}`);
    // Write-then-rename so a crash mid-download can never leave a TORN wheel
    // that a later process would trust by co-location.
    const tmpWheel = `${siblingWheel}.tmp-${process.pid}`;
    writeFileSync(tmpWheel, Buffer.from(await whlRes.arrayBuffer()));
    renameSync(tmpWheel, siblingWheel);
    refreshedWheelPath = siblingWheel;
    write(`  ${pc.green('✓')} Bundled backend wheel refreshed.`);
  } catch {
    // The binary is already the NEW version, so the OLD sibling wheel must not
    // survive: the next process (new compiled-in pin) would trust it by
    // co-location and install stale backend bits under the new pin (PR #35
    // review, discussion_r3513795163). Remove it so later `horus update`/
    // `horus init` fall back to the installer; install-time dist-info
    // verification is the second line of defense if this unlink fails.
    if (existsSync(siblingWheel)) {
      try {
        unlinkSync(siblingWheel);
        write(`  ${pc.yellow('!')} Backend wheel refresh failed — removed the stale bundled wheel.`);
      } catch {
        write(`  ${pc.yellow('!')} Backend wheel refresh failed and the stale wheel could not be removed.`);
      }
    }
  }

  // Bring the source backend to the version of the release we just installed —
  // NOT the stale compiled-in pin of this still-running old process (HOR-350).
  // Only a wheel confirmed downloaded from THIS release may be installed as
  // `latest`; on a failed refresh this skips with the installer fallback.
  await ensureBackendPinned(write, latest, refreshedWheelPath);
  return 0;
}
