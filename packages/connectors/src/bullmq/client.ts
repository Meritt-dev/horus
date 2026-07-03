/**
 * Thin Redis client for reading BullMQ queue state (HOR-12).
 * Read-only — no mutations, no write surface exposed.
 */

import { Redis, type RedisOptions } from 'ioredis';
import type { HealthStatus } from '@horus/core';
import { redactErrorMessage } from '@horus/core';

export interface BullMQClientOpts {
  url: string;
  /** BullMQ key prefix — defaults to "bull". */
  prefix?: string;
}

export class BullMQRedisClient {
  private readonly redis: Redis;
  readonly prefix: string;

  constructor(opts: BullMQClientOpts) {
    this.prefix = opts.prefix ?? 'bull';
    const redisOpts: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      // Bound reconnection so a dropped connection fails fast instead of retrying forever.
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    };
    this.redis = new Redis(opts.url, redisOpts);
    // Prevent unhandled-error process crash; failures surface via thrown promises.
    this.redis.on('error', () => {});
  }

  /** Redis key for a BullMQ queue sub-structure. */
  queueKey(
    name: string,
    suffix: 'wait' | 'active' | 'delayed' | 'failed' | 'completed' | 'paused',
  ): string {
    return `${this.prefix}:${name}:${suffix}`;
  }

  /** Redis key for a BullMQ job hash. */
  jobKey(queueName: string, jobId: string): string {
    return `${this.prefix}:${queueName}:${jobId}`;
  }

  async listLen(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  async sortedSetCard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  /** Returns null when the list is empty or the key does not exist. */
  async listIndex(key: string, index: number): Promise<string | null> {
    return this.redis.lindex(key, index);
  }

  /**
   * Read specific fields from a BullMQ job hash.
   * Returns an object with only the fields that exist in Redis.
   */
  async jobFields(
    queueName: string,
    jobId: string,
    fields: string[],
  ): Promise<Record<string, string>> {
    const values = await this.redis.hmget(this.jobKey(queueName, jobId), ...fields);
    const result: Record<string, string> = {};
    for (let i = 0; i < fields.length; i++) {
      const v = values[i];
      if (v !== null && v !== undefined) result[fields[i]!] = v;
    }
    return result;
  }

  /** The most recent `count` members of a sorted set (rightmost = highest score). */
  async sortedSetTail(key: string, count: number): Promise<string[]> {
    return this.redis.zrange(key, -count, -1);
  }

  /**
   * Fetch a single field from multiple job hashes in one pipeline round-trip.
   * Null entries mean the field was absent.
   */
  async pipelineHget(
    queueName: string,
    jobIds: string[],
    field: string,
  ): Promise<(string | null)[]> {
    if (jobIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const jobId of jobIds) {
      pipeline.hget(this.jobKey(queueName, jobId), field);
    }
    const results = await pipeline.exec();
    if (!results) return jobIds.map(() => null);
    return results.map(([err, val]: [Error | null, unknown]) =>
      err !== null || val === undefined ? null : (val as string | null),
    );
  }

  /**
   * Discover queue names by scanning for BullMQ `:meta` keys.
   *
   * `:meta` is written when a Queue is instantiated and persists regardless of job
   * state, so it finds idle queues too. Scanning `:wait` (the previous approach) only
   * surfaced queues with pending jobs, so idle-but-real queues were invisible.
   * Returns at most `limit` queue names.
   */
  async discoverQueues(limit = 50): Promise<string[]> {
    const pattern = `${this.prefix}:*:meta`;
    const suffixLen = ':meta'.length;
    const prefixLen = this.prefix.length + 1; // "bull:"
    const names: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      for (const key of batch) {
        names.push(key.slice(prefixLen, key.length - suffixLen));
        if (names.length >= limit) return names;
      }
    } while (cursor !== '0' && names.length < limit);
    return names;
  }

  async health(): Promise<HealthStatus> {
    try {
      await this.redis.ping();
      return { ok: true, detail: `Redis reachable (prefix: ${this.prefix})` };
    } catch (err) {
      // ioredis errors can echo the credential-bearing connection URL.
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }
}
