import { Command } from 'commander';
import { HORUS_VERSION } from '@horus/core';
import { maybeNotifyUpdate } from './lib/update-notifier.js';
import { maybePromptResolutionFeedback } from './lib/feedback-nudge.js';
import { runStatus } from './commands/status.js';
import { runExplain } from './commands/explain.js';
import {
  runKnowledgeStatus,
  runKnowledgeSearch,
  runKnowledgeContracts,
  runKnowledgeTrace,
  runKnowledgeAsk,
  runKnowledgeValidate,
} from './commands/knowledge.js';
import { runMcpServer } from './commands/mcp/server.js';
import {
  runKnowledgePush,
  runKnowledgePull,
  runKnowledgeCloudStatus,
} from './commands/knowledge-cloud.js';
import { runQueues } from './commands/queues.js';
import { runInvestigate } from './commands/investigate.js';
import { runPacket } from './commands/packet.js';
import { runWatch } from './commands/watch.js';
import type { WatchSource } from './commands/watch.js';
import { runChanges } from './commands/changes.js';
import { runTimeline } from './commands/timeline.js';
import { runWhatChanged } from './commands/what-changed.js';
import { runArchitecture } from './commands/architecture.js';
import { runBlastRadius } from './commands/blast-radius.js';
import { runRepos } from './commands/repos.js';
import { runSearch } from './commands/search.js';
import { runInvestigations } from './commands/investigations.js';
import { runReplay } from './commands/replay.js';
import { runOwner } from './commands/owner.js';
import { runPostmortem } from './commands/postmortem.js';
import { runScore, runScores } from './commands/score.js';
import { runAsk } from './commands/ask.js';
import { runOnboard } from './commands/onboard.js';
import {
  runMemoryShow,
  runMemoryAdd,
  runMemoryConfirm,
  runMemoryForget,
  runMemoryPin,
  runMemoryList,
  runMemoryLink,
  runMemoryUnlink,
  runMemoryDetect,
  runMemorySync,
  runMemoryAccuracy,
} from './commands/memory.js';
import { runSimulate } from './commands/simulate.js';
import { runLogs } from './commands/logs.js';
import { runMetrics } from './commands/metrics.js';
import { runState } from './commands/state.js';
import { runInit } from './commands/init.js';
import { runProjects } from './commands/projects.js';
import { runConnect } from './commands/connect.js';
import { runNotify, type NotifyOptions } from './commands/notify.js';
import { runSecretsStatus, runSecretsMigrate, runSecretsKey } from './commands/secrets.js';
import { runStop } from './commands/stop.js';
import { runHosts } from './commands/hosts.js';
import { runDoctor } from './commands/doctor.js';
import { runProvidersDoctorCommand } from './commands/providers-doctor.js';
import { runGenerateConfig } from './commands/generate-config.js';
import { runReadiness } from './commands/readiness.js';
import { runSkillInstall, runSkillPrint, runSkillPath } from './commands/skill.js';
import { runUpdate } from './commands/update.js';
import { runLogin, runLogout } from './commands/login.js';
import { runContextList, runContextUse, runContextShow } from './commands/context.js';
import { runCloudLink, runCloudUnlink, runCloudStatus, runCloudSync } from './commands/cloud.js';
import {
  runTelemetryStatus,
  runTelemetryEnable,
  runTelemetryDisable,
  runTelemetryEnableContent,
  runTelemetryDisableContent,
  runTelemetryResetId,
  runTelemetryDelete,
} from './commands/telemetry.js';
import { maybeShowFirstRunNotice } from './lib/telemetry/notice.js';
import { installCommandTelemetry } from './lib/telemetry/command-hooks.js';
import { flushTelemetry } from './lib/telemetry/transport.js';
import { runFeedback } from './commands/feedback.js';
import { runReportIssue } from './commands/report-issue.js';
import { runEvalBuild, runEvalBaseline } from './commands/eval.js';
import { runTrain } from './commands/train.js';

/**
 * Build the Horus CLI program. Commands are added as their phases land:
 *   status (HOR-1) · index (STITCH) · explain/trace (HOR-3/4) ·
 *   investigate/ask/replay (HOR-5). See architecture.md §2.8.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('horus')
    .description('Local-first, source-aware production-incident investigation engine')
    .version(`horus ${HORUS_VERSION}`, '-V, --version', 'output the version number');

  // Passive update notifier (HOR-383): a one-line stderr hint when the CLI is behind the latest
  // release — cached (~24h), non-blocking, and suppressed for non-TTY / CI / --json /
  // HORUS_NO_UPDATE_CHECK. Skip `update` itself (it runs its own check).
  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (actionCommand.name() !== 'update') maybeNotifyUpdate();
  });

  program
    .command('doctor')
    .description('Check local readiness: CLI version, git root, .horus config, and source-intelligence setup')
    .option('-c, --config <path>', 'path to horus.config.js for connector checks')
    .option('--json', 'output machine-readable JSON instead of human-readable text')
    .action(async (opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runDoctor({ config: opts.config, json: opts.json });
    })
    .addHelpText('after', `
Examples:
  horus doctor
  horus doctor --json
  horus doctor --config ./horus.config.js
`);

  const providers = program
    .command('providers')
    .description('Local AI provider management');

  providers
    .command('doctor')
    .description('Check which local AI providers (Codex, Claude, Gemini, etc.) are available')
    .action(async () => {
      process.exitCode = await runProvidersDoctorCommand();
    });

  // Hidden deprecation stub — `setup` was merged into `init`.
  program
    .command('setup', { hidden: true })
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      console.error('`horus setup` has been merged into `horus init`. Run: horus init');
      process.exitCode = 1;
    });

  program
    .command('init')
    .description(
      'Set up this repo for Horus: check prerequisites, write/register .horus config, start the source-intelligence host, and index the code',
    )
    .option('--name <name>', 'project name (new repo) or registered name to resolve (default: repo directory name)')
    .option('--env <name>', 'environment name (default: production)')
    .option('--source <url>', 'external source-intelligence host URL — recorded verbatim, skips the local host/index')
    .option('--path <dir>', 'repository root (default: nearest git root, else cwd)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--project <name>', 'project name within the config')
    .option('--full', 'build a full project-knowledge snapshot (default)')
    .option('--changed', 'pre-push-safe: refresh knowledge for changed files only')
    .option('--fast', 'speed hint, used with --changed')
    .option('--import-kb <path>', 'import a knowledge-base JSON (e.g. Maison Safqa MCP) as the knowledge source')
    .action(
      async (opts: {
        name?: string;
        env?: string;
        source?: string;
        path?: string;
        config?: string;
        project?: string;
        full?: boolean;
        changed?: boolean;
        fast?: boolean;
        importKb?: string;
      }) => {
        process.exitCode = await runInit(opts);
      },
    )
    .addHelpText('after', `
Examples:
  horus init
  horus init --name atlas-payments
  horus init --name atlas-payments --env staging
  horus init --changed --fast          # pre-push: refresh knowledge for changed files only
  horus init --source http://127.0.0.1:8420   # use an already-running external host
`);

  program
    .command('projects')
    .description('List projects registered in the global registry (~/.horus/registry.json)')
    .action(async () => {
      process.exitCode = await runProjects();
    });

  program
    .command('generate-config')
    .description('Create a starter horus.config.js with placeholders (HOR-90)')
    .option('--out <path>', 'output path (default: horus.config.js in cwd)')
    .option('--name <name>', 'project name placeholder (default: my-project)')
    .option('--repo <path>', 'repository path placeholder (default: /path/to/<name>)')
    .option('--force', 'overwrite an existing config file')
    .action(async (opts: { out?: string; name?: string; repo?: string; force?: boolean }) => {
      process.exitCode = await runGenerateConfig(opts);
    });

  program
    .command('readiness')
    .description('Summarize release/demo readiness: DB, source intelligence, connectors, and local config (HOR-97)')
    .option('-c, --config <path>', 'path to horus.config.js')
    .option('--ai', 'append AI readiness summary and recommended next action')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(async (opts: { config?: string; ai?: boolean; aiModel?: string }) => {
      process.exitCode = await runReadiness({ config: opts.config, ai: opts.ai, aiModel: opts.aiModel });
    });

  program
    .command('connect <type>')
    .description(
      'Add or update a connector (elasticsearch / mongodb / postgres / sentry / axiom / shopify / grafana / redis / ai) in .horus/config.json',
    )
    .option('--env <name>', 'target environment (default: first environment in config)')
    .option('--provider <name>', 'AI provider for `connect ai` (anthropic / claude / codex / gemini)')
    .option('--api-key <key>', 'Anthropic API key for `connect ai`')
    .option('--model <id>', 'default model for `connect ai`')
    .option('--url <url>', 'connector URL or connection string (Redis with auth: redis://:password@host:6379)')
    .option('--username <user>', 'username (elasticsearch / grafana)')
    .option('--password <pass>', 'password (elasticsearch / grafana; for Redis embed in --url)')
    .option('--index-pattern <pattern>', 'Elasticsearch index pattern (required for elasticsearch)')
    .option('--service <name>', 'service name scope for log queries')
    .option('--database <name>', 'database name (required for mongodb)')
    .option('--collections <list>', 'comma-separated collection allowlist (mongodb)')
    .option('--schema <name>', 'schema to introspect (postgres; default public)')
    .option('--tables <list>', 'comma-separated table allowlist (postgres)')
    .option('--auth-token <token>', 'Sentry API auth token (required for sentry)')
    .option('--org <slug>', 'Sentry org slug (required for sentry)')
    .option('--project <slug>', 'Sentry project slug (required for sentry)')
    .option('--token <token>', 'Axiom API token (required for axiom)')
    .option('--dataset <name>', 'Axiom dataset to query (required for axiom)')
    .option('--store <name>', 'Shopify store subdomain, e.g. my-store — .myshopify.com is added automatically (required for shopify)')
    .option('--api-version <ver>', 'Shopify Admin API version, e.g. 2025-10 (shopify; defaults to a recent version)')
    .option('--access-id <id>', 'Shopify app client_id — omit for a static Admin API token (shopify)')
    .option('--secret <secret>', 'Shopify client_secret, or a static Admin API access token — encrypted at rest (required for shopify)')
    .option('--dashboard <uid>', 'default dashboard uid (grafana)')
    .option(
      '--db <spec>',
      'redis logical DB as db:role1,role2 (e.g. 0:cache,state or 1:bullmq,queues); repeatable',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option('--bullmq-prefix <prefix>', 'BullMQ key prefix for redis queue DBs (default: bull)')
    .option('--no-scan-dbs', 'skip interactive Redis DB scan')
    .option('--no-test', 'skip live connection probe')
    .action(
      async (
        type: string,
        opts: {
          env?: string;
          url?: string;
          username?: string;
          password?: string;
          indexPattern?: string;
          service?: string;
          database?: string;
          collections?: string;
          schema?: string;
          tables?: string;
          authToken?: string;
          org?: string;
          project?: string;
          token?: string;
          dataset?: string;
          store?: string;
          apiVersion?: string;
          accessId?: string;
          secret?: string;
          dashboard?: string;
          db?: string[];
          bullmqPrefix?: string;
          scanDbs?: boolean;
          provider?: string;
          apiKey?: string;
          model?: string;
          test?: boolean;
        },
      ) => {
        process.exitCode = await runConnect(type, {
          env: opts.env,
          url: opts.url,
          username: opts.username,
          password: opts.password,
          indexPattern: opts.indexPattern,
          service: opts.service,
          database: opts.database,
          collections: opts.collections,
          schema: opts.schema,
          tables: opts.tables,
          authToken: opts.authToken,
          org: opts.org,
          project: opts.project,
          token: opts.token,
          dataset: opts.dataset,
          store: opts.store,
          apiVersion: opts.apiVersion,
          accessId: opts.accessId,
          secret: opts.secret,
          dashboard: opts.dashboard,
          db: opts.db,
          bullmqPrefix: opts.bullmqPrefix,
          scanDbs: opts.scanDbs,
          provider: opts.provider,
          apiKey: opts.apiKey,
          aiModel: opts.model,
          noTest: opts.test === false,
        });
      },
    );

  const notify = program
    .command('notify')
    .description('Configure the outbound notify sink for `horus watch` (webhook / cloud) — HOR-454');
  const notifyAction =
    (sub: string | undefined) =>
    async (opts: NotifyOptions): Promise<void> => {
      process.exitCode = await runNotify(sub, opts);
    };
  notify
    .command('set')
    .description('Set the webhook URL (and optional signing secret) for an environment')
    .option('-c, --config <path>', 'path to a horus config file')
    .option('--env <name>', 'environment to configure (default: first)')
    .option('--url <url>', 'webhook URL to POST confident auto-investigations to')
    .option('--secret <secret>', 'HMAC signing secret (stored encrypted, never plaintext)')
    .option('--min-confidence <n>', 'only dispatch at/above this confidence (0..1, default 0.6)')
    .option('--cloud', 'also push headlines to Horus Cloud')
    .option('--no-cloud', 'disable the Horus Cloud push')
    .action(notifyAction('set'));
  notify
    .command('show')
    .description('Show the configured notify sink (secret masked)')
    .option('-c, --config <path>', 'path to a horus config file')
    .option('--env <name>', 'environment to show (default: first)')
    .action(notifyAction('show'));
  notify
    .command('test')
    .description('Send a sample signed dispatch to the configured webhook to verify it')
    .option('-c, --config <path>', 'path to a horus config file')
    .option('--env <name>', 'environment to test (default: first)')
    .action(notifyAction('test'));
  notify
    .command('remove')
    .description('Remove the notify sink from an environment')
    .option('-c, --config <path>', 'path to a horus config file')
    .option('--env <name>', 'environment to clear (default: first)')
    .action(notifyAction('remove'));

  const secrets = program
    .command('secrets')
    .description('Manage encrypted connector credentials (.horus/secrets.local.json) — HOR-452');
  secrets
    .command('status')
    .description('Show the master key source, stored secrets, plaintext in config, and gitignore state')
    .action(() => {
      process.exitCode = runSecretsStatus();
    });
  secrets
    .command('migrate')
    .description('Move plaintext connector secrets out of config.json into the encrypted store')
    .option('--dry-run', 'list what would be migrated without changing anything')
    .action((opts: { dryRun?: boolean }) => {
      process.exitCode = runSecretsMigrate({ dryRun: opts.dryRun });
    });
  secrets
    .command('key')
    .description('Show the master key source; --show prints it (base64) for CI (HORUS_SECRET_KEY)')
    .option('--show', 'print the master key (treat as a credential)')
    .action((opts: { show?: boolean }) => {
      process.exitCode = runSecretsKey({ show: opts.show });
    });

  program
    .command('stop')
    .description('Stop the source-intelligence host for the current repo (or --all to stop every host)')
    .option('--all', 'stop all registered source-intelligence hosts')
    .action(async (opts: { all?: boolean }) => {
      process.exitCode = await runStop(opts);
    });

  program
    .command('hosts')
    .description('List registered source-intelligence hosts and their live status (port, repo, running/stopped)')
    .option('--reap', 'stop orphaned source hosts that no registered repo owns')
    .action(async (opts: { reap?: boolean }) => {
      process.exitCode = await runHosts({ reap: opts.reap });
    });

  program
    .command('status')
    .description('Show config, provider health, and project/environment matrix')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name (show only this project)')
    .option('--env <name>', 'environment name (e.g. production)')
    .action(
      async (opts: { config?: string; name?: string; project?: string; env?: string }) => {
        const code = await runStatus(opts.config, {
          name: opts.name,
          project: opts.project,
          env: opts.env,
        });
        process.exitCode = code;
      },
    );

  program
    .command('explain <query>')
    .description(
      'Explain a symbol: location, community, callers/callees, impact, related flows',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-d, --depth <n>', 'impact depth', (v) => parseInt(v, 10))
    .option('--repo <name>', 'repository name to scope the source lookup to')
    .option('--json', 'output JSON')
    .action(
      async (
        query: string,
        opts: { config?: string; depth?: number; repo?: string; json?: boolean },
      ) => {
        process.exitCode = await runExplain(query, {
          config: opts.config,
          depth: opts.depth,
          repo: opts.repo,
          json: opts.json,
        });
      },
    );

  // Hidden deprecation stub — `index` was merged into `init`.
  program
    .command('index', { hidden: true })
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      console.error('`horus index` has been merged into `horus init`. Run: horus init');
      process.exitCode = 1;
    });

  const knowledge = program
    .command('knowledge')
    .description('Query the local project-knowledge index (.horus/index) — offline, no Cloud');
  knowledge
    .command('status')
    .description('Show last indexed commit, schema version, item counts, and stale/dirty status')
    .option('--cloud', 'also compare the local index with the linked cloud snapshot')
    .action(async (opts: { cloud?: boolean }) => {
      const local = runKnowledgeStatus();
      const cloud = opts.cloud ? await runKnowledgeCloudStatus() : 0;
      process.exitCode = local || cloud;
    });
  knowledge
    .command('search <query>')
    .description('Keyword search across indexed operations, types, concepts, and patterns')
    .action((query: string) => {
      process.exitCode = runKnowledgeSearch(query);
    });
  knowledge
    .command('contracts <name>')
    .description('Show operations/types/enums/auth rules verbatim (no hallucinated values)')
    .action((name: string) => {
      process.exitCode = runKnowledgeContracts(name);
    });
  knowledge
    .command('trace <query>')
    .description('Walk known concept ↔ operation ↔ type / data-flow links')
    .action((query: string) => {
      process.exitCode = runKnowledgeTrace(query);
    });
  knowledge
    .command('ask <question>')
    .description('Grounded answer from the local index, with provenance (offline)')
    .action((question: string) => {
      process.exitCode = runKnowledgeAsk(question);
    });
  knowledge
    .command('validate')
    .description('Validate the index (schema + content hash + staleness) — pre-push friendly')
    .action(() => {
      process.exitCode = runKnowledgeValidate();
    });
  knowledge
    .command('push')
    .description('Upload the local knowledge snapshot to the linked cloud project (optional; content-hash deduped)')
    .option('--dry-run', 'preview what would be uploaded without sending')
    .action(async (opts: { dryRun?: boolean }) => {
      process.exitCode = await runKnowledgePush({ dryRun: opts.dryRun });
    });
  knowledge
    .command('pull')
    .description('Download the latest knowledge snapshot from the linked cloud project')
    .option('--force', 'overwrite local knowledge that differs from the cloud snapshot')
    .action(async (opts: { force?: boolean }) => {
      process.exitCode = await runKnowledgePull({ force: opts.force });
    });

  const memory = program
    .command('memory')
    .description(
      'Inspect deterministic incident memory + code-knowledge for a scope (project-scoped, offline)',
    );
  memory
    .command('show <scope>')
    .description(
      'Synthesize owned areas, runtime paths, past investigations and weak spots for a scope',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--json', 'output JSON')
    .action(async (scope: string, opts: { config?: string; repo?: string; json?: boolean }) => {
      process.exitCode = await runMemoryShow(scope, opts);
    });

  const collectEvidence = (value: string, prev: string[]): string[] => prev.concat([value]);

  memory
    .command('add <claim>')
    .description('Add an authored memory claim (human source) for the repo')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--scope <scope>', 'applicability scope: global|repo|module:<area>|symbol:<node_id>', 'repo')
    .option('--kind <kind>', 'code-fact|contract|decision|pitfall|incident-pattern', 'code-fact')
    .option('--evidence <kind:ref>', 'evidence reference (repeatable); "kind:ref" or bare "ref"', collectEvidence, [])
    .option('--confidence <0..1>', 'confidence in the claim (default 0.75)')
    .option('--json', 'output JSON')
    .action(
      async (
        claim: string,
        opts: {
          config?: string;
          repo?: string;
          scope?: string;
          kind?: string;
          evidence?: string[];
          confidence?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runMemoryAdd(claim, opts);
      },
    );

  memory
    .command('confirm <investigationId>')
    .description('Record a confirmed-outcome memory item from an investigation (private, PII-gated)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--note <note>', 'note recorded in the audit trail')
    .option('--json', 'output JSON')
    .action(
      async (
        investigationId: string,
        opts: { config?: string; repo?: string; note?: string; json?: boolean },
      ) => {
        process.exitCode = await runMemoryConfirm(investigationId, opts);
      },
    );

  memory
    .command('forget <id>')
    .description('Soft-delete a memory item (retained + audited, excluded from recall, reversible)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--note <note>', 'note recorded in the audit trail')
    .option('--json', 'output JSON')
    .action(async (id: string, opts: { config?: string; note?: string; json?: boolean }) => {
      process.exitCode = await runMemoryForget(id, opts);
    });

  memory
    .command('pin <id>')
    .description('Pin a memory item so it floats to the top of recall (never auto-hidden)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--note <note>', 'note recorded in the audit trail')
    .option('--json', 'output JSON')
    .action(async (id: string, opts: { config?: string; note?: string; json?: boolean }) => {
      process.exitCode = await runMemoryPin(id, opts);
    });

  memory
    .command('list')
    .description('List persisted authored memory items for the repo')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--all', 'include forgotten/deprecated/contradicted items')
    .option('--json', 'output JSON')
    .action(async (opts: { config?: string; repo?: string; all?: boolean; json?: boolean }) => {
      process.exitCode = await runMemoryList(opts);
    });

  // Memory→memory link graph (FROZEN day-0 rels). NB: these are `memory link/unlink` SUBcommands —
  // distinct from the unrelated top-level `link` (cloud link).
  memory
    .command('link <a> <b>')
    .description('Author a memory→memory edge (supersedes|contradicts|recurs-with) between two items')
    .requiredOption('--rel <rel>', 'relation: supersedes | contradicts | recurs-with')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--note <note>', 'note recorded in the audit trail')
    .option('--json', 'output JSON')
    .action(
      async (
        a: string,
        b: string,
        opts: { config?: string; repo?: string; rel?: string; note?: string; json?: boolean },
      ) => {
        process.exitCode = await runMemoryLink(a, b, opts);
      },
    );

  memory
    .command('unlink <a> <b>')
    .description('Remove a memory→memory edge (inverse of `memory link`); a missing edge is a no-op')
    .requiredOption('--rel <rel>', 'relation: supersedes | contradicts | recurs-with')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--note <note>', 'note recorded in the audit trail')
    .option('--json', 'output JSON')
    .action(
      async (
        a: string,
        b: string,
        opts: { config?: string; repo?: string; rel?: string; note?: string; json?: boolean },
      ) => {
        process.exitCode = await runMemoryUnlink(a, b, opts);
      },
    );

  memory
    .command('detect')
    .description('Auto-detect memory→memory edges (recurrence/contradiction); --dry-run previews only')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--dry-run', 'print proposed edges for confirmation without writing')
    .option('--limit <n>', 'max items to scan', (v) => Number(v))
    .option('--json', 'output JSON')
    .action(
      async (opts: { config?: string; repo?: string; dryRun?: boolean; limit?: number; json?: boolean }) => {
        process.exitCode = await runMemoryDetect(opts);
      },
    );

  memory
    .command('accuracy')
    .description("Report Horus's measured hit-rate from the converged outcome-label eval set")
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--source <source>', 'filter to one signal source: feedback | confirm')
    .option('--since <date>', 'only count labels on/after this date (e.g. 2026-06-01)')
    .option('--days <n>', 'only count labels from the last N days', (v) => Number(v))
    .option('--all', 'count the full retained history (disable the default recent window)')
    .option('--limit <n>', 'max labels to scan', (v) => Number(v))
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        config?: string;
        repo?: string;
        source?: string;
        since?: string;
        days?: number;
        all?: boolean;
        limit?: number;
        json?: boolean;
      }) => {
        process.exitCode = await runMemoryAccuracy(opts);
      },
    );

  memory
    .command('sync')
    .description('Push local memory items to the linked cloud project (idempotent, best-effort)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--limit <n>', 'max local items to scan', (v) => Number(v))
    .option('--dry-run', 'preview what would be synced without uploading')
    .option('--yes', 'skip the confirmation prompt')
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        config?: string;
        repo?: string;
        limit?: number;
        dryRun?: boolean;
        yes?: boolean;
        json?: boolean;
      }) => {
        process.exitCode = await runMemorySync(opts);
      },
    );

  // `eval` — the read-only accuracy harness (HOR-403). READ-ONLY over the outcome-label eval store:
  // it never writes labels (only `horus feedback` + `horus memory confirm` do). Shares the read
  // flags (--source/--days/--limit/--repo) with `horus memory accuracy`.
  const evalCmd = program
    .command('eval')
    .description("Read-only accuracy harness over Horus's outcome-label eval set (never writes labels)");
  evalCmd
    .command('build')
    .description('Emit a byte-stable corpus-<version>.jsonl + manifest from the eval set (read-only)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--source <source>', 'filter to one signal source: feedback | confirm')
    .option('--days <n>', 'only include labels from the last N days', (v) => Number(v))
    .option('--limit <n>', 'max labels to scan', (v) => Number(v))
    .option('--out <dir>', 'output directory for the corpus + manifest (default: ./.horus/eval)')
    .option('--version <v>', 'corpus schema version tag (default: v1)')
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        config?: string;
        repo?: string;
        source?: string;
        days?: number;
        limit?: number;
        out?: string;
        version?: string;
        json?: boolean;
      }) => {
        process.exitCode = await runEvalBuild(opts);
      },
    );
  evalCmd
    .command('baseline')
    .description('Print the baseline hit-rate (== memory accuracy) + a feature-separation diagnostic')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope to (default: inferred from cwd)')
    .option('--source <source>', 'filter to one signal source: feedback | confirm')
    .option('--days <n>', 'only count labels from the last N days', (v) => Number(v))
    .option('--limit <n>', 'max labels to scan', (v) => Number(v))
    .option('--json', 'output JSON')
    .action(
      async (opts: {
        config?: string;
        repo?: string;
        source?: string;
        days?: number;
        limit?: number;
        json?: boolean;
      }) => {
        process.exitCode = await runEvalBaseline(opts);
      },
    );

  program
    .command('train')
    .description('Fit the local, per-tenant reranker over your outcome-label corpus (off until it beats baseline)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--source <source>', 'filter to one signal source: feedback | confirm')
    .option('--days <n>', 'only train on labels from the last N days', (v) => Number(v))
    .option('--limit <n>', 'max labels to scan', (v) => Number(v))
    .addHelpText(
      'after',
      `
The reranker is LOCAL and per-tenant: your corpus never leaves this machine. It only REORDERS
candidate causes among those that already clear Horus's confidence gates — it never changes a
score, a confidence, or a verdict. It ships OFF; once trained, enable with:
  HORUS_RERANK=1 horus investigate "<hint>"`,
    )
    .action(async (opts: { config?: string; source?: string; days?: number; limit?: number }) => {
      process.exitCode = await runTrain(opts);
    });

  program
    .command('mcp')
    .description('Run the Horus MCP server (stdio) — exposes the local project-knowledge index to agents')
    .action(async () => {
      process.exitCode = await runMcpServer();
    });

  program
    .command('queues [name]')
    .description('Show queue topology from source intelligence; --live adds real-time Redis/BullMQ state')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via registry)')
    .option('--project <name>', 'filter edges by project')
    .option('--live', 'fetch real-time queue depths and failed-job counts from Redis/BullMQ')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI narration of queue topology and live state (most useful with --live)')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (
        name: string | undefined,
        opts: { config?: string; name?: string; project?: string; live?: boolean; json?: boolean; ai?: boolean; aiModel?: string },
      ) => {
        process.exitCode = await runQueues(name, {
          config: opts.config,
          name: opts.name,
          project: opts.project,
          live: opts.live,
          json: opts.json,
          ai: opts.ai,
          aiModel: opts.aiModel,
        });
      },
    );

  program
    .command('investigate <hint>')
    .description('Run a deterministic investigation for an incident hint')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name to scope to')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--repo <name>', 'repository/project to scope to (alias for --project)')
    .option('--scope <path>', 'resolve the seed only from symbols under this path (e.g. packages/core) — useful in monorepos')
    .option('--since <ref>', 'git ref/range for change-impact (e.g. HEAD~5)')
    .option('--logs-since <dur>', 'runtime-log window as a duration (e.g. 30d, 24h); independent of --since')
    .option(
      '--shopify-query <q>',
      'Shopify Admin GraphQL query to run as evidence: @file, - (stdin), or a raw string; repeatable',
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option('--shopify-variables <json>', 'variables (@file or inline JSON object) applied to every --shopify-query')
    .option('--timeout <sec>', 'overall investigation deadline in seconds (default 120)')
    .option(
      '--service <name>',
      'service name to scope runtime logs, e.g. leadcall-api-prod',
    )
    .option('--json', 'output JSON (alias for --format json)')
    .option('--format <fmt>', 'output format: text | markdown | json', 'text')
    .option('--ai', 'enrich report with AI narrative (requires ANTHROPIC_API_KEY; falls back to deterministic on failure)')
    .option('--ai-model <model>', 'AI model for --ai (default: claude-opus-4-8)')
    .action(
      async (
        hint: string,
        opts: {
          config?: string;
          name?: string;
          project?: string;
          env?: string;
          repo?: string;
          scope?: string;
          since?: string;
          logsSince?: string;
          shopifyQuery?: string[];
          shopifyVariables?: string;
          timeout?: string;
          service?: string;
          json?: boolean;
          format?: string;
          ai?: boolean;
          aiModel?: string;
        },
      ) => {
        process.exitCode = await runInvestigate(hint, {
          config: opts.config,
          name: opts.name,
          project: opts.project,
          env: opts.env,
          repo: opts.repo,
          scope: opts.scope,
          since: opts.since,
          logsSince: opts.logsSince,
          ...(opts.shopifyQuery !== undefined ? { shopifyQuery: opts.shopifyQuery } : {}),
          ...(opts.shopifyVariables !== undefined ? { shopifyVariables: opts.shopifyVariables } : {}),
          timeout: opts.timeout,
          service: opts.service,
          json: opts.json,
          format: opts.format,
          ai: opts.ai,
          aiModel: opts.aiModel,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus investigate "checkout latency spike"
  horus investigate --project atlas-payments --env production "checkout timeout"
  horus investigate --name atlas-payments "queue backlog"
  horus investigate --ai "payment failures"
`);

  program
    .command('packet <hint|savedId>')
    .description('Build a compact, honesty-framed agent packet from a hint (fresh run) or saved investigation id')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name to scope to')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--scope <path>', 'resolve the seed only from symbols under this path (e.g. packages/core)')
    .option('--service <name>', 'service name to scope runtime logs, e.g. leadcall-api-prod')
    .option('--since <ref>', 'git ref/range for the change window (e.g. HEAD~5)')
    .option('--timeout <sec>', 'overall investigation deadline in seconds (default 120)')
    .option('--for <agent>', 'presentation preset: claude | cursor | generic (tightens caps only)')
    .option('--json', 'emit the packet as JSON (clean for piping into agents)')
    .action(
      async (
        hintOrId: string,
        opts: {
          config?: string;
          name?: string;
          project?: string;
          env?: string;
          scope?: string;
          service?: string;
          since?: string;
          timeout?: string;
          for?: string;
          json?: boolean;
        },
      ) => {
        process.exitCode = await runPacket(hintOrId, {
          config: opts.config,
          name: opts.name,
          project: opts.project,
          env: opts.env,
          scope: opts.scope,
          service: opts.service,
          since: opts.since,
          timeout: opts.timeout,
          for: opts.for,
          json: opts.json,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus packet "checkout latency spike"
  horus packet "queue backlog" --for claude --json
  horus packet <savedId> --json          # project a saved investigation (no re-query)
`);

  program
    .command('watch')
    .description('Proactively monitor a source (Sentry/Elasticsearch) and auto-investigate each new incident')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name to scope to')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--source <source>', 'sentry | elasticsearch | auto (default: auto — whichever is configured)', 'auto')
    .option('--interval <seconds>', 'poll interval in seconds (default 60)', '60')
    .option('--once', 'poll a single cycle then exit (for cron/testing)')
    .action(
      async (opts: {
        config?: string;
        name?: string;
        project?: string;
        env?: string;
        source?: string;
        interval?: string;
        once?: boolean;
      }) => {
        process.exitCode = await runWatch({
          config: opts.config,
          name: opts.name,
          project: opts.project,
          env: opts.env,
          source: opts.source as WatchSource | undefined,
          interval: opts.interval,
          once: opts.once,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus watch                                  # auto source, poll every 60s until Ctrl-C
  horus watch --source sentry --once           # one sweep over current Sentry issues
  horus watch --source elasticsearch --interval 30
  horus watch --project atlas-payments --env production --once
`);

  program
    .command('changes <base> [compare]')
    .description(
      'Show what changed between two git refs and which flows are affected (source change-impact)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI change-impact review')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(async (base: string, compare: string | undefined, opts: { config?: string; json?: boolean; ai?: boolean; aiModel?: string }) => {
      process.exitCode = await runChanges(base, compare, { config: opts.config, json: opts.json, ai: opts.ai, aiModel: opts.aiModel });
    });

  program
    .command('timeline [service]')
    .description(
      'Reconstruct what changed in a time window (git + change-impact) — evidence, not conclusions',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--since <when>', 'git --since (default "7 days ago"; e.g. "30 days ago", a date)')
    .option('--until <when>', 'git --until')
    .option('--all', 'include all history instead of the default recent window')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI narrative interpretation of the timeline')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          until?: string;
          all?: boolean;
          json?: boolean;
          ai?: boolean;
          aiModel?: string;
        },
      ) => {
        process.exitCode = await runTimeline(service, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          until: opts.until,
          all: opts.all,
          json: opts.json,
          ai: opts.ai,
          aiModel: opts.aiModel,
        });
      },
    );

  program
    .command('what-changed [service]')
    .description(
      'Concise, evidence-backed summary of what changed for a service in a time window',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--since <when>', 'git --since (default "7 days ago")')
    .option('--until <when>', 'git --until')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI interpretation of the changes')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .option('--push', 'push the report to the linked Horus Cloud project')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          repo?: string;
          since?: string;
          until?: string;
          json?: boolean;
          ai?: boolean;
          aiModel?: string;
          push?: boolean;
        },
      ) => {
        process.exitCode = await runWhatChanged(service, {
          config: opts.config,
          repo: opts.repo,
          since: opts.since,
          until: opts.until,
          json: opts.json,
          ai: opts.ai,
          aiModel: opts.aiModel,
          push: opts.push,
        });
      },
    );

  program
    .command('architecture')
    .description(
      'Discover the living architecture (subsystems, async boundaries, external systems, fragility)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI system explanation grounded in discovered architecture')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(async (opts: { config?: string; json?: boolean; ai?: boolean; aiModel?: string }) => {
      process.exitCode = await runArchitecture({ config: opts.config, json: opts.json, ai: opts.ai, aiModel: opts.aiModel });
    });

  program
    .command('blast-radius <query>')
    .description(
      'Failure-propagation analysis: upstream/downstream dependencies + blast radius across async boundaries',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-d, --depth <n>', 'traversal depth', (v) => parseInt(v, 10))
    .option('--json', 'output JSON')
    .option('--ai', 'append AI severity and containment interpretation')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (query: string, opts: { config?: string; depth?: number; json?: boolean; ai?: boolean; aiModel?: string }) => {
        process.exitCode = await runBlastRadius(query, {
          config: opts.config,
          depth: opts.depth,
          json: opts.json,
          ai: opts.ai,
          aiModel: opts.aiModel,
        });
      },
    );

  program
    .command('repos')
    .description('List configured repositories and their source-intelligence host health')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(async (opts: { config?: string }) => {
      process.exitCode = await runRepos({ config: opts.config });
    });

  program
    .command('search <query>')
    .description(
      'Search symbols across ALL configured repositories (you need not know which repo holds the answer)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'results per repo', (v) => parseInt(v, 10))
    .option('--json', 'output JSON')
    .action(
      async (query: string, opts: { config?: string; limit?: number; json?: boolean }) => {
        process.exitCode = await runSearch(query, {
          config: opts.config,
          limit: opts.limit,
          json: opts.json,
        });
      },
    );

  program
    .command('investigations')
    .description('List recent investigations (ids for replay)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10))
    .action(async (opts: { config?: string; limit?: number }) => {
      process.exitCode = await runInvestigations({ config: opts.config, limit: opts.limit });
    })
    .addHelpText('after', `
Examples:
  horus investigations
  horus investigations -n 20
`);

  program
    .command('replay <id>')
    .description('Re-render a saved investigation from the audit store (no re-query)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--format <fmt>', 'text | markdown | json', 'text')
    .option('--ai', 'enrich report with AI narrative (requires ANTHROPIC_API_KEY; falls back to deterministic on failure)')
    .option('--ai-model <model>', 'AI model for --ai (default: claude-opus-4-8)')
    .option('--refresh-ai', 're-run AI even if a stored judgment already exists')
    .action(async (id: string, opts: { config?: string; format?: string; ai?: boolean; aiModel?: string; refreshAi?: boolean }) => {
      process.exitCode = await runReplay(id, { config: opts.config, format: opts.format, ai: opts.ai, aiModel: opts.aiModel, refreshAi: opts.refreshAi });
    })
    .addHelpText('after', `
Examples:
  horus replay <id>
  horus replay <id> --format markdown
  horus replay <id> --format json
  horus replay <id> --ai
  horus replay <id> --ai --ai-model claude-sonnet-4-6
  horus replay <id> --ai --refresh-ai

  (Use 'horus investigations' to list saved investigation ids.)
`);

  program
    .command('postmortem <id>')
    .description('Draft an editable incident postmortem from a saved investigation')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--output <path>', 'write Markdown to a file instead of printing to stdout')
    .option('--force', 'overwrite the output file if it already exists')
    .option('--ai-summary', 'append an AI-generated summary section (requires ANTHROPIC_API_KEY; falls back gracefully)')
    .option('--ai-model <model>', 'AI model for --ai-summary (default: claude-opus-4-8)')
    .option('--refresh-ai', 're-run AI even if a stored judgment already exists')
    .action(async (id: string, opts: { config?: string; output?: string; force?: boolean; aiSummary?: boolean; aiModel?: string; refreshAi?: boolean }) => {
      process.exitCode = await runPostmortem(id, { config: opts.config, output: opts.output, force: opts.force, aiSummary: opts.aiSummary, aiModel: opts.aiModel, refreshAi: opts.refreshAi });
    })
    .addHelpText('after', `
Examples:
  horus postmortem <id>
  horus postmortem <id> --output ./postmortem.md
  horus postmortem <id> --output ./postmortem.md --force
  horus postmortem <id> --ai-summary
  horus postmortem <id> --output ./postmortem.md --ai-summary --ai-model claude-sonnet-4-6
  horus postmortem <id> --ai-summary --refresh-ai

  (Use 'horus investigations' to list saved investigation ids.)
`);

  program
    .command('owner <query>')
    .description(
      'Estimate who likely owns a component (git history, with confidence + evidence)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--json', 'output JSON')
    .action(
      async (query: string, opts: { config?: string; repo?: string; json?: boolean }) => {
        process.exitCode = await runOwner(query, {
          config: opts.config,
          repo: opts.repo,
          json: opts.json,
        });
      },
    );

  program
    .command('score <id>')
    .description(
      'Score a saved investigation\'s quality (a feedback loop for Horus, not engineers)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI score explanation and improvement suggestions')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(async (id: string, opts: { config?: string; json?: boolean; ai?: boolean; aiModel?: string }) => {
      process.exitCode = await runScore(id, { config: opts.config, json: opts.json, ai: opts.ai, aiModel: opts.aiModel });
    });

  program
    .command('ask <id> <directive>')
    .description(
      'Ask about or refine a saved investigation — reuses evidence; code-locating\n' +
        '  questions re-query the source host for fresh file:line citations.\n' +
        '  Code-locating (fresh source lookup):\n' +
        '    "where is processOrder defined?" · "which file has OrderService?"\n' +
        '  Questions (direct answers):\n' +
        '    "what evidence contradicts <topic>?"  · "what evidence is missing?"\n' +
        '    "why is confidence not higher?"\n' +
        '  Topic filters (deterministic scoping):\n' +
        '    "focus on queue behavior" · "ignore deployment changes" · "retry"',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--json', 'output JSON')
    .action(async (id: string, directive: string, opts: { config?: string; json?: boolean }) => {
      process.exitCode = await runAsk(id, directive, { config: opts.config, json: opts.json });
    });

  program
    .command('scores')
    .description('List recent investigation quality scores + the average (trend)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10))
    .action(async (opts: { config?: string; limit?: number }) => {
      process.exitCode = await runScores({ config: opts.config, limit: opts.limit });
    });

  program
    .command('onboard [area]')
    .description(
      'Understand a system fast: architecture, critical paths, what breaks, ownership, past incidents',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI onboarding guide grounded in discovered system evidence')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(async (area: string | undefined, opts: { config?: string; repo?: string; json?: boolean; ai?: boolean; aiModel?: string }) => {
      process.exitCode = await runOnboard(area, {
        config: opts.config,
        repo: opts.repo,
        json: opts.json,
        ai: opts.ai,
        aiModel: opts.aiModel,
      });
    });

  program
    .command('simulate [scenario]')
    .description(
      'Practice an incident: pick a synthetic scenario and compare your reasoning with Horus',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'repository name from config')
    .action(async (scenario: string | undefined, opts: { config?: string; repo?: string }) => {
      process.exitCode = await runSimulate(scenario, {
        config: opts.config,
        repo: opts.repo,
      });
    });

  program
    .command('logs [service]')
    .description(
      'Synthesize error evidence from logs (signatures, first/last, affected services); --raw for lines',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--since <when>', 'time window, e.g. 24h, 7d, or an ISO date')
    .option('--level <level>', 'minimum level (with --raw): trace|debug|info|warn|error|fatal')
    .option('--grep <text>', 'match text in the message')
    .option('--raw', 'dump individual log lines instead of synthesized evidence (error+ by default)')
    .option('--all-levels', 'with --raw: show all severity levels, not just error+')
    .option('--group-by <field>', 'aggregate error counts by a context field, e.g. context.brand_id')
    .option(
      '--where <field=value>',
      'filter by a structured context field (repeatable, AND-combined), e.g. --where context.brand_id=42',
      (val: string, acc: string[]) => [...acc, val],
      [] as string[],
    )
    .option('--limit <n>', 'max records (with --raw)')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI narration of error signatures (default mode only, not --raw or --json)')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (
        service: string | undefined,
        opts: {
          config?: string;
          name?: string;
          project?: string;
          env?: string;
          since?: string;
          level?: string;
          grep?: string;
          raw?: boolean;
          allLevels?: boolean;
          groupBy?: string;
          where?: string[];
          limit?: string;
          json?: boolean;
          ai?: boolean;
          aiModel?: string;
        },
      ) => {
        process.exitCode = await runLogs(service, opts);
      },
    );

  program
    .command('state')
    .description(
      'Surface application-state evidence from MongoDB (read-only, allowlisted): counts, staleness, anomalous statuses',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--project <name>', 'project name')
    .option('--env <name>', 'environment name (e.g. production)')
    .option('--stale-hours <n>', 'staleness threshold in hours (default 24)')
    .option('--json', 'output JSON')
    .option('--ai', 'append AI narration of MongoDB state evidence')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (opts: {
        config?: string;
        name?: string;
        project?: string;
        env?: string;
        staleHours?: string;
        json?: boolean;
        ai?: boolean;
        aiModel?: string;
      }) => {
        process.exitCode = await runState(opts);
      },
    );

  program
    .command('metrics [hint]')
    .description(
      'Grafana metrics evidence: find dashboards/panels for a hint and detect latency spikes, error-rate changes, throughput drops, queue growth',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--name <name>', 'registered project name (resolves via the registry)')
    .option('--since <when>', 'window, e.g. 1h, 6h, 24h')
    .option('--step <secs>', 'range step seconds')
    .option('--dashboard <uid>', 'restrict to a dashboard uid')
    .option('--query <promql>', 'raw datasource query escape hatch')
    .option('--json', 'JSON output')
    .option('--ai', 'append AI narration of metric findings (default mode only, not --query or --json)')
    .option('--ai-model <model>', 'override the AI model (default: claude-opus-4-8)')
    .action(
      async (
        hint: string | undefined,
        opts: {
          config?: string;
          name?: string;
          since?: string;
          step?: string;
          dashboard?: string;
          query?: string;
          json?: boolean;
          ai?: boolean;
          aiModel?: string;
        },
      ) => {
        process.exitCode = await runMetrics(hint, opts);
      },
    );

  const skill = program
    .command('skill')
    .description('Manage the Horus agent skill — install playbooks that teach agents to use Horus as their evidence layer');

  skill
    .command('install <target>')
    .description('Install the Horus skill for a coding agent (claude | codex | gemini | cursor | generic)')
    .option('--force', 'overwrite an existing skill file')
    .option('--global', 'install into the home directory instead of the current repo')
    .action(async (target: string, opts: { force?: boolean; global?: boolean }) => {
      process.exitCode = await runSkillInstall(target, { force: opts.force, global: opts.global });
    })
    .addHelpText('after', `
Targets:
  claude   → .claude/skills/horus/SKILL.md  (Claude Code skill)
  codex    → AGENTS.md                     (Codex CLI project instructions)
  gemini   → GEMINI.md                     (Gemini CLI project context)
  cursor   → .cursor/rules/horus.mdc        (Cursor project rule)
  generic  → .horus/skills/horus-generic.md (plain Markdown)

Examples:
  horus skill install claude
  horus skill install generic --force
  horus skill install claude --global
`);

  skill
    .command('print <target>')
    .description('Print the Horus skill to stdout — copy it into any agent setup')
    .action(async (target: string) => {
      process.exitCode = await runSkillPrint(target, {});
    })
    .addHelpText('after', `
Examples:
  horus skill print generic
  horus skill print claude
`);

  skill
    .command('path <target>')
    .description('Print the install path for the given target')
    .option('--global', 'show the global (home directory) path')
    .action(async (target: string, opts: { global?: boolean }) => {
      process.exitCode = await runSkillPath(target, { global: opts.global });
    })
    .addHelpText('after', `
Examples:
  horus skill path claude
  horus skill path generic --global
`);

  program
    .command('update')
    .description('Update Horus to the latest release from GitHub')
    .option('--check', 'check for a newer version without downloading')
    .option('--force', 're-download even if already on the latest version')
    .action(async (opts: { check?: boolean; force?: boolean }) => {
      process.exitCode = await runUpdate({ check: opts.check, force: opts.force });
    })
    .addHelpText('after', `
Examples:
  horus update              # update to latest
  horus update --check      # check without installing
  horus update --force      # re-download current version
`);

  // --- Horus Cloud: login, context selection, repo↔project linking (HOR-226) ---
  program
    .command('login')
    .description('Log in to Horus Cloud; stores a CLI token in ~/.horus/auth.json (never in the repo)')
    .option('--token <token>', 'CLI token (or set HORUS_TOKEN); otherwise prompts when interactive')
    .option('--api-url <url>', 'Horus Cloud API base URL (or set HORUS_CLOUD_API_URL)')
    .action(async (opts: { token?: string; apiUrl?: string }) => {
      process.exitCode = await runLogin({ token: opts.token, apiUrl: opts.apiUrl });
    })
    .addHelpText('after', `
Examples:
  horus login --token <token>
  HORUS_TOKEN=<token> horus login`);

  program
    .command('logout')
    .description('Revoke the current CLI token and clear local credentials')
    .action(async () => {
      process.exitCode = await runLogout();
    });

  const context = program
    .command('context')
    .description('Select where this repo stores investigations (local or a cloud project)');
  context
    .command('list')
    .description('List the local context and the cloud contexts you can use')
    .action(async () => {
      process.exitCode = await runContextList();
    });
  context
    .command('use <target>')
    .description('Switch context: "local" or "<org>/<workspace>/<project>"')
    .action(async (target: string) => {
      process.exitCode = await runContextUse(target);
    });
  context
    .command('show')
    .description('Show the active context and the selected project\'s sync metadata')
    .action(async () => {
      process.exitCode = await runContextShow();
    });

  const cloud = program
    .command('cloud')
    .description('Link this repo to a Horus Cloud project and inspect cloud state');
  cloud
    .command('link')
    .description('Link the current repo to a cloud project (Git-aware)')
    .option('--project <org/workspace/project>', 'target project (skips the interactive picker)')
    .option('-y, --yes', 'skip confirmation prompts')
    .action(async (opts: { project?: string; yes?: boolean }) => {
      process.exitCode = await runCloudLink({ project: opts.project, yes: opts.yes });
    });
  cloud
    .command('unlink')
    .description("Remove this repo's cloud link (returns to local mode)")
    .action(async () => {
      process.exitCode = await runCloudUnlink();
    });
  cloud
    .command('status')
    .description('Show the active context, linked project, sync metadata, and auth state')
    .action(async () => {
      process.exitCode = await runCloudStatus();
    });
  cloud
    .command('sync')
    .description('Upload existing local investigations to the linked cloud project')
    .option('-c, --config <path>', 'path to horus config for the local database')
    .option('--limit <n>', 'max local investigations to consider', (v) => Number.parseInt(v, 10))
    .option('--dry-run', 'show what would be uploaded without uploading')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (opts: { config?: string; limit?: number; dryRun?: boolean; yes?: boolean }) => {
      process.exitCode = await runCloudSync({
        config: opts.config,
        limit: opts.limit,
        dryRun: opts.dryRun,
        yes: opts.yes,
      });
    })
    .addHelpText('after', `
Examples:
  horus cloud sync --dry-run     # preview what would upload
  horus cloud sync               # confirm, then upload
  horus cloud sync --yes         # upload without prompting`);

  program
    .command('feedback [investigationId]')
    .description('Leave quick impact feedback on an investigation — defaults to the latest (helps improve Horus)')
    .option(
      '--resolved <verdict>',
      'did Horus point at the cause? yes | partly | no — non-interactive, for agents/scripts',
    )
    .option(
      '--manual-estimate-min <minutes>',
      'estimated minutes this would have taken manually (optional, pair with --resolved)',
    )
    .option(
      '--cause <text>',
      'the human-confirmed root cause, recorded onto the outcome label (pair with --resolved)',
    )
    .option(
      '--note <text>',
      'free-text context recorded onto the outcome label (pair with --resolved)',
    )
    .option('-c, --config <path>', 'path to horus.config.ts')
    .option('--repo <name>', 'project/repository to scope the persisted label to (default: inferred)')
    .action(
      async (
        investigationId: string | undefined,
        opts: {
          resolved?: string;
          manualEstimateMin?: string;
          config?: string;
          repo?: string;
          note?: string;
          cause?: string;
        },
      ) => {
        process.exitCode = await runFeedback(investigationId, opts);
      },
    );

  program
    .command('report [hint]')
    .description('File a Horus bug or capability gap — opens a pre-filled GitHub issue (no auth, no data sent)')
    .option('--title <text>', 'issue title (default: derived from the hint)')
    .option('--body <text>', 'issue body / description')
    .option('--labels <list>', 'comma-separated GitHub labels (e.g. bug,cli)')
    .option('-c, --config <path>', 'path to horus.config.ts')
    .action(
      async (
        hint: string | undefined,
        opts: { title?: string; body?: string; labels?: string; config?: string },
      ) => {
        process.exitCode = await runReportIssue({
          hint,
          title: opts.title,
          body: opts.body,
          labels: opts.labels,
          config: opts.config,
        });
      },
    )
    .addHelpText('after', `
Examples:
  horus report "explain command crashes on monorepos"
  horus report --title "Axiom connector ignores --service" --labels bug,connectors`);

  const telemetry = program
    .command('telemetry')
    .description('Manage anonymous usage telemetry that helps improve Horus');
  telemetry
    .command('status')
    .description('Show the effective telemetry decision, saved preferences, and install ID')
    .action(async () => {
      process.exitCode = await runTelemetryStatus();
    });
  telemetry
    .command('enable')
    .description('Turn on anonymous usage metadata (Tier A)')
    .action(async () => {
      process.exitCode = await runTelemetryEnable();
    });
  telemetry
    .command('disable')
    .description('Turn off all telemetry (Tier A and Tier B)')
    .action(async () => {
      process.exitCode = await runTelemetryDisable();
    });
  telemetry
    .command('enable-content')
    .description('Opt in to sharing redacted investigation inputs/outputs (Tier B)')
    .action(async () => {
      process.exitCode = await runTelemetryEnableContent();
    });
  telemetry
    .command('disable-content')
    .description('Stop sharing inputs/outputs; keep usage metadata (Tier B off)')
    .action(async () => {
      process.exitCode = await runTelemetryDisableContent();
    });
  telemetry
    .command('reset-id')
    .description('Generate a new random install ID')
    .action(async () => {
      process.exitCode = await runTelemetryResetId();
    });
  telemetry
    .command('delete')
    .description('Delete local telemetry state (install ID + saved preferences)')
    .action(async () => {
      process.exitCode = await runTelemetryDelete();
    });
  telemetry.addHelpText(
    'after',
    `
Defaults: usage metadata ON (with this notice), content sharing OFF.
Hard opt-out via env: HORUS_TELEMETRY=0 or DO_NOT_TRACK=1.

Examples:
  horus telemetry status
  horus telemetry disable
  horus telemetry enable-content`,
  );

  return program;
}

export { reportCrash } from './lib/report-crash.js';

export async function run(argv: string[] = process.argv): Promise<void> {
  // One-time disclosure + install-identity bootstrap. Never throws/blocks.
  maybeShowFirstRunNotice(argv);
  const program = buildProgram();
  // Tier-A usage events (command.invoked/completed) — fire-and-forget, gated on
  // consent, spooled locally. Never affects command behavior.
  installCommandTelemetry(program);
  // `--no-input` is a global, position-independent kill-switch for interactive prompts
  // (CI/agents). Strip it before commander parses so no subcommand sees an unknown option;
  // the feedback nudge reads the original process.argv to honor it. `HORUS_NO_INPUT=1` works too.
  const parseArgv = argv.filter((a) => a !== '--no-input');
  await program.parseAsync(parseArgv);
  // Best-effort, time-boxed drain of spooled events to the cloud. Never throws.
  await flushTelemetry();
  // Resolution-time feedback nudge (HOR-431): at the END of a run, if a prior investigation is
  // still unlabeled and old enough, ask once. Deferred (never at investigate time), rate-limited,
  // dismissible, suppressed on non-TTY/CI/--json/--no-input. Never blocks or throws.
  await maybePromptResolutionFeedback();
}
