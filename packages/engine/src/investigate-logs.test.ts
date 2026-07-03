/**
 * HOR-13 — Integration test: investigate() with real runtime log evidence.
 *
 * Exercises the logs branch of the engine end-to-end using fake providers
 * (no network / DB I/O). Also acts as a regression guard to confirm that
 * calling investigate() WITHOUT a logs provider keeps the "logs" gap present.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { LogsProvider, LogRecord, ErrorBucket, LogAnalysis } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate, logWindowFrom } from './engine.js';

// ---------------------------------------------------------------------------
// Fake CodeProvider
// ---------------------------------------------------------------------------

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:ZohoSyncWorker',
  name: 'ZohoSyncWorker',
  filePath: 'src/workers/zoho-sync.worker.ts',
  startLine: 10,
};

const FAKE_CTX: SymbolContext = {
  symbol: FAKE_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

// The raise site of an arbitrary observed event_code — a DIFFERENT symbol than the seed, so
// GAP D (code→raise-site resolution) does not promote codes that aren't raised by the seed.
const OTHER_RAISER: Symbol = {
  id: 'sym:other:someOtherFn',
  name: 'someOtherFn',
  filePath: 'src/other/other.service.ts',
  startLine: 5,
};

const FAKE_IMPACT: ImpactResult = {
  target: FAKE_SYMBOL,
  affected: 0,
  byDepth: [],
};

const FAKE_CHANGE_SET: ChangeSet = {
  added: [],
  removed: [],
  modified: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',

  async health() {
    return { ok: true, detail: 'fake code provider' };
  },
  async searchSymbols(query: string, _limit?: number): Promise<Symbol[]> {
    // Realistic code→raise-site resolution (for GAP D): a BARE event_code resolves to ITS
    // raise site — a DIFFERENT symbol than the seed in these scenarios — while a hint phrase
    // resolves to the seed. A permissive "always the seed" fake would make GAP D over-promote
    // every observed ES code as seed-emitted. Tests that DO want a code promoted supply it in
    // the seed's sourceBody (the literal-scan path), independent of this.
    if (/^[A-Z][A-Z0-9_]{3,}$/.test(query.trim())) return [OTHER_RAISER];
    return [FAKE_SYMBOL];
  },
  async context(_symbolId: string): Promise<SymbolContext> {
    return FAKE_CTX;
  },
  async impact(_symbolId: string, _depth?: number): Promise<ImpactResult> {
    return FAKE_IMPACT;
  },
  async flowsFor(_symbolId: string) {
    return [];
  },
  async detectChanges(_diff: { base: string; compare: string }): Promise<ChangeSet> {
    return FAKE_CHANGE_SET;
  },
  async cypher(_query: string): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

// ---------------------------------------------------------------------------
// Fake HorusDb
//
// persist() inside engine.ts is wrapped in try/catch and returns null on any
// DB failure. So we provide a minimal stub that throws on all operations;
// the engine handles this gracefully and still returns the report.
// recallSimilar and storeIncidentMemory are also try/catch-wrapped.
// listQueueEdges does db.select().from(queueEdges) — we stub that too.
// ---------------------------------------------------------------------------

const fakeDb = {
  // Drizzle fluent-query stubs — each method returns `this` for chaining.
  select() {
    return {
      from(_table: unknown) {
        return Promise.resolve([]);
      },
    };
  },
  insert(_table: unknown) {
    return {
      values(_rows: unknown) {
        return {
          returning(_cols: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_table: unknown) {
    return {
      set(_vals: unknown) {
        return {
          where(_cond: unknown): Promise<void> {
            return Promise.resolve();
          },
        };
      },
    };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// Fake LogsProvider
// ---------------------------------------------------------------------------

const FAKE_LOG_ERROR: LogRecord = {
  timestamp: new Date(Date.now() - 300_000).toISOString(),
  level: 'error',
  levelValue: 50,
  message: 'Zoho API returned 503 Service Unavailable',
  service: 'leadcall-api-prod',
  component: 'ZohoSyncWorker',
  eventCode: 'HTTPFLT001',
  host: 'worker-01',
  index: 'logs-2026.06',
  raw: {},
};

const FAKE_LOG_INFO: LogRecord = {
  timestamp: new Date(Date.now() - 600_000).toISOString(),
  level: 'info',
  levelValue: 30,
  message: 'Processing zoho sync job',
  service: 'leadcall-api-prod',
  component: 'ZohoSyncWorker',
  eventCode: undefined,
  host: 'worker-01',
  index: 'logs-2026.06',
  raw: {},
};

const FAKE_BUCKET: ErrorBucket = { key: 'HTTPFLT001', count: 9 };

// HOR-10: the engine now consumes synthesized error SIGNATURES, not raw lines.
const FAKE_ANALYSIS: LogAnalysis = {
  window: { from: 'x', to: 'y' },
  totalErrors: 14,
  signatures: [
    {
      key: 'HTTPFLT001',
      count: 9,
      firstSeen: '2026-06-13T10:00:00.000Z',
      lastSeen: '2026-06-13T15:00:00.000Z',
      services: ['leadcall-api-prod'],
      isNew: true,
      baselineCount: 0,
      ratio: Infinity,
      sampleMessage: 'Zoho API returned 503 Service Unavailable',
    },
    {
      key: 'DBPOOL02',
      count: 5,
      firstSeen: '2026-06-13T09:00:00.000Z',
      lastSeen: '2026-06-13T14:00:00.000Z',
      services: ['leadcall-api-prod'],
      isNew: false,
      baselineCount: 2,
      ratio: 2.5,
    },
  ],
  newSignatures: ['HTTPFLT001'],
  affectedServices: ['leadcall-api-prod'],
};

const fakeLogs: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',

  async health() {
    return { ok: true, detail: 'fake logs provider' };
  },
  async searchLogs(_q) {
    return [FAKE_LOG_ERROR, FAKE_LOG_INFO];
  },
  async aggregateErrors(_q, _field?) {
    return [FAKE_BUCKET];
  },
  async errorDeltas(_baseline, _current, _field?) {
    return [];
  },
  async analyzeErrors(_q, _field?) {
    return FAKE_ANALYSIS;
  },
  async checkCompatibility() {
    return { ok: true, indexCount: 1, issues: [] };
  },
  toEvidence(_records) {
    return [];
  },
  async queryEvidence(_q, _collectedAt?) {
    return [];
  },
  async analyzeDurations() {
    return null;
  },
};

// ---------------------------------------------------------------------------
// Tests: WITH logs provider
// ---------------------------------------------------------------------------

describe('investigate() WITH logs provider (HOR-13)', () => {
  it('includes log evidence in the report', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logEvidence = report.evidence.filter((e) => e.kind === 'log');
    expect(logEvidence.length).toBeGreaterThan(0);
  });

  it('surfaces the error sample message in the evidence title (HOR-330)', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    const withMsg = report.evidence.find(
      (e) => e.kind === 'log' && e.title.includes('Zoho API returned 503 Service Unavailable'),
    );
    expect(withMsg).toBeDefined();
  });

  it('synthesizes a dependency/network cause from a direct ENOTFOUND error message (HOR-328 round-2)', async () => {
    const dnsLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors() {
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 20,
          signatures: [
            {
              key: 'GAIA_FETCH_FAIL',
              count: 20,
              firstSeen: '2026-06-13T10:00:00.000Z',
              lastSeen: '2026-06-13T15:00:00.000Z',
              services: ['gaia-sync'],
              isNew: true,
              baselineCount: 0,
              ratio: Infinity,
              sampleMessage: 'Gaia API fetch failed: getaddrinfo ENOTFOUND monnier.example.com',
            },
          ],
          newSignatures: ['GAIA_FETCH_FAIL'],
          affectedServices: ['gaia-sync'],
        };
      },
    };
    const report = await investigate(
      { hint: 'gaia fetch failing', service: 'gaia-sync' },
      { code: fakeCode, db: fakeDb, logs: dnsLogs },
    );
    expect(report.suspectedCauses.some((c) => /Dependency\/network failure/.test(c.title))).toBe(true);
  });

  it('a NEW error signature yields evidence with relevance 0.95', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const newSigEv = report.evidence.find(
      (e) => e.kind === 'log' && e.relevance === 0.95,
    );
    expect(newSigEv).toBeDefined();
    expect(newSigEv?.title).toContain('HTTPFLT001');
    expect(newSigEv?.title).toContain('NEW');
  });

  it('a spiking (non-new) error signature yields evidence with relevance 0.9', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const spikeEv = report.evidence.find(
      (e) => e.kind === 'log' && e.relevance === 0.9,
    );
    expect(spikeEv).toBeDefined();
    expect(spikeEv?.title).toContain('DBPOOL02');
  });

  it('clears the logs gap (no gap with dimension "logs")', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeUndefined();
  });

  it('all gaps have dimension !== "logs"', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    for (const gap of report.gapAnalysis.gaps) {
      expect(gap.dimension).not.toBe('logs');
    }
  });

  it('includes an observation finding summarizing the error signatures', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const logFinding = report.findings.find((f) =>
      f.title.toLowerCase().includes('error signature'),
    );
    expect(logFinding).toBeDefined();
    expect(logFinding?.kind).toBe('observation');
    // 2 signatures, 1 new, 14 errors
    expect(logFinding?.title).toContain('1 new');
  });

  it('includes an anomaly finding naming the top error signature', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );

    const anomalyFinding = report.findings.find(
      (f) => f.kind === 'anomaly' && f.title.includes('HTTPFLT001'),
    );
    expect(anomalyFinding).toBeDefined();
    expect(anomalyFinding?.title).toContain('NEW');
  });

  it('NEW error signature has isNew=true on the top-level Evidence field', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    const newSigEv = report.evidence.find((e) => e.kind === 'log' && e.relevance === 0.95);
    expect(newSigEv).toBeDefined();
    expect(newSigEv?.isNew).toBe(true);
  });

  it('spiking (non-new) error signature has ratio set on the top-level Evidence field', async () => {
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    // DBPOOL02 is non-new with ratio 2.5
    const spikeEv = report.evidence.find((e) => e.kind === 'log' && e.relevance === 0.9);
    expect(spikeEv).toBeDefined();
    expect(typeof spikeEv?.ratio).toBe('number');
    expect(spikeEv?.ratio).toBeCloseTo(2.5, 1);
  });

  // -------------------------------------------------------------------------
  // Cross-signal event_code JOIN: a code named by the hint that is NOT a top
  // aggregation bucket, but IS returned by the structured eventCode query, must
  // still surface as DIRECT evidence (the "no logs" while ES held 438 HTTPFLT001
  // errors miss).
  // -------------------------------------------------------------------------
  it('joins a hint event_code that is absent from the top aggregation but present in ES', async () => {
    // Top aggregation contains ONLY an unrelated signature — HTTPFLT001 is not a
    // top-N bucket. The structured eventCode query returns it with 438x.
    const joinLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors(q) {
        if (q.eventCode === 'HTTPFLT001') {
          return {
            window: { from: 'x', to: 'y' },
            totalErrors: 438,
            signatures: [
              {
                key: 'HTTPFLT001',
                count: 438,
                firstSeen: '2026-06-13T10:00:00.000Z',
                lastSeen: '2026-06-13T15:00:00.000Z',
                services: ['leadcall-api-prod'],
                isNew: true,
                baselineCount: 0,
                ratio: Infinity,
                sampleMessage: 'HTTP filter rejected request',
              },
            ],
            newSignatures: ['HTTPFLT001'],
            affectedServices: ['leadcall-api-prod'],
          };
        }
        // The unscoped (top-N) aggregation never surfaces HTTPFLT001.
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 5,
          signatures: [
            {
              key: 'DBPOOL02',
              count: 5,
              firstSeen: '2026-06-13T09:00:00.000Z',
              lastSeen: '2026-06-13T14:00:00.000Z',
              services: ['leadcall-api-prod'],
              isNew: false,
              baselineCount: 2,
              ratio: 2.5,
            },
          ],
          newSignatures: [],
          affectedServices: ['leadcall-api-prod'],
        };
      },
    };

    const report = await investigate(
      { hint: 'HTTPFLT001 errors in prod', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: joinLogs },
    );

    const joinEv = report.evidence.find(
      (e) =>
        e.kind === 'log' &&
        e.title.includes('event_code HTTPFLT001') &&
        e.title.includes('438x') &&
        e.title.includes('exact structured match'),
    );
    expect(joinEv).toBeDefined();
    expect(joinEv?.relevance).toBe(0.9);
    // It must be classified DIRECT so it feeds the seed-linked cause path.
    const payload = joinEv?.payload as Record<string, unknown> | undefined;
    expect(payload?.['relevanceClass']).toBe('direct');
    expect(payload?.['crossSignalJoin']).toBe(true);
  });

  it('does not re-join an event_code already present as a top signature', async () => {
    // FAKE_ANALYSIS already returns HTTPFLT001 as a top bucket; the hint names it.
    // The join must dedupe — exactly one HTTPFLT001 log evidence, not two.
    const report = await investigate(
      { hint: 'HTTPFLT001 zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    const httpfltEv = report.evidence.filter(
      (e) => e.kind === 'log' && e.title.includes('HTTPFLT001'),
    );
    // Only the original top-signature evidence — no duplicate cross-signal entry.
    expect(httpfltEv.length).toBe(1);
    expect(httpfltEv[0]?.title).not.toContain('exact structured match');
  });

  it('a logs failure inside the event_code join never breaks the investigation', async () => {
    const throwingJoinLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors(q) {
        if (q.eventCode !== undefined) throw new Error('es timeout on scoped query');
        return FAKE_ANALYSIS;
      },
    };
    const report = await investigate(
      { hint: 'BADCODE99 outage', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: throwingJoinLogs },
    );
    // The unscoped analysis still produced evidence; the scoped failure was swallowed.
    expect(report.evidence.filter((e) => e.kind === 'log').length).toBeGreaterThan(0);
    expect(report.evidence.some((e) => e.title.includes('exact structured match'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // HOR-341: a runtime error EMITTED FROM THE SEED FUNCTION (its literal is in the
  // seed's source body) that also has live ES occurrences is the strongest possible
  // link — it must form a dedicated headline cause, not be demoted to a "lead to verify".
  // -------------------------------------------------------------------------

  // A code provider whose seed context returns a SNIPPET that raises a code literal —
  // i.e. the seed function itself emits `E_FULFILLMENT_SYNC_ERROR_04`.
  const seedEmittingCode: CodeProvider = {
    ...fakeCode,
    async context(_symbolId: string): Promise<SymbolContext> {
      return {
        ...FAKE_CTX,
        snippet:
          'async checkBrandOrderFulfillment(order) {\n' +
          '  if (!synced) {\n' +
          "    throw new FulfillmentError('E_FULFILLMENT_SYNC_ERROR_04', order.id);\n" +
          '  }\n}',
      };
    },
  };

  // Logs where the seed-emitted code is NOT a top bucket but the structured eventCode
  // query returns it with thousands of live occurrences.
  const seedEmittedLogs: LogsProvider = {
    ...fakeLogs,
    async analyzeErrors(q) {
      if (q.eventCode === 'E_FULFILLMENT_SYNC_ERROR_04') {
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 2153,
          signatures: [
            {
              key: 'E_FULFILLMENT_SYNC_ERROR_04',
              count: 2153,
              firstSeen: '2026-06-13T10:00:00.000Z',
              lastSeen: '2026-06-13T15:00:00.000Z',
              services: ['maison-safqa-prod'],
              isNew: false,
              baselineCount: 1800,
              ratio: 1.2,
              sampleMessage: 'Error checking brand order fulfillment',
            },
          ],
          newSignatures: [],
          affectedServices: ['maison-safqa-prod'],
        };
      }
      // The unscoped top-N aggregation surfaces only an unrelated signature.
      return {
        window: { from: 'x', to: 'y' },
        totalErrors: 5,
        signatures: [
          {
            key: 'DBPOOL02',
            count: 5,
            firstSeen: '2026-06-13T09:00:00.000Z',
            lastSeen: '2026-06-13T14:00:00.000Z',
            services: ['maison-safqa-prod'],
            isNew: false,
            baselineCount: 2,
            ratio: 2.5,
          },
        ],
        newSignatures: [],
        affectedServices: ['maison-safqa-prod'],
      };
    },
  };

  it('forms a cause:seed-emitted-error headline when the seed snippet raises a code with ES occurrences', async () => {
    const report = await investigate(
      { hint: 'fulfillment failing for brand orders', service: 'maison-safqa-prod' },
      { code: seedEmittingCode, db: fakeDb, logs: seedEmittedLogs },
    );
    const seedCause = report.suspectedCauses.find((c) => c.id === 'cause:seed-emitted-error');
    expect(seedCause).toBeDefined();
    expect(seedCause?.title).toContain('E_FULFILLMENT_SYNC_ERROR_04');
    expect(seedCause?.title).toContain('2153x');
    expect(seedCause?.title).toContain('is raised by');
    // It must HEADLINE — and as a structurally LINKED diagnosis, not a co-occurring lead.
    expect(report.suspectedCauses[0]?.id).toBe('cause:seed-emitted-error');
    expect(report.summary).not.toContain('No cause is structurally linked');
    expect(report.summary).toContain('Top suspected cause');
  });

  it('promotes a seed-emitted code even when it is ALSO a top error signature (un-buries the dedup)', async () => {
    // The seed raises E_FULFILLMENT_SYNC_ERROR_04 AND it is the dominant top signature.
    const topAndSeedEmittedLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors() {
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 2153,
          signatures: [
            {
              key: 'E_FULFILLMENT_SYNC_ERROR_04',
              count: 2153,
              firstSeen: '2026-06-13T10:00:00.000Z',
              lastSeen: '2026-06-13T15:00:00.000Z',
              services: ['maison-safqa-prod'],
              isNew: false,
              baselineCount: 1800,
              ratio: 1.2,
              sampleMessage: 'Error checking brand order fulfillment',
            },
          ],
          newSignatures: [],
          affectedServices: ['maison-safqa-prod'],
        };
      },
    };
    const report = await investigate(
      { hint: 'fulfillment failing for brand orders', service: 'maison-safqa-prod' },
      { code: seedEmittingCode, db: fakeDb, logs: topAndSeedEmittedLogs },
    );
    const seedCause = report.suspectedCauses.find((c) => c.id === 'cause:seed-emitted-error');
    expect(seedCause).toBeDefined();
    expect(report.suspectedCauses[0]?.id).toBe('cause:seed-emitted-error');
    expect(report.summary).not.toContain('No cause is structurally linked');
  });

  it('does NOT promote a HINT-ONLY code (not in the seed snippet) to a cause', async () => {
    // The hint names HTTPFLT001 and the join surfaces it as DIRECT evidence, but the
    // seed (fakeCode — no snippet that raises it) does NOT emit it, so it must stay a
    // direct-evidence "lead", NOT a promoted seed-emitted cause.
    const hintCodeLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors(q) {
        if (q.eventCode === 'HTTPFLT001') {
          return {
            window: { from: 'x', to: 'y' },
            totalErrors: 438,
            signatures: [
              {
                key: 'HTTPFLT001',
                count: 438,
                firstSeen: '2026-06-13T10:00:00.000Z',
                lastSeen: '2026-06-13T15:00:00.000Z',
                services: ['leadcall-api-prod'],
                isNew: true,
                baselineCount: 0,
                ratio: Infinity,
                sampleMessage: 'HTTP filter rejected request',
              },
            ],
            newSignatures: ['HTTPFLT001'],
            affectedServices: ['leadcall-api-prod'],
          };
        }
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 5,
          signatures: [
            {
              key: 'DBPOOL02',
              count: 5,
              firstSeen: '2026-06-13T09:00:00.000Z',
              lastSeen: '2026-06-13T14:00:00.000Z',
              services: ['leadcall-api-prod'],
              isNew: false,
              baselineCount: 2,
              ratio: 2.5,
            },
          ],
          newSignatures: [],
          affectedServices: ['leadcall-api-prod'],
        };
      },
    };
    const report = await investigate(
      { hint: 'HTTPFLT001 outage in prod', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: hintCodeLogs },
    );
    // The join still surfaced HTTPFLT001 as direct evidence …
    expect(
      report.evidence.some((e) => e.title.includes('event_code HTTPFLT001')),
    ).toBe(true);
    // … but NO seed-emitted cause is formed (the seed does not raise it).
    expect(report.suspectedCauses.some((c) => c.id === 'cause:seed-emitted-error')).toBe(false);
  });

  it('gap D: promotes a code whose RAISE SITE is the seed even when its literal is not in the body', async () => {
    // The seed has no sourceBody literal for ERR4624 (it is referenced by a constant KEY
    // that differs from the logged code, or raised in a callee), but the backend resolves
    // the code's raise site to the seed → GAP D treats it as seed-emitted and headlines it.
    const codeRaisedBySeed: CodeProvider = {
      ...fakeCode,
      async searchSymbols(q: string): Promise<Symbol[]> {
        if (q.trim() === 'ERR4624') return [FAKE_SYMBOL]; // raise site IS the seed
        if (/^[A-Z][A-Z0-9_]{3,}$/.test(q.trim())) return [OTHER_RAISER]; // raised elsewhere
        return [FAKE_SYMBOL]; // hint phrase → seed
      },
    };
    const errLogs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors() {
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 19,
          signatures: [
            {
              key: 'ERR4624',
              count: 19,
              firstSeen: '2026-06-24T10:00:00.000Z',
              lastSeen: '2026-06-24T16:22:00.000Z',
              services: ['maison-safqa-prod'],
              isNew: true,
              level: 'error',
              sampleMessage: 'Error updating existing synced product in database during syncProduct',
            },
            // A second code raised ELSEWHERE must NOT be promoted as seed-emitted.
            {
              key: 'DBPOOL02',
              count: 50,
              firstSeen: '2026-06-24T10:00:00.000Z',
              lastSeen: '2026-06-24T16:22:00.000Z',
              services: ['maison-safqa-prod'],
              isNew: false,
              level: 'error',
              sampleMessage: 'pool exhausted',
            },
          ],
          newSignatures: ['ERR4624'],
          affectedServices: ['maison-safqa-prod'],
        };
      },
    };
    const report = await investigate(
      { hint: 'syncing a product fails', service: 'maison-safqa-prod' },
      { code: codeRaisedBySeed, db: fakeDb, logs: errLogs },
    );
    const seedCause = report.suspectedCauses.find((c) => c.id === 'cause:seed-emitted-error');
    expect(seedCause).toBeDefined();
    // Headlines the seed-raised ERROR (not the louder DBPOOL02 raised elsewhere), labelled
    // honestly as a runtime error (GAP A severity).
    expect(seedCause?.title).toMatch(/ERR4624/);
    expect(seedCause?.title).not.toMatch(/DBPOOL02/);
    expect(seedCause?.title.toLowerCase()).toMatch(/runtime error|likely failure/);
  });

  it('gap F: prefers the SEED-raised error over a generic error from a shared CALLEE', async () => {
    // The seed raises its own SALE_LOCAL_02 (5x); a shared transport callee raises the louder
    // generic GENERIC_500 (50x). The headline must be the seed-local error, NOT the callee's
    // generic one — and the callee error must be attributed to the callee, not the seed.
    const CALLEE: Symbol = {
      id: 'sym:lib:httpClient',
      name: 'httpClient',
      filePath: 'src/lib/http-client.ts',
      startLine: 5,
    };
    const code: CodeProvider = {
      ...fakeCode,
      async context(): Promise<SymbolContext> {
        return { ...(await fakeCode.context('x')), callees: [CALLEE] };
      },
      async searchSymbols(q: string): Promise<Symbol[]> {
        if (q.trim() === 'SALE_LOCAL_02') return [FAKE_SYMBOL]; // raised by the seed itself
        if (q.trim() === 'GENERIC_500') return [CALLEE]; // raised by the shared callee
        if (/^[A-Z][A-Z0-9_]{3,}$/.test(q.trim())) return [OTHER_RAISER];
        return [FAKE_SYMBOL];
      },
    };
    const logs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors() {
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 55,
          signatures: [
            {
              key: 'GENERIC_500',
              count: 50,
              firstSeen: 'x',
              lastSeen: 'y',
              services: ['s'],
              isNew: false,
              level: 'error',
              sampleMessage: 'Store client error',
            },
            {
              key: 'SALE_LOCAL_02',
              count: 5,
              firstSeen: 'x',
              lastSeen: 'y',
              services: ['s'],
              isNew: true,
              level: 'error',
              sampleMessage: 'Error drafting sale products',
            },
          ],
          newSignatures: ['SALE_LOCAL_02'],
          affectedServices: ['s'],
        };
      },
    };
    const report = await investigate(
      { hint: 'drafting sale products keeps erroring', service: 's' },
      { code, db: fakeDb, logs },
    );
    const seedCause = report.suspectedCauses.find((c) => c.id === 'cause:seed-emitted-error');
    expect(seedCause).toBeDefined();
    expect(seedCause?.title).toMatch(/SALE_LOCAL_02/);
    expect(seedCause?.title).toMatch(/is raised by .* — the likely failure/);
    expect(seedCause?.title).not.toMatch(/GENERIC_500/);
  });

  it('gap I: a HINT-NAMED code wins the tie among equally seed-raised errors', async () => {
    // Both EMODA_017D and EMODA_015_02_02 are raised by the seed at the same count/severity;
    // the hint NAMES EMODA_017D, so it must headline (the user asked about that code).
    const code: CodeProvider = {
      ...fakeCode,
      async searchSymbols(q: string): Promise<Symbol[]> {
        if (q.trim() === 'EMODA_017D' || q.trim() === 'EMODA_015_02_02') return [FAKE_SYMBOL];
        if (/^[A-Z][A-Z0-9_]{3,}$/.test(q.trim())) return [OTHER_RAISER];
        return [FAKE_SYMBOL];
      },
    };
    const logs: LogsProvider = {
      ...fakeLogs,
      async analyzeErrors() {
        const base = {
          firstSeen: 'x',
          lastSeen: 'y',
          services: ['s'],
          isNew: false,
          level: 'error' as const,
        };
        return {
          window: { from: 'x', to: 'y' },
          totalErrors: 4,
          signatures: [
            { key: 'EMODA_015_02_02', count: 2, ...base, sampleMessage: 'Reserving products' },
            { key: 'EMODA_017D', count: 2, ...base, sampleMessage: 'Reserve products API error' },
          ],
          newSignatures: [],
          affectedServices: ['s'],
        };
      },
    };
    const report = await investigate(
      { hint: 'EMODA_017D errors reserving products', service: 's' },
      { code, db: fakeDb, logs },
    );
    const seedCause = report.suspectedCauses.find((c) => c.id === 'cause:seed-emitted-error');
    expect(seedCause?.title).toMatch(/EMODA_017D/);
    expect(seedCause?.title).not.toMatch(/EMODA_015_02_02/);
  });

  it('keeps the #1/#2 co-occurring reframing when there is no seed-emitted linked cause', async () => {
    // A loud, seed-UNLINKED data-state anomaly: no seed-emitted code, so the honest
    // "no cause is structurally linked / lead to verify" reframing must still apply.
    const report = await investigate(
      { hint: 'fulfillment failing for brand orders', service: 'maison-safqa-prod' },
      { code: fakeCode, db: fakeDb, logs: seedEmittedLogs },
    );
    // fakeCode's seed has no snippet → no seed-emitted cause is formed.
    expect(report.suspectedCauses.some((c) => c.id === 'cause:seed-emitted-error')).toBe(false);
  });

  it('confidence ceiling is not reduced by the logs gap (since logs are present)', async () => {
    // Run without logs to get the baseline ceiling reduction caused by the logs gap.
    const reportNoLogs = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );
    const ceilingNoLogs = reportNoLogs.gapAnalysis.confidenceCeiling;

    // With logs, the ceiling should be higher (logs gap impact = 0.1 removed).
    const reportWithLogs = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: fakeLogs },
    );
    const ceilingWithLogs = reportWithLogs.gapAnalysis.confidenceCeiling;

    expect(ceilingWithLogs).toBeGreaterThan(ceilingNoLogs);
  });
});

// ---------------------------------------------------------------------------
// Tests: WITHOUT logs provider (regression guard)
// ---------------------------------------------------------------------------

describe('investigate() WITHOUT logs provider (regression guard)', () => {
  it('returns a valid report with no log evidence', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    const logEvidence = report.evidence.filter((e) => e.kind === 'log');
    expect(logEvidence).toHaveLength(0);
  });

  it('the "logs" gap is present when no logs provider is supplied', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });

  it('report.confidence is defined and between 0 and 1', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });

  it('report has seeds resolved from the fake code provider', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );

    expect(report.seeds.length).toBeGreaterThan(0);
    const firstSeed = report.seeds[0];
    expect(firstSeed).toBeDefined();
    expect(firstSeed?.name).toBe('ZohoSyncWorker');
  });

  it('passes logs: null explicitly (treated same as omitted)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: null },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: incompatible mapping → gap with compatibility error text
// ---------------------------------------------------------------------------

describe('investigate() with INCOMPATIBLE compat report (HOR-47)', () => {
  const incompatLogs: LogsProvider = {
    ...fakeLogs,
    async checkCompatibility() {
      return {
        ok: false,
        indexCount: 0,
        issues: [
          {
            severity: 'error' as const,
            field: 'time',
            message: "Timestamp field 'time' not found. Available date fields: @timestamp.",
          },
        ],
      };
    },
  };

  it('produces no log evidence when compat has errors', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: incompatLogs },
    );

    const logEv = report.evidence.filter((e) => e.kind === 'log');
    expect(logEv).toHaveLength(0);
  });

  it('logs gap is present with mapping-incompatibility reason', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: incompatLogs },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap?.why).toContain('incompatible');
    expect(logsGap?.why).toContain("'time'");
  });

  it('confidence ceiling is reduced by the logs gap', async () => {
    const reportIncompat = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: incompatLogs },
    );
    const reportNoLogs = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb },
    );
    expect(reportIncompat.gapAnalysis.confidenceCeiling).toBe(
      reportNoLogs.gapAnalysis.confidenceCeiling,
    );
  });
});

describe('investigate() with MISSING event-code aggregation field (HOR-47)', () => {
  // Simulates an index where errors exist but event_code.keyword is absent:
  // the compat check must block analyzeErrors before it can return empty buckets.
  const missingEcLogs: LogsProvider = {
    ...fakeLogs,
    async checkCompatibility() {
      return {
        ok: false,
        indexCount: 3,
        issues: [
          {
            severity: 'error' as const,
            field: 'event_code.keyword',
            message:
              "eventCodeKeyword is true but 'event_code.keyword' not found — signature aggregation blocked.",
          },
        ],
      };
    },
  };

  it('produces no log evidence when event-code is non-aggregatable', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: missingEcLogs },
    );
    expect(report.evidence.filter((e) => e.kind === 'log')).toHaveLength(0);
  });

  it('logs gap carries mapping-incompatibility reason (not "no matching logs")', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: missingEcLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap?.why).toContain('incompatible');
    expect(logsGap?.why).not.toContain('No error logs matched');
  });
});

describe('investigate() with THROWING checkCompatibility', () => {
  const throwingLogs: LogsProvider = {
    ...fakeLogs,
    async checkCompatibility() {
      throw new Error('network timeout');
    },
  };

  it('produces no log evidence and does not throw', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: throwingLogs },
    );

    const logEv = report.evidence.filter((e) => e.kind === 'log');
    expect(logEv).toHaveLength(0);
  });

  it('logs gap is present (collection failed) without compatibility error text', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: throwingLogs },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap?.why).toContain('failed');
    expect(logsGap?.why).not.toContain('incompatible');
  });

  it('logs gap carries the classified failure reason, not the raw error text', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: throwingLogs },
    );

    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    // 'network timeout' classifies to the leak-safe 'timeout' category.
    expect(logsGap?.why).toContain('(timeout)');
    expect(logsGap?.why).not.toContain('network timeout');
  });
});

// ---------------------------------------------------------------------------
// Tests: non-aggregatable service field → engine blocks analysis (HOR-47)
// ---------------------------------------------------------------------------

describe('investigate() with NON-AGGREGATABLE service keyword field (HOR-47)', () => {
  // Simulates service_name.keyword having aggregatable:false — analyzeErrors()
  // runs two service terms aggregations so Elasticsearch may reject the query.
  // The compat check with requiresServiceAggregation:true must block collection.
  const nonAggSvcLogs: LogsProvider = {
    ...fakeLogs,
    async checkCompatibility() {
      return {
        ok: false,
        indexCount: 2,
        issues: [
          {
            severity: 'error' as const,
            field: 'service_name.keyword',
            message:
              "Service field 'service_name.keyword' is not aggregatable — analyzeErrors() runs service terms aggregations that Elasticsearch may reject — collection blocked.",
          },
        ],
      };
    },
  };

  it('produces no log evidence when service agg field is non-aggregatable', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: nonAggSvcLogs },
    );
    expect(report.evidence.filter((e) => e.kind === 'log')).toHaveLength(0);
  });

  it('logs gap carries mapping-incompatibility reason (not generic failure)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: nonAggSvcLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap?.why).toContain('incompatible');
    expect(logsGap?.why).toContain('service_name.keyword');
    expect(logsGap?.why).not.toContain('No error logs matched');
  });
});

// ---------------------------------------------------------------------------
// Tests: logWindowFrom helper
// ---------------------------------------------------------------------------

describe('logWindowFrom', () => {
  it('parses "24h" into a timestamp ~24h ago', () => {
    const before = Date.now();
    const result = logWindowFrom('24h');
    const after = Date.now();
    const ts = new Date(result).getTime();
    const expected24h = 24 * 3_600_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected24h - 100);
    expect(ts).toBeLessThanOrEqual(after - expected24h + 100);
  });

  it('parses "7d" into a timestamp ~7 days ago', () => {
    const before = Date.now();
    const result = logWindowFrom('7d');
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('parses "30m" into a timestamp ~30 min ago', () => {
    const before = Date.now();
    const result = logWindowFrom('30m');
    const ts = new Date(result).getTime();
    const expected30m = 30 * 60_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected30m - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected30m + 100);
  });

  it('parses "90s" into a timestamp ~90 sec ago', () => {
    const before = Date.now();
    const result = logWindowFrom('90s');
    const ts = new Date(result).getTime();
    const expected90s = 90 * 1_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected90s - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected90s + 100);
  });

  it('defaults to ~7 days ago for undefined', () => {
    const before = Date.now();
    const result = logWindowFrom(undefined);
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('defaults to ~7 days ago for a git ref like "HEAD~5"', () => {
    const before = Date.now();
    const result = logWindowFrom('HEAD~5');
    const ts = new Date(result).getTime();
    const expected7d = 7 * 86_400_000;
    expect(ts).toBeGreaterThanOrEqual(before - expected7d - 100);
    expect(ts).toBeLessThanOrEqual(Date.now() - expected7d + 100);
  });

  it('returns an ISO-8601 string', () => {
    const result = logWindowFrom('1h');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// HOR-435 (lever #2): INFO-level duration-by-dimension evidence wiring
// ---------------------------------------------------------------------------

describe('investigate() duration-by-dimension evidence (HOR-435 lever #2)', () => {
  // A logs provider whose analyzeDurations returns a per-segment breakdown: one region runs
  // 2m10s while another runs 19ms — the ground truth a uniform-regression read would miss.
  const durationLogs: LogsProvider = {
    ...fakeLogs,
    async analyzeErrors() {
      // No error signatures — the duration anomaly lives entirely in INFO completion lines.
      return {
        window: { from: 'x', to: 'y' },
        totalErrors: 0,
        signatures: [],
        newSignatures: [],
        affectedServices: [],
      };
    },
    async analyzeDurations() {
      return {
        dimension: 'region',
        unit: 'ms' as const,
        byValue: {
          KSA: { avg: 130_000, p95: 150_000, count: 12, min: 90_000, max: 160_000 },
          UAE: { avg: 19, p95: 30, count: 40, min: 5, max: 60 },
        },
        sampleCount: 52,
      };
    },
  };

  it('builds a "Duration by region: …" evidence row for a performance hint', async () => {
    const report = await investigate(
      { hint: 'sync job duration anomaly — everything is slow', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: durationLogs },
    );
    const durEv = report.evidence.find(
      (e) =>
        e.kind === 'log' &&
        typeof e.payload === 'object' &&
        e.payload !== null &&
        (e.payload as { kind?: string }).kind === 'duration-by-dimension',
    );
    expect(durEv).toBeDefined();
    expect(durEv!.title).toMatch(/Duration by region:/);
    // Slowest-first: KSA (2m10s) leads UAE (19ms).
    expect(durEv!.title).toMatch(/KSA 2m10s/);
    expect(durEv!.title).toMatch(/UAE 19ms/);
    // Per-dimension stats are preserved in the payload.
    const byValue = (durEv!.payload as { byValue: Record<string, { avg: number }> }).byValue;
    expect(byValue.KSA!.avg).toBe(130_000);
    expect(byValue.UAE!.avg).toBe(19);
  });

  it('the duration-by-dimension evidence SUPPORTS the benign-variance hypothesis', async () => {
    const report = await investigate(
      { hint: 'sync job latency spike', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: durationLogs },
    );
    const bv = report.hypotheses.find((h) => h.category === 'benign-variance');
    expect(bv).toBeDefined();
    // It earned support from real per-dimension evidence — verdict supported, but not certain.
    expect(bv!.verdict).toBe('supported');
    expect(bv!.supportingPresent).toBeGreaterThan(0);
    expect(bv!.confidence).toBeLessThan(1);
  });

  it('does NOT query durations (no duration evidence) for a non-performance hint', async () => {
    const report = await investigate(
      { hint: 'who owns the user model', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, logs: durationLogs },
    );
    const durEv = report.evidence.find(
      (e) =>
        e.kind === 'log' &&
        typeof e.payload === 'object' &&
        e.payload !== null &&
        (e.payload as { kind?: string }).kind === 'duration-by-dimension',
    );
    expect(durEv).toBeUndefined();
  });
});
