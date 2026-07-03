/**
 * Generic Redis scan client (HOR-201).
 *
 * Redis in Horus is a general runtime-evidence connector, not only a BullMQ store:
 * a single server commonly holds queues in one logical DB and cache/locks/rate-limit/
 * session keys in others. This client inspects a single logical DB read-only — it never
 * mutates — and powers:
 *   - `horus connect redis` DB discovery (which DBs hold queues vs cache/state)
 *   - `horus status` per-DB display (key counts, queue counts)
 *   - investigation collectors sampling cache/state/locks/rate-limit DBs
 *
 * Queue *inspection* (job counts, failed breakdown) stays in BullMQRedisClient; this
 * client only counts/sample/detects.
 */

import { Redis, type RedisOptions } from 'ioredis';
import type { HealthStatus } from '@horus/core';
import { redactErrorMessage } from '@horus/core';

export interface RedisScanClientOpts {
  /** Base server URL. The DB is selected via the `db` option, not the URL path. */
  url: string;
  /** Logical DB index to operate on (default 0). */
  db?: number;
}

/** A sampled key prefix and how many sampled keys shared it. */
export interface KeyPrefixSample {
  prefix: string;
  count: number;
}

const SAMPLE_DEFAULT = 500;
const SCAN_BATCH = 200;

export class RedisScanClient {
  private readonly redis: Redis;
  readonly db: number;

  constructor(opts: RedisScanClientOpts) {
    this.db = opts.db ?? 0;
    const redisOpts: RedisOptions = {
      db: this.db,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      // Bound RECONNECTION — without this, ioredis reconnects forever when an
      // already-established connection drops (e.g. a port-forward/tunnel switches),
      // hanging the investigation indefinitely. Give up after 3 quick attempts.
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    };
    this.redis = new Redis(opts.url, redisOpts);
    this.redis.on('error', () => {});
  }

  /** Ping the server (also exercises AUTH). */
  async health(): Promise<HealthStatus> {
    try {
      await this.redis.ping();
      return { ok: true, detail: `Redis reachable (db ${this.db})` };
    } catch (err) {
      // Redaction never alters WRONGPASS/NOAUTH/"invalid password" tokens, so
      // redis/status.ts auth-failure classification keeps working on this detail.
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }

  /** Total number of keys in this DB (DBSIZE). */
  async dbSize(): Promise<number> {
    return this.redis.dbsize();
  }

  /**
   * Sample up to `limit` keys and group them by their leading segment (before the
   * first ':'), returning the most common prefixes. Used to characterise a cache/
   * state DB without reading values. Optional `patterns` restrict the scan.
   */
  async samplePrefixes(limit = SAMPLE_DEFAULT, patterns?: string[]): Promise<KeyPrefixSample[]> {
    const counts = new Map<string, number>();
    let sampled = 0;
    const scanPatterns = patterns && patterns.length > 0 ? patterns : ['*'];
    for (const pattern of scanPatterns) {
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          SCAN_BATCH,
        );
        cursor = next;
        for (const key of batch) {
          const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
          counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
          if (++sampled >= limit) break;
        }
      } while (cursor !== '0' && sampled < limit);
      if (sampled >= limit) break;
    }
    return [...counts.entries()]
      .map(([prefix, count]) => ({ prefix, count }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Detect BullMQ queue names in this DB by scanning `{prefix}:*:meta`. `:meta` exists
   * for every instantiated queue (even idle ones), so this finds all queues, not just
   * those with pending jobs. Returns at most `limit` names.
   */
  async detectBullmqQueues(prefix = 'bull', limit = 200): Promise<string[]> {
    const pattern = `${prefix}:*:meta`;
    const suffixLen = ':meta'.length;
    const prefixLen = prefix.length + 1;
    const names: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_BATCH);
      cursor = next;
      for (const key of batch) {
        names.push(key.slice(prefixLen, key.length - suffixLen));
        if (names.length >= limit) return names;
      }
    } while (cursor !== '0' && names.length < limit);
    return names;
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
