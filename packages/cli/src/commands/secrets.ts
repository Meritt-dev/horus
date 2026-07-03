/**
 * `horus secrets` — manage encrypted connector credentials (HOR-452).
 *
 *   horus secrets status   inspect the master key, stored secrets, and gitignore
 *   horus secrets migrate   move plaintext secrets out of config.json into the
 *                           encrypted store and strip them from config.json
 *   horus secrets key --show   print the active master key (base64) for CI use
 *
 * Connector credentials are AES-256-GCM encrypted into `.horus/secrets.local.json`;
 * the master key lives in the OS keychain (see packages/core/src/secrets.ts).
 */

import { existsSync } from 'node:fs';
import pc from 'picocolors';
import {
  findRepoRoot,
  discoverLocalConfig,
  localConfigPath,
  localSecretsPath,
  readLocalConfig,
  writeLocalConfig,
  ensureProjectGitignore,
  isHorusGitignored,
  readLocalSecrets,
  decryptConnectorSecrets,
  writeConnectorSecret,
  ensureMasterKey,
  masterKeyStatus,
  getMasterKeyForRead,
  CONNECTOR_SECRET_FIELDS,
  findPlaintextConnectorSecrets,
  type LocalConfigFile,
} from '@horus/core';

interface Located {
  root: string;
  configPath: string;
  exists: boolean;
}

function locate(cwd: string = process.cwd()): Located {
  const root = findRepoRoot(cwd) ?? cwd;
  const configPath = discoverLocalConfig(cwd) ?? localConfigPath(root);
  return { root, configPath, exists: existsSync(configPath) };
}

/** Count encrypted secret fields stored across all envs/connectors. */
function countStoredSecrets(root: string): number {
  const stored = readLocalSecrets(root).connectors;
  if (!stored) return 0;
  let n = 0;
  for (const byConnector of Object.values(stored)) {
    for (const byField of Object.values(byConnector)) {
      n += Object.keys(byField).length;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function runSecretsStatus(opts: { cwd?: string } = {}): number {
  const { root, configPath, exists } = locate(opts.cwd);

  const key = masterKeyStatus();
  console.log(pc.bold('\nMaster key'));
  console.log(
    key.available
      ? `  ${pc.green('●')} ${key.detail}`
      : `  ${pc.dim('○')} ${key.detail}`,
  );

  const stored = countStoredSecrets(root);
  console.log(pc.bold('\nEncrypted secrets'));
  console.log(`  ${stored} stored → ${pc.dim(localSecretsPath(root))}`);
  if (stored > 0) {
    const { warnings } = decryptConnectorSecrets(root);
    if (warnings.length > 0) {
      console.log(pc.yellow(`  ⚠ ${warnings.length} cannot be decrypted with the current key:`));
      for (const w of warnings) console.log(pc.dim(`    - ${w}`));
    } else {
      console.log(pc.dim('  all decrypt cleanly with the current key'));
    }
  }

  console.log(pc.bold('\nPlaintext in config.json'));
  if (!exists) {
    console.log(pc.dim('  no .horus/config.json found'));
  } else {
    const plaintext = findPlaintextConnectorSecrets(readLocalConfig(configPath).project);
    if (plaintext.length === 0) {
      console.log(`  ${pc.green('✓')} none — config carries no credentials`);
    } else {
      console.log(pc.yellow(`  ⚠ ${plaintext.length} plaintext secret(s) — run \`horus secrets migrate\`:`));
      for (const p of plaintext) console.log(pc.dim(`    - ${p}`));
    }
  }

  console.log(pc.bold('\nGitignore'));
  console.log(
    isHorusGitignored(root)
      ? `  ${pc.green('✓')} .horus/ is gitignored`
      : pc.yellow('  ⚠ .horus/ is NOT gitignored — run `horus secrets migrate` or add `.horus/` to .gitignore'),
  );
  console.log('');
  return 0;
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export function runSecretsMigrate(opts: { dryRun?: boolean; cwd?: string } = {}): number {
  const { root, configPath, exists } = locate(opts.cwd);
  if (!exists) {
    console.error(pc.red(`No .horus/config.json found at ${configPath}.`));
    console.error(pc.dim('  Run `horus init` in this repo first.'));
    return 1;
  }

  const file = readLocalConfig(configPath);
  const plaintext = findPlaintextConnectorSecrets(file.project);

  // Always harden gitignore — this is the cheap fix for the "git added later" gap.
  ensureProjectGitignore(root);

  if (plaintext.length === 0) {
    console.log(`${pc.green('✓')} No plaintext connector secrets in config.json — nothing to migrate.`);
    if (!isHorusGitignored(root)) {
      console.log(pc.dim('  Ensured `.horus/` is gitignored.'));
    }
    return 0;
  }

  if (opts.dryRun) {
    console.log(pc.bold(`Would migrate ${plaintext.length} plaintext secret(s) → encrypted store:`));
    for (const p of plaintext) console.log(pc.dim(`  - ${p}`));
    console.log(pc.dim('\n  Re-run without --dry-run to apply.'));
    return 0;
  }

  // Resolve/create the master key once.
  let keyResult: ReturnType<typeof ensureMasterKey>;
  try {
    keyResult = ensureMasterKey();
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }

  // Walk the structure directly (env name may contain '/', so don't re-parse the
  // locator string): encrypt each secret field, then strip it from config.
  const project = file.project as { environments?: Array<Record<string, unknown>> } | undefined;
  let migrated = 0;
  for (const env of project?.environments ?? []) {
    const envName = env['name'] as string | undefined;
    const connectors = env['connectors'] as Record<string, Record<string, unknown>> | undefined;
    if (!envName || !connectors) continue;
    for (const [connector, cfg] of Object.entries(connectors)) {
      if (!cfg || typeof cfg !== 'object') continue;
      for (const field of CONNECTOR_SECRET_FIELDS[connector] ?? []) {
        const val = cfg[field];
        if (typeof val === 'string' && val.length > 0) {
          writeConnectorSecret(root, envName, connector, field, val, keyResult.key);
          delete cfg[field];
          migrated++;
        }
      }
    }
  }

  // Persist the stripped config (writeLocalConfig enforces mode 0600).
  writeLocalConfig(root, file as LocalConfigFile);

  console.log(`${pc.green('✓')} Migrated ${migrated} secret(s) → ${pc.dim(localSecretsPath(root))}`);
  console.log(pc.dim(`  master key: ${masterKeyStatus().detail}`));
  console.log(pc.dim('  config.json now carries no credentials.'));
  if (keyResult.warning) console.warn(pc.yellow(`\n⚠ ${keyResult.warning}`));
  console.log(
    pc.dim(
      '\n  If config.json was ever committed, scrub the old secret from history:\n' +
        '    git rm --cached .horus/config.json   # if tracked\n' +
        '    # then rotate the exposed credential at its provider.',
    ),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

export function runSecretsKey(opts: { show?: boolean } = {}): number {
  const status = masterKeyStatus();
  if (!status.available) {
    console.log(pc.dim('No master key yet — created on first `horus connect` or `horus secrets migrate`.'));
    return 0;
  }
  console.log(`Master key source: ${status.detail}`);
  if (!opts.show) {
    console.log(pc.dim('  Pass --show to print the key (base64) for CI use (HORUS_SECRET_KEY).'));
    return 0;
  }
  const key = getMasterKeyForRead();
  if (!key) {
    console.error(pc.red('Could not read the master key.'));
    return 1;
  }
  console.warn(pc.yellow('⚠ Treat this as a credential. Anyone with it can decrypt your connector secrets.'));
  console.log(`\nexport HORUS_SECRET_KEY=${key.toString('base64')}\n`);
  return 0;
}
