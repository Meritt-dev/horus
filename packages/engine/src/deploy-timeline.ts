/**
 * HOR-22 — Deployment / change-timeline reconstruction.
 * Treats git history as EVIDENCE, not conclusions.
 */

import type { GitCommit, RepoState } from '@horus/connectors';
import type { CodeProvider } from '@horus/connectors';
import { changeImpact, type ChangeImpactReport } from './changes.js';
import { gitLog, collectRepoState } from '@horus/connectors';

export interface ChangeTimelineInput {
  repoPath: string;
  since?: string;
  until?: string;
  service?: string;
  /** `.horus/source/meta.json` freshness, injected by the CLI when available. */
  sourceIndex?: { lastIndexedAt?: string };
}

export interface ChangeTimeline {
  window: { since: string | null; until: string | null; service: string | null };
  commits: GitCommit[];
  changeImpact: ChangeImpactReport | null;
  /**
   * Repo truth beyond commit history: HEAD, branch, and the dirty-worktree state
   * (staged/unstaged/untracked + insertions/deletions). Null when the repo state
   * could not be read. `git log` alone said "0 commits" on repos full of
   * uncommitted work — this is the working-tree change source that closes that.
   */
  repoState: RepoState | null;
  /** When the CLI knows the source index freshness, it is echoed here. */
  sourceIndex?: { lastIndexedAt?: string } | null;
  summary: string;
  note: string;
}

export async function reconstructChangeTimeline(
  input: ChangeTimelineInput,
  deps: { code: CodeProvider },
): Promise<ChangeTimeline> {
  let commits = await gitLog(input.repoPath, {
    since: input.since,
    until: input.until,
  });

  const service = input.service;

  if (service !== undefined) {
    commits = commits.filter((c) =>
      c.files.some((f) => f.toLowerCase().includes(service.toLowerCase())),
    );
  }

  let impact: ChangeImpactReport | null = null;

  if (commits.length >= 1) {
    const oldest = commits[commits.length - 1];
    const newest = commits[0];
    if (oldest !== undefined && newest !== undefined) {
      const base = oldest.sha + '^';
      const compare = newest.sha;
      try {
        impact = await changeImpact({ base, compare }, deps);
      } catch {
        impact = null;
      }
    }
  }

  // Repo truth beyond `git log`: a dirty worktree is a change source commit history
  // cannot see. Best-effort — null (not a fabricated "clean") when unreadable.
  let repoState: RepoState | null = null;
  try {
    repoState = await collectRepoState(input.repoPath);
  } catch {
    repoState = null;
  }

  // Strip trailing period from impact.summary before embedding — we add our own.
  const impactPart =
    impact !== null
      ? '; ' + (impact.summary.endsWith('.') ? impact.summary.slice(0, -1) : impact.summary)
      : '';

  const dirtyPart = repoState?.dirty
    ? '; working tree has uncommitted changes (' +
      repoState.stagedCount +
      ' staged, ' +
      repoState.unstagedCount +
      ' unstaged, ' +
      repoState.untrackedCount +
      ' untracked)'
    : '';

  const summary =
    commits.length +
    ' commit(s)' +
    (service !== undefined ? ' touching ' + service : '') +
    ' in window' +
    (input.since !== undefined ? ' since ' + input.since : '') +
    impactPart +
    dirtyPart +
    '.';

  // A 0-commit window over a dirty worktree must say WHY it looks empty — the
  // uncommitted work is excluded from commit history but reported above.
  const note =
    commits.length === 0 && repoState?.dirty
      ? 'No commits in the window, but the working tree carries uncommitted changes — they are reported as a working-tree change source above, not in commit history.'
      : 'Changes are evidence, not conclusions — a change in this window is not automatically the cause.';

  return {
    window: {
      since: input.since ?? null,
      until: input.until ?? null,
      service: service ?? null,
    },
    commits,
    changeImpact: impact,
    repoState,
    sourceIndex: input.sourceIndex ?? null,
    summary,
    note,
  };
}
