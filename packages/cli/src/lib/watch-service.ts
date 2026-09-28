import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  statSync,
  appendFileSync,
} from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { loadConfig, resolveEnvironment, redactErrorMessage } from '@horus/core';
import {
  sentryForEnv,
  logsForEnv,
  type SentryIssue,
  type LogRecord,
} from '@horus/connectors';
import {
  createLocalDb,
  localDbPath,
  acquireDbLock,
  investigations,
  eq,
  type HorusDb,
} from '@horus/db';
import type { InvestigationReport } from '@horus/engine';
import {
  buildInvestigationContext,
  disposeInvestigationContext,
  runOneInvestigation,
} from './investigation-runner.js';
import {
  acceptEvents,
  digest,
  jobs,
  readWatchState,
  writeWatchState,
  saveJob,
  incidentEventSchema,
  type IncidentEvent,
  type WatchJobData,
} from './watch-store.js';
import {
  interpretIncident,
  runProcess,
  incidentResultSchema,
} from './claude-investigation.js';
import { CloudError } from './cloud/api.js';
import { memorySyncContext, syncLinkedMemory } from './cloud/memory-sync.js';
import {
  uploadInvestigationToCloud,
  redactCloudValue,
} from './cloud/investigation-sync.js';
import { dispatchNotify, notificationCause } from './notify-sink.js';

const absolute = z.string().refine(isAbsolute, 'Absolute path required');
export const serviceConfigSchema = z
  .object({
    claude: absolute,
    runtime: absolute,
    entry: absolute,
    runtimeArgs: z.array(z.string()).default([]),
    intervalSeconds: z.number().int().min(10).max(3600).default(60),
    deadlineSeconds: z.number().int().min(10).max(1800).default(300),
    // Pilot caps are selected during activation; no invented permanent daily allowance.
    dailyInvestigations: z.number().int().positive(),
    dailyModelCalls: z.number().int().positive(),
    cloudWebUrl: z.string().url().default('https://cloud.horus.sh'),
    environment: z.record(z.string()).default({}),
    projects: z
      .array(
        z.object({
          root: absolute,
          config: absolute,
          project: z.string().min(1),
          environment: z.string().min(1),
          source: z.enum(['sentry', 'elasticsearch', 'pagerduty', 'auto']),
          enabled: z.boolean().default(true),
          notifications: z.enum(['off', 'configured']),
          idempotentDestination: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type WatchProject = ServiceConfig['projects'][number];
export const serviceHome = () =>
  join(
    process.env.HORUS_SERVICE_DIR ?? process.env.HORUS_HOME ?? join(homedir(), '.horus'),
    'service',
  );
export const routeKey = (p: WatchProject) => digest([p.root, p.project, p.environment]);
export function readServiceConfig(path: string): ServiceConfig {
  const config = serviceConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (new Set(config.projects.map(routeKey)).size !== config.projects.length)
    throw new Error('Duplicate project/environment routes');
  return config;
}
async function withDb<T>(fn: (db: HorusDb) => Promise<T>): Promise<T> {
  const h = await createLocalDb();
  try {
    return await fn(h.db);
  } finally {
    await h.sql.end();
  }
}
function log(message: string) {
  const home = serviceHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'service.log');
  if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, `${file}.1`);
  appendFileSync(
    file,
    `${new Date().toISOString()} ${redactErrorMessage(new Error(message))}\n`,
    { mode: 0o600 },
  );
}
export function sentryEvent(issue: SentryIssue, environment: string): IncidentEvent {
  if (!issue.lastSeen) throw new Error('Sentry issue has no occurrence time');
  return incidentEventSchema.parse({
    source: 'sentry',
    eventId: `${issue.id}:${issue.lastSeen}:${issue.count}:${issue.status}`,
    incidentId: issue.id,
    fingerprint: issue.title,
    occurredAt:
      issue.status === 'resolved'
        ? (issue.lastStatusChange ?? new Date().toISOString())
        : issue.lastSeen,
    hint: issue.title,
    environment,
    sourceUrl: issue.permalink,
    severity: issue.level ?? 'error',
    state: issue.status === 'resolved' ? 'resolved' : 'active',
    episode: issue.lastStatusChange ?? issue.firstSeen,
  });
}
export function elasticEvent(record: LogRecord, environment: string): IncidentEvent {
  const c = record.context ?? {};
  const field = (...keys: string[]) =>
    keys.map((k) => c[k]).find((v) => typeof v === 'string' || typeof v === 'number');
  const string = (v: unknown) => (v === undefined ? undefined : String(v));
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const code = (v: unknown) =>
    typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(v) ? v : undefined;
  const details = object(object(c.data).details);
  const errorCode = code(details.code) ?? code(field('errorCode', 'error_code'));
  const reason = code(details.reason);
  const status =
    typeof c.status === 'number' &&
    Number.isInteger(c.status) &&
    c.status >= 100 &&
    c.status <= 599
      ? c.status
      : undefined;
  const requestId = record.requestId ?? code(object(c.headers)['x-request-id']);
  const orderId = string(field('orderId', 'order_id', 'orderNumber', 'order_number'));
  const workflow = string(
    field('workflow', 'workflowName', 'workflow_name', 'operation'),
  );
  const nativeId = record.raw['_id'];
  return incidentEventSchema.parse({
    source: 'elasticsearch',
    eventId:
      typeof nativeId === 'string'
        ? `${record.index}:${nativeId}`
        : digest([record.index, record.timestamp, record.message, c]),
    incidentId:
      orderId ??
      record.traceId ??
      requestId ??
      record.eventCode ??
      digest(record.message),
    fingerprint: [record.eventCode ?? digest(record.message), errorCode, reason, status]
      .filter((v) => v !== undefined)
      .join(':'),
    occurredAt: record.timestamp,
    hint: `${record.eventCode ?? ''} ${record.message}${errorCode || reason || status ? ` [${[status && `HTTP ${status}`, errorCode, reason].filter(Boolean).join('; ')}]` : ''}`
      .trim()
      .slice(0, 2000),
    environment,
    service: record.service,
    severity: /exhaust|fatal/i.test(record.message) ? 'critical' : record.level,
    state: 'active',
    orderId,
    workflow,
    correlationId:
      string(field('correlationId', 'correlation_id')) ?? record.traceId ?? requestId,
    errorCode: errorCode ?? record.eventCode,
  });
}

export async function pollProject(
  p: WatchProject,
  workerId: string,
  limits: ServiceConfig,
): Promise<void> {
  const route = routeKey(p);
  const config = await loadConfig(p.config, { cwd: p.root });
  const env = resolveEnvironment(config, {
    project: p.project,
    env: p.environment,
    cwd: p.root,
  });
  if (resolve(env.path) !== resolve(p.root))
    throw new Error('Configured project root mismatch');
  const ctx = memorySyncContext(p.root, p.project, AbortSignal.timeout(15_000));
  if (!ctx)
    throw new Error(
      'Sign-in required and Cloud project link required for unattended reports',
    );
  const savedScope = await withDb((db) => readWatchState<string>(db, `scope:${route}`));
  if (savedScope && savedScope !== ctx.scope)
    throw new Error(
      'Cloud account or project changed; drain or explicitly migrate this watcher profile',
    );
  await withDb((db) => writeWatchState(db, `scope:${route}`, ctx.scope));
  const usage = await withDb((db) =>
    readWatchState<{ investigations: number; modelCalls: number }>(
      db,
      `budget:${new Date().toISOString().slice(0, 10)}`,
    ),
  );
  const exhausted =
    usage &&
    (usage.investigations >= limits.dailyInvestigations ||
      usage.modelCalls >= limits.dailyModelCalls);
  await ctx.client
    .workerHeartbeat(ctx.config.workspace!.id, {
      projectId: ctx.config.project!.id,
      environment: p.environment,
      workerId,
      state: exhausted ? 'budget-exhausted' : 'idle',
    })
    .catch((error) => {
      if (p.source === 'pagerduty') throw error;
      log(`Cloud offline; local detection continues: ${redactErrorMessage(error)}`);
    });
  const active = await withDb((db) => jobs(db, route));
  if (active.filter((j) => !['done', 'cancelled'].includes(j.status)).length >= 500)
    throw new Error('Queue cap 500 reached; cursor retained, backlog deferred');
  if (p.source === 'pagerduty') {
    // Claim only what this single executor can start now. Other requests remain durable in Cloud.
    if (active.some((j) => !['done', 'cancelled', 'terminal-failed'].includes(j.status)))
      return;
    const requests = await ctx.client.listAlertRequests(
      ctx.config.workspace!.id,
      ctx.config.project!.id,
      p.environment,
    );
    await withDb((db) =>
      writeWatchState(db, `health:${route}`, {
        lastSuccess: new Date().toISOString(),
        failures: 0,
        cloudPending: requests.length,
      }),
    );
    const request = requests[0];
    if (!request) return;
    const event = incidentEventSchema.parse({
      ...request.payload,
      hint: request.hint,
      state: request.payload.state === 'resolved' ? 'resolved' : 'active',
    });
    if (
      event.environment !== p.environment ||
      request.projectId !== ctx.config.project!.id
    )
      throw new Error('Cloud event route mismatch');
    const claim = await ctx.client.alertRequest(
      ctx.config.workspace!.id,
      request.id,
      'claim',
      { projectId: ctx.config.project!.id, environment: p.environment, workerId },
    );
    await withDb((db) =>
      acceptEvents(db, route, [event], undefined, {
        requestId: request.id,
        reportId: claim.localReportId,
        claimToken: claim.claimToken,
        workerId,
      }),
    );
    return;
  }
  const source =
    p.source === 'auto' ? (env.connectors.sentry ? 'sentry' : 'elasticsearch') : p.source;
  const cursor = await withDb((db) => readWatchState<string>(db, `cursor:${route}`));
  const now = Date.now();
  const start = cursor ? Date.parse(cursor) - 120_000 : now - 86400_000;
  // Source windows advance durably with overlap; long offline gaps remain visible while catching up.
  let end = Math.min(now, (cursor ? Date.parse(cursor) : start) + 3600_000);
  let events: IncidentEvent[];
  if (source === 'sentry') {
    const sentry = sentryForEnv(env);
    if (!sentry) throw new Error('Sentry unconfigured or credentials missing');
    const key = `page:${route}`;
    const pageState = await withDb((db) =>
      readWatchState<{ from: string; to: string; cursor: string }>(db, key),
    );
    const from = pageState?.from ?? new Date(start).toISOString();
    const to = pageState?.to ?? new Date(end).toISOString();
    const page = await sentry.watchIssues(from, to, p.environment, pageState?.cursor);
    events = page.issues.map((issue) => sentryEvent(issue, p.environment));
    // lastSeen does not change when an issue is resolved. Reconcile known open issues separately.
    const unresolved = active.filter((j) => j.event.source === 'sentry' && !j.resolvedAt);
    const offset =
      (await withDb((db) => readWatchState<number>(db, `reconcile:${route}`))) ?? 0;
    const ids = unresolved.slice(offset, offset + 5).map((j) => j.event.incidentId);
    const updates = await Promise.all(ids.map((id) => sentry.watchIssue(id)));
    events.push(...updates.map((issue) => sentryEvent(issue, p.environment)));
    await withDb((db) =>
      writeWatchState(
        db,
        `reconcile:${route}`,
        offset + 5 >= unresolved.length ? 0 : offset + 5,
      ),
    );

    await withDb(async (db) =>
      db.transaction(async (tx) => {
        const d = tx as unknown as HorusDb;
        await acceptEvents(d, route, events, page.nextCursor ? undefined : to);
        await writeWatchState(
          d,
          key,
          page.nextCursor ? { from, to, cursor: page.nextCursor } : null,
        );
      }),
    );
  } else {
    const logs = logsForEnv(env);
    if (!logs) throw new Error('Elasticsearch unconfigured or credentials missing');
    let records: LogRecord[];
    for (;;) {
      records = await logs.searchLogs({
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        level: 'error',
        service: env.connectors.elasticsearch?.serviceName,
        limit: 1000,
      });
      if (records.length < 1000) break;
      if (end - start <= 1000 || (cursor && end <= Date.parse(cursor)))
        throw new Error(
          'Elasticsearch window exceeds 1000 events/second; cursor retained, refine service filter',
        );
      end = Math.floor((start + end) / 2);
    }
    events = records.map((record) => elasticEvent(record, p.environment));
    await withDb((db) => acceptEvents(db, route, events, new Date(end).toISOString()));
  }
  await withDb((db) =>
    writeWatchState(db, `health:${route}`, {
      lastSuccess: new Date().toISOString(),
      failures: 0,
      backlogPolicy:
        'Previous 24h, ten immediate bootstrap jobs; remaining work stays queued',
      gap:
        cursor && now - Date.parse(cursor) > 86400_000
          ? 'Offline over 24h: upstream retention must be verified; catch-up may be incomplete'
          : null,
    }),
  );
}

export async function runServiceWorker(settings: string, jobId: string): Promise<void> {
  const config = readServiceConfig(settings);
  Object.assign(process.env, config.environment);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const controller = new AbortController();
  let termination: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    controller.abort();
    termination ??= setTimeout(() => process.exit(124), 2000);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const deadline = Date.now() + config.deadlineSeconds * 1000;
  const timer = setTimeout(stop, config.deadlineSeconds * 1000);
  let context: Awaited<ReturnType<typeof buildInvestigationContext>> | undefined;
  let job: WatchJobData | undefined;
  let previousAttempts: WatchJobData['attempts'] = {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let localWorkerId = `local-${process.ppid}`;
  try {
    job = await withDb(async (db) => (await jobs(db)).find((j) => j.id === jobId));
    if (!job) throw new Error('Unknown watcher job');
    previousAttempts = { ...job.attempts };
    localWorkerId =
      (await withDb((db) => readWatchState<string>(db, 'worker:id'))) ??
      `local-${process.ppid}`;
    const p = config.projects.find((p) => routeKey(p) === job!.route && p.enabled);
    if (!p) throw new Error('Job project disabled or missing');
    const loaded = await loadConfig(p.config, { cwd: p.root });
    const env = resolveEnvironment(loaded, {
      project: p.project,
      env: p.environment,
      cwd: p.root,
    });
    if (p.notifications === 'configured' && !env.notify?.webhook)
      throw new Error(
        'Notification webhook missing; configure a destination or select notifications: off',
      );
    const cloud = memorySyncContext(p.root, p.project, controller.signal);
    if (!cloud) throw new Error('Sign in and link Cloud before running this job');
    const storedScope = await withDb((db) =>
      readWatchState<string>(db, `scope:${job!.route}`),
    );
    if (storedScope !== cloud.scope)
      throw new Error('Watcher account/project scope mismatch');
    const claimBody = () => ({
      projectId: cloud.config.project!.id,
      environment: p.environment,
      ...job!.cloudRequest,
    });
    const beat = async () => {
      if (job!.cloudRequest)
        await cloud.client.alertRequest(
          cloud.config.workspace!.id,
          job!.cloudRequest.id,
          'heartbeat',
          claimBody(),
        );
      await cloud.client.workerHeartbeat(cloud.config.workspace!.id, {
        projectId: cloud.config.project!.id,
        environment: p.environment,
        workerId: job!.cloudRequest?.workerId ?? localWorkerId,
        state: 'running',
      });
    };
    if (job.cloudRequest && job.stage !== 'complete') {
      try {
        await beat();
      } catch {
        const claim = await cloud.client.alertRequest(
          cloud.config.workspace!.id,
          job.cloudRequest.id,
          'claim',
          {
            projectId: cloud.config.project!.id,
            environment: p.environment,
            workerId: job.cloudRequest.workerId,
          },
        );
        job.cloudRequest.claimToken = claim.claimToken;
        await withDb((db) => saveJob(db, job!));
      }
    }
    heartbeat = setInterval(() => {
      void beat().catch(stop);
    }, 25_000);
    // No source host auto-start or re-index in the unattended path.
    context = await buildInvestigationContext(env, {
      databaseUrl: loaded.database.url,
      unattended: true,
      log,
    });
    const db = context.dbHandle.db;
    job.status = 'running';
    job.pid = process.pid;
    await saveJob(db, job);
    const day = new Date().toISOString().slice(0, 10);
    const budget = (await readWatchState<{ investigations: number; modelCalls: number }>(
      db,
      `budget:${day}`,
    )) ?? { investigations: 0, modelCalls: 0 };
    const save = async () => {
      if (controller.signal.aborted) throw new Error('Job cancelled or claim lost');
      await saveJob(db, job!);
      // The supervisor alone writes status.json; IPC avoids a second PGlite reader or file writer.
      if (process.connected)
        process.send?.({ jobId: job!.id, stage: job!.stage }, () => {});
    };
    const remaining = () => Math.max(1, deadline - Date.now());
    let [saved] = await db
      .select()
      .from(investigations)
      .where(eq(investigations.id, job.reportId));
    let report = saved?.report as InvestigationReport | undefined;
    if (job.stage === 'engine') {
      if (!report) {
        if (budget.investigations >= config.dailyInvestigations)
          throw new Error(
            'DAILY_BUDGET: investigations exhausted; deferred until UTC tomorrow',
          );
        budget.investigations++;
        await writeWatchState(db, `budget:${day}`, budget);
        job.attempts.engine = (job.attempts.engine ?? 0) + 1;
        await save();
        report = await runOneInvestigation(
          {
            reportId: job.reportId,
            hint: job.event.hint,
            incident: job.event,
            service: job.event.service,
          },
          context,
          { timeoutMs: config.deadlineSeconds * 1000 + 60_000 },
        );
        if (!report.persisted) throw new Error('Engine report was not durably saved');
      }
      job.stage = 'ai';
      await save();
    }
    if (job.stage !== 'complete') {
      if (!report) throw new Error('Saved engine report is missing');
      if (job.stage === 'ai') {
        if (!job.ai && (job.attempts.ai ?? 0) < 3) {
          if (budget.modelCalls >= config.dailyModelCalls)
            throw new Error(
              'DAILY_BUDGET: model calls exhausted; deferred until UTC tomorrow',
            );
          budget.modelCalls++;
          await writeWatchState(db, `budget:${day}`, budget);
          job.attempts.ai = (job.attempts.ai ?? 0) + 1;
          await save();
          try {
            job.ai = await interpretIncident(
              config.claude,
              p.root,
              job.latestEvent ?? job.event,
              report,
              remaining(),
              controller.signal,
              true, // Keep Claude/tools in the worker group so supervisor cleanup survives SIGKILL.
            );
            job.aiFailure = undefined;
            // Persist inference before report annotation: recovery reuses the validated result.
            await save();
          } catch (error) {
            job.aiFailure = redactErrorMessage(error);
            if ((job.attempts.ai ?? 0) < 3) throw error;
          }
        }
        report = {
          ...report,
          unattended: job.ai
            ? { model: job.ai.model, sessionId: job.ai.sessionId, status: 'completed' }
            : {
                model: 'claude-opus-5-5',
                status: 'failed',
                error: job.aiFailure,
                engineOnly: true,
              },
        };
        if (job.ai) {
          const result = incidentResultSchema.parse(job.ai.result);
          report.aiJudgment = {
            what: result.summary,
            why: `${result.likelyCause ?? 'Cause uncertain'}. ${result.uncertainty}`,
            whereNext: result.nextChecks,
            citations: result.evidenceIds.map((evidenceId) => ({ evidenceId })),
            confidence: result.confidence,
            provider: 'local Claude Code / claude-opus-5-5',
            generatedAt: new Date().toISOString(),
          };
        }
        await db
          .update(investigations)
          .set({ report })
          .where(eq(investigations.id, job.reportId));
        job.stage = 'upload';
        await save();
      }
      if (job.stage === 'upload') {
        job.attempts.upload = (job.attempts.upload ?? 0) + 1;
        await save();
        const refs = await uploadInvestigationToCloud(
          cloud.client,
          cloud.config,
          report,
          {
            db,
          },
        );
        job.cloudReportId = refs.investigationId;
        job.cloudUrl = `${config.cloudWebUrl.replace(/\/$/, '')}/${[cloud.config.organization!.slug, cloud.config.workspace!.slug, cloud.config.project!.slug, 'investigations', refs.investigationId].map(encodeURIComponent).join('/')}`;
        const sync = await syncLinkedMemory(db, p.root, p.project);
        if (sync.state !== 'Synced')
          throw new Error(
            `Memory ${sync.state}: ${sync.error ?? `${sync.pending} pending`}`,
          );
        job.stage = 'notify';
        await save();
      }
      if (job.stage === 'notify') {
        if (!job.cloudUrl)
          throw new Error('Cloud report link missing; notification deferred');
        if (p.notifications === 'configured' && !job.notified) {
          if (!env.notify?.webhook && !env.notify?.cloud)
            throw new Error('Configured notification destination missing');
          job.attempts.notify = (job.attempts.notify ?? 0) + 1;
          // A previous uncertain send is inspectable; retry only if destination deduplicates keys.
          if (job.notificationKey && !p.idempotentDestination)
            throw new Error(
              'DELIVERY_UNKNOWN: inspect destination before service retry --delivery-checked',
            );
          job.notificationKey ??= `${job.id}:${digest([job.cloudReportId, (job.latestEvent ?? job.event).severity, (job.latestEvent ?? job.event).eventId, job.aiFailure])}`;
          await save();
          const ai = job.ai ? incidentResultSchema.parse(job.ai.result) : undefined;
          const cause = notificationCause(report, ai, Boolean(job.aiFailure));
          const result = await dispatchNotify(
            {
              id: report.id,
              confidence: ai?.confidence ?? report.confidence,
              hint: redactCloudValue(`${p.project}/${p.environment}${report.input.service ? ` / ${report.input.service}` : ''} [${(job.latestEvent ?? job.event).severity}]: ${(job.latestEvent ?? job.event).hint}`),
              cause,
              reportUrl: job.cloudUrl,
              notificationKey: job.notificationKey,
            },
            { ...env.notify!, minConfidence: 0 },
            { cloudPush: async () => {}, timeoutMs: Math.min(5000, remaining()) },
          );
          if (result.some((r) => !r.ok))
            throw new Error(
              `Notification failed: ${result
                .filter((r) => !r.ok)
                .map((r) => r.detail)
                .join('; ')}`,
            );
          job.notified = true;
        }
        job.stage = 'complete';
        await save();
      }
    }
    if (job.stage === 'complete') {
      if (job.cloudRequest) {
        const complete = () =>
          cloud.client.alertRequest(
            cloud.config.workspace!.id,
            job!.cloudRequest!.id,
            'complete',
            {
              ...claimBody(),
              investigationId: job!.cloudReportId,
              eventId: (job!.latestEvent ?? job!.event).eventId,
            },
          );
        try {
          await complete();
        } catch {
          const claim = await cloud.client.alertRequest(
            cloud.config.workspace!.id,
            job.cloudRequest.id,
            'claim',
            {
              projectId: cloud.config.project!.id,
              environment: p.environment,
              workerId: job.cloudRequest.workerId,
            },
          );
          job.cloudRequest.claimToken = claim.claimToken;
          await save();
          await complete();
        }
      }
      job.stage = 'done';
      job.status = 'done';
      job.error = undefined;
      job.pid = undefined;
      await save();
    }
  } catch (error) {
    if (job) {
      job.error = redactErrorMessage(error);
      job.pid = undefined;
      const budget = job.error.includes('DAILY_BUDGET');
      if (
        !budget &&
        (job.attempts[job.stage] ?? 0) === (previousAttempts[job.stage] ?? 0)
      )
        job.attempts[job.stage] = (job.attempts[job.stage] ?? 0) + 1;
      job.status =
        !budget &&
        ((job.attempts[job.stage] ?? 0) >= 5 || job.error.includes('DELIVERY_UNKNOWN'))
          ? 'terminal-failed'
          : 'retry-wait';
      job.nextAttemptAt = budget
        ? Date.parse(new Date(Date.now() + 86400_000).toISOString().slice(0, 10))
        : Date.now() +
          Math.max(
            error instanceof CloudError ? (error.retryAfterMs ?? 0) : 0,
            Math.min(3600_000, 30_000 * 2 ** (job.attempts[job.stage] ?? 0)),
          );
      if (context) await saveJob(context.dbHandle.db, job);
      else await withDb((db) => saveJob(db, job!));
      const p = config.projects.find((p) => routeKey(p) === job!.route);
      const cloud = p && memorySyncContext(p.root, p.project, AbortSignal.timeout(5000));
      if (cloud && p) {
        if (job.status === 'terminal-failed' && job.cloudRequest)
          await cloud.client
            .alertRequest(cloud.config.workspace!.id, job.cloudRequest.id, 'fail', {
              ...job.cloudRequest,
              projectId: cloud.config.project!.id,
              environment: p.environment,
              error: job.error.slice(0, 2000),
              terminal: true,
            })
            .catch(() => {});
        await cloud.client
          .workerHeartbeat(cloud.config.workspace!.id, {
            projectId: cloud.config.project!.id,
            environment: p.environment,
            workerId: job.cloudRequest?.workerId ?? localWorkerId,
            state: budget ? 'budget-exhausted' : 'degraded',
          })
          .catch(() => {});
      }
      if (
        (budget || job.status === 'terminal-failed') &&
        p?.notifications === 'configured' &&
        cloud
      ) {
        const key = budget
          ? `notice:budget:${new Date().toISOString().slice(0, 10)}`
          : `notice:terminal:${job.id}`;
        const noticeDb = context?.dbHandle.db;
        const recordNotice = async (db: HorusDb) => {
          if (await readWatchState(db, key)) return false;
          // Record the attempt before sending: a crash/uncertain response never creates a notice storm.
          await writeWatchState(db, key, {
            jobId: job!.id,
            at: new Date().toISOString(),
            state: 'sending',
          });
          return true;
        };
        const first = noticeDb
          ? await recordNotice(noticeDb)
          : await withDb(recordNotice);
        if (first) {
          const loaded = await loadConfig(p.config, { cwd: p.root });
          const env = resolveEnvironment(loaded, {
            project: p.project,
            env: p.environment,
            cwd: p.root,
          });
          const results = await dispatchNotify(
            {
              id: job.reportId,
              hint: redactCloudValue(`${p.project}/${p.environment}: ${budget ? 'Daily budget reached' : 'Investigation needs attention'}`),
              cause: `${job.error}. Inspect horus service status${budget ? '; work is deferred until UTC tomorrow' : `; retry job ${job.id} after fixing the cause`}`,
              confidence: 0,
              notificationKey: digest(key),
              reportUrl: `${config.cloudWebUrl}/${cloud.config.organization!.slug}/${cloud.config.workspace!.slug}/settings`,
            },
            env.notify ? { ...env.notify, minConfidence: 0 } : undefined,
            { cloudPush: async () => {} },
          );
          const persistNotice = (db: HorusDb) =>
            writeWatchState(db, key, {
              jobId: job!.id,
              at: new Date().toISOString(),
              results,
            });
          if (noticeDb) await persistNotice(noticeDb);
          else await withDb(persistNotice);
        }
      }
      log(`${job.id} ${job.stage}: ${job.error}`);
    } else throw error;
  } finally {
    clearTimeout(timer);
    if (termination) clearTimeout(termination);
    if (heartbeat) clearInterval(heartbeat);
    if (context) await disposeInvestigationContext(context);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

export async function runWatchService(settings: string, once = false): Promise<void> {
  let config = readServiceConfig(settings);
  Object.assign(process.env, config.environment);
  const home = serviceHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const release = await acquireDbLock(join(home, 'worker'), 100);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const workerId = await withDb(async (db) => {
      const id =
        (await readWatchState<string>(db, 'worker:id')) ?? `local-${randomUUID()}`;
      await writeWatchState(db, 'worker:id', id);
      return id;
    });
    do {
      config = readServiceConfig(settings);
      for (const p of config.projects.filter((p) => p.enabled)) {
        if (controller.signal.aborted) break;
        const route = routeKey(p);
        try {
          const health = await withDb((db) =>
            readWatchState<{ retryAt?: number; failures?: number }>(db, `health:${route}`),
          );
          if (!health?.retryAt || health.retryAt <= Date.now())
            await pollProject(p, workerId, config);
          else {
            // Source backoff must not make a live worker appear offline in Cloud.
            const cloud = memorySyncContext(p.root, p.project, AbortSignal.timeout(5000));
            const { scope, usage } = await withDb(async db => ({
              scope: await readWatchState<string>(db, `scope:${route}`),
              usage: await readWatchState<{ investigations: number; modelCalls: number }>(
                db, `budget:${new Date().toISOString().slice(0, 10)}`,
              ),
            }));
            if (cloud && scope === cloud.scope)
              await cloud.client.workerHeartbeat(cloud.config.workspace!.id, {
                projectId: cloud.config.project!.id,
                environment: p.environment,
                workerId,
                state: usage && (usage.investigations >= config.dailyInvestigations || usage.modelCalls >= config.dailyModelCalls)
                  ? 'budget-exhausted' : (health.failures ?? 0) >= 3 ? 'degraded' : 'idle',
              }).catch(error => log(`Cloud heartbeat: ${redactErrorMessage(error)}`));
          }
        } catch (error) {
          await withDb(async (db) => {
            const health = await readWatchState<{
              failures?: number;
              lastSuccess?: string;
            }>(db, `health:${route}`);
            const failures = (health?.failures ?? 0) + 1;
            await writeWatchState(db, `health:${route}`, {
              ...health,
              failures,
              error: redactErrorMessage(error),
              retryAt:
                Date.now() +
                Math.max(
                  error instanceof CloudError ? (error.retryAfterMs ?? 0) : 0,
                  Math.min(3600_000, 10_000 * 2 ** Math.min(failures, 8)),
                ),
            });
          });
          log(`${p.project}/${p.environment} source: ${redactErrorMessage(error)}`);
        }
        try {
          await withDb(async (db) => {
            const sync = await syncLinkedMemory(db, p.root, p.project);
            await writeWatchState(db, `sync:${route}`, sync);
          });
        } catch (error) {
          log(`${p.project} memory: ${redactErrorMessage(error)}`);
        }
        const pending = await withDb((db) => jobs(db, route));
        const job = pending.find(
          (j) =>
            !['done', 'cancelled', 'terminal-failed'].includes(j.status) &&
            j.nextAttemptAt <= Date.now(),
        );
        if (!job) continue;
        if (job.pid) {
          try {
            process.kill(job.pid, 0);
            log(`${job.id}: prior worker still alive; waiting`);
            continue;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
          }
        }
        const stamp = () => {
          const file = join(home, 'status.json');
          const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
          writeFileSync(
            join(home, 'status.tmp'),
            JSON.stringify({
              ...prior,
              at: new Date().toISOString(),
              pid: process.pid,
              activeJob: {
                id: job.id,
                project: p.project,
                environment: p.environment,
                stage: job.stage,
              },
            }),
            { mode: 0o600 },
          );
          renameSync(join(home, 'status.tmp'), file);
        };
        stamp();
        const statusTimer = setInterval(stamp, 25_000);
        try {
          await runProcess(
            config.runtime,
            [
              ...config.runtimeArgs,
              config.entry,
              'service',
              'worker',
              '--settings',
              settings,
              '--job',
              job.id,
            ],
            {
              cwd: p.root,
              timeoutMs: (config.deadlineSeconds + 5) * 1000,
              signal: controller.signal,
              onMessage: (message) => {
                const progress = message as {
                  jobId?: string;
                  stage?: WatchJobData['stage'];
                } | null;
                if (
                  progress?.jobId !== job.id ||
                  !progress.stage ||
                  !['engine', 'ai', 'upload', 'notify', 'complete', 'done'].includes(
                    progress.stage,
                  )
                )
                  return;
                job.stage = progress.stage;
                stamp();
              },
            },
          );
        } catch (error) {
          await withDb(async (db) => {
            const current = (await jobs(db, route)).find((j) => j.id === job.id)!;
            if (current.status === 'done') return;
            current.pid = undefined;
            current.error = redactErrorMessage(error);
            current.attempts[current.stage] = (current.attempts[current.stage] ?? 0) + 1;
            current.status =
              current.attempts[current.stage]! >= 5 ? 'terminal-failed' : 'retry-wait';
            current.nextAttemptAt = Date.now() + 60_000;
            await saveJob(db, current);
          });
        } finally {
          clearInterval(statusTimer);
        }
      }
      const snapshot = await withDb(async (db) => ({
        budget: await readWatchState(
          db,
          `budget:${new Date().toISOString().slice(0, 10)}`,
        ),
        activeJob: null,
        at: new Date().toISOString(),
        pid: process.pid,
        database: localDbPath(),
        projects: await Promise.all(
          config.projects.map(async (p) => ({
            project: p.project,
            environment: p.environment,
            enabled: p.enabled,
            health: await readWatchState(db, `health:${routeKey(p)}`),
            sync: await readWatchState(db, `sync:${routeKey(p)}`),
            jobs: await jobs(db, routeKey(p)),
          })),
        ),
      }));
      writeFileSync(
        join(home, 'status.tmp'),
        JSON.stringify(redactCloudValue(snapshot)),
        { mode: 0o600 },
      );
      renameSync(join(home, 'status.tmp'), join(home, 'status.json'));
      if (once || controller.signal.aborted) break;
      await new Promise<void>((r) => {
        const timer = setTimeout(done, config.intervalSeconds * 1000);
        function done() {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          r();
        }
        controller.signal.addEventListener('abort', done, { once: true });
      });
    } while (!controller.signal.aborted);
  } finally {
    release();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
