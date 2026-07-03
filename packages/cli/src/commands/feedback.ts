import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, recordOutcomeLabel, isOutcomeResolved, getLastInvestigationId } from '@horus/db';
import { runFeedbackPrompt, submitFeedback, parseResolved } from '../lib/telemetry/feedback.js';

/**
 * Persist a feedback verdict into the converged outcome-label / eval store (HOR-390) — the same
 * sink `horus memory confirm` writes to (source=confirm). This is what turns `horus feedback` from
 * telemetry-only into a durable, queryable signal (`horus memory accuracy`).
 *
 * BEST-EFFORT (never throws): feedback must never break or block on local persistence — the
 * telemetry emit is the floor, this is additive. A missing config, an unresolvable project, or a
 * DB error just means no local label this time. `project` is denormalized (best-effort) so accuracy
 * can be sliced per project; an unresolvable project is stored as null rather than failing.
 */
export async function persistOutcomeLabel(
  investigationId: string,
  resolved: string,
  manualEstimateMinutes: number | null,
  opts: { config?: string; repo?: string; note?: string; cause?: string },
): Promise<void> {
  // Only a concrete verdict (yes|partly|no) is an eval data point — an 'unsure'/null answer is not.
  if (!isOutcomeResolved(resolved)) return;
  try {
    const config = await loadConfig(opts.config);
    let project: string | null = null;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project ?? null;
    } catch {
      project = null;
    }
    const { db, sql } = await openDb(config.database.url);
    try {
      // The human-confirmed cause/note ride onto the label (same columns `memory confirm` writes),
      // so the flywheel corpus carries a real root cause — not just a yes/partly/no verdict.
      const note = opts.note?.trim() || null;
      const confirmedCause = opts.cause?.trim() || null;
      await recordOutcomeLabel(db, {
        investigationId,
        resolved,
        source: 'feedback',
        project,
        confirmedCause,
        note,
        payload: manualEstimateMinutes != null ? { manualEstimateMinutes } : null,
      });
    } finally {
      await sql.end();
    }
  } catch {
    // best-effort — persistence never breaks the telemetry-only feedback contract.
  }
}

/**
 * `horus feedback <investigationId>` — leave impact feedback on a past investigation.
 *
 * Two modes:
 *   • Non-interactive (`--resolved yes|partly|no`): emit feedback directly, no TTY
 *     required. This is the path the `horus skill` instructs an agent to call after
 *     it has acted on an investigation and knows whether Horus pointed at the cause
 *     — closing the loop where most usage (agent-driven, non-interactive) otherwise
 *     produces no impact signal.
 *   • Interactive (no flags, TTY): the sampled post-result prompt (HOR-326).
 *
 * Both modes emit the Tier-A telemetry event (unchanged) AND persist a durable outcome label into
 * the local eval store (source=feedback, HOR-390) so the signal converges with `memory confirm`.
 */
export async function runFeedback(
  investigationId?: string,
  opts: {
    resolved?: string;
    manualEstimateMin?: string;
    config?: string;
    repo?: string;
    note?: string;
    cause?: string;
  } = {},
): Promise<number> {
  let id = investigationId?.trim();
  // No id given → default to the LAST investigation (HOR-431). This is the common case after a
  // fresh `horus investigate`, so feedback no longer requires copy-pasting an id.
  if (!id) {
    let last: string | null = null;
    try {
      const config = await loadConfig(opts.config);
      // "The last investigation" means THIS project's last on the shared DB (dogfood N1).
      let project: string | undefined;
      try {
        project = resolveEnvironment(config).project;
      } catch {
        /* unresolvable — leave unscoped */
      }
      const { db, sql } = await openDb(config.database.url);
      try {
        last = await getLastInvestigationId(db, { project });
      } finally {
        await sql.end();
      }
    } catch {
      last = null;
    }
    if (!last) {
      console.error(pc.red('No investigations yet — run: horus investigate "<hint>"'));
      return 1;
    }
    id = last;
  }

  // Non-interactive path — agent/scripted feedback via flags. Works without a TTY.
  if (opts.resolved !== undefined) {
    const resolved = parseResolved(opts.resolved);
    if (resolved === null) {
      console.error(pc.red(`Invalid --resolved "${opts.resolved}". Use: yes | partly | no.`));
      return 1;
    }
    let manualEstimateMinutes: number | null = null;
    if (opts.manualEstimateMin !== undefined) {
      const n = Number.parseInt(opts.manualEstimateMin, 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(pc.red(`Invalid --manual-estimate-min "${opts.manualEstimateMin}" (expect a non-negative integer).`));
        return 1;
      }
      manualEstimateMinutes = n;
    }
    submitFeedback({ investigationId: id, resolved, manualEstimateMinutes, horusSeconds: null, source: 'flag' });
    await persistOutcomeLabel(id, resolved, manualEstimateMinutes, opts);
    console.log(pc.dim(`Feedback recorded (${resolved}) — thanks, this helps improve Horus.`));
    return 0;
  }

  // Interactive path — requires a TTY.
  if (!process.stdin.isTTY) {
    console.error(
      pc.yellow(
        'horus feedback needs an interactive terminal — or pass --resolved yes|partly|no for non-interactive (agent) use.',
      ),
    );
    return 1;
  }
  const answer = await runFeedbackPrompt(id, null);
  if (answer !== null) {
    await persistOutcomeLabel(id, answer.resolved ?? '', answer.manualEstimateMinutes, opts);
  }
  return 0;
}
