/** Explicitly isolated launchd smoke test: no providers, Cloud calls, inference or notifications. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
      entry: resolve('apps/horus/dist/index.cjs'),
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
  let state: any;
  for (let i = 0; i < 90; i++) {
    state = await readFile(join(dir, 'service/status.json'), 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (state?.projects?.[0]?.enabled === false) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(
    state?.projects?.[0]?.enabled === false,
    'launchd did not produce a complete durable status snapshot within 45 seconds',
  );
  assert(state.pid);
  assert.match(state.supervisor.runtimeSha256, /^[a-f0-9]{64}$/);
  assert.equal(state.supervisor.restartCount, 0);
  assert.equal(state.supervisor.previousExit, null);
  assert.equal(state.projects[0].enabled, false);
  for (const action of ['resume', 'pause']) {
    await runService(action, { settings, profile, path: dir, env: 'test' });
    let applied = false;
    // Hosted Macs can spend a full cycle opening cold PGlite; this is a
    // bounded lifecycle check, not the production latency measurement.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const next = JSON.parse(await readFile(join(dir, 'service/status.json'), 'utf8'));
      if (next.projects[0].enabled === (action === 'resume')) {
        assert.equal(next.pid, state.pid, 'pause/resume must not restart the service');
        applied = true;
        break;
      }
    }
    assert(applied, `${action} was not applied within 60 seconds`);
  }
  let h = await createLocalDb();
  await writeWatchState(h.db, 'restart:marker', { cursor: 'durable' });
  await h.sql.end();
  process.kill(state.pid, 'SIGKILL');
  let restarted = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const next = JSON.parse(await readFile(join(dir, 'service/status.json'), 'utf8'));
    if (next.pid !== state.pid) {
      assert.equal(next.supervisor.restartCount, 1);
      assert.equal(next.supervisor.previousExit.reason, 'unrecorded');
      assert.equal(next.supervisor.runtimeSha256, state.supervisor.runtimeSha256);
      assert(
        Date.parse(next.supervisor.startedAt) > Date.parse(state.supervisor.startedAt),
      );
      restarted = true;
      break;
    }
  }
  assert(restarted, 'launchd did not restart killed service within 60 seconds');
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
} catch (error) {
  // Keep isolated startup diagnostics before finally removes the test profile.
  console.error(
    spawnSync(
      '/bin/launchctl',
      ['print', `gui/${process.getuid!()}/sh.horus.watch.${profile}`],
      { encoding: 'utf8' },
    ).stdout.slice(-8_000),
  );
  console.error(
    await readFile(join(dir, 'service/service.log'), 'utf8').catch(
      () => 'No service log was created',
    ),
  );
  throw error;
} finally {
  await runService('remove', { settings, profile }).catch(() => {});
  for (const key of ['HORUS_HOME', 'HORUS_DB_DIR', 'HORUS_SERVICE_DIR']) {
    if (saved[key]) process.env[key] = saved[key];
    else delete process.env[key];
  }
  // launchd can finish its final file writes after bootout returns.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
