import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { openDb } from '@horus/db';
import { buildOnboarding, renderOnboarding, onboardingToJSON } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const ONBOARD_AI_CONTRACT = `Provide a clearly separated AI onboarding guide with:

Start here
- Files and components a new engineer should read first (only those Horus found)
- Entry points, controllers, workers, or queue producers most relevant to the area

Mental model
- How this area works in plain language, grounded in what Horus discovered
- Key data flows and async handoffs

What breaks here
- Common failure modes based on discovered components, async boundaries, and past incidents
- Frame each as "if X fails, then Y" using only evidence Horus found

Useful commands
- Exact Horus commands to continue exploring this area

Confidence / gaps
- What Horus knows confidently (indexed source, queue edges, past incidents)
- What is missing and would require manual inspection or a broader index`;

export async function runOnboard(
  area: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    // --repo maps 1:1 to a project name (HOR-34 compat). Resolve the default/single
    // project/env when --repo is omitted.
    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }
    const repo = { name: renv.project, path: renv.path };

    const code = codeForRepo(config, repo.name);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Source-intelligence host unreachable — run: horus init'),
      );
      return 1;
    }

    const { db, sql } = await openDb(config.database.url);
    try {
      const g = await buildOnboarding(
        { area },
        { code, db, repoPath: repo.path, project: renv.project },
      );
      if (opts.json) {
        console.log(onboardingToJSON(g));
      } else {
        console.log(renderOnboarding(g));
        if (opts.ai) {
          const result = await renderAiInterpretation({
            command: 'onboard',
            userIntent: area ? `area: ${area}` : undefined,
            evidence: g,
            promptKind: 'system-explanation',
            outputContract: ONBOARD_AI_CONTRACT,
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
