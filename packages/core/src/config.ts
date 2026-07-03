import { z } from 'zod';
import { createJiti } from 'jiti';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  discoverLocalConfig,
  findRepoRoot,
  lookupProject,
  readLocalConfig,
  readLocalSecrets,
  decryptConnectorSecrets,
} from './discovery.js';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

/**
 * Horus configuration schema. Loaded from `config/horus.config.ts` (or a path given
 * to `loadConfig`). Validated with zod so a malformed config fails at startup with a
 * clear message rather than deep in the pipeline.
 *
 * HOR-34: Config is now project/environment scoped. No connector may run without an
 * explicit project/env scope; the old global `providers` block is gone.
 */

// ---------------------------------------------------------------------------
// Repository schema (CODE — belongs to the PROJECT, served by source-intelligence backend)
// ---------------------------------------------------------------------------

const repositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /**
   * Horus source-intelligence backend host for this repository.
   * `source.hostUrl` is the canonical key (HOR-137).
   * When absent/unreachable, source context, impact, change analysis, and queue
   * stitching degrade — runtime evidence still works.
   */
  source: z.object({ hostUrl: z.string().url() }).optional(),
});

// ---------------------------------------------------------------------------
// Connector-level schemas (RUNTIME — belong to the ENVIRONMENT)
// ---------------------------------------------------------------------------

/**
 * Roles a Redis logical DB can play (HOR-201). `bullmq`/`queues` mark a queue DB
 * (used by `horus queues --live`); `cache`/`state`/`locks`/`rate-limit`/`session`/
 * `dedupe` mark runtime-state DBs that investigation collectors may sample.
 */
export const REDIS_ROLES = [
  'cache',
  'state',
  'locks',
  'rate-limit',
  'session',
  'dedupe',
  'bullmq',
  'queues',
] as const;
export type RedisRole = (typeof REDIS_ROLES)[number];
const redisRoleSchema = z.enum(REDIS_ROLES);
/** Roles that mark a DB as holding BullMQ queues. */
export const REDIS_QUEUE_ROLES: readonly RedisRole[] = ['bullmq', 'queues'];

/** Parse the logical DB index from a redis URL path (`redis://h:p/1` → 1); defaults to 0. */
export function redisDbFromUrl(url: string | undefined): number {
  if (!url) return 0;
  try {
    const seg = new URL(url).pathname.replace(/^\//, '');
    const n = Number.parseInt(seg, 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Return `url` with its DB-index path set to `db`, for selecting a logical DB. */
export function redisUrlForDb(url: string, db: number): string {
  try {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  } catch {
    return url;
  }
}

const connectorsSchema = z
  .object({
    elasticsearch: z
      .object({
        indexPattern: z.string().optional(),
        /** Multiple index patterns — joined with ',' when resolving. Takes precedence over indexPattern. */
        indexPatterns: z.array(z.string()).optional(),
        serviceName: z.string().optional(),
        /**
         * Log schema preset. Controls which Elasticsearch field names Horus
         * queries for timestamps, levels, service names, and event codes.
         *
         * - 'meritt' (default): pino-based Meritt shared logger
         *   (time, level numeric, service_name, event_code)
         * - 'ecs': Elastic Common Schema
         *   (@timestamp, log.level string, service.name, event.code)
         *
         * Use `fields` to override individual field names when neither preset
         * matches your schema (Pino with custom keys, legacy formats, etc.).
         */
        preset: z.enum(['meritt', 'ecs']).default('meritt'),
        /**
         * Per-field overrides merged on top of the selected preset.
         * Only the fields you specify are changed; the rest come from the preset.
         */
        fields: z
          .object({
            timestamp: z.string().optional(),
            level: z.string().optional(),
            levelFormat: z.enum(['numeric', 'string']).optional(),
            service: z.string().optional(),
            serviceKeyword: z.boolean().optional(),
            message: z.string().optional(),
            messageFallback: z.string().optional(),
            traceId: z.string().optional(),
            requestId: z.string().optional(),
            eventCode: z.string().optional(),
            eventCodeKeyword: z.boolean().optional(),
          })
          .optional(),
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the ES base URL. Defaults to "ES_URL". */
        urlEnv: z.string().optional(),
        /** Direct username value (takes priority over usernameEnv). */
        username: z.string().optional(),
        /** Name of the env var holding the ES username. Defaults to "ES_USERNAME". */
        usernameEnv: z.string().optional(),
        /** Direct password value (takes priority over passwordEnv). */
        password: z.string().optional(),
        /** Name of the env var holding the ES password. Defaults to "ES_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    mongodb: z
      .object({
        database: z.string(),
        collections: z.array(z.string()).default([]),
        /** Direct connection string (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the MongoDB URL. Defaults to "MONGODB_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    postgres: z
      .object({
        /** Schema to introspect (default: "public"). */
        schema: z.string().optional(),
        /** Logical database label for evidence provenance (optional). */
        database: z.string().optional(),
        /** Allowlisted tables to analyze (empty = auto-discover all base tables). */
        tables: z.array(z.string()).default([]),
        /** Direct connection string (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the Postgres URL. Defaults to "DATABASE_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    /**
     * Sentry error-tracking connector (HOR-CONNECTORS). Grouped exceptions (issues)
     * become ERROR evidence: title + culprit + count + frequency + last-seen, plus a
     * direct code seed from the top in-app stack frame of the latest event.
     */
    sentry: z
      .object({
        /** Sentry org slug. */
        org: z.string(),
        /** Sentry project slug. */
        project: z.string(),
        /** Direct API auth token (takes priority over authTokenEnv). */
        authToken: z.string().optional(),
        /** Env var holding the auth token. Defaults to "SENTRY_AUTH_TOKEN". */
        authTokenEnv: z.string().optional(),
        /** Direct base URL (self-hosted). Takes priority over urlEnv. Defaults to https://sentry.io. */
        url: z.string().optional(),
        /** Env var holding the base URL. Defaults to "SENTRY_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    /**
     * Axiom logs connector (HOR-429). Structured log rows queried with APL become
     * `kind: 'log'` evidence (message + level + fields), alongside Elasticsearch.
     */
    axiom: z
      .object({
        /** Dataset to query (the Axiom analogue of an ES index). */
        dataset: z.string(),
        /** Direct API token (takes priority over tokenEnv). */
        token: z.string().optional(),
        /** Env var holding the API token. Defaults to "AXIOM_TOKEN". */
        tokenEnv: z.string().optional(),
        /** Direct base URL (US default https://api.axiom.co; EU https://api.eu.axiom.co). Takes priority over urlEnv. */
        url: z.string().optional(),
        /** Env var holding the base URL. Defaults to "AXIOM_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    /**
     * Shopify Admin connector — a first-class evidence source for the investigation
     * engine. The connector embeds NO queries: the GraphQL document is supplied by the
     * caller at investigation time (`--shopify-query`) and/or declared here as named
     * default queries that `horus watch` (which has no agent to pass a flag) runs each
     * cycle. Auth is a read-only Client-Credentials grant: `accessId` is the app
     * `client_id` (readable), `secret` is the `client_secret` (encrypted at rest).
     */
    shopify: z
      .object({
        /** Store subdomain, e.g. "my-store" — `.myshopify.com` is added automatically (a full domain is also accepted). */
        store: z.string(),
        /** Admin API version segment, e.g. "2025-10". Defaults when omitted. */
        apiVersion: z.string().optional(),
        /** App client_id (Client-Credentials grant). Takes priority over accessIdEnv. */
        accessId: z.string().optional(),
        /** Env var holding the client_id. Defaults to "SHOPIFY_ACCESS_ID". */
        accessIdEnv: z.string().optional(),
        /** App client_secret (encrypted at rest). Takes priority over secretEnv. */
        secret: z.string().optional(),
        /** Env var holding the client_secret. Defaults to "SHOPIFY_SECRET". */
        secretEnv: z.string().optional(),
        /**
         * Default named GraphQL queries run when no `--shopify-query` is supplied at
         * invocation (notably by `horus watch`). Each result set becomes Evidence. The
         * query text is authored by the operator, executed verbatim — never built in code.
         */
        queries: z
          .array(
            z.object({
              /** Label for provenance + the evidence title. */
              name: z.string(),
              /** Verbatim Admin GraphQL query document (read-only). */
              query: z.string(),
              /** Static variables merged under any engine-bound window variables. */
              variables: z.record(z.unknown()).optional(),
              /** EvidenceKind to map results onto (constrained to the existing union). */
              kind: z.enum(['state', 'log', 'metric']).default('state'),
              /** Base relevance seed (0–1) before hint-term weighting. */
              relevance: z.number().min(0).max(1).optional(),
              /** Inject the investigation window as `$from`/`$to` variables when declared. */
              bindWindow: z.boolean().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    grafana: z
      .object({
        dashboard: z.string().optional(),
        /** Multiple dashboard UIDs to fetch. Takes precedence over `dashboard` when set. */
        dashboards: z.array(z.string()).optional(),
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the Grafana base URL. Defaults to "GRAFANA_URL". */
        urlEnv: z.string().optional(),
        /** Direct username value (takes priority over usernameEnv). */
        username: z.string().optional(),
        /** Name of the env var holding the Grafana username. Defaults to "GRAFANA_USER". */
        usernameEnv: z.string().optional(),
        /** Direct password value (takes priority over passwordEnv). */
        password: z.string().optional(),
        /** Name of the env var holding the Grafana password. Defaults to "GRAFANA_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    redis: z
      .object({
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the Redis URL. Defaults to "REDIS_URL". */
        urlEnv: z.string().optional(),
        /**
         * Logical databases on the same Redis server (HOR-201). Redis is a general
         * runtime-evidence connector — a single server commonly holds BullMQ queues in
         * one DB and cache/locks/rate-limit/session keys in others. Declaring them here
         * (with roles) lets `queues --live` target the queue DB and lets investigation
         * collectors target cache/state/locks DBs. When omitted, the DB index in `url`
         * (default 0) is treated as a single configured database (backward compatible).
         */
        databases: z
          .array(
            z.object({
              /** Logical DB index on the server (0–15 by default Redis config). */
              db: z.number().int().min(0).max(15),
              /** Friendly name for display (e.g. "cache", "queues"). */
              name: z.string().optional(),
              /** What this DB holds — drives which collectors/commands use it. */
              roles: z.array(redisRoleSchema).default([]),
              /** BullMQ settings when this DB has the bullmq/queues role. */
              bullmq: z.object({ prefix: z.string().default('bull') }).optional(),
              /** Sampled-scan settings for cache/state/locks DBs. */
              scan: z
                .object({
                  enabled: z.boolean().default(true),
                  sampleLimit: z.number().int().positive().default(500),
                  patterns: z.array(z.string()).default([]),
                })
                .optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .default({});

/**
 * Outbound notify sink (HOR-454). When `horus watch` auto-investigates a new incident and the
 * result clears `minConfidence`, the headline is dispatched here. CLI/notify-layer only — the
 * deterministic engine never sees this. Both targets are optional; absent `notify` = no dispatch.
 */
const notifySchema = z
  .object({
    /** Only dispatch when an auto-investigation's confidence is >= this (0..1). Default 0.6. */
    minConfidence: z.number().min(0).max(1).default(0.6),
    /** Generic outbound webhook (Slack-compatible JSON, HMAC-signed when `secret` is set). */
    webhook: z
      .object({
        url: z.string().url(),
        /** HMAC-SHA256 signing secret; when set, payloads carry an `X-Horus-Signature` header. */
        secret: z.string().min(1).optional(),
      })
      .optional(),
    /** Also push the headline to Horus Cloud (uses the existing cloud session, if signed in). */
    cloud: z.boolean().default(false),
  })
  .optional();

const environmentSchema = z.object({
  name: z.string().min(1),
  readOnly: z.boolean().default(true),
  connectors: connectorsSchema,
  notify: notifySchema,
});

const projectSchema = z.object({
  name: z.string().min(1),
  /** Code repositories (with their source-intelligence hosts) — code belongs to the project. */
  repositories: z.array(repositorySchema).min(1),
  /** Runtime environments — runtime systems belong to the environment. */
  environments: z.array(environmentSchema).min(1),
});

const databaseSchema = z.object({
  /** Postgres connection string. Plain Postgres — no pgvector in v0. */
  url: z.string().min(1),
});

const modelsSchema = z.object({
  reasoning: z.string().default('claude-opus-4-8'),
  extraction: z.string().default('claude-haiku-4-5'),
});

/** AI providers a user can connect (HOR-206). */
export const AI_PROVIDERS = ['anthropic', 'claude', 'codex', 'gemini', 'kimi', 'cursor'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * AI narrative configuration (HOR-206). Lets `horus investigate --ai` work without
 * the user editing shell env: the Anthropic API key (and preferred provider) can be
 * saved via `horus connect ai`. Secrets resolve from config first, then env.
 */
const aiSchema = z
  .object({
    /** Preferred provider for AI narrative. */
    provider: z.enum(AI_PROVIDERS).optional(),
    anthropic: z
      .object({
        /** Direct API key (takes priority over apiKeyEnv). Stored redacted in display. */
        apiKey: z.string().optional(),
        /** Env var holding the key. Defaults to ANTHROPIC_API_KEY. */
        apiKeyEnv: z.string().optional(),
        /** Default model for narrative generation. */
        model: z.string().optional(),
      })
      .optional(),
  })
  .optional();

export const horusConfigSchema = z.object({
  projects: z.array(projectSchema).default([]),
  database: databaseSchema,
  models: modelsSchema.default({}),
  ai: aiSchema,
});

export interface ResolvedAiSettings {
  provider?: AiProvider;
  /** Resolved Anthropic API key (config value or env fallback), if any. */
  anthropicApiKey?: string;
  /** Whether the key came from config (vs env) — drives doctor's "configured" wording. */
  anthropicKeyFromConfig: boolean;
  model?: string;
}

/** Resolve AI settings: config key first, then the ANTHROPIC_API_KEY env fallback. */
export function resolveAiSettings(config: HorusConfig): ResolvedAiSettings {
  const ai = config.ai;
  const fromConfig = ai?.anthropic?.apiKey;
  const key = fromConfig ?? process.env[ai?.anthropic?.apiKeyEnv ?? 'ANTHROPIC_API_KEY'];
  const out: ResolvedAiSettings = { anthropicKeyFromConfig: fromConfig !== undefined };
  if (ai?.provider !== undefined) out.provider = ai.provider;
  if (key !== undefined) out.anthropicApiKey = key;
  if (ai?.anthropic?.model !== undefined) out.model = ai.anthropic.model;
  return out;
}

/**
 * Which fields of each connector are SECRETS (HOR-452). These never live in
 * config.json — `horus connect` encrypts them into `.horus/secrets.local.json`
 * and they are decrypted back into the in-memory config at load. Connection URLs
 * for mongo/postgres/redis are secrets because they embed credentials; ES and
 * Grafana keep their (non-secret) endpoint URL in config and encrypt only
 * username/password.
 */
export const CONNECTOR_SECRET_FIELDS: Record<string, readonly string[]> = {
  elasticsearch: ['username', 'password'],
  mongodb: ['url'],
  postgres: ['url'],
  sentry: ['authToken'],
  axiom: ['token'],
  grafana: ['username', 'password'],
  redis: ['url'],
  shopify: ['secret'],
};

/** True if `field` is a secret for `connector` (see CONNECTOR_SECRET_FIELDS). */
export function isSecretField(connector: string, field: string): boolean {
  return CONNECTOR_SECRET_FIELDS[connector]?.includes(field) ?? false;
}

/**
 * Scan a raw local config object for connector secret fields stored as plaintext
 * direct values (the legacy/insecure shape). Returns `env/connector.field`
 * locators. Used by `horus doctor` and `horus secrets migrate`.
 */
export function findPlaintextConnectorSecrets(project: unknown): string[] {
  const out: string[] = [];
  const envs = (project as { environments?: Array<Record<string, unknown>> } | undefined)
    ?.environments;
  if (!Array.isArray(envs)) return out;
  for (const env of envs) {
    const envName = (env['name'] as string | undefined) ?? '(unnamed)';
    const connectors = env['connectors'] as Record<string, unknown> | undefined;
    if (!connectors || typeof connectors !== 'object') continue;
    for (const [connector, cfg] of Object.entries(connectors)) {
      if (!cfg || typeof cfg !== 'object') continue;
      for (const field of CONNECTOR_SECRET_FIELDS[connector] ?? []) {
        const val = (cfg as Record<string, unknown>)[field];
        if (typeof val === 'string' && val.length > 0) {
          out.push(`${envName}/${connector}.${field}`);
        }
      }
    }
  }
  return out;
}

export type HorusConfig = z.infer<typeof horusConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type ConnectorsConfig = z.infer<typeof connectorsSchema>;
export type NotifyConfig = NonNullable<z.infer<typeof notifySchema>>;

// ---------------------------------------------------------------------------
// Resolved environment types (runtime, with secrets read from process.env)
// ---------------------------------------------------------------------------

export interface ResolvedRepository {
  name: string;
  path: string;
  /** Canonical Horus-owned source-intelligence host URL (HOR-137). */
  sourceHostUrl?: string;
}

export interface ResolvedElasticsearchFields {
  timestamp?: string;
  level?: string;
  levelFormat?: 'numeric' | 'string';
  service?: string;
  serviceKeyword?: boolean;
  message?: string;
  messageFallback?: string;
  traceId?: string;
  requestId?: string;
  eventCode?: string;
  eventCodeKeyword?: boolean;
}

/**
 * A single Shopify Admin GraphQL query to run as evidence. The `query` text is authored
 * by the operator (config) or supplied by the caller at investigation time — never built
 * in connector code. Shared by resolved config, `InvestigationInput`, and the provider.
 */
export interface ShopifyQuerySpec {
  /** Label for provenance + the evidence title. */
  name: string;
  /** Verbatim Admin GraphQL query document (read-only). */
  query: string;
  /** Static variables, merged under any engine-bound window variables. */
  variables?: Record<string, unknown>;
  /** EvidenceKind results map onto (a member of the existing evidence union). */
  kind: 'state' | 'log' | 'metric';
  /** Base relevance seed (0–1) before hint-term weighting. */
  relevance?: number;
  /** Inject the investigation window as `$from`/`$to` variables when the query declares them. */
  bindWindow?: boolean;
}

export interface ResolvedConnectors {
  elasticsearch?: {
    url: string;
    username?: string;
    password?: string;
    indexPattern: string;
    /** All configured index patterns (populated when indexPatterns was used). */
    indexPatterns?: string[];
    serviceName?: string;
    /** Log schema preset forwarded from config. */
    preset: 'meritt' | 'ecs';
    /** Per-field overrides merged on top of the preset. */
    fields?: ResolvedElasticsearchFields;
  };
  mongodb?: { url?: string; database: string; collections: string[] };
  postgres?: { url?: string; schema?: string; database?: string; tables: string[] };
  sentry?: { authToken?: string; org: string; project: string; url?: string };
  axiom?: { token?: string; dataset: string; url?: string };
  shopify?: {
    store: string;
    apiVersion?: string;
    accessId?: string;
    secret?: string;
    queries?: ShopifyQuerySpec[];
  };
  grafana?: {
    url?: string;
    username?: string;
    password?: string;
    dashboard?: string;
    /** All configured dashboard UIDs (populated when dashboards was used). */
    dashboards?: string[];
  };
  redis?: {
    /** Base server URL (auth + host + port). The DB index in the path is captured
     *  per-database in `databases`; consumers pick the DB they need. */
    url?: string;
    /** Logical databases on this server. Always at least one entry when redis is
     *  configured (synthesized from the URL for backward compatibility). */
    databases: ResolvedRedisDatabase[];
  };
}

export interface ResolvedRedisDatabase {
  db: number;
  name?: string;
  roles: RedisRole[];
  /** BullMQ key prefix for this DB (default "bull"). */
  bullmqPrefix: string;
  scan?: { enabled: boolean; sampleLimit: number; patterns: string[] };
}

export interface ResolvedEnvironment {
  project: string;
  env: string;
  readOnly: boolean;
  /** Code repositories for the project (with their source-intelligence hosts). */
  repositories: ResolvedRepository[];
  /** Primary repository path (first repo) — convenience for git-based commands. */
  path: string;
  connectors: ResolvedConnectors;
  /** Outbound notify sink for `horus watch` (HOR-454); absent when not configured. */
  notify?: NotifyConfig;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Flatten all configured project/env pairs (for help text / matrix display). */
export function listEnvironments(config: HorusConfig): { project: string; env: string }[] {
  const out: { project: string; env: string }[] = [];
  for (const p of config.projects) {
    for (const e of p.environments) {
      out.push({ project: p.name, env: e.name });
    }
  }
  return out;
}

/**
 * Resolve a concrete environment from the config, reading connector secrets from
 * `process.env`. Throws a descriptive Error if resolution is ambiguous.
 *
 * Selection rules:
 * - project: use `opts.project` if given; else the single configured project; else
 *   infer from the current repo (a project whose repository path contains `opts.cwd`);
 *   else throw.
 * - env: use `opts.env` if given; else the single env; else the one named "production"; else throw.
 */
export function resolveEnvironment(
  config: HorusConfig,
  opts?: { project?: string; env?: string; cwd?: string },
): ResolvedEnvironment {
  // --- pick project ---
  let project: ProjectConfig;
  if (opts?.project !== undefined) {
    const found = config.projects.find((p) => p.name === opts.project);
    if (found === undefined) {
      const names = config.projects.map((p) => p.name).join(', ');
      throw new Error(
        `Unknown project: ${opts.project} (configured: ${names || 'none'})`,
      );
    }
    project = found;
  } else if (config.projects.length === 1) {
    const p = config.projects[0];
    if (p === undefined) throw new Error('No projects configured.');
    project = p;
  } else {
    // No --project and multiple projects: infer from the current repo by matching
    // its root against a project's repository paths (so `cd repo && horus …` works).
    const cwd = opts?.cwd ?? process.cwd();
    const root = findRepoRoot(cwd) ?? resolve(cwd);
    const matches = config.projects.filter((p) =>
      p.repositories.some((r) => resolve(r.path) === root),
    );
    const inferred = matches[0];
    if (matches.length === 1 && inferred !== undefined) {
      project = inferred;
    } else {
      const names = config.projects.map((p) => p.name).join(', ');
      throw new Error(
        `Multiple projects configured; pass --project <name> (one of: ${names}) ` +
          `— or run from inside a project's repository.`,
      );
    }
  }

  // --- pick environment ---
  let environment: EnvironmentConfig;
  if (opts?.env !== undefined) {
    const found = project.environments.find((e) => e.name === opts.env);
    if (found === undefined) {
      const names = project.environments.map((e) => e.name).join(', ');
      throw new Error(
        `Unknown environment: ${opts.env} in project ${project.name} (one of: ${names})`,
      );
    }
    environment = found;
  } else if (project.environments.length === 1) {
    const e = project.environments[0];
    if (e === undefined) throw new Error(`Project ${project.name} has no environments.`);
    environment = e;
  } else {
    const prod = project.environments.find((e) => e.name === 'production');
    if (prod !== undefined) {
      environment = prod;
    } else {
      const names = project.environments.map((e) => e.name).join(', ');
      throw new Error(
        `Project ${project.name} has multiple environments; pass --env <name> (one of: ${names})`,
      );
    }
  }

  // --- resolve repositories ---
  // `source.hostUrl` is the canonical source-intelligence host (HOR-137).
  const repositories: ResolvedRepository[] = project.repositories.map((r) => {
    const hostUrl = r.source?.hostUrl;
    return {
      name: r.name,
      path: r.path,
      ...(hostUrl ? { sourceHostUrl: hostUrl } : {}),
    };
  });
  const primary = repositories[0];

  // --- resolve connectors (runtime belongs to the environment) ---
  const c = environment.connectors;
  const resolved: ResolvedConnectors = {};

  if (c.elasticsearch !== undefined) {
    const es = c.elasticsearch;
    // Direct value takes priority over env var name.
    const url = es.url ?? process.env[es.urlEnv ?? 'ES_URL'] ?? '';
    // indexPatterns (array) takes precedence; falls back to indexPattern string.
    const effectivePattern = es.indexPatterns?.join(',') ?? es.indexPattern ?? '';
    resolved.elasticsearch = {
      url,
      username: es.username ?? process.env[es.usernameEnv ?? 'ES_USERNAME'],
      password: es.password ?? process.env[es.passwordEnv ?? 'ES_PASSWORD'],
      indexPattern: effectivePattern,
      ...(es.indexPatterns !== undefined ? { indexPatterns: es.indexPatterns } : {}),
      serviceName: es.serviceName,
      preset: es.preset,
      ...(es.fields !== undefined ? { fields: es.fields } : {}),
    };
  }

  if (c.mongodb !== undefined) {
    const m = c.mongodb;
    resolved.mongodb = {
      url: m.url ?? process.env[m.urlEnv ?? 'MONGODB_URL'],
      database: m.database,
      collections: m.collections,
    };
  }

  if (c.postgres !== undefined) {
    const p = c.postgres;
    resolved.postgres = {
      url: p.url ?? process.env[p.urlEnv ?? 'DATABASE_URL'],
      schema: p.schema,
      database: p.database,
      tables: p.tables,
    };
  }

  if (c.sentry !== undefined) {
    const s = c.sentry;
    const authToken = s.authToken ?? process.env[s.authTokenEnv ?? 'SENTRY_AUTH_TOKEN'];
    const url = s.url ?? process.env[s.urlEnv ?? 'SENTRY_URL'];
    resolved.sentry = {
      org: s.org,
      project: s.project,
      ...(authToken !== undefined ? { authToken } : {}),
      ...(url !== undefined ? { url } : {}),
    };
  }

  if (c.axiom !== undefined) {
    const a = c.axiom;
    const token = a.token ?? process.env[a.tokenEnv ?? 'AXIOM_TOKEN'];
    const url = a.url ?? process.env[a.urlEnv ?? 'AXIOM_URL'];
    resolved.axiom = {
      dataset: a.dataset,
      ...(token !== undefined ? { token } : {}),
      ...(url !== undefined ? { url } : {}),
    };
  }

  if (c.shopify !== undefined) {
    const sh = c.shopify;
    const accessId = sh.accessId ?? process.env[sh.accessIdEnv ?? 'SHOPIFY_ACCESS_ID'];
    const secret = sh.secret ?? process.env[sh.secretEnv ?? 'SHOPIFY_SECRET'];
    resolved.shopify = {
      store: sh.store,
      ...(sh.apiVersion !== undefined ? { apiVersion: sh.apiVersion } : {}),
      ...(accessId !== undefined ? { accessId } : {}),
      ...(secret !== undefined ? { secret } : {}),
      ...(sh.queries !== undefined ? { queries: sh.queries } : {}),
    };
  }

  if (c.grafana !== undefined) {
    const g = c.grafana;
    resolved.grafana = {
      url: g.url ?? process.env[g.urlEnv ?? 'GRAFANA_URL'],
      username: g.username ?? process.env[g.usernameEnv ?? 'GRAFANA_USER'],
      password: g.password ?? process.env[g.passwordEnv ?? 'GRAFANA_PASSWORD'],
      dashboard: g.dashboard,
      ...(g.dashboards !== undefined ? { dashboards: g.dashboards } : {}),
    };
  }

  if (c.redis !== undefined) {
    const r = c.redis;
    const url = r.url ?? process.env[r.urlEnv ?? 'REDIS_URL'];
    let databases: ResolvedRedisDatabase[];
    if (r.databases !== undefined && r.databases.length > 0) {
      databases = r.databases.map((d) => ({
        db: d.db,
        ...(d.name !== undefined ? { name: d.name } : {}),
        roles: d.roles,
        bullmqPrefix: d.bullmq?.prefix ?? 'bull',
        ...(d.scan !== undefined
          ? {
              scan: {
                enabled: d.scan.enabled,
                sampleLimit: d.scan.sampleLimit,
                patterns: d.scan.patterns,
              },
            }
          : {}),
      }));
    } else {
      // Backward compatibility: no `databases` declared — treat the DB index from the
      // URL (default 0) as a single configured database. No roles are assumed, so
      // consumers that need a queue DB fall back to this single DB.
      databases = [{ db: redisDbFromUrl(url), roles: [], bullmqPrefix: 'bull' }];
    }
    resolved.redis = {
      ...(url !== undefined ? { url } : {}),
      databases,
    };
  }

  return {
    project: project.name,
    env: environment.name,
    readOnly: environment.readOnly,
    repositories,
    path: primary?.path ?? '',
    connectors: resolved,
    ...(environment.notify !== undefined ? { notify: environment.notify } : {}),
  };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** Helper so config files get full type-checking and inference. */
export function defineConfig(config: HorusConfig): HorusConfig {
  return config;
}

/**
 * Example value hints shown alongside Zod validation errors.
 * Path segments that are array indices are replaced with '*' before lookup.
 */
const CONFIG_EXAMPLES: Record<string, string> = {
  '(root)': 'add `database: { url: "postgresql://..." }` and at least one project',
  'database': 'e.g. database: { url: "postgresql://horus:horus@localhost:5433/horus" }',
  'database.url': 'e.g. "postgresql://horus:horus@localhost:5433/horus"',
  'projects.*.name': 'e.g. name: "my-api"',
  'projects.*.repositories': 'e.g. [{ name: "my-api", path: "/path/to/repo" }]',
  'projects.*.repositories.*.name': 'e.g. name: "my-api"',
  'projects.*.repositories.*.path': 'e.g. path: "/absolute/path/to/repo"',
  'projects.*.repositories.*.source.hostUrl':
    'e.g. "http://127.0.0.1:8420"  (start one with: horus init)',
  'projects.*.environments': 'e.g. [{ name: "production", connectors: {} }]',
  'projects.*.environments.*.name': 'e.g. name: "production"',
  'projects.*.environments.*.connectors.elasticsearch.indexPattern':
    'e.g. indexPattern: "my-api-prod-*"',
};

/** Normalize a Zod issue path to the lookup key (replace numeric indices with '*'). */
function normalizePath(path: (string | number)[]): string {
  if (path.length === 0) return '(root)';
  return path.map((seg) => (typeof seg === 'number' ? '*' : seg)).join('.');
}

/** Validate a raw config object, throwing a readable error on failure. */
function parseConfig(raw: unknown, source: string): HorusConfig {
  const parsed = horusConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => {
        const key = normalizePath(i.path);
        const example = CONFIG_EXAMPLES[key];
        const hint = example ? `  → ${example}` : '';
        return `  • ${key}: ${i.message}${hint ? `\n${hint}` : ''}`;
      })
      .join('\n');
    throw new Error(`Invalid Horus config (${source}):\n${details}`);
  }
  return parsed.data;
}

/**
 * Decrypt connector secrets from `.horus/secrets.local.json` and inject them into
 * the in-memory `project` so resolveEnvironment resolves them as direct values
 * (HOR-452). Only injects into connectors already declared in config — it never
 * fabricates a connector block (that could violate the schema). Best-effort: a
 * blob that cannot be decrypted is skipped with a stderr note.
 */
function hydrateConnectorSecrets(project: unknown, root: string): void {
  const decrypted = decryptConnectorSecrets(root);
  for (const w of decrypted.warnings) {
    process.stderr.write(`horus: skipped encrypted connector secret (${w})\n`);
  }
  if (Object.keys(decrypted.values).length === 0) return;

  const envs = (project as { environments?: Array<Record<string, unknown>> } | undefined)
    ?.environments;
  if (!Array.isArray(envs)) return;
  for (const env of envs) {
    const envName = env['name'] as string | undefined;
    if (!envName) continue;
    const byConnector = decrypted.values[envName];
    if (!byConnector) continue;
    const connectors = env['connectors'] as Record<string, unknown> | undefined;
    if (!connectors || typeof connectors !== 'object') continue;
    for (const [connector, fields] of Object.entries(byConnector)) {
      // HOR-454: the notify webhook signing secret is encrypted under a pseudo-connector
      // namespace "notify" → hydrate it into env.notify.webhook.secret (not env.connectors),
      // so a sensitive secret never sits plaintext in config.json (consistent with HOR-452).
      if (connector === 'notify') {
        const webhook = (env['notify'] as { webhook?: Record<string, unknown> } | undefined)?.webhook;
        const secret = (fields as Record<string, unknown>)['webhookSecret'];
        if (webhook && typeof webhook === 'object' && typeof secret === 'string') {
          webhook['secret'] = secret;
        }
        continue;
      }
      const target = connectors[connector];
      if (!target || typeof target !== 'object') continue; // not declared in config — skip
      for (const [field, value] of Object.entries(fields)) {
        (target as Record<string, unknown>)[field] = value;
      }
    }
  }
}

/** Load a config file by absolute path — JSON, native JS/ESM, or a TS module. */
async function loadConfigFile(target: string): Promise<HorusConfig> {
  if (target.endsWith('.json')) {
    // A local `.horus/config.json` wraps a single project.
    const file = readLocalConfig(target);
    // Hydrate the API key from `.horus/secrets.local.json` (HOR-212) so it never has to
    // live in config.json. The secret is merged into the in-memory ai block only.
    const root = dirname(dirname(target));
    const secrets = readLocalSecrets(root);
    let ai = file.ai as { anthropic?: { apiKey?: string } } | undefined;
    if (secrets.anthropic?.apiKey) {
      ai = { ...(ai ?? {}), anthropic: { ...(ai?.anthropic ?? {}), apiKey: secrets.anthropic.apiKey } };
    }
    // Hydrate encrypted connector secrets (HOR-452) back into the in-memory config
    // so resolveEnvironment sees them as direct values. Never written back to disk.
    hydrateConnectorSecrets(file.project, root);
    const raw = {
      projects: file.project ? [file.project] : [],
      database: file.database ?? {
        url: process.env['DATABASE_URL'] ?? DEFAULT_DB_URL,
      },
      ...(ai !== undefined ? { ai } : {}),
    };
    return parseConfig(raw, target);
  }

  // Native JS/ESM/CJS module — use dynamic import(), no jiti needed.
  // This path works in the built binary without requiring babel.cjs.
  if (target.endsWith('.js') || target.endsWith('.mjs') || target.endsWith('.cjs')) {
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(target).href)) as { default?: unknown };
    } catch (err) {
      throw new Error(
        `Could not load Horus config at ${target}: ${(err as Error).message}`,
      );
    }
    if (!mod.default) {
      throw new Error(`Horus config at ${target} must have a default export.`);
    }
    return parseConfig(mod.default, target);
  }

  // TypeScript config — use jiti. Works in source mode (tsx / ts-node).
  // In the built binary, jiti requires babel.cjs to be resolvable from the
  // config file's directory (i.e. within a project that has jiti in node_modules).
  // For portable use with the curl-installed binary, prefer horus.config.js instead.
  const jiti = createJiti(import.meta.url);
  let mod: { default?: unknown };
  try {
    mod = (await jiti.import(target)) as { default?: unknown };
  } catch (err) {
    throw new Error(
      `Could not load Horus config at ${target}: ${(err as Error).message}`,
    );
  }
  if (!mod.default) {
    throw new Error(`Horus config at ${target} must have a default export.`);
  }
  return parseConfig(mod.default, target);
}

/**
 * Load and validate the active Horus config. Resolution order:
 *   1. an explicit `configPath` (e.g. `--config`)
 *   2. `opts.name` → the global project registry (`~/.horus/registry.json`)
 *   3. a discovered `.horus/config.json` walking up from `opts.cwd` (git-style)
 *   4. the `HORUS_CONFIG` environment variable
 *   5. `config/horus.config.js` relative to cwd (preferred — works with built binary)
 *   6. `config/horus.config.ts` relative to cwd (source-mode fallback)
 */
export async function loadConfig(
  configPath?: string,
  opts?: { name?: string; cwd?: string },
): Promise<HorusConfig> {
  const cwd = opts?.cwd ?? process.cwd();

  let target: string;
  if (configPath) {
    target = resolve(configPath);
  } else if (opts?.name) {
    const entry = lookupProject(opts.name);
    if (entry === null) {
      throw new Error(
        `Unknown project "${opts.name}". Run \`horus init --name ${opts.name}\` in its repo, ` +
          `or list registered projects with \`horus projects\`.`,
      );
    }
    target = entry.configPath;
  } else {
    const discovered = discoverLocalConfig(cwd);
    if (discovered) {
      target = discovered;
    } else if (process.env['HORUS_CONFIG']) {
      target = resolve(process.env['HORUS_CONFIG']);
    } else {
      // Prefer .js — native import() works in the built binary without jiti/babel.
      // Fall back to .ts for source-mode workflows (tsx, ts-node).
      const jsPath = resolve(cwd, 'config/horus.config.js');
      const tsPath = resolve(cwd, 'config/horus.config.ts');
      // No `.horus/config.json`, no $HORUS_CONFIG, and no `config/horus.config.*` — this repo
      // isn't set up. Fail with an ACTIONABLE message instead of a cryptic module-not-found
      // (the recurring "Cannot find module .../config/horus.config.ts").
      if (!existsSync(jsPath) && !existsSync(tsPath)) {
        throw new Error(
          `No Horus config found for ${cwd}. Run \`horus init\` in this repo to set it up, ` +
            `or pass --config <path> / --name <project>.`,
        );
      }
      target = existsSync(jsPath) ? jsPath : tsPath;
    }
  }

  return loadConfigFile(target);
}
