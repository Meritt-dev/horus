import pc from 'picocolors';
import { openDb, getInvestigation, updateInvestigationReport } from '@horus/db';
import { renderReport, reportToMarkdown, reportToJSON, migrateReport } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative } from '@horus/ai';
import { buildNarrativeProvider } from '../lib/ai-provider.js';
import {
  buildNarrativeInput,
  renderStoredAIJudgment,
  narrativeOutputToStoredJudgment,
} from './investigate.js';

export async function runReplay(
  id: string,
  opts: {
    config?: string;
    format?: string;
    ai?: boolean;
    aiModel?: string;
    /** Re-run AI even if a stored judgment already exists. */
    refreshAi?: boolean;
  },
): Promise<number> {
  const { db, sql } = await openDb();
  try {
    const row = await getInvestigation(db, id);
    if (!row) {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    if (!row.report) {
      console.error(
        pc.red(
          'Investigation ' +
            id +
            ' has no stored report (run a newer investigation).',
        ),
      );
      return 1;
    }
    const report = migrateReport(row.report) as InvestigationReport;
    const fmt = opts.format ?? 'text';
    const out =
      fmt === 'json'
        ? reportToJSON(report)
        : fmt === 'markdown' || fmt === 'md'
          ? reportToMarkdown(report)
          : renderReport(report);
    console.log(out);

    if (opts.ai && fmt !== 'json') {
      // Use stored judgment unless --refresh-ai is set (HOR-198)
      if (report.aiJudgment && !opts.refreshAi) {
        renderStoredAIJudgment(report.aiJudgment);
        console.log(pc.dim('[ai] Stored judgment replayed. Use --refresh-ai to regenerate.'));
      } else {
        const narrativeInput = buildNarrativeInput(report);
        // Resolve the key/model saved via `horus connect ai` (env fallback) — same as
        // investigate, so replay --ai works without exporting ANTHROPIC_API_KEY (HOR-215).
        const { provider } = await buildNarrativeProvider({
          config: opts.config,
          modelOverride: opts.aiModel,
        });
        const { output, fromProvider, degraded, validationErrors } = await renderNarrative(
          narrativeInput,
          { provider },
        );

        if (!fromProvider && degraded) {
          // Usable AI prose that didn't fully validate — show it as a labeled raw section
          // rather than discarding it for deterministic-only output (HOR-213).
          if (validationErrors?.length) {
            console.error(pc.yellow('[ai] structured validation incomplete — showing raw AI narrative'));
          }
          console.log('');
          console.log(pc.dim('─'.repeat(60)));
          console.log(pc.bold('AI narrative ') + pc.yellow('(unstructured — not validated)'));
          if (output.what?.trim()) console.log(pc.bold('\nWhat:'), output.what.trim());
          if (output.why?.trim()) console.log(pc.bold('\nWhy:'), output.why.trim());
        } else if (!fromProvider) {
          console.error(pc.yellow('[ai] Provider unavailable — deterministic output shown above.'));
          if (validationErrors?.length) {
            console.error(pc.dim(`    ${validationErrors[0]}`));
          }
        } else {
          const stored = narrativeOutputToStoredJudgment(output, 'anthropic');
          report.aiJudgment = stored;
          try {
            await updateInvestigationReport(db, report.id, report);
          } catch {
            // best-effort
          }
          renderStoredAIJudgment(stored);
        }
      }
    }
  } finally {
    await sql.end();
  }
  return 0;
}
