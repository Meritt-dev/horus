/**
 * `whatChanged` — git truth first, structural impact second, dirty worktrees visible.
 * Pure unit tests — connectors are stubbed, no git I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeProvider, GitCommit } from '@horus/connectors';

vi.mock('@horus/connectors', () => ({
  gitLog: vi.fn(),
  collectRepoState: vi.fn(async () => null),
  gitDiffSummary: vi.fn(async () => null),
}));

import * as connectors from '@horus/connectors';
import { whatChanged } from './what-changed.js';
import { renderWhatChanged } from './render-what-changed.js';

const mockGitLog = vi.mocked(connectors.gitLog);
const mockRepoState = vi.mocked(connectors.collectRepoState);
const mockDiffSummary = vi.mocked(connectors.gitDiffSummary);

function makeCommit(sha: string, subject: string, files: string[] = ['src/index.ts']): GitCommit {
  return { sha, shortSha: sha.slice(0, 7), subject, author: 'Dev', dateIso: '2026-07-01', files };
}

const code = {
  health: vi.fn(),
  searchSymbols: vi.fn(),
  context: vi.fn(),
  impact: vi.fn(),
  flowsFor: vi.fn(async () => []),
  detectChanges: vi.fn(async () => ({ added: [], removed: [], modified: [] })),
} as unknown as CodeProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockRepoState.mockResolvedValue(null);
  mockDiffSummary.mockResolvedValue(null);
});

describe('whatChanged — git truth first', () => {
  it('reports git diff truth (files by status, +/-, buckets) ahead of structural impact', async () => {
    mockGitLog.mockResolvedValue([
      makeCommit('b'.repeat(40), 'feat: y', ['src/api/checkout.ts']),
      makeCommit('a'.repeat(40), 'feat: x', ['src/api/orders.ts']),
    ]);
    mockDiffSummary.mockResolvedValue({
      files: [
        { path: 'src/api/orders.ts', status: 'M' },
        { path: 'src/api/orders.test.ts', status: 'A' },
        { path: 'README.md', status: 'M' },
        { path: 'tsconfig.json', status: 'M' },
      ],
      fileCount: 4,
      insertions: 120,
      deletions: 30,
    });

    const r = await whatChanged({ repoPath: '/repo', since: '7 days ago' }, { code });
    expect(r.gitTruth).not.toBeNull();
    expect(r.gitTruth!.fileCount).toBe(4);
    expect(r.gitTruth!.insertions).toBe(120);
    expect(r.gitTruth!.buckets).toEqual({ runtime: 1, test: 1, docs: 1, config: 1 });
    // The diff range matches the change-impact range: oldest^ .. newest.
    expect(mockDiffSummary).toHaveBeenCalledWith('/repo', 'a'.repeat(40) + '^', 'b'.repeat(40));
    expect(r.summary).toContain('4 file(s) changed (+120/-30, 1 runtime)');

    const rendered = renderWhatChanged(r);
    const gitIdx = rendered.indexOf('## Git truth');
    const structuralIdx = rendered.indexOf('## Structural impact (source index)');
    expect(gitIdx).toBeGreaterThan(-1);
    expect(structuralIdx).toBeGreaterThan(-1);
    expect(gitIdx).toBeLessThan(structuralIdx); // git truth FIRST, index view second
  });

  it('an undiffable range reports gitTruth: null, never fabricated zeros', async () => {
    mockGitLog.mockResolvedValue([makeCommit('a'.repeat(40), 'root commit')]);
    mockDiffSummary.mockResolvedValue(null); // e.g. shallow clone, a^ unresolvable
    const r = await whatChanged({ repoPath: '/repo' }, { code });
    expect(r.gitTruth).toBeNull();
    expect(r.summary).not.toContain('file(s) changed');
  });

  it('0 commits over a dirty worktree explains itself and surfaces the working tree', async () => {
    mockGitLog.mockResolvedValue([]);
    mockRepoState.mockResolvedValue({
      headSha: 'abc',
      branch: 'main',
      dirty: true,
      staged: [{ path: 'src/a.ts', status: 'M' }],
      unstaged: [],
      untracked: ['wip.ts'],
      stagedCount: 1,
      unstagedCount: 0,
      untrackedCount: 1,
      insertions: 9,
      deletions: 2,
    });
    const r = await whatChanged({ repoPath: '/repo', since: 'HEAD' }, { code });
    expect(r.commitCount).toBe(0);
    expect(r.repoState?.dirty).toBe(true);
    expect(r.summary).toContain('working tree has uncommitted changes');
    expect(r.note).toContain('uncommitted changes');
    expect(renderWhatChanged(r)).toContain('## Working tree (uncommitted)');
  });
});
