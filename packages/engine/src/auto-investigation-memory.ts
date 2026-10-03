import { readIncidentDisposition } from './memory-recall.js';
/**
 * HOR-432 — auto-capture a recurrence-aware memory from EVERY investigation, CONSOLIDATING recurrences.
 *
 * Every produced investigation report contributes to a durable `memory_item` (kind:`investigation`):
 *   - the FIRST time an incident-pattern is investigated, a new `investigation` memory is created;
 *   - each LATER investigation that RECURS (same incident fingerprint in the same repo) UPDATES that
 *     existing memory IN PLACE — bumping a recurrence count + last-seen and refreshing the claim/
 *     confidence to the LATEST finding — rather than minting a twin.
 *
 * Net: N identical investigations ⇒ ONE memory_item with `recurrenceCount = N` (recall surfaces it
 * once: "recurred N×; latest finding: …"), NOT N duplicate items joined by `recurs-with` edges. The
 * separate `memory detect` recurs-with detector (for DISTINCT related incidents) is untouched.
 *
 * HONESTY INVARIANTS (spec §8) — load-bearing, mirrored from memory-store.ts / memory-detect.ts:
 *   - The captured memory is CONTEXT-ONLY. Nothing here (or downstream of it) feeds the
 *     confidence/verdict scoring path. The memory stores the HONEST verdict — including unconfirmed/
 *     partly outcomes and the report's real `confidence` (NEVER inflated). A consolidation refreshes
 *     the claim/confidence to the LATEST report VERBATIM; a hypothesis is never upgraded to a fact.
 *   - Consolidation NEVER mutates status (it goes through `store.update`, which cannot touch status).
 *   - HOR-46 fail-closed: a blank repo identity produces NO memory (never cross-repo).
 *
 * NON-BLOCKING: the caller (engine `investigate`) wraps the entry point here in try/catch so a failure
 * can NEVER block investigation delivery. These functions are best-effort by contract.
 *
 * DETERMINISM: nothing here calls `Date.now()`. The "report time" used for `lastSeenAt` is passed in
 * by the caller (the persisted investigation's `createdAt`), so the consolidation is deterministic.
 */

import type { AuditCtx, MemoryItem, MemoryStore, NewMemoryItem } from './memory-store.js';
import type { InvestigationReport } from './types.js';
import { deriveSignature, deriveTags } from './memory.js';
import { recurrenceReason } from './memory-detect.js';

/** Max prior memories scanned for a recurrence match (deterministic, bounded). */
const RECURRENCE_SCAN_LIMIT = 100;

/** Cap on the rolling list of source investigation ids kept in the consolidated payload. */
const MAX_INVESTIGATION_IDS = 20;

/** Trim + cap a free-text fragment so the auto claim stays a concise one-liner. */
function snippet(text: string, max = 140): string {
  const s = text.trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Default-ON env gate. The user wants EVERY investigation to contribute to memory, so the feature is
 * on unless `HORUS_AUTO_INVESTIGATION_MEMORY` is explicitly set to `0`/`false`/`off`/`no` (escape hatch).
 */
export function autoInvestigationMemoryEnabled(): boolean {
  const v = (process.env.HORUS_AUTO_INVESTIGATION_MEMORY ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** The deterministic incident fingerprint + claim derived from a report (shared by create + consolidate). */
export interface InvestigationFields {
  hint: string;
  /** The one-line claim: `Investigation: <hint> -> <top hypothesis | summary>` (the latest finding). */
  claim: string;
  /** HONEST confidence — the report's own value, never inflated. */
  confidence: number;
  /** Incident-family recall keys (same derivation as incident_memory) so this memory recurs identically. */
  signature: string;
  tags: string[];
  /** The top hypothesis CATEGORY (recorded as a hypothesis, never a confirmed fact), or null. */
  topHypothesisCategory: string | null;
}

/**
 * Derive the (deterministic) incident fingerprint + claim a report contributes to memory. PURE — no
 * persistence, no clock. Reused by {@link createInvestigationMemory} (new item) and the recurrence
 * probe / {@link consolidateRecurrence} (existing item refresh) so both speak the exact same keys.
 */
export function deriveInvestigationFields(
  report: InvestigationReport,
): InvestigationFields {
  const hint = report.input.hint;
  const topHyp = report.hypotheses[0];
  // The headline is the top hypothesis (recorded AS a hypothesis), falling back to the summary.
  const headline =
    topHyp !== undefined
      ? snippet(topHyp.statement || topHyp.category || report.summary)
      : snippet(report.summary || '(no leading hypothesis)');

  return {
    hint,
    claim: `Investigation: ${snippet(hint)} -> ${headline}`,
    confidence: report.confidence,
    signature: deriveSignature(report),
    tags: deriveTags(report),
    topHypothesisCategory: topHyp !== undefined ? (topHyp.category ?? null) : null,
  };
}

/** Read a payload's `recurrenceCount` (>=1), defaulting to 1 when absent/invalid. */
export function recurrenceCountOf(payload: unknown): number {
  if (payload !== null && typeof payload === 'object') {
    const c = (payload as Record<string, unknown>).recurrenceCount;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 1) return Math.floor(c);
  }
  return 1;
}

/**
 * Build + persist a NEW `kind:investigation` memory from a finished report, with an `about-incident`
 * link back to the source investigation. Returns the persisted item, or `null` when there is no repo
 * identity (HOR-46 fail-closed — a memory is never created for a blank repo).
 *
 * HONESTY: `confidence` is the report's real confidence (never inflated); the claim names the top
 * hypothesis as a hypothesis (never as a confirmed fact). `payload.recurrenceCount` starts at 1.
 */
export async function createInvestigationMemory(
  store: MemoryStore,
  investigationId: string | null,
  report: InvestigationReport,
  audit: AuditCtx,
): Promise<MemoryItem | null> {
  // HOR-46 fail-closed: blank/whitespace repo is treated as missing → no memory.
  const repo = report.input.repo?.trim() || null;
  if (repo === null) return null;

  const fields = deriveInvestigationFields(report);

  const item: NewMemoryItem = {
    id: '',
    kind: 'investigation',
    source: 'investigation',
    scope: 'repo',
    visibility: 'private',
    // HONEST confidence — the report's own value, never inflated.
    confidence: fields.confidence,
    claim: fields.claim,
    repo,
    evidence: [],
    // Incident-family recall keys (same derivation as incident_memory) so this memory recurs.
    signature: fields.signature,
    tags: fields.tags,
    payload: {
      investigationId,
      hint: fields.hint,
      topHypothesis: fields.topHypothesisCategory,
      // First sighting: a single investigation is "recurred 1×". Bumped on each later recurrence.
      recurrenceCount: 1,
      outcome: {
        disposition: 'unknown',
        certainty: 'inferred',
        sourceInvestigation: investigationId ?? '',
        sourceRefs: [],
        applicability: {
          environment: report.input.environment,
          service: report.input.service,
          ...report.input.incident,
        },
        invalidatingConditions: [],
        checks: [],
      },
    },
  };

  const created = await store.add(item, audit);

  // about-incident link back to the source investigation (a derived, structural relationship).
  if (investigationId !== null && investigationId.trim() !== '') {
    await store.addLink(
      {
        id: '',
        fromMemoryId: created.id,
        rel: 'about-incident',
        toKind: 'incident',
        toRef: investigationId,
      },
      { detection: 'structural', audit },
    );
  }

  return created;
}

/**
 * Find an existing `kind:investigation` memory in the SAME repo that THIS investigation recurs with,
 * or `null`. Takes a deterministic PROBE (the signature/tags/claim of the not-yet-persisted current
 * investigation) and REUSES the conservative matching logic from `memory-detect.ts`
 * (`recurrenceReason`: identical usable signature, OR tag overlap ≥0.6 with ≥1 non-generic shared tag,
 * OR a corroborated claim-text fallback). Existing items come back newest-first, so the most recent
 * matching memory wins. Fails closed on a blank repo (HOR-46). CONTEXT-ONLY: read seam only.
 */
export async function detectRecurrence(
  store: MemoryStore,
  probe: Pick<MemoryItem, 'signature' | 'tags' | 'claim'> & { hint?: string },
  repo: string,
  input?: InvestigationReport['input'],
): Promise<MemoryItem | null> {
  const r = repo.trim();
  if (r === '') return null; // HOR-46 fail-closed

  const existing = await store.query({
    repo: r,
    kind: ['investigation'],
    limit: RECURRENCE_SCAN_LIMIT,
  });

  for (const candidate of existing) {
    if (['forgotten', 'deprecated', 'contradicted'].includes(candidate.status)) continue;
    const a = readIncidentDisposition(
      (candidate.payload as Record<string, unknown> | null)?.outcome,
    )?.applicability;
    if (
      a &&
      input &&
      ((a.environment && input.environment && a.environment !== input.environment) ||
        (a.service && input.service && a.service !== input.service) ||
        (['errorCode', 'fingerprint', 'workflow', 'operation'] as const).some(
          (key) => a[key] && input.incident?.[key] && a[key] !== input.incident[key],
        ))
    )
      continue;
    const structuredMatch = a?.fingerprint && a.fingerprint === input?.incident?.fingerprint;
    const compared = {
      ...probe,
      payload: structuredMatch ? undefined : { hint: input?.hint ?? probe.hint },
    };
    if (recurrenceReason(candidate, compared as MemoryItem) !== null) return candidate;
  }
  return null;
}

/**
 * CONSOLIDATE a recurring investigation into an EXISTING `investigation` memory IN PLACE (HOR-432).
 * No new memory_item is created and NO `recurs-with` edge is minted — the single item absorbs the
 * recurrence:
 *   - payload.recurrenceCount := prev+1; payload.lastSeenAt := `reportTime`; payload.investigationIds
 *     gains this run (capped to the last {@link MAX_INVESTIGATION_IDS});
 *   - claim/confidence/topHypothesis are refreshed to the LATEST finding (confidence VERBATIM, honest);
 *   - an `about-incident` link to the latest investigation is added, plus a `recurrence` audit row
 *     stamped `detection:'auto:recurrence-consolidate'`.
 *
 * HONESTY: `store.update` cannot touch status; the refreshed confidence is the latest report's own
 * value, never inflated; this is CONTEXT-ONLY and never read by the scoring path. Returns the updated row.
 */
export async function consolidateRecurrence(
  store: MemoryStore,
  existing: MemoryItem,
  investigationId: string | null,
  fields: InvestigationFields,
  reportTime: Date,
  audit: AuditCtx,
): Promise<MemoryItem> {
  const prev = (existing.payload ?? {}) as Record<string, unknown>;
  if (
    investigationId &&
    (prev.investigationId === investigationId ||
      (Array.isArray(prev.investigationIds) &&
        prev.investigationIds.includes(investigationId)))
  )
    return existing;
  const recurrenceCount = recurrenceCountOf(prev) + 1;

  // Roll the source investigation ids forward (seeding from the original single id on first bump),
  // then cap to the most recent few so the payload stays bounded.
  const prevIds = Array.isArray(prev.investigationIds)
    ? prev.investigationIds.filter((x): x is string => typeof x === 'string')
    : [];
  const seedIds =
    prevIds.length > 0
      ? prevIds
      : typeof prev.investigationId === 'string'
        ? [prev.investigationId]
        : [];
  const thisId =
    investigationId !== null && investigationId.trim() !== '' ? investigationId : null;
  const investigationIds = (thisId !== null ? [...seedIds, thisId] : seedIds).slice(
    -MAX_INVESTIGATION_IDS,
  );

  const payload: Record<string, unknown> = {
    ...prev,
    recurrenceCount,
    lastSeenAt: reportTime.toISOString(),
    investigationIds,
    // Refresh the "latest finding" provenance; keep the original first-seen id for reference.
    hint: fields.hint,
    topHypothesis: fields.topHypothesisCategory,
    investigationId:
      typeof prev.investigationId === 'string'
        ? prev.investigationId
        : (seedIds[0] ?? thisId),
  };

  const updated = await store.update(
    existing.id,
    {
      claim: fields.claim,
      // HONEST: the LATEST report's confidence, verbatim — never inflated, never an average.
      confidence: fields.confidence,
      payload,
    },
    {
      audit,
      action: 'recurrence',
      detection: 'auto:recurrence-consolidate',
      detail: {
        recurrenceCount,
        ...(thisId !== null ? { investigationId: thisId } : {}),
      },
    },
  );

  // about-incident link to the LATEST investigation (a derived, structural relationship).
  if (thisId !== null) {
    await store.addLink(
      {
        id: '',
        fromMemoryId: existing.id,
        rel: 'about-incident',
        toKind: 'incident',
        toRef: thisId,
      },
      { detection: 'structural', audit },
    );
  }

  return updated;
}

/** What {@link captureInvestigationMemory} did with a report. */
export interface CaptureResult {
  /** `created` = new memory; `consolidated` = recurrence folded into an existing memory; `skipped` = no repo. */
  action: 'created' | 'consolidated' | 'skipped';
  /** The affected memory id, or null when skipped / no row was written. */
  memoryId: string | null;
  /** The memory's recurrence count after this capture (1 for a first sighting). */
  recurrenceCount: number;
}

/**
 * Capture ONE investigation into the authored-memory substrate, CONSOLIDATING recurrences (HOR-432).
 *
 * Flow: derive the incident fingerprint → look for a matching existing `investigation` memory in the
 * same repo → if found, UPDATE it in place (bump count + refresh latest finding); else CREATE a new
 * memory. A blank repo is skipped (HOR-46 fail-closed). CONTEXT-ONLY + best-effort by contract — the
 * caller wraps this in try/catch so it can never block report delivery.
 *
 * `reportTime` is the deterministic "seen at" stamp (the persisted investigation's `createdAt`); this
 * function never calls `Date.now()`.
 */
export async function captureInvestigationMemory(
  store: MemoryStore,
  investigationId: string | null,
  report: InvestigationReport,
  reportTime: Date,
  audit: AuditCtx,
): Promise<CaptureResult> {
  const repo = report.input.repo?.trim() || null;
  if (repo === null) return { action: 'skipped', memoryId: null, recurrenceCount: 0 };

  const fields = deriveInvestigationFields(report);
  const existing = await detectRecurrence(
    store,
    {
      signature: fields.signature,
      tags: fields.tags,
      claim: fields.claim,
      hint: fields.hint,
    },
    repo,
    report.input,
  );

  if (existing !== null) {
    const updated = await consolidateRecurrence(
      store,
      existing,
      investigationId,
      fields,
      reportTime,
      audit,
    );
    return {
      action: 'consolidated',
      memoryId: updated.id,
      recurrenceCount: recurrenceCountOf(updated.payload),
    };
  }

  const created = await createInvestigationMemory(store, investigationId, report, audit);
  return {
    action: created !== null ? 'created' : 'skipped',
    memoryId: created?.id ?? null,
    recurrenceCount: 1,
  };
}
