import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalDb, acquireDbLock, type DbHandle } from '@horus/db';
import {
  acceptEvents,
  jobs,
  readWatchState,
  saveJob,
  writeWatchState,
  type IncidentEvent,
} from './watch-store.js';
import {
  CLAUDE_ARGS,
  runProcess,
  validateClaudeResult,
  interpretIncident,
} from './claude-investigation.js';
import { launchdPlist, runService } from '../commands/service.js';
import {
  serviceConfigSchema,
  elasticEvent,
  runWatchService,
  routeKey,
  pollProject,
} from './watch-service.js';
import { writeAuth } from './cloud/auth-store.js';
import { writeCloudConfig } from './cloud/context-store.js';
import { memorySyncContext } from './cloud/memory-sync.js';
import { normalizeHit } from '@horus/connectors';
import type { InvestigationReport } from '@horus/engine';
// Cold PGlite startup competes with the workspace suites on CI. Runtime budgets remain tested below.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const dirs: string[] = [];
const handles: DbHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.sql.end();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'horus-worker-'));
  dirs.push(p);
  return p;
};
const event = (extra: Partial<IncidentEvent> = {}): IncidentEvent => ({
  source: 'elasticsearch',
  eventId: 'initial',
  incidentId: 'dispatch',
  fingerprint: 'DISPATCH',
  hint: 'EMODA order dispatch failed',
  occurredAt: '2026-09-27T01:00:00Z',
  environment: 'production',
  state: 'active',
  severity: 'error',
  orderId: 'order-a',
  workflow: 'dispatch',
  ...extra,
});
it('retains the ES cursor and jobs after partial HTTP 200 results, then recovers once', async () => {
  const root = temp();
  vi.stubEnv('HORUS_HOME', join(root, 'profile'));
  vi.stubEnv('HORUS_DB_DIR', join(root, 'db'));
  writeAuth({
    apiBaseUrl: 'https://cloud.invalid',
    token: 'fixture',
    account: { userId: 'u', email: 'test@example.invalid' },
  });
  writeCloudConfig(root, {
    context: 'cloud',
    workspace: { id: 'w', slug: 'w' },
    project: { id: 'p', slug: 'p' },
  });
  const config = join(root, 'horus.config.mjs');
  writeFileSync(
    config,
    'export default ' +
      JSON.stringify({
        projects: [
          {
            name: 'p',
            repositories: [{ name: 'repo', path: root }],
            environments: [
              {
                name: 'production',
                connectors: {
                  elasticsearch: { url: 'https://es.invalid', indexPattern: 'logs' },
                },
              },
            ],
          },
        ],
      }),
  );
  const limits = serviceConfigSchema.parse({
    claude: '/usr/bin/true',
    runtime: process.execPath,
    entry: '/unused',
    dailyInvestigations: 1,
    dailyModelCalls: 1,
    projects: [
      {
        root,
        config,
        project: 'p',
        environment: 'production',
        source: 'elasticsearch',
        notifications: 'off',
      },
    ],
  });
  const p = limits.projects[0]!;
  const cursor = new Date(Date.now() - 3600_000).toISOString();
  const key = `cursor:${routeKey(p)}`;
  let h = await createLocalDb();
  await writeWatchState(h.db, key, cursor);
  await h.sql.end();
  let partial = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).startsWith('https://cloud.invalid/')) return new Response('{}');
      expect(String(url)).toBe('https://es.invalid/logs/_search');
      return new Response(
        JSON.stringify({
          timed_out: partial,
          _shards: { failed: partial ? 1 : 0 },
          hits: {
            hits: [
              {
                _id: 'event-1',
                _index: 'logs',
                _source: {
                  time: new Date(Date.now() - 60_000).toISOString(),
                  level: 50,
                  message: 'Dispatch failed',
                },
              },
            ],
          },
        }),
      );
    }),
  );
  await expect(pollProject(p, 'worker', limits)).rejects.toThrow('incomplete results');
  h = await createLocalDb();
  expect(await readWatchState(h.db, key)).toBe(cursor);
  expect(await jobs(h.db)).toHaveLength(0);
  await h.sql.end();
  partial = false;
  await pollProject(p, 'worker', limits);
  await pollProject(p, 'worker', limits);
  h = await createLocalDb();
  handles.push(h);
  expect(Date.parse((await readWatchState<string>(h.db, key))!)).toBeGreaterThan(
    Date.parse(cursor),
  );
  expect(await jobs(h.db)).toHaveLength(1);
}, 60_000);
it('keeps Cloud liveness during source backoff without clearing failure, budget or account scope', async () => {
  const root = temp();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR']) vi.stubEnv(key, root);
  writeAuth({ apiBaseUrl: 'https://cloud.invalid', token: 'fixture', account: { userId: 'u', email: 'test@example.invalid' } });
  writeCloudConfig(root, { context: 'cloud', workspace: { id: 'w', slug: 'w' }, project: { id: 'p', slug: 'p' } });
  const settings = join(root, 'settings.json');
  const config = serviceConfigSchema.parse({
    claude: '/usr/bin/true', runtime: process.execPath, entry: '/unused',
    dailyInvestigations: 1, dailyModelCalls: 1,
    projects: [{ root, config: join(root, 'unused.json'), project: 'p', environment: 'production', source: 'elasticsearch', notifications: 'off' }],
  });
  writeFileSync(settings, JSON.stringify(config));
  const route = routeKey(config.projects[0]!);
  const health = { failures: 3, error: 'source unavailable', retryAt: Date.now() + 3600_000 };
  let h = await createLocalDb();
  await writeWatchState(h.db, `health:${route}`, health);
  await writeWatchState(h.db, `scope:${route}`, memorySyncContext(root, 'p')!.scope);
  await h.sql.end();
  // Expire the short HTTP deadline at the next async boundary: DB startup must
  // happen before that clock starts, even when the local store is slow.
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    if (ms !== 5000) return realTimeout(ms);
    const deadline = new AbortController();
    setImmediate(() => deadline.abort(new Error('HTTP deadline elapsed')));
    return deadline.signal;
  });
  const beats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options?: RequestInit) => {
    if (String(url).endsWith('/alert-workers') && options?.method === 'POST') {
      expect((options.headers as Record<string, string>).authorization).toBe('Bearer fixture');
      expect(options.signal?.aborted).toBe(false);
      beats.push(JSON.parse(String(options.body)).state);
    }
    return new Response(JSON.stringify({ items: [], hasMore: false, nextRevision: '0' }));
  }));
  await runWatchService(settings, true);
  expect(beats).toEqual(['degraded']);
  h = await createLocalDb();
  expect(await readWatchState(h.db, `health:${route}`)).toEqual(health);
  await writeWatchState(h.db, `budget:${new Date().toISOString().slice(0, 10)}`, { investigations: 1, modelCalls: 0 });
  await h.sql.end();
  await runWatchService(settings, true);
  expect(beats).toEqual(['degraded', 'budget-exhausted']);
  writeAuth({ apiBaseUrl: 'https://cloud.invalid', token: 'fixture', account: { userId: 'other', email: 'other@example.invalid' } });
  await runWatchService(settings, true);
  expect(beats).toHaveLength(2);
}, 60_000);
it('supervisor crashes count only attempts the worker has not already journaled', async () => {
  const root = temp();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR']) vi.stubEnv(key, root);
  const worker = join(root, 'worker.mts');
  writeFileSync(worker, `
    import {createLocalDb} from ${JSON.stringify(new URL('../../../db/src/index.ts', import.meta.url).href)};
    import {jobs,saveJob} from ${JSON.stringify(new URL('./watch-store.ts', import.meta.url).href)};
    const h=await createLocalDb();const job=(await jobs(h.db))[0];
    job.attempts.ai=(job.attempts.ai??0)+1;await saveJob(h.db,job);
    await h.sql.end();process.exit(1);
  `);
  const settings = join(root, 'settings.json');
  const config = serviceConfigSchema.parse({
    claude: '/usr/bin/true', runtime: process.execPath,
    runtimeArgs: [resolve('../../node_modules/tsx/dist/cli.mjs')], entry: worker,
    deadlineSeconds: 10, dailyInvestigations: 1, dailyModelCalls: 1,
    projects: [{ root, config: join(root, 'unused.json'), project: 'p', environment: 'production', source: 'elasticsearch', notifications: 'off' }],
  });
  writeFileSync(settings, JSON.stringify(config));
  const route = routeKey(config.projects[0]!);
  let h = await createLocalDb();
  await writeWatchState(h.db, `health:${route}`, { retryAt: Date.now() + 3600_000 });
  await acceptEvents(h.db, route, [event()]);
  const job = (await jobs(h.db))[0]!;
  job.stage = 'ai';
  await saveJob(h.db, job);
  await h.sql.end();
  await runWatchService(settings, true);
  h = await createLocalDb();
  const failed = (await jobs(h.db))[0]!;
  expect(failed.attempts.ai).toBe(1);
  expect(failed.status).toBe('retry-wait');
  expect(failed.reportId).toBe(job.reportId);
  failed.nextAttemptAt = 0;
  await saveJob(h.db, failed);
  await h.sql.end();
  writeFileSync(worker, 'process.exit(1);');
  await runWatchService(settings, true);
  h = await createLocalDb();
  handles.push(h);
  expect((await jobs(h.db))[0]!.attempts.ai).toBe(2);
}, 60_000);
it('pause works during DB ownership, persists across service starts, and preserves queued work', async () => {
  const root = temp();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR'])
    vi.stubEnv(key, root);
  const settings = join(root, 'settings.json');
  const config = serviceConfigSchema.parse({
    claude: '/usr/bin/true',
    runtime: process.execPath,
    entry: '/unused',
    dailyInvestigations: 1,
    dailyModelCalls: 1,
    projects: [
      {
        root,
        config: join(root, 'unused.json'),
        project: 'p',
        environment: 'production',
        source: 'elasticsearch',
        notifications: 'off',
      },
    ],
  });
  writeFileSync(settings, JSON.stringify(config));
  const route = routeKey(config.projects[0]!);
  let h = await createLocalDb();
  await acceptEvents(h.db, route, [event()], 'saved-cursor');
  const before = await jobs(h.db);
  await expect(
    runService('pause', { settings, path: root, env: 'wrong' }),
  ).rejects.toThrow('Select exactly one');
  await runService('pause', { settings, path: root, env: 'production' });
  await h.sql.end();
  // The missing connector config makes accidental polling fail; a paused cycle must stay quiet.
  await runWatchService(settings, true);
  const snapshot = JSON.parse(readFileSync(join(root, 'service/status.json'), 'utf8'));
  expect(snapshot.projects[0].enabled).toBe(false);
  expect(snapshot.projects[0].health).toBeUndefined();
  h = await createLocalDb();
  handles.push(h);
  expect(await jobs(h.db)).toEqual(before);
  expect(await readWatchState(h.db, `cursor:${route}`)).toBe('saved-cursor');
  await runService('resume', { settings, path: root, env: 'production' });
  expect(JSON.parse(readFileSync(settings, 'utf8')).projects[0].enabled).toBe(true);
});
it('atomic event/cursor durability, EMODA retry grouping, changed severity, recurrence, separate orders', async () => {
  const root = temp();
  let h = await createLocalDb({ path: join(root, 'db') });
  await acceptEvents(
    h.db,
    'route',
    [
      event(),
      event({ eventId: 'retry1', occurredAt: '2026-09-27T01:01:00Z' }),
      event({ eventId: 'retry2', occurredAt: '2026-09-27T01:02:00Z' }),
      event({
        eventId: 'exhausted',
        occurredAt: '2026-09-27T01:03:00Z',
        severity: 'critical',
      }),
    ],
    '2026-09-27T01:04:00Z',
  );
  await h.sql.end();
  h = await createLocalDb({ path: join(root, 'db') });
  handles.push(h);
  expect(await readWatchState(h.db, 'cursor:route')).toBe('2026-09-27T01:04:00Z');
  expect(await jobs(h.db)).toHaveLength(1);
  const first = (await jobs(h.db))[0]!;
  expect(first.latestEvent?.severity).toBe('critical');
  await acceptEvents(h.db, 'route', [
    event(),
    event({ eventId: 'order-b', orderId: 'order-b' }),
  ]);
  expect(await jobs(h.db)).toHaveLength(2);
  await acceptEvents(h.db, 'route', [
    event({ eventId: 'resolved', state: 'resolved', occurredAt: '2026-09-27T01:05:00Z' }),
    event({ eventId: 'recurs', occurredAt: '2026-09-27T01:06:00Z' }),
  ]);
  expect(await jobs(h.db)).toHaveLength(3);
  const current = (await jobs(h.db)).at(-1)!;
  current.stage = 'upload';
  current.ai = { sessionId: 'session', model: 'claude-opus-5-5', result: {} };
  await saveJob(h.db, current);
  expect((await jobs(h.db)).at(-1)?.stage).toBe('upload');
  await expect(
    acceptEvents(
      h.db,
      'route',
      [event({ eventId: 'bad', occurredAt: 'bad' })],
      'bad-cursor',
    ),
  ).rejects.toThrow();
  expect(await readWatchState(h.db, 'cursor:route')).toBe('2026-09-27T01:04:00Z');
});
it('acknowledged severity updates get a fresh delivery checkpoint; uncertain sends retain theirs', async () => {
  const h = await createLocalDb({ path: join(temp(), 'db') });
  handles.push(h);
  await acceptEvents(h.db, 'route', [event()]);
  const job = (await jobs(h.db))[0]!;
  Object.assign(job, {
    stage: 'done',
    status: 'done',
    notified: true,
    notificationKey: 'acknowledged',
    nextAttemptAt: Date.now() + 60000,
  });
  job.attempts.notify = 4;
  await saveJob(h.db, job);
  await acceptEvents(h.db, 'route', [
    event({
      eventId: 'escalation',
      severity: 'critical',
      occurredAt: event().occurredAt, // Different native event, same source clock tick.
    }),
  ]);
  const updated = (await jobs(h.db))[0]!;
  expect(updated).toMatchObject({
    reportId: job.reportId,
    stage: 'notify',
    status: 'pending',
    notified: false,
    attempts: { notify: 0 },
    nextAttemptAt: 0,
  });
  expect(updated.notificationKey).toBeUndefined();
  Object.assign(updated, { status: 'retry-wait', notificationKey: 'uncertain' });
  await saveJob(h.db, updated);
  await acceptEvents(h.db, 'route', [
    event({
      eventId: 'another-delivery',
      severity: 'critical',
      occurredAt: '2026-09-27T01:02:00Z',
    }),
  ]);
  expect((await jobs(h.db))[0]!.notificationKey).toBe('uncertain');
});
it('live owner never expires or permits unlocked access; dead PID can recover', async () => {
  const path = join(temp(), 'db');
  const release = await acquireDbLock(path, 10);
  await expect(acquireDbLock(path, 10)).rejects.toThrow('HORUS_DB_BUSY');
  release();
  writeFileSync(`${path}.lock`, '2147483647 0');
  const recovered = await acquireDbLock(path, 200);
  recovered();
});
it('Claude exact argv/stdin, fresh result validation, timeout kills grandchildren', async () => {
  const root = temp();
  const file = join(root, 'fake.cjs');
  const received = join(root, 'received.json');
  writeFileSync(
    file,
    `let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(received)},JSON.stringify({args:process.argv.slice(2),input:s}));console.log('{}')});`,
  );
  await runProcess(process.execPath, [file, ...CLAUDE_ARGS], {
    cwd: root,
    input: 'untrusted $(touch nope)',
    timeoutMs: 2000,
  });
  expect(JSON.parse(readFileSync(received, 'utf8'))).toEqual({
    args: CLAUDE_ARGS,
    input: 'untrusted $(touch nope)',
  });
  const pidFile = join(root, 'child');
  writeFileSync(
    file,
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`,
  );
  await expect(
    runProcess(process.execPath, [file], { cwd: root, timeoutMs: 400 }),
  ).rejects.toThrow('deadline');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 100));
  expect(() => process.kill(pid, 0)).toThrow();
  const id = 'c2de50b7-267f-4b93-85c8-ef0b906c7b3e';
  const report = {
    id,
    evidence: [{ id: 'ev1' }],
    startupRecall: [{ memoryId: 'm1' }],
  } as unknown as InvestigationReport;
  const result = {
    reportId: id,
    summary: 'uncertain',
    likelyCause: null,
    confidence: 0,
    evidenceIds: ['ev1'],
    historicalMemoryIds: ['m1'],
    nextChecks: ['check current reservation'],
    uncertainty: 'No cause established',
  };
  const envelope = (v: unknown) =>
    JSON.stringify({
      type: 'result',
      is_error: false,
      session_id: 'fresh-session',
      result: JSON.stringify(v),
    });
  expect(validateClaudeResult(envelope(result), report).model).toBe('claude-opus-5-5');
  expect(() =>
    validateClaudeResult(envelope({ ...result, evidenceIds: ['invented'] }), report),
  ).toThrow(/unknown evidence/);
  expect(() => validateClaudeResult('invalid', report)).toThrow();
  // A real Opus run cited a similar investigation's report ID as a memory ID.
  const withoutRecall = {
    ...report,
    startupRecall: [],
    similarIncidents: [{ investigationId: 'previous-report' }],
  } as unknown as InvestigationReport;
  const noHistory = { ...result, historicalMemoryIds: [] };
  writeFileSync(
    file,
    `#!${process.execPath}\nlet s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(received)},s);console.log(${JSON.stringify(envelope(noHistory))})});`,
  );
  chmodSync(file, 0o700);
  await interpretIncident(file, root, event(), withoutRecall, 2000);
  const prompt = readFileSync(received, 'utf8');
  const allowed = JSON.parse(prompt.split('ALLOWED_CITATIONS:\n')[1]!.split('\nDATA:\n')[0]!);
  expect(allowed).toEqual({ evidenceIds: ['ev1'], historicalMemoryIds: [] });
  expect(prompt).toContain('report reference, not a memoryId');
  expect(() =>
    validateClaudeResult(
      envelope({ ...noHistory, historicalMemoryIds: ['previous-report'] }),
      withoutRecall,
    ),
  ).toThrow(/unknown evidence or memory/);
  writeFileSync(
    file,
    `console.log(JSON.stringify({type:'result',is_error:true,errors:['Not logged in; run claude auth login']}));process.exit(1);`,
  );
  await expect(
    runProcess(process.execPath, [file], { cwd: root, timeoutMs: 2000 }),
  ).rejects.toThrow('run claude auth login');
});
it('preserves the caller abort reason before spawn and while killing a running child', async () => {
  const root = temp();
  const file = join(root, 'waiting.cjs');
  const pidFile = join(root, 'pid');
  const reason = new Error('Investigation deadline exceeded');
  writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  await expect(runProcess(process.execPath, [file], {
    cwd: root, timeoutMs: 5000, signal: AbortSignal.abort(reason),
  })).rejects.toBe(reason);
  expect(existsSync(pidFile)).toBe(false);

  const controller = new AbortController();
  const running = runProcess(process.execPath, [file], {
    cwd: root, timeoutMs: 10000, signal: controller.signal,
  });
  const rejected = expect(running).rejects.toBe(reason);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort(reason);
    await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort(reason);
    await running.catch(() => {});
  }
});
it('launchd uses argument array and explicit auth paths; no shell or API key requirement', () => {
  const c = serviceConfigSchema.parse({
    claude: '/local/bin/claude',
    runtime: process.execPath,
    entry: '/app/horus.cjs',
    dailyInvestigations: 10,
    dailyModelCalls: 10,
    projects: [
      {
        root: '/project',
        config: '/project/config.ts',
        project: 'p',
        environment: 'prod',
        source: 'sentry',
        notifications: 'off',
      },
    ],
  });
  const xml = launchdPlist(c, '/tmp/a & b.json', 'test');
  expect(xml).toContain('ProgramArguments');
  expect(xml).toContain('a &amp; b.json');
  expect(xml).toContain('<key>HOME</key>');
  expect(xml).not.toContain('/bin/sh');
});
it('preserves native ES document identity independently of coincident payloads or source-supplied IDs', () => {
  const hit = { _index: 'logs', _id: 'native-a', _source: {
    time: '2026-09-27T01:00:00Z', level: 50, message: 'Fetch products error',
    event_code: 'EMODA_011_04', _id: 'source-spoof',
  } };
  const a = elasticEvent(normalizeHit(hit), 'production');
  const b = elasticEvent(normalizeHit({ ...hit, _id: 'native-b' }), 'production');
  expect(a.eventId).toBe('logs:native-a');
  expect(b.eventId).toBe('logs:native-b');
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(JSON.stringify(a)).not.toContain('source-spoof');
});
it('normalizes actual ES fields without exporting raw payloads and groups workflow retries by order', () => {
  const record = {
    timestamp: '2026-09-27T01:00:00Z',
    level: 'error',
    levelValue: 50,
    message: 'supplier retry exhausted',
    index: 'logs',
    eventCode: 'DISPATCH_RETRY',
    service: 'safqa',
    context: { order_id: '42', workflow: 'supplierDispatch', operation: 'reserve', password: 'secret' },
    raw: { large: 'do not retain' },
  } as import('@horus/connectors').LogRecord;
  const e = elasticEvent(record, 'production');
  expect(e.orderId).toBe('42');
  expect(e.workflow).toBe('supplierDispatch');
  expect(e.operation).toBe('reserve');
  expect(e.eventCode).toBe('DISPATCH_RETRY');
  expect(e.errorCode).toBeUndefined();
  expect(e.severity).toBe('critical');
  expect(JSON.stringify(e)).not.toContain('password');
  expect(JSON.stringify(e)).not.toContain('do not retain');
});
it('retains real supplier failure identity without conflating stock and indeterminate reserve responses', () => {
  const record = {
    timestamp: '2026-09-23T10:25:36.273Z',
    level: 'error',
    levelValue: 50,
    eventCode: 'EMODA_017D',
    message: 'Reserve products API error details',
    index: 'logs',
    raw: {},
    context: {
      status: 503,
      data: { details: { code: 'ETIMEDOUT', reason: 'indeterminate' } },
      headers: { 'x-request-id': 'request-a', authorization: 'secret' },
    },
  } as import('@horus/connectors').LogRecord;
  const reserve = elasticEvent(record, 'production');
  expect(reserve.errorCode).toBe('ETIMEDOUT');
  expect(reserve.eventCode).toBe('EMODA_017D');
  expect(reserve.hint).toContain('HTTP 503; ETIMEDOUT; indeterminate');
  expect(reserve.correlationId).toBe('request-a');
  const stock = elasticEvent(
    {
      ...record,
      context: { status: 400, data: { details: { reason: 'insufficient_stock' } } },
    },
    'production',
  );
  expect(stock.fingerprint).not.toBe(reserve.fingerprint);
  const otherOrder = elasticEvent(
    {
      ...record,
      context: { ...record.context, headers: { 'x-request-id': 'request-b' } },
    },
    'production',
  );
  expect(otherOrder.incidentId).not.toBe(reserve.incidentId);
  expect(JSON.stringify(reserve)).not.toContain('secret');
});

it('a hard-killed worker cannot leave Claude or its tools running', async () => {
  const root = temp();
  const pidFile = join(root, 'pids.json');
  const claude = join(root, 'claude.cjs');
  const worker = join(root, 'worker.mts');
  writeFileSync(
    claude,
    `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({claude:process.pid,tool:child.pid}));setInterval(()=>{},1000);`,
  );
  writeFileSync(
    worker,
    `import {existsSync} from 'node:fs';import {setTimeout as sleep} from 'node:timers/promises';import {runProcess} from ${JSON.stringify(new URL('./claude-investigation.ts', import.meta.url).href)};const running=runProcess(process.execPath,[${JSON.stringify(claude)}],{cwd:${JSON.stringify(root)},timeoutMs:30000,inheritProcessGroup:true});while(!existsSync(${JSON.stringify(pidFile)})) await sleep(20);process.kill(process.pid,'SIGKILL');await running;`,
  );
  try {
    await expect(
      runProcess(
        process.execPath,
        [resolve('../../node_modules/tsx/dist/cli.mjs'), worker],
        { cwd: root, timeoutMs: 15_000 },
      ),
    ).rejects.toThrow('Subprocess exited');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pids.claude, 0)).toThrow();
    expect(() => process.kill(pids.tool, 0)).toThrow();
  } finally {
    // Cleanup also runs when reproducing the pre-fix orphan: only the test's recorded group.
    try {
      const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      process.kill(-pids.claude, 'SIGKILL');
    } catch {}
  }
});

it('controller death closes worker IPC and terminates its detached group', async () => {
  const root = temp();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR']) vi.stubEnv(key, root);
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify(serviceConfigSchema.parse({
    claude: '/usr/bin/true', runtime: process.execPath, entry: '/unused',
    dailyInvestigations: 1, dailyModelCalls: 1,
    projects: [{ root, config: join(root, 'unused.json'), project: 'p', environment: 'production', source: 'elasticsearch', notifications: 'off' }],
  })));
  // Hold only this test's lock so the real worker stays at its first DB acquisition.
  const release = await acquireDbLock(join(root, 'horus.db'), 100);
  const pidFile = join(root, 'pids.json');
  const claude = join(root, 'claude.cjs');
  const worker = join(root, 'worker.mts');
  const supervisor = join(root, 'supervisor.mts');
  // Run in one PID/group like the bundled CLI; the tsx CLI wrapper masks controller death.
  const runtime = resolve('../../node_modules/tsx/dist/loader.mjs');
  writeFileSync(claude, `const tool=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({worker:Number(process.argv[2]),supervisor:Number(process.argv[3]),claude:process.pid,tool:tool.pid}));setInterval(()=>{},1000);`);
  writeFileSync(worker, `import {spawn} from 'node:child_process';import {runServiceWorker} from ${JSON.stringify(new URL('./watch-service.ts', import.meta.url).href)};spawn(process.execPath,[${JSON.stringify(claude)},String(process.pid),String(process.ppid)],{stdio:'ignore'});await runServiceWorker(${JSON.stringify(settings)},'fixture');`);
  writeFileSync(supervisor, `import {runProcess} from ${JSON.stringify(new URL('./claude-investigation.ts', import.meta.url).href)};await runProcess(process.execPath,['--import',${JSON.stringify(runtime)},${JSON.stringify(worker)}],{cwd:${JSON.stringify(root)},timeoutMs:30000,onMessage:()=>{}});`);
  const running = runProcess(process.execPath, ['--import', runtime, supervisor], { cwd: root, timeoutMs: 15000 });
  let pids: {worker: number; supervisor: number; claude: number; tool: number} | undefined;
  try {
    await vi.waitFor(() => { pids = JSON.parse(readFileSync(pidFile, 'utf8')); }, { timeout: 10000 });
    process.kill(pids!.supervisor, 'SIGKILL');
    await expect(running).rejects.toThrow('Subprocess exited');
    await vi.waitFor(() => {
      for (const pid of [pids!.worker, pids!.claude, pids!.tool])
        expect(() => process.kill(pid, 0)).toThrow();
    }, { timeout: 3000 });
  } finally {
    release();
    if (pids) {
      try { process.kill(-pids.worker, 'SIGKILL'); } catch {}
      try { process.kill(pids.supervisor, 'SIGKILL'); } catch {}
    }
    await running.catch(() => {});
  }
});

it('reuses an explicit Cloud episode through native child resolutions and starts an uninvestigated episode when active', async () => {
  const root = temp();
  vi.stubEnv('HORUS_DB_DIR', join(root, 'db'));
  const h = await createLocalDb();
  handles.push(h);
  const initial = event({
    source: 'pagerduty',
    episode: 'cloud-episode-a',
    eventId: 'resolved-first',
    state: 'resolved',
  });
  await acceptEvents(h.db, 'route', [initial]);
  expect((await jobs(h.db))[0]?.status).toBe('cancelled');
  await acceptEvents(h.db, 'route', [
    event({
      ...initial,
      eventId: 'retry-1',
      incidentId: 'native-retry',
      state: 'active',
      occurredAt: '2026-09-27T01:05:00Z',
    }),
  ]);
  const [active] = await jobs(h.db);
  if (!active) throw new Error('The active Cloud episode was not queued');
  expect(active.status).toBe('pending');
  expect(active.stage).toBe('engine');
  expect(active.resolvedAt).toBeUndefined();
  active.status = 'done';
  active.stage = 'done';
  active.attempts.engine = 1;
  await saveJob(h.db, active);
  await acceptEvents(h.db, 'route', [
    event({
      ...initial,
      eventId: 'retry-2',
      incidentId: 'different-native-id',
      state: 'active',
      occurredAt: '2026-09-27T01:20:00Z',
    }),
  ]);
  expect(await jobs(h.db)).toHaveLength(1);
  expect((await jobs(h.db))[0]?.reportId).toBe(active.reportId);
  expect((await jobs(h.db))[0]?.stage).toBe('done');
  await acceptEvents(h.db, 'route', [
    event({
      ...initial,
      episode: 'cloud-episode-b',
      eventId: 'new-occurrence',
      state: 'active',
      occurredAt: '2026-09-28T01:00:00Z',
    }),
  ]);
  expect(await jobs(h.db)).toHaveLength(2);
});
