import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq, watchState, watchJob, watchEvent, type HorusDb } from '@horus/db';
import { redactCloudValue } from './cloud/investigation-sync.js';
import type { WorkerActivity } from './worker-activity.js';

export const incidentEventSchema = z.object({
  source: z.enum(['sentry', 'elasticsearch', 'pagerduty']),
  eventId: z.string().min(1).max(512),
  incidentId: z.string().min(1).max(512),
  fingerprint: z.string().min(1).max(1024),
  occurredAt: z.string().datetime({ offset: true }),
  hint: z.string().min(1).max(2000),
  environment: z.string().min(1),
  service: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  state: z.enum(['active', 'resolved']),
  investigationRequired: z.boolean().optional(),
  severity: z.string(),
  episode: z.string().optional(),
  orderId: z.string().optional(),
  workflow: z.string().optional(),
  correlationId: z.string().optional(),
  errorCode: z.string().optional(),
  eventCode: z.string().max(255).optional(),
  operation: z.string().optional(),
});
export type IncidentEvent = z.infer<typeof incidentEventSchema>;
export type WatchStage = 'engine' | 'ai' | 'upload' | 'notify' | 'complete' | 'done';
export interface WatchJobData {
  id: string;
  route: string;
  event: IncidentEvent;
  reportId: string;
  createdAt: string;
  stage: WatchStage;
  attempts: Partial<Record<WatchStage, number>>;
  nextAttemptAt: number;
  status: 'pending' | 'running' | 'retry-wait' | 'terminal-failed' | 'done' | 'cancelled';
  error?: string;
  pid?: number;
  resolvedAt?: string;
  cloudReportId?: string;
  cloudAgentRunId?: string;
  cloudUrl?: string;
  cloudRequest?: { id: string; claimToken: string; workerId: string };
  ai?: { sessionId: string; model: string; result: unknown };
  aiFailure?: string;
  notified?: boolean;
  notificationKey?: string;
  notice?: {
    kind: 'budget' | 'terminal';
    day: string;
    hint: string;
    cause: string;
    state: 'pending' | 'done';
    retryAt: number;
    error?: string;
  };
  latestEvent?: IncidentEvent;
  activity?: WorkerActivity[];
  startedAt?: string;
  analysisEndedAt?: string;
}
export const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function readWatchState<T>(
  db: HorusDb,
  key: string,
): Promise<T | undefined> {
  const [row] = await db.select().from(watchState).where(eq(watchState.key, key));
  return (row?.value as { data?: T } | undefined)?.data;
}
export async function writeWatchState(
  db: HorusDb,
  key: string,
  value: unknown,
): Promise<void> {
  await db
    .insert(watchState)
    .values({ key, value: { data: value } })
    .onConflictDoUpdate({ target: watchState.key, set: { value: { data: value } } });
}
export async function jobs(db: HorusDb, route?: string): Promise<WatchJobData[]> {
  const rows = await db
    .select()
    .from(watchJob)
    .where(route ? eq(watchJob.route, route) : undefined);
  return rows
    .map((r) => r.data as WatchJobData)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function saveJob(db: HorusDb, job: WatchJobData): Promise<void> {
  await db
    .update(watchJob)
    .set({ data: redactCloudValue(job), updatedAt: new Date() })
    .where(eq(watchJob.id, job.id));
}
/** Event acceptance and the source cursor commit together. No permanent in-memory seen set. */
export async function acceptEvents(
  db: HorusDb,
  route: string,
  events: IncidentEvent[],
  cursor?: string,
  cloud?: { requestId: string; reportId: string; claimToken: string; workerId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const d = tx as unknown as HorusDb;
    for (const raw of [...events].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    )) {
      const event = redactCloudValue(incidentEventSchema.parse(raw));
      const storedEventId = cloud ? `${cloud.requestId}:${event.eventId}` : event.eventId;
      const [seen] = await tx
        .select()
        .from(watchEvent)
        .where(and(eq(watchEvent.route, route), eq(watchEvent.eventId, storedEventId)));
      if (seen) {
        if (cloud) {
          const [row] = await tx
            .select()
            .from(watchJob)
            .where(eq(watchJob.id, seen.jobId));
          const job = row!.data as WatchJobData;
          job.cloudRequest = {
            id: cloud.requestId,
            claimToken: cloud.claimToken,
            workerId: cloud.workerId,
          };
          if (job.status === 'done') {
            job.stage = 'complete';
            job.status = 'pending';
          }
          await saveJob(d, job);
        }
        continue;
      }
      const family = event.orderId
        ? `${event.workflow ?? 'workflow'}:${event.orderId}`
        : (event.correlationId ??
          `${event.source}:${event.incidentId}:${event.fingerprint}`);
      const prior = (await jobs(d, route))
        .filter((j) =>
          cloud
            ? j.id === cloud.requestId || j.cloudRequest?.id === cloud.requestId
            : (j.event.orderId
                ? `${j.event.workflow ?? 'workflow'}:${j.event.orderId}`
                : (j.event.correlationId ??
                  `${j.event.source}:${j.event.incidentId}:${j.event.fingerprint}`)) ===
              family,
        )
        .at(-1);
      const isLater =
        !prior ||
        Date.parse(event.occurredAt) >=
          Date.parse((prior.latestEvent ?? prior.event).occurredAt);
      // Explicit resolution or a native new episode reopens; ES has no resolve, so a quiet hour is an explicit episode boundary.
      const recurrence =
        prior &&
        isLater &&
        event.state === 'active' &&
        ((prior.resolvedAt &&
          (!event.episode || event.episode !== prior.event.episode)) ||
          (event.episode && event.episode !== prior.event.episode) ||
          (event.source === 'elasticsearch' &&
            Date.parse(event.occurredAt) -
              Date.parse((prior.latestEvent ?? prior.event).occurredAt) >
              3600_000));
      let job = prior && !recurrence ? prior : undefined;
      if (!job) {
        const id = cloud?.requestId ?? randomUUID();
        job = {
          id,
          route,
          event,
          reportId: cloud?.reportId ?? randomUUID(),
          createdAt: new Date().toISOString(),
          stage: 'engine',
          attempts: {},
          nextAttemptAt: 0,
          status:
            event.state === 'resolved' && !event.investigationRequired
              ? 'cancelled'
              : 'pending',
          ...(event.state === 'resolved' ? { resolvedAt: event.occurredAt } : {}),
        };
        await tx.insert(watchJob).values({
          id,
          route,
          episode: cloud
            ? digest([cloud.requestId])
            : digest([family, event.episode ?? event.eventId]),
          data: job,
        });
      } else if (isLater) {
        if (
          event.investigationRequired &&
          !job.attempts.engine &&
          ['cancelled', 'done'].includes(job.status)
        ) {
          job.stage = 'engine';
          job.status = 'pending';
          job.nextAttemptAt = 0;
        }
        const previousSeverity = (job.latestEvent ?? job.event).severity;
        job.latestEvent = event;
        if (event.state === 'resolved') job.resolvedAt = event.occurredAt;
        else {
          // A resolved-only episode has no report; its first active event still needs the engine.
          if (
            job.resolvedAt &&
            !job.attempts.engine &&
            ['cancelled', 'done'].includes(job.status)
          ) {
            job.stage = 'engine';
            job.status = 'pending';
            job.nextAttemptAt = 0;
          }
          job.resolvedAt = undefined;
        }
        // Severity changes update the saved incident and re-deliver it without re-running inference.
        if (event.severity !== previousSeverity && job.status === 'done') {
          job.stage = 'notify';
          job.status = 'pending';
          job.notified = false;
          // The prior delivery was acknowledged. This update gets its own retry checkpoint.
          job.notificationKey = undefined;
          job.attempts.notify = 0;
          job.nextAttemptAt = 0;
        }
      }
      if (cloud) {
        job.cloudRequest = {
          id: cloud.requestId,
          claimToken: cloud.claimToken,
          workerId: cloud.workerId,
        };
        if (job.status === 'done' || job.status === 'cancelled') {
          job.stage = 'complete';
          job.status = 'pending';
        }
      }
      await saveJob(d, job);
      await tx
        .insert(watchEvent)
        .values({ route, eventId: storedEventId, jobId: job.id });
    }
    if (cursor) await writeWatchState(d, `cursor:${route}`, cursor);
  });
}
