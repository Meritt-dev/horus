/**
 * Pure helpers for converting raw BullMQ queue state into typed Evidence (HOR-12).
 *
 * No network, no side effects. Thresholds are intentionally generous — the goal
 * is to surface anything an engineer would care about during an incident, not to
 * flag every non-zero count.
 */

import type { Evidence } from '@horus/core';
import { redactSecrets } from '@horus/core';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Raw counts for a single queue, collected from Redis. */
export interface QueueCounts {
  queueName: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  completed: number;
  /** Non-zero only when the queue is paused (jobs accumulate in the paused list). */
  paused: number;
  isPaused: boolean;
  /** Age of the oldest waiting job in milliseconds; undefined when the queue is empty. */
  oldestWaitingMs?: number;
  /**
   * Age (ms) of the most recent failed job in the sample (HOR-217). Lets callers
   * distinguish a job that failed minutes ago from a stale failure days old.
   */
  newestFailedAgeMs?: number;
  /**
   * Top failed-reason buckets, sorted by count descending. `lastFailedAgeMs` is the
   * age (ms) of the most recent sampled failure for that reason (HOR-217).
   */
  failedBreakdown?: Array<{ reason: string; count: number; lastFailedAgeMs?: number }>;
}

export interface QueueRuntimeState {
  prefix: string;
  collectedAt: string;
  queues: QueueCounts[];
}

export type QueueSignalKind =
  | 'backlog'
  | 'failed-spike'
  | 'delayed-accumulation'
  | 'worker-starvation'
  | 'failed-breakdown'
  | 'oldest-job'
  | 'summary';

export interface QueueSignal {
  queueName: string;
  kind: QueueSignalKind;
  title: string;
  relevance: number;
  payload: Record<string, unknown>;
  timestamp?: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const BACKLOG_WARN = 100;
const BACKLOG_HIGH = 1_000;
const FAILED_WARN = 20;
const DELAYED_WARN = 50;
/** Starvation: queue has jobs waiting but no workers are processing. */
const STARVATION_MIN = 10;
const OLD_JOB_WARN_MS = 5 * 60_000;
const OLD_JOB_HIGH_MS = 60 * 60_000;
/** Only emit a failed-breakdown signal when the top reason owns at least this share. */
const BREAKDOWN_PCT_THRESHOLD = 30;
/**
 * A failed job older than this is "stale" — its error reflects a past run, not a
 * live incident. Surfaced so investigations don't report an old 401 as current (HOR-217).
 */
export const STALE_FAILED_MS = 60 * 60_000;

/** Is a failed-job age stale (older than the threshold)? */
export function isStaleFailure(ageMs: number | undefined): boolean {
  return ageMs !== undefined && ageMs > STALE_FAILED_MS;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms >= 86_400_000) return `${Math.floor(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 1_000)}s`;
}

// ── Signal extraction ─────────────────────────────────────────────────────────

/**
 * Derive all notable signals for a single queue.
 * Always includes a `summary` signal so the AI sees raw counts even when
 * nothing is alarming.
 */
export function analyzeQueueSignals(q: QueueCounts): QueueSignal[] {
  const signals: QueueSignal[] = [];

  // Starvation-like signal: waiting jobs with no active workers in this snapshot.
  // A single zero-active observation is not proof of starvation — workers may be
  // idle between polls or all jobs may have just completed. Relevance is kept
  // moderate; the engine should not treat this alone as a confirmed cause.
  if (q.waiting >= STARVATION_MIN && q.active === 0) {
    signals.push({
      queueName: q.queueName,
      kind: 'worker-starvation',
      title: `${q.queueName}: ${q.waiting} waiting jobs, 0 active workers — possible starvation`,
      relevance: 0.7,
      payload: { queueName: q.queueName, waiting: q.waiting, active: 0 },
    });
  } else if (q.waiting > BACKLOG_HIGH) {
    signals.push({
      queueName: q.queueName,
      kind: 'backlog',
      title: `${q.queueName}: ${q.waiting.toLocaleString()} jobs waiting (severe backlog)`,
      relevance: 0.88,
      payload: { queueName: q.queueName, waiting: q.waiting, active: q.active },
    });
  } else if (q.waiting > BACKLOG_WARN) {
    signals.push({
      queueName: q.queueName,
      kind: 'backlog',
      title: `${q.queueName}: ${q.waiting} jobs waiting (backlog)`,
      relevance: 0.8,
      payload: { queueName: q.queueName, waiting: q.waiting, active: q.active },
    });
  }

  if (q.oldestWaitingMs !== undefined && q.oldestWaitingMs > OLD_JOB_WARN_MS) {
    const severe = q.oldestWaitingMs > OLD_JOB_HIGH_MS;
    signals.push({
      queueName: q.queueName,
      kind: 'oldest-job',
      title: `${q.queueName}: oldest waiting job is ${fmtMs(q.oldestWaitingMs)} old${severe ? ' (severe)' : ''}`,
      relevance: severe ? 0.85 : 0.75,
      payload: { queueName: q.queueName, oldestWaitingMs: q.oldestWaitingMs },
    });
  }

  if (q.failed > FAILED_WARN) {
    const severe = q.failed > 100;
    const stale = isStaleFailure(q.newestFailedAgeMs);
    const ageStr =
      q.newestFailedAgeMs !== undefined
        ? ` (most recent ${fmtMs(q.newestFailedAgeMs)} ago${stale ? ', STALE' : ''})`
        : '';
    signals.push({
      queueName: q.queueName,
      kind: 'failed-spike',
      title: `${q.queueName}: ${q.failed} failed jobs${severe ? ' (severe)' : ''}${ageStr}`,
      // A purely stale failure pile is less likely to be the live incident — hedge.
      relevance: stale ? 0.5 : severe ? 0.85 : 0.75,
      payload: {
        queueName: q.queueName,
        failed: q.failed,
        newestFailedAgeMs: q.newestFailedAgeMs ?? null,
        stale,
      },
    });
  }

  if (q.delayed > DELAYED_WARN) {
    signals.push({
      queueName: q.queueName,
      kind: 'delayed-accumulation',
      title: `${q.queueName}: ${q.delayed} delayed jobs accumulated`,
      relevance: 0.7,
      payload: { queueName: q.queueName, delayed: q.delayed },
    });
  }

  // Failed breakdown: only when a single reason dominates (>= BREAKDOWN_PCT_THRESHOLD%).
  // Divide by sample total (not q.failed) — q.failed reflects all retained failures,
  // but breakdown counts come from a fixed-size sample (FAILED_SAMPLE), so the
  // denominator must match the sample to produce meaningful percentages.
  if (q.failedBreakdown && q.failedBreakdown.length > 0 && q.failed > 0) {
    const top = q.failedBreakdown[0]!;
    const sampleTotal = q.failedBreakdown.reduce((sum, b) => sum + b.count, 0);
    const pct = Math.round((top.count / Math.max(sampleTotal, 1)) * 100);
    if (pct >= BREAKDOWN_PCT_THRESHOLD) {
      const stale = isStaleFailure(top.lastFailedAgeMs);
      const ageStr =
        top.lastFailedAgeMs !== undefined
          ? `, last failed ${fmtMs(top.lastFailedAgeMs)} ago${stale ? ' [STALE]' : ''}`
          : '';
      // failedReason is a raw application error string (routinely a driver message
      // with a connection URL). It reaches reports/postmortems/AI input via the
      // title AND the payload (engine reads payload.topReason into cause titles),
      // so redact every copy.
      const safeReason = redactSecrets(top.reason);
      signals.push({
        queueName: q.queueName,
        kind: 'failed-breakdown',
        title: `${q.queueName}: ${pct}% of recently sampled failures (${top.count}/${sampleTotal} sampled) are "${safeReason}"${ageStr}`,
        // Demote a stale-only breakdown so a days-old error isn't read as live (HOR-217).
        relevance: stale ? 0.5 : 0.82,
        payload: {
          queueName: q.queueName,
          topReason: safeReason,
          topCount: top.count,
          topPct: pct,
          totalFailed: q.failed,
          topLastFailedAgeMs: top.lastFailedAgeMs ?? null,
          topStale: stale,
          breakdown: q.failedBreakdown
            .slice(0, 3)
            .map((b) => ({ ...b, reason: redactSecrets(b.reason) })),
        },
      });
    }
  }

  // Always emit a summary (low relevance) for raw counts
  signals.push({
    queueName: q.queueName,
    kind: 'summary',
    title: `${q.queueName}: ${q.waiting} waiting, ${q.active} active, ${q.failed} failed, ${q.delayed} delayed`,
    relevance: 0.4,
    payload: {
      queueName: q.queueName,
      waiting: q.waiting,
      active: q.active,
      failed: q.failed,
      delayed: q.delayed,
      completed: q.completed,
      isPaused: q.isPaused,
    },
  });

  return signals;
}

/** All signals across all queues in a runtime state snapshot. */
export function analyzeQueueRuntime(state: QueueRuntimeState): QueueSignal[] {
  return state.queues.flatMap(analyzeQueueSignals);
}

/**
 * Convert queue runtime state into Evidence records.
 * Used by `QueueRuntimeProvider.toEvidence()` and in tests.
 */
export function queueStateToEvidence(
  state: QueueRuntimeState,
  query: string,
  collectedAt: string,
): Evidence[] {
  const evs: Evidence[] = [];
  let i = 0;
  for (const q of state.queues) {
    for (const s of analyzeQueueSignals(q)) {
      evs.push({
        id: `ev_qs_${i++}`,
        source: 'queue',
        kind: 'queue-state',
        title: s.title,
        relevance: s.relevance,
        payload: s.payload,
        links: { queueName: q.queueName },
        provenance: { query, collectedAt },
        ...(s.timestamp ? { timestamp: s.timestamp } : {}),
      });
    }
  }
  return evs;
}
