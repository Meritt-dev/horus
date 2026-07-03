/**
 * HOR-429 — Integration test: investigate() with Axiom structured-log evidence.
 *
 * Exercises the Axiom branch of the engine end-to-end using a fake AxiomProvider
 * (no network / DB I/O). Mirrors the Sentry/Elasticsearch log-evidence path:
 * each Axiom row folds into one `kind: 'log'` Evidence, relevance-classified
 * against the seed (direct vs ambient), and a failing provider must never abort.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider, AxiomProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';

// ---------------------------------------------------------------------------
// Fake CodeProvider (seed: ZohoSyncWorker → seed terms include "zoho"/"sync")
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

const FAKE_IMPACT: ImpactResult = { target: FAKE_SYMBOL, affected: 0, byDepth: [] };
const FAKE_CHANGE_SET: ChangeSet = { added: [], removed: [], modified: [] };

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() {
    return { ok: true, detail: 'fake code provider' };
  },
  async searchSymbols(): Promise<Symbol[]> {
    return [FAKE_SYMBOL];
  },
  async context(): Promise<SymbolContext> {
    return FAKE_CTX;
  },
  async impact(): Promise<ImpactResult> {
    return FAKE_IMPACT;
  },
  async flowsFor() {
    return [];
  },
  async detectChanges(): Promise<ChangeSet> {
    return FAKE_CHANGE_SET;
  },
  async cypher(): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

// Minimal DB stub — persist()/recall are try/catch-wrapped in the engine.
const fakeDb = {
  select() {
    return {
      from() {
        return Promise.resolve([]);
      },
    };
  },
  insert() {
    return {
      values() {
        return {
          returning(): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update() {
    return {
      set() {
        return {
          where(): Promise<void> {
            return Promise.resolve();
          },
        };
      },
    };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// Fake AxiomProvider — the engine only calls collect({ from, to, hintTerms }).
// ---------------------------------------------------------------------------

function fakeAxiom(rows: Array<{ fields: Record<string, unknown>; timestamp?: string }>): AxiomProvider {
  return {
    async collect() {
      return rows;
    },
  } as unknown as AxiomProvider;
}

const recentTs = new Date(Date.now() - 300_000).toISOString();

describe('investigate() WITH Axiom logs provider (HOR-429)', () => {
  it('folds an Axiom row into kind:log evidence tagged source=axiom', async () => {
    const axiom = fakeAxiom([
      {
        timestamp: recentTs,
        fields: { message: 'Zoho token refresh failed', level: 'error', service: 'leadcall-api-prod' },
      },
    ]);
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, axiom },
    );

    const axiomEv = report.evidence.find(
      (e) => e.kind === 'log' && (e.payload as Record<string, unknown>)?.['source'] === 'axiom',
    );
    expect(axiomEv).toBeDefined();
    expect(axiomEv?.title).toContain('Zoho token refresh failed');
  });

  it('classifies a hint-matching error row as DIRECT', async () => {
    const axiom = fakeAxiom([
      { timestamp: recentTs, fields: { message: 'Zoho sync worker crashed', level: 'error' } },
    ]);
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, axiom },
    );
    const ev = report.evidence.find(
      (e) => e.kind === 'log' && (e.payload as Record<string, unknown>)?.['source'] === 'axiom',
    );
    expect((ev?.payload as Record<string, unknown>)?.['relevanceClass']).toBe('direct');
  });

  it('classifies an unrelated row as AMBIENT and demotes its relevance', async () => {
    const axiom = fakeAxiom([
      { timestamp: recentTs, fields: { message: 'cron heartbeat ok', level: 'info', service: 'billing-cron' } },
    ]);
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, axiom },
    );
    const ev = report.evidence.find(
      (e) =>
        e.kind === 'log' &&
        (e.payload as Record<string, unknown>)?.['source'] === 'axiom' &&
        (e.payload as Record<string, unknown>)?.['relevanceClass'] === 'ambient',
    );
    expect(ev).toBeDefined();
    expect(ev?.relevance).toBeLessThan(0.5);
    expect(ev?.title).toContain('[ambient]');
  });

  it('an Axiom failure never breaks the investigation', async () => {
    const throwingAxiom = {
      async collect() {
        throw new Error('axiom timeout');
      },
    } as unknown as AxiomProvider;
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      { code: fakeCode, db: fakeDb, axiom: throwingAxiom },
    );
    expect(report).toBeDefined();
    expect(
      report.evidence.some(
        (e) => e.kind === 'log' && (e.payload as Record<string, unknown>)?.['source'] === 'axiom',
      ),
    ).toBe(false);
    // With no ES configured, the logs gap is purely about Axiom and carries the
    // classified (leak-safe) failure reason.
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap?.why).toContain('Axiom log collection failed');
    expect(logsGap?.why).toContain('(timeout)');
  });

  it('a configured Axiom that returns rows clears the logs gap', async () => {
    const axiom = fakeAxiom([
      { timestamp: recentTs, fields: { message: 'Zoho sync failed', level: 'error' } },
    ]);
    const report = await investigate(
      { hint: 'zoho', service: 'leadcall-api-prod' },
      {
        code: fakeCode,
        db: fakeDb,
        axiom,
        connectors: { axiom: true, axiomCollected: true },
      },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeUndefined();
  });
});

describe('investigate() WITHOUT Axiom provider (regression guard)', () => {
  it('produces no axiom-sourced evidence', async () => {
    const report = await investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb });
    expect(
      report.evidence.some(
        (e) => e.kind === 'log' && (e.payload as Record<string, unknown>)?.['source'] === 'axiom',
      ),
    ).toBe(false);
  });
});
