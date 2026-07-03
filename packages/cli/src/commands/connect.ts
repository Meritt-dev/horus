/**
 * `horus connect <type>` — add or update a runtime connector in the current
 * repo's `.horus/config.json` (HOR-41).
 *
 * Two modes:
 *  - Flags only (machine-friendly):
 *      horus connect elasticsearch --url https://elastic.meritt.dev \
 *        --username admin --password secret --index-pattern 'logs-*'
 *
 *  - Interactive (human-friendly, kicks in when key flags are missing):
 *      horus connect elasticsearch
 *      > URL: https://elastic.meritt.dev
 *      > Username: admin
 *      > Password: ••••••••
 *      > Index pattern: logs-*
 */

import { createInterface } from 'node:readline';
import pc from 'picocolors';
import {
  findRepoRoot,
  discoverLocalConfig,
  localConfigPath,
  localSecretsPath,
  patchLocalConnector,
  writeConnectorSecret,
  ensureProjectGitignore,
  readLocalConfig,
  CONNECTOR_SECRET_FIELDS,
  ensureMasterKey,
  masterKeyStatus,
  REDIS_ROLES,
  type RedisRole,
} from '@horus/core';
import {
  ElasticsearchClient,
  MongoStateClient,
  PostgresStateClient,
  SentryClient,
  AxiomClient,
  ShopifyAdminClient,
  GrafanaClient,
  RedisScanClient,
  probeRedisDatabases,
  type RedisDbProbe,
} from '@horus/connectors';
import { checkboxSearch, selectSearch, isInteractive, ExitPromptError } from '../lib/tty-selector.js';
import { runConnectAi } from './connect-ai.js';

/** A logical Redis DB the user wants to configure, with its roles. */
interface RedisDatabaseSpec {
  db: number;
  name?: string;
  roles: RedisRole[];
}

/** Parse a `--db` spec like "0:cache,state" or "1:bullmq" into a RedisDatabaseSpec. */
export function parseDbSpec(spec: string): RedisDatabaseSpec {
  const [dbPart, rolesPart] = spec.split(':');
  const db = Number.parseInt((dbPart ?? '').trim(), 10);
  if (!Number.isInteger(db) || db < 0 || db > 15) {
    throw new Error(`Invalid --db spec "${spec}": DB index must be 0–15 (e.g. 1:bullmq,queues)`);
  }
  const roles = (rolesPart ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean) as RedisRole[];
  for (const role of roles) {
    if (!(REDIS_ROLES as readonly string[]).includes(role)) {
      throw new Error(`Invalid role "${role}" in --db spec "${spec}". Valid roles: ${REDIS_ROLES.join(', ')}`);
    }
  }
  return { db, roles };
}

export interface ConnectOpts {
  env?: string;
  url?: string;
  username?: string;
  password?: string;
  indexPattern?: string;
  /** Multiple index patterns selected during interactive discovery. */
  indexPatterns?: string[];
  service?: string;
  database?: string;
  collections?: string;
  /** Postgres schema to introspect (default "public"). */
  schema?: string;
  /** Postgres tables (comma-separated allowlist; empty = auto-discover all base tables). */
  tables?: string;
  /** Sentry API auth token (sent as Bearer). */
  authToken?: string;
  /** Sentry org slug. */
  org?: string;
  /** Sentry project slug. */
  project?: string;
  /** Axiom API token (sent as Bearer). */
  token?: string;
  /** Axiom dataset to query. */
  dataset?: string;
  /** Shopify store domain (e.g. my-store.myshopify.com). */
  store?: string;
  /** Shopify Admin API version (e.g. 2025-10). */
  apiVersion?: string;
  /** Shopify app client_id (Client-Credentials grant). */
  accessId?: string;
  /** Shopify app client_secret (encrypted at rest). */
  secret?: string;
  dashboard?: string;
  /** Multiple dashboard UIDs selected during interactive discovery. */
  dashboardUids?: string[];
  noTest?: boolean;
  /** AI provider (for `horus connect ai`): anthropic / claude / codex / gemini. */
  provider?: string;
  /** Anthropic API key (for `horus connect ai`). */
  apiKey?: string;
  /** Default model (for `horus connect ai`). */
  aiModel?: string;
  /** Raw `--db db:roles` specs (redis, repeatable). */
  db?: string[];
  /** BullMQ key prefix for queue DBs (redis). */
  bullmqPrefix?: string;
  /** Force/skip interactive DB scan (redis). Undefined = auto when interactive. */
  scanDbs?: boolean;
  /** Parsed/discovered redis databases (internal). */
  redisDatabases?: RedisDatabaseSpec[];
  /** Override the working directory used to locate the repo/config (tests). */
  cwd?: string;
}

const SUPPORTED = ['elasticsearch', 'mongodb', 'postgres', 'sentry', 'axiom', 'shopify', 'grafana', 'redis'] as const;
type ConnectorType = (typeof SUPPORTED)[number];

export async function runConnect(type: string, opts: ConnectOpts): Promise<number> {
  // AI providers are not per-environment connectors — dispatch to the dedicated flow.
  if (type === 'ai') {
    return runConnectAi({
      provider: opts.provider,
      apiKey: opts.apiKey,
      model: opts.aiModel,
      noTest: opts.noTest,
    });
  }
  if (!(SUPPORTED as readonly string[]).includes(type)) {
    console.error(
      pc.red(`Unknown connector type: ${type}`) +
        pc.dim(`\n  supported: ${SUPPORTED.join(', ')}, ai`),
    );
    return 1;
  }
  const connectorType = type as ConnectorType;

  try {
    const cwd = opts.cwd ?? process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const configPath = discoverLocalConfig(cwd) ?? localConfigPath(root);

    // Fill in any missing opts interactively.
    const filled = await fillInteractive(connectorType, opts);

    // Safety net: never save a half-configured connector. If a required field is still
    // missing (e.g. the secret was left blank, or a non-interactive run omitted a flag),
    // fail loudly instead of writing a connector that silently can't authenticate.
    if (missingRequired(connectorType, filled)) {
      console.error(
        pc.red(`Missing required field(s) for ${connectorType} — nothing saved.`) +
          pc.dim(
            `\n  Re-run ${pc.bold(`horus connect ${connectorType}`)} and fill every prompt, ` +
              `or pass them as flags (e.g. --secret for the token).`,
          ),
      );
      return 1;
    }

    // Build the patch.
    let patch: Record<string, unknown>;
    switch (connectorType) {
      case 'elasticsearch':
        patch = buildEsPatch(filled);
        break;
      case 'mongodb':
        patch = buildMongoPatch(filled);
        break;
      case 'postgres':
        patch = buildPostgresPatch(filled);
        break;
      case 'sentry':
        patch = buildSentryPatch(filled);
        break;
      case 'axiom':
        patch = buildAxiomPatch(filled);
        break;
      case 'shopify':
        patch = buildShopifyPatch(filled);
        break;
      case 'grafana':
        patch = buildGrafanaPatch(filled);
        break;
      case 'redis':
        patch = buildRedisPatch(filled);
        break;
    }

    // Probe the connector unless --no-test.
    if (!filled.noTest) {
      const probeResult = await probe(connectorType, filled);
      if (!probeResult.ok) {
        console.error(
          `\n${pc.red(`✗ Could not reach ${connectorType}:`)} ${probeResult.detail}` +
            pc.dim('\n  Fix the connection and retry, or pass --no-test to skip.'),
        );
        return 1;
      }
      console.log(
        `\n${pc.green('✓')} ${connectorType} reachable ${pc.dim(`(${probeResult.detail})`)}`,
      );
    }

    // HOR-452: split the patch into SECRETS (AES-256-GCM encrypted into
    // .horus/secrets.local.json) and non-secret config (.horus/config.json).
    // Connector credentials never touch config.json, so it stays safe to share.
    const envName = resolveEnvName(configPath, filled.env);
    const secretFields = CONNECTOR_SECRET_FIELDS[connectorType] ?? [];
    const nonSecretPatch: Record<string, unknown> = {};
    const secretPatch: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(patch)) {
      if (secretFields.includes(k) && typeof v === 'string' && v.length > 0) {
        secretPatch.push([k, v]);
      } else {
        nonSecretPatch[k] = v;
      }
    }

    // Always keep `.horus/` out of Git — covers repos where Git was initialized
    // after `horus init`, so the secrets file can never be committed.
    ensureProjectGitignore(root);

    if (secretPatch.length > 0) {
      // Resolve (creating on first use) the master key up front so we can surface
      // where it lives and any fallback warning before writing anything.
      let keyResult: ReturnType<typeof ensureMasterKey>;
      try {
        keyResult = ensureMasterKey();
      } catch (err) {
        console.error(pc.red((err as Error).message));
        return 1;
      }
      for (const [field, value] of secretPatch) {
        writeConnectorSecret(root, envName, connectorType, field, value, keyResult.key);
      }
      if (keyResult.warning) console.warn(pc.yellow(`\n⚠ ${keyResult.warning}`));
    }

    // Write the non-secret config (writeLocalConfig enforces mode 0600). Always
    // patch — even an empty patch — so the connector block exists for resolution.
    patchLocalConnector(configPath, connectorType, nonSecretPatch, envName);

    console.log(
      `${pc.green('✓')} ${pc.bold(connectorType)} connector saved → ${pc.dim(configPath)}`,
    );
    if (secretPatch.length > 0) {
      const n = secretPatch.length;
      console.log(
        pc.dim(
          `  ${n} secret${n > 1 ? 's' : ''} encrypted → ${localSecretsPath(root)}\n` +
            `  master key: ${masterKeyStatus().detail}`,
        ),
      );
    }
    printSummary(connectorType, filled);
    console.log(pc.dim(`\n  run: horus investigate "<hint>"`));
    return 0;
  } catch (err) {
    if (err instanceof ExitPromptError) {
      console.error(pc.red('Cancelled.'));
      return 1;
    }
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Interactive fill-in
// ---------------------------------------------------------------------------

async function fillInteractive(
  type: ConnectorType,
  opts: ConnectOpts,
): Promise<ConnectOpts> {
  const needsInteraction = missingRequired(type, opts);
  if (!needsInteraction) return opts;

  console.log(
    `\n${pc.bold(`Connect ${type}`)} ${pc.dim('(press Enter to skip optional fields)')}\n`,
  );

  const filled = { ...opts };

  switch (type) {
    case 'elasticsearch':
      filled.url = filled.url ?? (await ask('URL', 'https://elastic.example.com'));
      filled.username =
        filled.username ?? ((await ask('Username', '', false)) || undefined);
      filled.password = filled.password ?? ((await askPassword('Password')) || undefined);
      // Discover available indexes if no index pattern was passed via flag.
      if (filled.indexPattern === undefined && filled.indexPatterns === undefined) {
        const discovered = await discoverEsIndices(
          filled.url,
          filled.username,
          filled.password,
        );
        if (discovered.length > 0) {
          const selected = await askIndexSelection(discovered);
          if (selected.length > 0) {
            filled.indexPatterns = selected;
          }
        }
        // Fall back to manual entry if discovery failed or user typed manually.
        if (filled.indexPatterns === undefined) {
          filled.indexPattern = await ask('Index pattern', 'logs-*');
        }
      }
      filled.service = filled.service ?? ((await ask('Service name', '')) || undefined);
      break;

    case 'mongodb':
      filled.url =
        filled.url ?? (await ask('Connection string', 'mongodb://localhost:27017'));
      filled.database = filled.database ?? (await ask('Database name', ''));
      filled.collections =
        filled.collections ??
        ((await ask('Collections (comma-separated, or Enter for all)', '')) || undefined);
      break;

    case 'postgres':
      filled.url =
        filled.url ?? (await ask('Connection string', 'postgres://localhost:5432/postgres'));
      filled.schema = filled.schema ?? ((await ask('Schema', 'public')) || undefined);
      filled.tables =
        filled.tables ??
        ((await ask('Tables (comma-separated, or Enter for all)', '')) || undefined);
      break;

    case 'sentry':
      filled.org = filled.org ?? (await ask('Org slug', 'my-org'));
      filled.project = filled.project ?? (await ask('Project slug', 'my-project'));
      filled.authToken =
        filled.authToken ?? ((await askPassword('Auth token')) || undefined);
      filled.url =
        filled.url ?? ((await ask('Base URL (self-hosted)', 'https://sentry.io', false)) || undefined);
      break;

    case 'axiom': {
      filled.token = filled.token ?? ((await askPassword('Axiom API token')) || undefined);

      // Server/region — single-select (US / EU / Custom URL), unless --url was given.
      if (filled.url === undefined) {
        filled.url = await askAxiomRegion();
      }

      // Dataset — discover-then-select, unless --dataset was given.
      if (filled.dataset === undefined) {
        const baseUrl = filled.url ?? 'https://api.axiom.co';
        let names: string[] = [];
        if (filled.token) {
          const client = new AxiomClient({ token: filled.token, dataset: '', baseUrl });
          names = (await client.listDatasets()).map((d) => d.name).filter(Boolean);
        }
        if (names.length > 0) {
          const picked = await askDatasetSelection(names);
          if (picked) filled.dataset = picked;
        }
        // Fall back to manual entry if listing failed/empty or the user skipped.
        if (filled.dataset === undefined) {
          if (names.length === 0) {
            console.log(
              pc.yellow(
                "  Couldn't list datasets (check token / network / region) — enter the name manually.",
              ),
            );
          }
          filled.dataset = await ask('Dataset name', 'logs');
        }
      }
      break;
    }

    case 'shopify': {
      // Subdomain only — Horus adds `.myshopify.com` internally so users can't fat-finger it.
      filled.store = filled.store ?? (await ask('Store name (subdomain only, e.g. acme-store)', 'my-store'));
      filled.apiVersion = filled.apiVersion ?? (await ask('API version', '2025-10'));
      // Ask WHICH auth model up front so the credential prompts are unambiguous. Skipped
      // when a secret was already supplied via flags (non-interactive).
      if (filled.secret === undefined) {
        const method = await askShopifyAuthMethod();
        if (method === 'client-credentials') {
          filled.accessId = filled.accessId ?? (await askRequiredText('Access id (client_id)'));
          filled.secret = (await askPassword('Client secret', true)) || undefined;
        } else {
          // Static token: the secret IS the Admin API access token; there is no access id.
          filled.accessId = undefined;
          filled.secret = (await askPassword('Admin API access token (e.g. shpat_…)', true)) || undefined;
        }
      }
      break;
    }

    case 'grafana':
      filled.url = filled.url ?? (await ask('URL', 'https://grafana.example.com'));
      filled.username =
        filled.username ?? ((await ask('Username', '', false)) || undefined);
      filled.password = filled.password ?? ((await askPassword('Password')) || undefined);
      // Discover available dashboards if no dashboard was passed via flag.
      if (filled.dashboard === undefined && filled.dashboardUids === undefined) {
        const discovered = await discoverGrafanaDashboards(
          filled.url,
          filled.username,
          filled.password,
        );
        if (discovered.length > 0) {
          const selected = await askDashboardSelection(discovered);
          if (selected.length > 0) {
            filled.dashboardUids = selected.map((d) => d.uid);
          }
        }
        // Fall back to manual UID entry if discovery failed or user typed manually.
        if (filled.dashboardUids === undefined) {
          filled.dashboard = (await ask('Default dashboard uid', '', false)) || undefined;
        }
      }
      break;

    case 'redis': {
      console.log(
        pc.dim(
          '  Tip: embed credentials directly in the URL — redis://:password@host:6379\n' +
            '       or enter the URL and password separately below.',
        ),
      );
      filled.url = filled.url ?? (await ask('URL', 'redis://localhost:6379'));
      // Only prompt for password when the URL doesn't already contain one.
      if (!redisUrlHasPassword(filled.url)) {
        const pw = (await askPassword('Password')) || undefined;
        if (pw !== undefined && filled.url !== undefined) {
          filled.url = injectRedisPassword(filled.url, pw);
        }
      }

      // Multi-DB configuration (HOR-201). Priority: explicit --db specs > interactive
      // scan > none (backward-compatible single-DB-from-URL).
      if (filled.db && filled.db.length > 0) {
        filled.redisDatabases = filled.db.map(parseDbSpec);
      } else if (filled.url && filled.scanDbs !== false && isInteractive()) {
        const scan = await askScanDbs();
        if (scan) {
          filled.redisDatabases = await discoverAndSelectDbs(filled.url, filled.bullmqPrefix ?? 'bull');
        }
      }
      break;
    }
  }

  return filled;
}

function missingRequired(type: ConnectorType, opts: ConnectOpts): boolean {
  switch (type) {
    case 'elasticsearch':
      return !opts.url || (!opts.indexPattern && !opts.indexPatterns?.length);
    case 'mongodb':
      return !opts.url || !opts.database;
    case 'postgres':
      return !opts.url;
    case 'sentry':
      return !opts.org || !opts.project || !opts.authToken;
    case 'axiom':
      return !opts.dataset || !opts.token;
    case 'shopify':
      // accessId is optional (blank ⇒ static token); apiVersion defaults in the client.
      return !opts.store || !opts.secret;
    case 'grafana':
      return !opts.url;
    case 'redis':
      return !opts.url;
  }
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

export function ask(label: string, placeholder = '', required = true): Promise<string> {
  return new Promise((resolve) => {
    const hint = placeholder ? pc.dim(` (${placeholder})`) : '';
    const suffix = required ? '' : pc.dim(' [optional]');
    process.stdout.write(`  ${label}${suffix}${hint}: `);
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim() || (required ? placeholder : ''));
    });
  });
}

export function askPassword(label: string, required = false): Promise<string> {
  return new Promise((resolve) => {
    // Use raw mode to mask input character-by-character.
    const stdin = process.stdin;
    if (typeof (stdin as NodeJS.ReadStream).setRawMode === 'function') {
      const suffix = required ? '' : pc.dim(' [optional]');
      process.stdout.write(`  ${label}${suffix}: `);
      (stdin as NodeJS.ReadStream).setRawMode(true);
      stdin.resume();
      let value = '';
      const onData = (chunk: Buffer) => {
        const char = chunk.toString();
        if (char === '\r' || char === '\n') {
          // A required secret can't be skipped — re-prompt on an empty Enter.
          if (required && value === '') {
            process.stdout.write(`\n${pc.yellow('  Required — please enter a value.')}\n`);
            process.stdout.write(`  ${label}: `);
            return;
          }
          (stdin as NodeJS.ReadStream).setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (char === '') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '' || char === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          value += char;
          process.stdout.write('•');
        }
      };
      stdin.on('data', onData);
    } else {
      // Non-TTY (piped input): fall back to plain readline.
      resolve(ask(label, '', false));
    }
  });
}

/** Prompt for a REQUIRED free-text value, re-prompting until something is entered. */
async function askRequiredText(label: string): Promise<string> {
  for (;;) {
    const v = (await ask(label, '', false)).trim();
    if (v) return v;
    console.log(pc.yellow('  Required — please enter a value.'));
  }
}

/**
 * Ask which Shopify auth model to configure, so the credential prompts that follow are
 * unambiguous (a static Admin API token vs a Client-Credentials app). Defaults to static.
 */
async function askShopifyAuthMethod(): Promise<'static' | 'client-credentials'> {
  console.log(`  ${pc.bold('Auth method')}`);
  console.log(`    ${pc.bold('1)')} Static Admin API access token   ${pc.dim('— a Custom App shpat_… token')}`);
  console.log(`    ${pc.bold('2)')} Client-Credentials app          ${pc.dim('— client id + secret, exchanged for a token')}`);
  for (;;) {
    const a = (await ask('Choose', '1')).trim();
    if (a === '1') return 'static';
    if (a === '2') return 'client-credentials';
    console.log(pc.yellow('  Enter 1 or 2.'));
  }
}

// ---------------------------------------------------------------------------
// Patch builders
// ---------------------------------------------------------------------------

function buildEsPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.indexPattern && !opts.indexPatterns?.length) {
    throw new Error('Index pattern is required for elasticsearch');
  }
  const patch: Record<string, unknown> = {};
  // indexPatterns (array) takes precedence over the legacy indexPattern string.
  if (opts.indexPatterns && opts.indexPatterns.length > 0) {
    patch['indexPatterns'] = opts.indexPatterns;
  } else {
    patch['indexPattern'] = opts.indexPattern;
  }
  if (opts.url) patch['url'] = opts.url;
  if (opts.username) patch['username'] = opts.username;
  if (opts.password) patch['password'] = opts.password;
  if (opts.service) patch['serviceName'] = opts.service;
  return patch;
}

function buildMongoPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.database) throw new Error('Database name is required for mongodb');
  const patch: Record<string, unknown> = { database: opts.database };
  if (opts.url) patch['url'] = opts.url;
  if (opts.collections) {
    patch['collections'] = opts.collections
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }
  return patch;
}

function buildPostgresPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.url) patch['url'] = opts.url;
  if (opts.schema) patch['schema'] = opts.schema;
  if (opts.tables) {
    patch['tables'] = opts.tables
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return patch;
}

function buildSentryPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.org) patch['org'] = opts.org;
  if (opts.project) patch['project'] = opts.project;
  if (opts.authToken) patch['authToken'] = opts.authToken;
  // Only persist a non-default base URL (self-hosted Sentry).
  if (opts.url && opts.url.replace(/\/$/, '') !== 'https://sentry.io') patch['url'] = opts.url;
  return patch;
}

function buildAxiomPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.dataset) throw new Error('Dataset is required for axiom');
  const patch: Record<string, unknown> = { dataset: opts.dataset };
  if (opts.token) patch['token'] = opts.token;
  // Only persist a non-default base URL (EU region / self-hosted).
  if (opts.url && opts.url.replace(/\/$/, '') !== 'https://api.axiom.co') patch['url'] = opts.url;
  return patch;
}

function buildShopifyPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.store) throw new Error('Store is required for shopify');
  const patch: Record<string, unknown> = { store: opts.store };
  if (opts.apiVersion) patch['apiVersion'] = opts.apiVersion;
  if (opts.accessId) patch['accessId'] = opts.accessId;
  // `secret` is routed to encrypted storage by CONNECTOR_SECRET_FIELDS.shopify.
  if (opts.secret) patch['secret'] = opts.secret;
  return patch;
}

function buildGrafanaPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.url) patch['url'] = opts.url;
  if (opts.username) patch['username'] = opts.username;
  if (opts.password) patch['password'] = opts.password;
  // dashboardUids (array) takes precedence over the legacy dashboard string.
  if (opts.dashboardUids && opts.dashboardUids.length > 0) {
    patch['dashboards'] = opts.dashboardUids;
  } else if (opts.dashboard) {
    patch['dashboard'] = opts.dashboard;
  }
  return patch;
}

function buildRedisPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.url) patch['url'] = opts.url;
  const dbs = opts.redisDatabases ?? (opts.db ? opts.db.map(parseDbSpec) : undefined);
  if (dbs && dbs.length > 0) {
    const prefix = opts.bullmqPrefix ?? 'bull';
    patch['databases'] = dbs.map((d) => {
      const isQueue = d.roles.some((r) => r === 'bullmq' || r === 'queues');
      return {
        db: d.db,
        ...(d.name ? { name: d.name } : {}),
        roles: d.roles,
        ...(isQueue ? { bullmq: { prefix } } : {}),
      };
    });
  }
  return patch;
}

/** Interactive: ask whether to scan DBs 0–15. */
async function askScanDbs(): Promise<boolean> {
  const answer = (await ask('Scan Redis DBs 0-15 to detect queues vs cache?', 'yes', false))
    .trim()
    .toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

/** Format a probe result as a one-line summary for display. */
function describeProbe(p: RedisDbProbe): string {
  if (!p.reachable) return `unreachable (${p.detail ?? 'error'})`;
  if (p.keyCount === 0) return 'empty';
  if (p.bullmqQueues.length > 0) {
    const sample = p.bullmqQueues.slice(0, 3).join(', ');
    return `${p.bullmqQueues.length} BullMQ queue(s) · prefix ${p.bullmqPrefix} · ${sample}`;
  }
  const examples = p.prefixes.slice(0, 3).map((x) => `${x.prefix}:*`).join(', ');
  return `${p.keyCount} keys · ${p.suggestedRoles.join('/')}${examples ? ` · ${examples}` : ''}`;
}

/** Interactive: probe DBs 0–15, show findings, let the user pick which to save. */
async function discoverAndSelectDbs(url: string, bullmqPrefix: string): Promise<RedisDatabaseSpec[]> {
  console.log(pc.dim('\n  Scanning DBs 0-15 (read-only, sampled)…'));
  const probes = await probeRedisDatabases(url, { bullmqPrefix });
  const nonEmpty = probes.filter((p) => p.reachable && p.keyCount > 0);
  if (nonEmpty.length === 0) {
    console.log(pc.dim('  No populated DBs found.'));
    return [];
  }
  for (const p of nonEmpty) {
    console.log(`  ${pc.bold(`DB ${p.db}`)} ${pc.dim('· ' + describeProbe(p))}`);
  }
  const byLabel = new Map<string, RedisDbProbe>();
  const choices = nonEmpty.map((p) => {
    const label = `DB ${p.db} — ${p.suggestedRoles.join('/') || 'unrolled'} (${describeProbe(p)})`;
    byLabel.set(label, p);
    return label;
  });
  let selected: string[];
  try {
    selected = await checkboxSearch({ message: 'Select DBs to save', choices, pageSize: 12 });
  } catch (err) {
    if (err instanceof ExitPromptError) throw err;
    selected = choices; // non-interactive fallback: save all detected
  }
  return selected.map((label) => {
    const p = byLabel.get(label)!;
    return { db: p.db, name: p.suggestedRoles.includes('bullmq') ? 'queues' : 'cache', roles: p.suggestedRoles };
  });
}

// ---------------------------------------------------------------------------
// Live probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  detail: string;
}

async function probe(type: ConnectorType, opts: ConnectOpts): Promise<ProbeResult> {
  try {
    switch (type) {
      case 'elasticsearch': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const client = new ElasticsearchClient({
          baseUrl: opts.url,
          username: opts.username,
          password: opts.password,
        });
        // AbortController cancels the fetch and clears the timer so nothing
        // keeps the process alive after the probe resolves either way.
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new Error('timed out after 8s')),
          8000,
        );
        try {
          return await client.health(controller.signal);
        } catch (err) {
          const msg = controller.signal.aborted
            ? 'timed out after 8s'
            : (err as Error).message;
          return { ok: false, detail: msg };
        } finally {
          clearTimeout(timer);
        }
      }
      case 'mongodb': {
        if (!opts.url || !opts.database) return { ok: true, detail: 'skipped (no URL)' };
        // The MongoStateClient already sets serverSelectionTimeoutMS: 5000 in the
        // driver — rely on that for the deadline; just ensure close() runs.
        const client = new MongoStateClient({
          url: opts.url,
          database: opts.database,
          allowlist: opts.collections
            ? opts.collections
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean)
            : [],
        });
        try {
          return await client.health();
        } finally {
          await client.close();
        }
      }
      case 'postgres': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const client = new PostgresStateClient({
          url: opts.url,
          schema: opts.schema,
          allowlist: opts.tables
            ? opts.tables.split(',').map((t) => t.trim()).filter(Boolean)
            : [],
        });
        try {
          return await client.health();
        } finally {
          await client.close();
        }
      }
      case 'sentry': {
        if (!opts.authToken || !opts.org || !opts.project) {
          return { ok: true, detail: 'skipped (missing org/project/token)' };
        }
        const client = new SentryClient({
          authToken: opts.authToken,
          org: opts.org,
          project: opts.project,
          ...(opts.url ? { baseUrl: opts.url } : {}),
        });
        return client.health();
      }
      case 'axiom': {
        if (!opts.token || !opts.dataset) {
          return { ok: true, detail: 'skipped (missing dataset/token)' };
        }
        const client = new AxiomClient({
          token: opts.token,
          dataset: opts.dataset,
          ...(opts.url ? { baseUrl: opts.url } : {}),
        });
        return client.health();
      }
      case 'shopify': {
        if (!opts.store || !opts.secret) {
          return { ok: true, detail: 'skipped (missing store/secret)' };
        }
        // Auth liveness — runs the Client-Credentials grant; embeds no GraphQL query.
        const client = new ShopifyAdminClient({
          store: opts.store,
          secret: opts.secret,
          ...(opts.accessId ? { accessId: opts.accessId } : {}),
          ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}),
        });
        return client.health();
      }
      case 'grafana': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (opts.username && opts.password) {
          const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString(
            'base64',
          );
          headers['Authorization'] = `Basic ${encoded}`;
        }
        const res = await fetch(`${opts.url.replace(/\/$/, '')}/api/health`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { ok: true, detail: 'Grafana API reachable' };
        return { ok: false, detail: `HTTP ${res.status}` };
      }
      case 'redis': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        // Real PING (exercises AUTH), not just a TCP open — so wrong passwords are
        // caught here instead of surfacing later as a confusing runtime failure.
        const client = new RedisScanClient({ url: opts.url });
        try {
          const h = await client.health();
          const host = new URL(opts.url).hostname;
          const port = new URL(opts.url).port || '6379';
          if (h.ok) return { ok: true, detail: `PING ok at ${host}:${port}` };
          const authFailed = /WRONGPASS|NOAUTH|invalid password/i.test(h.detail);
          return { ok: false, detail: authFailed ? `auth failed (${h.detail})` : h.detail };
        } finally {
          await client.close();
        }
      }
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createConnection } = require('node:net') as typeof import('node:net');
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(type: ConnectorType, opts: ConnectOpts): void {
  const lines: string[] = [];
  if (opts.url) lines.push(`  url:            ${redactUrl(opts.url)}`);
  if (opts.username) lines.push(`  username:       ${opts.username}`);
  if (opts.password)
    lines.push(`  password:       ${'•'.repeat(Math.min(opts.password.length, 8))}`);
  if (opts.indexPatterns && opts.indexPatterns.length > 0) {
    lines.push(`  index-patterns: ${opts.indexPatterns.join(', ')}`);
  } else if (opts.indexPattern) {
    lines.push(`  index-pattern:  ${opts.indexPattern}`);
  }
  if (opts.service) lines.push(`  service:        ${opts.service}`);
  if (opts.database) lines.push(`  database:       ${opts.database}`);
  if (opts.collections) lines.push(`  collections:    ${opts.collections}`);
  if (opts.org) lines.push(`  org:            ${opts.org}`);
  if (opts.project) lines.push(`  project:        ${opts.project}`);
  if (opts.dataset) lines.push(`  dataset:        ${opts.dataset}`);
  if (opts.store) lines.push(`  store:          ${opts.store}`);
  if (opts.apiVersion) lines.push(`  api-version:    ${opts.apiVersion}`);
  if (opts.accessId) lines.push(`  access-id:      ${opts.accessId}`);
  if (opts.secret)
    lines.push(`  secret:         ${'•'.repeat(Math.min(opts.secret.length, 8))}`);
  if (opts.authToken)
    lines.push(`  auth-token:     ${'•'.repeat(Math.min(opts.authToken.length, 8))}`);
  if (opts.token)
    lines.push(`  token:          ${'•'.repeat(Math.min(opts.token.length, 8))}`);
  if (opts.dashboardUids && opts.dashboardUids.length > 0) {
    lines.push(`  dashboards:     ${opts.dashboardUids.join(', ')}`);
  } else if (opts.dashboard) {
    lines.push(`  dashboard:      ${opts.dashboard}`);
  }
  if (lines.length > 0) console.log(pc.dim(lines.join('\n')));
}

/**
 * Resolve the target environment name the same way patchLocalConnector does:
 * the requested `--env` if given (validated), else the first environment in the
 * config. Keeps the encrypted-secret write and the config patch on the same env.
 */
function resolveEnvName(configPath: string, requested?: string): string {
  const file = readLocalConfig(configPath);
  const project = file.project as { environments?: Array<{ name?: string }> } | undefined;
  const envs = project?.environments ?? [];
  if (requested) {
    if (!envs.some((e) => e.name === requested)) {
      throw new Error(`Environment "${requested}" not found in config.`);
    }
    return requested;
  }
  const first = envs[0]?.name;
  if (!first) throw new Error('No environments found in config.');
  return first;
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** Discover available Elasticsearch index names. Returns [] on any error. */
async function discoverEsIndices(
  url: string | undefined,
  username: string | undefined,
  password: string | undefined,
): Promise<string[]> {
  if (!url) return [];
  try {
    const client = new ElasticsearchClient({ baseUrl: url, username, password });
    const signal = AbortSignal.timeout(8000);
    return await client.listIndices(signal);
  } catch {
    return [];
  }
}

/**
 * Show a numbered list of discovered Elasticsearch indexes and let the user
 * pick one or more by number (comma-separated) or type a pattern manually.
 *
 * Returns the selected index names, or [] if the user skipped / typed manually
 * (the caller falls back to a text prompt in that case).
 */
export async function askIndexSelection(indices: string[]): Promise<string[]> {
  if (isInteractive()) {
    try {
      return await checkboxSearch({
        message: 'Select index patterns to use',
        choices: indices,
        pageSize: 12,
      });
    } catch (err) {
      if (err instanceof ExitPromptError) throw err;
      // If the interactive selector fails for any reason, fall back to plain text.
    }
  }

  const MAX_DISPLAY = 25;
  const shown = indices.slice(0, MAX_DISPLAY);

  console.log('\n  Available Elasticsearch indexes/data streams:');
  shown.forEach((name, i) => {
    console.log(`  ${pc.dim(`[${i + 1}]`)} ${name}`);
  });
  if (indices.length > MAX_DISPLAY) {
    console.log(
      pc.dim(
        `  … and ${indices.length - MAX_DISPLAY} more (type a pattern manually to match all)`,
      ),
    );
  }

  const input = (
    await ask(
      `  Select index patterns to use (e.g. 1,2 or Enter to type pattern manually)`,
      '',
      false,
    )
  ).trim();

  if (!input) return [];

  // If the input looks like numbers (e.g. "1,2,3"), parse as selection.
  if (/^[\d,\s]+$/.test(input)) {
    const picks = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < shown.length)
      .map((i) => shown[i] as string);
    if (picks.length > 0) return picks;
  }

  // Non-numeric input: treat as a manually-typed pattern; signal caller to use it.
  // Return a synthetic single-element array so the caller stores it as indexPatterns.
  return [input];
}

/** Discover available Grafana dashboards. Returns [] on any error. */
async function discoverGrafanaDashboards(
  url: string | undefined,
  username: string | undefined,
  password: string | undefined,
): Promise<{ uid: string; title: string; folderTitle?: string }[]> {
  if (!url) return [];
  try {
    const client = new GrafanaClient({ baseUrl: url, username, password });
    const signal = AbortSignal.timeout(8000);
    return await client.searchDashboards(undefined, signal);
  } catch {
    return [];
  }
}

/**
 * Show a numbered list of discovered Grafana dashboards and let the user
 * pick one or more by number. Returns selected dashboard objects, or [] if
 * the user skipped (caller falls back to manual UID prompt).
 */
export async function askDashboardSelection(
  dashboards: { uid: string; title: string; folderTitle?: string }[],
): Promise<{ uid: string; title: string }[]> {
  if (isInteractive()) {
    try {
      const selected = await checkboxSearch({
        message: 'Select dashboards to use',
        choices: dashboards.map((d) => d.title),
        pageSize: 12,
      });
      return dashboards.filter((d) => selected.includes(d.title));
    } catch (err) {
      if (err instanceof ExitPromptError) throw err;
      // Fall back to plain text on unexpected failures.
    }
  }

  const MAX_DISPLAY = 25;
  const shown = dashboards.slice(0, MAX_DISPLAY);

  console.log('\n  Available Grafana dashboards:');
  shown.forEach((d, i) => {
    const folder = d.folderTitle ? pc.dim(` (${d.folderTitle})`) : '';
    console.log(`  ${pc.dim(`[${i + 1}]`)} ${d.title}${folder}`);
  });
  if (dashboards.length > MAX_DISPLAY) {
    console.log(pc.dim(`  … and ${dashboards.length - MAX_DISPLAY} more`));
  }

  const input = (
    await ask(
      `  Select dashboards to use (e.g. 1,2 or Enter to type uid manually)`,
      '',
      false,
    )
  ).trim();

  if (!input) return [];

  if (/^[\d,\s]+$/.test(input)) {
    const picks = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < shown.length)
      .map((i) => shown[i] as { uid: string; title: string });
    return picks;
  }

  return [];
}

/**
 * Single-select the Axiom server / region. Presents US / EU / Custom URL and
 * resolves the choice to a base URL. "Custom URL…" then prompts for the URL.
 * In a non-interactive context, defaults to the US region.
 */
export async function askAxiomRegion(): Promise<string> {
  const US = 'US — api.axiom.co';
  const EU = 'EU — api.eu.axiom.co';
  const CUSTOM = 'Custom URL…';
  const US_URL = 'https://api.axiom.co';
  const EU_URL = 'https://api.eu.axiom.co';

  let choice = US;
  if (isInteractive()) {
    try {
      choice = await selectSearch({
        message: 'Axiom server / region',
        choices: [US, EU, CUSTOM],
        pageSize: 3,
      });
    } catch (err) {
      if (err instanceof ExitPromptError) throw err;
      // Fall back to the default region on unexpected selector failures.
      return US_URL;
    }
  } else {
    return US_URL;
  }

  if (choice === EU) return EU_URL;
  if (choice === CUSTOM) {
    return (await ask('Custom Axiom base URL', US_URL)) || US_URL;
  }
  return US_URL;
}

/**
 * Show discovered Axiom dataset names and let the user pick exactly ONE
 * (mirrors askIndexSelection, but single-select). Returns the chosen name, or
 * undefined if the user skipped (caller falls back to a manual text prompt).
 */
export async function askDatasetSelection(names: string[]): Promise<string | undefined> {
  if (names.length === 0) return undefined;

  if (isInteractive()) {
    try {
      return await selectSearch({
        message: 'Select an Axiom dataset',
        choices: names,
        pageSize: 12,
      });
    } catch (err) {
      if (err instanceof ExitPromptError) throw err;
      // Fall back to plain text on unexpected selector failures.
    }
  }

  const MAX_DISPLAY = 25;
  const shown = names.slice(0, MAX_DISPLAY);

  console.log('\n  Available Axiom datasets:');
  shown.forEach((name, i) => {
    console.log(`  ${pc.dim(`[${i + 1}]`)} ${name}`);
  });
  if (names.length > MAX_DISPLAY) {
    console.log(pc.dim(`  … and ${names.length - MAX_DISPLAY} more`));
  }

  const input = (
    await ask('  Select a dataset (e.g. 1 or Enter to type a name manually)', '', false)
  ).trim();

  if (!input) return undefined;

  // Numeric input: treat as a 1-based pick from the displayed list.
  if (/^\d+$/.test(input)) {
    const idx = parseInt(input, 10) - 1;
    if (idx >= 0 && idx < shown.length) return shown[idx];
  }

  // Otherwise treat the input as a manually-typed dataset name.
  return input;
}

// ---------------------------------------------------------------------------
// Redis credential helpers
// ---------------------------------------------------------------------------

/** Returns true when the Redis URL already has a password in the authority. */
function redisUrlHasPassword(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return new URL(raw).password !== '';
  } catch {
    return false;
  }
}

/**
 * Inject a password into a Redis URL that has no credentials.
 * Produces `redis://:password@host:port/db`.
 */
function injectRedisPassword(raw: string, password: string): string {
  try {
    const u = new URL(raw);
    u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    // Not parseable — try naive string splice after the scheme
    const match = /^(rediss?:\/\/)(.*)$/.exec(raw);
    if (match?.[1] && match?.[2]) {
      return `${match[1]}:${encodeURIComponent(password)}@${match[2]}`;
    }
    return raw;
  }
}

/** Redact `user:pass@` from a URL before displaying it. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    // Not a valid URL (e.g. a bare hostname) — return as-is; no userinfo to strip.
    return raw;
  }
}
