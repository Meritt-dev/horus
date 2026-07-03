import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { openDb } from '@horus/db';
import {
  investigate,
  SCENARIOS,
  getScenario,
  evaluateScenario,
  renderScenarioList,
  renderSimulation,
} from '@horus/engine';

export async function runSimulate(
  scenarioId: string | undefined,
  opts: { config?: string; repo?: string },
): Promise<number> {
  try {
    // No scenario id — list all available scenarios.
    if (scenarioId === undefined) {
      console.log(renderScenarioList(SCENARIOS));
      return 0;
    }

    const scenario = getScenario(scenarioId);
    if (scenario === null) {
      console.error(
        pc.red(
          `Unknown scenario: "${scenarioId}". Run horus simulate to list available scenarios.`,
        ),
      );
      return 1;
    }

    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const code = codeForRepo(config, renv.project);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Source-intelligence host unreachable — run: horus init'),
      );
      return 1;
    }

    const { db, sql } = await openDb(config.database.url);
    try {
      const report = await investigate(
        { hint: scenario.hint, repo: renv.project, since: scenario.since },
        { code, db },
      );
      const evaluation = evaluateScenario(scenario, report);
      console.log(renderSimulation(scenario, report, evaluation));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
