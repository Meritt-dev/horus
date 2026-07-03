/**
 * HOR-319 layer-2 — runtime-only degrade.
 *
 * When the source-intelligence host is unreachable and can't be self-healed, the CLI
 * passes `code: null`. The engine must then run a RUNTIME-ONLY investigation: no seed,
 * no structural evidence, capped confidence, an explicit `degraded` flag — but it must
 * still gather and reason over runtime evidence (logs/metrics/state/queues).
 *
 * All deterministic, service-free (mocked providers, no live sockets).
 */
import { describe, it, expect } from 'vitest';
import type { LogsProvider, LogRecord, LogAnalysis } from '@horus/connectors';
import type { HorusDb, QueueEdge } from '@horus/db';
import { investigate } from './engine.js';

function makeDb(edges: QueueEdge[] = []): HorusDb {
  return {
    select() {
      return { from(_t: unknown) { return Promise.resolve(edges); } };
    },
    insert(_t: unknown) {
      return {
        values(_rows: unknown) {
          return { returning(_c: unknown): Promise<{ id: string }[]> { return Promise.resolve([{ id: 'rt-id' }]); } };
        },
      };
    },
    update(_t: unknown) {
      return { set(_v: unknown) { return { where(_w: unknown): Promise<void> { return Promise.resolve(); } }; } };
    },
  } as unknown as HorusDb;
}

const logsWithErrors: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',
  async health() { return { ok: true, detail: 'ok' }; },
  async searchLogs() { return [] as LogRecord[]; },
  async aggregateErrors() { return []; },
  async errorDeltas() { return []; },
  async analyzeErrors(): Promise<LogAnalysis> {
    return {
      window: { from: 'x', to: 'y' },
      totalErrors: 120,
      signatures: [
        { key: 'SCHEDULER_TIMEOUT', count: 90, firstSeen: '2026-06-20T15:00:00Z', lastSeen: '2026-06-20T16:00:00Z', services: ['acme-prod-scheduler'], isNew: true, ratio: 4 },
      ],
      newSignatures: ['SCHEDULER_TIMEOUT'],
      affectedServices: ['acme-prod-scheduler'],
    };
  },
  async checkCompatibility() { return { ok: true, indexCount: 1, issues: [] }; },
  toEvidence() { return []; },
  async queryEvidence() { return []; },
  async analyzeDurations() { return null; },
};

describe('HOR-319 layer-2 — runtime-only degrade (code: null)', () => {
  const input = { hint: 'MANAGE_SALES scheduler 3x runtime', service: 'acme-prod-scheduler' };

  it('does not throw and returns a valid report with no source intelligence', async () => {
    await expect(
      investigate(input, { code: null, db: makeDb(), logs: logsWithErrors }),
    ).resolves.toBeDefined();
  });

  it('flags the report as degraded (sourceIntelligence: false)', async () => {
    const report = await investigate(input, { code: null, db: makeDb(), logs: logsWithErrors });
    expect(report.degraded).toEqual({ sourceIntelligence: false, reason: expect.any(String) });
  });

  it('resolves no seed and emits no structural evidence', async () => {
    const report = await investigate(input, { code: null, db: makeDb(), logs: logsWithErrors });
    expect(report.seeds).toHaveLength(0);
    const structural = report.evidence.filter((e) => ['symbol', 'impact', 'flow', 'queue-edge'].includes(e.kind));
    expect(structural).toHaveLength(0);
  });

  it('still gathers runtime log evidence', async () => {
    const report = await investigate(input, { code: null, db: makeDb(), logs: logsWithErrors });
    const logEv = report.evidence.filter((e) => e.kind === 'log');
    expect(logEv.length).toBeGreaterThan(0);
  });

  it('caps confidence at ≤0.5 (no seed resolved)', async () => {
    const report = await investigate(input, { code: null, db: makeDb(), logs: logsWithErrors });
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(0.5);
  });

  it('banners the degrade in the summary and next actions', async () => {
    const report = await investigate(input, { code: null, db: makeDb(), logs: logsWithErrors });
    expect(report.summary).toContain('Runtime-only');
    expect(report.nextActions.some((a) => a.includes('horus init'))).toBe(true);
  });

  it('does not throw even with no runtime providers at all', async () => {
    const report = await investigate(input, { code: null, db: makeDb() });
    expect(report).toBeDefined();
    expect(report.degraded?.sourceIntelligence).toBe(false);
  });
});
