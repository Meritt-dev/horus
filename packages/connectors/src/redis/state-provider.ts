/**
 * Redis runtime-state evidence provider (HOR-201).
 *
 * Reads cache/state/locks/rate-limit logical DBs read-only and produces summary
 * signals (key counts, top prefixes, lock/rate-limit presence) for the investigation
 * engine to fold as `redis-key` evidence. Counts/prefixes only — never key values.
 */

import type { RedisRole } from '@horus/core';
import { RedisScanClient, type KeyPrefixSample } from './scan-client.js';

/** One configured state DB to sample (URL already points at the base server). */
export interface RedisStateDb {
  db: number;
  name?: string;
  roles: RedisRole[];
  /** Base server URL — the DB index is selected via the `db` field. */
  url: string;
  scan?: { sampleLimit: number; patterns: string[] };
}

export interface RedisDbSummary {
  db: number;
  name?: string;
  roles: RedisRole[];
  keyCount: number;
  prefixes: KeyPrefixSample[];
}

export interface RedisStateSignal {
  db: number;
  title: string;
  payload: Record<string, unknown>;
  /** Base relevance 0–1; the engine may boost it on hint-term overlap. */
  relevance: number;
  /** Lowercased text the engine can match hint terms against. */
  matchText: string;
}

export interface RedisStateAnalysis {
  collectedAt: string;
  databases: RedisDbSummary[];
  signals: RedisStateSignal[];
}

export interface RedisStateProvider {
  analyzeRedisState(): Promise<RedisStateAnalysis>;
  close(): Promise<void>;
}

const LOCK_RE = /lock/i;
const RATELIMIT_RE = /rate.?limit|throttle/i;

/** Minimal scan surface the state provider needs — lets tests inject a fake. */
export interface ScanLike {
  health(): Promise<{ ok: boolean; detail: string }>;
  dbSize(): Promise<number>;
  samplePrefixes(limit?: number, patterns?: string[]): Promise<KeyPrefixSample[]>;
  close(): Promise<void>;
}

export class RedisStateRuntimeProvider implements RedisStateProvider {
  constructor(
    private readonly dbs: RedisStateDb[],
    /** Injectable for tests; defaults to a real RedisScanClient. */
    private readonly mkClient: (d: RedisStateDb) => ScanLike = (d) =>
      new RedisScanClient({ url: d.url, db: d.db }),
  ) {}

  async analyzeRedisState(): Promise<RedisStateAnalysis> {
    const collectedAt = new Date().toISOString();
    const databases: RedisDbSummary[] = [];
    const signals: RedisStateSignal[] = [];
    const failures: string[] = [];

    for (const d of this.dbs) {
      const client = this.mkClient(d);
      try {
        const health = await client.health();
        if (!health.ok) {
          // Skip this DB but remember why — when EVERY configured DB fails we
          // throw below so the engine records a state gap instead of reading a
          // total Redis outage as a clean empty analysis.
          failures.push(`db ${d.db}: ${health.detail}`);
          continue;
        }
        const keyCount = await client.dbSize();
        const prefixes = await client.samplePrefixes(d.scan?.sampleLimit ?? 500, d.scan?.patterns);
        databases.push({
          db: d.db,
          ...(d.name !== undefined ? { name: d.name } : {}),
          roles: d.roles,
          keyCount,
          prefixes,
        });
        if (keyCount === 0) continue;

        const roleLabel = d.roles.length > 0 ? d.roles.join('/') : 'state';
        const topPrefixes = prefixes.slice(0, 10);
        const topText = topPrefixes.map((p) => p.prefix).join(' ');

        // Summary signal — structural context for this DB.
        signals.push({
          db: d.db,
          title: `Redis DB ${d.db} (${roleLabel}): ${keyCount} key(s), top prefixes ${topPrefixes
            .slice(0, 4)
            .map((p) => `${p.prefix}:*`)
            .join(', ')}`,
          payload: { db: d.db, roles: d.roles, keyCount, topPrefixes },
          relevance: 0.4,
          matchText: `${roleLabel} ${topText}`.toLowerCase(),
        });

        // Role-specific signals — locks and rate-limits are common incident causes.
        const lockPrefixes = prefixes.filter((p) => LOCK_RE.test(p.prefix));
        if (d.roles.includes('locks') || lockPrefixes.length > 0) {
          const lockKeys = lockPrefixes.reduce((n, p) => n + p.count, 0);
          if (lockKeys > 0) {
            signals.push({
              db: d.db,
              title: `Redis DB ${d.db}: ${lockKeys} lock key(s) present (${lockPrefixes
                .map((p) => `${p.prefix}:*`)
                .join(', ')})`,
              payload: { db: d.db, lockKeys, lockPrefixes },
              relevance: 0.6,
              matchText: `lock locks ${lockPrefixes.map((p) => p.prefix).join(' ')}`.toLowerCase(),
            });
          }
        }
        const rlPrefixes = prefixes.filter((p) => RATELIMIT_RE.test(p.prefix));
        if (d.roles.includes('rate-limit') || rlPrefixes.length > 0) {
          const rlKeys = rlPrefixes.reduce((n, p) => n + p.count, 0);
          if (rlKeys > 0) {
            signals.push({
              db: d.db,
              title: `Redis DB ${d.db}: ${rlKeys} rate-limit key(s) present`,
              payload: { db: d.db, rateLimitKeys: rlKeys, prefixes: rlPrefixes },
              relevance: 0.6,
              matchText: `rate limit throttle ${rlPrefixes.map((p) => p.prefix).join(' ')}`.toLowerCase(),
            });
          }
        }
      } finally {
        await client.close();
      }
    }

    if (this.dbs.length > 0 && databases.length === 0 && failures.length > 0) {
      // health.detail is already redacted by the scan client.
      throw new Error(`redis state collection failed: ${failures.join('; ')}`);
    }
    return { collectedAt, databases, signals };
  }

  async close(): Promise<void> {}
}
