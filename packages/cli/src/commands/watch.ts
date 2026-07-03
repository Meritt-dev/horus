/**
 * `horus watch` — proactive incident monitoring (HOR-CLI).
 *
 * Polls a configured error source on an interval and auto-investigates each NEW incident
 * exactly once. Sentry: new = an issue id not seen before. Elasticsearch: new = an error
 * signature the analyzer flagged `isNew` (absent from the baseline window) and not seen
 * before. For each new incident it derives a hint and runs the SHARED investigation runner
 * (`runOneInvestigation`) — the same wiring `horus investigate` uses — which persists the
 * report into the local DB, so auto-investigations land in incident memory + `horus ask`.
 *
 * Resilience is the whole point of a watcher: a failing poll or a failing investigation is
 * logged and the loop continues. It never crashes. `--once` runs a single cycle (cron/test);
 * otherwise it loops until SIGINT, then shuts down cleanly (closes connectors + DB).
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import type { SentryIssue, ErrorSignature, SentryProvider, LogsProvider } from '@horus/connectors';
import type { InvestigationReport } from '@horus/engine';
import {
  buildInvestigationContext,
  runOneInvestigation,
  disposeInvestigationContext,
  type InvestigationContext,
} from '../lib/investigation-runner.js';
import { dispatchNotify, shouldNotify } from '../lib/notify-sink.js';

export type WatchSource = 'sentry' | 'elasticsearch' | 'auto';

export interface WatchOptions {
  config?: string;
  name?: string;
  project?: string;
  env?: string;
  source?: WatchSource;
  /** Poll interval in seconds (default 60). */
  interval?: string;
  /** Run a single poll cycle, then exit (for cron/testing). */
  once?: boolean;
}

// ---------------------------------------------------------------------------
// Pure detection + hint derivation (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Of `issues`, return those whose id is not already in `seen`, and record them as seen.
 * Dedup is by issue id, so the same incident triggers an investigation exactly once across
 * polls. Issues with an empty id are skipped (un-trackable).
 */
export function detectNewSentryIncidents(
  issues: SentryIssue[],
  seen: Set<string>,
): SentryIssue[] {
  const fresh: SentryIssue[] = [];
  for (const issue of issues) {
    if (!issue.id || seen.has(issue.id)) continue;
    seen.add(issue.id);
    fresh.push(issue);
  }
  return fresh;
}

/**
 * Of `signatures`, return those the analyzer flagged `isNew` (absent from the baseline
 * window) that we haven't acted on before, keyed by signature `key` (the event_code).
 * Records each returned key as seen so it never re-triggers.
 */
export function detectNewEsSignatures(
  signatures: ErrorSignature[],
  seen: Set<string>,
): ErrorSignature[] {
  const fresh: ErrorSignature[] = [];
  for (const sig of signatures) {
    if (sig.isNew !== true) continue;
    if (!sig.key || seen.has(sig.key)) continue;
    seen.add(sig.key);
    fresh.push(sig);
  }
  return fresh;
}

/** Pull an event_code-like token off a Sentry issue when one is present in its metadata. */
function sentryEventCode(issue: SentryIssue): string | undefined {
  const withCode = issue as SentryIssue & { metadata?: { value?: string }; shortId?: string };
  // Sentry surfaces a short id like "LEADCALL-API-3X" — usable as a stable code token.
  if (typeof withCode.shortId === 'string' && withCode.shortId.length > 0) return withCode.shortId;
  return undefined;
}

/**
 * Derive the investigation hint for a Sentry issue: prefer the issue title, append the
 * culprit (the function/transaction where it surfaced) when present, or fall back to an
 * event_code token. Bounded so the hint stays a clean one-liner.
 */
export function hintFromSentryIssue(issue: SentryIssue): string {
  const title = (issue.title ?? '').trim();
  const culprit = (issue.culprit ?? '').trim();
  const code = sentryEventCode(issue);
  let hint: string;
  if (title) hint = culprit ? `${title} (${culprit})` : title;
  else if (culprit) hint = culprit;
  else if (code) hint = code;
  else hint = '(untitled Sentry issue)';
  return hint.slice(0, 200);
}

/**
 * Derive the investigation hint for an Elasticsearch error signature: its `key` is the
 * event_code. Append a sample message when present so the hint is human-meaningful even
 * when the code alone is opaque.
 */
export function hintFromEsSignature(sig: ErrorSignature): string {
  const key = (sig.key ?? '').trim();
  const sample = (sig.sampleMessage ?? '').trim();
  let hint: string;
  if (key && key !== '(none)') hint = sample ? `${key}: ${sample}` : key;
  else if (sample) hint = sample;
  else hint = '(new error signature)';
  return hint.slice(0, 200);
}

/** The headline cause + confidence line for one finished investigation. */
export function headlineFor(report: InvestigationReport): { cause: string; confidence: number } {
  const top = report.suspectedCauses[0];
  return {
    cause: top?.title ?? 'no clear cause',
    confidence: typeof report.confidence === 'number' ? report.confidence : 0,
  };
}

// ---------------------------------------------------------------------------
// Source polling
// ---------------------------------------------------------------------------

/** A normalized incident discovered by a poll, ready to investigate. */
interface DiscoveredIncident {
  hint: string;
  /** A short tracking label for logs (issue id or signature key). */
  ref: string;
}

/**
 * Poll Sentry once: list recent issues, detect ones not seen before, and turn each into a
 * `DiscoveredIncident`. Degrades to [] on any error (collect() failures are caught here).
 */
async function pollSentry(
  sentry: SentryProvider,
  seen: Set<string>,
): Promise<DiscoveredIncident[]> {
  // SentryProvider wraps the client; reach its issue list via collect() (frames resolved
  // best-effort). We only need the issue metadata here, not the frames. collect()
  // throws on transport/auth failure — the poll loop degrades to [] and retries
  // next tick rather than killing the watcher.
  const signatures = await sentry.collect({}).catch(() => []);
  const issues = signatures.map((s) => s.issue);
  return detectNewSentryIncidents(issues, seen).map((issue) => ({
    hint: hintFromSentryIssue(issue),
    ref: issue.id,
  }));
}

/**
 * Poll Elasticsearch once: analyze the recent error window, take signatures the analyzer
 * flagged NEW that we haven't acted on, and turn each into a `DiscoveredIncident`.
 */
async function pollElasticsearch(
  logs: LogsProvider,
  seen: Set<string>,
  service?: string,
): Promise<DiscoveredIncident[]> {
  const analysis = await logs.analyzeErrors(service !== undefined ? { service } : {});
  return detectNewEsSignatures(analysis.signatures, seen).map((sig) => ({
    hint: hintFromEsSignature(sig),
    ref: sig.key,
  }));
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Resolve which source to poll. `auto` picks Sentry if configured, else Elasticsearch.
 * Returns null with a printed reason when the requested source isn't usable.
 */
function resolveSource(
  requested: WatchSource,
  ctx: InvestigationContext,
): 'sentry' | 'elasticsearch' | null {
  const hasSentry = ctx.sentry !== null;
  const hasEs = ctx.logs !== null;
  if (requested === 'sentry') return hasSentry ? 'sentry' : null;
  if (requested === 'elasticsearch') return hasEs ? 'elasticsearch' : null;
  // auto
  if (hasSentry) return 'sentry';
  if (hasEs) return 'elasticsearch';
  return null;
}

export async function runWatch(opts: WatchOptions): Promise<number> {
  const config = await loadConfig(opts.config, { name: opts.name });

  let renv;
  try {
    renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }

  let ctx: InvestigationContext;
  try {
    ctx = await buildInvestigationContext(renv, { databaseUrl: config.database.url });
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }

  const requested: WatchSource = opts.source ?? 'auto';
  const source = resolveSource(requested, ctx);
  if (source === null) {
    console.error(
      pc.red(
        requested === 'auto'
          ? `No Sentry or Elasticsearch connector configured for "${renv.project}" / "${renv.env}".`
          : `No ${requested} connector configured for "${renv.project}" / "${renv.env}".`,
      ),
    );
    await disposeInvestigationContext(ctx);
    return 1;
  }

  const intervalSec = Math.max(1, Number(opts.interval) || 60);
  const seen = new Set<string>();

  // Seen-set dedup means the FIRST poll fires investigations for everything currently open —
  // that's intended for --once (a one-shot sweep). A long-running watcher will then only act
  // on incidents that appear after start.
  console.error(
    pc.dim(
      `[watch] source: ${source} · project: ${renv.project} · env: ${renv.env}` +
        (opts.once ? ' · mode: once' : ` · interval: ${intervalSec}s`),
    ),
  );

  // One poll cycle: discover new incidents, investigate + persist each, print one line each.
  // A poll error or a per-incident investigation error is logged and never propagates — the
  // watcher must survive a flaky source or a single bad investigation.
  const pollOnce = async (): Promise<void> => {
    let incidents: DiscoveredIncident[];
    try {
      incidents =
        source === 'sentry'
          ? await pollSentry(ctx.sentry!, seen)
          : await pollElasticsearch(ctx.logs!, seen, ctx.service);
    } catch (err) {
      console.error(pc.yellow(`[watch] poll failed — ${(err as Error).message}`));
      return;
    }

    if (incidents.length === 0) {
      console.error(pc.dim(`[watch] no new incidents`));
      return;
    }

    for (const incident of incidents) {
      try {
        const report = await runOneInvestigation({ hint: incident.hint }, ctx);
        const { cause, confidence } = headlineFor(report);
        const persisted = report.persisted === false ? pc.yellow(' (not persisted)') : '';
        console.log(
          `${pc.bold('●')} ${incident.hint}  ${pc.dim('→')} ` +
            `${cause} ${pc.dim(`(${(confidence * 100).toFixed(0)}%)`)}  ` +
            `${pc.dim(`id: ${report.id}`)}${persisted}`,
        );
        // HOR-454: dispatch a confident headline to the configured outbound sink. Best-effort —
        // every result (ok or not) is logged and the loop continues (the watcher never crashes).
        if (shouldNotify(confidence, renv.notify)) {
          const results = await dispatchNotify(
            { id: report.id, confidence, hint: incident.hint, cause },
            renv.notify,
          );
          for (const r of results) {
            if (r.ok) console.error(pc.dim(`[watch] notified ${r.target} (${r.detail})`));
            else console.error(pc.yellow(`[watch] notify ${r.target} failed — ${r.detail}`));
          }
        }
      } catch (err) {
        console.error(
          pc.yellow(`[watch] investigation failed for "${incident.ref}" — ${(err as Error).message}`),
        );
      }
    }
  };

  if (opts.once) {
    await pollOnce();
    await disposeInvestigationContext(ctx);
    return 0;
  }

  // Long-running loop until SIGINT/SIGTERM. We poll, wait the interval, and repeat. The
  // shutdown handler flips `stopping`, breaks the sleep, and tears everything down cleanly.
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSignal = (): void => {
    if (stopping) return;
    stopping = true;
    console.error(pc.dim(`\n[watch] shutting down…`));
    if (wake) wake();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    while (!stopping) {
      await pollOnce();
      if (stopping) break;
      // Interruptible sleep: resolves on the interval OR immediately on a shutdown signal.
      await new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, intervalSec * 1000);
        // Don't keep the loop's sleep from being cut short on shutdown.
        if (typeof timer.unref === 'function') timer.unref();
      });
      wake = null;
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await disposeInvestigationContext(ctx);
  }

  return 0;
}
