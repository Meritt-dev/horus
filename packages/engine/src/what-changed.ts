/**
 * HOR-30 — 'what changed' entry point.
 * Composes HOR-22 reconstruction and adds ownership + queue-topology signals.
 * Produces a concise, evidence-backed change summary for a service + window.
 */

import type { CodeProvider, GitCommit, RepoState, RepoFileChange } from '@horus/connectors';
import { gitDiffSummary } from '@horus/connectors';
import { bucketForChange, type ChangeBucket } from '@horus/core';
import { reconstructChangeTimeline } from './deploy-timeline.js';
import type { ChangeImpactReport } from './changes.js';

export interface Contributor {
  author: string;
  commits: number;
}

/**
 * The git TRUTH for the window — `git diff --name-status/--shortstat` over the
 * commit range, independent of the source index. Reported FIRST; the structural
 * (source-index) impact is a separate, second-class section.
 */
export interface GitTruth {
  base: string;
  compare: string;
  files: RepoFileChange[];
  fileCount: number;
  insertions: number;
  deletions: number;
  /** How many changed files land in each risk bucket. */
  buckets: Record<ChangeBucket, number>;
}

export interface WhatChangedReport {
  window: {
    since: string | null;
    until: string | null;
    service: string | null;
  };
  commitCount: number;
  topCommits: GitCommit[];
  /** Git truth first (null when the range is not diffable). */
  gitTruth: GitTruth | null;
  /** Repo/working-tree state — dirty worktrees are a change source too. */
  repoState: RepoState | null;
  changeImpact: ChangeImpactReport | null;
  contributors: Contributor[];
  queueTopology: {
    touched: boolean;
    files: string[];
  };
  summary: string;
  note: string;
}

export async function whatChanged(
  input: {
    repoPath: string;
    since?: string;
    until?: string;
    service?: string;
  },
  deps: { code: CodeProvider },
): Promise<WhatChangedReport> {
  const t = await reconstructChangeTimeline(input, deps);

  // Tally commits by author
  const authorMap = new Map<string, number>();
  for (const commit of t.commits) {
    const prev = authorMap.get(commit.author) ?? 0;
    authorMap.set(commit.author, prev + 1);
  }
  const contributors: Contributor[] = [...authorMap]
    .map(([author, commits]) => ({ author, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 5);

  // Queue topology: collect files matching queue/processor patterns
  const queueFileSet = new Set<string>();
  for (const commit of t.commits) {
    for (const file of commit.files) {
      const lower = file.toLowerCase();
      if (
        /\.(processor|module)\.ts$/i.test(file) ||
        lower.includes('queue') ||
        lower.includes('processor')
      ) {
        queueFileSet.add(file);
        if (queueFileSet.size >= 20) break;
      }
    }
    if (queueFileSet.size >= 20) break;
  }
  const queueFiles = [...queueFileSet].slice(0, 20);
  const queueTopology = {
    touched: queueFiles.length > 0,
    files: queueFiles,
  };

  const topCommits = t.commits.slice(0, 3);

  // Git truth for the window: diff the same range the change impact uses
  // (oldest-in-window^ .. newest). Best-effort — a shallow clone or root commit
  // makes the range undiffable, which reports as null, never as fabricated zeros.
  let gitTruth: GitTruth | null = null;
  const newest = t.commits[0];
  const oldest = t.commits[t.commits.length - 1];
  if (newest !== undefined && oldest !== undefined) {
    const base = oldest.sha + '^';
    const diff = await gitDiffSummary(input.repoPath, base, newest.sha);
    if (diff !== null) {
      const buckets: Record<ChangeBucket, number> = { runtime: 0, test: 0, docs: 0, config: 0 };
      for (const f of diff.files) buckets[bucketForChange(f.path)] += 1;
      gitTruth = { base, compare: newest.sha, ...diff, buckets };
    }
  }

  const topContributor = contributors[0];
  const gitTruthPart =
    gitTruth !== null
      ? '; ' +
        gitTruth.fileCount +
        ' file(s) changed (+' +
        gitTruth.insertions +
        '/-' +
        gitTruth.deletions +
        ', ' +
        gitTruth.buckets.runtime +
        ' runtime)'
      : '';
  const dirtyPart = t.repoState?.dirty
    ? '; working tree has uncommitted changes (' +
      (t.repoState.stagedCount + t.repoState.unstagedCount) +
      ' modified, ' +
      t.repoState.untrackedCount +
      ' untracked)'
    : '';
  const summary =
    t.commits.length +
    ' commit(s)' +
    (input.service !== undefined ? ' touching ' + input.service : '') +
    (input.since !== undefined ? ' since ' + input.since : '') +
    gitTruthPart +
    (t.changeImpact !== null
      ? '; ' +
        t.changeImpact.added.length +
        ' symbols added/' +
        t.changeImpact.modified.length +
        ' modified/' +
        t.changeImpact.removed.length +
        ' removed'
      : '') +
    (topContributor !== undefined
      ? '; top contributor ' + topContributor.author + ' (' + topContributor.commits + ')'
      : '') +
    (queueTopology.touched ? '; queue/worker files changed (topology may have shifted)' : '') +
    dirtyPart +
    '.';

  const note =
    t.commits.length === 0 && t.repoState?.dirty
      ? 'No commits in the window, but the working tree carries uncommitted changes — see the repo state; they are excluded from commit history.'
      : 'A change is evidence, not a conclusion — confirm with logs/metrics before blaming a change.';

  return {
    window: {
      since: input.since ?? null,
      until: input.until ?? null,
      service: input.service ?? null,
    },
    commitCount: t.commits.length,
    topCommits,
    gitTruth,
    repoState: t.repoState,
    changeImpact: t.changeImpact,
    contributors,
    queueTopology,
    summary,
    note,
  };
}
