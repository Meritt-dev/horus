/**
 * Source-intelligence process lifecycle (HOR-37) — analyze a repo and host its graph.
 *
 * This shells out to the `horus-source` CLI for LIFECYCLE only (analyze / host), which is
 * explicitly allowed (like the git connector). The "no CLI shell-out" rule applies
 * to QUERIES — those still go over HTTP/MCP via SourceHttpClient.
 *
 * The binary is named `horus-source` (installed from the wheel bundled with the CLI).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, openSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { PINNED_SOURCE_VERSION, SOURCE_PIN_ENFORCED, redactSecrets } from '@horus/core';

const exec = promisify(execFile);

const SOURCE_BINARY = 'horus-source';

/** Resolve the source-intelligence binary, or null if it is not on PATH. */
export async function resolveSourceBin(): Promise<string | null> {
  try {
    await exec(SOURCE_BINARY, ['--version'], { timeout: 5000 });
    return SOURCE_BINARY;
  } catch {
    return null;
  }
}

/** Is the `horus-source` binary on PATH? */
export async function sourceAvailable(): Promise<boolean> {
  return (await resolveSourceBin()) !== null;
}

/** Resolve the active source-intelligence binary name, or null if not installed. */
export function getActiveSourceBin(): Promise<string | null> {
  return resolveSourceBin();
}

/**
 * Return the installed `horus-source` version string (e.g. "1.0.1"),
 * or null if the binary is not on PATH or the version cannot be parsed.
 */
export async function getSourceVersion(): Promise<string | null> {
  try {
    const { stdout } = await exec(SOURCE_BINARY, ['--version'], { timeout: 5000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Thrown when the installed `horus-source` backend does not match {@link PINNED_SOURCE_VERSION}.
 * Carries both versions so callers can render an actionable, copy-pasteable remediation.
 */
export class SourceVersionMismatchError extends Error {
  constructor(
    public readonly installed: string,
    public readonly pinned: string,
  ) {
    super(
      `horus-source ${installed} is installed but Horus is pinned to ${pinned}. ` +
        `A drifted backend builds a graph this CLI cannot map and can corrupt the index ` +
        `(e.g. duplicate-primary-key failures during "Running initial index").\n` +
        `  Fix it — run \`horus update\` to install the backend bundled with this CLI.`,
    );
    this.name = 'SourceVersionMismatchError';
  }
}

/**
 * Assert the installed backend matches the pinned version BEFORE we let it analyze a repo
 * or host its graph (architecture.md §1, risk R4). A drifted build (an installed version
 * other than the pin) can build a Kùzu graph this CLI's query mapping does not expect, so
 * we refuse to launch it — failing loudly here instead of silently mis-mapping results.
 *
 * A version that cannot be read/parsed is allowed through (treated as "unknown", matching
 * how `horus status` reports it) — we only block on a *known* mismatch.
 *
 * @throws {SourceVersionMismatchError} when the installed version is known and differs.
 */
export async function assertSourceVersionPinned(): Promise<void> {
  if (!SOURCE_PIN_ENFORCED) return; // unbundled dev run — no meaningful pin
  const installed = await getSourceVersion();
  if (installed !== null && installed !== PINNED_SOURCE_VERSION) {
    throw new SourceVersionMismatchError(installed, PINNED_SOURCE_VERSION);
  }
}

/** Has the repo been analyzed? Checks `.horus/source/`. */
export function isAnalyzed(root: string): boolean {
  return existsSync(join(root, '.horus', 'source'));
}

/**
 * Active source-storage backend the CLI expects on disk. Mirrors horus-source's
 * `factory.DEFAULT_BACKEND` (SQLite since HOR-392), overridable for parity with the backend
 * env switch. Used to detect a legacy/mismatched store on the 2.0 upgrade path (HOR-433).
 */
const CURRENT_STORE_BACKEND = (process.env['HORUS_SOURCE_STORAGE_BACKEND'] ?? 'sqlite')
  .trim()
  .toLowerCase();

interface SourceMeta {
  storeBackend?: string;
  embeddingsComplete?: boolean;
  stats?: { symbols?: number; embeddings?: number };
}

/** Read `.horus/source/meta.json`, or null when absent/unreadable. */
function readSourceMeta(root: string): SourceMeta | null {
  try {
    const raw = readFileSync(join(root, '.horus', 'source', 'meta.json'), 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    const stats = (j['stats'] as Record<string, number> | undefined) ?? undefined;
    return {
      storeBackend:
        typeof j['store_backend'] === 'string'
          ? (j['store_backend'] as string).toLowerCase()
          : undefined,
      embeddingsComplete:
        typeof j['embeddings_complete'] === 'boolean'
          ? (j['embeddings_complete'] as boolean)
          : undefined,
      stats: stats ? { symbols: stats['symbols'], embeddings: stats['embeddings'] } : undefined,
    };
  } catch {
    return null;
  }
}

/** Whether the index has usable semantic vectors (mirror of freshness.semanticSearchReady). */
function metaHasEmbeddings(meta: SourceMeta): boolean {
  if (meta.embeddingsComplete === false) return false;
  const embeddings = meta.stats?.embeddings ?? 0;
  const symbols = meta.stats?.symbols ?? 0;
  return !(symbols > 0 && embeddings === 0);
}

/**
 * Whether an existing on-disk index is stale/legacy/incompatible and must be RE-analyzed
 * rather than reused (HOR-433). Returns a human-readable reason, or `null` when the index is
 * healthy and reusable.
 *
 * The 2.0 upgrade trap: a pre-existing kùzu-era index opened by the SQLite backend reads with
 * 0 embeddings / symbols unsearchable and never self-heals — `isAnalyzed()` (a bare dir check)
 * would wrongly treat it as good and reuse it. This is intentionally CONSERVATIVE: a healthy
 * index (matching backend, semantic search ready) returns `null` and is never re-indexed. Only
 * a genuinely broken/legacy store triggers a re-analyze:
 *   - a legacy `.horus/source/kuzu` store while the active backend is SQLite,
 *   - a meta `store_backend` stamp that differs from the active backend,
 *   - an index that serves no semantic vectors (symbols present but 0 embeddings, or an
 *     explicit `embeddings_complete: false`).
 *
 * An absent `store_backend` stamp alone is NOT treated as stale (a healthy pre-stamp SQLite
 * index is fine; horus-source backfills the stamp on host start) — avoiding a spurious
 * re-index of healthy indexes.
 */
export function indexNeedsReanalyze(root: string): string | null {
  if (!isAnalyzed(root)) return null; // "not analyzed" is handled by callers, not "stale"

  // (a) Legacy KùzuDB store present while we expect SQLite: the active store is empty/wrong.
  if (CURRENT_STORE_BACKEND !== 'kuzu' && existsSync(join(root, '.horus', 'source', 'kuzu'))) {
    return 'legacy KùzuDB store present';
  }

  const meta = readSourceMeta(root);
  if (meta === null) return null; // unreadable meta — don't blindly force a re-index

  // (b) Store-backend stamp mismatch (a stamped index written by a different backend).
  if (meta.storeBackend && meta.storeBackend !== CURRENT_STORE_BACKEND) {
    return `store backend changed (${meta.storeBackend} -> ${CURRENT_STORE_BACKEND})`;
  }

  // (c) The index serves no semantic vectors — unsearchable until rebuilt.
  if (!metaHasEmbeddings(meta)) {
    return 'index has no semantic embeddings (symbols present but 0 vectors)';
  }

  return null;
}

/** Run `horus-source analyze .` in the repo. Throws on failure with the REAL cause (HOR-381). */
export async function analyzeRepo(root: string): Promise<void> {
  const bin = await resolveSourceBin();
  if (!bin) throw new Error('horus-source not found on PATH. Install it: curl -fsSL https://horus.sh/install.sh | bash');
  try {
    await exec(bin, ['analyze', '.'], {
      cwd: root,
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // The generic "Command failed: horus-source analyze ." hides both the 900s timeout (hit on
    // large repos in the slow embeddings phase) and horus-source's own stderr. Surface them so
    // `horus init` reports WHY it failed instead of a bare command-failed string (HOR-381).
    const e = err as { killed?: boolean; signal?: string; code?: unknown; stderr?: string; message?: string };
    // stderr can print env-derived URLs (credential-bearing connection strings) —
    // redact BEFORE capping so a conn string straddling the cut can't lose its
    // scheme prefix and escape the pattern.
    const tail = redactSecrets((e.stderr ?? '').trim()).slice(-800);
    if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
      throw new Error(
        `horus-source analyze timed out after 900s (large repo / slow embeddings phase)` +
          (tail ? ` — last output: ${tail}` : ''),
      );
    }
    throw new Error(tail ? `horus-source analyze failed: ${tail}` : redactSecrets(e.message ?? 'horus-source analyze failed'));
  }
}

/**
 * Return the host URL for the source-intelligence backend serving `root`, or null.
 * Reads from `.horus/source/host.json` — the canonical path written by horus-source.
 * The backend runs at most ONE host per repo (single-writer Kùzu lock), so this is
 * the source of truth for "is this repo already being hosted, and where". Different
 * repos get different hosts/ports and run concurrently.
 */
export function readSourceHostUrl(root: string): string | null {
  const p = join(root, '.horus', 'source', 'host.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { host_url?: unknown };
    return typeof j.host_url === 'string' ? j.host_url : null;
  } catch {
    return null;
  }
}

/**
 * The backend's own record of the host process it is running for `root`, read from
 * `.horus/source/host.json` (written by `horus-source host`). The `pid` here is the ACTUAL
 * listening server — which can differ from, and outlive, the spawn-wrapper pid Horus
 * records in `spawned-host.json`. Teardown needs this to signal the real process rather
 * than a stale wrapper pid. Returns null if the file is absent or malformed.
 */
export interface SourceHostRecord {
  pid: number;
  /** Port the backend reports it is serving on, or NaN if absent/invalid. */
  port: number;
  /** Repo the backend reports it is hosting, or '' if absent. */
  repoPath: string;
}

export function readSourceHostPid(root: string): SourceHostRecord | null {
  const p = join(root, '.horus', 'source', 'host.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as {
      pid?: unknown;
      port?: unknown;
      repo_path?: unknown;
    };
    if (typeof j.pid !== 'number' || !Number.isInteger(j.pid) || j.pid <= 0) return null;
    return {
      pid: j.pid,
      port: typeof j.port === 'number' ? j.port : NaN,
      repoPath: typeof j.repo_path === 'string' ? j.repo_path : '',
    };
  } catch {
    return null;
  }
}

/** Is a source-intelligence host reachable + healthy at this base URL? */
export async function isHostHealthy(hostUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${hostUrl}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the repo path a source-intelligence host at `hostUrl` reports it is serving, via
 * `GET /api/host`. Returns the served repo path, or `null` when the host is unreachable,
 * unhealthy, or cannot report its identity (older backend / transient error).
 *
 * HOR-421: the default host URL is `:8420` for every repo, so a host serving a DIFFERENT
 * repo can occupy the configured port. Callers use this to VERIFY a host's identity before
 * grounding on it, so an investigation can never be silently run against a foreign repo's
 * code graph. The wire field is `repoPath` (SourceHostInfo); `repo_path` is also accepted
 * defensively to match the on-disk host.json shape.
 */
export async function fetchHostRepoPath(hostUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${hostUrl}/api/host`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { repoPath?: unknown; repo_path?: unknown };
    if (typeof j.repoPath === 'string' && j.repoPath) return j.repoPath;
    if (typeof j.repo_path === 'string' && j.repo_path) return j.repo_path;
    return null;
  } catch {
    return null;
  }
}

/** Find a free localhost TCP port in [start, end]. */
export async function findFreePort(start = 8420, end = 8520): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port available in ${start}-${end}`);
}

export interface SpawnedHostRecord {
  pid: number;
  port: number;
  root: string;
  startedAt: string;
}

const SPAWNED_HOST_FILE = 'spawned-host.json';

/** Read the PID record Horus wrote when it spawned a source-intelligence host for `root`. */
export function readSpawnedHost(root: string): SpawnedHostRecord | null {
  const p = join(root, '.horus', SPAWNED_HOST_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SpawnedHostRecord;
  } catch {
    return null;
  }
}

/**
 * Spawn `horus-source host --port <port>` as a detached background host in `root`,
 * logging to `.horus/source-host.log`. Records the PID in `.horus/spawned-host.json`
 * for safe teardown. Returns immediately — poll `waitForHost`.
 */
export function startHost(root: string, port: number): void {
  mkdirSync(join(root, '.horus'), { recursive: true });
  const logPath = join(root, '.horus', 'source-host.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(SOURCE_BINARY, ['host', '--port', String(port)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        '\nhorus-source not found on PATH. Install it: curl -fsSL https://horus.sh/install.sh | bash\n',
      );
    }
  });

  if (child.pid !== undefined) {
    const record: SpawnedHostRecord = {
      pid: child.pid,
      port,
      root,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(root, '.horus', SPAWNED_HOST_FILE), JSON.stringify(record, null, 2) + '\n');
  }
  child.unref();
}

/** Remove the spawned-host record for `root`, if it exists. */
export function removeSpawnedHostRecord(root: string): void {
  const p = join(root, '.horus', SPAWNED_HOST_FILE);
  try {
    unlinkSync(p);
  } catch {
    // Not present — nothing to clean up.
  }
}

/**
 * Kill the host process(es) for `root` and remove the spawn record (HOR-372). Reaps BOTH the
 * spawn-wrapper pid (spawned-host.json) AND the detached backend server pid (source/host.json) —
 * the latter actually holds the kùzu single-writer lock and can outlive the wrapper. SIGTERM then
 * SIGKILL, waiting briefly so the lock is RELEASED before a retry re-opens the same kùzu (a failed
 * spawn left running was orphaning the lock and wedging every subsequent start). Best-effort.
 */
export async function killSpawnedHost(root: string): Promise<void> {
  const pids = new Set<number>();
  const spawned = readSpawnedHost(root);
  if (spawned?.pid) pids.add(spawned.pid);
  const backend = readSourceHostPid(root);
  if (backend?.pid) pids.add(backend.pid);
  for (const pid of pids) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        break; // already gone / not permitted — stop escalating this pid
      }
      let dead = false;
      for (let i = 0; i < 15; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          process.kill(pid, 0);
        } catch {
          dead = true;
          break;
        }
      }
      if (dead) break;
    }
  }
  removeSpawnedHostRecord(root);
}

/**
 * Reconcile the ownership record (`spawned-host.json`) with the host the backend ACTUALLY
 * brought up: its real server pid AND the port it really bound.
 *
 * `startHost` can only record the pid + REQUESTED port of the `horus-source host` process it
 * spawned. But under concurrent contention the backend can fall back to a DIFFERENT free port
 * (recording the actual pid + port in `source/host.json`). If the ownership record keeps the
 * requested port, a scoped `horus stop` rejects the host ("ownership record port does not
 * match host URL port") and refuses to stop a host it really did spawn (HOR-409). Adopting the
 * backend's actual pid + port keeps the ownership record authoritative so `horus stop` signals
 * the process that truly holds the port + Kùzu lock.
 *
 * Safe to adopt a different-port backend record here because callers only reconcile AFTER
 * verifying the resolved host serves THIS repo (so the record can't be a foreign/stale one).
 * `actualPort` is the fallback used when the backend record omits a usable port. Only refines
 * an existing record. Best-effort: never throws.
 */
export function reconcileSpawnedHost(root: string, actualPort: number): void {
  try {
    const spawned = readSpawnedHost(root);
    if (!spawned) return;
    const backend = readSourceHostPid(root);
    const pid =
      backend && Number.isInteger(backend.pid) && backend.pid > 0 ? backend.pid : spawned.pid;
    const port =
      backend && Number.isFinite(backend.port) && backend.port > 0 ? backend.port : actualPort;
    if (spawned.pid === pid && spawned.port === port) return;
    const updated: SpawnedHostRecord = { ...spawned, pid, port };
    writeFileSync(
      join(root, '.horus', SPAWNED_HOST_FILE),
      JSON.stringify(updated, null, 2) + '\n',
    );
  } catch {
    // Reconciliation is an optimisation; teardown still has the host.json fallback.
  }
}

/**
 * Wait until a source-intelligence host that VERIFIABLY serves `root` is healthy, and return
 * its URL — or null on timeout.
 *
 * HOR-409 defense-in-depth: a freshly-spawned host can fall back to a DIFFERENT port than the
 * one requested (the requested port may, right now, be a FOREIGN repo's host). A plain health
 * check on the requested URL would happily pass against that foreign host and ground the index
 * on the wrong codebase. So we resolve to the port the backend ACTUALLY bound (recorded in
 * `source/host.json`) and NEVER return a host that reports a different repo. The requested URL
 * is also probed so the normal no-contention case resolves immediately; a host that cannot
 * report its identity (older backend → `null`) is accepted, but a KNOWN-foreign one never is.
 */
export async function waitForOwnHost(
  root: string,
  requestedUrl: string,
  timeoutMs = 45_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const servesThisRepo = async (url: string): Promise<boolean> => {
    const served = await fetchHostRepoPath(url);
    // null = host can't report its repo (older backend / transient) → accept conservatively;
    // a healthy FOREIGN host reports a different path → reject.
    return served === null || resolve(served) === resolve(root);
  };
  while (Date.now() < deadline) {
    // Prefer the port the backend actually bound (host.json); fall back to the requested URL.
    const candidates: string[] = [];
    const recorded = readSourceHostUrl(root);
    if (recorded) candidates.push(recorded);
    if (!candidates.includes(requestedUrl)) candidates.push(requestedUrl);
    for (const url of candidates) {
      if (await isHostHealthy(url)) {
        if (await servesThisRepo(url)) return url;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** Poll a host's health until it responds or the timeout elapses. */
export async function waitForHost(hostUrl: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostHealthy(hostUrl)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
