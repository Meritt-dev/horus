/**
 * Bounded git change collector for investigation input (HOR-93).
 *
 * Accepts a repo path + a "since" value (duration, ISO date, or commit ref)
 * and returns a bounded summary of commits + per-file diff stats. Hard limits
 * on files, commits, and bytes prevent large repositories from generating
 * unbounded investigation input.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitLog } from '@horus/connectors';
import type { GitCommit } from '@horus/connectors';

const exec = promisify(execFile);

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_COMMITS = 50;
const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = 50_000;

/**
 * Default look-back window (in days) used when no explicit `--since` is supplied but a
 * repo path is available (HOR-333). Auto-enables change analysis + the deployment-regression
 * hypothesis without changing explicit-since behaviour.
 */
export const DEFAULT_CHANGE_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitChangeQuery {
  repoPath: string;
  /** Duration ("24 hours ago", "2 days ago"), ISO date, or commit ref/SHA. */
  since: string;
  until?: string;
  maxCommits?: number;
  maxFiles?: number;
  /** Byte cap on the total serialised size of fileStats entries. */
  maxBytes?: number;
}

export interface FileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface BoundedGitChange {
  commits: GitCommit[];
  fileStats: FileStat[];
  changedFiles: string[];
  totalInsertions: number;
  totalDeletions: number;
  window: { since: string; until: string | undefined };
  truncated: boolean;
  truncatedReason?: string;
  /**
   * HOR-423: the diff against the base carries NO usable change signal and must never drive a
   * deployment-regression conclusion. True when the base was wrong/absent (a root or shallow-clone
   * boundary where the first parent cannot be resolved), the diff is a +0/-0 no-op across the
   * files it reports (pure merge / rename / mode-only), or it "over-reaches" — reporting far more
   * files than the in-window commits actually touched (e.g. a merge dragging an entire long-lived
   * branch into the endpoint diff, or a checkout/vendor bump). Consumers treat a degenerate change
   * window as if no change evidence existed. Absent ⇒ false (a usable change window).
   */
  degenerate?: boolean;
  /** Human-readable reason a window was flagged {@link degenerate}. Absent when not degenerate. */
  degenerateReason?: string;
}

// ── Degenerate-diff thresholds (HOR-423) ────────────────────────────────────────

/**
 * A diff "over-reaches" — signalling a wrong/too-far base — when it reports at least this many
 * files AND that file count dwarfs (by {@link OVERREACH_FACTOR}×) what the in-window commits
 * actually touched. The floor avoids flagging small, legitimately-broad commits.
 */
const OVERREACH_MIN_FILES = 20;
const OVERREACH_FACTOR = 4;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return true when `s` looks like a git ref (SHA or ref name) rather than a
 * date/duration.  Conservative: only matches hex-only strings (7–40 chars) or
 * slash-free single-word tokens that are not purely numeric or time-like.
 * Date/time strings always contain a colon, space, dash sequence, or the word
 * "ago" — those are excluded.
 */
export function isRefLike(s: string): boolean {
  const t = s.trim();
  // Reject flag-like strings and range notation embedded in a ref value.
  if (t.startsWith('-')) return false;
  if (t.includes('..')) return false;
  // ISO date, "N days ago", "N hours ago", "yesterday", etc.
  if (/\s|:|ago|yesterday|week|month|year|=/i.test(t)) return false;
  // Duration strings like "24h", "7d", "30m", "90s" — log window specifiers,
  // not git refs.
  if (/^\d+[smhd]$/i.test(t)) return false;
  // Pure hex SHA (7–40 chars)
  if (/^[0-9a-f]{7,40}$/i.test(t)) return true;
  // Named ref: branch, tag, or relative ref notation (HEAD~5, v1.2~3, etc.).
  // Allows ~^- in addition to the base alphanumeric+./_ set.
  if (/^[a-zA-Z0-9_.~^/-]{1,200}$/.test(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  return false;
}

/**
 * Parse `git diff --stat` or `git diff --shortstat` output into FileStat[].
 * Lines look like: " path/to/file.ts | 12 ++++----"
 * The summary line ("N files changed, X insertions(+)…") is skipped.
 */
export function parseDiffStat(stdout: string): FileStat[] {
  const stats: FileStat[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+ files? changed/.test(trimmed)) continue;

    // Format: "path | N +++---" or "path | Bin 0 -> N bytes"
    const pipeIdx = trimmed.lastIndexOf('|');
    if (pipeIdx === -1) continue;

    const path = trimmed.slice(0, pipeIdx).trim();
    const rest = trimmed.slice(pipeIdx + 1).trim();

    if (!path || rest.includes('Bin')) continue;

    const insertions = (rest.match(/\+/g) ?? []).length;
    const deletions = (rest.match(/-/g) ?? []).length;
    stats.push({ path, insertions, deletions });
  }
  return stats;
}

/**
 * Compute an ISO-8601 `since` timestamp `days` before the given anchor instant.
 * Pure + deterministic: the same anchor always yields the same window, so the
 * auto-derived change window never depends on a bare wall-clock read. Returns
 * undefined when the anchor cannot be parsed.
 */
export function changeWindowSinceFrom(
  anchorIso: string,
  days: number = DEFAULT_CHANGE_WINDOW_DAYS,
): string | undefined {
  const anchorMs = Date.parse(anchorIso);
  if (Number.isNaN(anchorMs)) return undefined;
  const span = days > 0 ? days : DEFAULT_CHANGE_WINDOW_DAYS;
  return new Date(anchorMs - span * DAY_MS).toISOString();
}

/**
 * Read the author date (ISO-8601) of the repo's most recent commit — the deterministic
 * anchor for the auto change window. Never throws; returns undefined when the repo path
 * is not absolute or git cannot be queried.
 */
export async function latestCommitDate(repoPath: string): Promise<string | undefined> {
  if (!repoPath.startsWith('/')) return undefined;
  try {
    const { stdout } = await exec(
      'git',
      ['-C', repoPath, 'log', '-1', '--format=%aI'],
      { maxBuffer: 1024 * 1024 },
    );
    const iso = stdout.trim();
    return iso === '' ? undefined : iso;
  } catch {
    return undefined;
  }
}

/**
 * List the commits (full SHAs) that touched a specific LINE RANGE of a file — the
 * symbol-level analogue of a file-level change check. Uses `git log -L<start>,<end>:<file>`
 * so a commit that merely edited ANOTHER part of a large file which happens to CONTAIN the
 * symbol is NOT reported (dogfood: a 4000-line options.ts where the seed's retry block was
 * untouched, yet two unrelated commits to the same file were blamed for a retry regression).
 * Best-effort: returns null on any git failure — a shallow clone, a rename boundary git can't
 * follow, an out-of-bounds range, or a non-absolute repo path — so callers can fall back to
 * file-level attribution. `sinceIso`, when it is a date/duration (not a ref), bounds the scan.
 */
export async function commitsTouchingRange(
  repoPath: string,
  file: string,
  startLine: number,
  endLine: number,
  sinceIso?: string,
): Promise<string[] | null> {
  if (!repoPath.startsWith('/')) return null;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;
  try {
    // `git log -L` implies patch output; `--format=%H` + `--no-patch`/`-s` prints one SHA per
    // touching commit with no diff body. The line range is embedded in a single `-L` arg so
    // the file path can never smuggle a leading-dash flag.
    const args = [
      '-C', repoPath,
      'log',
      '--format=%H',
      '--no-patch',
      '-s',
      `-L${startLine},${endLine}:${file}`,
    ];
    // A ref-like `since` (HEAD~5, a SHA) is not a valid `--since` value — skip it and let the
    // caller's intersection with the in-window commits bound the result instead.
    if (sinceIso !== undefined && sinceIso !== '' && !isRefLike(sinceIso)) {
      args.push(`--since=${sinceIso}`);
    }
    const { stdout } = await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });
    const seen = new Set<string>();
    for (const line of stdout.split('\n')) {
      const sha = line.trim();
      if (/^[0-9a-f]{7,40}$/i.test(sha)) seen.add(sha);
    }
    return [...seen];
  } catch {
    return null;
  }
}

/**
 * Derive a default change-window `since` value when the caller supplied no explicit one,
 * anchored to the repo's last commit rather than wall-clock time so the window is
 * deterministic for a given repo state (HOR-333). Returns an ISO-8601 timestamp suitable
 * for {@link collectGitChanges}, or undefined when the repo has no readable history.
 */
export async function defaultChangeWindowSince(
  repoPath: string,
  days: number = DEFAULT_CHANGE_WINDOW_DAYS,
): Promise<string | undefined> {
  const anchor = await latestCommitDate(repoPath);
  if (anchor === undefined) return undefined;
  return changeWindowSinceFrom(anchor, days);
}

// ── Config/migration change classification (HOR-332) ───────────────────────────

/**
 * A non-git change source class. Most production incidents are not (only) code:
 * a migration or a config/data edit landing in the change window is a candidate
 * cause on its own. `migration` = schema/data migrations (the highest-signal
 * non-code change); `config` = environment/config/data files.
 */
export type ConfigChangeCategory = 'migration' | 'config';

export interface ConfigChangeFile {
  path: string;
  category: ConfigChangeCategory;
}

// Migration / schema migrations: a `migrations/`, `migration/`, `alembic/`, or
// `migrate/` directory anywhere in the path, a top-level schema file, or a
// `*.migration.*` / `*.migrate.*` file. Checked FIRST so a migration is never
// downgraded to a plain config match.
const MIGRATION_DIR_RE = /(^|\/)(migrations?|alembic|migrate)\//i;
const SCHEMA_FILE_RE = /(^|\/)schema\.(sql|prisma|rb|graphql|gql)$/i;
const MIGRATION_FILE_RE = /\.(migration|migrate)\.[a-z0-9]+$/i;

// Config/data files: env files (`.env`, `.env.local`, `prod.env`), `*.config.*`
// / `*.conf` files, and yaml/toml/ini data files.
const ENV_FILE_RE = /(^|\.)env($|\.)/i;
const CONFIG_FILE_RE = /\.(config|conf)($|\.)/i;
const DATA_FILE_RE = /\.(ya?ml|toml|ini)$/i;

/**
 * Classify a single changed file path as a config/migration change source, or
 * undefined when it is neither. Pure + deterministic. Migration classification
 * wins over config so a migration is never mislabelled.
 */
export function classifyConfigPath(path: string): ConfigChangeCategory | undefined {
  const p = path.trim();
  if (p === '') return undefined;
  const base = p.split('/').pop() ?? p;

  if (MIGRATION_DIR_RE.test(p) || SCHEMA_FILE_RE.test(p) || MIGRATION_FILE_RE.test(base)) {
    return 'migration';
  }
  if (ENV_FILE_RE.test(base) || CONFIG_FILE_RE.test(base) || DATA_FILE_RE.test(base)) {
    return 'config';
  }
  return undefined;
}

/**
 * From a changed-files list (e.g. {@link BoundedGitChange.changedFiles}), pick the
 * config/migration files and tag each with its category. De-duplicates by path and
 * preserves input order so the result is deterministic for a given change window.
 * Classification only — no I/O. Runtime-config / feature-flag ingestion is out of
 * scope (HOR-332 remaining).
 */
export function classifyConfigChangeFiles(
  paths: readonly string[],
): ConfigChangeFile[] {
  const out: ConfigChangeFile[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    if (path === '' || seen.has(path)) continue;
    const category = classifyConfigPath(path);
    if (category !== undefined) {
      out.push({ path, category });
      seen.add(path);
    }
  }
  return out;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Collect bounded git changes for investigation input.
 * Never throws — errors produce a result with truncated=true and an error reason.
 */
export async function collectGitChanges(query: GitChangeQuery): Promise<BoundedGitChange> {
  const maxCommits = query.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxFiles = query.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = query.maxBytes ?? DEFAULT_MAX_BYTES;

  const empty = (reason?: string): BoundedGitChange => ({
    commits: [],
    fileStats: [],
    changedFiles: [],
    totalInsertions: 0,
    totalDeletions: 0,
    window: { since: query.since, until: query.until },
    truncated: reason !== undefined,
    truncatedReason: reason,
    degenerate: false,
  });

  // ── Input validation (security: prevent argv flag smuggling) ─────────────────

  if (!query.repoPath.startsWith('/')) {
    return empty('repoPath must be an absolute path');
  }
  if (query.until !== undefined && isRefLike(query.since) && !isRefLike(query.until)) {
    return empty(`invalid until ref: ${query.until.slice(0, 60)}`);
  }

  // ── 1. Fetch commits ───────────────────────────────────────────────────────

  let commits: GitCommit[];
  try {
    if (isRefLike(query.since)) {
      // Ref-based: use <ref>..HEAD range with an extra arg so gitLog doesn't
      // add --since. We call git directly with the range syntax.
      const args = [
        '-C', query.repoPath,
        'log',
        '--no-merges',
        `--pretty=format:%H%h%an%aI%s`,
        '--name-only',
        `--max-count=${maxCommits}`,
        `${query.since}..${query.until ?? 'HEAD'}`,
      ];
      const { stdout } = await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });
      commits = parseRefRangeLog(stdout);
    } else {
      commits = await gitLog(query.repoPath, {
        since: query.since,
        until: query.until,
        maxCount: maxCommits,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return empty(`git log failed: ${msg.slice(0, 120)}`);
  }

  if (commits.length === 0) return empty();

  const truncatedCommits = commits.length >= maxCommits;

  // ── 2. Fetch diff stats ────────────────────────────────────────────────────
  //
  // HOR-423: diff against the CORRECT base. For a ref-based window the base is the supplied
  // ref. For a date/duration window the base is the FIRST PARENT of the oldest in-window commit
  // (`<sha>^1`, explicit so a merge commit resolves to its mainline parent rather than the
  // branch it merged). A root commit or a shallow-clone boundary has no first parent, so the
  // diff exec fails — caught below and surfaced as a degenerate window rather than silently
  // reporting the commit file list with +0/-0.
  let rawStats: FileStat[] = [];
  let diffOk = false;
  try {
    const oldest = commits[commits.length - 1];
    if (oldest !== undefined) {
      const rangeBase = isRefLike(query.since) ? query.since : `${oldest.sha}^1`;
      // query.until already validated above when isRefLike(query.since) is true.
      const rangeHead = query.until ?? 'HEAD';
      const { stdout } = await exec(
        'git',
        ['-C', query.repoPath, 'diff', '--stat', `${rangeBase}..${rangeHead}`],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      rawStats = parseDiffStat(stdout);
      diffOk = true;
    }
  } catch {
    // Diff stats are best-effort; proceed without them. A failure here (e.g. a root commit's
    // missing first parent, or a shallow-clone boundary) leaves diffOk=false → degenerate.
  }

  // ── 3. Apply file and byte limits ─────────────────────────────────────────

  let fileStats = rawStats;
  let truncatedFiles = false;
  let truncatedBytes = false;

  if (fileStats.length > maxFiles) {
    fileStats = fileStats.slice(0, maxFiles);
    truncatedFiles = true;
  }

  // Byte cap: measure the serialised representation of each FileStat entry.
  let byteCount = 0;
  const bounded: FileStat[] = [];
  for (const s of fileStats) {
    const entrySize = s.path.length + 30; // path + numbers + overhead
    if (byteCount + entrySize > maxBytes) {
      truncatedBytes = true;
      break;
    }
    byteCount += entrySize;
    bounded.push(s);
  }
  fileStats = bounded;

  // ── 4. Aggregate totals ────────────────────────────────────────────────────

  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const s of fileStats) {
    totalInsertions += s.insertions;
    totalDeletions += s.deletions;
  }

  // Unique changed files from commits (capped to maxFiles)
  const fileSet = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      fileSet.add(f);
      if (fileSet.size >= maxFiles) break;
    }
    if (fileSet.size >= maxFiles) break;
  }
  const changedFiles = [...fileSet];

  const truncated = truncatedCommits || truncatedFiles || truncatedBytes;
  const reasons: string[] = [];
  if (truncatedCommits) reasons.push(`commits capped at ${maxCommits}`);
  if (truncatedFiles) reasons.push(`files capped at ${maxFiles}`);
  if (truncatedBytes) reasons.push(`output capped at ${maxBytes} bytes`);

  // ── 5. Degenerate-diff detection (HOR-423) ─────────────────────────────────
  // A degenerate window carries no usable change signal and must never drive a
  // deployment-regression conclusion. Three independent triggers:
  //   (a) no base — the diff could not be computed (root commit's missing first parent,
  //       shallow-clone boundary, or any git failure) yet the in-window commits touched files;
  //   (b) no-op — the diff reports files but +0/-0 across them (pure merge / rename / mode-only);
  //   (c) over-reach — the diff reports far more files than the in-window commits actually
  //       touched (a wrong/too-far base, e.g. a merge dragging a whole branch into the endpoint
  //       diff, or a checkout/vendor bump).
  let degenerate = false;
  let degenerateReason: string | undefined;

  // Files the in-window commits actually touched (uncapped — ground truth for this window).
  const commitFileUnion = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) commitFileUnion.add(f);
  }
  const diffFileCount = rawStats.length;

  if (!diffOk) {
    if (changedFiles.length > 0) {
      degenerate = true;
      degenerateReason = 'no usable diff base (root commit, shallow clone, or diff failed)';
    }
  } else if (diffFileCount > 0 && totalInsertions + totalDeletions === 0) {
    degenerate = true;
    degenerateReason = '+0/-0 no-op diff (pure merge, rename, or mode-only change)';
  } else if (
    diffFileCount >= OVERREACH_MIN_FILES &&
    commitFileUnion.size > 0 &&
    diffFileCount >= commitFileUnion.size * OVERREACH_FACTOR
  ) {
    degenerate = true;
    degenerateReason = `diff over-reaches base (${diffFileCount} files vs ${commitFileUnion.size} touched by in-window commits)`;
  }

  return {
    commits,
    fileStats,
    changedFiles,
    totalInsertions,
    totalDeletions,
    window: { since: query.since, until: query.until },
    truncated,
    truncatedReason: reasons.length > 0 ? reasons.join('; ') : undefined,
    degenerate,
    ...(degenerateReason !== undefined ? { degenerateReason } : {}),
  };
}

// ── Internal: ref-range log parser ────────────────────────────────────────────

function parseRefRangeLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  if (!stdout.trim()) return commits;

  const lines = stdout.split('\n');
  let current: GitCommit | null = null;

  for (const line of lines) {
    if (line.includes('')) {
      if (current !== null) commits.push(current);
      const parts = line.split('');
      current = {
        sha: parts[0] ?? '',
        shortSha: parts[1] ?? '',
        author: parts[2] ?? '',
        dateIso: parts[3] ?? '',
        subject: parts[4] ?? '',
        files: [],
      };
    } else if (line.trim() !== '' && current !== null) {
      current.files.push(line.trim());
    }
  }
  if (current !== null) commits.push(current);
  return commits;
}
