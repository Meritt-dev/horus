/** Run explicitly against a disposable Cloud test database; never reads the user's Horus profile. */
import assert from 'node:assert/strict';
import { CLAUDE_ARGS } from '../packages/cli/src/lib/claude-investigation.js';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import {
  runWatchService,
  pollProject,
  serviceConfigSchema,
  routeKey,
} from '../packages/cli/src/lib/watch-service.js';
import {
  jobs,
  saveJob,
  readWatchState,
  acceptEvents,
  incidentEventSchema,
} from '../packages/cli/src/lib/watch-store.js';
import { writeAuth } from '../packages/cli/src/lib/cloud/auth-store.js';
import { writeCloudConfig } from '../packages/cli/src/lib/cloud/context-store.js';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalDb, investigations, eq } from '../packages/db/src/index.js';

const url = process.env.HORUS_CLOUD_TEST_DATABASE_URL;
assert(url, 'Set HORUS_CLOUD_TEST_DATABASE_URL to a disposable, migrated local database');
assert(['localhost', '127.0.0.1'].includes(new URL(url).hostname));
assert(new URL(url).pathname.endsWith('_test'), 'Database name must end in _test');
process.env.HORUS_CLOUD_DATABASE_URL = url;
const cloudRoot = resolve(process.env.HORUS_CLOUD_REPO ?? '../horus-cloud');
const cloudImport = (path: string) => import(pathToFileURL(join(cloudRoot, path)).href);
const {
  createDatabase,
  cliTokens,
  investigationRequests,
  organizations,
  users,
  notificationTargets,
} = await cloudImport('packages/db/src/index.ts');
const { seedTenant } = await cloudImport('packages/core/src/test-helpers.ts');
const { buildServer } = await cloudImport('apps/api/src/server.ts');
const { generateCliToken } = await cloudImport('apps/api/src/auth/tokens.ts');
const db = createDatabase(url);
const tenant = await seedTenant(db, 'service-contract');
const token = generateCliToken();
await db.insert(cliTokens).values({
  userId: tenant.userId,
  name: 'isolated contract test',
  tokenHash: token.hash,
  tokenPrefix: token.prefix,
});
process.env.LOG_LEVEL = 'silent';
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;

const dir = await mkdtemp(join(tmpdir(), 'horus-service-contract-'));
const originalEnv = { ...process.env };
process.env.LENS_DASHBOARD_ORIGIN = base;
const originalFetch = globalThis.fetch;
let slackCalls = 0;
let budgetNotices = 0;
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://slack.com/api/')) {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.channel, 'C123');
    if (body.blocks[0].text.text === 'Horus daily budget reached') {
      budgetNotices++;
      assert(body.blocks.at(-1).elements[0].url.endsWith('/settings'));
      assert(body.text.includes('work remains queued'));
    } else if (body.blocks[0].text.text === 'Horus investigation needs attention') {
      assert(body.blocks.at(-1).elements[0].url.endsWith('/settings'));
      assert(body.text.includes('Investigation needs attention'));
    } else {
      assert(body.text.includes('uncertain') || body.text.includes('attention'));
      assert(body.blocks.at(-1).elements[0].url.includes('/investigations/'));
    }
    slackCalls++;
    return new Response(JSON.stringify({ ok: true, ts: '123.456' }));
  }
  return originalFetch(input, init);
};
await db
  .insert(notificationTargets)
  .values({
    organizationId: tenant.orgId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
    type: 'slack',
    name: 'Project app reports',
    oauth: { accessToken: 'fixture-bot-token' },
    config: { channelId: 'C123' },
    enabled: true,
    minConfidence: 0,
  });
const deliveries = new Set<string>();
const deliveryTexts: string[] = [];
let sends = 0;
let duringFirstDelivery: (() => Promise<void>) | undefined;
const sink = createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  assert.equal(
    req.headers['x-horus-signature'],
    `sha256=${createHmac('sha256', 'test-destination-secret').update(raw).digest('hex')}`,
  );
  const value = JSON.parse(raw);
  assert(value.reportUrl);
  assert(
    value.text.includes('uncertain') ||
      value.text.includes('Daily budget reached') ||
      value.text.includes('Investigation needs attention'),
  );
  deliveries.add(String(req.headers['idempotency-key']));
  deliveryTexts.push(value.text);
  sends++;
  if (sends === 1) await duringFirstDelivery?.();
  res.statusCode = sends === 1 ? 503 : 200;
  res.end('recorded');
});
await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
try {
  process.env.HORUS_HOME = join(dir, 'profile');
  process.env.HORUS_DB_DIR = join(dir, 'profile');
  process.env.HORUS_SERVICE_DIR = join(dir, 'profile');
  await mkdir(join(dir, 'repo'), { recursive: true });
  const root = join(dir, 'repo');
  writeAuth({
    apiBaseUrl: base,
    token: token.plaintext,
    account: { userId: tenant.userId, email: 'service-test@example.invalid' },
  });
  const cloudConfig = {
    context: 'cloud' as const,
    organization: { id: tenant.orgId, slug: 'org' },
    workspace: { id: tenant.workspaceId, slug: 'ws' },
    project: { id: tenant.projectId, slug: 'project' },
  };
  writeCloudConfig(root, cloudConfig);
  const fakeClaude = join(dir, 'claude');
  const calls = join(dir, 'calls');
  await writeFile(
    fakeClaude,
    `#!${process.execPath}
const fs=require('fs');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',async()=>{
const deadline=Date.now()+2000;let stage;while(Date.now()<deadline){stage=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'profile/service/status.json'))},'utf8')).activeJob?.stage;if(stage==='ai')break;await new Promise(r=>setTimeout(r,20));}if(stage!=='ai')throw new Error('Service status did not reach AI stage while worker owned DB');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
const args=process.argv.slice(2);const session=args[args.indexOf('--session-id')+1];
const hooks=JSON.parse(args[args.indexOf('--settings')+1]).hooks;
for(const hook_event_name of ['SessionStart','PreToolUse','PostToolUse','Stop']){
 const r=require('child_process').spawnSync('/bin/sh',['-c',hooks[hook_event_name][0].hooks[0].command],{input:JSON.stringify({session_id:session,hook_event_name,tool_name:hook_event_name.includes('Tool')?'Bash':undefined,tool_input:{command:'DO NOT UPLOAD THIS SECRET'},tool_response:'DO NOT UPLOAD RAW OUTPUT'}),encoding:'utf8',timeout:5000});if(r.status!==0)throw new Error('Activity hook failed '+r.stderr);
}
let live=false;const liveDeadline=Date.now()+8000;
while(Date.now()<liveDeadline){const r=await fetch(${JSON.stringify(base + '/v1/workspaces/' + tenant.workspaceId + '/alert-workers')},{headers:{authorization:${JSON.stringify('Bearer ' + token.plaintext)}}});const rows=await r.json();live=r.ok&&rows.some(w=>w.activeJob?.stage==='ai'&&w.activity?.some(a=>a.action==='Bash'&&a.kind==='tool-start'));if(live)break;await new Promise(r=>setTimeout(r,200));}if(!live)throw new Error('No live AI tool activity reached Cloud before inference finished');
const {report}=JSON.parse(s.split('\\nDATA:\\n')[1]);
console.log(JSON.stringify({type:'result',is_error:false,session_id:session,modelUsage:{'claude-opus-5-5':{}},result:JSON.stringify({reportId:report.id,summary:'Cause uncertain',likelyCause:null,confidence:0,evidenceIds:[],historicalMemoryIds:[],nextChecks:['Check current reservation state'],uncertainty:'No current evidence'})}));});`,
    { mode: 0o700 },
  );
  const configPath = join(root, 'horus.config.mjs');
  await writeFile(
    configPath,
    'export default ' +
      JSON.stringify({
        database: { url: 'postgres://unused' },
        projects: [
          {
            name: 'service-project',
            repositories: [{ name: 'repo', path: root }],
            environments: [
              {
                name: 'production',
                connectors: {},
                notify: {
                  minConfidence: 0.9,
                  webhook: {
                    url: `http://127.0.0.1:${(sink.address() as { port: number }).port}`,
                    secret: 'test-destination-secret',
                  },
                },
              },
            ],
          },
        ],
      }),
  );
  const settings = join(dir, 'settings.json');
  const project = {
    root,
    config: configPath,
    project: 'service-project',
    environment: 'production',
    source: 'pagerduty',
    enabled: true,
    notifications: 'configured',
    idempotentDestination: true,
  };
  await writeFile(
    settings,
    JSON.stringify({
      claude: fakeClaude,
      runtime: process.execPath,
      runtimeArgs: [resolve('node_modules/tsx/dist/cli.mjs')],
      entry: resolve('apps/horus/src/index.ts'),
      dailyInvestigations: 10,
      dailyModelCalls: 10,
      deadlineSeconds: 90,
      cloudWebUrl: base,
      projects: [project],
    }),
  );
  const http = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const value = await res.json();
    assert(res.ok, JSON.stringify(value));
    return value;
  };
  const source = await http(`/v1/workspaces/${tenant.workspaceId}/alert-sources`, {
    name: 'PD replay',
    provider: 'pagerduty',
    serviceId: 'safqa',
    projectId: tenant.projectId,
    environment: 'production',
    signingSecret: 'test-pagerduty-signing-secret',
  });
  let raw = JSON.stringify({
    event: {
      id: 'delivery-1',
      event_type: 'incident.triggered',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'native-incident',
        title: 'EMODA dispatch retry exhausted',
        status: 'triggered',
        urgency: 'high',
        html_url: 'https://example.pagerduty.com/incidents/1',
        created_at: new Date().toISOString(),
        service: { id: 'safqa' },
      },
    },
  });
  const ingest = () =>
    fetch(`${base}/v1/alerts/${source.id}/pagerduty`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pagerduty-signature': `v1=${createHmac('sha256', source.signingSecret).update(raw).digest('hex')}`,
      },
      body: raw,
    });
  assert.equal((await ingest()).status, 202);
  assert.equal((await ingest()).status, 202);
  duringFirstDelivery = async () => {
    const update = JSON.parse(raw);
    update.event.id = 'severity-during-delivery';
    update.event.event_type = 'incident.priority_updated';
    update.event.data.urgency = 'low';
    // Distinct event on the same provider clock tick must survive the older completion.
    raw = JSON.stringify(update);
    assert.equal((await ingest()).status, 202);
  };
  await runWatchService(settings, true);
  let h = await createLocalDb();
  let queued = await jobs(h.db);
  assert.equal(
    queued.length,
    1,
    await readFile(join(dir, 'profile/service/service.log'), 'utf8').catch(() => ''),
  );
  assert.equal(queued[0]!.stage, 'notify', JSON.stringify(queued[0]));
  assert.equal(queued[0]!.status, 'retry-wait');
  assert(queued[0]!.ai);
  assert(queued[0]!.cloudReportId);
  const reportId = queued[0]!.reportId;
  queued[0]!.nextAttemptAt = 0;
  await saveJob(h.db, queued[0]!);
  await h.sql.end();
  await runWatchService(settings, true);
  h = await createLocalDb();
  queued = await jobs(h.db);
  assert.equal(queued[0]!.stage, 'done', JSON.stringify(queued[0]));
  assert.equal((await h.db.select().from(investigations)).length, 1);
  assert.equal(queued[0]!.reportId, reportId);
  assert.equal(
    slackCalls,
    1,
    'Cloud receipt prevents duplicate Slack send on notification retry',
  );
  const budget = await readWatchState<{ modelCalls: number; investigations: number }>(
    h.db,
    `budget:${new Date().toISOString().slice(0, 10)}`,
  );
  assert.equal(budget?.modelCalls, 1);
  assert.equal(budget?.investigations, 1);
  await h.sql.end();
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  const argv = JSON.parse((await readFile(calls, 'utf8')).trim().split('\n')[0]!);
  assert.deepEqual(argv.slice(0, CLAUDE_ARGS.length), CLAUDE_ARGS);
  assert(argv.includes('--session-id') && argv.includes('--settings'));
  const activityResponse = await fetch(
    `${base}/v1/workspaces/${tenant.workspaceId}/alert-workers`,
    { headers: { authorization: `Bearer ${token.plaintext}` } },
  );
  assert.equal(activityResponse.status, 200);
  const workerRows = await activityResponse.json();
  assert(
    workerRows.some((w: any) =>
      w.activity.some((a: any) => a.action === 'Bash' && a.kind === 'tool-start'),
    ),
  );
  assert(workerRows.some((w: any) => w.activity.some((a: any) => a.action === 'done')));
  assert(!JSON.stringify(workerRows).includes('DO NOT UPLOAD'));
  const runsResponse = await fetch(
    `${base}/v1/projects/${tenant.projectId}/investigations/${queued[0]!.cloudReportId}/agent-runs`,
    { headers: { authorization: `Bearer ${token.plaintext}` } },
  );
  assert.equal(runsResponse.status, 200);
  const completedRuns = await runsResponse.json();
  assert.equal(completedRuns[0].model, 'claude-opus-5-5');
  assert.equal(completedRuns[0].agent, 'Horus background worker');
  assert(Date.parse(completedRuns[0].endedAt) >= Date.parse(completedRuns[0].startedAt));
  const logsResponse = await fetch(
    `${base}/v1/projects/${tenant.projectId}/investigations/${queued[0]!.cloudReportId}/agent-runs/${completedRuns[0].id}/logs`,
    { headers: { authorization: `Bearer ${token.plaintext}` } },
  );
  assert.equal(logsResponse.status, 200);
  const runLogs = await logsResponse.json();
  assert.equal(runLogs.logsFormat, 'application/vnd.horus.activity+json');
  const timeline = JSON.parse(runLogs.logs);
  assert(
    timeline.events.some((a: any) => a.action === 'Bash' && a.kind === 'tool-start'),
  );
  assert(timeline.events.some((a: any) => a.action === 'complete'));
  assert(timeline.result.includes('Next check:'));
  assert(!runLogs.logs.includes('DO NOT UPLOAD'));
  assert.equal(
    completedRuns.length,
    1,
    'Early memory sync and final timeline keep one run',
  );
  assert.equal(deliveries.size, 1);
  assert.equal(sends, 2);
  const [cloudPending] = await db
    .select()
    .from(investigationRequests)
    .where(eq(investigationRequests.id, queued[0]!.cloudRequest!.id));
  assert.equal(
    cloudPending.status,
    'pending',
    'A newer native event must survive stale completion',
  );
  await runWatchService(settings, true);
  h = await createLocalDb();
  const updatedNative = (await jobs(h.db))[0]!;
  assert.equal(updatedNative.status, 'done');
  assert.equal(updatedNative.latestEvent?.severity, 'low');
  assert.equal(updatedNative.reportId, reportId);
  assert.equal((await h.db.select().from(investigations)).length, 1);
  await h.sql.end();
  const [cloudDone] = await db
    .select()
    .from(investigationRequests)
    .where(eq(investigationRequests.id, cloudPending.id));
  assert.equal(cloudDone.status, 'done');
  assert.equal(deliveries.size, 2);
  assert.equal(sends, 3);
  assert(deliveryTexts[0]!.includes('[high]'));
  assert(deliveryTexts[0]!.includes('Current evidence:'));
  assert(deliveryTexts[0]!.includes('Next:'));
  assert(deliveryTexts.at(-1)!.includes('[low]'));
  // Recover from the durable AI checkpoint before report annotation, with no new inference.
  h = await createLocalDb();
  const checkpoint = (await jobs(h.db))[0]!;
  checkpoint.stage = 'ai';
  checkpoint.status = 'pending';
  checkpoint.nextAttemptAt = 0;
  checkpoint.cloudRequest = undefined; // Exercise a locally detected job; the earlier Cloud claim is complete.
  await saveJob(h.db, checkpoint);
  const [annotated] = await h.db
    .select()
    .from(investigations)
    .where(eq(investigations.id, reportId));
  const initial = { ...(annotated!.report as any) };
  delete initial.aiJudgment;
  delete initial.unattended;
  await h.db
    .update(investigations)
    .set({ report: initial })
    .where(eq(investigations.id, reportId));
  await h.sql.end();
  await runWatchService(settings, true);
  h = await createLocalDb();
  assert.equal((await jobs(h.db))[0]!.stage, 'done');
  const [recovered] = await h.db
    .select()
    .from(investigations)
    .where(eq(investigations.id, reportId));
  assert.equal((recovered!.report as any).unattended.sessionId, checkpoint.ai!.sessionId);
  await h.sql.end();
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  assert.equal(sends, 3);
  // A daily model cap defers a saved engine report; repeated invalid AI cannot erase it.
  const serviceConfig = JSON.parse(await readFile(settings, 'utf8'));
  // Successful severity updates are new deliveries even to a non-idempotent destination.
  serviceConfig.projects[0].idempotentDestination = false;
  await writeFile(settings, JSON.stringify(serviceConfig));
  for (const [index, severity] of ['medium', checkpoint.event.severity].entries()) {
    h = await createLocalDb();
    await acceptEvents(h.db, checkpoint.route, [
      {
        ...checkpoint.event,
        eventId: `severity-change-${index}`,
        severity,
        occurredAt: new Date(
          Date.parse(checkpoint.event.occurredAt) + (index + 1) * 1000,
        ).toISOString(),
      },
    ]);
    await h.sql.end();
    await runWatchService(settings, true);
    h = await createLocalDb();
    const updated = (await jobs(h.db))[0]!;
    assert.equal(updated.status, 'done', JSON.stringify(updated));
    assert.equal(updated.reportId, reportId);
    assert.equal(updated.attempts.notify, 1);
    await h.sql.end();
  }
  assert.equal(
    deliveries.size,
    4,
    'Severity cycling must not reuse a prior delivery key',
  );
  assert.equal(sends, 5);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);
  serviceConfig.projects[0].idempotentDestination = true;
  serviceConfig.dailyModelCalls = 1;
  await writeFile(settings, JSON.stringify(serviceConfig));
  const nextEvent = JSON.parse(raw);
  nextEvent.event.id = 'delivery-2';
  nextEvent.event.data.id = 'native-incident-2';
  nextEvent.event.occurred_at = new Date().toISOString();
  raw = JSON.stringify(nextEvent);
  assert.equal((await ingest()).status, 202);
  await runWatchService(settings, true);
  h = await createLocalDb();
  const deferred = (await jobs(h.db)).find((j) => j.id !== queued[0]!.id)!;
  assert.equal(deferred.stage, 'ai');
  assert.match(deferred.error!, /DAILY_BUDGET/);
  assert.equal(deferred.notice?.state, 'done');
  assert.equal(budgetNotices, 1, 'Budget notice uses the selected Cloud app channel');
  assert.equal((await h.db.select().from(investigations)).length, 2);
  // Recover a local notice acknowledgement loss without rerunning analysis or posting twice.
  const priorAttempts = { ...deferred.attempts };
  deferred.notice!.state = 'pending';
  deferred.notice!.retryAt = 0;
  await saveJob(h.db, deferred);
  await h.sql.end();
  await runWatchService(settings, true);
  h = await createLocalDb();
  const recoveredNotice = (await jobs(h.db)).find(j => j.id === deferred.id)!;
  assert.equal(recoveredNotice.notice?.state, 'done');
  assert.deepEqual(recoveredNotice.attempts, priorAttempts);
  assert.equal(budgetNotices, 1, 'Cloud receipt suppresses a repeated operational send');
  Object.assign(deferred, recoveredNotice);
  deferred.nextAttemptAt = 0;
  await saveJob(h.db, deferred);
  await h.sql.end();
  serviceConfig.dailyModelCalls = 10;
  await writeFile(settings, JSON.stringify(serviceConfig));
  await writeFile(
    fakeClaude,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log('invalid model envelope'));`,
    { mode: 0o700 },
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await runWatchService(settings, true);
    h = await createLocalDb();
    const failed = (await jobs(h.db)).find((j) => j.id === deferred.id)!;
    if (attempt < 2) {
      assert.equal(failed.stage, 'ai');
      failed.nextAttemptAt = 0;
      await saveJob(h.db, failed);
    } else {
      assert.equal(failed.stage, 'done', JSON.stringify(failed));
      assert.equal(failed.attempts.ai, 3);
      const [saved] = await h.db
        .select()
        .from(investigations)
        .where(eq(investigations.id, failed.reportId));
      assert.equal((saved!.report as any).unattended.engineOnly, true);
    }
    await h.sql.end();
  }
  const cancelledEvent = JSON.parse(raw);
  cancelledEvent.event.data.id = 'resolved-before-start';
  cancelledEvent.event.id = 'resolved-before-start-trigger';
  raw = JSON.stringify(cancelledEvent);
  assert.equal((await ingest()).status, 202);
  cancelledEvent.event.id = 'resolved-before-start-resolve';
  cancelledEvent.event.event_type = 'incident.resolved';
  cancelledEvent.event.data.status = 'resolved';
  raw = JSON.stringify(cancelledEvent);
  assert.equal((await ingest()).status, 202);
  await runWatchService(settings, true);
  h = await createLocalDb();
  const cancelled = (await jobs(h.db)).find(
    (j) => j.event.incidentId === 'resolved-before-start',
  )!;
  assert.equal(cancelled.stage, 'done', JSON.stringify(cancelled));
  assert.equal(cancelled.attempts.engine, undefined);
  assert.equal((await h.db.select().from(investigations)).length, 2);
  await h.sql.end();
  // Exercise the actual routed API and local episode contract with separate native incidents.
  const nativeFetch = globalThis.fetch;
  const reason = 'One or more items do not have enough stock.';
  const details: Record<string, unknown> = {
    'order-initial': {
      context: { orderNumber: 4085, brandType: 'EMODA' },
      metadata: { operation: 'EMODACreateOrder' },
      message: reason,
    },
    'order-retry': {
      context: { workflow: 'SUPPLIER_DISPATCH_RETRY' },
      message: `Supplier dispatch retry attempt 1/3 failed for order #4085 (aggregate:EMODA): ${reason}`,
    },
    'order-exhausted': {
      context: { orderNumber: 4085, brandType: 'EMODA', lastError: reason },
      metadata: { operation: 'supplierDispatchRetryExhausted' },
    },
  };
  let apiUnauthorized = false;
  globalThis.fetch = async (input, init) => {
    const u = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (u.origin !== 'https://api.eu.pagerduty.com') return nativeFetch(input, init);
    if (apiUnauthorized) return new Response('', { status: 401 });
    const id = u.pathname.split('/').at(-1)!;
    return new Response(
      JSON.stringify(
        u.pathname.startsWith('/incidents/')
          ? {
              incident: { id, service: { id: 'safqa' }, first_trigger_log_entry: { id } },
            }
          : { log_entry: { channel: { details: details[id] } } },
      ),
    );
  };
  try {
    const groupedSource = await http(
      `/v1/workspaces/${tenant.workspaceId}/alert-sources`,
      {
        name: 'Native order details',
        provider: 'pagerduty',
        serviceId: 'safqa',
        projectId: tenant.projectId,
        environment: 'production',
        apiToken: 'fixture-read-only',
        apiRegion: 'eu',
        signingSecret: 'native-order-subscription-secret',
      },
    );
    process.env.HORUS_DB_DIR = join(dir, 'order-grouping-db');
    let groupedId: string | undefined;
    let localReportId: string | undefined;
    let groupedClaim: { localReportId: string; claimToken: string } | undefined;
    for (const [i, [id, at, state]] of [
      ['order-initial', '01:00', 'triggered'],
      ['order-initial', '01:01', 'resolved'],
      ['order-retry', '01:05', 'triggered'],
      ['order-retry', '01:06', 'resolved'],
      ['order-exhausted', '02:20', 'triggered'],
    ].entries()) {
      const body = JSON.stringify({
        event: {
          id: `native-order-${i}`,
          event_type: state === 'resolved' ? 'incident.resolved' : 'incident.triggered',
          occurred_at: `2026-09-27T${at}:00Z`,
          data: {
            id,
            incident_key: id,
            title: id,
            status: state,
            urgency: 'high',
            html_url: `https://example.pagerduty.com/incidents/${id}`,
            created_at: `2026-09-27T${id === 'order-initial' ? '01:00' : id === 'order-retry' ? '01:05' : '02:20'}:00Z`,
            service: { id: 'safqa' },
          },
        },
      });
      const response = await fetch(`${base}/v1/alerts/${groupedSource.id}/pagerduty`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pagerduty-signature': `v1=${createHmac('sha256', groupedSource.signingSecret).update(body).digest('hex')}`,
        },
        body,
      });
      const accepted = (await response.json()) as { id: string };
      assert.equal(response.status, 202, JSON.stringify(accepted));
      groupedId ??= accepted.id;
      assert.equal(accepted.id, groupedId);
      const [request] = await db
        .select()
        .from(investigationRequests)
        .where(eq(investigationRequests.id, groupedId));
      groupedClaim ??= await http(
        `/v1/workspaces/${tenant.workspaceId}/investigation-requests/${groupedId}/claim`,
        {
          projectId: tenant.projectId,
          environment: 'production',
          workerId: 'grouping-worker',
        },
      );
      localReportId ??= groupedClaim!.localReportId;
      assert.equal(request.localReportId, localReportId);
      h = await createLocalDb();
      const incident = incidentEventSchema.parse({
        ...request.payload,
        hint: request.hint,
        state: request.payload.state === 'resolved' ? 'resolved' : 'active',
      });
      await acceptEvents(h.db, 'native-order-route', [incident], undefined, {
        requestId: groupedId!,
        reportId: groupedClaim!.localReportId,
        claimToken: groupedClaim!.claimToken,
        workerId: 'grouping-worker',
      });
      const acceptedJobs = await jobs(h.db);
      assert.equal(acceptedJobs.length, 1);
      assert.equal(acceptedJobs[0]!.reportId, localReportId);
      if (i === 0) {
        acceptedJobs[0]!.attempts.engine = 1;
        acceptedJobs[0]!.stage = 'done';
        acceptedJobs[0]!.status = 'done';
        await saveJob(h.db, acceptedJobs[0]!);
      } else
        assert.notEqual(
          acceptedJobs[0]!.stage,
          'engine',
          'An unchanged explicit episode must reuse its saved checkpoint',
        );
      await h.sql.end();
    }
    // A failed details credential is visible without preventing claims of previously queued work.
    apiUnauthorized = true;
    const bad = JSON.parse(raw);
    bad.event.id = 'details-auth-failure';
    const body = JSON.stringify(bad);
    const failedIngress = await fetch(`${base}/v1/alerts/${groupedSource.id}/pagerduty`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pagerduty-signature': `v1=${createHmac('sha256', groupedSource.signingSecret).update(body).digest('hex')}`,
      },
      body,
    });
    assert.equal(failedIngress.status, 500);
    await db
      .update(investigationRequests)
      .set({ leaseUntil: new Date(0) })
      .where(eq(investigationRequests.id, groupedId!));
    process.env.HORUS_DB_DIR = join(dir, 'ingress-degraded-db');
    const liveLimits = serviceConfigSchema.parse(
      JSON.parse(await readFile(settings, 'utf8')),
    );
    const project = liveLimits.projects[0]!;
    await assert.rejects(
      pollProject(project, 'degraded-source-worker', liveLimits),
      /PagerDuty ingress degraded.*401/,
    );
    h = await createLocalDb();
    assert.equal((await jobs(h.db, routeKey(project)))[0]?.cloudRequest?.id, groupedId);
    await h.sql.end();
  } finally {
    globalThis.fetch = nativeFetch;
  }
  console.log(
    'PASS: native PagerDuty -> authenticated lease -> real worker process -> saved engine -> exact Claude argv via fake executable -> Cloud report/memory -> idempotent notification retry; an in-flight same-timestamp PagerDuty update survives completion with one report/model call; durable AI checkpoint recovery and acknowledged severity updates without repeated inference; budget deferral and three invalid-AI retries preserve engine-only fallback',
  );
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((r) => sink.close(() => r()));
  await app.close();
  await db.delete(organizations).where(eq(organizations.id, tenant.orgId));
  await db.delete(users).where(eq(users.id, tenant.userId));
  await db.$client.end();
  const { getDb } = await cloudImport('apps/api/src/db.ts');
  await getDb().$client.end();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR', 'LENS_DASHBOARD_ORIGIN']) {
    if (originalEnv[key]) process.env[key] = originalEnv[key];
    else delete process.env[key];
  }
  await rm(dir, { recursive: true, force: true });
}
