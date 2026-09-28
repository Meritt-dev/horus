/** Run explicitly against a disposable Cloud test database; never reads the user's Horus profile. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import {
  routeKey,
  pollProject,
  serviceConfigSchema,
} from '../packages/cli/src/lib/watch-service.js';
import { jobs, saveJob, readWatchState } from '../packages/cli/src/lib/watch-store.js';
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
const { createDatabase, cliTokens } = await cloudImport('packages/db/src/index.ts');
const { seedTenant } = await cloudImport('packages/core/src/test-helpers.ts');
const { buildServer } = await cloudImport('apps/api/src/server.ts');
const { generateCliToken } = await cloudImport('apps/api/src/auth/tokens.ts');
const db = createDatabase(url);
const tenant = await seedTenant(db, 'service-contract');
const token = generateCliToken();
await db
  .insert(cliTokens)
  .values({
    userId: tenant.userId,
    name: 'isolated contract test',
    tokenHash: token.hash,
    tokenPrefix: token.prefix,
  });
process.env.LOG_LEVEL = 'silent';
const app = await buildServer();
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;

const dir = await mkdtemp(join(tmpdir(), 'horus-input-contract-'));
const savedEnv = { ...process.env };
let phase = 0;
let adapter = 'sentry';
const start = Date.now() - 86400_000;
const stamp = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const issue = (id: string, status = 'unresolved') => ({
  id,
  title: 'Dispatch failed',
  count: '1',
  lastSeen: phase === 3 && id === '1' ? stamp(150) : stamp(30),
  firstSeen: stamp(30),
  lastStatusChange:
    phase === 3 && id === '1'
      ? stamp(150)
      : status === 'resolved'
        ? stamp(90)
        : stamp(30),
  status,
  level: 'fatal',
  permalink: `https://sentry.example/issues/${id}`,
});
const source = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (adapter === 'sentry') {
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    if (req.url!.startsWith('/api/0/issues/')) {
      const id = req.url!.split('/')[4]!;
      res.end(
        JSON.stringify(issue(id, phase === 2 && id === '1' ? 'resolved' : 'unresolved')),
      );
      return;
    }
    const url = new URL(req.url!, 'http://localhost');
    assert(url.searchParams.get('query')?.includes('environment:"production"'));
    if (phase === 0) {
      res.setHeader(
        'link',
        '<http://localhost/>; rel="next"; results="true"; cursor="page-2"',
      );
      res.end(JSON.stringify([issue('1')]));
    } else if (phase === 1) {
      assert.equal(url.searchParams.get('cursor'), 'page-2');
      res.end(JSON.stringify([issue('2')]));
    } else res.end(JSON.stringify(phase === 3 ? [issue('1')] : []));
  } else {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert(JSON.parse(body).query);
    assert(req.headers.authorization);
    const hits = [
      ['initial', 'a', 'dispatch failed'],
      ['retry', 'a', 'dispatch retry'],
      ['exhaust', 'a', 'dispatch exhausted'],
      ['different', 'b', 'dispatch failed'],
    ].map(([id, order, message], i) => ({
      _id: id,
      _index: 'logs',
      _source: {
        time: stamp(30 + i),
        level: 50,
        message,
        service_name: 'safqa',
        event_code: 'DISPATCH',
        context: {
          order_id: order,
          workflow: 'supplierDispatch',
          password: 'never-export-this',
        },
      },
    }));
    res.end(JSON.stringify({ hits: { hits } }));
  }
});
await new Promise<void>((r) => source.listen(0, '127.0.0.1', r));
try {
  process.env.HORUS_HOME = join(dir, 'auth');
  writeAuth({
    apiBaseUrl: base,
    token: token.plaintext,
    account: { userId: tenant.userId, email: 'test@example.invalid' },
  });
  const providerUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  for (const kind of ['sentry', 'elasticsearch'] as const) {
    adapter = kind;
    const root = join(dir, kind);
    await mkdir(root, { recursive: true });
    process.env.HORUS_DB_DIR = join(dir, `${kind}-db`);
    writeCloudConfig(root, {
      context: 'cloud',
      organization: { id: tenant.orgId, slug: 'org' },
      workspace: { id: tenant.workspaceId, slug: 'ws' },
      project: { id: tenant.projectId, slug: 'project' },
    });
    const config = join(root, 'config.mjs');
    const connectors =
      kind === 'sentry'
        ? {
            sentry: {
              org: 'test',
              project: 'app',
              authToken: 'fixture-token',
              url: providerUrl,
            },
          }
        : {
            elasticsearch: {
              url: providerUrl,
              username: 'fixture-user',
              password: 'fixture-password',
              indexPattern: 'logs',
              serviceName: 'safqa',
            },
          };
    await writeFile(
      config,
      'export default ' +
        JSON.stringify({
          projects: [
            {
              name: 'input-project',
              repositories: [{ name: 'repo', path: root }],
              environments: [{ name: 'production', connectors }],
            },
          ],
        }),
    );
    const p = {
      root,
      config,
      project: 'input-project',
      environment: 'production',
      source: kind,
      enabled: true,
      notifications: 'off' as const,
      idempotentDestination: false,
    };
    const limits = serviceConfigSchema.parse({
      claude: '/usr/bin/true',
      runtime: process.execPath,
      entry: resolve('apps/horus/dist/index.cjs'),
      dailyInvestigations: 1,
      dailyModelCalls: 1,
      projects: [p],
    });
    await pollProject(p, 'fixture-worker', limits);
    let h = await createLocalDb();
    let all = await jobs(h.db);
    assert.equal(all.length, kind === 'sentry' ? 1 : 2);
    assert(!JSON.stringify(all).includes('never-export-this'));
    if (kind === 'elasticsearch')
      assert.equal(
        all.find((j) => j.event.orderId === 'a')?.latestEvent?.severity,
        'critical',
      );
    else assert.equal(await readWatchState(h.db, `cursor:${routeKey(p)}`), undefined);
    await h.sql.end();
    if (kind === 'sentry') {
      for (phase = 1; phase <= 3; phase++) await pollProject(p, 'fixture-worker', limits);
      h = await createLocalDb();
      all = await jobs(h.db);
      assert.equal(all.length, 3);
      assert(all.some((j) => j.resolvedAt));
      assert(await readWatchState(h.db, `cursor:${routeKey(p)}`));
      await h.sql.end();
    }
  }
  console.log(
    'PASS: real Sentry HTTP pagination/reconciliation/recurrence and Elasticsearch normalized order/retry/exhaustion inputs with durable cursors, isolated profiles and authenticated Cloud routing',
  );
} finally {
  await new Promise<void>((r) => source.close(() => r()));
  await app.close();
  await db.$client.end();
  const { getDb } = await cloudImport('apps/api/src/db.ts');
  await getDb().$client.end();
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR']) {
    if (savedEnv[key]) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
  await rm(dir, { recursive: true, force: true });
}
