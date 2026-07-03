/**
 * Config-driven evidence routing — report-level regression tests.
 *
 * Dogfood: gap consolidation treated zero runtime connectors neutrally, but the
 * router still LED with `connect elasticsearch` / `connect grafana`, so a single
 * report contradicted itself (gaps: "runtime evidence is optional/unavailable";
 * nextSteps: connector-setup nags). These tests pin the contract at the report
 * level: a zero-runtime config gets source/config follow-ups first, never
 * `connect`; a configured-but-unavailable connector is named as such.
 */
import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';
import { hasAnyRuntimeConnector, type ConnectorFlags } from './gaps.js';
import { renderReport, reportToMarkdown, runtimeSourceCaveat } from './render.js';

const SEED: Symbol = {
  id: 'sym:services:CheckoutService.processOrder',
  name: 'processOrder',
  filePath: 'src/services/checkout.service.ts',
  startLine: 40,
  endLine: 80,
  score: 1,
};

const ctx: SymbolContext = {
  symbol: SEED,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [SEED]; },
  async context() { return ctx; },
  async impact(): Promise<ImpactResult> { return { target: SEED, affected: 0, byDepth: [] }; },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> { return { added: [], removed: [], modified: [] }; },
  async cypher(): Promise<CypherResult> { return { columns: [], rows: [], rowCount: 0 }; },
};

const fakeDb = {
  select() { return { from(_t: unknown) { return Promise.resolve([]); } }; },
  insert(_t: unknown) {
    return {
      values(_r: unknown) {
        return {
          returning(_c: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_t: unknown) {
    return { set(_v: unknown) { return { where(_c: unknown): Promise<void> { return Promise.resolve(); } }; } };
  },
} as unknown as HorusDb;

/** The flags the CLI passes for a config with ZERO runtime connectors. */
const NO_RUNTIME: ConnectorFlags = {
  elasticsearch: false,
  grafana: false,
  mongodb: false,
  postgres: false,
  sentry: false,
  axiom: false,
  shopify: false,
  redis: false,
  queue: false,
};

describe('hasAnyRuntimeConnector — one definition for gaps AND routing', () => {
  it('is false on the zero-connector config', () => {
    expect(hasAnyRuntimeConnector(NO_RUNTIME)).toBe(false);
    expect(hasAnyRuntimeConnector({})).toBe(false);
  });

  it('counts EVERY runtime source, including axiom / shopify / queue', () => {
    expect(hasAnyRuntimeConnector({ axiom: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ shopify: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ queue: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ elasticsearch: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ grafana: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ sentry: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ mongodb: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ postgres: true })).toBe(true);
    expect(hasAnyRuntimeConnector({ redis: true })).toBe(true);
  });
});

describe('zero-runtime config — the report never contradicts itself', () => {
  const run = () =>
    investigate(
      // A perf-flavored incident hint — the worst case: it used to trigger BOTH
      // `connect elasticsearch` (no-connectors rule) and `connect grafana` (metricsNull).
      { hint: 'checkout latency spike' },
      { code: fakeCode, db: fakeDb, connectors: NO_RUNTIME },
    );

  it('nextSteps contain NO connector setup at all', async () => {
    const report = await run();
    expect(report.nextSteps).toBeDefined();
    expect(report.nextSteps!.every((s) => s.nextTool !== 'connect')).toBe(true);
  });

  it('nextSteps lead with configured source/config follow-ups — and are NEVER empty', async () => {
    const report = await run();
    const tools = (report.nextSteps ?? []).map((s) => s.nextTool);
    // Dogfood: zero-runtime runs used to return [] when no gap carried a routeHint —
    // the router's fallback guarantees a walkable follow-up whenever a seed resolved.
    expect(tools.length).toBeGreaterThan(0);
    // Whatever fires first must be an immediately-useful configured follow-up.
    const USEFUL = new Set(['what-changed', 'owner', 'init', 'search', 'explain', 'blast-radius', 'queues', 'logs', 'metrics', 'doctor']);
    for (const t of tools) expect(USEFUL.has(t), `unexpected nextStep tool: ${t}`).toBe(true);
  });

  it('gaps consolidate to one neutral runtime-evidence statement', async () => {
    const report = await run();
    const dims = report.gapAnalysis.gaps.map((g) => g.dimension);
    expect(dims).toContain('runtime evidence');
    for (const d of ['logs', 'metrics', 'queue runtime state', 'traces']) {
      expect(dims).not.toContain(d);
    }
    const runtimeGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'runtime evidence')!;
    expect(runtimeGap.routeHint).toBeUndefined(); // must never be routed as the top remedy
    // A statement, never setup advice — `connect` must not appear anywhere in it.
    expect(runtimeGap.nextSource).toContain('None');
    expect(runtimeGap.nextSource.toLowerCase()).not.toContain('horus connect');
  });

  it('nextActions do not LEAD with connector setup', async () => {
    const report = await run();
    const first = report.nextActions[0] ?? '';
    expect(first.toLowerCase()).not.toContain('connect');
  });

  it('LIVE SHAPE: no "source-only" wording, no connector pitch, anywhere in the report', async () => {
    const report = await run();

    // Structured fields.
    for (const a of report.nextActions) {
      expect(a, `nextAction pitches connect: ${a}`).not.toContain('horus connect');
    }
    for (const g of report.gapAnalysis.gaps) {
      expect(g.why, `gap.why pitches connect: ${g.why}`).not.toContain('horus connect');
      expect(g.nextSource, `gap.nextSource pitches connect: ${g.nextSource}`).not.toContain('horus connect');
    }
    for (const h of report.hypotheses) {
      for (const m of h.missingEvidence) {
        expect(m, `hypothesis missingEvidence pitches connect: ${m}`).not.toContain('horus connect');
      }
    }
    expect(report.sourceStatus).toBeDefined();
    expect(report.sourceStatus!.sources.every((s) => s.status === 'not-configured')).toBe(true);
    expect(runtimeSourceCaveat(report) ?? '').not.toContain('source-only');

    // Rendered surfaces (text + markdown) — what the user actually reads.
    for (const rendered of [renderReport(report), reportToMarkdown(report)]) {
      expect(rendered).not.toMatch(/source-only/i);
      expect(rendered).not.toContain('horus connect');
    }
  });
});

describe('configured-but-unavailable is named as such, not "not configured"', () => {
  it('sentry configured with no provider → logs gap says configured-but-unavailable', async () => {
    const report = await investigate(
      { hint: 'checkout errors spiking' },
      {
        code: fakeCode,
        db: fakeDb,
        // Config says Sentry exists; no provider was constructed (missing token).
        connectors: { ...NO_RUNTIME, sentry: true },
      },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap!.why).toContain('configured but unavailable');
    expect(logsGap!.why).not.toContain('not configured');
    expect(logsGap!.why).not.toMatch(/collection failed/i);
    // The remedy is fixing credentials (doctor), not `connect sentry` again.
    expect(logsGap!.routeHint).toMatchObject({ nextTool: 'doctor' });
    // A configured connector (even unavailable) means the config shows runtime
    // intent — no neutral consolidation, no contradiction.
    expect(report.gapAnalysis.gaps.map((g) => g.dimension)).not.toContain('runtime evidence');

    // sourceStatus + rendered caveat name the same truth and point at doctor.
    const logsEntry = report.sourceStatus!.sources.find((s) => s.source === 'logs')!;
    expect(logsEntry.status).toBe('unavailable');
    const caveat = runtimeSourceCaveat(report)!;
    expect(caveat).toContain('configured but unavailable');
    expect(caveat).toContain('horus doctor');
  });
});
