import pc from 'picocolors';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadConfig, resolveEnvironment, resolveAiSettings, redactContent, redactOrDrop } from '@horus/core';
import type { ShopifyQuerySpec } from '@horus/core';
import { updateInvestigationReport } from '@horus/db';
import { renderReport, reportToJSON, reportToMarkdown } from '@horus/engine';
import type { InvestigationReport, StoredAIJudgment } from '@horus/engine';
import { renderNarrative, AnthropicNarrativeProvider } from '@horus/ai';
import type { NarrativeInput, NarrativeOutput, NarrativeProvider } from '@horus/ai';
import type { Evidence } from '@horus/engine';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { uploadInvestigationToCloud } from '../lib/cloud/investigation-sync.js';
import { track } from '../lib/telemetry/client.js';
import { isContentSharingEnabled } from '../lib/telemetry/consent.js';
import { reportCloudError } from './context.js';
import { computeFreshness, renderFreshness, readIndexMeta, commitsSince } from '../lib/freshness.js';
import { failCommand } from '../lib/command-failure.js';
import {
  buildInvestigationContext,
  runOneInvestigation,
  disposeInvestigationContext,
  withDeadline,
} from '../lib/investigation-runner.js';

// Re-exported for back-compat: existing tests import `withDeadline` from this module.
export { withDeadline };

/**
 * Resolve `--shopify-query` values into query specs supplied to the investigation. Each value
 * is `@path` (read the file), `-` (read stdin), or a raw GraphQL string. `--shopify-variables`
 * (`@file` or inline JSON object) applies to every query. `bindWindow` auto-enables when a
 * query references `$from`/`$to`, so the engine injects the investigation window. The query
 * text is executed verbatim — never rewritten. Throws on an unreadable file / bad JSON.
 */
export function resolveShopifyQueries(
  values: string[] | undefined,
  variablesRaw: string | undefined,
): ShopifyQuerySpec[] {
  if (values === undefined || values.length === 0) return [];
  const variables = parseShopifyVariables(variablesRaw);
  let stdinCache: string | null = null;
  return values.map((raw, i) => {
    const value = raw.trim();
    let query: string;
    let name = `q${i + 1}`;
    if (value === '-') {
      stdinCache ??= readFileSync(0, 'utf8');
      query = stdinCache;
      name = 'stdin';
    } else if (value.startsWith('@')) {
      const path = value.slice(1);
      query = readFileSync(path, 'utf8');
      name = basename(path).replace(/\.[^.]+$/, '') || name;
    } else {
      query = raw;
    }
    const spec: ShopifyQuerySpec = { name, query, kind: 'state' };
    if (variables !== undefined) spec.variables = variables;
    if (/\$(from|to)\b/.test(query)) spec.bindWindow = true;
    return spec;
  });
}

/** Parse `--shopify-variables` (`@file` or inline JSON) into a variables object, or undefined. */
function parseShopifyVariables(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  const text = trimmed.startsWith('@') ? readFileSync(trimmed.slice(1), 'utf8') : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('--shopify-variables is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--shopify-variables must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function extractEvidenceExcerpt(e: Evidence): string | undefined {
  if (!e.payload || typeof e.payload !== 'object') return undefined;
  const p = e.payload as Record<string, unknown>;
  const candidate =
    (typeof p['pattern'] === 'string' ? p['pattern'] : null) ??
    (typeof p['message'] === 'string' ? p['message'] : null) ??
    (typeof p['label'] === 'string' ? p['label'] : null) ??
    (typeof p['summary'] === 'string' ? p['summary'] : null) ??
    (typeof p['valueLabel'] === 'string' ? p['valueLabel'] : null);
  return candidate ? candidate.slice(0, 120) : undefined;
}

export function buildNarrativeInput(report: InvestigationReport): NarrativeInput {
  return {
    investigationId: report.id,
    hint: report.input.hint,
    reportConfidence: report.confidence,
    evidence: report.evidence.map((e) => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      excerpt: extractEvidenceExcerpt(e),
    })),
    knownServices: report.input.service ? [report.input.service] : [],
    suspectedCauses: report.suspectedCauses.map((c) => ({
      label: c.title,
      score: c.finalScore,
      evidenceIds: c.sourceEvidenceIds,
    })),
    deterministicSummary: report.summary,
    findings: report.findings.map((f) => ({
      title: f.title,
      evidenceIds: f.evidenceIds,
    })),
    hypotheses: report.hypotheses.map((h) => ({
      id: h.id,
      category: h.category,
      statement: h.statement,
      deterministicVerdict: h.verdict,
      deterministicConfidence: h.confidence,
      supportingEvidenceIds: h.supportingEvidenceIds,
    })),
  };
}

/** Map a NarrativeOutput to the StoredAIJudgment shape for persistence. */
export function narrativeOutputToStoredJudgment(
  output: NarrativeOutput,
  provider: string,
): StoredAIJudgment {
  const judgment: StoredAIJudgment = {
    what: output.what,
    why: output.why,
    whereNext: output.whereNext,
    citations: output.citations,
    confidence: output.confidence,
    provider,
    generatedAt: new Date().toISOString(),
  };
  if (output.mentionedServices) judgment.mentionedServices = output.mentionedServices;
  if (output.hypothesisJudgments) judgment.hypothesisJudgments = output.hypothesisJudgments;
  if (output.rootCauseAssessment) judgment.rootCauseAssessment = output.rootCauseAssessment;
  return judgment;
}

/** Render a stored AI judgment to the console. */
export function renderStoredAIJudgment(
  judgment: StoredAIJudgment,
  write: (line: string) => void = (l) => console.log(l),
): void {
  const sep = '─'.repeat(60);
  write(`\n${sep}`);
  write(pc.bold('AI Judgment') + pc.dim(` (confidence: ${(judgment.confidence * 100).toFixed(0)}%, provider: ${judgment.provider})`));
  write(sep);

  if (judgment.hypothesisJudgments && judgment.hypothesisJudgments.length > 0) {
    write(pc.bold('Hypothesis verdicts:'));
    for (const j of judgment.hypothesisJudgments) {
      const verdictColor =
        j.verdict === 'supported' ? pc.green :
        j.verdict === 'weakened' ? pc.yellow :
        j.verdict === 'eliminated' ? pc.red : pc.dim;
      write(`  ${verdictColor(`[${j.verdict}]`)} ${j.category}` + pc.dim(` (${(j.confidence * 100).toFixed(0)}%)`));
      write(pc.dim(`    ${j.rationale}`));
    }
    write('');
  }

  if (judgment.rootCauseAssessment) {
    const rca = judgment.rootCauseAssessment;
    const uncertaintyColor =
      rca.uncertainty === 'low' ? pc.green :
      rca.uncertainty === 'medium' ? pc.yellow : pc.red;
    write(pc.bold('Root cause assessment:') + pc.dim(` uncertainty: ${uncertaintyColor(rca.uncertainty)}`));
    write(rca.summary);
    if (rca.citedEvidenceIds.length > 0) {
      write(pc.dim(`  Cited: ${rca.citedEvidenceIds.join(', ')}`));
    }
    write('');
  }

  write(pc.bold('What:') + ' ' + judgment.what);
  write(pc.bold('Why:') + ' ' + judgment.why);
  if (judgment.whereNext.length > 0) {
    write(pc.bold('Next steps:'));
    for (const step of judgment.whereNext) {
      write(`  • ${step}`);
    }
  }
  if (judgment.citations.length > 0) {
    write(pc.dim(`\nCited evidence: ${judgment.citations.map((c) => c.evidenceId).join(', ')}`));
  }
}

/**
 * Classify an AI provider failure reason into a user-readable string.
 * Inspects the first validationError to distinguish common failure modes.
 */
export function classifyAIFailure(firstError?: string): string {
  if (!firstError) return 'provider unavailable';
  if (/401|unauthorized|api.key|api key/i.test(firstError)) {
    return 'missing or invalid API key — set ANTHROPIC_API_KEY';
  }
  if (/invalid.request|model|not.found/i.test(firstError)) {
    return `invalid model or request — ${firstError}`;
  }
  if (/econnrefused|enotfound|network|fetch|abort/i.test(firstError)) {
    return 'network error — check connectivity';
  }
  return firstError;
}

/**
 * Compact the JSON projection of an investigation report IN PLACE — the agent-facing
 * default. Dogfood: the "compact" output was still ~105 KB, with `recentChanges`
 * alone ~52 KB (every in-window commit with its full file list) and the raw graph
 * ~9 KB. Keeps counts + bounded tops + truncation metadata; `--full` skips this and
 * restores the raw report. Exported for the size-budget regression test.
 */
export function compactInvestigateJSON(obj: Record<string, unknown>): void {
  // Evidence payloads/snippets carry raw source strings — keep citable metadata only.
  const ev = obj['evidence'];
  if (Array.isArray(ev)) {
    obj['evidence'] = ev.map((e) => {
      const { payload: _payload, ...rest } = e as Record<string, unknown>;
      return { ...rest, payload: '[omitted — re-run with --full]' };
    });
  }

  // recentChanges → bounded projection: counts, top commits WITHOUT file lists, and
  // the top changed files by churn (from fileStats).
  const rc = obj['recentChanges'] as
    | {
        commits?: Array<{ sha?: string; shortSha?: string; author?: string; dateIso?: string; subject?: string; files?: string[] }>;
        fileStats?: Array<{ path: string; insertions: number; deletions: number }>;
        changedFiles?: string[];
        [k: string]: unknown;
      }
    | undefined;
  if (rc && Array.isArray(rc.commits)) {
    const COMMIT_CAP = 10;
    const FILE_CAP = 15;
    const commits = rc.commits.slice(0, COMMIT_CAP).map((c) => ({
      shortSha: c.shortSha ?? (c.sha ?? '').slice(0, 7),
      dateIso: c.dateIso,
      author: c.author,
      subject: c.subject,
      fileCount: c.files?.length ?? 0,
    }));
    const topChangedFiles = [...(rc.fileStats ?? [])]
      .sort((a, b) => b.insertions + b.deletions - (a.insertions + a.deletions))
      .slice(0, FILE_CAP);
    const omitted = rc.commits.length - commits.length;
    obj['recentChanges'] = {
      window: rc['window'],
      commitCount: rc.commits.length,
      changedFileCount: rc.changedFiles?.length ?? rc.fileStats?.length ?? 0,
      totalInsertions: rc['totalInsertions'],
      totalDeletions: rc['totalDeletions'],
      degenerate: rc['degenerate'],
      commits,
      topChangedFiles,
      ...(omitted > 0
        ? { truncated: true, truncatedCount: omitted, hint: 're-run with --full for the complete structure' }
        : { truncated: rc['truncated'] }),
      ...(rc['truncatedReason'] !== undefined ? { truncatedReason: rc['truncatedReason'] } : {}),
    };
  }

  // graph → counts only; the full node/edge lists are a --full concern.
  const graph = obj['graph'] as { nodes?: unknown[]; edges?: unknown[] } | undefined;
  if (graph && (Array.isArray(graph.nodes) || Array.isArray(graph.edges))) {
    obj['graph'] = {
      nodeCount: graph.nodes?.length ?? 0,
      edgeCount: graph.edges?.length ?? 0,
      hint: 're-run with --full for nodes/edges',
    };
  }
}

export async function runInvestigate(
  hint: string,
  opts: {
    config?: string;
    env?: string;
    /** @deprecated use project — kept for back-compat with parked commands */
    repo?: string;
    /** Path scope for seed resolution (e.g. packages/core) — HOR-356. */
    scope?: string;
    since?: string;
    /** Widen the runtime-log window independently of `--since` (a duration like 30d/24h). */
    logsSince?: string;
    /** Shopify Admin GraphQL query/queries to run as evidence: `@file`, `-` (stdin), or raw. */
    shopifyQuery?: string[];
    /** Variables (`@file` or inline JSON object) applied to every `--shopify-query`. */
    shopifyVariables?: string;
    /** Overall investigation deadline in seconds (default 120). */
    timeout?: string;
    service?: string;
    json?: boolean;
    format?: string;
    full?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for smoke tests — bypasses credential requirement. */
    _aiProvider?: NarrativeProvider;
  },
): Promise<number> {
  // Validate the output format BEFORE any work — `--format xml` used to silently
  // fall back to text after a full investigation ran (dogfood).
  const requestedFormat = opts.json ? 'json' : (opts.format ?? 'text');
  if (!['text', 'json', 'markdown', 'md'].includes(requestedFormat)) {
    console.error(pc.red(`Unknown format "${requestedFormat}". Valid: text, json, markdown.`));
    return 1;
  }
  try {
    const config = await loadConfig(opts.config);

    // Resolve any invocation-time Shopify queries (@file / stdin / raw) before wiring — a bad
    // path or malformed variables JSON should fail fast with a clear message, not mid-run.
    let shopifyQueries: ShopifyQuerySpec[];
    try {
      shopifyQueries = resolveShopifyQueries(opts.shopifyQuery, opts.shopifyVariables);
    } catch (err) {
      console.error(pc.red(`--shopify-query: ${(err as Error).message}`));
      return 1;
    }

    // --repo selects a repository/project WITHIN this config; default = cwd inference.
    const projectName = opts.repo;

    let renv;
    try {
      renv = resolveEnvironment(config, { project: projectName, env: opts.env });
    } catch (err) {
      return failCommand(err, opts.json || opts.format === 'json');
    }

    const repoRoot = repoRootOrCwd(renv.path);
    const cloudCfg = readCloudConfig(repoRoot);
    const cloudActive = isCloudActive(cloudCfg);
    const cloudSession = cloudActive ? authedClient() : null;
    if (cloudActive && !cloudSession) {
      // Horus Cloud is OPTIONAL — never block a local investigation on it. Warn and
      // proceed locally; the cloud upload at the end is simply skipped when there is
      // no session (see the `cloudSession` guard before uploadInvestigationToCloud).
      console.error(
        pc.yellow(
          `This repo is linked to Horus Cloud but you are not logged in — running locally only. ` +
            `Run ${pc.bold('horus login')} to also sync results to the cloud.`,
        ),
      );
    }

    // Build the connector deps + open the DB via the shared runner (HOR-CLI): self-heals a
    // down source host, degrades to runtime-only when it stays down, and resolves every
    // runtime connector. `horus watch` reuses the exact same wiring — do not duplicate it.
    let ctx;
    try {
      ctx = await buildInvestigationContext(renv, {
        databaseUrl: config.database.url,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
      });
    } catch (err) {
      // No source-intelligence connector configured — same hard requirement as before.
      return failCommand(err, opts.json || opts.format === 'json');
    }

    try {
      // Overall deadline so an unreachable/slow connector (e.g. a dropped tunnel or a stuck
      // source-intelligence query) can never hang the investigation forever (HOR — reliability).
      const timeoutSec =
        (opts.timeout !== undefined ? Number(opts.timeout) : 0) ||
        Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) ||
        120;
      const report = await runOneInvestigation(
        {
          hint,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(opts.logsSince !== undefined ? { logsSince: opts.logsSince } : {}),
          ...(shopifyQueries.length > 0 ? { shopifyQueries } : {}),
        },
        ctx,
        { timeoutMs: timeoutSec * 1000 },
      );
      const db = ctx.dbHandle.db;
      // --json is back-compat for --format json.
      const format = opts.json ? 'json' : (opts.format ?? 'text');
      // HOR-362: how fresh are the inputs behind this report? (code index age, git drift,
      // runtime window). Index drift = commits on HEAD since the index was built.
      const fmeta = readIndexMeta(repoRoot);
      const commitsSinceIndex = fmeta?.lastIndexedAt
        ? await commitsSince(repoRoot, fmeta.lastIndexedAt)
        : null;
      const freshness = computeFreshness({
        repoRoot,
        evidence: report.evidence,
        nowIso: new Date().toISOString(),
        meta: fmeta,
        commitsSinceIndex,
        anyRuntimeConnector: report.sourceStatus?.sources.some((s) => s.configured) ?? false,
      });
      if (format === 'json') {
        const obj = JSON.parse(reportToJSON(report)) as Record<string, unknown>;
        obj.freshness = freshness;
        // Compact by default (agent-facing) — `--full` restores the raw report.
        if (!opts.full) compactInvestigateJSON(obj);
        console.log(JSON.stringify(obj, null, 2));
      } else {
        console.log(format === 'markdown' || format === 'md' ? reportToMarkdown(report) : renderReport(report));
        console.log('');
        console.log(renderFreshness(freshness));
      }

      if (opts.ai && format !== 'json') {
        // Resolve AI settings saved via `horus connect ai` (key + model), with the
        // ANTHROPIC_API_KEY env as fallback. CLI --ai-model overrides the saved model.
        const ai = resolveAiSettings(config);
        const model = opts.aiModel ?? ai.model ?? 'claude-opus-4-8';
        const provider =
          opts._aiProvider ??
          new AnthropicNarrativeProvider({
            model,
            ...(ai.anthropicApiKey !== undefined ? { apiKey: ai.anthropicApiKey } : {}),
          });
        console.log(pc.dim(`[ai] model: ${model}`));

        const narrativeInput = buildNarrativeInput(report);
        const { output, fromProvider, degraded, validationErrors } = await renderNarrative(
          narrativeInput,
          { provider },
        );

        if (fromProvider) {
          // Persist AI judgment in the report and update DB (HOR-198)
          const stored = narrativeOutputToStoredJudgment(output, 'anthropic');
          report.aiJudgment = stored;
          try {
            await updateInvestigationReport(db, report.id, report);
          } catch {
            // best-effort — display still works even if DB update fails
          }
          renderStoredAIJudgment(stored);
        } else if (degraded) {
          // The model produced usable prose that didn't fully validate — show it in a
          // clearly-labeled unstructured section rather than discarding it (HOR-213).
          if (validationErrors && validationErrors.length > 0) {
            console.error(pc.yellow(`[ai] structured validation incomplete — showing raw AI narrative`));
          }
          console.log('');
          console.log(pc.dim('─'.repeat(60)));
          console.log(pc.bold('AI narrative ') + pc.yellow('(unstructured — not validated)'));
          if (output.what?.trim()) {
            console.log(pc.bold('\nWhat:'), output.what.trim());
          }
          if (output.why?.trim()) {
            console.log(pc.bold('\nWhy:'), output.why.trim());
          }
          if (output.whereNext.length > 0) {
            console.log(pc.bold('\nNext:'));
            for (const a of output.whereNext) console.log(`  - ${a}`);
          }
        } else {
          const reason = classifyAIFailure(validationErrors?.[0]);
          console.error(pc.yellow(`[ai] fallback to deterministic — ${reason}`));
        }
      }

      // Tier-A usage signal: shape + confidence + gaps only, no report bodies (HOR-324).
      track({
        type: 'investigation.completed',
        investigationId: report.id,
        confidence: typeof report.confidence === 'number' ? report.confidence : null,
        evidenceCount: report.evidence?.length ?? 0,
        findingCount: report.findings?.length ?? 0,
        suspectedCauseCount: report.suspectedCauses?.length ?? 0,
        degraded: Boolean(report.degraded),
        gapCount: report.gapAnalysis?.gaps?.length ?? 0,
        hasAi: Boolean(report.aiJudgment),
      });

      // Tier-B (explicit content opt-in): redacted inputs/outputs to improve the
      // engine + future ML (HOR-325). Every field is scrubbed; the hint is
      // fail-closed (dropped if a secret survives), in which case we send nothing.
      if (isContentSharingEnabled()) {
        const hint = redactOrDrop(report.input.hint ?? '');
        if (!hint.dropped) {
          track({
            type: 'investigation.content',
            investigationId: report.id,
            hint: hint.value ?? '',
            summary: redactContent(report.summary ?? ''),
            findingTitles: (report.findings ?? [])
              .slice(0, 20)
              .map((f) => redactContent(f.title ?? '')),
            suspectedCauseTitles: (report.suspectedCauses ?? [])
              .slice(0, 20)
              .map((c) => redactContent(c.title ?? '')),
            confidence: typeof report.confidence === 'number' ? report.confidence : null,
          });
        }
      }

      if (cloudActive && cloudSession && cloudCfg) {
        try {
          // Pass the local db so a recorded human outcome label (HOR-390) rides the sync.
          const refs = await uploadInvestigationToCloud(cloudSession.client, cloudCfg, report, {
            db,
          });
          // Never write the human notice to STDOUT under --json — it corrupts the
          // machine-readable output (a trailing non-JSON line breaks every parser).
          const cloudNote = pc.dim(`[cloud] investigation saved: ${refs.investigationId}`);
          if (format === 'json') console.error(cloudNote);
          else console.log(cloudNote);
        } catch (err) {
          return reportCloudError(err);
        }
      }

      // HOR-319 (Bug 1): point the user at the id that `horus ask` accepts. report.id is
      // the local id printed in the header and now resolves in both local and cloud mode.
      if (format !== 'json') {
        if (report.persisted === false) {
          // DB-resilient degrade (HOR-319): the investigation store was unreachable,
          // so the report wasn't saved — be explicit instead of pointing at an id
          // that `horus ask` can't resolve.
          console.error(
            pc.yellow(`\n⚠ Results were not saved — the investigation database was unreachable.`),
          );
          console.error(
            pc.dim(
              `  This report is display-only; \`horus ask\` won't find it. Start the database and re-run to persist.`,
            ),
          );
        } else {
          console.log(pc.dim(`\nAsk a follow-up:  horus ask ${report.id} "<question>"`));
        }
        // Shared footer nudge (HOR-431 / HOR-439): teach Horus when the cause is wrong, or
        // file a bug/gap. Dim, two tight lines — the same wording reused across surfaces.
        // The interactive feedback PROMPT is deferred to a later run (HOR-431, resolution-time
        // nudge) — never asked here at investigate time, before the user knows if Horus was right.
        console.log(pc.dim(`  Wrong cause? Teach Horus:  horus feedback`));
        console.log(pc.dim(`  Bug or gap? File an issue:  horus report`));
      }
    } finally {
      // Close EVERY connector + the DB — an unclosed pg/ioredis handle keeps the Node event
      // loop alive so the CLI prints its report but never exits (the process lingers forever).
      await disposeInvestigationContext(ctx);
    }

    return 0;
  } catch (err) {
    // Never fail silently: surface a message even when the error carries none,
    // and include the stack under HORUS_DEBUG for diagnosis. Route through the shared
    // machine-JSON failure contract so `--json`/`--format json` still emits ONE parseable
    // object on stdout (agents pipe stdout to json.load) instead of leaving it empty.
    const msg = (err as Error)?.message || String(err);
    const detail = msg.trim() ? msg : 'Investigation failed (unknown error).';
    const code = failCommand(new Error(detail), opts.json || opts.format === 'json');
    if (process.env.HORUS_DEBUG) console.error(pc.dim((err as Error)?.stack ?? String(err)));
    return code;
  }
}
