/**
 * HOR-364 — orphaned source-host reaper.
 *
 * `horus hosts` only knows about REGISTERED projects. A `horus-source host --port N` process
 * whose owning record is gone — repo unregistered, host crashed/restarted, or a DUPLICATE
 * bound near a port another host already claims — is invisible to it, yet still holds memory +
 * a Kùzu lock. Stacked up, these wedge the machine (observed: two hosts on 8420). This finds
 * such orphans by scanning for `horus-source host` processes whose pid isn't recorded by any
 * registered repo, and reaps them. Only processes whose argv unmistakably matches a Horus
 * source host are ever considered — we never signal an unrelated process.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunningHost {
  pid: number;
  port: number;
}

/** Matches a `horus-source host --port <N>` argv (optional path prefix), capturing the port. */
const HOST_ARGV = /(?:^|\s)(?:\S*\/)?horus-source\s+host\s+--port(?:=|\s+)(\d+)(?=\s|$)/;

/** Parse `ps -axww -o pid=,args=` output into the running source-host processes. Pure. */
export function parseSourceHosts(psStdout: string): RunningHost[] {
  const hosts: RunningHost[] = [];
  for (const line of psStdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const m = HOST_ARGV.exec(trimmed.slice(sp + 1));
    if (!m) continue;
    hosts.push({ pid, port: Number(m[1]) });
  }
  return hosts;
}

/**
 * Pure: a running host whose pid is not claimed by any registered repo is an orphan.
 * Matching on pid (not port) catches a duplicate bound to a port another host already owns.
 */
export function selectOrphans(running: RunningHost[], claimedPids: Set<number>): RunningHost[] {
  return running.filter((h) => !claimedPids.has(h.pid));
}

/** Discover running source-host processes via `ps` (best-effort; [] on any error). */
export async function listRunningSourceHosts(): Promise<RunningHost[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,args='], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    return parseSourceHosts(stdout);
  } catch {
    return [];
  }
}

/** Is `pid` alive? Uses signal 0 (no-op probe). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it → treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Back-compat internal alias. */
const isAlive = isPidAlive;

/**
 * A registered host as `horus hosts` sees it: a registry entry plus what we actually probed
 * about the process behind it. `hostUrl`/`pid`/`port` come from the repo's host records;
 * `healthy` is the HTTP `/api/health` result; `pidAlive` is a signal-0 liveness probe of the
 * recorded pid (null when no pid is recorded).
 */
export interface RegisteredHostState {
  name: string;
  hostUrl: string | null;
  pid: number | null;
  port: number | null;
  healthy: boolean;
  pidAlive: boolean | null;
  /**
   * Does the live host at `hostUrl` actually serve THIS entry's repo? (dogfood
   * finding 5: the default port is shared, so a healthy FOREIGN host on the port
   * made every entry read "running".) `null` = identity unknown (host down, or an
   * older backend that can't report it — treated as matching for back-compat).
   */
  servesRepo?: boolean | null;
}

/**
 * Is this registered host backed by a LIVE process? (HOR-389)
 *
 * Authoritative signal is the HTTP health check: a reachable `/api/health` means a server is
 * up. As a fallback — when no host URL is recorded to probe — a recorded pid that is still
 * alive also counts as live. A stale entry (process gone: health fails and pid dead/absent)
 * is NOT live.
 */
export function isLiveRegisteredHost(h: RegisteredHostState): boolean {
  // A healthy port is NOT enough: the host must serve this entry's repo
  // (identity from GET /api/host), or be unable to report identity (null).
  if (h.healthy) return h.servesRepo !== false;
  if (h.hostUrl === null && h.pidAlive === true) return true;
  return false;
}

/**
 * Count DISTINCT live source-host PROCESSES among registered hosts (HOR-389).
 *
 * The backend runs at most one host per repo, but several registry entries can resolve to the
 * SAME running process (e.g. many repos whose host.json points at one shared port, or a stale +
 * a fresh entry for the same pid). Counting registry rows then reports "40 hosts running" when a
 * single process exists. We dedupe by the underlying process identity — pid when known, else
 * port, else name — so each live process is counted exactly once.
 */
export function countDistinctLiveHosts(hosts: RegisteredHostState[]): number {
  const seen = new Set<string>();
  for (const h of hosts) {
    if (!isLiveRegisteredHost(h)) continue;
    const key =
      h.pid != null ? `pid:${h.pid}` : h.port != null ? `port:${h.port}` : `name:${h.name}`;
    seen.add(key);
  }
  return seen.size;
}

/** SIGTERM then escalate to SIGKILL; resolves true once the pid is gone. */
export async function reapPid(
  pid: number,
  opts: { termMs?: number; killMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const termMs = opts.termMs ?? 4000;
  const killMs = opts.killMs ?? 3000;
  const pollMs = opts.pollMs ?? 200;
  for (const [signal, wait] of [
    ['SIGTERM', termMs],
    ['SIGKILL', killMs],
  ] as const) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; // already gone
    }
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (!isAlive(pid)) return true;
    }
  }
  return !isAlive(pid);
}
