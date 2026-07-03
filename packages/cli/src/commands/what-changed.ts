import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors, resolvesToCommit } from '@horus/connectors';
import {
  whatChanged,
  renderWhatChanged,
  whatChangedToJSON,
  type WhatChangedReport,
} from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';

const DEFAULT_SINCE = '7 days ago';

/** Heuristic: does this --since value look like a git ref (HEAD~10, a sha, v1.2) rather than a date? */
export function looksLikeGitRef(s: string): boolean {
  const t = s.trim();
  if (/\s/.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t)) return false; // "7 days ago", ISO date
  return /[~^]/.test(t) || /^HEAD\b/.test(t) || /^[0-9a-f]{7,40}$/i.test(t) || /^v?\d+\.\d+/.test(t);
}

export const WHAT_CHANGED_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

Evidence used
- List the concrete changes/files/commits/timestamps Horus found

Interpretation
- Which change(s) look most incident-relevant and why
- Which changes are likely noise and why
- Any suspicious ordering or coverage gaps

Confidence
- High / Medium / Low with a one-line reason

Next checks
- Exact Horus commands or files to inspect next`;

export async function runWhatChanged(
  service: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    since?: string;
    until?: string;
    json?: boolean;
    /** With --json: uncapped raw structure instead of the compact summary. */
    full?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Push the report to the linked Horus Cloud project. */
    push?: boolean;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const { code } = createConnectors(config);

    const since = opts.since ?? DEFAULT_SINCE;

    // HOR-371: a ref-like --since that doesn't resolve (e.g. HEAD~10 on a shallow clone) is
    // silently treated as a date by git and yields zero commits. Warn instead of misleading.
    if (
      opts.since !== undefined &&
      looksLikeGitRef(opts.since) &&
      !(await resolvesToCommit(renv.path, opts.since))
    ) {
      console.error(
        pc.yellow(
          `Warning: --since "${opts.since}" does not resolve to a commit (shallow clone or unknown ref?); ` +
            `it will be treated as a date filter and likely return no commits.`,
        ),
      );
    }

    const r = await whatChanged(
      { repoPath: renv.path, since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? whatChangedToJSON(r, { full: opts.full }) : renderWhatChanged(r));

    if (opts.ai && !opts.json) {
      const result = await renderAiInterpretation({
        command: 'what-changed',
        userIntent: service ? `service: ${service}` : undefined,
        evidence: r,
        promptKind: 'change-risk',
        outputContract: WHAT_CHANGED_AI_CONTRACT,
        config: opts.config,
        modelOverride: opts.aiModel,
        provider: opts._aiProvider,
      });
      console.log('\n' + renderInterpretation(result));
      if (!result.ok) {
        console.error(pc.yellow(`[ai] ${result.warning}`));
      }
    }

    if (opts.push) {
      await pushChangeReport(r, opts.repo);
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

/**
 * Push a what-changed report to the linked Horus Cloud project so the team can
 * see it in the dashboard. Best-effort: a missing login/link or a network error
 * warns but never fails the command (the local report already printed).
 */
async function pushChangeReport(
  r: WhatChangedReport,
  repoCwd?: string,
): Promise<void> {
  const session = authedClient();
  if (!session) {
    console.error(pc.yellow('[cloud] not logged in — run `horus login` to push reports.'));
    return;
  }
  const cfg = readCloudConfig(repoRootOrCwd(repoCwd));
  if (!isCloudActive(cfg)) {
    console.error(pc.yellow('[cloud] repo not linked — run `horus cloud link` to push reports.'));
    return;
  }
  const projectId = cfg.project?.id;
  if (!projectId) return;

  const symName = (s: unknown): string => {
    if (s && typeof s === 'object') {
      const o = s as Record<string, unknown>;
      return String(o.name ?? o.fqn ?? o.id ?? o.symbol ?? '');
    }
    return String(s);
  };
  const ci = r.changeImpact;
  const payload: Record<string, unknown> = {
    summary: r.summary,
    note: r.note,
    window: r.window,
    commitCount: r.commitCount,
    // Git truth + working-tree state (cloud treats payload as opaque; bounded fields only).
    gitTruth:
      r.gitTruth == null
        ? null
        : {
            base: r.gitTruth.base,
            compare: r.gitTruth.compare,
            fileCount: r.gitTruth.fileCount,
            insertions: r.gitTruth.insertions,
            deletions: r.gitTruth.deletions,
            buckets: r.gitTruth.buckets,
          },
    workingTree:
      r.repoState == null
        ? null
        : {
            dirty: r.repoState.dirty,
            stagedCount: r.repoState.stagedCount,
            unstagedCount: r.repoState.unstagedCount,
            untrackedCount: r.repoState.untrackedCount,
          },
    topCommits: r.topCommits.map((c) => ({
      hash: c.shortSha,
      message: c.subject,
      author: c.author,
      files: c.files.length,
    })),
    changeImpact: ci
      ? {
          added: ci.added.map(symName),
          modified: ci.modified.map((m) => symName(m.after)),
          removed: ci.removed.map(symName),
        }
      : null,
    contributors: r.contributors,
    queueTopology: r.queueTopology,
  };

  try {
    await session.client.createChangeReport(projectId, {
      service: r.window.service ?? undefined,
      since: r.window.since ?? undefined,
      until: r.window.until ?? undefined,
      summary: r.summary,
      commitCount: r.commitCount,
      contributorCount: r.contributors.length,
      symbolsAdded: ci?.added.length ?? 0,
      symbolsModified: ci?.modified.length ?? 0,
      symbolsRemoved: ci?.removed.length ?? 0,
      queueTopologyTouched: r.queueTopology.touched,
      payload,
    });
    console.error(pc.dim('[cloud] pushed change report.'));
  } catch (err) {
    console.error(pc.yellow(`[cloud] push failed: ${(err as Error).message}`));
  }
}
