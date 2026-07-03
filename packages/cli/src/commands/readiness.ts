/**
 * HOR-97 — Release readiness summary command.
 *
 * Reports whether the local checkout is ready for a demo or preview release.
 * Checks are split into two tiers:
 *
 *   Blocking  — must pass before any demo or release (DB reachability/schema,
 *               CLI binary present). Non-zero exit code when any blocking check fails.
 *   Optional  — improve investigation depth but do not block a basic demo
 *               (source intelligence, local config, connectors, indexed repo).
 *
 * Does not auto-start services, run investigation flows, or probe live
 * external connectors (Elasticsearch, Grafana, MongoDB, Redis).
 */

import pc from 'picocolors';
import {
  HORUS_VERSION,
  discoverLocalConfig,
  loadConfig,
  PINNED_SOURCE_VERSION,
} from '@horus/core';
import { checkDatabase, type DbHealth } from '@horus/db';
import { getSourceVersion } from '@horus/connectors';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';
import { readIndexMeta, semanticSearchReady } from '../lib/freshness.js';

export const READINESS_AI_CONTRACT = `Provide a clearly separated AI readiness summary with:

Overall assessment
- Release/demo readiness in plain language (Ready / Partially ready / Not ready)
- One sentence explaining why

Blockers
- Each failing blocking check and what it means operationally
- Only reference checks that Horus found failing

Risks
- Non-blocking warnings that could limit investigation depth or demo quality
- Prioritize by likely impact

Recommended next action
- The single most impactful step to take right now
- Exact command or config change based on the checks above

Confidence / gaps
- Which checks Horus could verify vs. which require manual confirmation`;


const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

type ReadinessStatus = 'pass' | 'warn' | 'fail';

interface ReadinessCheck {
  label: string;
  status: ReadinessStatus;
  /** true = must pass for release/demo; false = optional. */
  blocking: boolean;
  detail: string;
  next?: string;
}

function mark(status: ReadinessStatus): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'warn') return pc.yellow('~');
  return pc.red('✗');
}

export async function runReadiness(opts?: {
  cwd?: string;
  config?: string;
  write?: (line: string) => void;
  /** Injectable for tests — defaults to the real checkDatabase. */
  _dbCheck?: (url: string) => Promise<DbHealth>;
  /** Injectable for tests — defaults to the real getSourceVersion. */
  _sourceVersion?: () => Promise<string | null>;
  /** Injectable for tests — defaults to the real loadConfig. */
  _loadConfig?: typeof loadConfig;
  ai?: boolean;
  aiModel?: string;
  /** Injectable AI provider for tests — bypasses credential resolution. */
  _aiProvider?: InterpretationProvider;
}): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd();
  const write = opts?.write ?? ((line: string) => console.log(line));
  const dbChecker = opts?._dbCheck ?? checkDatabase;
  const sourceVersionFn = opts?._sourceVersion ?? getSourceVersion;
  const configLoader = opts?._loadConfig ?? loadConfig;
  const checks: ReadinessCheck[] = [];

  // ── CLI binary — always passes if the process is running ─────────────────
  checks.push({
    label: 'CLI',
    status: 'pass',
    blocking: true,
    detail: `horus ${HORUS_VERSION}`,
  });

  // ── Load global config once (used for DB URL + connector checks) ──────────
  let globalConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    globalConfig = await configLoader(opts?.config, { cwd });
  } catch {
    // No global config — DB URL falls back to env or default.
  }

  // ── Database — BLOCKING ───────────────────────────────────────────────────
  const dbUrl = globalConfig?.database.url ?? process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  const db = await dbChecker(dbUrl);
  if (!db.reachable) {
    checks.push({
      label: 'Database',
      status: 'fail',
      blocking: true,
      detail: 'Postgres not reachable',
      next:
        'docker run -d --name horus-db \\\n' +
        '        -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n' +
        '        -p 5433:5432 postgres:16\n' +
        '      or set DATABASE_URL to an existing Postgres 16 instance',
    });
  } else if (!db.schemaReady) {
    checks.push({
      label: 'Database',
      status: 'fail',
      blocking: true,
      detail: 'connected but schema not applied',
      next: 'pnpm db migrate',
    });
  } else {
    checks.push({
      label: 'Database',
      status: 'pass',
      blocking: true,
      detail: db.schemaDetail,
    });
  }

  // ── Local config (.horus/config.json) — OPTIONAL ─────────────────────────
  const localConfigPath = discoverLocalConfig(cwd);
  checks.push(
    localConfigPath
      ? { label: 'Local config', status: 'pass', blocking: false, detail: localConfigPath }
      : {
          label: 'Local config',
          status: 'warn',
          blocking: false,
          detail: '.horus/config.json not found',
          next: 'run `horus init` to create one for this repo',
        },
  );

  // ── Source-intelligence backend — OPTIONAL ────────────────────────────────
  const sourceVersion = await sourceVersionFn();
  if (sourceVersion === null) {
    checks.push({
      label: 'Source intelligence',
      status: 'warn',
      blocking: false,
      detail: 'not installed — source intelligence unavailable',
      next: `curl -fsSL https://horus.sh/install.sh | bash`,
    });
  } else if (sourceVersion !== PINNED_SOURCE_VERSION) {
    checks.push({
      label: 'Source intelligence',
      status: 'warn',
      blocking: false,
      detail: `version mismatch (installed: ${sourceVersion}, required: ${PINNED_SOURCE_VERSION})`,
      next: `horus update`,
    });
  } else {
    checks.push({
      label: 'Source intelligence',
      status: 'pass',
      blocking: false,
      detail: `${sourceVersion} — ready`,
    });
  }

  // ── Semantic search (index embeddings) — OPTIONAL (HOR-373/375) ───────────
  // An index with symbols but zero embeddings silently degrades search to keyword/FTS only, so
  // surface it here rather than letting recall quietly vanish. Only checked for an indexed repo.
  const indexMeta = readIndexMeta(cwd);
  if (indexMeta !== null) {
    checks.push(
      semanticSearchReady(indexMeta)
        ? {
            label: 'Semantic search',
            status: 'pass',
            blocking: false,
            detail: `${indexMeta.stats?.embeddings ?? 0} embeddings`,
          }
        : {
            label: 'Semantic search',
            status: 'warn',
            blocking: false,
            detail: 'index has 0 embeddings — running keyword/FTS only',
            next: 'horus init   # rebuilds embeddings (a prior index was interrupted)',
          },
    );
  }

  // ── Connector config (from global config) — OPTIONAL ─────────────────────
  if (!globalConfig) {
    checks.push({
      label: 'Global config',
      status: 'warn',
      blocking: false,
      detail: 'horus.config.js not found — connector and repo checks skipped',
      next: 'run `horus generate-config` then fill in your project details',
    });
  } else {
    let anyRepoConfigured = false;
    let anyEs = false;
    let anyGrafana = false;
    let anyMongo = false;
    let anyPostgres = false;
    let anySentry = false;
    let anyAxiom = false;
    let anyShopify = false;
    let anyRedis = false;

    for (const project of globalConfig.projects) {
      for (const repo of project.repositories) {
        if (repo.source?.hostUrl) anyRepoConfigured = true;
      }
      for (const env of project.environments) {
        const c = env.connectors;
        if (c.elasticsearch) anyEs = true;
        if (c.grafana) anyGrafana = true;
        if (c.mongodb) anyMongo = true;
        if (c.postgres) anyPostgres = true;
        if (c.sentry) anySentry = true;
        if (c.axiom) anyAxiom = true;
        if (c.shopify) anyShopify = true;
        if (c.redis) anyRedis = true;
      }
    }

    checks.push(
      anyRepoConfigured
        ? { label: 'Source host', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Source host',
            status: 'warn',
            blocking: false,
            detail: 'no source host URL in any project',
            next: 'set source.hostUrl in horus.config.js for this repository',
          },
    );

    checks.push(
      anyEs
        ? { label: 'Elasticsearch', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Elasticsearch',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no runtime log evidence',
            next: 'run `horus connect elasticsearch`',
          },
    );

    checks.push(
      anyGrafana
        ? { label: 'Grafana', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Grafana',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no metric evidence',
            next: 'run `horus connect grafana`',
          },
    );

    checks.push(
      anyMongo
        ? { label: 'MongoDB', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'MongoDB',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no database state evidence',
            next: 'run `horus connect mongodb`',
          },
    );

    checks.push(
      anyPostgres
        ? { label: 'Postgres', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Postgres',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no database state evidence',
            next: 'run `horus connect postgres`',
          },
    );

    checks.push(
      anySentry
        ? { label: 'Sentry', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Sentry',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no error-tracking evidence',
            next: 'run `horus connect sentry`',
          },
    );

    checks.push(
      anyAxiom
        ? { label: 'Axiom', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Axiom',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no runtime log evidence',
            next: 'run `horus connect axiom`',
          },
    );

    checks.push(
      anyShopify
        ? { label: 'Shopify', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Shopify',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no Shopify Admin state evidence',
            next: 'run `horus connect shopify`',
          },
    );

    checks.push(
      anyRedis
        ? { label: 'Redis', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Redis',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no queue state evidence',
            next: 'run `horus connect redis`',
          },
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const blockingChecks = checks.filter(c => c.blocking);
  const optionalChecks = checks.filter(c => !c.blocking);

  write(pc.bold('\nHorus release readiness\n'));

  write(pc.bold('  Blocking'));
  for (const check of blockingChecks) {
    write(`    ${mark(check.status)} ${pc.bold(check.label.padEnd(22))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`      ${pc.dim('→ ' + check.next)}`);
    }
  }

  write('');
  write(pc.bold('  Optional'));
  for (const check of optionalChecks) {
    write(`    ${mark(check.status)} ${pc.bold(check.label.padEnd(22))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`      ${pc.dim('→ ' + check.next)}`);
    }
  }

  write('');

  const blockingFails = blockingChecks.filter(c => c.status === 'fail');
  const optionalWarns = optionalChecks.filter(c => c.status === 'warn').length;

  if (blockingFails.length === 0) {
    if (optionalWarns === 0) {
      write(pc.green('  Ready for demo/release.'));
    } else {
      write(
        pc.yellow(
          `  Ready for a basic demo. ${optionalWarns} optional item(s) not configured — investigation evidence will be limited.`,
        ),
      );
    }
  } else {
    write(
      pc.red(
        `  Not ready. ${blockingFails.length} blocking item(s) must be resolved before demo/release.`,
      ),
    );
    write(pc.dim('  Re-run `horus readiness` after resolving the items above.'));
  }

  write('');

  if (opts?.ai) {
    const result = await renderAiInterpretation({
      command: 'readiness',
      evidence: checks,
      promptKind: 'readiness',
      outputContract: READINESS_AI_CONTRACT,
      config: opts.config,
      modelOverride: opts.aiModel,
      provider: opts._aiProvider,
    });
    console.log('\n' + renderInterpretation(result));
    if (!result.ok) {
      console.error(pc.yellow(`[ai] ${result.warning}`));
    }
  }

  return blockingFails.length > 0 ? 1 : 0;
}
