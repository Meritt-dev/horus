/**
 * Resolution-time feedback nudge (HOR-431, Mechanism 2).
 *
 * The outcome-label corpus only grows when a human/agent attests whether an investigation pointed
 * at the real cause — and that is the flywheel's true bottleneck. Prompting at investigate TIME is
 * premature: the user does not yet know if Horus was right. So instead, on a LATER CLI run, if the
 * most-recent investigation is still unlabeled and old enough that the outcome is likely known, we
 * ask ONCE:
 *
 *     You have an investigation from <ago> without an outcome — a quick note trains Horus:
 *       "<title>"
 *       Did this point you at the cause? [y / partly / n]   (Enter to skip)
 *
 * Modeled on the update-notifier (HOR-383): the decision is made from a cheap cached state file so
 * the common run touches no DB; it is ONE-TIME per investigation, rate-limited (no nagging), fully
 * suppressed on non-TTY / CI / `--json` / `--no-input` / `HORUS_NO_INPUT` and during the `feedback`
 * and `mcp` commands, and it NEVER blocks or throws. The local label persists regardless of
 * telemetry consent (the corpus is local-first); only the Tier-A event self-gates on consent.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, listInvestigations, getLatestOutcomeLabel } from '@horus/db';
import { runFeedbackPrompt } from './telemetry/feedback.js';
import { persistOutcomeLabel } from '../commands/feedback.js';

const STATE_PATH = join(homedir(), '.horus', 'feedback-nudge.json');
/** Don't ask until the investigation is at least this old — the user must have time to learn the outcome. */
export const MIN_AGE_MS = 2 * 60 * 60 * 1000; // 2h
/** Ask at most once per this window — the dismissible, no-nag rate limit. */
export const RATE_LIMIT_MS = 20 * 60 * 60 * 1000; // ~once/day
/** Bound the remembered-id list so the state file can't grow without limit. */
const MAX_REMEMBERED = 50;

export interface NudgeState {
  /** Epoch ms of the last time we surfaced the nudge (any answer, including skip). */
  lastPromptMs: number;
  /** Investigation ids we've already nudged — one-time per investigation. */
  promptedIds: string[];
}

export interface LastInvestigation {
  id: string;
  title: string | null;
  createdAtMs: number;
}

/** Reasons to stay silent — same spirit as the update-notifier's suppression. */
export function isSuppressed(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  argv: string[] = process.argv,
): boolean {
  if (env['HORUS_NO_INPUT']) return true;
  if (env['CI']) return true;
  if (!isTTY) return true;
  if (argv.includes('--json')) return true;
  if (argv.includes('--no-input')) return true;
  // Don't nudge during the feedback command itself (redundant) or the long-running MCP server.
  const cmd = argv.slice(2).find((a) => !a.startsWith('-'));
  if (cmd === 'feedback' || cmd === 'mcp') return true;
  return false;
}

export function readState(path: string = STATE_PATH): NudgeState {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const lastPromptMs = typeof j['lastPromptMs'] === 'number' ? j['lastPromptMs'] : 0;
    const promptedIds = Array.isArray(j['promptedIds'])
      ? j['promptedIds'].filter((x): x is string => typeof x === 'string')
      : [];
    return { lastPromptMs, promptedIds };
  } catch {
    return { lastPromptMs: 0, promptedIds: [] };
  }
}

function writeState(state: NudgeState, path: string = STATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const trimmed: NudgeState = {
      lastPromptMs: state.lastPromptMs,
      promptedIds: state.promptedIds.slice(-MAX_REMEMBERED),
    };
    writeFileSync(path, JSON.stringify(trimmed) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Pure decision (testable): given the most-recent investigation, whether it is already labeled,
 * the saved state, and now — return the investigation to ask about, or null to stay silent.
 */
export function decideFeedbackNudge(input: {
  last: LastInvestigation | null;
  labeled: boolean;
  state: NudgeState;
  nowMs: number;
}): LastInvestigation | null {
  const { last, labeled, state, nowMs } = input;
  if (!last) return null; // nothing to ask about
  if (labeled) return null; // already attested — never re-ask
  if (nowMs - last.createdAtMs < MIN_AGE_MS) return null; // too fresh — never premature
  if (state.promptedIds.includes(last.id)) return null; // one-time per investigation
  if (nowMs - state.lastPromptMs < RATE_LIMIT_MS) return null; // rate-limited — no nagging
  return last;
}

/** Human-friendly age for the nudge line ("3 hours", "2 days"). */
function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The deferred resolution-time nudge. Safe to call at the end of every run — it must NEVER block,
 * throw, or corrupt output. Reuses the shared {@link runFeedbackPrompt} (so the prompt, telemetry
 * emit, and skip semantics match `horus feedback`) and persists the durable outcome label via the
 * same {@link persistOutcomeLabel} sink.
 */
export async function maybePromptResolutionFeedback(opts: { config?: string } = {}): Promise<void> {
  try {
    if (isSuppressed()) return;
    const nowMs = Date.now();
    const state = readState();
    // Cheap gate: if we nudged within the rate-limit window, skip WITHOUT opening the DB.
    if (nowMs - state.lastPromptMs < RATE_LIMIT_MS) return;

    // Due for a possible nudge — consult the DB for the latest investigation and its label.
    let last: LastInvestigation | null = null;
    let labeled = false;
    const config = await loadConfig(opts.config);
    // Scope to the active project — "the latest investigation" must not be another
    // project's on the shared DB (dogfood N1).
    let project: string | undefined;
    try {
      project = resolveEnvironment(config).project;
    } catch {
      /* unresolvable — leave unscoped */
    }
    const { db, sql } = await openDb(config.database.url);
    try {
      const row = (await listInvestigations(db, 1, { project }))[0];
      if (row) {
        last = { id: row.id, title: row.title ?? null, createdAtMs: new Date(row.createdAt).getTime() };
        labeled = (await getLatestOutcomeLabel(db, row.id)) !== null;
      }
    } finally {
      await sql.end();
    }

    const target = decideFeedbackNudge({ last, labeled, state, nowMs });
    if (!target) return;

    console.log(
      pc.dim(`\nYou have an investigation from ${formatAge(nowMs - target.createdAtMs)} without an outcome — a quick note trains Horus:`),
    );
    if (target.title) console.log(pc.dim(`  “${target.title}”`));
    const answer = await runFeedbackPrompt(target.id, null);
    if (answer !== null) {
      await persistOutcomeLabel(target.id, answer.resolved ?? '', answer.manualEstimateMinutes, {
        config: opts.config,
      });
    }
    // Record that we surfaced it (one-time per id + rate-limit), regardless of answer or skip.
    writeState({ lastPromptMs: nowMs, promptedIds: [...state.promptedIds, target.id] });
  } catch {
    /* a nudge must never break a command */
  }
}
