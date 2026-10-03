import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDbLock, createLocalDb } from '@horus/db';
import {
  readServiceConfig,
  runWatchService,
  runServiceWorker,
  serviceHome,
  routeKey,
  type ServiceConfig,
} from '../lib/watch-service.js';
import { jobs, saveJob, readWatchState } from '../lib/watch-store.js';
import { runProcess } from '../lib/claude-investigation.js';
import { recordActivityHook } from '../lib/worker-activity.js';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { memorySyncContext } from '../lib/cloud/memory-sync.js';
import { sentryForEnv, logsForEnv } from '@horus/connectors';

const xml = (v: string) =>
  v.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
export function serviceLabel(profile: string): string {
  if (!/^[a-z0-9-]{1,40}$/.test(profile))
    throw new Error('Profile must be 1–40 lowercase letters, digits or hyphens');
  return `sh.horus.watch.${profile}`;
}
export function launchdPlist(
  config: ServiceConfig,
  settings: string,
  profile: string,
): string {
  const env = {
    HOME: homedir(),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.CLAUDE_CONFIG_DIR
      ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
      : {}),
    ...(process.env.HORUS_HOME ? { HORUS_HOME: process.env.HORUS_HOME } : {}),
    ...(process.env.HORUS_DB_DIR ? { HORUS_DB_DIR: process.env.HORUS_DB_DIR } : {}),
    ...(process.env.HORUS_SERVICE_DIR
      ? { HORUS_SERVICE_DIR: process.env.HORUS_SERVICE_DIR }
      : {}),
    ...config.environment,
  };
  const args = [
    config.runtime,
    ...config.runtimeArgs,
    config.entry,
    'service',
    'run',
    '--settings',
    settings,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${xml(serviceLabel(profile))}</string>
<key>ProgramArguments</key><array>${args.map((v) => `<string>${xml(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(config.projects[0]!.root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string><key>ExitTimeOut</key><integer>5</integer>
</dict></plist>\n`;
}
function launchctl(args: string[], allowMissing = false) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowMissing)
    throw new Error(`launchctl ${args[0]}: ${result.stderr.trim()}`);
  return result.stdout;
}
export async function runService(
  action: string,
  opts: {
    settings?: string;
    profile?: string;
    job?: string;
    session?: string;
    once?: boolean;
    deliveryChecked?: boolean;
    skipChecks?: boolean;
    path?: string;
    env?: string;
  },
): Promise<number> {
  if (action === 'activity') {
    if (opts.session && opts.job) await recordActivityHook(serviceHome(), opts.session, opts.job);
    return 0;
  }
  const settings = resolve(opts.settings ?? join(serviceHome(), 'settings.json'));
  if (action === 'pause' || action === 'resume') {
    const file = realpathSync(settings);
    const release = await acquireDbLock(file, 2000);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const config = readServiceConfig(file);
      const matches = config.projects.filter(
        (p) =>
          resolve(p.root) === resolve(opts.path ?? process.cwd()) &&
          (!opts.env || p.environment === opts.env),
      );
      if (matches.length !== 1)
        throw new Error('Select exactly one configured project with --path and --env');
      const project = matches[0]!;
      project.enabled = action === 'resume';
      writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, file);
      console.log(
        `${project.project}/${project.environment}: ${project.enabled ? 'resumed' : 'paused'}. Applies on the next service cycle; an active investigation finishes. Queued work is preserved.`,
      );
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      release();
    }
    return 0;
  }
  if (action === 'worker') {
    if (!opts.job) throw new Error('--job required');
    await runServiceWorker(settings, opts.job);
    return 0;
  }
  if (action === 'run') {
    await runWatchService(settings, opts.once);
    return 0;
  }
  const profile = opts.profile ?? 'default';
  const label = serviceLabel(profile);
  const domain = `gui/${process.getuid!()}`;
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (action === 'status') {
    const statusPath = join(serviceHome(), 'status.json');
    const snapshot = existsSync(statusPath)
      ? JSON.parse(readFileSync(statusPath, 'utf8'))
      : { state: 'not started' };
    let alive = false;
    try {
      if (snapshot.pid) {
        process.kill(snapshot.pid, 0);
        alive = true;
      }
    } catch {
      /* stopped */
    }
    console.log(
      JSON.stringify(
        {
          ...snapshot,
          online: alive && Date.now() - Date.parse(snapshot.at) < 120_000,
          launchd:
            process.platform === 'darwin'
              ? (launchctl(['print', `${domain}/${label}`], true).match(
                  /state = ([^\n]+)/,
                )?.[1] ?? 'not loaded')
              : 'macOS only',
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (action === 'retry') {
    if (!opts.job) throw new Error('--job required');
    const h = await createLocalDb();
    try {
      const job = (await jobs(h.db)).find((j) => j.id === opts.job);
      if (!job) throw new Error('Job not found');
      if (job.pid) {
        try {
          process.kill(job.pid, 0);
          throw new Error('Job is still running');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (job.notificationKey && !opts.deliveryChecked)
        throw new Error(
          'Inspect destination, then use --delivery-checked to permit another send',
        );
      if (job.cloudRequest) {
        const config = readServiceConfig(settings);
        const p = config.projects.find((p) => routeKey(p) === job.route);
        const cloud =
          p && memorySyncContext(p.root, p.project, AbortSignal.timeout(15000));
        if (!cloud || !p)
          throw new Error('Sign in to the job Cloud scope before retrying');
        if ((await readWatchState<string>(h.db, `scope:${job.route}`)) !== cloud.scope)
          throw new Error('Job Cloud scope mismatch');
        await cloud.client.alertRequest(
          cloud.config.workspace!.id,
          job.cloudRequest.id,
          'retry',
          { projectId: cloud.config.project!.id, environment: p.environment },
        );
      }
      if (opts.deliveryChecked) {
        job.notificationKey = undefined;
        job.notified = false;
      }
      job.status = 'pending';
      job.attempts[job.stage] = 0;
      job.nextAttemptAt = 0;
      job.error = undefined;
      job.pid = undefined;
      await saveJob(h.db, job);
    } finally {
      await h.sql.end();
    }
    return 0;
  }
  if (action === 'check' || action === 'install') {
    const config = readServiceConfig(settings);
    if (config.environment.ANTHROPIC_API_KEY || config.environment.ANTHROPIC_AUTH_TOKEN)
      throw new Error(
        'Use the local Claude Code login; do not configure API credentials for this adapter',
      );
    Object.assign(process.env, config.environment);
    for (const executable of [config.runtime, config.claude]) {
      accessSync(executable, constants.X_OK);
      realpathSync(executable);
    }
    accessSync(config.entry, constants.R_OK);
    console.log(
      `Backlog: active events from previous 24h; at most ten bootstrap executions, remaining backlog retained. Daily limits: ${config.dailyInvestigations} investigations / ${config.dailyModelCalls} model calls.`,
    );
    if (!opts.skipChecks) {
      const authStatus = JSON.parse(
        await runProcess(config.claude, ['auth', 'status'], {
          cwd: config.projects[0]!.root,
          timeoutMs: 15_000,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => key !== 'ANTHROPIC_API_KEY' && key !== 'ANTHROPIC_AUTH_TOKEN',
            ),
          ),
        }),
      );
      if (authStatus.loggedIn !== true)
        throw new Error(
          'Claude Code is not logged in; run claude auth login as this local user',
        );
      for (const p of config.projects.filter((p) => p.enabled)) {
        const loaded = await loadConfig(p.config, { cwd: p.root });
        const env = resolveEnvironment(loaded, {
          project: p.project,
          env: p.environment,
          cwd: p.root,
        });
        if (resolve(env.path) !== resolve(p.root))
          throw new Error(`Project root mismatch: ${p.project}`);
        const cloud = memorySyncContext(p.root, p.project, AbortSignal.timeout(15_000));
        if (!cloud) throw new Error(`${p.project}: sign in and link Cloud first`);
        await cloud.client.listAlertRequests(
          cloud.config.workspace!.id,
          cloud.config.project!.id,
          p.environment,
        );
        const source =
          p.source === 'auto'
            ? env.connectors.sentry
              ? 'sentry'
              : 'elasticsearch'
            : p.source;
        if (
          source === 'pagerduty' &&
          !(await cloud.client.listAlertSources(cloud.config.workspace!.id)).some(
            (s) =>
              s.enabled &&
              s.provider === 'pagerduty' &&
              s.projectId === cloud.config.project!.id &&
              s.environment === p.environment &&
              s.serviceId,
          )
        )
          throw new Error(
            `${p.project}: configure and enable the native PagerDuty subscription first`,
          );
        if (source === 'sentry') {
          const provider = sentryForEnv(env);
          if (!provider || !(await provider.health()).ok)
            throw new Error(`${p.project}: Sentry unavailable`);
        }
        if (source === 'elasticsearch') {
          const provider = logsForEnv(env);
          if (!provider || !(await provider.health()).ok)
            throw new Error(`${p.project}: Elasticsearch unavailable`);
        }
        if (p.notifications === 'configured' && !env.notify?.webhook)
          throw new Error(
            `${p.project}: configure a notification webhook or select notifications: off; Cloud report storage alone is not an outbound notice`,
          );
        console.log(
          `${p.project}/${p.environment}: ${source}; ${p.notifications === 'off' ? 'notifications disabled' : 'configured destination selected'}`,
        );
      }
    } else if (action === 'install' && profile === 'default')
      throw new Error('--skip-checks is restricted to an explicitly named test profile');
    if (action === 'check') {
      console.log(
        'Paths/auth/connectivity checked. Opus access requires a real investigation; no model substitution.',
      );
      return 0;
    }
    if (process.platform !== 'darwin')
      throw new Error('launchd installation requires macOS');
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    if (existsSync(plist))
      throw new Error('Profile already installed; stop/remove before reinstalling');
    writeFileSync(plist, launchdPlist(config, settings, profile), { mode: 0o600 });
    launchctl(['bootstrap', domain, plist]);
    console.log(`Installed ${label}. Settings: ${settings}`);
    return 0;
  }
  if (action === 'start') {
    if (process.platform !== 'darwin' || !existsSync(plist))
      throw new Error('Install the macOS profile first');
    launchctl(['bootstrap', domain, plist]);
    return 0;
  }
  if (action === 'stop' || action === 'remove') {
    if (process.platform !== 'darwin')
      throw new Error('launchd management requires macOS');
    launchctl(['bootout', `${domain}/${label}`], true);
    if (action === 'remove' && existsSync(plist)) unlinkSync(plist);
    console.log(
      `${action === 'remove' ? 'Removed' : 'Stopped'} ${label}; queue history and reports preserved.`,
    );
    return 0;
  }
  throw new Error(
    'Use service check|install|start|run|status|pause|resume|stop|remove|retry',
  );
}
