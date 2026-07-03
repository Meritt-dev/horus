import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import {
  reconstructChangeTimeline,
  renderChangeTimeline,
  changeTimelineToJSON,
} from '@horus/engine';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';
import { readIndexMeta } from '../lib/freshness.js';

// Same default window as `horus what-changed` — a bounded, investigation-useful range
// instead of all history (which buried real signal under hundreds of commits, HOR-202).
const DEFAULT_SINCE = '7 days ago';

/**
 * Resolve the git `--since` window for the timeline. Defaults to the recent window;
 * `--all` opts into full history (wins over `--since`); an explicit `--since` overrides
 * the default. `usingDefault` is true only when neither `--all` nor `--since` was given.
 */
export function resolveTimelineWindow(opts: { since?: string; all?: boolean }): {
  since: string | undefined;
  usingDefault: boolean;
} {
  const usingDefault = !opts.all && opts.since === undefined;
  const since = opts.all ? undefined : (opts.since ?? DEFAULT_SINCE);
  return { since, usingDefault };
}

export const TIMELINE_AI_CONTRACT = `Provide a clearly separated AI interpretation section with:

Evidence used
- List the timeline events, commits, and change-impact signals Horus found

Narrative
- Group events into phases (e.g. pre-change, change window, symptom onset, recovery)
- Highlight any suspicious ordering (e.g. a change immediately before first error)
- Note what happened before vs. after the first symptom if identifiable

Confidence
- High / Medium / Low with a one-line reason

Gaps / Next checks
- Missing evidence dimensions (logs, metrics, traces, etc.)
- Exact Horus commands to fill the gaps`;

export async function runTimeline(
  service: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    since?: string;
    until?: string;
    json?: boolean;
    /** With --json: uncapped raw structure instead of the compact summary. */
    full?: boolean;
    /** Include all history instead of the default recent window. */
    all?: boolean;
    ai?: boolean;
    aiModel?: string;
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

    // Default to a bounded recent window for incident investigation (see helper).
    const { since, usingDefault: usingDefaultWindow } = resolveTimelineWindow(opts);

    // Source-index freshness travels with the timeline so a stale index is visible
    // right next to the git evidence it may lag behind.
    const indexMeta = readIndexMeta(renv.path);
    const t = await reconstructChangeTimeline(
      {
        repoPath: renv.path,
        since,
        until: opts.until,
        service,
        ...(indexMeta?.lastIndexedAt !== undefined
          ? { sourceIndex: { lastIndexedAt: indexMeta.lastIndexedAt } }
          : {}),
      },
      { code },
    );

    if (opts.json) {
      console.log(changeTimelineToJSON(t, { full: opts.full }));
    } else {
      console.log(renderChangeTimeline(t));
      if (usingDefaultWindow) {
        console.log(
          pc.dim(
            `\n  Showing the last 7 days (default). Widen with ` +
              `${pc.bold('--since "30 days ago"')}, pin a range with ` +
              `${pc.bold('--since <when> --until <when>')}, or see everything with ` +
              `${pc.bold('--all')}.`,
          ),
        );
      }

      if (opts.ai) {
        const result = await renderAiInterpretation({
          command: 'timeline',
          userIntent: service ? `service: ${service}` : undefined,
          evidence: t,
          promptKind: 'timeline-narrative',
          outputContract: TIMELINE_AI_CONTRACT,
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
