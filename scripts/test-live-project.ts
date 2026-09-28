/** Opt-in: live read-only ES evidence + real local Claude, writing only to a disposable local Cloud DB. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveEnvironment } from '../packages/core/src/index.js';
import { logsForEnv } from '../packages/connectors/src/index.js';
import { createLocalDb, investigations, eq } from '../packages/db/src/index.js';
import {
  createLocalMemoryStore,
  recallStartupIncidents,
} from '../packages/engine/src/index.js';
import {
  runWatchService,
  elasticEvent,
  routeKey,
} from '../packages/cli/src/lib/watch-service.js';
import {
  acceptEvents,
  jobs,
  writeWatchState,
} from '../packages/cli/src/lib/watch-store.js';
import { writeAuth } from '../packages/cli/src/lib/cloud/auth-store.js';
import { writeCloudConfig } from '../packages/cli/src/lib/cloud/context-store.js';
import { runService } from '../packages/cli/src/commands/service.js';
import {
  memorySyncContext,
  synchronizeMemory,
  restoreMemoryReport,
} from '../packages/cli/src/lib/cloud/memory-sync.js';

const url = process.env.HORUS_CLOUD_TEST_DATABASE_URL;
const inputConfig = process.env.HORUS_LIVE_CONFIG;
const claude = process.env.HORUS_CLAUDE_BIN;
const launchd = process.env.HORUS_LIVE_LAUNCHD === '1';
assert(!launchd || process.platform === 'darwin', 'launchd requires macOS');
const profile = `live-test-${process.pid}`;
assert(
  url &&
    ['localhost', '127.0.0.1'].includes(new URL(url).hostname) &&
    new URL(url).pathname.endsWith('_test'),
  'Disposable localhost database ending _test required',
);
assert(inputConfig && isAbsolute(inputConfig), 'Absolute HORUS_LIVE_CONFIG required');
assert(
  claude && isAbsolute(claude),
  'Absolute HORUS_CLAUDE_BIN required; uses its existing user authentication',
);
const original = { ...process.env };
const loaded = await loadConfig(inputConfig);
const live = resolveEnvironment(loaded, { env: process.env.HORUS_LIVE_ENV });
assert(live.readOnly, 'Live environment must be read-only');
const logs = logsForEnv(live);
assert(logs, 'This live acceptance script needs an existing Elasticsearch connector');
const records = await logs.searchLogs({
  from: new Date(Date.now() - 7 * 86400_000).toISOString(),
  level: 'error',
  text: process.env.HORUS_LIVE_GREP ?? 'Reserve products API error details',
  broadText: true,
  limit: 1,
});
assert(
  records[0],
  'No matching live error; choose HORUS_LIVE_GREP without generating production traffic',
);
const event = elasticEvent(records[0], live.env);
process.env.HORUS_CLOUD_DATABASE_URL = url;
process.env.LOG_LEVEL = 'silent';
const cloudRoot = resolve(process.env.HORUS_CLOUD_REPO ?? '../horus-cloud');
const cloudImport = (p: string) => import(pathToFileURL(join(cloudRoot, p)).href);
const { createDatabase, cliTokens, organizations, users } = await cloudImport(
  'packages/db/src/index.ts',
);
const { seedTenant } = await cloudImport('packages/core/src/test-helpers.ts');
const { buildServer } = await cloudImport('apps/api/src/server.ts');
const { generateCliToken } = await cloudImport('apps/api/src/auth/tokens.ts');
const db = createDatabase(url);
const tenant = await seedTenant(db, 'live-project-check');
const token = generateCliToken();
await db.insert(cliTokens).values({
  userId: tenant.userId,
  name: 'local live acceptance',
  tokenHash: token.hash,
  tokenPrefix: token.prefix,
});
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const dir = await mkdtemp(join(tmpdir(), 'horus-live-worker-'));
const settings = join(dir, 'settings.json');
let installed = false;
try {
  const root = join(dir, 'repo');
  await mkdir(root, { mode: 0o700 });
  process.env.HORUS_HOME = join(dir, 'profile');
  process.env.HORUS_DB_DIR = join(dir, 'profile');
  process.env.HORUS_SERVICE_DIR = join(dir, 'profile');
  writeAuth({
    apiBaseUrl: base,
    token: token.plaintext,
    account: { userId: tenant.userId, email: 'local-test@example.invalid' },
  });
  writeCloudConfig(root, {
    context: 'cloud',
    organization: { id: tenant.orgId, slug: 'org' },
    workspace: { id: tenant.workspaceId, slug: 'ws' },
    project: { id: tenant.projectId, slug: 'project' },
  });
  // Private ephemeral config: preserve real read-only connectors, no production Cloud link or notification sink.
  const configPath = join(root, 'horus.config.mjs');
  await writeFile(
    configPath,
    'export default ' +
      JSON.stringify({
        projects: [
          {
            name: live.project,
            repositories: live.repositories.map((r) => ({
              name: r.name,
              path: root,
              ...(r.sourceHostUrl ? { source: { hostUrl: r.sourceHostUrl } } : {}),
            })),
            environments: [
              { name: live.env, readOnly: true, connectors: live.connectors },
            ],
          },
        ],
      }),
    { mode: 0o600 },
  );
  const project = {
    root,
    config: configPath,
    project: live.project,
    environment: live.env,
    source: 'pagerduty' as const,
    enabled: true,
    notifications: 'off' as const,
    idempotentDestination: false,
  };
  await writeFile(
    settings,
    JSON.stringify({
      claude,
      runtime: process.execPath,
      entry: resolve('apps/horus/dist/index.cjs'),
      dailyInvestigations: 1,
      dailyModelCalls: 1,
      deadlineSeconds: 600,
      cloudWebUrl: base,
      projects: [project],
    }),
    { mode: 0o600 },
  );
  const scope = memorySyncContext(root, live.project)!;
  assert(scope);
  let h = await createLocalDb();
  await writeWatchState(h.db, `scope:${routeKey(project)}`, scope.scope);
  await acceptEvents(h.db, routeKey(project), [event]);
  await h.sql.end();
  const startedAt = Date.now();
  let servicePid: number | undefined;
  if (launchd) {
    installed = true; // Also clean up a plist if bootstrap itself fails.
    await runService('install', { settings, profile, skipChecks: true });
    const deadline = Date.now() + 660_000;
    let completed = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      // Read the atomic snapshot; do not contend with the worker's PGlite owner.
      let snapshot;
      try {
        snapshot = JSON.parse(
          await readFile(join(dir, 'profile/service/status.json'), 'utf8'),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      servicePid = snapshot.pid;
      const current = snapshot.projects?.[0]?.jobs?.[0];
      if (snapshot.activeJob || !current) continue;
      assert.equal(
        current.stage,
        'done',
        JSON.stringify({ stage: current.stage, error: current.error }),
      );
      completed = true;
      break;
    }
    assert(completed, 'launchd did not finish the live job within 11 minutes');
    assert(
      servicePid && servicePid !== process.pid,
      'Expected an independent launchd process',
    );
    await runService('stop', { settings, profile });
  } else await runWatchService(settings, true);
  const elapsedMs = Date.now() - startedAt;
  h = await createLocalDb();
  const [job] = await jobs(h.db);
  try {
    assert.equal(
      job?.stage,
      'done',
      JSON.stringify({ stage: job?.stage, error: job?.error }),
    );
    assert.equal(job.ai?.model, 'claude-opus-5-5');
    assert(job.cloudReportId);
    const [saved] = await h.db
      .select()
      .from(investigations)
      .where(eq(investigations.id, job.reportId));
    const report = saved!.report as any;
    assert(report.evidence.length > 0);
    assert(report.aiJudgment.citations.length > 0);
    const second = await createLocalDb({ path: join(dir, 'clean-machine') });
    try {
      const clean = { ...scope, repo: live.project + '-clean' };
      const sync = await synchronizeMemory(second.db, clean, {
        deadline: Date.now() + 30000,
      });
      assert.equal(sync.state, 'Synced');
      const recall = await recallStartupIncidents(
        createLocalMemoryStore(second.db),
        { ...report.input, repo: clean.repo },
        { syncScope: scope.scope },
      );
      assert(recall.some((c) => Object.keys(c.reportRefs).includes(report.id)));
      assert(await restoreMemoryReport(second.db, clean, report.id));
      const summary = {
        project: live.project,
        environment: live.env,
        reportId: report.id,
        evidence: report.evidence.length,
        model: job.ai.model,
        citations: report.aiJudgment.citations.length,
        jobStage: job.stage,
        cloudReportSaved: true,
        cleanMachineRecall: recall.length,
        reportRestored: true,
        notifications: 'off',
        cloud: 'disposable localhost server',
        execution: launchd ? 'macOS launchd' : 'terminal service controller',
        servicePid,
        elapsedMs,
      };
      console.log(JSON.stringify(summary, null, 2));
      if (process.env.HORUS_LIVE_EVIDENCE_OUT)
        await writeFile(
          process.env.HORUS_LIVE_EVIDENCE_OUT,
          JSON.stringify(summary, null, 2),
          { mode: 0o600 },
        );
    } finally {
      await second.sql.end();
    }
  } finally {
    await h.sql.end();
  }
} finally {
  if (installed) await runService('remove', { settings, profile });
  try {
    await app.close();
    // Only this script's tenant; never truncate the shared test database.
    await db.delete(organizations).where(eq(organizations.id, tenant.orgId));
    await db.delete(users).where(eq(users.id, tenant.userId));
  } finally {
    // Always remove the private config, even when test-server cleanup fails.
    await rm(dir, { recursive: true, force: true });
    await db.$client.end();
    const { getDb } = await cloudImport('apps/api/src/db.ts');
    await getDb().$client.end();
    for (const key of [
      'HORUS_HOME',
      'HORUS_DB_DIR',
      'HORUS_SERVICE_DIR',
      'HORUS_CLOUD_DATABASE_URL',
      'LOG_LEVEL',
    ]) {
      if (original[key]) process.env[key] = original[key];
      else delete process.env[key];
    }
  }
}
