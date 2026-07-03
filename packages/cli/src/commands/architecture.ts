import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { openDb } from '@horus/db';
import { discoverArchitecture, renderArchitecture, architectureToJSON } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const ARCHITECTURE_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

System summary
- What the system appears to do based on subsystems, external systems, and key flows Horus found
- Major subsystems and their responsibilities

Critical paths
- Important flows and async boundaries found by Horus
- Queues, workers, and external API touch points

Fragility / risk points
- Areas where coupling, queues, external systems, or unclear ownership create risk
- Refer only to components and boundaries Horus discovered

How to investigate this system
- Useful Horus commands to explore further (blast-radius, investigate, timeline, etc.)
- Specific files or symbols worth inspecting

Confidence / gaps
- Where Horus evidence was strong (e.g. indexed source, queue edges)
- What evidence is missing and what to do to fill those gaps`;

export async function runArchitecture(opts: {
  config?: string;
  repo?: string;
  json?: boolean;
  ai?: boolean;
  aiModel?: string;
  /** Injectable AI provider for tests — bypasses credential resolution. */
  _aiProvider?: InterpretationProvider;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Source-intelligence host unreachable — run: horus init'),
      );
      return 1;
    }

    // Resolve the active project so async boundaries (queue edges) are scoped to it —
    // otherwise another project's queues leak into this repo's architecture (HOR-207).
    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable (multi-project, no cwd match) — leave unscoped */
    }

    const { db, sql } = await openDb(config.database.url);
    try {
      const m = await discoverArchitecture({ code, db, project });
      if (opts.json) {
        console.log(architectureToJSON(m));
      } else {
        console.log(renderArchitecture(m));
        if (opts.ai) {
          const result = await renderAiInterpretation({
            command: 'architecture',
            evidence: m,
            promptKind: 'system-explanation',
            outputContract: ARCHITECTURE_AI_CONTRACT,
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
