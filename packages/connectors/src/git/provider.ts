/**
 * Git history provider for @horus/connectors (HOR-22).
 * Shells out to `git` via node:child_process execFile — this is intentional and
 * expected for the history connector (the "no CLI shell-out" rule only applies
 * to source-intelligence queries). See architecture.md §2.2.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
  files: string[];
}

export interface GitLogOptions {
  since?: string;
  until?: string;
  maxCount?: number;
}

/**
 * Pure parser for `git log` stdout.
 * Each commit block starts with a line containing  (unit separator) as the
 * field delimiter in the --pretty=format string. Subsequent non-empty lines (up
 * to the next header line or end of input) are file paths from --name-only.
 */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];

  if (!stdout.trim()) return commits;

  const lines = stdout.split('\n');

  let current: GitCommit | null = null;

  for (const line of lines) {
    if (line.includes('')) {
      // Push the previous commit before starting a new one.
      if (current !== null) {
        commits.push(current);
      }
      const parts = line.split('');
      const sha = parts[0] ?? '';
      const shortSha = parts[1] ?? '';
      const author = parts[2] ?? '';
      const dateIso = parts[3] ?? '';
      const subject = parts[4] ?? '';
      current = { sha, shortSha, author, dateIso, subject, files: [] };
    } else if (line.trim() !== '') {
      // Non-empty line after the header — it's a file path.
      if (current !== null) {
        current.files.push(line.trim());
      }
    }
  }

  // Push the last commit.
  if (current !== null) {
    commits.push(current);
  }

  return commits;
}

/** True when `rev` resolves to a commit in `repoPath` (i.e. it's a git ref, not a date). */
export async function resolvesToCommit(repoPath: string, rev: string): Promise<boolean> {
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch git log for `repoPath` with optional time-window and commit-count limits.
 * Returns commits in git order (newest first).
 */
export async function gitLog(
  repoPath: string,
  opts: GitLogOptions = {},
): Promise<GitCommit[]> {
  const args: string[] = [
    '-C',
    repoPath,
    'log',
    '--no-merges',
    '--pretty=format:%H%h%an%aI%s',
    '--name-only',
  ];

  // `since`/`until` accept EITHER a date (git --since semantics, e.g. "7 days ago") OR a
  // git ref (e.g. HEAD~10). A ref passed to --since is parsed as an invalid date and
  // silently yields zero commits (HOR-354), so when `since` resolves to a commit we build a
  // revision range instead.
  if (opts.since !== undefined && (await resolvesToCommit(repoPath, opts.since))) {
    const end =
      opts.until !== undefined && (await resolvesToCommit(repoPath, opts.until))
        ? opts.until
        : 'HEAD';
    args.push(`${opts.since}..${end}`);
  } else {
    if (opts.since !== undefined) {
      args.push('--since=' + opts.since);
    }
    if (opts.until !== undefined) {
      args.push('--until=' + opts.until);
    }
  }
  args.push('--max-count=' + (opts.maxCount ?? 200));

  const { stdout } = await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });

  return parseGitLog(stdout);
}

/**
 * Returns true when the repo has at least one commit; false on any error
 * (e.g. path is not a git repo).
 */
export async function gitRepoHasCommits(repoPath: string): Promise<boolean> {
  try {
    return (await gitLog(repoPath, { maxCount: 1 })).length > 0;
  } catch {
    return false;
  }
}

/** A single contributor's summary for a file, derived from git log. */
export interface FileContributor {
  author: string;
  commits: number;
  firstDate: string;
  lastDate: string;
}

/**
 * Pure parser for `git log --format=%an%x1f%ae%x1f%aI` stdout.
 * Each line is 'nameemailISODATE'. Entries are grouped by email so
 * different display-name aliases for the same address are merged. Returns
 * contributors sorted by commits descending, then by lastDate descending.
 */
export function parseFileContributors(stdout: string): FileContributor[] {
  if (!stdout.trim()) return [];

  // key = email (or name when email is absent), value = tally
  const tally = new Map<string, { name: string; commits: number; firstDate: string; lastDate: string }>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('');
    if (parts.length < 3) continue;

    const name = parts[0]!.trim();
    const email = parts[1]!.trim();
    const date = parts[2]!.trim();

    if (!name || !date) continue;

    // Group by email to merge alias commits; fall back to name when email is absent.
    const key = email || name;

    const existing = tally.get(key);
    if (existing === undefined) {
      tally.set(key, { name, commits: 1, firstDate: date, lastDate: date });
    } else {
      existing.commits += 1;
      if (date < existing.firstDate) existing.firstDate = date;
      if (date > existing.lastDate) {
        existing.lastDate = date;
        existing.name = name; // use the most recently seen display name
      }
    }
  }

  const result: FileContributor[] = [];
  for (const [, stats] of tally.entries()) {
    result.push({ author: stats.name, commits: stats.commits, firstDate: stats.firstDate, lastDate: stats.lastDate });
  }

  result.sort((a, b) => {
    if (b.commits !== a.commits) return b.commits - a.commits;
    return b.lastDate < a.lastDate ? -1 : b.lastDate > a.lastDate ? 1 : 0;
  });

  return result;
}

/**
 * Fetch per-author contribution stats for a single file in a git repo.
 * Uses `--follow` to track renames. Returns an empty array on any error.
 */
export async function gitFileContributors(
  repoPath: string,
  file: string,
): Promise<FileContributor[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', repoPath, 'log', '--follow', '--format=%an%x1f%ae%x1f%aI', '--', file],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return parseFileContributors(stdout);
  } catch {
    return [];
  }
}

/** One changed file with its git status letter (M/A/D/R…). */
export interface RepoFileChange {
  path: string;
  status: string;
}

/** Cap for staged/unstaged/untracked file lists — counts stay exact. */
const REPO_STATE_FILE_CAP = 100;

/**
 * A truthful snapshot of the repo beyond commit history. Change reports that only
 * read `git log` said "0 commits" while the working tree carried staged/unstaged/
 * untracked work — this is the evidence that closes that hole.
 */
export interface RepoState {
  headSha: string | null;
  branch: string | null;
  /** True when anything is staged, unstaged, or untracked. */
  dirty: boolean;
  staged: RepoFileChange[];
  unstaged: RepoFileChange[];
  untracked: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  /** Working-tree insertions/deletions vs HEAD (staged + unstaged combined). */
  insertions: number;
  deletions: number;
}

function parseNameStatus(stdout: string): RepoFileChange[] {
  const out: RepoFileChange[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [status, ...rest] = trimmed.split('\t');
    const path = rest[rest.length - 1]; // renames are "R100 old new" — report the new path
    if (status && path) out.push({ path, status: status[0] ?? status });
  }
  return out;
}

function parseShortstat(stdout: string): { insertions: number; deletions: number } {
  const ins = /(\d+) insertion/.exec(stdout);
  const del = /(\d+) deletion/.exec(stdout);
  return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

/**
 * Collect the repo's current state: HEAD, branch, and the dirty-worktree truth
 * (staged / unstaged / untracked, with insertions/deletions vs HEAD). Returns null
 * when `repoPath` is not a usable git repo — callers treat that as "unknown".
 */
export async function collectRepoState(repoPath: string): Promise<RepoState | null> {
  try {
    const run = async (args: string[]): Promise<string> =>
      (await exec('git', ['-C', repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 })).stdout;

    const [headSha, branch, stagedRaw, unstagedRaw, untrackedRaw, shortstat] = await Promise.all([
      run(['rev-parse', 'HEAD']).then((s) => s.trim() || null).catch(() => null),
      run(['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim() || null).catch(() => null),
      run(['diff', '--name-status', '--cached']),
      run(['diff', '--name-status']),
      run(['ls-files', '--others', '--exclude-standard']),
      run(['diff', 'HEAD', '--shortstat']).catch(() => ''),
    ]);

    const staged = parseNameStatus(stagedRaw);
    const unstaged = parseNameStatus(unstagedRaw);
    const untracked = untrackedRaw.split('\n').map((l) => l.trim()).filter(Boolean);
    const { insertions, deletions } = parseShortstat(shortstat);

    return {
      headSha,
      branch,
      dirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
      staged: staged.slice(0, REPO_STATE_FILE_CAP),
      unstaged: unstaged.slice(0, REPO_STATE_FILE_CAP),
      untracked: untracked.slice(0, REPO_STATE_FILE_CAP),
      stagedCount: staged.length,
      unstagedCount: unstaged.length,
      untrackedCount: untracked.length,
      insertions,
      deletions,
    };
  } catch {
    return null;
  }
}

/**
 * `git diff --name-status` + `--shortstat` between two refs — the git TRUTH for a
 * change window, independent of the source index. Returns null when the range is
 * not diffable.
 */
export async function gitDiffSummary(
  repoPath: string,
  base: string,
  compare: string,
): Promise<{ files: RepoFileChange[]; fileCount: number; insertions: number; deletions: number } | null> {
  try {
    const range = `${base}..${compare}`;
    const [nameStatus, shortstat] = await Promise.all([
      exec('git', ['-C', repoPath, 'diff', '--name-status', range], {
        maxBuffer: 10 * 1024 * 1024,
      }).then((r) => r.stdout),
      exec('git', ['-C', repoPath, 'diff', '--shortstat', range], {
        maxBuffer: 10 * 1024 * 1024,
      }).then((r) => r.stdout),
    ]);
    // Full list — consumers bucket over ALL files and cap only at display/serialization
    // time (a capped list here made the risk buckets undercount large windows).
    const files = parseNameStatus(nameStatus);
    const { insertions, deletions } = parseShortstat(shortstat);
    return { files, fileCount: files.length, insertions, deletions };
  } catch {
    return null;
  }
}
