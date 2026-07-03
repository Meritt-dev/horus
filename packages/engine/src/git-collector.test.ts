/**
 * HOR-93 — Unit tests for bounded git change collector (pure functions + mocked I/O).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isRefLike,
  parseDiffStat,
  collectGitChanges,
  commitsTouchingRange,
  changeWindowSinceFrom,
  latestCommitDate,
  defaultChangeWindowSince,
  DEFAULT_CHANGE_WINDOW_DAYS,
  classifyConfigPath,
  classifyConfigChangeFiles,
} from './git-collector.js';
import type { GitChangeQuery } from './git-collector.js';

// ── isRefLike ─────────────────────────────────────────────────────────────────

describe('isRefLike', () => {
  it('detects short SHA', () => {
    expect(isRefLike('abc1234')).toBe(true);
  });

  it('detects full SHA', () => {
    expect(isRefLike('a'.repeat(40))).toBe(true);
  });

  it('detects branch name', () => {
    expect(isRefLike('main')).toBe(true);
    expect(isRefLike('feature/HOR-93')).toBe(true);
  });

  it('rejects "N hours ago"', () => {
    expect(isRefLike('24 hours ago')).toBe(false);
    expect(isRefLike('2 days ago')).toBe(false);
  });

  it('rejects ISO date', () => {
    expect(isRefLike('2024-01-15')).toBe(false);
  });

  it('rejects "yesterday"', () => {
    expect(isRefLike('yesterday')).toBe(false);
  });

  it('rejects ISO datetime with colon', () => {
    expect(isRefLike('2024-01-15T10:30:00Z')).toBe(false);
  });

  it('rejects strings containing "ago"', () => {
    expect(isRefLike('1week ago')).toBe(false);
  });

  it('rejects leading-dash strings (flag smuggling guard)', () => {
    expect(isRefLike('-no-merges')).toBe(false);
    expect(isRefLike('--exec=bad')).toBe(false);
  });

  it('rejects strings containing ".." (range injection guard)', () => {
    expect(isRefLike('HEAD..main')).toBe(false);
    expect(isRefLike('v1.0..v2.0')).toBe(false);
  });

  it('rejects duration strings like "24h", "7d", "30m", "90s"', () => {
    expect(isRefLike('24h')).toBe(false);
    expect(isRefLike('7d')).toBe(false);
    expect(isRefLike('30m')).toBe(false);
    expect(isRefLike('90s')).toBe(false);
  });

  it('accepts relative ref notation (HEAD~N, v1.2~3)', () => {
    expect(isRefLike('HEAD~5')).toBe(true);
    expect(isRefLike('HEAD~3')).toBe(true);
    expect(isRefLike('v1.2~1')).toBe(true);
  });
});

// ── parseDiffStat ─────────────────────────────────────────────────────────────

describe('parseDiffStat', () => {
  it('returns empty array for empty string', () => {
    expect(parseDiffStat('')).toEqual([]);
  });

  it('parses a single-file diff stat', () => {
    const out = ' src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)';
    expect(parseDiffStat(out)).toEqual([
      { path: 'src/foo.ts', insertions: 5, deletions: 0 },
    ]);
  });

  it('parses insertions and deletions', () => {
    const out = ' src/bar.ts | 10 ++++++----\n 1 file changed';
    const stats = parseDiffStat(out);
    expect(stats[0]).toMatchObject({ path: 'src/bar.ts', insertions: 6, deletions: 4 });
  });

  it('skips the summary line', () => {
    const out = [
      ' a.ts | 3 +++',
      ' b.ts | 2 +-',
      ' 2 files changed, 3 insertions(+), 1 deletion(-)',
    ].join('\n');
    const stats = parseDiffStat(out);
    expect(stats).toHaveLength(2);
    expect(stats.map(s => s.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('skips binary files', () => {
    const out = ' assets/image.png | Bin 0 -> 1234 bytes\n a.ts | 1 +';
    const stats = parseDiffStat(out);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.path).toBe('a.ts');
  });

  it('handles paths with spaces by using lastIndexOf(|)', () => {
    const out = ' path with spaces/file.ts | 2 ++';
    const stats = parseDiffStat(out);
    expect(stats[0]!.path).toBe('path with spaces/file.ts');
  });
});

// ── collectGitChanges ─────────────────────────────────────────────────────────

vi.mock('@horus/connectors', () => ({
  gitLog: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import * as connectors from '@horus/connectors';
import * as childProcess from 'node:child_process';

const mockGitLog = vi.mocked(connectors.gitLog);
const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCb = (err: Error | null, result?: { stdout: string }) => void;

// Helper: make execFile mock resolve with stdout (promisify-compatible callback style)
function stubExec(stdout: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: ExecFileCb) => {
    cb(null, { stdout });
  });
}

function stubExecError(msg: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: ExecFileCb) => {
    cb(new Error(msg));
  });
}

function makeCommit(sha: string, files: string[] = []) {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    author: 'Test Author',
    dateIso: '2024-01-15T10:00:00Z',
    subject: `commit ${sha}`,
    files,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('collectGitChanges', () => {
  it('returns empty result when no commits found', async () => {
    mockGitLog.mockResolvedValue([]);

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
    });

    expect(result.commits).toHaveLength(0);
    expect(result.fileStats).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('returns commits and parses diff stats', async () => {
    const commits = [makeCommit('abc1234', ['src/foo.ts'])];
    mockGitLog.mockResolvedValue(commits);
    stubExec(' src/foo.ts | 3 +++\n 1 file changed');

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
    });

    expect(result.commits).toHaveLength(1);
    expect(result.fileStats).toHaveLength(1);
    expect(result.fileStats[0]!.path).toBe('src/foo.ts');
    expect(result.totalInsertions).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it('marks truncated when commits hit maxCommits', async () => {
    const commits = Array.from({ length: 3 }, (_, i) => makeCommit(`sha${i}`));
    mockGitLog.mockResolvedValue(commits);
    stubExec('');

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
      maxCommits: 3,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/commits capped at 3/);
  });

  it('caps fileStats at maxFiles and marks truncated', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234')]);
    const manyFiles = Array.from({ length: 5 }, (_, i) => ` file${i}.ts | 1 +`).join('\n');
    stubExec(manyFiles);

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
      maxFiles: 2,
    });

    expect(result.fileStats.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/files capped at 2/);
  });

  it('caps output at maxBytes and marks truncated', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234')]);
    const manyFiles = Array.from({ length: 20 }, (_, i) =>
      ` ${'a'.repeat(50)}/file${i}.ts | 1 +`,
    ).join('\n');
    stubExec(manyFiles);

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
      maxBytes: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/output capped at 100 bytes/);
  });

  it('handles git log failure gracefully', async () => {
    mockGitLog.mockRejectedValue(new Error('not a git repo'));

    const result = await collectGitChanges({
      repoPath: '/not-a-repo',
      since: '24 hours ago',
    });

    expect(result.commits).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/git log failed/);
  });

  it('proceeds without fileStats when diff fails', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234', ['src/foo.ts'])]);
    stubExecError('diff failed');

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '24 hours ago',
    });

    expect(result.commits).toHaveLength(1);
    expect(result.fileStats).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('uses ref-range syntax when since is a commit SHA', async () => {
    // Both calls (log + diff) return empty — only testing that gitLog is NOT called
    stubExec('');

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: 'abc1234',
    });

    expect(result.commits).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(mockGitLog).not.toHaveBeenCalled();
  });

  it('sets window from query', async () => {
    mockGitLog.mockResolvedValue([]);

    const result = await collectGitChanges({
      repoPath: '/repo',
      since: '2024-01-01',
      until: '2024-01-31',
    });

    expect(result.window).toEqual({ since: '2024-01-01', until: '2024-01-31' });
  });

  it('returns empty+truncated for relative repoPath (security guard)', async () => {
    const result = await collectGitChanges({
      repoPath: 'relative/path',
      since: '24 hours ago',
    });
    expect(result.commits).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/absolute/);
  });

  it('returns empty+truncated for invalid until ref when since is a ref (security guard)', async () => {
    const result = await collectGitChanges({
      repoPath: '/repo',
      since: 'abc1234',
      until: '--bad-flag',
    });
    expect(result.commits).toHaveLength(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedReason).toMatch(/invalid until ref/);
  });
});

// ── HOR-423: correct base + degenerate-diff detection ──────────────────────────

describe('collectGitChanges — HOR-423 base + degenerate detection', () => {
  it('diffs a date window against the oldest commit FIRST PARENT (<sha>^1)', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234def5678', ['src/foo.ts'])]);
    stubExec(' src/foo.ts | 3 +++\n 1 file changed');

    await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diffCall = (mockExecFile as any).mock.calls.find(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('diff'),
    );
    expect(diffCall).toBeDefined();
    const args = diffCall[1] as string[];
    expect(args).toContain('abc1234def5678^1..HEAD');
  });

  it('a healthy diff is NOT degenerate', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234', ['src/foo.ts'])]);
    stubExec(' src/foo.ts | 3 +++\n 1 file changed');

    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.degenerate).toBe(false);
    expect(result.degenerateReason).toBeUndefined();
  });

  it('flags degenerate when the diff fails but in-window commits touched files (root/shallow)', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234', ['src/foo.ts'])]);
    stubExecError("fatal: ambiguous argument 'abc1234^1': unknown revision");

    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.fileStats).toHaveLength(0);
    expect(result.degenerate).toBe(true);
    expect(result.degenerateReason).toMatch(/no usable diff base/);
  });

  it('flags degenerate for a +0/-0 no-op diff (pure merge / rename / mode-only)', async () => {
    mockGitLog.mockResolvedValue([makeCommit('abc1234', ['a.ts', 'b.ts'])]);
    stubExec(' a.ts | 0\n b.ts | 0\n 2 files changed');

    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.totalInsertions + result.totalDeletions).toBe(0);
    expect(result.degenerate).toBe(true);
    expect(result.degenerateReason).toMatch(/no-op/);
  });

  it('flags degenerate when the diff over-reaches its base (far more files than commits touched)', async () => {
    // One in-window commit touches one file, but the endpoint diff reports 25 files —
    // a merge dragged a whole branch into the diff, or the base reached too far back.
    mockGitLog.mockResolvedValue([makeCommit('abc1234', ['src/foo.ts'])]);
    const manyFiles = Array.from({ length: 25 }, (_, i) => ` pkg/file${i}.ts | 1 +`).join('\n');
    stubExec(manyFiles);

    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.degenerate).toBe(true);
    expect(result.degenerateReason).toMatch(/over-reach/);
  });

  it('does NOT flag over-reach for a legitimately broad single commit (files match the diff)', async () => {
    const touched = Array.from({ length: 25 }, (_, i) => `pkg/file${i}.ts`);
    mockGitLog.mockResolvedValue([makeCommit('abc1234', touched)]);
    const manyFiles = touched.map((f) => ` ${f} | 1 +`).join('\n');
    stubExec(manyFiles);

    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.degenerate).toBe(false);
  });

  it('empty result is not degenerate', async () => {
    mockGitLog.mockResolvedValue([]);
    const result = await collectGitChanges({ repoPath: '/repo', since: '24 hours ago' });
    expect(result.degenerate).toBe(false);
  });
});

// ── A7: commitsTouchingRange (symbol-line-range intersection) ───────────────────

describe('commitsTouchingRange', () => {
  it('parses unique commit SHAs from git log -L output', async () => {
    stubExec('584c5e5785f68bcf\n600e61b223bcaf03\n584c5e5785f68bcf\n');
    const shas = await commitsTouchingRange('/repo', 'src/options.ts', 40, 120);
    expect(shas).toEqual(['584c5e5785f68bcf', '600e61b223bcaf03']);
  });

  it('builds the -L<start>,<end>:<file> arg and adds --since for a date window', async () => {
    stubExec('');
    await commitsTouchingRange('/repo', 'src/options.ts', 40, 120, '2024-01-01T00:00:00Z');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (mockExecFile as any).mock.calls.at(-1);
    const args = call[1] as string[];
    expect(args).toContain('-L40,120:src/options.ts');
    expect(args).toContain('--format=%H');
    expect(args).toContain('--since=2024-01-01T00:00:00Z');
  });

  it('omits --since when the window boundary is ref-like (a SHA, not a date)', async () => {
    stubExec('');
    await commitsTouchingRange('/repo', 'src/options.ts', 40, 120, 'abc1234');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (mockExecFile as any).mock.calls.at(-1)[1] as string[];
    expect(args.some((a) => a.startsWith('--since='))).toBe(false);
  });

  it('returns null when git fails (shallow clone / rename boundary / out-of-range)', async () => {
    stubExecError('fatal: -L range out of bounds');
    expect(await commitsTouchingRange('/repo', 'src/options.ts', 40, 120)).toBeNull();
  });

  it('returns null for a relative repo path (security guard)', async () => {
    expect(await commitsTouchingRange('relative/path', 'a.ts', 1, 5)).toBeNull();
  });

  it('returns null for a non-sensical range', async () => {
    expect(await commitsTouchingRange('/repo', 'a.ts', 0, 5)).toBeNull();
    expect(await commitsTouchingRange('/repo', 'a.ts', 10, 5)).toBeNull();
  });
});

// ── HOR-333: auto change window ─────────────────────────────────────────────────

describe('changeWindowSinceFrom', () => {
  it('subtracts the default 14-day window from the anchor (deterministic)', () => {
    expect(changeWindowSinceFrom('2024-01-15T10:00:00.000Z')).toBe('2024-01-01T10:00:00.000Z');
  });

  it('honors a custom day count', () => {
    expect(changeWindowSinceFrom('2024-01-15T00:00:00.000Z', 7)).toBe('2024-01-08T00:00:00.000Z');
  });

  it('falls back to the default for a non-positive day count', () => {
    expect(changeWindowSinceFrom('2024-01-15T10:00:00.000Z', 0)).toBe('2024-01-01T10:00:00.000Z');
    expect(changeWindowSinceFrom('2024-01-15T10:00:00.000Z', -5)).toBe('2024-01-01T10:00:00.000Z');
  });

  it('returns undefined for an unparseable anchor', () => {
    expect(changeWindowSinceFrom('not-a-date')).toBeUndefined();
  });

  it('is pure — same anchor always yields the same window', () => {
    const a = changeWindowSinceFrom('2024-06-01T12:34:56.000Z');
    const b = changeWindowSinceFrom('2024-06-01T12:34:56.000Z');
    expect(a).toBe(b);
  });
});

describe('latestCommitDate', () => {
  it('returns the trimmed ISO date from git log', async () => {
    stubExec('2024-01-15T10:00:00+00:00\n');
    expect(await latestCommitDate('/repo')).toBe('2024-01-15T10:00:00+00:00');
  });

  it('returns undefined for a relative repo path (security guard)', async () => {
    expect(await latestCommitDate('relative/path')).toBeUndefined();
  });

  it('returns undefined when git fails (empty repo / no history)', async () => {
    stubExecError('fatal: your current branch does not have any commits yet');
    expect(await latestCommitDate('/repo')).toBeUndefined();
  });

  it('returns undefined for empty stdout', async () => {
    stubExec('   \n');
    expect(await latestCommitDate('/repo')).toBeUndefined();
  });
});

describe('defaultChangeWindowSince', () => {
  it('anchors the window to the last commit, not wall-clock', async () => {
    stubExec('2024-01-15T10:00:00.000Z\n');
    expect(await defaultChangeWindowSince('/repo')).toBe('2024-01-01T10:00:00.000Z');
  });

  it('respects an overridden window length', async () => {
    stubExec('2024-01-15T00:00:00.000Z\n');
    expect(await defaultChangeWindowSince('/repo', 7)).toBe('2024-01-08T00:00:00.000Z');
  });

  it('returns undefined when the repo has no readable history', async () => {
    stubExecError('fatal: bad default revision HEAD');
    expect(await defaultChangeWindowSince('/repo')).toBeUndefined();
  });

  it('exposes a 14-day default', () => {
    expect(DEFAULT_CHANGE_WINDOW_DAYS).toBe(14);
  });
});

// ── classifyConfigPath / classifyConfigChangeFiles (HOR-332) ───────────────────

describe('classifyConfigPath', () => {
  it('classifies a migrations directory as a migration', () => {
    expect(classifyConfigPath('db/migrations/0009_add_index.sql')).toBe('migration');
    expect(classifyConfigPath('migration/2024_01_init.ts')).toBe('migration');
    expect(classifyConfigPath('app/alembic/versions/abc.py')).toBe('migration');
    expect(classifyConfigPath('src/migrate/001.sql')).toBe('migration');
  });

  it('classifies a top-level schema file as a migration', () => {
    expect(classifyConfigPath('prisma/schema.prisma')).toBe('migration');
    expect(classifyConfigPath('schema.sql')).toBe('migration');
    expect(classifyConfigPath('db/schema.rb')).toBe('migration');
  });

  it('classifies a *.migration.* file as a migration', () => {
    expect(classifyConfigPath('users.migration.ts')).toBe('migration');
  });

  it('classifies env files as config', () => {
    expect(classifyConfigPath('.env')).toBe('config');
    expect(classifyConfigPath('.env.local')).toBe('config');
    expect(classifyConfigPath('config/production.env')).toBe('config');
  });

  it('classifies *.config.* / *.conf files as config', () => {
    expect(classifyConfigPath('webpack.config.js')).toBe('config');
    expect(classifyConfigPath('nginx.conf')).toBe('config');
  });

  it('classifies yaml/toml/ini data files as config', () => {
    expect(classifyConfigPath('docker-compose.yml')).toBe('config');
    expect(classifyConfigPath('k8s/deploy.yaml')).toBe('config');
    expect(classifyConfigPath('pyproject.toml')).toBe('config');
    expect(classifyConfigPath('setup.ini')).toBe('config');
  });

  it('prefers migration over config when a path could match both', () => {
    // A yaml file living under a migrations dir is still a migration.
    expect(classifyConfigPath('migrations/0001_seed.yaml')).toBe('migration');
  });

  it('returns undefined for ordinary source files', () => {
    expect(classifyConfigPath('src/service/order.ts')).toBeUndefined();
    expect(classifyConfigPath('lib/environment.ts')).toBeUndefined();
    expect(classifyConfigPath('README.md')).toBeUndefined();
    expect(classifyConfigPath('')).toBeUndefined();
  });
});

describe('classifyConfigChangeFiles', () => {
  it('picks and tags only the config/migration files, preserving order', () => {
    const result = classifyConfigChangeFiles([
      'src/service/order.ts',
      'db/migrations/0009_add.sql',
      '.env.production',
      'README.md',
      'config/app.config.json',
    ]);
    expect(result).toEqual([
      { path: 'db/migrations/0009_add.sql', category: 'migration' },
      { path: '.env.production', category: 'config' },
      { path: 'config/app.config.json', category: 'config' },
    ]);
  });

  it('de-duplicates by path', () => {
    const result = classifyConfigChangeFiles(['.env', '.env', 'schema.sql']);
    expect(result).toEqual([
      { path: '.env', category: 'config' },
      { path: 'schema.sql', category: 'migration' },
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(classifyConfigChangeFiles(['a.ts', 'b.go', 'c.py'])).toEqual([]);
  });
});
