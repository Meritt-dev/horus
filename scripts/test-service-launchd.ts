/** Explicitly isolated launchd smoke test: no providers, Cloud calls, inference or notifications. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLocalDb } from '../packages/db/src/index.js';
import { readWatchState, writeWatchState } from '../packages/cli/src/lib/watch-store.js';
import { runService } from '../packages/cli/src/commands/service.js';
if (process.platform !== 'darwin') throw new Error('macOS required');
const dir = await mkdtemp(join(tmpdir(), 'horus-launchd-test-'));
const profile = `test-${process.pid}`;
const saved = { ...process.env };
const settings = join(dir, 'settings.json');
try {
  process.env.HORUS_HOME = dir;
  process.env.HORUS_DB_DIR = dir;
  process.env.HORUS_SERVICE_DIR = dir;
  await writeFile(
    settings,
    JSON.stringify({
      claude: '/usr/bin/true',
      runtime: process.execPath,
      runtimeArgs: [resolve('node_modules/tsx/dist/cli.mjs')],
      entry: resolve('apps/horus/src/index.ts'),
      dailyInvestigations: 1,
      dailyModelCalls: 1,
      intervalSeconds: 10,
      projects: [
        {
          root: dir,
          config: join(dir, 'unused.mjs'),
          project: 'isolated-test',
          environment: 'test',
          source: 'sentry',
          enabled: false,
          notifications: 'off',
        },
      ],
    }),
  );
  await runService('install', { settings, profile, skipChecks: true });
  for (let i = 0; i < 30 && !existsSync(join(dir, 'service/status.json')); i++)
    await new Promise((r) => setTimeout(r, 500));
  assert(
    existsSync(join(dir, 'service/status.json')),
    'launchd did not produce a durable status snapshot within 15 seconds',
  );
  const state = JSON.parse(await readFile(join(dir, 'service/status.json'), 'utf8'));
  assert(state.pid);
  assert.equal(state.projects[0].enabled, false);
  for (const action of ['resume', 'pause']) {
    await runService(action, { settings, profile, path: dir, env: 'test' });
    let applied = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const next = JSON.parse(await readFile(join(dir, 'service/status.json'), 'utf8'));
      if (next.projects[0].enabled === (action === 'resume')) {
        assert.equal(next.pid, state.pid, 'pause/resume must not restart the service');
        applied = true;
        break;
      }
    }
    assert(applied, `${action} was not applied within 20 seconds`);
  }
  let h = await createLocalDb();
  await writeWatchState(h.db, 'restart:marker', { cursor: 'durable' });
  await h.sql.end();
  process.kill(state.pid, 'SIGKILL');
  let restarted = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const next = JSON.parse(await readFile(join(dir, 'service/status.json'), 'utf8'));
    if (next.pid !== state.pid) {
      restarted = true;
      break;
    }
  }
  assert(restarted, 'launchd did not restart killed service within 45 seconds');
  h = await createLocalDb();
  assert.deepEqual(await readWatchState(h.db, 'restart:marker'), { cursor: 'durable' });
  await h.sql.end();
  await runService('status', { settings, profile });
  await runService('stop', { settings, profile });
  await runService('remove', { settings, profile });
  assert(
    !existsSync(
      join(homedir(), 'Library/LaunchAgents', `sh.horus.watch.${profile}.plist`),
    ),
  );
  assert(existsSync(join(dir, 'horus.db')), 'stop/remove must preserve DB');
  console.log(
    'PASS: real launchd test profile installed, paused/resumed without restart, recovered after SIGKILL with saved state, reported status, stopped and removed; local history retained',
  );
} finally {
  await runService('remove', { settings, profile }).catch(() => {});
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR']) {
    if (saved[key]) process.env[key] = saved[key];
    else delete process.env[key];
  }
  await rm(dir, { recursive: true, force: true });
}
