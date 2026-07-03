/**
 * HOR-386 — surfaces test. The router (`router.ts`) is the SINGLE decision point; every
 * surface (human text, `--json`, the packet, and — in the CLI — MCP) must render the SAME
 * `RouteStep[]`. These tests pin that one-source-of-truth invariant for the engine surfaces
 * and verify the human/markdown/json renderers actually emit the suggestions.
 */

import { describe, it, expect } from 'vitest';
import type { InvestigationReport } from './types.js';
import { renderReport, reportToMarkdown, reportToJSON } from './render.js';
import { buildPacket, packetToJSON, renderPacketMarkdown } from './packet.js';
import { route, formatRouteStep, formatRouteCommand, type RouterConditions } from './router.js';

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'inv-test',
    input: { hint: 'what depends on SlideEditorProvider' },
    summary: 'Impact of SlideEditorProvider: 4 affected symbol(s).',
    intent: 'source-impact',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0.6,
    nextActions: [],
    ...overrides,
  };
}

// The conditions a source-impact investigate run produces → blast-radius suggestion.
const CONDITIONS: RouterConditions = {
  command: 'investigate',
  intent: 'source-impact',
  seedName: 'SlideEditorProvider',
  query: 'what depends on SlideEditorProvider',
};

describe('HOR-386 surfaces — one router decision, rendered everywhere', () => {
  it('route() yields the blast-radius step for a source-impact investigation', () => {
    const steps = route(CONDITIONS);
    expect(steps).toEqual([
      {
        nextTool: 'blast-radius',
        args: 'SlideEditorProvider',
        reason: 'Full upstream/downstream blast radius for the named symbol.',
      },
    ]);
  });

  it('--json, packet, and the engine report all carry the IDENTICAL RouteStep[]', () => {
    const steps = route(CONDITIONS);
    const report = makeReport({ nextSteps: steps });

    // (b) --json surface: reportToJSON serializes report.nextSteps verbatim.
    const json = JSON.parse(reportToJSON(report)) as { nextSteps: unknown };
    expect(json.nextSteps).toEqual(steps);

    // packet surface: honesty.routing is the same array, co-assembled with caveats.
    const packet = buildPacket(report);
    expect(packet.honesty.routing).toEqual(steps);
    expect(packetToJSON(packet).honesty.routing).toEqual(steps);

    // All carriers agree — the single source of truth.
    expect(packet.honesty.routing).toEqual(json.nextSteps);
  });

  it('(a) human text renders "Suggested next" with the runnable command', () => {
    const steps = route(CONDITIONS);
    const report = makeReport({ nextSteps: steps });
    const text = renderReport(report);
    expect(text).toContain('## Suggested next');
    expect(text).toContain(formatRouteStep(steps[0]!));
    expect(text).toContain('`horus blast-radius SlideEditorProvider`');
  });

  it('markdown report renders the suggestion as a checkbox item', () => {
    const steps = route(CONDITIONS);
    const md = reportToMarkdown(makeReport({ nextSteps: steps }));
    expect(md).toContain('## Suggested next');
    expect(md).toContain(`- [ ] ${formatRouteStep(steps[0]!)}`);
  });

  it('packet markdown renders the routing under "Suggested next steps"', () => {
    const steps = route(CONDITIONS);
    const md = renderPacketMarkdown(buildPacket(makeReport({ nextSteps: steps })));
    expect(md).toContain('## Suggested next steps');
    expect(md).toContain(formatRouteCommand(steps[0]!));
  });

  it('no nextSteps ⇒ no "Suggested next" section (incident path stays clean)', () => {
    const report = makeReport({ intent: 'incident', nextSteps: [] });
    expect(renderReport(report)).not.toContain('## Suggested next');
    expect(reportToMarkdown(report)).not.toContain('## Suggested next');
    // packet routing is an empty array, not a fabricated step.
    expect(buildPacket(report).honesty.routing).toEqual([]);
  });

  it('formatRouteCommand omits the args separator when args is empty', () => {
    expect(formatRouteCommand({ nextTool: 'init', args: '', reason: 'x' })).toBe('horus init');
    expect(formatRouteCommand({ nextTool: 'search', args: 'Foo', reason: 'x' })).toBe(
      'horus search Foo',
    );
  });
});
