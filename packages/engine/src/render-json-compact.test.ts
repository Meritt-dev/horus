/**
 * Compact-by-default JSON serializers — agent-safety regression tests.
 *
 * Dogfood: `timeline --json` (~2.6 MB) and `what-changed --json` (~2.5 MB)
 * were unusable for agents. The compact projections must stay bounded on
 * fixture-heavy reports, carry full counts + truncation metadata, and still
 * answer the question (summary, top files/symbols, flows, timestamps).
 * `full: true` restores the raw structure.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import type { GitCommit } from '@horus/connectors';
import type { ChangeImpactReport } from './changes.js';
import type { ChangeTimeline } from './deploy-timeline.js';
import type { WhatChangedReport } from './what-changed.js';
import { changeImpactToJSON } from './render-changes.js';
import { changeTimelineToJSON } from './render-timeline.js';
import { whatChangedToJSON } from './render-what-changed.js';

// Generous ceiling for agent ingestion — the raw fixtures below serialize to
// multiple MB, so anything under this proves the caps are doing their job.
const BYTE_CAP = 64 * 1024;

function fatSymbol(i: number): Symbol {
  return {
    id: `sym:services:Service${i}.method${i}`,
    name: `method${i}`,
    filePath: `src/services/service-${i % 40}.service.ts`,
    startLine: i,
    endLine: i + 40,
    // Fat payload standing in for the raw source signatures/snippets that blew
    // up the full report.
    signature: `function method${i}(${'arg: string, '.repeat(50)})`,
  };
}

function heavyChangeImpact(): ChangeImpactReport {
  return {
    base: 'HEAD~200',
    compare: 'HEAD',
    added: Array.from({ length: 2000 }, (_, i) => fatSymbol(i)),
    removed: Array.from({ length: 500 }, (_, i) => fatSymbol(10_000 + i)),
    modified: Array.from({ length: 1000 }, (_, i) => ({
      before: fatSymbol(20_000 + i),
      after: fatSymbol(30_000 + i),
    })),
    affectedFlows: Array.from({ length: 300 }, (_, i) => ({
      flowId: `flow:${i}`,
      flowName: `Flow ${i}`,
      changedSymbols: Array.from({ length: 50 }, (_, j) => `method${i}_${j}`),
    })),
    summary: '2000 added, 500 removed, 1000 modified. 300 flow(s) affected.',
  };
}

function heavyCommits(n: number): GitCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${i}`,
    shortSha: `aaaa${i}`,
    author: `Dev ${i % 7}`,
    dateIso: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00+00:00`,
    subject: `feat: change number ${i} touching many files across the service layer`,
    files: Array.from({ length: 40 }, (_, j) => `src/modules/module-${j}/file-${i % 50}.ts`),
  }));
}

describe('changeImpactToJSON — compact by default', () => {
  const report = heavyChangeImpact();

  it('stays under the byte cap on a fixture-heavy report', () => {
    const compact = changeImpactToJSON(report);
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(BYTE_CAP);
  });

  it('carries counts, capped lists, and truncation metadata', () => {
    const out = JSON.parse(changeImpactToJSON(report));
    expect(out.counts).toEqual({ added: 2000, removed: 500, modified: 1000, affectedFlows: 300 });
    expect(out.added).toHaveLength(25);
    expect(out.added[0]).toEqual({ name: 'method0', filePath: 'src/services/service-0.service.ts' });
    expect(out.removed).toHaveLength(25);
    expect(out.modified).toHaveLength(25);
    expect(out.affectedFlows).toHaveLength(20);
    expect(out.affectedFlows[0].changedSymbols).toHaveLength(10);
    expect(out.truncated).toBe(true);
    expect(out.truncatedCount).toBeGreaterThan(0);
    expect(out.summary).toContain('2000 added');
  });

  it('emits no truncation metadata when nothing was omitted', () => {
    const small: ChangeImpactReport = {
      base: 'HEAD~1',
      compare: 'HEAD',
      added: [fatSymbol(1)],
      removed: [],
      modified: [],
      affectedFlows: [],
      summary: '1 added.',
    };
    const out = JSON.parse(changeImpactToJSON(small));
    expect(out.truncated).toBeUndefined();
    expect(out.truncatedCount).toBeUndefined();
  });

  it('full restores the raw report', () => {
    const out = JSON.parse(changeImpactToJSON(report, { full: true }));
    expect(out.added).toHaveLength(2000);
    expect(out.modified[0].before.signature).toContain('arg: string');
  });
});

describe('changeTimelineToJSON — compact by default', () => {
  const timeline: ChangeTimeline = {
    window: { since: '30 days ago', until: null, service: null },
    commits: heavyCommits(3000),
    repoState: null,
    changeImpact: heavyChangeImpact(),
    summary: '3000 commits in window.',
    note: 'git history is evidence, not conclusions.',
  };

  it('stays under the byte cap on a fixture-heavy timeline', () => {
    const compact = changeTimelineToJSON(timeline);
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(BYTE_CAP);
    // Sanity: the raw structure really is enormous — the cap is meaningful.
    expect(Buffer.byteLength(changeTimelineToJSON(timeline, { full: true }), 'utf8')).toBeGreaterThan(
      1024 * 1024,
    );
  });

  it('answers the question: summary, key timestamps, top files, commits, impact', () => {
    const out = JSON.parse(changeTimelineToJSON(timeline));
    expect(out.summary).toBe('3000 commits in window.');
    expect(out.commitCount).toBe(3000);
    expect(out.commits).toHaveLength(25);
    expect(out.commits[0]).toMatchObject({ shortSha: 'aaaa0', fileCount: 40 });
    expect(out.commits[0].files).toBeUndefined(); // per-commit lists are the blow-up source
    expect(out.firstCommitAt).toBeTruthy();
    expect(out.lastCommitAt).toBe(timeline.commits[0]!.dateIso);
    expect(out.topChangedFiles).toHaveLength(15);
    expect(out.topChangedFiles[0]).toHaveProperty('file');
    expect(out.topChangedFiles[0]).toHaveProperty('commits');
    expect(out.changeImpact.counts.added).toBe(2000);
    expect(out.truncated).toBe(true);
    expect(out.truncatedCount).toBe(3000 - 25);
  });

  it('full restores the raw timeline', () => {
    const out = JSON.parse(changeTimelineToJSON(timeline, { full: true }));
    expect(out.commits).toHaveLength(3000);
    expect(out.commits[0].files).toHaveLength(40);
  });
});

describe('whatChangedToJSON — compact by default', () => {
  const report: WhatChangedReport = {
    window: { since: '7 days ago', until: null, service: 'checkout' },
    commitCount: 3000,
    topCommits: heavyCommits(3).map((c) => ({
      ...c,
      files: Array.from({ length: 500 }, (_, j) => `src/generated/big-${j}.ts`),
    })),
    gitTruth: null,
    repoState: null,
    changeImpact: heavyChangeImpact(),
    contributors: [{ author: 'Dev 1', commits: 40 }],
    queueTopology: { touched: true, files: ['src/queues/order.processor.ts'] },
    summary: '3000 commits, 5 contributors.',
    note: 'evidence, not conclusions.',
  };

  it('stays under the byte cap on a fixture-heavy report', () => {
    const compact = whatChangedToJSON(report);
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(BYTE_CAP);
  });

  it('keeps summary, capped top commits, contributors, queue topology, and compact impact', () => {
    const out = JSON.parse(whatChangedToJSON(report));
    expect(out.summary).toBe('3000 commits, 5 contributors.');
    expect(out.commitCount).toBe(3000);
    expect(out.topCommits).toHaveLength(3);
    expect(out.topCommits[0].files).toHaveLength(10);
    expect(out.topCommits[0].fileCount).toBe(500);
    expect(out.contributors).toEqual([{ author: 'Dev 1', commits: 40 }]);
    expect(out.queueTopology.touched).toBe(true);
    expect(out.changeImpact.counts.modified).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.truncatedCount).toBe(3 * (500 - 10));
  });

  it('full restores the raw report', () => {
    const out = JSON.parse(whatChangedToJSON(report, { full: true }));
    expect(out.topCommits[0].files).toHaveLength(500);
    expect(out.changeImpact.added).toHaveLength(2000);
  });
});
