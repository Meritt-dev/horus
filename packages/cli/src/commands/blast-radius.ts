import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { openDb } from '@horus/db';
import { analyzeBlastRadius, renderBlastRadius, blastRadiusToJSON, route, formatRouteStep } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const BLAST_RADIUS_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

Evidence used
- The matched component(s), upstream dependencies, downstream callers, and async boundaries Horus found

Likely impact
- What users or operators would notice if this component fails
- Which services/flows are inside the blast radius and at direct risk
- Which services/flows appear outside the blast radius

Containment ideas
- Safe mitigations grounded only in the dependencies Horus found
- Rollback or disable suggestions only when supported by the evidence (prefix with "verify before doing this")
- Async boundaries to isolate (queues, workers, cron jobs, webhooks, external APIs)

Confidence
- High / Medium / Low with a one-line reason

Next checks
- Exact Horus commands or files to inspect next`;

export async function runBlastRadius(
  query: string,
  opts: {
    config?: string;
    repo?: string;
    depth?: number;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      // HOR-386 — host down: the router points at `horus init`.
      const steps = route({ command: 'blast-radius', hostUnreachable: true });
      if (opts.json) {
        console.log(JSON.stringify({ error: 'Source-intelligence host unreachable', nextSteps: steps }, null, 2));
      } else {
        console.error(pc.red('Source-intelligence host unreachable — run: horus init'));
        for (const s of steps) console.log(pc.dim('  Suggested next: ') + formatRouteStep(s));
      }
      return 1;
    }

    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable — leave unscoped */
    }

    const { db, sql } = await openDb(config.database.url);
    try {
      const r = await analyzeBlastRadius(query, { code, db, project }, opts.depth ?? 3);
      if (!r) {
        // HOR-386 — no symbol matched: the router points at `horus search <query>`.
        const steps = route({ command: 'blast-radius', empty: true, query });
        if (opts.json) {
          console.log(JSON.stringify({ symbol: null, nextSteps: steps }, null, 2));
        } else {
          console.log(`No symbol found for: ${query}`);
          console.log(pc.dim(`  Tip: use an exact class or function name, e.g. "MyService"`));
          for (const s of steps) console.log(pc.dim('  Suggested next: ') + formatRouteStep(s));
        }
        return 1;
      }
      if (r.seed.name.toLowerCase() !== query.toLowerCase()) {
        console.log(
          pc.yellow(`  No exact match for "${query}"`) +
            pc.dim(` — showing closest: "${r.seed.name}" (fuzzy match)`),
        );
      }
      if (opts.json) {
        // HOR-386 — bolt the SAME router's structured next-steps onto the --json shape
        // (mirrors investigate.ts adding `freshness`). Empty on the happy path.
        const obj = JSON.parse(blastRadiusToJSON(r)) as Record<string, unknown>;
        obj.nextSteps = route({ command: 'blast-radius', seedName: r.seed.name, query });
        console.log(JSON.stringify(obj, null, 2));
      } else {
        console.log(renderBlastRadius(r));
        if (opts.ai) {
          const result = await renderAiInterpretation({
            command: 'blast-radius',
            userIntent: `query: ${query}`,
            evidence: r,
            promptKind: 'blast-radius',
            outputContract: BLAST_RADIUS_AI_CONTRACT,
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
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
