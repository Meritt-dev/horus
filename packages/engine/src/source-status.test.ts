/**
 * HOR-70 — Unit tests for buildRuntimeSourceStatus (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { ConnectorFlags } from './gaps.js';
import { buildRuntimeSourceStatus } from './source-status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(
  source: Evidence['source'],
  kind: Evidence['kind'],
): Evidence {
  return {
    id: globalThis.crypto.randomUUID(),
    source,
    kind,
    title: `Test evidence (${source}/${kind})`,
    relevance: 0.5,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

const NO_CONNECTORS: ConnectorFlags = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRuntimeSourceStatus — not-configured', () => {
  it('marks all sources as not-configured when no connectors are set', () => {
    const report = buildRuntimeSourceStatus([], NO_CONNECTORS);
    for (const entry of report.sources) {
      expect(entry.status).toBe('not-configured');
      expect(entry.configured).toBe(false);
      expect(entry.evidenceCount).toBe(0);
    }
  });

  it('marks logs as not-configured when elasticsearch is false', () => {
    const report = buildRuntimeSourceStatus(
      [makeEvidence('logs', 'log')],
      { elasticsearch: false },
    );
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('not-configured');
  });
});

describe('buildRuntimeSourceStatus — failed', () => {
  it('marks logs as failed when elasticsearch is true but logsCollected is false', () => {
    const report = buildRuntimeSourceStatus([], { elasticsearch: true, logsCollected: false });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('failed');
    expect(logs.configured).toBe(true);
    expect(logs.evidenceCount).toBe(0);
  });

  it('attaches logsCompatibilityError as detail on logs failed entry', () => {
    const report = buildRuntimeSourceStatus([], {
      elasticsearch: true,
      logsCollected: false,
      logsCompatibilityError: 'field @timestamp missing',
    });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('failed');
    expect(logs.detail).toBe('field @timestamp missing');
  });

  it('marks metrics as failed when grafana is true but metricsCollected is false', () => {
    const report = buildRuntimeSourceStatus([], { grafana: true, metricsCollected: false });
    const metrics = report.sources.find((s) => s.source === 'metrics')!;
    expect(metrics.status).toBe('failed');
    expect(metrics.configured).toBe(true);
  });

  it('attaches metricsFailureReason as detail on the failed metrics entry', () => {
    const report = buildRuntimeSourceStatus([], {
      grafana: true,
      metricsCollected: false,
      metricsFailureReason: 'timeout',
    });
    const metrics = report.sources.find((s) => s.source === 'metrics')!;
    expect(metrics.status).toBe('failed');
    expect(metrics.detail).toBe('timeout');
  });

  it('attaches logsFailureReason as detail when there is no compatibility error', () => {
    const report = buildRuntimeSourceStatus([], {
      elasticsearch: true,
      logsCollected: false,
      logsFailureReason: 'connection failed',
    });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('failed');
    expect(logs.detail).toBe('connection failed');
  });

  it('compatibility error keeps precedence over logsFailureReason', () => {
    const report = buildRuntimeSourceStatus([], {
      elasticsearch: true,
      logsCollected: false,
      logsCompatibilityError: 'field @timestamp missing',
      logsFailureReason: 'request failed',
    });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.detail).toBe('field @timestamp missing');
  });

  it('marks state as failed with detail when a state provider threw (stateCollected false)', () => {
    const report = buildRuntimeSourceStatus([], {
      mongodb: true,
      stateCollected: false,
      stateFailureReason: 'mongodb: connection failed',
    });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('failed');
    expect(state.detail).toBe('mongodb: connection failed');
  });

  it('marks state as failed when a configured Shopify collection failed', () => {
    const report = buildRuntimeSourceStatus([], {
      shopify: true,
      shopifyCollected: false,
      shopifyFailureReason: 'auth failure',
    });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('failed');
    expect(state.detail).toBe('shopify: auth failure');
  });

  it('marks queue as failed with detail when queue is configured but queueCollected is false', () => {
    const report = buildRuntimeSourceStatus([], {
      queue: true,
      queueCollected: false,
      queueFailureReason: 'connection failed',
    });
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.status).toBe('failed');
    expect(queue.configured).toBe(true);
    expect(queue.detail).toBe('connection failed');
  });
});

describe('buildRuntimeSourceStatus — empty', () => {
  it('marks logs as empty when configured+collected but no log evidence', () => {
    const report = buildRuntimeSourceStatus([], { elasticsearch: true, logsCollected: true });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('empty');
    expect(logs.evidenceCount).toBe(0);
  });

  it('marks metrics as empty when configured+collected but no metric evidence', () => {
    const report = buildRuntimeSourceStatus([], { grafana: true, metricsCollected: true });
    const metrics = report.sources.find((s) => s.source === 'metrics')!;
    expect(metrics.status).toBe('empty');
  });

  it('marks state as empty when mongodb configured but no state evidence', () => {
    const report = buildRuntimeSourceStatus([], { mongodb: true });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('empty');
    expect(state.configured).toBe(true);
    expect(state.evidenceCount).toBe(0);
  });

  it('marks state as empty when redis configured but no state evidence', () => {
    const report = buildRuntimeSourceStatus([], { redis: true });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('empty');
  });

  it('state stays empty when stateCollected is absent (old reports never read failed)', () => {
    const report = buildRuntimeSourceStatus([], { mongodb: true });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('empty');
    expect(state.detail).toBeUndefined();
  });

  it('queue stays empty when queueCollected is absent (old reports never read failed)', () => {
    const report = buildRuntimeSourceStatus([], { queue: true });
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.status).toBe('empty');
    expect(queue.detail).toBeUndefined();
  });

  it('queue stays not-configured when the connector is absent, even with queueCollected false', () => {
    const report = buildRuntimeSourceStatus([], { queueCollected: false });
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.status).toBe('not-configured');
  });
});

describe('buildRuntimeSourceStatus — contributed', () => {
  it('marks logs as contributed with correct count', () => {
    const evidence = [makeEvidence('logs', 'log'), makeEvidence('logs', 'log')];
    const report = buildRuntimeSourceStatus(evidence, { elasticsearch: true, logsCollected: true });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.status).toBe('contributed');
    expect(logs.evidenceCount).toBe(2);
  });

  it('credits a configured+collected Axiom as a contributed logs source (HOR-429 honesty)', () => {
    // Regression: a configured Axiom that folded log evidence must NOT report
    // "logs not-configured" — the header self-contradiction this fixes.
    const evidence = [makeEvidence('logs', 'log'), makeEvidence('logs', 'log')];
    const report = buildRuntimeSourceStatus(evidence, { axiom: true, axiomCollected: true });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.configured).toBe(true);
    expect(logs.status).toBe('contributed');
    expect(logs.evidenceCount).toBe(2);
  });

  it('marks logs as failed when axiom is configured but axiomCollected is false', () => {
    const report = buildRuntimeSourceStatus([], { axiom: true, axiomCollected: false });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.configured).toBe(true);
    expect(logs.status).toBe('failed');
  });

  it('marks metrics as contributed', () => {
    const evidence = [makeEvidence('metrics', 'metric')];
    const report = buildRuntimeSourceStatus(evidence, { grafana: true, metricsCollected: true });
    const metrics = report.sources.find((s) => s.source === 'metrics')!;
    expect(metrics.status).toBe('contributed');
    expect(metrics.evidenceCount).toBe(1);
  });

  it('marks state as contributed via redis evidence', () => {
    const evidence = [makeEvidence('state', 'redis-key')];
    const report = buildRuntimeSourceStatus(evidence, { redis: true });
    const state = report.sources.find((s) => s.source === 'state')!;
    expect(state.status).toBe('contributed');
    expect(state.evidenceCount).toBe(1);
  });

  it('marks queue as contributed only from queue-state, not queue-edge', () => {
    const evidence = [
      makeEvidence('queue', 'queue-edge'), // structural — should not count
      makeEvidence('queue', 'queue-state'), // runtime — counts
      makeEvidence('queue', 'queue-state'),
    ];
    const report = buildRuntimeSourceStatus(evidence, {});
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.configured).toBe(true);
    expect(queue.evidenceCount).toBe(2);
    expect(queue.status).toBe('contributed');
  });

  it('marks queue as empty when only queue-edge evidence exists (no runtime data)', () => {
    const evidence = [makeEvidence('queue', 'queue-edge')];
    const report = buildRuntimeSourceStatus(evidence, {});
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.configured).toBe(true);
    expect(queue.evidenceCount).toBe(0);
    expect(queue.status).toBe('empty');
  });

  it('marks queue as not-configured when no queue evidence at all', () => {
    const evidence = [makeEvidence('logs', 'log')];
    const report = buildRuntimeSourceStatus(evidence, { elasticsearch: true, logsCollected: true });
    const queue = report.sources.find((s) => s.source === 'queue')!;
    expect(queue.configured).toBe(false);
    expect(queue.status).toBe('not-configured');
  });
});

describe('buildRuntimeSourceStatus — report shape', () => {
  it('always returns exactly 4 sources in order: logs, metrics, state, queue', () => {
    const report = buildRuntimeSourceStatus([], {});
    expect(report.sources).toHaveLength(4);
    expect(report.sources.map((s) => s.source)).toEqual(['logs', 'metrics', 'state', 'queue']);
  });

  it('does not set detail when there is no compatibility error', () => {
    const report = buildRuntimeSourceStatus([], { elasticsearch: true, logsCollected: true });
    const logs = report.sources.find((s) => s.source === 'logs')!;
    expect(logs.detail).toBeUndefined();
  });
});
