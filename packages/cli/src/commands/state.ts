/**
 * `horus state` — surface application-STATE evidence from MongoDB (HOR-33).
 * Read-only, allowlisted collections only. Reports counts, staleness, and
 * anomalous status distributions — never raw documents.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { mongoForEnv } from '@horus/connectors';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const STATE_AI_CONTRACT = `Provide a clearly separated AI evidence narration with:

Evidence used
- Exact collection names, document counts, staleness hours, and anomalous status values Horus found

What stands out
- Collections with stale records or anomalous status distributions
- Any counts that seem unusually low or high

What this may indicate
- Use "may suggest", "is consistent with", or "could indicate" — never "proves"
- Do not infer private data or claim access to document contents

What is not proven
- Claims that require reading actual document content or non-allowlisted collections

Next checks
- Exact Horus commands or database queries to inspect next`;

export async function runState(opts: {
  config?: string;
  env?: string;
  staleHours?: string;
  json?: boolean;
  ai?: boolean;
  aiModel?: string;
  /** Injectable AI provider for tests — bypasses credential resolution. */
  _aiProvider?: InterpretationProvider;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const mongo = mongoForEnv(renv);
    if (mongo === null) {
      console.error(
        pc.red(
          `No MongoDB connector configured for ${renv.project}/${renv.env} ` +
            `(set the project's Mongo URL env var).`,
        ),
      );
      return 1;
    }

    const health = await mongo.health();
    if (!health.ok) {
      console.error(pc.red(`MongoDB unreachable: ${health.detail}`));
      await mongo.close();
      return 1;
    }

    try {
      const staleHours = opts.staleHours !== undefined ? Number(opts.staleHours) : undefined;
      const analysis = await mongo.analyzeState(
        staleHours !== undefined ? { staleHours } : {},
      );

      if (opts.json) {
        const staleSignals = analysis.collections.filter((c) => c.isStale === true).length;
        const anomalousSignals = analysis.collections.reduce((n, c) => n + c.anomalies.length, 0);
        console.log(
          JSON.stringify(
            {
              scope: { project: renv.project, env: renv.env, database: analysis.database },
              autoDiscovered: analysis.autoDiscovered,
              signals: { stale: staleSignals, anomalous: anomalousSignals },
              collections: analysis.collections,
            },
            null,
            2,
          ),
        );
        return 0;
      }

      const discoveryNote = analysis.autoDiscovered
        ? pc.dim(` (${analysis.collections.length} collections, auto-discovered)`)
        : '';
      console.log(
        pc.bold('State analysis') +
          pc.dim(` — ${renv.project}/${renv.env} · db ${analysis.database}`) +
          discoveryNote,
      );
      console.log('');

      let signals = 0;
      for (const c of analysis.collections) {
        const flags: string[] = [];
        if (c.isStale === true) {
          flags.push(pc.yellow(`stale (last ${c.dateField}, ~${Math.round(c.ageHours ?? 0)}h)`));
        }
        for (const a of c.anomalies) {
          flags.push(pc.red(`${a.count}× "${a.value}"`));
          signals += 1;
        }
        if (c.isStale === true) signals += 1;

        const head = `  ${pc.bold(c.collection.padEnd(18).slice(0, 18))} ${pc.dim(String(c.count).padStart(8) + ' docs')}`;
        console.log(flags.length > 0 ? `${head}   ${flags.join('  ')}` : pc.dim(head));
      }

      console.log('');
      if (analysis.collections.length === 0) {
        console.log(
          pc.yellow('  No collections discovered in this database.') +
            pc.dim(' Verify the database name in your MongoDB connector config.'),
        );
      } else {
        const scope = analysis.autoDiscovered ? 'collection(s)' : 'allowlisted collection(s)';
        console.log(
          signals > 0
            ? `  ${pc.bold(String(signals))} state signal(s) across ${analysis.collections.length} ${scope}`
            : pc.dim(`  No state anomalies across ${analysis.collections.length} ${scope}.`),
        );
        if (analysis.autoDiscovered) {
          console.log(
            pc.dim(
              `  Tip: add a "collections" list to your MongoDB connector config to restrict analysis.`,
            ),
          );
        }
      }

      if (opts.ai) {
        const result = await renderAiInterpretation({
          command: 'state',
          evidence: analysis,
          promptKind: 'evidence-summary',
          outputContract: STATE_AI_CONTRACT,
          config: opts.config,
          modelOverride: opts.aiModel,
          provider: opts._aiProvider,
        });
        console.log('\n' + renderInterpretation(result));
        if (!result.ok) {
          console.error(pc.yellow(`[ai] ${result.warning}`));
        }
      }

      return 0;
    } finally {
      await mongo.close();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
