/**
 * `horus init` — THE single onboarding command (merger of the old `setup`,
 * `init`, and `index` commands): check prerequisites (advisory), write/register
 * a local `.horus/config.json`, then start the source-intelligence host and
 * index the repo (via the HOR-37 flow in index-repo.ts).
 *
 * Degradation policy:
 *   - `--source <url>`      → record the external host in config, skip local
 *                             spawn/index entirely (escape hatch), exit 0.
 *   - backend not installed → write + register config, print the install hint,
 *                             exit 0 (indexing is optional; investigate runs
 *                             degraded runtime-only).
 *   - backend present but analyze/host fails → exit 1 (the user asked for a
 *                             working index and didn't get one).
 *   - Postgres down         → advisory warning only (needed by investigate,
 *                             not by init).
 */

import pc from 'picocolors';
import { basename, resolve } from 'node:path';
import {
  findRepoRoot,
  writeLocalConfig,
  registerProject,
  ensureProjectGitignore,
  type LocalConfigFile,
} from '@horus/core';
import { sourceAvailable } from '@horus/connectors';
import { checkPrerequisites } from './setup.js';
import { runIndex } from './index-repo.js';
import { installBundledBackend, resolveBundledWheel } from '../lib/bundled-backend.js';

export interface InitOptions {
  name?: string;
  env?: string;
  /** External source-intelligence host URL — recorded verbatim, no local spawn. */
  source?: string;
  path?: string;
  config?: string;
  project?: string;
  full?: boolean;
  changed?: boolean;
  fast?: boolean;
  importKb?: string;
}

export async function runInit(opts: InitOptions): Promise<number> {
  try {
    console.log(pc.bold('\nHorus init\n'));
    // Advisory only — a red line here guides the user but never gates init.
    await checkPrerequisites({ ...(opts.config !== undefined ? { config: opts.config } : {}) });
    console.log('');

    const cwd = process.cwd();
    const root = opts.path ? resolve(opts.path) : (findRepoRoot(cwd) ?? cwd);

    if (opts.source !== undefined) {
      // External host: record it, skip local spawn/analyze/index.
      return writeConfigOnly(root, opts, opts.source);
    }

    if (!(await sourceAvailable().catch(() => false))) {
      // No backend on PATH — the bundle carries its wheel, so try installing it
      // right here (one bundle: `horus init` alone gets a working backend).
      if (
        resolveBundledWheel() !== null &&
        (await installBundledBackend((l) => console.log(l))) &&
        (await sourceAvailable().catch(() => false))
      ) {
        // Installed from the bundle — fall through to the full flow below.
      } else {
        // Config still gets written so connect/investigate (degraded
        // runtime-only) work; indexing waits for the backend.
        const code = writeConfigOnly(root, opts, undefined);
        if (code === 0) {
          console.log(
            pc.dim('  indexing skipped — no source-intelligence backend found. Install it:'),
          );
          console.log(pc.dim('    curl -fsSL https://horus.sh/install.sh | bash'));
          console.log(pc.dim('  then re-run `horus init` to index this repo'));
        }
        return code;
      }
    }

    // Backend available: the full HOR-37 flow (host reuse/spawn, analyze,
    // stitch, knowledge, config write/register for new repos).
    return await runIndex({
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.project !== undefined ? { project: opts.project } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.full !== undefined ? { full: opts.full } : {}),
      ...(opts.changed !== undefined ? { changed: opts.changed } : {}),
      ...(opts.fast !== undefined ? { fast: opts.fast } : {}),
      ...(opts.importKb !== undefined ? { importKb: opts.importKb } : {}),
      path: root,
    });
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

/** Write + register `.horus/config.json` without touching the backend. */
function writeConfigOnly(root: string, opts: InitOptions, hostUrl: string | undefined): number {
  try {
    const name = opts.name ?? basename(root);
    const envName = opts.env ?? 'production';

    const repo: Record<string, unknown> = { name, path: root };
    if (hostUrl !== undefined) repo['source'] = { hostUrl };

    const file: LocalConfigFile = {
      version: 1,
      project: {
        name,
        repositories: [repo],
        environments: [{ name: envName, readOnly: true, connectors: {} }],
      },
    };

    const configPath = writeLocalConfig(root, file);
    registerProject(name, root, configPath);
    ensureProjectGitignore(root);

    console.log(`${pc.green('✓')} Initialized Horus project ${pc.bold(name)}`);
    console.log(pc.dim(`  config:     ${configPath}`));
    console.log(pc.dim(`  registered: horus investigate --name ${name} "<hint>"`));
    console.log(
      pc.dim('  add runtime connectors with `horus connect <type>` (elasticsearch/mongodb/grafana/...) — credentials are encrypted, never hand-edited into config.json'),
    );
    console.log(
      pc.dim('  .horus/ is gitignored — local config and runtime state stay out of version control'),
    );
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
