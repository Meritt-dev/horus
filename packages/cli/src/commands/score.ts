import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, getInvestigation, listInvestigationsWithReports } from '@horus/db';
import { formatDateTime } from '../lib/format.js';
import { resolveDbUrl } from '../lib/db-url.js';
import {
  scoreInvestigation,
  renderScore,
  scoreToJSON,
  migrateReport,
} from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const SCORE_AI_CONTRACT = `Provide a clearly separated AI score explanation with:

Why this scored this way
- Explain each weak dimension (low value, low weight contribution)
- Ground each explanation in what Horus found or failed to find

Biggest improvement lever
- The single dimension where better evidence would move the score most
- Exact investigation step or command to gather that evidence

Suggested improvements
- Specific ideas for how Horus could gather better evidence next time
- Be concrete: what connector, query, or signal is missing`;

export async function runScore(
  id: string,
  opts: {
    config?: string;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  const { db, sql } = await openDb(await resolveDbUrl(opts.config));
  try {
    const row = await getInvestigation(db, id);
    if (!row) {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    if (!row.report) {
      console.error(pc.red('Investigation ' + id + ' has no stored report.'));
      return 1;
    }
    const s = scoreInvestigation(migrateReport(row.report) as InvestigationReport);

    if (opts.json) {
      console.log(scoreToJSON(s));
    } else {
      console.log(renderScore(s));
      if (opts.ai) {
        const result = await renderAiInterpretation({
          command: 'score',
          userIntent: `investigation: ${id}`,
          evidence: s,
          promptKind: 'evidence-summary',
          outputContract: SCORE_AI_CONTRACT,
          config: opts.config,
          modelOverride: opts.aiModel,
          provider: opts._aiProvider,
        });
        console.log('\n' + renderInterpretation(result));
        if (!result.ok) {
          console.error(pc.yellow(`[ai] ${result.warning}`));
        }
      }
    }
  } finally {
    await sql.end();
  }
  return 0;
}

export async function runScores(opts: {
  config?: string;
  limit?: number;
}): Promise<number> {
  // Score THIS project's investigations only (dogfood N1 — shared-DB isolation).
  let project: string | undefined;
  try {
    project = resolveEnvironment(await loadConfig(opts.config)).project;
  } catch {
    /* unresolvable — leave unscoped */
  }
  const { db, sql } = await openDb(await resolveDbUrl(opts.config));
  try {
    const rows = await listInvestigationsWithReports(db, opts.limit ?? 15, { project });
    const scored = rows
      .filter((r) => r.report)
      .map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        score: scoreInvestigation(migrateReport(r.report) as InvestigationReport).score,
      }));
    if (scored.length === 0) {
      console.log('No scored investigations yet.');
      return 0;
    }
    for (const s of scored) {
      console.log(
        '  ' +
          String(s.score).padStart(3) +
          '/100  ' +
          formatDateTime(s.createdAt) +
          '  ' +
          s.id +
          '  ' +
          (s.title ?? ''),
      );
    }
    const avg = Math.round(
      scored.reduce((n, s) => n + s.score, 0) / scored.length,
    );
    console.log('  avg ' + avg + '/100 across ' + scored.length + ' investigation(s)');
  } finally {
    await sql.end();
  }
  return 0;
}
