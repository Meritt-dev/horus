/**
 * Pure unit tests for parseGitLog — no git process is spawned.
 */

import { describe, it, expect } from 'vitest';
import { parseGitLog } from './provider.js';

// Unit separator character used in the --pretty=format string.
const SEP = '';

describe('parseGitLog', () => {
  it('returns an empty array for empty stdout', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('   \n  \n')).toEqual([]);
  });

  it('parses two commits with correct fields and files', () => {
    // Simulate what `git log --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s --name-only`
    // produces for two commits (newest first), separated by a blank line.
    const stdout = [
      `abc123fullsha${SEP}abc123${SEP}Alice${SEP}2024-01-15T10:00:00+00:00${SEP}feat: add payment flow`,
      'src/payments/index.ts',
      'src/payments/types.ts',
      '',
      `def456fullsha${SEP}def456${SEP}Bob${SEP}2024-01-14T09:00:00+00:00${SEP}fix: handle timeout`,
      'src/utils/timeout.ts',
    ].join('\n');

    const commits = parseGitLog(stdout);

    expect(commits).toHaveLength(2);

    const first = commits[0];
    expect(first).toBeDefined();
    expect(first?.sha).toBe('abc123fullsha');
    expect(first?.shortSha).toBe('abc123');
    expect(first?.author).toBe('Alice');
    expect(first?.dateIso).toBe('2024-01-15T10:00:00+00:00');
    expect(first?.subject).toBe('feat: add payment flow');
    expect(first?.files).toEqual(['src/payments/index.ts', 'src/payments/types.ts']);

    const second = commits[1];
    expect(second).toBeDefined();
    expect(second?.sha).toBe('def456fullsha');
    expect(second?.shortSha).toBe('def456');
    expect(second?.author).toBe('Bob');
    expect(second?.dateIso).toBe('2024-01-14T09:00:00+00:00');
    expect(second?.subject).toBe('fix: handle timeout');
    expect(second?.files).toEqual(['src/utils/timeout.ts']);
  });

  it('handles a commit with no changed files', () => {
    const stdout =
      `deadbeefdeadbeef${SEP}deadbeef${SEP}Carol${SEP}2024-01-13T08:00:00+00:00${SEP}chore: bump version`;

    const commits = parseGitLog(stdout);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual([]);
  });

  it('trims whitespace from file paths', () => {
    const stdout = [
      `aaabbbcccddd${SEP}aaabbb${SEP}Dave${SEP}2024-01-12T07:00:00+00:00${SEP}refactor: cleanup`,
      '  src/foo.ts  ',
    ].join('\n');

    const commits = parseGitLog(stdout);
    expect(commits[0]?.files).toEqual(['src/foo.ts']);
  });
});

// ---------------------------------------------------------------------------
// collectRepoState / gitDiffSummary — real-git integration over a temp repo
// ---------------------------------------------------------------------------

import { describe as describe2, it as it2, expect as expect2, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectRepoState, gitDiffSummary } from './provider.js';

describe2('collectRepoState / gitDiffSummary (real git, temp repo)', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'horus-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 2;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'second');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it2('reports a clean repo as not dirty with a real HEAD sha and branch', async () => {
    const state = await collectRepoState(repo);
    expect2(state).not.toBeNull();
    expect2(state!.dirty).toBe(false);
    expect2(state!.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect2(state!.branch).toBe('main');
    expect2(state!.stagedCount + state!.unstagedCount + state!.untrackedCount).toBe(0);
  });

  it2('sees staged, unstaged, and untracked work with insertions/deletions', async () => {
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 42;\nexport const extra = 1;\n');
    git('add', 'src/a.ts'); // staged
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 3;\n'); // unstaged
    writeFileSync(join(repo, 'notes.md'), 'wip\n'); // untracked

    const state = await collectRepoState(repo);
    expect2(state!.dirty).toBe(true);
    expect2(state!.staged).toEqual([{ path: 'src/a.ts', status: 'M' }]);
    expect2(state!.unstaged).toEqual([{ path: 'src/b.ts', status: 'M' }]);
    expect2(state!.untracked).toEqual(['notes.md']);
    expect2(state!.insertions).toBeGreaterThan(0);

    // restore for other tests
    git('reset', '-q', '--hard', 'HEAD');
    rmSync(join(repo, 'notes.md'), { force: true });
  });

  it2('gitDiffSummary reports files by status and +/- for a range', async () => {
    const diff = await gitDiffSummary(repo, 'HEAD~1', 'HEAD');
    expect2(diff).not.toBeNull();
    expect2(diff!.files).toEqual([{ path: 'src/b.ts', status: 'A' }]);
    expect2(diff!.fileCount).toBe(1);
    expect2(diff!.insertions).toBe(1);
  });

  it2('returns null (not fabricated zeros) for non-repos and bad ranges', async () => {
    expect2(await collectRepoState(join(tmpdir(), 'definitely-not-a-repo-xyz'))).toBeNull();
    expect2(await gitDiffSummary(repo, 'nope-ref', 'HEAD')).toBeNull();
  });
});
