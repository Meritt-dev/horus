import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
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
  const beats: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options?: RequestInit) => {
    if (String(url).endsWith('/alert-workers') && options?.method === 'POST') {
      expect((options.headers as Record<string, string>).authorization).toBe('Bearer fixture');
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
it('normalizes actual ES fields without exporting raw payloads and groups workflow retries by order', () => {
  const record = {
    timestamp: '2026-09-27T01:00:00Z',
    level: 'error',
    levelValue: 50,
    message: 'supplier retry exhausted',
    index: 'logs',
    eventCode: 'DISPATCH_RETRY',
    service: 'safqa',
    context: { order_id: '42', workflow: 'supplierDispatch', password: 'secret' },
    raw: { large: 'do not retain' },
  } as import('@horus/connectors').LogRecord;
  const e = elasticEvent(record, 'production');
  expect(e.orderId).toBe('42');
  expect(e.workflow).toBe('supplierDispatch');
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
