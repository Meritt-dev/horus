/**
 * HOR-386 — the shared, deterministic next-step router.
 *
 * A PURE module: no IO, no LLM, no command execution. Given a command + the conditions
 * the engine/surfaces already computed, it returns an ordered `RouteStep[]` of suggested
 * next commands. Adding a route = adding one table entry below.
 *
 * Honesty invariants (see spec §5):
 *   - Suggests, never runs. A `RouteStep` is advisory data only.
 *   - Never fabricates. Every `nextTool` is a REAL shipped command (`init`, `search`,
 *     `blast-radius`, `explain`, `connect <supported-type>`, `readiness`, `investigate`,
 *     `what-changed`, `owner`, `logs`, `metrics`, `queues`) or a real MCP knowledge tool
 *     (`search_project_knowledge`). There is NO `connect tracing`/`connect source` — those
 *     connectors do not exist in `connect.ts` (SUPPORTED = elasticsearch/mongodb/postgres/
 *     sentry/axiom/shopify/grafana/redis), so no rule emits them; the `traces` gap carries no `routeHint`.
 *   - Deterministic. Each rule fires on a known boolean/enum condition; same input ⇒ same
 *     output, byte-stable for snapshots. No probabilistic ranking, no generated prose.
 */

import type { Intent } from './engine.js';
import type { EvidenceGap } from './gaps.js';
import type { RouteStep } from './types.js';

export type { RouteStep };

/** The surface/command the router is producing next-steps for. */
export type RouterCommand =
  | 'investigate'
  | 'explain'
  | 'blast-radius'
  | 'packet'
  | 'memory'
  | 'search'
  | 'mcp.search'
  | 'mcp.ask'
  | 'mcp.contract'
  | 'mcp.domain';

/**
 * The facts the router decides over — every field is something a surface already computed
 * (the engine's `intent`, `gapAnalysis`, `report.degraded`, `report.confidence`, the
 * connector flags). The router invents nothing; it only re-shapes these.
 */
export interface RouterConditions {
  command: RouterCommand;
  /** The classified structural intent (HOR-385). */
  intent?: Intent;
  /** No seed / no result (the engine empty-return, or a 0-match MCP query). */
  empty?: boolean;
  /** `report.confidence` is below the routing threshold. */
  lowConfidence?: boolean;
  /**
   * The highest-impact evidence gap — `gapAnalysis.gaps` sorted by `confidenceImpact`
   * (callers MUST pass the sorted top, e.g. `gapNextSteps(gaps)` source, since
   * `detectMissingEvidence` pushes gaps in fixed insertion order, not impact order).
   */
  topGap?: EvidenceGap;
  /** Runtime intent but no source/runtime connector is configured. */
  noConnectors?: boolean;
  /** Source-intelligence host is unreachable. */
  hostUnreachable?: boolean;
  /** The code index is stale and should be rebuilt. */
  staleIndex?: boolean;
  /** `report.degraded.sourceIntelligence` — the run had no source intelligence. */
  degradedSourceIntelligence?: boolean;
  /** A performance hint with no metrics connector (`looksPerformance && deps.metrics == null`). */
  metricsNull?: boolean;
  /** The resolved seed name, for `blast-radius`/`explain` args. */
  seedName?: string;
  /** The raw hint, for `search`/`investigate` args. */
  query?: string;
}

/** One row of the routing table: a predicate over the conditions → zero or more steps. */
interface RouteRule {
  /** Stable id, used by the isolation test ("new route = new table entry"). */
  id: string;
  when: (c: RouterConditions) => boolean;
  steps: (c: RouterConditions) => RouteStep[];
}

const arg = (s: string | undefined): string => s ?? '';

/**
 * The ordered routing table (priority top→bottom). `route()` concatenates the steps of
 * EVERY matching rule, in table order — deterministic. Rule #1 (index remedy) sits first
 * so a degraded/stale run always leads with "rebuild the index".
 */
const RULES: RouteRule[] = [
  // 1 — any command: the source-intelligence host is down or the index is stale/degraded.
  {
    id: 'host-or-index-unhealthy',
    when: (c) => Boolean(c.hostUnreachable || c.staleIndex || c.degradedSourceIntelligence),
    steps: () => [
      {
        nextTool: 'init',
        args: '',
        reason: 'Source-intelligence host unreachable / index stale — run `horus init`.',
      },
    ],
  },
  // 2 — investigate with no seed matched: search the index for the right name.
  {
    id: 'investigate-empty',
    when: (c) => c.command === 'investigate' && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'search',
        args: arg(c.query),
        reason: 'No symbol matched — search the index for the right name.',
      },
    ],
  },
  // 3 — investigate classified as a structural impact question → blast-radius.
  {
    id: 'investigate-source-impact',
    when: (c) => c.command === 'investigate' && c.intent === 'source-impact',
    steps: (c) => [
      {
        nextTool: 'blast-radius',
        args: arg(c.seedName),
        reason: 'Full upstream/downstream blast radius for the named symbol.',
      },
    ],
  },
  // 4 — investigate classified as a behavioral how-does-it-work question → explain.
  {
    id: 'investigate-explain',
    when: (c) => c.command === 'investigate' && c.intent === 'explain',
    steps: (c) => [
      {
        nextTool: 'explain',
        args: arg(c.seedName),
        reason: 'Reads as a how-does-it-work question — `explain` walks the behavior.',
      },
    ],
  },
  // 5 — runtime intent but nothing connected: connect a source + see what's configured.
  {
    id: 'investigate-no-connectors',
    when: (c) => c.command === 'investigate' && Boolean(c.noConnectors),
    steps: () => [
      {
        nextTool: 'connect',
        args: 'elasticsearch',
        reason: 'No runtime connector — connect one to gather logs/metrics.',
      },
      {
        nextTool: 'readiness',
        args: '',
        reason: 'Check which connectors are configured.',
      },
    ],
  },
  // 6 — a performance hypothesis with no metrics backend.
  {
    id: 'investigate-metrics-null',
    when: (c) => c.command === 'investigate' && Boolean(c.metricsNull),
    steps: () => [
      {
        nextTool: 'connect',
        args: 'grafana',
        reason: 'No metrics connector — connect Grafana to confirm the perf hypothesis.',
      },
    ],
  },
  // 7 — low confidence: route to the top evidence gap's colocated, real remedy.
  {
    id: 'investigate-low-confidence-top-gap',
    when: (c) =>
      c.command === 'investigate' &&
      Boolean(c.lowConfidence) &&
      c.topGap?.routeHint != null,
    // The non-null is guaranteed by `when`; clone so callers can't mutate the gap.
    steps: (c) => [{ ...(c.topGap as EvidenceGap).routeHint! }],
  },
  // 8 — explain with no symbol found → search.
  {
    id: 'explain-empty',
    when: (c) => c.command === 'explain' && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'search',
        args: arg(c.query),
        reason: 'No symbol found — search for the right name.',
      },
    ],
  },
  // 9 — blast-radius with no symbol found → search.
  {
    id: 'blast-radius-empty',
    when: (c) => c.command === 'blast-radius' && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'search',
        args: arg(c.query),
        reason: 'No symbol found — search for the right name.',
      },
    ],
  },
  // 10 — memory show with nothing stored → run an investigation to populate it.
  {
    id: 'memory-empty',
    when: (c) => c.command === 'memory' && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'investigate',
        args: arg(c.query),
        reason: 'No stored memory — run an investigation to populate it.',
      },
    ],
  },
  // 11 — MCP search/ask with 0 matches → broaden the knowledge search.
  {
    id: 'mcp-search-empty',
    when: (c) => (c.command === 'mcp.search' || c.command === 'mcp.ask') && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'search_project_knowledge',
        args: arg(c.query),
        reason: 'No indexed knowledge matched — broaden the search.',
      },
    ],
  },
  // 12 — MCP contract/domain lookup miss → search across knowledge.
  {
    id: 'mcp-contract-empty',
    when: (c) =>
      (c.command === 'mcp.contract' || c.command === 'mcp.domain') && Boolean(c.empty),
    steps: (c) => [
      {
        nextTool: 'search_project_knowledge',
        args: arg(c.query),
        reason: 'No exact match — search across knowledge.',
      },
    ],
  },
];

/**
 * Resolve next-steps for a command + its detected conditions. Walks the table top→bottom
 * and concatenates the steps of every matching rule (deterministic order). Returns `[]`
 * when nothing matches — the surfaces simply render no suggestions.
 */
export function route(c: RouterConditions): RouteStep[] {
  const out: RouteStep[] = [];
  for (const rule of RULES) {
    if (rule.when(c)) out.push(...rule.steps(c));
  }
  return out;
}

/** The rule ids in priority order — exposed for the "new route = new table entry" test. */
export const ROUTE_RULE_IDS: readonly string[] = RULES.map((r) => r.id);

/**
 * The runnable `horus <tool> <args>` command string for a step — the single place a
 * `RouteStep` becomes a printable command, so every CLI surface renders it identically.
 * (MCP renders the structured `RouteStep` instead; it routes to sibling MCP tools, not
 * `horus` commands, so it never calls this.)
 */
export function formatRouteCommand(step: RouteStep): string {
  return `horus ${step.nextTool}${step.args ? ` ${step.args}` : ''}`;
}

/** A one-line human suggestion: `"<reason> → run \`horus <tool> <args>\`"`. */
export function formatRouteStep(step: RouteStep): string {
  return `${step.reason} → run \`${formatRouteCommand(step)}\``;
}
