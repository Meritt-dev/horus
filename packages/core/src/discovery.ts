/**
 * Local-project discovery + registry (HOR-37).
 *
 * Horus is driven git-style: a repo carries a `.horus/config.json`, discovered by
 * walking up from the working directory — the config/cwd IS the project identity.
 * The global registry at `~/.horus/registry.json` only backs the informational
 * `projects`/`hosts` listings; it is NOT a targeting mechanism (no --name/--project).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  MasterKeyUnavailableError,
  type EncryptedSecret,
} from './secrets.js';

export const HORUS_DIR = '.horus';
export const LOCAL_CONFIG_FILE = 'config.json';

/** Absolute path to a repo's local config file. */
export function localConfigPath(root: string): string {
  return join(root, HORUS_DIR, LOCAL_CONFIG_FILE);
}

/** Walk up from `start` for a `.horus/config.json`; returns its absolute path or null. */
export function discoverLocalConfig(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = localConfigPath(dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up from `start` for a `.git` directory → repo root; else null. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Global registry (~/.horus/registry.json)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  root: string;
  configPath: string;
}
export interface Registry {
  projects: Record<string, RegistryEntry>;
}

export function registryPath(): string {
  return join(homedir(), HORUS_DIR, 'registry.json');
}

export function readRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Registry>;
    return { projects: parsed.projects ?? {} };
  } catch {
    return { projects: {} };
  }
}

/**
 * Read the registry for a read-modify-WRITE cycle. Unlike {@link readRegistry}
 * (display-only, degrades to empty), an EXISTING-but-unreadable registry throws:
 * treating a corrupt/locked file as "empty" and then writing it back would WIPE
 * every registered project on an ordinary `horus init` (dogfood: registered
 * projects vanished after routine flows). The corrupt file is left in place for
 * recovery; callers treat registration as best-effort.
 */
function readRegistryForUpdate(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { projects: {} };
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Registry>;
  return { projects: parsed.projects ?? {} };
}

export function writeRegistry(reg: Registry): void {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  // Atomic: a crash mid-write must never leave a torn registry that the next
  // read treats as corrupt (and a later write then clobbers).
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * Merge one project into the registry. BEST-EFFORT and strictly ADDITIVE:
 * if the existing registry can't be parsed, registration is skipped (returns
 * false) rather than replacing everyone's entries with a fresh file — the
 * registry is informational (`horus projects`/`hosts`), never identity.
 */
export function registerProject(name: string, root: string, configPath: string): boolean {
  let reg: Registry;
  try {
    reg = readRegistryForUpdate();
  } catch {
    return false; // corrupt registry preserved for recovery; never clobbered
  }
  reg.projects[name] = { root, configPath };
  writeRegistry(reg);
  return true;
}

export function lookupProject(name: string): RegistryEntry | null {
  return readRegistry().projects[name] ?? null;
}

// ---------------------------------------------------------------------------
// Local config file shape
// ---------------------------------------------------------------------------

export interface LocalConfigFile {
  version: number;
  /** A single ProjectConfig-shaped object (name, repositories[], environments[]). */
  project: unknown;
  /** @deprecated Ignored — local persistence is embedded (pglite); teams use Horus Cloud. */
  database?: { url: string };
  /** Optional AI narrative settings (provider + Anthropic key/model) — HOR-206. */
  ai?: unknown;
}

/** Write a `.horus/config.json` under `root` and return its absolute path. */
export function writeLocalConfig(root: string, file: LocalConfigFile): string {
  const dir = join(root, HORUS_DIR);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, LOCAL_CONFIG_FILE);
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  // chmod after write enforces 0600 on pre-existing files too — writeFileSync's
  // mode flag is ignored when the file already exists on most platforms.
  chmodSync(p, 0o600);
  return p;
}

/**
 * Ensure `.horus/config.json` is listed in `.horus/.gitignore`.
 * Called by `horus connect` when literal credential values (url/password) are
 * written into the config, so that secrets are not accidentally committed.
 */
export function ensureCredentialGitignore(root: string): void {
  const dir = join(root, HORUS_DIR);
  mkdirSync(dir, { recursive: true });
  const gitignorePath = join(dir, '.gitignore');
  const entry = 'config.json';
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf8');
    if (existing.split('\n').some((l) => l.trim() === entry)) return;
    writeFileSync(gitignorePath, existing.trimEnd() + '\n' + entry + '\n');
  } else {
    writeFileSync(gitignorePath, entry + '\n');
  }
}

export function readLocalConfig(path: string): LocalConfigFile {
  return JSON.parse(readFileSync(path, 'utf8')) as LocalConfigFile;
}

// ---------------------------------------------------------------------------
// Local secrets (HOR-212) — API keys live OUTSIDE config.json so the config can
// be shared/committed without leaking credentials. Always gitignored.
// ---------------------------------------------------------------------------

export const LOCAL_SECRETS_FILE = 'secrets.local.json';

export interface LocalSecrets {
  anthropic?: { apiKey?: string };
  /**
   * Connector credentials, AES-256-GCM encrypted (HOR-452). Keyed by environment
   * name → connector type → field name. Never plaintext, never committed — the
   * config.json carries only non-secret fields (dataset, org, schema, …).
   */
  connectors?: Record<string, Record<string, Record<string, EncryptedSecret>>>;
}

/** Absolute path to a repo's local secrets file. */
export function localSecretsPath(root: string): string {
  return join(root, HORUS_DIR, LOCAL_SECRETS_FILE);
}

/** Read `.horus/secrets.local.json`, or `{}` when absent/unreadable. */
export function readLocalSecrets(root: string): LocalSecrets {
  const p = localSecretsPath(root);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LocalSecrets;
  } catch {
    return {};
  }
}

/** Write `.horus/secrets.local.json` (mode 0600) and ensure it is gitignored. */
export function writeLocalSecrets(root: string, secrets: LocalSecrets): string {
  const dir = join(root, HORUS_DIR);
  mkdirSync(dir, { recursive: true });
  const p = localSecretsPath(root);
  writeFileSync(p, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  chmodSync(p, 0o600);
  // Belt-and-suspenders: explicitly ignore the secrets file (in addition to `.horus/`).
  const gitignorePath = join(dir, '.gitignore');
  const entry = LOCAL_SECRETS_FILE;
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf8');
    if (!existing.split('\n').some((l) => l.trim() === entry)) {
      writeFileSync(gitignorePath, existing.trimEnd() + '\n' + entry + '\n');
    }
  } else {
    writeFileSync(gitignorePath, entry + '\n');
  }
  return p;
}

// ---------------------------------------------------------------------------
// Encrypted connector secrets (HOR-452) — AES-256-GCM ciphertext stored in the
// gitignored secrets file; the master key lives in the OS keychain (see secrets.ts).
// ---------------------------------------------------------------------------

/** Encrypt + store one connector secret field into `.horus/secrets.local.json`. */
export function writeConnectorSecret(
  root: string,
  envName: string,
  connector: string,
  field: string,
  plaintext: string,
  key?: Buffer,
): void {
  const secrets = readLocalSecrets(root);
  const blob = encryptSecret(plaintext, key);
  const byEnv = (secrets.connectors ??= {});
  const byConnector = (byEnv[envName] ??= {});
  const byField = (byConnector[connector] ??= {});
  byField[field] = blob;
  writeLocalSecrets(root, secrets);
  // Harden (HOR-452): writeLocalSecrets only ignores the nested secrets file;
  // also ensure the repo root ignores `.horus/` in case it was never onboarded.
  ensureProjectGitignore(root);
}

/** Remove all stored secrets for one connector in an environment (e.g. on disconnect). */
export function deleteConnectorSecrets(root: string, envName: string, connector: string): void {
  const secrets = readLocalSecrets(root);
  const byConnector = secrets.connectors?.[envName];
  if (byConnector && byConnector[connector]) {
    delete byConnector[connector];
    writeLocalSecrets(root, secrets);
  }
}

export interface DecryptedConnectorSecrets {
  /** env → connector → field → plaintext value. */
  values: Record<string, Record<string, Record<string, string>>>;
  /** Non-fatal decrypt problems (missing/wrong key) for the caller to surface. */
  warnings: string[];
}

/**
 * Read + decrypt every connector secret from `.horus/secrets.local.json`.
 * Best-effort: a blob that cannot be decrypted is skipped with a warning so the
 * rest of config loading still works (degrade, don't crash).
 */
export function decryptConnectorSecrets(root: string): DecryptedConnectorSecrets {
  const out: DecryptedConnectorSecrets = { values: {}, warnings: [] };
  const stored = readLocalSecrets(root).connectors;
  if (!stored) return out;
  for (const [env, byConnector] of Object.entries(stored)) {
    for (const [connector, byField] of Object.entries(byConnector)) {
      for (const [field, blob] of Object.entries(byField)) {
        if (!isEncryptedSecret(blob)) continue;
        try {
          const plain = decryptSecret(blob);
          const e = (out.values[env] ??= {});
          const c = (e[connector] ??= {});
          c[field] = plain;
        } catch (err) {
          const reason =
            err instanceof MasterKeyUnavailableError ? 'no master key' : (err as Error).message;
          out.warnings.push(`${env}/${connector}.${field}: ${reason}`);
        }
      }
    }
  }
  return out;
}

/** True when a gitignore/exclude file's text carries a `.horus` ignore line. */
function hasHorusIgnoreEntry(text: string): boolean {
  return text
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === '.horus' || l === '.horus/' || l === '/.horus' || l === '/.horus/');
}

/**
 * Resolve the repo-local `.git/info/exclude` path for `root`, following a `.git` FILE
 * (worktree/submodule `gitdir: <path>`) to its real git dir. Returns null when `root`
 * is not a git repo or the pointer is unreadable.
 */
function gitInfoExcludePath(root: string): string | null {
  const gitPath = join(root, '.git');
  if (!existsSync(gitPath)) return null;
  let gitDir: string;
  try {
    const st = statSync(gitPath);
    if (st.isDirectory()) {
      gitDir = gitPath;
    } else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitPath, 'utf8'));
      if (!m) return null;
      const resolved = m[1]!;
      gitDir = resolved.startsWith('/') ? resolved : join(root, resolved);
    }
  } catch {
    return null;
  }
  return join(gitDir, 'info', 'exclude');
}

/**
 * Read-only check: is `.horus/` ignored for this repo? Checks the repo-local
 * `.git/info/exclude` (where {@link ensureProjectGitignore} writes it) AND a legacy tracked
 * `.gitignore` entry from an older init. Returns true for a non-git directory (nothing can
 * leak). Used by `horus doctor`.
 */
export function isHorusGitignored(root: string): boolean {
  if (!existsSync(join(root, '.git'))) return true;
  const excludePath = gitInfoExcludePath(root);
  if (excludePath !== null && existsSync(excludePath) && hasHorusIgnoreEntry(readFileSync(excludePath, 'utf8'))) {
    return true;
  }
  const gitignorePath = join(root, '.gitignore');
  return existsSync(gitignorePath) && hasHorusIgnoreEntry(readFileSync(gitignorePath, 'utf8'));
}

/**
 * Ensure the project's root `.gitignore` ignores the `.horus/` directory, so the
 * local config and machine-specific runtime state (host.json, logs, source index)
 * are never committed. Called by `horus init` when onboarding a repo.
 *
 * Behavior:
 *   - No `.git` directory under `root` → no-op (not a git repo, nothing to ignore).
 *   - `.gitignore` missing → create it with a `.horus/` entry.
 *   - `.gitignore` present without a `.horus` entry → append one.
 *   - `.horus` already ignored (any common spelling) → no-op.
 */
export function ensureProjectGitignore(root: string): void {
  // Ignore `.horus/` through the repo-LOCAL exclude file (`.git/info/exclude`), NEVER the
  // tracked `.gitignore`. Writing a tracked file dirties the working tree, and Horus's own
  // dirty-worktree / what-changed detection then reports its setup edit as evidence
  // (dogfood 0.21). `.git/info/exclude` is per-clone and never committed, so it ignores our
  // scratch dir without touching anything git tracks.
  const excludePath = gitInfoExcludePath(root);
  if (excludePath === null) return;
  const entry = '.horus/';
  try {
    const infoDir = dirname(excludePath);
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (hasHorusIgnoreEntry(existing)) return;
    const prefix = existing.trim() === '' ? '' : existing.trimEnd() + '\n';
    writeFileSync(excludePath, prefix + entry + '\n');
  } catch {
    // Best-effort — a read-only .git/info must never fail a connect/init.
  }
}

/**
 * Patch a single connector's config in an existing `.horus/config.json`.
 * If `envName` is omitted, targets the first environment in the project.
 * Merges `patch` into any existing connector config (so partial updates work).
 */
export function patchLocalConnector(
  configPath: string,
  connectorType: string,
  patch: Record<string, unknown>,
  envName?: string,
): void {
  const file = readLocalConfig(configPath);
  const project = file.project as Record<string, unknown>;
  const envs = project['environments'] as Array<Record<string, unknown>> | undefined;
  if (!envs || envs.length === 0) throw new Error('No environments found in config.');

  const env = envName
    ? envs.find((e) => e['name'] === envName)
    : envs[0];
  if (!env) throw new Error(`Environment "${envName ?? envs[0]?.['name']}" not found in config.`);

  if (!env['connectors'] || typeof env['connectors'] !== 'object') {
    env['connectors'] = {};
  }
  const connectors = env['connectors'] as Record<string, unknown>;
  connectors[connectorType] = { ...(connectors[connectorType] as Record<string, unknown> ?? {}), ...patch };

  const root = configPath.replace(`/${HORUS_DIR}/${LOCAL_CONFIG_FILE}`, '');
  writeLocalConfig(root, file);
}
