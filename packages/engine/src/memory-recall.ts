/**
 * Horus Memory — deterministic recall + read-time freshness (M1, spec §4 + §5 + §8).
 *
 * `recallMemory` is the read path: it takes a repo-scoped query, asks the MemoryStore for the
 * authoritative candidate pool (scope/tenancy/visibility/kind), applies the deterministic STATUS
 * filter, lets the `MemoryVectorIndex` (M1: NoopVectorIndex, Jaccard/scope) PROPOSE relevance, then
 * sorts by confidence × READ-TIME freshness-decay. Freshness is derived at read time from the
 * `lastVerifiedAt` age (always-on, zero infra) plus an optional PULL re-hash of symbol links against
 * an in-process `code` provider — so correctness never depends on the watcher/SSE push path (which
 * does NOT exist in the one-shot `horus investigate`).
 *
 * HONESTY INVARIANT (spec §8): the result is CONTEXT ONLY. `recallMemory` is never called from
 * `validate.ts` or any confidence/verdict scoring path; the read-time downgrade to `possibly-stale`
 * is DISPLAY-ONLY and is NOT persisted (no `setStatus` write here). The vector index merely proposes;
 * the deterministic filter/rank below is the sole authority on what surfaces.
 */

import { createHash } from 'node:crypto';
import { incidentHintOverlap } from './memory-store.js';
import type { CodeProvider } from '@horus/connectors';
import type { MemoryItem } from '@horus/db';
import type { MemoryStore, MemoryQuery, MemoryStatus, MemoryVectorIndex } from './memory-store.js';
import { HIDDEN_STATUSES } from './memory-store.js';

// ---------------------------------------------------------------------------
// Tunables (deterministic, bounded)
// ---------------------------------------------------------------------------

/** Days after which the read-time freshness decay multiplier halves. */
export const FRESHNESS_HALF_LIFE_DAYS = 30;

/** Decay applied when an item has no verify/creation anchor at all (should be rare). */
const NO_ANCHOR_DECAY = 0.5;

/** Multiplier applied to the rank of a `possibly-stale` item — it is downranked, never hidden. */
const STALE_RANK_FACTOR = 0.5;

/** Additive boost so a `pinned` item floats to the top while STILL surfacing its freshness/drift. */
const PINNED_RANK_BOOST = 1;

/** Default cap on surfaced results. */
const DEFAULT_LIMIT = 10;

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Code provider seam (narrow, in-process; best-effort)
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the code graph that read-time staleness needs: the CURRENT content of a code
 * node, addressed by its node id (`{label}:{relpath}:{symbol}`). Kept narrow so recall does not
 * depend on the full `CodeProvider` and stays trivially testable. Returns null when the node is
 * missing/renamed or the host is unreachable — in which case re-hash is simply skipped (best-effort).
 */
export interface RecallCodeProvider {
  getNodeContent(nodeId: string): Promise<string | null>;
}

/**
 * Adapt a full `CodeProvider` into the narrow {@link RecallCodeProvider}. Reads the node's full
 * source body (falling back to the display snippet) and swallows all errors → null, so a down host
 * never breaks recall. This is the single wiring point used by the runner/`memory show`.
 */
export function recallCodeProviderFromCodeProvider(code: CodeProvider): RecallCodeProvider {
  return {
    async getNodeContent(nodeId: string): Promise<string | null> {
      try {
        const ctx = await code.context(nodeId);
        return ctx.sourceBody ?? ctx.snippet ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Hash code-node content the same way for verify-time snapshot and read-time re-hash comparison. */
export function hashNodeContent(content: string): string {
  return 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A human-facing freshness label derived from the effective status + age. */
export type FreshnessLabel =
  | 'pinned'
  | 'possibly-stale'
  | 'unverified'
  | 'fresh'
  | 'recent'
  | 'aging'
  | 'stale';

/** Read-time freshness for one recalled item. Never persisted — recomputed every recall. */
export interface MemoryFreshness {
  /**
   * The EFFECTIVE status used for display + ranking. Equals the stored status unless a pull re-hash
   * found the linked symbol changed underneath: then a non-pinned item is downgraded to
   * `possibly-stale` for display only (the store is NOT mutated here).
   */
  status: MemoryStatus;
  /** Days since `lastVerifiedAt` (or `createdAt` when never verified); null when neither exists. */
  ageDays: number | null;
  /** True when the age anchor is a real verification (`lastVerifiedAt`), false when it is creation. */
  verified: boolean;
  /** 0..1 decay multiplier (1 = just verified; halves every {@link FRESHNESS_HALF_LIFE_DAYS}). */
  decay: number;
  /** True when a pull re-hash detected the symbol-linked content changed since last verify. */
  driftDetected: boolean;
  label: FreshnessLabel;
}

/** One recalled item, returned as CONTEXT for the human render / evidence step (never scoring). */
export interface RecalledMemory {
  item: MemoryItem;
  /** Retrieval relevance proposed by the vector index (Jaccard in M1); 0 when scope-only. */
  relevance: number;
  freshness: MemoryFreshness;
  /** Deterministic combined ordering score (confidence × decay, status-adjusted). */
  rank: number;
}

/** Recall query: the authoritative {@link MemoryQuery} filter plus an optional free-text relevance. */
export interface RecallQuery extends MemoryQuery {
  /** Free-text query handed to the vector index for relevance proposals (best-effort). */
  text?: string;
}

export interface RecallOptions {
  /** Vector index (M1: NoopVectorIndex). Best-effort; absence/failure falls through to scope-only. */
  vectorIndex?: MemoryVectorIndex;
  /** In-process code provider for read-time pull re-hash of `about-symbol` links. */
  code?: RecallCodeProvider;
  /** Clock for deterministic freshness-decay. Defaults to `new Date()`. */
  now?: Date;
  /** Half-life (days) for the freshness decay. Defaults to {@link FRESHNESS_HALF_LIFE_DAYS}. */
  halfLifeDays?: number;
  /** Cap on surfaced results. Defaults to {@link DEFAULT_LIMIT}. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Freshness (read-time)
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function labelFor(status: MemoryStatus, ageDays: number | null): FreshnessLabel {
  if (status === 'pinned') return 'pinned';
  if (status === 'possibly-stale') return 'possibly-stale';
  if (ageDays === null) return 'unverified';
  if (ageDays < 7) return 'fresh';
  if (ageDays < 30) return 'recent';
  if (ageDays < 90) return 'aging';
  return 'stale';
}

/**
 * Derive read-time freshness for an item. The age anchor is `lastVerifiedAt` when present, else
 * `createdAt` (a never-verified item still ages from creation). Decay is a half-life curve so the
 * DISPLAYED freshness can never claim "fresh" next to a months-old verification (the confidently-
 * stale lie the critique calls out). `effectiveStatus`/`driftDetected` come from the optional
 * pull re-hash and override the stored status for DISPLAY only.
 */
export function deriveFreshness(
  item: MemoryItem,
  now: Date,
  halfLifeDays: number,
  effectiveStatus: MemoryStatus,
  driftDetected: boolean,
): MemoryFreshness {
  const verifiedAt = toDate(item.lastVerifiedAt);
  const anchor = verifiedAt ?? toDate(item.createdAt);
  const ageDays =
    anchor === null ? null : Math.max(0, (now.getTime() - anchor.getTime()) / MS_PER_DAY);

  const hl = halfLifeDays > 0 ? halfLifeDays : FRESHNESS_HALF_LIFE_DAYS;
  const decay = ageDays === null ? NO_ANCHOR_DECAY : clamp01(Math.pow(0.5, ageDays / hl));

  return {
    status: effectiveStatus,
    ageDays,
    verified: verifiedAt !== null,
    decay,
    driftDetected,
    label: labelFor(effectiveStatus, ageDays),
  };
}

// ---------------------------------------------------------------------------
// Pull re-hash (read-time staleness, best-effort)
// ---------------------------------------------------------------------------

/**
 * Re-hash an item's `about-symbol` links against the live code provider and report drift. A drift is
 * any resolved symbol whose current content hash differs from the item's `lastVerifiedHash` snapshot.
 * Returns `{ drift:false }` when: no code provider, no baseline hash, no symbol links, or nothing
 * resolved (best-effort — absence of signal never asserts staleness). Read-only: never writes.
 */
async function detectDrift(
  store: MemoryStore,
  item: MemoryItem,
  code: RecallCodeProvider | undefined,
): Promise<boolean> {
  if (code === undefined) return false;
  // No baseline snapshot → nothing to compare against; the 'unverified' label carries the doubt.
  if (item.lastVerifiedHash == null || item.lastVerifiedHash === '') return false;

  let links;
  try {
    links = await store.links(item.id, { rels: ['about-symbol'] });
  } catch {
    return false;
  }
  if (links.length === 0) return false;

  for (const link of links) {
    let content: string | null;
    try {
      content = await code.getNodeContent(link.toRef);
    } catch {
      content = null;
    }
    if (content === null) continue; // unresolved (renamed/host down) — skip, do not assert drift
    if (hashNodeContent(content) !== item.lastVerifiedHash) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/** Compare two recalled items for a fully deterministic, stable ordering. */
function compareRecalled(a: RecalledMemory, b: RecalledMemory): number {
  if (b.rank !== a.rank) return b.rank - a.rank;
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;
  if (b.item.confidence !== a.item.confidence) return b.item.confidence - a.item.confidence;
  const av = toDate(a.item.lastVerifiedAt)?.getTime() ?? 0;
  const bv = toDate(b.item.lastVerifiedAt)?.getTime() ?? 0;
  if (bv !== av) return bv - av;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

/**
 * Recall authored memory for `query`, returned as CONTEXT (spec §4 minimal cut + §5 read-time).
 *
 * Pipeline:
 *   1. FILTER — `store.query` (repo fail-closed HOR-46, scope/tenancy/visibility/kind), then drop
 *      hidden statuses (`forgotten`/`deprecated`/`contradicted`) unless the caller pins a status set.
 *   2. RETRIEVE — the vector index (M1: NoopVectorIndex, Jaccard/scope) PROPOSES relevance for the
 *      free-text query; best-effort, annotation only — every filtered item remains a candidate so an
 *      empty/unavailable index degrades to scope-only recall (the union in spec §4).
 *   3. FRESHNESS — read-time decay from `lastVerifiedAt` age + a pull re-hash of symbol links that
 *      downgrades a changed-underneath item to `possibly-stale` for DISPLAY (pinned shows
 *      `driftDetected` but keeps its status — never auto-flipped, spec §5).
 *   4. RANK — confidence × decay, `possibly-stale` downranked, `pinned` boosted; deterministic
 *      tie-breaks. NO vector/lexical weighting in the rank (deferred — spec "minimal-but-complete").
 *
 * The vector index only proposes; this function's filter/rank is the sole authority on what surfaces.
 */
export async function recallMemory(
  store: MemoryStore,
  query: RecallQuery,
  opts: RecallOptions = {},
): Promise<RecalledMemory[]> {
  const repo = query.repo.trim();
  if (repo === '') return []; // HOR-46 fail-closed — no repo identity sees nothing

  const now = opts.now ?? new Date();
  const halfLifeDays = opts.halfLifeDays ?? FRESHNESS_HALF_LIFE_DAYS;
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;

  // 1. Authoritative candidate pool (no status filter here → apply it deterministically below).
  const pool = await store.query({
    repo,
    scope: query.scope,
    visibility: query.visibility,
    kind: query.kind,
    orgId: query.orgId,
    workspaceId: query.workspaceId,
    userId: query.userId,
  });

  // STATUS filter (deterministic, authoritative). Caller-supplied status is an explicit allow-list;
  // otherwise hide forgotten/deprecated/contradicted.
  const allow = query.status && query.status.length > 0 ? new Set(query.status) : null;
  const filtered = pool.filter((it) => {
    const s = it.status as MemoryStatus;
    return allow ? allow.has(s) : !HIDDEN_STATUSES.includes(s);
  });
  if (filtered.length === 0) return [];

  // 2. Vector retrieval — best-effort relevance annotation (never a hard gate in M1).
  const relevanceById = new Map<string, number>();
  const text = (query.text ?? '').trim();
  if (opts.vectorIndex !== undefined && text !== '') {
    try {
      const hits = await opts.vectorIndex.search({
        query: text,
        repo,
        limit: Math.max(filtered.length, 1),
      });
      for (const h of hits) relevanceById.set(h.memoryId, h.score);
    } catch {
      // best-effort: degrade to scope-only recall
    }
  }

  // 3 + 4. Freshness (with pull re-hash) → rank.
  const recalled: RecalledMemory[] = [];
  for (const item of filtered) {
    const stored = item.status as MemoryStatus;
    const drift = await detectDrift(store, item, opts.code);
    // Pinned is never auto-flipped — it surfaces driftDetected but keeps status (spec §5/§8).
    const effectiveStatus: MemoryStatus =
      drift && stored !== 'pinned' ? 'possibly-stale' : stored;

    const freshness = deriveFreshness(item, now, halfLifeDays, effectiveStatus, drift);

    let rank = clamp01(item.confidence) * freshness.decay;
    if (effectiveStatus === 'possibly-stale') rank *= STALE_RANK_FACTOR;
    if (effectiveStatus === 'pinned') rank += PINNED_RANK_BOOST;

    recalled.push({ item, relevance: relevanceById.get(item.id) ?? 0, freshness, rank });
  }

  recalled.sort(compareRecalled);
  return recalled.slice(0, limit);
}

/** Structured trigger context is available before hypotheses exist. */
export interface IncidentContext {
  fingerprint?: string; errorCode?: string; workflow?: string; operation?: string;
  incidentId?: string; eventId?: string; occurredAt?: string; source?: string; sourceUrl?: string;
}
export interface IncidentDisposition {
  disposition: 'confirmed-incident' | 'expected-behavior' | 'duplicate-alert' | 'monitoring-error' | 'unknown';
  certainty: 'confirmed' | 'inferred'; actualCause?: string; resolution?: string;
  sourceInvestigation: string; sourceRefs: string[]; attester?: string; verifiedAt?: string;
  applicability: Pick<IncidentContext, 'fingerprint' | 'errorCode' | 'workflow' | 'operation' | 'source' | 'eventId'> &
    { service?: string; environment?: string; conditions?: string[] };
  invalidatingConditions: string[]; checks: string[];
}
export interface StartupIncident {
  memoryId: string; claim: string; incidentId?: string; reportRefs: Record<string, string>;
  matchingFields: string[]; lastVerifiedAt: string | null; environment: string;
  outcome: IncidentDisposition | null; checks: string[]; relevance: number;
  validation: 'unverified' | 'contradicted'; contradictingEvidenceIds: string[];
}

/** Reject malformed or unproven attestations; strip unknown nested fields before sync/prompt use. */
export function readIncidentDisposition(value: unknown): IncidentDisposition | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === 'string');
  if (!['confirmed-incident', 'expected-behavior', 'duplicate-alert', 'monitoring-error', 'unknown'].includes(String(v.disposition)) ||
      !['confirmed', 'inferred'].includes(String(v.certainty)) || typeof v.sourceInvestigation !== 'string' ||
      !strings(v.sourceRefs) || !strings(v.invalidatingConditions) || !strings(v.checks) ||
      !v.applicability || typeof v.applicability !== 'object') return null;
  if (v.certainty === 'confirmed' && (typeof v.attester !== 'string' || !v.attester.trim() ||
      typeof v.verifiedAt !== 'string' || !Number.isFinite(Date.parse(v.verifiedAt)) || !v.sourceRefs.length)) return null;
  const applicability: IncidentDisposition['applicability'] = {};
  const a = v.applicability as Record<string, unknown>;
  for (const key of ['fingerprint', 'errorCode', 'workflow', 'operation', 'service', 'environment', 'source', 'eventId'] as const)
    if (typeof a[key] === 'string') applicability[key] = a[key];
  if (strings(a.conditions)) applicability.conditions = a.conditions;
  return { disposition: v.disposition as IncidentDisposition['disposition'], certainty: v.certainty as IncidentDisposition['certainty'],
    sourceInvestigation: v.sourceInvestigation, sourceRefs: v.sourceRefs, invalidatingConditions: v.invalidatingConditions,
    checks: v.checks, applicability,
    ...(typeof v.actualCause === 'string' ? { actualCause: v.actualCause } : {}),
    ...(typeof v.resolution === 'string' ? { resolution: v.resolution } : {}),
    ...(typeof v.attester === 'string' ? { attester: v.attester } : {}),
    ...(typeof v.verifiedAt === 'string' ? { verifiedAt: v.verifiedAt } : {}) };
}

/** Bounded, deterministic startup retrieval. No hypothesis/category from the current run is used. */
export async function recallStartupIncidents(
  store: MemoryStore,
  input: import('./types.js').InvestigationInput,
  opts: { syncScope?: string; now?: Date } = {},
): Promise<StartupIncident[]> {
  if (!input.repo?.trim()) return [];
  const pool = await store.query({ repo: input.repo, kind: ['investigation', 'confirmed-outcome', 'incident-pattern'], limit: 200 });
  const now = opts.now ?? new Date();
  const ranked: StartupIncident[] = [];
  for (const item of pool) {
    if (item.repo !== input.repo || HIDDEN_STATUSES.includes(item.status as MemoryStatus) ||
        (opts.syncScope !== undefined && item.syncScope !== null && item.syncScope !== opts.syncScope) || item.createdAt > now) continue;
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    const outcome = readIncidentDisposition(payload.outcome);
    if (typeof payload.lastSeenAt === 'string' && Date.parse(payload.lastSeenAt) > now.getTime() ||
        outcome?.verifiedAt && Date.parse(outcome.verifiedAt) > now.getTime()) continue;
    const applicability = outcome?.applicability ?? {};
    if (applicability.environment && input.environment && applicability.environment !== input.environment) continue;
    if (applicability.service && input.service && applicability.service !== input.service) continue;
    const fields: string[] = []; let mismatch = false;
    for (const key of ['fingerprint', 'errorCode', 'workflow', 'operation'] as const) {
      const expected = applicability[key]; const actual = input.incident?.[key];
      if (expected && actual) { if (expected !== actual) mismatch = true; else fields.push(key); }
    }
    if (mismatch) continue;
    const { shared, overlap } = incidentHintOverlap(input.hint, typeof payload.hint === 'string' ? payload.hint : item.claim);
    // ponytail: conservative lexical fallback; replace only after chronological replay improves it.
    if (!fields.length && (shared.length < 2 || overlap < 0.45)) continue;
    if (shared.length) fields.push(`hint:${shared.join(',')}`);
    const refs = payload.reportRefs && typeof payload.reportRefs === 'object' ? payload.reportRefs as Record<string, string> : {};
    ranked.push({ memoryId: item.id, claim: item.claim, incidentId: typeof payload.investigationId === 'string' ? payload.investigationId : undefined,
      reportRefs: refs, matchingFields: fields, lastVerifiedAt: outcome?.verifiedAt ?? item.lastVerifiedAt?.toISOString() ?? null,
      environment: applicability.environment ?? 'unknown (legacy)', outcome,
      checks: outcome?.checks.length ? outcome.checks : [`Check current evidence for ${typeof payload.hint === 'string' ? payload.hint : item.claim}`],
      relevance: fields.filter(f => !f.startsWith('hint:')).length + overlap,
      validation: 'unverified', contradictingEvidenceIds: [] });
  }
  ranked.sort((a, b) => b.relevance - a.relevance || a.memoryId.localeCompare(b.memoryId));
  const seen = new Set<string>();
  return ranked.filter(c => {
    const origin = c.outcome?.applicability;
    const keys = [c.incidentId ?? c.claim.toLowerCase()];
    if (origin?.source && origin.eventId) keys.push(JSON.stringify([origin.source, origin.eventId]));
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  }).slice(0, 3);
}
