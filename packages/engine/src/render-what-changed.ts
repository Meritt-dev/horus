/**
 * HOR-30 — Render helpers for WhatChangedReport.
 */

import type { WhatChangedReport } from './what-changed.js';
import { changeImpactToCompactObject } from './render-changes.js';

// Cap for per-commit file lists in the compact (default) JSON projection. Dogfood:
// `what-changed --json` produced ~2.5 MB (raw change-impact Symbol arrays + full
// file lists) — unusable for agents.
const JSON_COMMIT_FILE_CAP = 10;

export function renderWhatChanged(r: WhatChangedReport): string {
  const lines: string[] = [];

  lines.push('# What changed');
  lines.push('');
  // Show the effective window so users can understand why counts may differ from horus timeline
  // (which uses all history when --since is not provided).
  const sinceLabel = r.window.since ?? '(all history)';
  const untilLabel = r.window.until ?? 'HEAD';
  lines.push('Range: ' + sinceLabel + ' → ' + untilLabel);
  lines.push(r.summary);
  lines.push('');
  lines.push('> ' + r.note);

  // Git truth FIRST — what the diff actually says, independent of the source index.
  if (r.gitTruth != null) {
    lines.push('');
    lines.push(
      '## Git truth: ' +
        r.gitTruth.fileCount +
        ' file(s) changed, +' +
        r.gitTruth.insertions +
        '/-' +
        r.gitTruth.deletions +
        ' (' +
        r.gitTruth.base +
        '..' +
        r.gitTruth.compare +
        ')',
    );
    lines.push(
      '  runtime ' +
        r.gitTruth.buckets.runtime +
        ' · test ' +
        r.gitTruth.buckets.test +
        ' · docs ' +
        r.gitTruth.buckets.docs +
        ' · config ' +
        r.gitTruth.buckets.config,
    );
    for (const f of r.gitTruth.files.slice(0, 10)) {
      lines.push('  ' + f.status + ' ' + f.path);
    }
    if (r.gitTruth.fileCount > 10) {
      lines.push('  +' + (r.gitTruth.fileCount - 10) + ' more');
    }
  }

  // Working tree — uncommitted changes are a change source commit history can't see.
  if (r.repoState?.dirty) {
    lines.push('');
    lines.push(
      '## Working tree (uncommitted): ' +
        r.repoState.stagedCount +
        ' staged, ' +
        r.repoState.unstagedCount +
        ' unstaged, ' +
        r.repoState.untrackedCount +
        ' untracked (+' +
        r.repoState.insertions +
        '/-' +
        r.repoState.deletions +
        ' vs HEAD)',
    );
  }

  // Top commits
  if (r.topCommits.length > 0) {
    lines.push('');
    lines.push('## Top commits');
    for (const c of r.topCommits) {
      lines.push('  ' + c.shortSha + '  ' + c.dateIso + '  ' + c.subject);
    }
  }

  // Top contributors
  if (r.contributors.length > 0) {
    lines.push('');
    lines.push(
      '## Top contributors: ' +
        r.contributors.map((c) => c.author + ' ×' + c.commits).join(', '),
    );
  }

  // Queue topology
  lines.push('');
  if (r.queueTopology.touched) {
    lines.push(
      '## Queue topology: touched — ' + r.queueTopology.files.slice(0, 6).join(', '),
    );
  } else {
    lines.push('## Queue topology: no queue/worker files changed');
  }

  // Structural impact — the source-index view, reported separately from git truth.
  if (r.changeImpact !== null) {
    lines.push('');
    lines.push(
      '## Structural impact (source index): ' +
        r.changeImpact.added.length +
        ' added / ' +
        r.changeImpact.modified.length +
        ' modified / ' +
        r.changeImpact.removed.length +
        ' removed symbols · ' +
        r.changeImpact.affectedFlows.length +
        ' execution flow(s) affected',
    );
    if (r.changeImpact.affectedFlows.length > 0) {
      for (const f of r.changeImpact.affectedFlows) {
        lines.push('  - ' + f.flowName);
      }
    }
  }

  return lines.join('\n');
}

/** Stable JSON serialization — compact by default; `full` restores the raw report. */
export function whatChangedToJSON(r: WhatChangedReport, opts?: { full?: boolean }): string {
  if (opts?.full) return JSON.stringify(r, null, 2);

  // Compact repo state: counts stay exact, file lists slim to 10 entries each.
  const compactRepoState =
    r.repoState == null
      ? null
      : {
          headSha: r.repoState.headSha,
          branch: r.repoState.branch,
          dirty: r.repoState.dirty,
          stagedCount: r.repoState.stagedCount,
          unstagedCount: r.repoState.unstagedCount,
          untrackedCount: r.repoState.untrackedCount,
          insertions: r.repoState.insertions,
          deletions: r.repoState.deletions,
          staged: r.repoState.staged.slice(0, 10),
          unstaged: r.repoState.unstaged.slice(0, 10),
          untracked: r.repoState.untracked.slice(0, 10),
        };

  let omittedFiles = 0;
  const topCommits = r.topCommits.map((c) => {
    omittedFiles += Math.max(0, c.files.length - JSON_COMMIT_FILE_CAP);
    return {
      shortSha: c.shortSha,
      dateIso: c.dateIso,
      author: c.author,
      subject: c.subject,
      fileCount: c.files.length,
      files: c.files.slice(0, JSON_COMMIT_FILE_CAP),
    };
  });

  return JSON.stringify(
    {
      window: r.window,
      summary: r.summary,
      note: r.note,
      commitCount: r.commitCount,
      // Git truth first; the structural (source-index) impact is a separate field below.
      gitTruth:
        r.gitTruth == null
          ? null
          : {
              ...r.gitTruth,
              files: r.gitTruth.files.slice(0, 25),
            },
      repoState: compactRepoState,
      topCommits,
      contributors: r.contributors,
      queueTopology: r.queueTopology,
      changeImpact: r.changeImpact == null ? null : changeImpactToCompactObject(r.changeImpact),
      ...(omittedFiles > 0
        ? { truncated: true, truncatedCount: omittedFiles, hint: 're-run with --full for the complete structure' }
        : {}),
    },
    null,
    2,
  );
}
