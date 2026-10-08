/** Foreground entry point for the durable watcher shared with the macOS service.
 * Pure hint/detection helpers remain exported for compatibility with existing callers;
 * persistent event/episode acceptance lives in watch-store.ts.
 */

import type { SentryIssue, ErrorSignature } from '@horus/connectors';
import type { InvestigationReport } from '@horus/engine';

export type WatchSource = 'sentry' | 'elasticsearch' | 'pagerduty' | 'auto';

export interface WatchOptions {
  config?: string;
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

/** Foreground execution uses the same durable watcher as launchd. */
export async function runWatch(opts: WatchOptions & { settings?: string } = {}): Promise<number> {
  const { runService } = await import('./service.js');
  return runService('run', { settings: opts.settings, once: opts.once });
}
