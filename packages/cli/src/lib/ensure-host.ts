/**
 * HOR-319 (Bug 2) — self-heal a down source-intelligence host.
 *
 * `horus investigate` used to exit 1 the moment `code.health()` failed. Instead we try
 * to restart a previously-indexed host at its configured port before giving up, so a
 * transient host outage degrades into a brief auto-start rather than a dead end.
 *
 * This composes the canonical host-lifecycle primitives owned by HOR-SOURCE
 * (@horus/connectors) — it does NOT reimplement host management, and it never performs
 * first-time analysis (that remains the job of `horus init`).
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  isHostHealthy,
  sourceAvailable,
  assertSourceVersionPinned,
  isAnalyzed,
  startHost,
  waitForHost,
  removeSpawnedHostRecord,
  reconcileSpawnedHost,
  fetchHostRepoPath,
  readSourceHostUrl,
  findFreePort,
} from '@horus/connectors';

export type EnsureHostReason =
  | 'source-unavailable'
  | 'version-mismatch'
  | 'not-analyzed'
  | 'bad-url'
  | 'no-free-port'
  | 'unhealthy';

export interface EnsureHostResult {
  ok: boolean;
  /** The healthy host URL when ok === true. */
  hostUrl?: string;
  /** Why a self-heal attempt could not proceed, when ok === false. */
  reason?: EnsureHostReason;
}

/** Parse the TCP port from a host URL (e.g. `http://127.0.0.1:8420` → 8420). */
export function parseHostPort(hostUrl: string): number | null {
  try {
    const port = parseInt(new URL(hostUrl).port, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Human-readable next step for why a self-heal attempt could not proceed. */
export function ensureHostReasonHint(reason: EnsureHostReason | undefined): string {
  switch (reason) {
    case 'source-unavailable':
      return 'horus-source is not installed — install it: curl -fsSL https://horus.sh/install.sh | bash';
    case 'version-mismatch':
      return 'the installed horus-source backend does not match the version Horus is pinned to — reinstall the pinned version (run `horus status` to see it)';
    case 'not-analyzed':
      return 'this repo has not been indexed yet — run: horus init';
    case 'bad-url':
      return 'the configured source host URL is not a valid URL';
    case 'no-free-port':
      return 'no free localhost port was available to start this repo’s own source host';
    default:
      return 'the host did not become healthy — run: horus init';
  }
}

/** Identity verdict for a source host relative to a target repo (HOR-421). */
export type HostRepoVerdict =
  /** The host reports it serves THIS repo. */
  | 'match'
  /** The host serves a DIFFERENT repo — grounding on it would investigate foreign code. */
  | 'foreign'
  /** The host could not report its identity (unreachable / older backend). */
  | 'unknown';

/**
 * HOR-421: does the source host at `hostUrl` serve `root`?
 *
 * The default host URL is `:8420` for every repo, so a host serving a DIFFERENT repo can
 * occupy the configured port. Before grounding an investigation we VERIFY identity: a
 * `foreign` verdict means the host belongs to another repo and must never be used. `unknown`
 * (the host can't report its repo) is treated conservatively by callers — we do not assume a
 * match, but we also don't reclassify an ambiguous host as foreign (which could trigger a
 * second host that collides on the same repo's single-writer Kùzu lock).
 */
export async function verifyHostServesRepo(
  hostUrl: string,
  root: string,
): Promise<HostRepoVerdict> {
  const served = await fetchHostRepoPath(hostUrl);
  if (served === null) return 'unknown';
  return resolve(served) === resolve(root) ? 'match' : 'foreign';
}

/**
 * HOR-421: resolve a source host that is VERIFIED to serve `root` — never a foreign one —
 * by starting this repo's OWN host on a free port when needed.
 *
 *  1. Reuse the repo's own recorded host (`.horus/source/host.json`) when it is healthy AND
 *     its identity matches — the single-writer backend records the canonical "where MY repo
 *     is hosted", which may differ from the (shared) configured default port.
 *  2. Otherwise spawn this repo's own host on a FREE port (never the configured port, which a
 *     foreign host is occupying) and verify its identity before returning it.
 *
 * Applies the same guard rails as {@link ensureSourceHost} (backend installed, version
 * pinned, repo analyzed) before spawning, and never performs first-time analysis.
 */
export async function ensureOwnSourceHost(
  root: string,
  opts: { timeoutMs?: number } = {},
): Promise<EnsureHostResult> {
  // 1) The repo's own recorded host, if it is up and genuinely serving this repo.
  const ownUrl = readSourceHostUrl(root);
  if (
    ownUrl &&
    (await isHostHealthy(ownUrl)) &&
    (await verifyHostServesRepo(ownUrl, root)) === 'match'
  ) {
    return { ok: true, hostUrl: ownUrl };
  }

  // Need to spawn — mirror ensureSourceHost's guard rails so we never launch a drifted or
  // un-analyzed backend.
  if (!(await sourceAvailable())) return { ok: false, reason: 'source-unavailable' };
  try {
    await assertSourceVersionPinned();
  } catch {
    return { ok: false, reason: 'version-mismatch' };
  }
  if (!isAnalyzed(root)) return { ok: false, reason: 'not-analyzed' };

  // 2) Spawn on a free port — NOT the configured port, which a foreign host is holding.
  let port: number;
  try {
    port = await findFreePort();
  } catch {
    return { ok: false, reason: 'no-free-port' };
  }
  const hostUrl = `http://127.0.0.1:${port}`;
  startHost(root, port);
  if (await waitForHost(hostUrl, opts.timeoutMs ?? 20_000)) {
    // Defensive: we just spawned this for `root`, but never return a host whose identity
    // doesn't match — a foreign answer here means something is badly wrong; refuse it.
    if ((await verifyHostServesRepo(hostUrl, root)) === 'foreign') {
      removeSpawnedHostRecord(root);
      return { ok: false, reason: 'unhealthy' };
    }
    reconcileSpawnedHost(root, port);
    return { ok: true, hostUrl };
  }
  removeSpawnedHostRecord(root);
  return { ok: false, reason: 'unhealthy' };
}

/**
 * HOR-319 + HOR-421: resolve a source host URL that is healthy AND verified to serve `root`.
 *
 * This is the single host-selection entry point for grounding an investigation:
 *  - Self-heals a down host at the configured port (HOR-319 layer 1).
 *  - Then VERIFIES the healthy host actually serves `root`. If it serves a DIFFERENT repo
 *    (cross-repo contamination — HOR-421) it is rejected and this repo's OWN host is started
 *    on a free port instead. The returned `hostUrl` may therefore differ from `configuredUrl`.
 *
 * Returns the verified host URL on success, or a failure reason — the caller degrades to a
 * runtime-only investigation rather than ever grounding on a foreign repo's host.
 */
export async function resolveSourceHostUrl(
  root: string,
  configuredUrl: string,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<EnsureHostResult> {
  const log = opts.log ?? (() => {});
  const healOpts = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};

  // Self-heal the configured host if it is down (HOR-319 layer 1).
  let healthyUrl: string | null = null;
  if (await isHostHealthy(configuredUrl)) {
    healthyUrl = configuredUrl;
  } else {
    log(
      pc.yellow(
        `Source-intelligence host unreachable (${configuredUrl}) — attempting to start it…`,
      ),
    );
    const healed = await ensureSourceHost(root, configuredUrl, healOpts);
    if (healed.ok && healed.hostUrl) {
      log(pc.green(`Source-intelligence host is up at ${healed.hostUrl}.`));
      healthyUrl = healed.hostUrl;
    } else {
      log(pc.dim(`  ${ensureHostReasonHint(healed.reason)}`));
    }
  }

  if (!healthyUrl) return { ok: false, reason: 'unhealthy' };

  // HOR-421 contamination guard: never ground on a host serving a DIFFERENT repo.
  const verdict = await verifyHostServesRepo(healthyUrl, root);
  if (verdict !== 'foreign') return { ok: true, hostUrl: healthyUrl };

  log(
    pc.red(
      `Source-intelligence host at ${healthyUrl} is serving a DIFFERENT repository — ` +
        `refusing to ground this investigation on foreign code.`,
    ),
  );
  const own = await ensureOwnSourceHost(root, healOpts);
  if (own.ok && own.hostUrl) {
    log(pc.green(`Started this repo's own source-intelligence host at ${own.hostUrl}.`));
    return own;
  }
  log(pc.dim(`  ${ensureHostReasonHint(own.reason)}`));
  return { ok: false, reason: own.reason ?? 'unhealthy' };
}

/**
 * Try to make the source-intelligence host at `hostUrl` healthy, restarting it at the
 * SAME port if it is down — so an existing CodeProvider pointed at `hostUrl` keeps
 * working without a rebuild. Only restarts a repo that is already analyzed; it never
 * triggers first-time analysis.
 */
export async function ensureSourceHost(
  root: string,
  hostUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<EnsureHostResult> {
  // Maybe it recovered between the caller's health check and now.
  if (await isHostHealthy(hostUrl)) return { ok: true, hostUrl };

  // We can only restart a real, analyzed repo with the source backend installed.
  if (!(await sourceAvailable())) return { ok: false, reason: 'source-unavailable' };
  // Never restart a host with a drifted backend — it would re-corrupt the graph the same
  // way `horus init` would. Mirror that guard here so self-heal can't smuggle one in.
  try {
    await assertSourceVersionPinned();
  } catch {
    return { ok: false, reason: 'version-mismatch' };
  }
  if (!isAnalyzed(root)) return { ok: false, reason: 'not-analyzed' };

  const port = parseHostPort(hostUrl);
  if (port === null) return { ok: false, reason: 'bad-url' };

  startHost(root, port);
  if (await waitForHost(hostUrl, opts.timeoutMs ?? 20_000)) {
    // Make the ownership record point at the backend's real server pid + actual bound port
    // (host.json) so a later `horus stop` signals the process that truly holds the port +
    // Kùzu lock — even if the host fell back to a different port than requested (HOR-409).
    reconcileSpawnedHost(root, port);
    return { ok: true, hostUrl };
  }

  // Never became healthy — drop the ownership record so `horus stop` doesn't chase a
  // dead PID (mirrors index-repo's behaviour on a failed spawn).
  removeSpawnedHostRecord(root);
  return { ok: false, reason: 'unhealthy' };
}
