import { Kafka, type SASLOptions } from 'kafkajs';
import { z } from 'zod';
import {
  runtimeSchemas,
  redactErrorMessage,
  type RuntimeConfig,
  type Evidence,
} from '@horus/core';
import type { Provider } from '../contract.js';
import { nativeJson } from '../cloud-logs/native-cli.js';
import { createHash } from 'node:crypto';
export interface QueueEvidenceProvider extends Provider {
  collect(): Promise<Evidence[]>;
}
function evidence(
  source: string,
  queueName: string,
  payload: Record<string, unknown>,
): Evidence {
  const now = new Date().toISOString();
  return {
    id: `ev_${source}_${createHash('sha256').update(queueName).digest('hex').slice(0, 16)}`,
    source: 'queue',
    kind: 'queue-state',
    title: `${source}: ${queueName} — read-only queue snapshot`,
    timestamp: now,
    relevance: 0.45,
    payload: { source, ...payload },
    links: { queueName },
    provenance: { query: `${source}.metadata`, collectedAt: now },
  };
}
/** Offsets only: never consumes messages, commits offsets, or creates topics. */
export class KafkaQueueProvider implements QueueEvidenceProvider {
  readonly id = 'kafka';
  readonly kind = 'queue' as const;
  readonly config: RuntimeConfig['kafka'];
  constructor(config: RuntimeConfig['kafka']) {
    this.config = runtimeSchemas.kafka.parse(config);
  }
  async collect(): Promise<Evidence[]> {
    const c = this.config;
    const admin = new Kafka({
      clientId: 'horus-readonly',
      brokers: c.brokers,
      ssl: c.ssl,
      connectionTimeout: 5000,
      requestTimeout: 8000,
      retry: { retries: 1 },
      logLevel: 0,
      ...(c.username && c.password
        ? {
            sasl: {
              mechanism: c.mechanism,
              username: c.username,
              password: c.password,
            } as SASLOptions,
          }
        : {}),
    }).admin();
    try {
      await admin.connect();
      const out: Evidence[] = [];
      for (const topic of c.topics) {
        const ends = await admin.fetchTopicOffsets(topic);
        for (const groupId of c.groups) {
          const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
          const partitions = ends.map((p) => {
            const committed = offsets
              .find((t) => t.topic === topic)
              ?.partitions.find((x) => x.partition === p.partition)?.offset;
            return {
              partition: p.partition,
              logEnd: p.high,
              committed: committed ?? null,
              lag: offsetLag(p.high, committed),
            };
          });
          out.push(
            evidence('kafka', `${topic}/${groupId}`, {
              topic,
              groupId,
              partitions,
              limitation:
                'Point-in-time committed offsets; unknown lag is not zero and does not prove worker starvation.',
            }),
          );
        }
      }
      return out;
    } finally {
      await admin.disconnect();
    }
  }
  async health() {
    try {
      await this.collect();
      return { ok: true, detail: 'Kafka topic and group offsets readable' };
    } catch (e) {
      return { ok: false, detail: redactErrorMessage(e) };
    }
  }
}
export function offsetLag(high: string, committed?: string): string | null {
  if (!committed || !/^\d+$/.test(committed) || !/^\d+$/.test(high)) return null;
  const lag = BigInt(high) - BigInt(committed);
  return lag >= 0n ? lag.toString() : null;
}
const count = z.number().int().nonnegative();
const queueSchema = z.object({
  properties: z.object({
    status: z.string(),
    countDetails: z.object({
      activeMessageCount: count,
      deadLetterMessageCount: count,
      scheduledMessageCount: count,
      transferMessageCount: count.optional(),
      transferDeadLetterMessageCount: count.optional(),
    }),
  }),
});
/** Management-plane counts only: no peek-lock, receive, complete, or dead-letter writes. */
export class ServiceBusQueueProvider implements QueueEvidenceProvider {
  readonly id = 'azure-service-bus';
  readonly kind = 'queue' as const;
  readonly config: RuntimeConfig['azure-service-bus'];
  constructor(config: RuntimeConfig['azure-service-bus']) {
    this.config = runtimeSchemas['azure-service-bus'].parse(config);
  }
  async collect(): Promise<Evidence[]> {
    const c = this.config;
    const out: Evidence[] = [];
    for (const queue of c.queues) {
      const result = queueSchema.parse(
        await nativeJson(c.executable, [
          'rest',
          '--method',
          'get',
          '--url',
          `https://management.azure.com${c.namespaceId}/queues/${encodeURIComponent(queue)}?api-version=2024-01-01`,
          '--subscription',
          c.namespaceId.split('/')[2]!,
          '--output',
          'json',
        ]),
      );
      out.push(
        evidence(this.id, queue, {
          queue,
          status: result.properties.status,
          ...result.properties.countDetails,
          limitation:
            'Broker counts do not measure active workers or establish starvation.',
        }),
      );
    }
    return out;
  }
  async health() {
    try {
      await this.collect();
      return { ok: true, detail: 'Service Bus queue counts readable' };
    } catch (e) {
      return { ok: false, detail: redactErrorMessage(e) };
    }
  }
}
