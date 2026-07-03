/**
 * HOR-386 — shared router unit tests.
 *
 * Two correctness properties the critique demanded are enforced here:
 *   1. Every route resolves to a REAL shipped command (no `connect tracing`/`connect source`).
 *   2. The dimension→tool mapping keys off the ACTUAL `EvidenceGap.dimension` constants
 *      emitted by `detectMissingEvidence` (verified by feeding real gaps through the router),
 *      and the router SORTS by `confidenceImpact` itself.
 */

import { describe, it, expect } from 'vitest';
import { route, ROUTE_RULE_IDS, type RouterConditions } from './router.js';
import { detectMissingEvidence, gapNextSteps, type EvidenceGap } from './gaps.js';
import type { InvestigationReport } from './types.js';

/**
 * Every command a `RouteStep.nextTool` may name — the shipped `horus` CLI commands plus the
 * one MCP knowledge tool. A route to anything NOT in this set is a fabrication bug. Mirrors
 * `packages/cli/src/index.ts` (.command(...)) + the SUPPORTED connector types in connect.ts.
 */
const REAL_TOOLS = new Set([
  'init',
  'search',
  'blast-radius',
  'explain',
  'connect',
  'readiness',
  'investigate',
  'what-changed',
  'owner',
  'logs',
  'metrics',
  'queues',
  'search_project_knowledge',
]);

/** Real `horus connect <type>` types (connect.ts SUPPORTED). */
const REAL_CONNECTORS = new Set([
  'elasticsearch',
  'mongodb',
  'postgres',
  'sentry',
  'grafana',
  'redis',
]);

function assertRealSteps(conds: RouterConditions): ReturnType<typeof route> {
  const steps = route(conds);
  for (const s of steps) {
    expect(REAL_TOOLS.has(s.nextTool)).toBe(true);
    // A `connect` step must name a real connector type — never `tracing`/`source`.
    if (s.nextTool === 'connect') expect(REAL_CONNECTORS.has(s.args)).toBe(true);
  }
  return steps;
}

describe('route() — every rule resolves to a real command', () => {
  it('host unreachable / stale index / degraded → init', () => {
    for (const c of [
      { command: 'investigate', hostUnreachable: true },
      { command: 'explain', staleIndex: true },
      { command: 'blast-radius', degradedSourceIntelligence: true },
    ] as RouterConditions[]) {
      const steps = assertRealSteps(c);
      expect(steps[0]!.nextTool).toBe('init');
    }
  });

  it('investigate + empty → search', () => {
    const steps = assertRealSteps({ command: 'investigate', empty: true, query: 'Foo' });
    expect(steps).toEqual([
      { nextTool: 'search', args: 'Foo', reason: expect.any(String) },
    ]);
  });

  it('investigate + source-impact → blast-radius on the seed', () => {
    const steps = assertRealSteps({
      command: 'investigate',
      intent: 'source-impact',
      seedName: 'SlideEditorProvider',
    });
    expect(steps[0]).toMatchObject({ nextTool: 'blast-radius', args: 'SlideEditorProvider' });
  });

  it('investigate + explain → explain on the seed', () => {
    const steps = assertRealSteps({
      command: 'investigate',
      intent: 'explain',
      seedName: 'getUser',
    });
    expect(steps[0]).toMatchObject({ nextTool: 'explain', args: 'getUser' });
  });

  it('investigate + noConnectors → connect a real source + readiness', () => {
    const steps = assertRealSteps({ command: 'investigate', noConnectors: true });
    expect(steps.map((s) => s.nextTool)).toEqual(['connect', 'readiness']);
    expect(REAL_CONNECTORS.has(steps[0]!.args)).toBe(true);
  });

  it('investigate + metricsNull → connect grafana', () => {
    const steps = assertRealSteps({ command: 'investigate', metricsNull: true });
    expect(steps[0]).toMatchObject({ nextTool: 'connect', args: 'grafana' });
  });

  it('explain + empty / blast-radius + empty → search', () => {
    for (const command of ['explain', 'blast-radius'] as const) {
      const steps = assertRealSteps({ command, empty: true, query: 'Bar' });
      expect(steps[0]).toMatchObject({ nextTool: 'search', args: 'Bar' });
    }
  });

  it('memory + empty → investigate', () => {
    const steps = assertRealSteps({ command: 'memory', empty: true, query: 'auth' });
    expect(steps[0]).toMatchObject({ nextTool: 'investigate', args: 'auth' });
  });

  it('mcp.search / mcp.ask / mcp.contract / mcp.domain + empty → search_project_knowledge', () => {
    for (const command of ['mcp.search', 'mcp.ask', 'mcp.contract', 'mcp.domain'] as const) {
      const steps = assertRealSteps({ command, empty: true, query: 'webhook' });
      expect(steps[0]).toMatchObject({ nextTool: 'search_project_knowledge', args: 'webhook' });
    }
  });
});

describe('route() — determinism & isolation', () => {
  it('is deterministic: same input → byte-identical output', () => {
    const c: RouterConditions = { command: 'investigate', intent: 'source-impact', seedName: 'X' };
    expect(route(c)).toEqual(route(c));
  });

  it('concatenates matching rules in stable table order (index remedy first)', () => {
    // A stale-index source-impact investigation matches rule #1 AND rule #3.
    const steps = route({
      command: 'investigate',
      intent: 'source-impact',
      staleIndex: true,
      seedName: 'X',
    });
    expect(steps.map((s) => s.nextTool)).toEqual(['init', 'blast-radius']);
  });

  it('unknown / unmatched conditions → no fabricated steps', () => {
    expect(route({ command: 'packet' })).toEqual([]);
    expect(route({ command: 'investigate', intent: 'incident' })).toEqual([]);
  });

  it('new route = new table entry: rule ids are unique and ordered', () => {
    expect(new Set(ROUTE_RULE_IDS).size).toBe(ROUTE_RULE_IDS.length);
    expect(ROUTE_RULE_IDS[0]).toBe('host-or-index-unhealthy');
  });
});

// ── dimension→tool mapping over the REAL EvidenceGap.dimension constants ──────────────────

/** A minimal report with no evidence/ownership → detectMissingEvidence emits every gap. */
function bareReport(service?: string): InvestigationReport {
  return {
    id: 'r1',
    input: { hint: 'something broke', ...(service ? { service } : {}) },
    summary: '',
    seeds: [{ id: 's1', name: 'PaymentService', filePath: 'a.ts' } as InvestigationReport['seeds'][number]],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [{} as never] }, // non-empty → queue-state gap fires
    correlation: { groups: [], chains: [], missing: [] as never },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0,
    nextActions: [],
  } as InvestigationReport;
}

describe('dimensionToStep — keyed off the real EvidenceGap.dimension constants', () => {
  const gaps = detectMissingEvidence(bareReport('payments')).gaps;

  it('emits exactly the known dimension strings', () => {
    expect(gaps.map((g) => g.dimension).sort()).toEqual(
      ['deployment records', 'logs', 'metrics', 'ownership', 'queue runtime state', 'traces'].sort(),
    );
  });

  it('every gap except `traces` carries a routeHint to a real command', () => {
    for (const g of gaps) {
      if (g.dimension === 'traces') {
        // No `tracing` connector exists → the gap must NOT fabricate a route.
        expect(g.routeHint).toBeUndefined();
      } else {
        expect(g.routeHint).toBeDefined();
        expect(REAL_TOOLS.has(g.routeHint!.nextTool)).toBe(true);
      }
    }
  });

  it('routeHints map to the expected real tools (ownership→owner, deployment→what-changed)', () => {
    const byDim = new Map(gaps.map((g) => [g.dimension, g.routeHint]));
    expect(byDim.get('logs')).toMatchObject({ nextTool: 'connect', args: 'elasticsearch' });
    expect(byDim.get('metrics')).toMatchObject({ nextTool: 'connect', args: 'grafana' });
    expect(byDim.get('queue runtime state')).toMatchObject({ nextTool: 'connect', args: 'redis' });
    expect(byDim.get('deployment records')).toMatchObject({
      nextTool: 'what-changed',
      args: 'payments',
    });
    expect(byDim.get('ownership')).toMatchObject({ nextTool: 'owner', args: 'PaymentService' });
  });

  it('gapNextSteps sorts by confidenceImpact and drops the route-less traces gap', () => {
    const steps = gapNextSteps(gaps);
    // 5 routable gaps (traces dropped), highest-impact first (logs/metrics/queue = 0.1).
    expect(steps).toHaveLength(5);
    expect(steps.every((s) => REAL_TOOLS.has(s.nextTool))).toBe(true);
    expect(steps.some((s) => s.nextTool === 'owner')).toBe(true); // 0.05, last
    expect(steps[steps.length - 1]!.nextTool).toBe('owner');
  });

  it('low-confidence investigate routes to the top gap’s routeHint', () => {
    const topGap = [...gaps]
      .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
      .find((g) => g.routeHint != null) as EvidenceGap;
    const steps = route({ command: 'investigate', lowConfidence: true, topGap });
    expect(steps).toEqual([topGap.routeHint]);
    expect(REAL_TOOLS.has(steps[0]!.nextTool)).toBe(true);
  });
});
