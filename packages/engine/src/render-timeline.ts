/**
 * Human-facing renderers for a ChangeTimeline. Pure, deterministic, no I/O.
 */

import type { ChangeTimeline } from './deploy-timeline.js';
import { changeImpactToCompactObject } from './render-changes.js';

const COMMIT_CAP = 25;

// Caps for the compact (default) JSON projection. Dogfood: `timeline --json`
// produced ~2.6 MB (every commit with its full file list) — unusable for agents.
const JSON_COMMIT_CAP = 25;
const JSON_TOP_FILE_CAP = 15;

/** Sectioned text report for terminal output. */
export function renderChangeTimeline(t: ChangeTimeline): string {
  const lines: string[] = [];

  lines.push('# Change Timeline');
  lines.push('');

  lines.push('## Summary');
  // Show the effective window so users understand why counts may differ from horus what-changed
  // (which defaults to 7 days) or horus changes (which takes explicit refs).
  const sinceLabel = t.window.since ?? '(all history)';
  const untilLabel = t.window.until ?? 'HEAD';
  lines.push('Range: ' + sinceLabel + ' → ' + untilLabel);
  lines.push(t.summary);
  lines.push('');

  lines.push('> ' + t.note);
  lines.push('');

  // Working tree — uncommitted changes are a change source `git log` can't see.
  if (t.repoState?.dirty) {
    lines.push(
      '## Working tree (uncommitted): ' +
        t.repoState.stagedCount +
        ' staged, ' +
        t.repoState.unstagedCount +
        ' unstaged, ' +
        t.repoState.untrackedCount +
        ' untracked (+' +
        t.repoState.insertions +
        '/-' +
        t.repoState.deletions +
        ' vs HEAD)',
    );
    lines.push('');
  }

  lines.push('## Commits');
  if (t.commits.length === 0) {
    lines.push('  (none in window)');
  } else {
    const shown = t.commits.slice(0, COMMIT_CAP);
    for (const c of shown) {
      lines.push(
        '  ' +
          c.shortSha +
          ' ' +
          c.dateIso +
          '  ' +
          c.subject +
          '  (' +
          c.files.length +
          ' file(s))',
      );
    }
    const remaining = t.commits.length - shown.length;
    if (remaining > 0) {
      lines.push('  +' + remaining + ' more');
    }
  }

  if (t.changeImpact !== null) {
    lines.push('');
    lines.push('## Change impact');
    // Show the exact git refs so users can cross-reference with horus changes <base> <compare>.
    lines.push('Git range: ' + t.changeImpact.base + '..' + t.changeImpact.compare);
    lines.push(t.changeImpact.summary);
    if (t.changeImpact.affectedFlows.length > 0) {
      for (const f of t.changeImpact.affectedFlows) {
        lines.push('  - ' + f.flowName);
      }
    }
  }

  return lines.join('\n');
}

/** Stable JSON serialization — compact by default; `full` restores the raw timeline. */
export function changeTimelineToJSON(t: ChangeTimeline, opts?: { full?: boolean }): string {
  if (opts?.full) return JSON.stringify(t, null, 2);

  const commits = t.commits.slice(0, JSON_COMMIT_CAP).map((c) => ({
    shortSha: c.shortSha,
    dateIso: c.dateIso,
    author: c.author,
    subject: c.subject,
    fileCount: c.files.length,
  }));

  // Top changed files across the WHOLE window (not just the shown commits), so the
  // compact view still answers "what files churned" without the raw per-commit lists.
  const fileCounts = new Map<string, number>();
  for (const c of t.commits) {
    for (const f of c.files) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
  }
  const topChangedFiles = [...fileCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, JSON_TOP_FILE_CAP)
    .map(([file, commitCount]) => ({ file, commits: commitCount }));

  // Compact repo state: counts stay exact, file lists slim to 10 entries each.
  const compactRepoState =
    t.repoState == null
      ? null
      : {
          headSha: t.repoState.headSha,
          branch: t.repoState.branch,
          dirty: t.repoState.dirty,
          stagedCount: t.repoState.stagedCount,
          unstagedCount: t.repoState.unstagedCount,
          untrackedCount: t.repoState.untrackedCount,
          insertions: t.repoState.insertions,
          deletions: t.repoState.deletions,
          staged: t.repoState.staged.slice(0, 10),
          unstaged: t.repoState.unstaged.slice(0, 10),
          untracked: t.repoState.untracked.slice(0, 10),
        };

  const truncatedCount = t.commits.length - commits.length;
  return JSON.stringify(
    {
      window: t.window,
      summary: t.summary,
      note: t.note,
      repoState: compactRepoState,
      ...(t.sourceIndex != null ? { sourceIndex: t.sourceIndex } : {}),
      commitCount: t.commits.length,
      // Commits are newest-first (git log order) — expose the window edges directly.
      firstCommitAt: t.commits[t.commits.length - 1]?.dateIso ?? null,
      lastCommitAt: t.commits[0]?.dateIso ?? null,
      commits,
      topChangedFiles,
      changeImpact: t.changeImpact == null ? null : changeImpactToCompactObject(t.changeImpact),
      ...(truncatedCount > 0
        ? { truncated: true, truncatedCount, hint: 're-run with --full for the complete structure' }
        : {}),
    },
    null,
    2,
  );
}
