import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { openDb, getInvestigation } from '@horus/db';
import { generatePostmortem, migrateReport } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';
import { renderNarrative } from '@horus/ai';
import { buildNarrativeProvider } from '../lib/ai-provider.js';
import { buildNarrativeInput, narrativeOutputToStoredJudgment } from './investigate.js';

/**
 * HOR-26 — Draft an editable postmortem from a persisted investigation.
 * HOR-111 — adds --output <path> / --force for Markdown file export.
 * HOR-15  — adds --ai-summary to append an AI-generated summary section.
 * Read-only from Postgres; never touches the source-intelligence host or connectors.
 */
export async function runPostmortem(
  id: string,
  opts: {
    config?: string;
    output?: string;
    force?: boolean;
    write?: (line: string) => void;
    /** Bypass DB for unit tests — inject a pre-built report directly. */
    _report?: InvestigationReport;
    aiSummary?: boolean;
    aiModel?: string;
    /** Re-run AI even if a stored judgment already exists. */
    refreshAi?: boolean;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));
  let sql: { end: () => Promise<void> } | undefined;
  try {
    let report: InvestigationReport;

    if (opts._report !== undefined) {
      report = opts._report;
    } else {
      const conn = await openDb();
      sql = conn.sql;
      const { db } = conn;
      const row = await getInvestigation(db, id);
      if (!row) {
        log(pc.red('No investigation found: ' + id));
        return 1;
      }
      if (!row.report) {
        log(pc.red('Investigation ' + id + ' has no stored report.'));
        return 1;
      }
      report = migrateReport(row.report) as InvestigationReport;
    }

    let content = generatePostmortem(report);

    if (opts.aiSummary) {
      // Use stored AI judgment when available (HOR-198); only call AI if --refresh-ai or no stored judgment
      const storedJudgment = report.aiJudgment;
      if (storedJudgment && !opts.refreshAi) {
        content += '\n\n## AI Summary\n\n';
        content += `_Stored AI judgment (provider: ${storedJudgment.provider}, generated: ${storedJudgment.generatedAt})_\n\n`;
        content += `**What happened:** ${storedJudgment.what}\n\n`;
        content += `**Why:** ${storedJudgment.why}\n`;
        if (storedJudgment.rootCauseAssessment) {
          content += `\n**Root cause (AI):** ${storedJudgment.rootCauseAssessment.summary}\n`;
          content += `_(uncertainty: ${storedJudgment.rootCauseAssessment.uncertainty})_\n`;
        }
        if (storedJudgment.whereNext.length > 0) {
          content += '\n**Next steps:**\n';
          for (const step of storedJudgment.whereNext) {
            content += `- ${step}\n`;
          }
        }
        if (storedJudgment.citations.length > 0) {
          content += `\n**Cited evidence:** ${storedJudgment.citations.map((c) => c.evidenceId).join(', ')}\n`;
        }
      } else {
        const narrativeInput = buildNarrativeInput(report);
        // Resolve the key/model saved via `horus connect ai` (env fallback), same as
        // investigate — so postmortem --ai works without exporting the env var (HOR-215).
        const { provider } = await buildNarrativeProvider({
          config: opts.config,
          modelOverride: opts.aiModel,
        });
        const { output, fromProvider, degraded, validationErrors } = await renderNarrative(
          narrativeInput,
          { provider },
        );

        if (!fromProvider && degraded) {
          // Usable AI prose that didn't fully validate — record it as a clearly-labeled
          // unstructured section rather than 'unavailable' (HOR-213). Not persisted as a
          // validated judgment (only the structured/valid path sets report.aiJudgment).
          content += '\n\n## AI Summary (unstructured — not validated)\n\n';
          if (output.what?.trim()) content += `**What happened:** ${output.what.trim()}\n\n`;
          if (output.why?.trim()) content += `**Why:** ${output.why.trim()}\n`;
        } else if (!fromProvider) {
          // No usable AI text — provider threw (network/auth). validationErrors[0] here is
          // the thrown error message, not a validation/hallucination detail.
          content += `\n\n## AI Summary\n\n_AI summary unavailable: ${validationErrors?.[0] ?? 'provider error'}_\n`;
        } else {
          content += '\n\n## AI Summary\n\n';
          content += `**What happened:** ${output.what}\n\n`;
          content += `**Why:** ${output.why}\n`;
          if (output.rootCauseAssessment) {
            content += `\n**Root cause (AI):** ${output.rootCauseAssessment.summary}\n`;
            content += `_(uncertainty: ${output.rootCauseAssessment.uncertainty})_\n`;
          }
          if (output.whereNext.length > 0) {
            content += '\n**Next steps:**\n';
            for (const step of output.whereNext) {
              content += `- ${step}\n`;
            }
          }
          if (output.citations.length > 0) {
            content += `\n**Cited evidence:** ${output.citations.map((c) => c.evidenceId).join(', ')}\n`;
          }
          // Persist AI judgment for future use (HOR-198) — best effort via report mutation
          report.aiJudgment = narrativeOutputToStoredJudgment(output, 'anthropic');
        }
      }
    }

    if (opts.output) {
      const outputPath = resolve(opts.output);
      if (existsSync(outputPath) && !opts.force) {
        log(pc.red('✗') + ' ' + outputPath + ' already exists');
        log(pc.dim('  pass --force to overwrite'));
        return 1;
      }
      try {
        writeFileSync(outputPath, content, 'utf8');
      } catch (err) {
        log(pc.red('✗ Could not write ' + outputPath + ': ') + (err as Error).message);
        return 1;
      }
      log(pc.green('✓') + ' Saved postmortem to ' + outputPath);
    } else {
      log(content);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(pc.red('postmortem failed: ' + message));
    return 1;
  } finally {
    if (sql) {
      await sql.end();
    }
  }
  return 0;
}
