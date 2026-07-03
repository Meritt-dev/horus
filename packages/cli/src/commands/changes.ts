import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { changeImpact, renderChangeImpact, changeImpactToJSON } from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const CHANGES_AI_CONTRACT = `Provide a clearly separated AI change-impact review with:

Highest-risk changes
- Files, symbols, or flows most likely to matter for correctness or stability
- Explain why based on affected flows and change types (added/removed/modified)

Review focus
- What the reviewer should inspect first
- Specific symbols or files worth extra attention

Testing suggestions
- Specific smoke tests or checks based on affected flows
- Only reference flows and symbols Horus found

Confidence / gaps
- Where Horus evidence is strong (full flow coverage)
- What is missing (e.g. no affected flows found — no source index, or no matching flows)`;

export async function runChanges(
  base: string,
  compare: string | undefined,
  opts: {
    config?: string;
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
      console.error(
        pc.red('Source-intelligence host unreachable — run: horus init'),
      );
      return 1;
    }

    const report = await changeImpact({ base, compare }, { code });

    if (opts.json) {
      console.log(changeImpactToJSON(report));
    } else {
      console.log(renderChangeImpact(report));
      if (opts.ai) {
        const result = await renderAiInterpretation({
          command: 'changes',
          userIntent: `base: ${base}, compare: ${compare ?? 'HEAD'}`,
          evidence: report,
          promptKind: 'change-risk',
          outputContract: CHANGES_AI_CONTRACT,
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

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
