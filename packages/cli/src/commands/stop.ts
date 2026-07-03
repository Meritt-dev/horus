/**
 * `horus stop` — stop the source-intelligence host(s) spawned by Horus for the
 * current repo (HOR-41). Stopping is never required for correctness — per-repo
 * hosts are independent. This is ergonomics/resource hygiene.
 *
 * Safety model:
 *  1. Read `.horus/spawned-host.json` (written by `startHost` at spawn time).
 *  2. Verify the PID is genuinely THIS repo's `horus-source host` — its argv either matches
 *     `horus-source host --port <port>` on the resolved port, OR (when the backend fell back
 *     from a contended port and so keeps the REQUESTED port in its argv while binding the
 *     BOUND port) it is a `horus-source host` whose identity the backend's own record
 *     (`source/host.json`) corroborates on pid + bound port + repo (HOR-409 cleanup gap).
 *     This handles Python-backed executables where comm= returns the interpreter.
 *  3. Guard against PID reuse: compare the process's elapsed time (etimes=)
 *     against the recorded startedAt, rejecting divergences > 60 s.
 *  4. Only then send SIGTERM.
 *  5. Remove the spawned-host record on success.
 *
 * No fallback to an unowned lsof-discovered PID is provided — we will not
 * signal a process we cannot prove Horus spawned.
 */

import { execFile } from 'node:child_process';
import { unlink } from 'node:fs';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import pc from 'picocolors';
import { findRepoRoot, readRegistry, HORUS_DIR } from '@horus/core';
import {
  readSourceHostUrl,
  isHostHealthy,
  readSpawnedHost,
  readSourceHostPid,
  type SpawnedHostRecord,
} from '@horus/connectors';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(unlink);

export interface StopOpts {
  all?: boolean;
}

const SPAWNED_HOST_FILE = 'spawned-host.json';
/** Tolerated drift between recorded start time and measured elapsed time (seconds). */
const START_TIME_TOLERANCE_S = 60;
/** How long to wait after SIGTERM for the process to exit. */
const STOP_WAIT_MS = 5_000;
/** How long to wait after escalating to SIGKILL before giving up (HOR-364). */
const STOP_KILL_WAIT_MS = 3_000;
/** Poll interval when waiting for a process to exit. */
const STOP_POLL_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runStop(opts: StopOpts): Promise<number> {
  try {
    if (opts.all) {
      return await stopAll();
    }
    const cwd = process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const hostUrl = readSourceHostUrl(root);
    if (!hostUrl) {
      console.log(pc.dim('No source-intelligence host found for this repo (.horus/source/host.json absent).'));
      return 0;
    }
    return await stopHost(root, hostUrl);
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

async function stopHost(root: string, hostUrl: string): Promise<number> {
  const port = extractPort(hostUrl);
  if (port === null) {
    console.error(pc.red(`Cannot determine port from host URL: ${hostUrl}`));
    return 1;
  }

  const healthy = await isHostHealthy(hostUrl);
  if (!healthy) {
    // A failing /api/health does NOT prove the process is gone. A host can crash mid-index
    // yet keep its port bound and hold the Kùzu single-writer lock — in which case the next
    // `horus init` can't acquire it and keeps re-using the broken host. So only declare
    // "already stopped" when we own no still-running process; otherwise fall through and
    // terminate the stuck host (its identity is still verified before we signal it).
    const owned = readSpawnedHost(root);
    const wrapperAlive = owned !== null && (await getProcessInfo(owned.pid)) !== null;
    if (!wrapperAlive) {
      // The spawn-wrapper pid Horus recorded is gone — but `horus-source host` detaches the
      // real server under a DIFFERENT pid (recorded by the backend in source/host.json) that
      // can outlive the wrapper and keep the port + Kùzu lock held. Stop that server before
      // concluding the host is down — otherwise `horus stop` reports success while the host
      // is still listening (the exact zombie that blocks the next `horus init`).
      const res = await stopBackendServerPid(root, port);
      if (res === 'failed') return 1;
      if (res !== 'stopped') console.log(pc.dim(`Host ${hostUrl} is already stopped.`));
      await cleanupSpawnedRecord(root);
      return 0;
    }
    console.log(
      pc.dim(
        `Host ${hostUrl} is unreachable but pid ${owned!.pid} is still running — ` +
          `terminating a stuck host.`,
      ),
    );
  }

  const spawned = readSpawnedHost(root);
  if (spawned === null) {
    console.error(
      pc.red(
        `No ownership record found (.horus/${SPAWNED_HOST_FILE} absent). ` +
          'Horus will not stop a host it did not spawn.',
      ),
    );
    return 1;
  }

  // --- validate record structure before using any value from it ---
  const recordError = validateSpawnedRecord(spawned);
  if (recordError !== null) {
    console.error(pc.red(`Ownership record is malformed: ${recordError}. Aborting for safety.`));
    return 1;
  }

  if (spawned.port !== port) {
    console.error(
      pc.red(
        `Ownership record port (${spawned.port}) does not match host URL port (${port}). ` +
          'Record may be stale.',
      ),
    );
    return 1;
  }

  if (spawned.root !== root) {
    console.error(
      pc.red(
        `Ownership record root (${spawned.root}) does not match resolved root (${root}). ` +
          'Record may be stale.',
      ),
    );
    return 1;
  }

  // --- verify process identity ---
  const info = await getProcessInfo(spawned.pid);
  if (info === null) {
    // The wrapper pid exited between the health check and here (a race) — but the detached
    // backend server (source/host.json) may still be alive, so try it before reporting
    // success.
    const res = await stopBackendServerPid(root, port);
    if (res === 'failed') return 1;
    if (res !== 'stopped') {
      console.log(pc.dim(`Process pid ${spawned.pid} is no longer running — already stopped.`));
    }
    await cleanupSpawnedRecord(root);
    return 0;
  }

  if (!isOwnHostProcess(spawned.pid, port, root, info.args)) {
    console.error(
      pc.red(
        `Pid ${spawned.pid} args do not match "horus-source host --port ${port}". ` +
          `Got: "${info.args.slice(0, 120)}". Aborting for safety.`,
      ),
    );
    return 1;
  }

  // Elapsed time check: guard against PID reuse.
  // validateSpawnedRecord() guarantees startedAt parses to a valid past timestamp,
  // so startTs is finite and < Date.now().
  const startTs = new Date(spawned.startedAt).getTime();
  const recordedAgeS = Math.round((Date.now() - startTs) / 1000);
  if (!Number.isFinite(info.etimeSeconds)) {
    console.error(pc.red(`Could not read elapsed time for pid ${spawned.pid}. Aborting for safety.`));
    return 1;
  }
  if (Math.abs(info.etimeSeconds - recordedAgeS) > START_TIME_TOLERANCE_S) {
    console.error(
      pc.red(
        `Pid ${spawned.pid} age mismatch: record says ~${recordedAgeS}s, ` +
          `process reports ${info.etimeSeconds}s elapsed. Possible PID reuse — aborting for safety.`,
      ),
    );
    return 1;
  }

  // SIGTERM, then escalate to SIGKILL if the host refuses to exit — a host that ignores
  // SIGTERM must not be left holding the port + Kùzu lock (HOR-364).
  let terminated: boolean;
  try {
    terminated = await terminatePid(spawned.pid);
  } catch (err) {
    console.error(pc.red(`Failed to signal pid ${spawned.pid}: ${(err as Error).message}`));
    return 1;
  }
  if (!terminated) {
    console.error(
      pc.red(`Host pid ${spawned.pid} did not exit even after SIGKILL — could not reclaim the port.`),
    );
    return 1;
  }
  console.log(
    `${pc.green('✓')} Stopped source-intelligence host ` +
      pc.dim(`(pid ${spawned.pid}, port ${port})`) +
      ` for ${root}`,
  );

  // The wrapper we recorded is down — but the detached backend server can be a separate,
  // still-listening pid. Reap it too so the port + Kùzu lock are actually released.
  if (await stopBackendServerPid(root, port) === 'failed') return 1;

  await cleanupSpawnedRecord(root);
  return 0;
}

/**
 * Build the argv matcher for a horus-source host on `port`. Requirements:
 *  - optional path prefix (handles /home/user/.local/bin/horus-source, a Python entrypoint)
 *  - binary then `host` then `--port` in that ORDER (not independent substrings)
 *  - port followed by whitespace or EOL so 8420 does not match 84200
 *  - `port` is an integer, so it carries no regex metacharacters
 */
function hostArgvRegex(port: number): RegExp {
  return new RegExp(
    `(?:^|\\s)(?:\\S*/)?horus-source\\s+host\\s+--port(?:=|\\s+)${String(port)}(?=\\s|$)`,
  );
}

/**
 * Like {@link hostArgvRegex} but matches a `horus-source host --port <any-int>` — used to prove
 * a pid is genuinely a host process when the literal port in its argv may not equal the resolved
 * (bound) port. The discrepancy is real: under port contention `horus-source host --port N` binds
 * a DIFFERENT free port and records THAT in `source/host.json`, yet its own argv still shows the
 * REQUESTED port N. The exact-port matcher then rejects a host Horus genuinely spawned.
 */
function hostArgvAnyPortRegex(): RegExp {
  return /(?:^|\s)(?:\S*\/)?horus-source\s+host\s+--port(?:=|\s+)\d+(?=\s|$)/;
}

/**
 * Decide whether `pid` (whose argv is `args`) is THIS repo's source host on the resolved
 * (bound) `port`, so it is safe to signal.
 *
 *  - Fast path: the argv matches `horus-source host --port <port>` exactly — the common
 *    no-contention case.
 *  - Port-fallback path (HOR-409 cleanup gap that left dramatiq/sanic hosts running after
 *    `horus stop`): when the backend bumped off a contended port, its argv keeps the REQUESTED
 *    port while it actually bound — and recorded in `source/host.json` — a DIFFERENT port. Accept
 *    the pid only when it is unmistakably a `horus-source host` process AND the backend's own
 *    record positively corroborates this exact pid serving THIS repo on the resolved port, so the
 *    sole discrepancy is requested-vs-bound port. PID-reuse is still caught by the elapsed-time
 *    guard that runs after this check.
 */
function isOwnHostProcess(pid: number, port: number, root: string, args: string): boolean {
  if (hostArgvRegex(port).test(args)) return true;
  if (!hostArgvAnyPortRegex().test(args)) return false;
  const rec = readSourceHostPid(root);
  return (
    rec !== null &&
    rec.pid === pid &&
    Number.isFinite(rec.port) &&
    rec.port === port &&
    !!rec.repoPath &&
    resolve(rec.repoPath) === resolve(root)
  );
}

/** Remove the spawn-wrapper ownership record. Best-effort; a missing file is benign. */
async function cleanupSpawnedRecord(root: string): Promise<void> {
  try {
    await unlinkAsync(join(root, HORUS_DIR, SPAWNED_HOST_FILE));
  } catch {
    // Not fatal — missing record is benign on the next invocation.
  }
}

/**
 * Stop the detached backend host server recorded in `.horus/source/host.json` for this
 * repo+port, if one is still alive. This is the process that actually holds the TCP port
 * and the Kùzu single-writer lock, and it can outlive the spawn-wrapper pid Horus tracks.
 *
 * Ownership is proven before signalling: the pid's argv must match
 * `horus-source host --port <port>`, and the record's port/repo must match what we are
 * stopping. Returns 'stopped' (we signalled it and it exited), 'failed' (signalled but it
 * would not die, or the record's identity could not be trusted), or 'none' (nothing alive
 * and owned to stop).
 */
type BackendStopResult = 'stopped' | 'failed' | 'none';

async function stopBackendServerPid(root: string, port: number): Promise<BackendStopResult> {
  const rec = readSourceHostPid(root);
  if (!rec) return 'none';
  // Only act when the backend's own record agrees on port and repo — otherwise it is a
  // stale or unrelated record and we must not signal off it.
  if (Number.isFinite(rec.port) && rec.port !== port) return 'none';
  if (rec.repoPath && rec.repoPath !== root) return 'none';

  const info = await getProcessInfo(rec.pid);
  if (info === null) return 'none'; // already gone

  if (!isOwnHostProcess(rec.pid, port, root, info.args)) {
    // The pid is alive but is NOT our host — it was REUSED by another process after our host
    // already exited. Our host is gone and the record is merely stale: don't signal the
    // unrelated process, and DON'T count this as a stop failure (HOR-378). It's "already gone",
    // not a failure — this was the source of `stop --all`'s phantom "N failed".
    console.log(
      pc.dim(
        `Host pid ${rec.pid} is now an unrelated process (stale source/host.json / PID reuse) — host already gone.`,
      ),
    );
    return 'none';
  }

  let terminated: boolean;
  try {
    terminated = await terminatePid(rec.pid);
  } catch (err) {
    console.error(pc.red(`Failed to signal pid ${rec.pid}: ${(err as Error).message}`));
    return 'failed';
  }
  if (!terminated) {
    console.error(
      pc.red(`Host pid ${rec.pid} did not exit even after SIGKILL — could not reclaim the port.`),
    );
    return 'failed';
  }
  console.log(
    `${pc.green('✓')} Stopped source-intelligence host ` +
      pc.dim(`(pid ${rec.pid}, port ${port})`) +
      ` for ${root}`,
  );
  return 'stopped';
}

async function stopAll(): Promise<number> {
  const registry = readRegistry();
  const projects = Object.entries(registry.projects);
  if (projects.length === 0) {
    console.log(pc.dim('No registered projects.'));
    return 0;
  }

  let stopped = 0;
  let failed = 0;
  for (const [name, entry] of projects) {
    const hostUrl = readSourceHostUrl(entry.root);
    if (!hostUrl) continue;
    // Something to stop if the host is healthy OR we still hold a record for it — either
    // the spawn-wrapper record or the backend's own host.json (a crashed host fails the
    // health check but may be alive and holding the port; stopHost sorts out which). Skip
    // only when none of these is present.
    const healthy = await isHostHealthy(hostUrl);
    if (
      !healthy &&
      readSpawnedHost(entry.root) === null &&
      readSourceHostPid(entry.root) === null
    ) {
      continue;
    }
    console.log(`  Stopping ${pc.bold(name)} ${pc.dim(`(${hostUrl})`)}`);
    const code = await stopHost(entry.root, hostUrl);
    if (code === 0) stopped++;
    else failed++;
  }

  if (stopped === 0 && failed === 0) {
    console.log(pc.dim('No running source-intelligence hosts found.'));
  } else {
    console.log(
      `\nStopped ${stopped} host(s)${failed > 0 ? pc.red(`, ${failed} failed`) : ''}.`,
    );
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Record validation
// ---------------------------------------------------------------------------

/**
 * Structurally validate the spawned-host record before any value is used.
 * Returns a human-readable error string, or null if the record is valid.
 */
function validateSpawnedRecord(r: SpawnedHostRecord): string | null {
  if (!Number.isInteger(r.pid) || r.pid <= 0) {
    return `invalid pid ${r.pid}`;
  }
  if (!Number.isInteger(r.port) || r.port <= 0 || r.port > 65535) {
    return `invalid port ${r.port}`;
  }
  if (!r.root || typeof r.root !== 'string') {
    return 'root is empty or not a string';
  }
  if (!r.startedAt || typeof r.startedAt !== 'string') {
    return 'startedAt is missing or not a string';
  }
  const ts = new Date(r.startedAt).getTime();
  if (!Number.isFinite(ts)) {
    return `startedAt is not a valid date: "${r.startedAt}"`;
  }
  if (ts > Date.now()) {
    return `startedAt is in the future: "${r.startedAt}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process info
// ---------------------------------------------------------------------------

/**
 * Terminate an already-identity-verified host pid: SIGTERM, wait, then escalate to SIGKILL
 * if it refuses to exit, so the port + Kùzu lock are actually released (HOR-364 — a host that
 * survived SIGTERM used to be left running). Returns true once the process is gone; throws
 * only on an unexpected (non-ESRCH) kill error.
 */
async function terminatePid(pid: number): Promise<boolean> {
  const escalation: { signal: NodeJS.Signals; waitMs: number }[] = [
    { signal: 'SIGTERM', waitMs: STOP_WAIT_MS },
    { signal: 'SIGKILL', waitMs: STOP_KILL_WAIT_MS },
  ];
  for (const { signal, waitMs } of escalation) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; // already gone
      throw err;
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(STOP_POLL_MS);
      if ((await getProcessInfo(pid)) === null) return true;
    }
  }
  return (await getProcessInfo(pid)) === null;
}

interface ProcessInfo {
  args: string;
  etimeSeconds: number;
}

/**
 * Read the full argument string and elapsed time (in seconds) for a PID.
 * Returns null ONLY when the process does not exist (no argv) — liveness is determined by
 * `args` alone, never by elapsed time, so a still-running process is never mistaken for
 * dead just because its age could not be read.
 *
 *  - `args=`  — full argv joined by spaces; handles Python-backed CLI wrappers where
 *               `comm=` would return the interpreter name.
 *  - `etime=` — process age, used to detect PID reuse against the recorded startedAt.
 *               We use `etime` (formatted), NOT `etimes` (raw seconds): `etimes` is a
 *               Linux/procps keyword that ERRORS on macOS ("etimes: keyword not found"),
 *               which previously made every lookup fail and `horus stop` wrongly report a
 *               live host as "already stopped". `etime` is portable across macOS and Linux.
 */
async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  let args: string;
  try {
    const argsResult = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
      timeout: 3000,
    });
    args = argsResult.stdout.trim();
  } catch {
    return null; // `ps -p` exits non-zero when the pid does not exist
  }
  if (!args) return null;

  // Elapsed time is best-effort: the process is already proven alive by `args`. A parse
  // failure leaves etimeSeconds NaN, which callers treat as "can't verify age" (and abort
  // for safety) rather than "process gone".
  let etimeSeconds = Number.NaN;
  try {
    const etimeResult = await execFileAsync('ps', ['-p', String(pid), '-o', 'etime='], {
      timeout: 3000,
    });
    etimeSeconds = parseEtimeSeconds(etimeResult.stdout.trim());
  } catch {
    // leave NaN — process is still alive (args present)
  }
  return { args, etimeSeconds };
}

/** Parse a ps `etime` field (`[[dd-]hh:]mm:ss`) to seconds, or NaN if it does not match. */
function parseEtimeSeconds(etime: string): number {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return Number.NaN;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function extractPort(hostUrl: string): number | null {
  try {
    const p = parseInt(new URL(hostUrl).port, 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}
