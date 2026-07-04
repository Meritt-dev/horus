/**
 * HOR-18 — Deterministic incident memory & pattern recognition.
 *
 * Stores past investigations as tagged + signed memory rows, and recalls
 * similar past incidents via Jaccard overlap on tags. NO vectors / embeddings.
 * Past incidents are CONTEXT ONLY — they must never override current evidence.
 */

import type { InvestigationReport } from './types.js';
import type {
  HorusDb,
  MemoryItem,
  NewMemoryItem,
  MemoryLink,
  NewMemoryLink,
  MemoryAudit,
} from '@horus/db';
import {
  incidentMemory,
  memoryItem,
  memoryLink,
  memoryAudit,
  eq,
  and,
  or,
  desc,
  notInArray,
} from '@horus/db';
import type {
  MemoryStore,
  LocalMemoryStore,
  MemoryQuery,
  AuditCtx,
  MemoryStatus,
  Visibility,
  Rel,
  MemoryRel,
  AddLinkOpts,
  RemoveLinkSpec,
  RemoveLinkOpts,
  LinksOpts,
  AnnotatedMemoryLink,
  MemoryUpdate,
  UpdateOpts,
} from './memory-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SimilarIncident {
  investigationId: string | null;
  title: string;
  summary: string | null;
  /** Jaccard overlap score (0..1). */
  overlap: number;
  sharedTags: string[];
}

// ---------------------------------------------------------------------------
// Tag / signature derivation
// ---------------------------------------------------------------------------

/**
 * Derive the "module area" from a file path: up to the first 3 path segments.
 * e.g. 'src/modules/zoho/zoho.service.ts' -> 'src/modules/zoho'
 *      'a.ts'                              -> 'a.ts'
 */
export function moduleArea(filePath: string): string {
  if (!filePath) return '';
  const parts = filePath.replace(/^\//, '').split('/');
  // Guard: if the path has 3 or fewer segments, return the whole thing.
  if (parts.length <= 3) return filePath;
  // Take only the first 3 segments.
  return parts.slice(0, 3).join('/');
}

/**
 * Derive a deterministic, lowercase tag set from an InvestigationReport.
 *
 * Sources:
 *   - Queue names from timeline boundary crossings
 *   - Top hypothesis category
 *   - Module area of the first seed's filePath
 *   - input.service
 *
 * Guards all indexed access (noUncheckedIndexedAccess).
 */
export function deriveTags(r: InvestigationReport): string[] {
  const raw: string[] = [];

  // Queue names from boundary crossings.
  for (const bc of r.timeline.boundaryCrossings) {
    if (bc.queueName) raw.push(bc.queueName);
  }

  // Top hypothesis category.
  const topHyp = r.hypotheses[0];
  if (topHyp !== undefined && topHyp.category) {
    raw.push(topHyp.category);
  }

  // Module area of the first seed's filePath.
  const firstSeed = r.seeds[0];
  if (firstSeed !== undefined && firstSeed.filePath) {
    const area = moduleArea(firstSeed.filePath);
    if (area) raw.push(area);
  }

  // Optional service scoping.
  if (r.input.service) {
    raw.push(r.input.service);
  }

  // Lowercase, deduplicate, filter empty.
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (lower && !seen.has(lower)) {
      seen.add(lower);
      tags.push(lower);
    }
  }
  return tags;
}

/**
 * Derive a compact, deterministic signature string from an InvestigationReport.
 * Format: '<area>|<topHypCategory>|<sortedQueues>'
 */
export function deriveSignature(r: InvestigationReport): string {
  const firstSeed = r.seeds[0];
  const area = firstSeed !== undefined ? moduleArea(firstSeed.filePath ?? '') : '';

  const topHyp = r.hypotheses[0];
  const topHypCategory = topHyp !== undefined ? (topHyp.category ?? '') : '';

  const queues = r.timeline.boundaryCrossings
    .map((bc) => bc.queueName)
    .filter(Boolean)
    .sort()
    .join(',');

  return [area, topHypCategory, queues].join('|');
}

/** Hypothesis-category tags — generic, shared by many unrelated incidents. */
const GENERIC_HYPOTHESIS_TAGS = new Set([
  'queue-backlog',
  'worker-slowdown',
  'external-api-latency',
  'deployment-regression',
  'retry-storm',
  'infrastructure',
]);

/** True for tags too generic to imply two incidents are actually related. */
export function isGenericTag(tag: string): boolean {
  return (
    GENERIC_HYPOTHESIS_TAGS.has(tag) ||
    /(^|-)(prod|production|staging|dev|local)$/.test(tag)
  );
}

// ---------------------------------------------------------------------------
// Jaccard tag overlap
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity: |intersection| / |union|, clamped to 0..1.
 * Returns 0 when the union is empty.
 */
export function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersectionCount = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersectionCount++;
  }

  const unionCount = setA.size + setB.size - intersectionCount;
  if (unionCount === 0) return 0;
  return intersectionCount / unionCount;
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * Read up to ~200 incident_memory rows scoped to the given project and return
 * the top-3 most similar (by Jaccard overlap) that are NOT the current investigation.
 *
 * Fails closed: returns [] when project is null so investigations without a
 * repo identity never receive another project's memories (HOR-46).
 * A second in-memory project check guards against DB-layer misses.
 *
 * Past incidents are CONTEXT ONLY — callers must not modify report.confidence.
 */
export async function recallSimilar(
  db: HorusDb,
  tags: string[],
  excludeInvestigationId: string | null,
  project: string | null,
): Promise<SimilarIncident[]> {
  // Normalize: treat blank/whitespace as missing, then fail closed.
  const p = project?.trim() || null;
  if (p === null) return [];

  try {
    const rows = await db
      .select()
      .from(incidentMemory)
      .where(eq(incidentMemory.project, p))
      .limit(200);

    const candidates: SimilarIncident[] = [];
    const tagSet = new Set(tags);
    for (const row of rows) {
      // Skip the current investigation.
      if (
        excludeInvestigationId !== null &&
        row.investigationId === excludeInvestigationId
      ) {
        continue;
      }

      // Defense in depth: skip rows from other projects even if the DB query leaked them.
      if (row.project !== p) continue;

      const rowTags = row.tags ?? [];
      const overlap = tagOverlap(tags, rowTags);
      if (overlap <= 0) continue;

      const sharedTags = rowTags.filter((t) => tagSet.has(t));
      // A match is only meaningful if it shares a SPECIFIC tag (a symbol/file/queue/
      // module), not just generic hypothesis categories or env/service labels (HOR-39).
      if (sharedTags.every((t) => isGenericTag(t))) continue;

      candidates.push({
        investigationId: row.investigationId,
        title: row.title,
        summary: row.summary,
        overlap,
        sharedTags,
      });
    }

    // Deduplicate by title (the same incident may have been investigated repeatedly),
    // keeping the best-overlap representative; then take the top 3 distinct incidents.
    const byTitle = new Map<string, SimilarIncident>();
    for (const c of candidates) {
      const existing = byTitle.get(c.title);
      if (existing === undefined || c.overlap > existing.overlap) {
        byTitle.set(c.title, c);
      }
    }
    return [...byTitle.values()].sort((a, b) => b.overlap - a.overlap).slice(0, 3);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persist a memory row for the current investigation. Non-fatal — a DB failure
 * here never throws and never prevents the report from being returned.
 * Skips storage when no project identity is available (HOR-46).
 */
export async function storeIncidentMemory(
  db: HorusDb,
  investigationId: string | null,
  r: InvestigationReport,
): Promise<void> {
  // Normalize then fail closed: blank/whitespace repo is treated as missing.
  const project = r.input.repo?.trim() || null;
  if (project === null) return;

  try {
    const topHyp = r.hypotheses[0];
    await db.insert(incidentMemory).values({
      investigationId,
      project,
      title: r.input.hint,
      summary: r.summary,
      signature: deriveSignature(r),
      tags: deriveTags(r),
      payload: {
        confidence: r.confidence,
        topHypothesis: topHyp !== undefined ? (topHyp.category ?? null) : null,
        queues: r.timeline.boundaryCrossings.map((b) => b.queueName),
      },
    });
  } catch {
    // Non-fatal — institutional memory must never prevent report delivery.
  }
}

// ---------------------------------------------------------------------------
// PII / secret gate (spec §7 privacy)
// ---------------------------------------------------------------------------

/**
 * Thrown when a claim contains an obvious secret/credential. The add/confirm path REJECTS rather
 * than silently storing — a memory claim is durable, user-controllable, and (later) cloud-syncable,
 * so credentials must never enter it (spec §7).
 */
export class MemorySecretError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`refusing to store memory claim: detected ${kind}`);
    this.name = 'MemorySecretError';
    this.kind = kind;
  }
}

/**
 * Thrown when a local mutation targets a cloud-owned cache row (HOR-464 / M4). A pulled team item
 * (`origin='cloud'`) is server-authoritative: `setStatus`/`setVisibility`/`update` refuse it rather
 * than let a local edit silently diverge from the shared copy. To change a team item, re-promote it.
 */
export class MemoryCacheReadonlyError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `refusing to mutate a cloud-owned cached memory item (${id}); the team store owns it — re-promote to change it`,
    );
    this.name = 'MemoryCacheReadonlyError';
    this.id = id;
  }
}

/**
 * Obvious-secret detectors for the claim gate. These mirror the credential class of
 * `@horus/core`'s redaction patterns but are non-global + labelled so a single match can be
 * reported. PII like bare emails/IPs is intentionally NOT rejected here (it does not block a claim
 * in M1); only high-confidence credentials/keys do.
 */
const CLAIM_SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'private-key', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
  { label: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'gcp-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { label: 'auth-header', re: /authorization\s*[=:]\s*(?:bearer|basic)\s+\S+/i },
  {
    label: 'credential-kv',
    re: /"?(?:password|passwd|secret|token|api[_-]?key|apikey|x-api-key)"?\s*[=:]\s*"?[^"',\s)>]+/i,
  },
  {
    label: 'connection-string-creds',
    re: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^:@/\s]+:[^@\s]+@/i,
  },
  { label: 'card-number', re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/ },
];

/** Return a label for the first obvious secret found in `claim`, or null when it is clean. */
export function detectClaimSecret(claim: string): string | null {
  for (const { label, re } of CLAIM_SECRET_PATTERNS) {
    if (re.test(claim)) return label;
  }
  return null;
}

/** Throw `MemorySecretError` if the claim carries an obvious secret/credential. */
function assertClaimClean(claim: string): void {
  const found = detectClaimSecret(claim);
  if (found !== null) throw new MemorySecretError(found);
}

// ---------------------------------------------------------------------------
// createLocalMemoryStore — drizzle/Postgres impl of the MemoryStore seam (M1, spec §6)
// ---------------------------------------------------------------------------

/** Stable, prefixed id for a memory row. ULID-shaped is unnecessary in M1; a UUID suffices. */
function genId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

/** M1 link relations with concrete code/incident/evidence resolvers (any `toKind`). */
const M1_RELS: ReadonlySet<Rel> = new Set<Rel>([
  'about-symbol',
  'about-file',
  'has-evidence',
  'about-incident',
]);

/**
 * M3 memory→memory relations (FROZEN day-0 vocabulary). Each REQUIRES `toKind:'memory'`.
 * `supersedes`/`contradicts` are DIRECTIONAL (stored as authored); `recurs-with` is SYMMETRIC and
 * canonicalized (stored from the lexicographically-smaller id) so the pair dedupes.
 */
const MEMORY_RELS: ReadonlySet<Rel> = new Set<MemoryRel>([
  'supersedes',
  'contradicts',
  'recurs-with',
]);

/** True for the symmetric memory rel that gets canonicalized + deduped on write. */
function isSymmetricRel(rel: string): boolean {
  return rel === 'recurs-with';
}

/**
 * Kinds whose items carry an incident-family `signature`/`tags` (populated at WRITE from the source
 * investigation report). Only these participate in recurrence detection; a non-incident claim
 * (code-fact/decision/...) never gets a signature, so it can never spuriously "recur".
 */
const INCIDENT_DERIVED_KINDS: ReadonlySet<string> = new Set([
  'confirmed-outcome',
  'incident-pattern',
  // HOR-432: auto-captured investigation memories carry the same incident-family signature/tags so
  // they participate in recurrence detection. CONTEXT-ONLY — never read by the scoring path.
  'investigation',
]);

/** Trim a stored signature; treat blank / all-delimiter ("", "||", "|") as absent (→ null). */
function normalizeStoredSignature(sig: string | null | undefined): string | null {
  const s = (sig ?? '').trim();
  if (s === '' || /^\|*$/.test(s)) return null;
  return s;
}

/** Lowercase + dedupe + drop-empty stored tags; an empty result is stored as null. */
function normalizeStoredTags(tags: readonly string[] | null | undefined): string[] | null {
  if (!tags || tags.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const lower = (t ?? '').trim().toLowerCase();
    if (lower !== '' && !seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out.length === 0 ? null : out;
}

/** Map a target status onto the audit action that produced it (user-facing provenance). */
function statusAction(status: MemoryStatus): string {
  switch (status) {
    case 'forgotten':
      return 'forget';
    case 'pinned':
      return 'pin';
    case 'possibly-stale':
      return 'mark-stale';
    case 'deprecated':
      return 'deprecate';
    case 'contradicted':
      return 'contradict';
    case 'fresh':
      return 'confirm';
    default:
      return 'set-status';
  }
}

/**
 * Local (drizzle/Postgres, embedded pglite by default) implementation of the `MemoryStore` seam.
 *
 * - The existing incident-recall methods (`recall`/`record`/`loadScoped`) stay backed by
 *   `incident_memory` and reuse the pure helpers above, so the ~12 incident-memory tests are
 *   unaffected (additive).
 * - The authored substrate (`add`/`get`/`query`/`setStatus`/`setVisibility`/`verify`/`addLink`/
 *   `links`/`history`) is backed by `memory_item`/`memory_link`/`memory_audit`.
 *
 * Invariants:
 *   - HOR-46 fail-closed: every `memory_item` requires a `repo`; `query` returns nothing for a
 *     blank repo and filters defensively against leaking another repo's rows.
 *   - Soft-forget: `setStatus(id, 'forgotten')` flips status only — the row is retained and the
 *     transition is audited, so forgetting is reversible.
 *   - Append-only audit: every mutation writes a `memory_audit` row; `history()` returns the trail.
 *   - PII/secret gate (spec §7): `add` and `verify` reject claims carrying obvious secrets.
 *   - Confirmed-outcome stays `private`: a `confirmed-outcome` item is never auto-promoted to team.
 *
 * HONESTY INVARIANT (spec §8): this is storage only. Nothing here is read by the confidence/verdict
 * scoring path.
 */
export function createLocalMemoryStore(db: HorusDb): LocalMemoryStore {
  const getById = async (id: string): Promise<MemoryItem | null> => {
    const rows = await db.select().from(memoryItem).where(eq(memoryItem.id, id)).limit(1);
    return rows[0] ?? null;
  };

  const appendAudit = async (a: {
    memoryId: string;
    action: string;
    actor: AuditCtx['actor'];
    fromStatus: string | null;
    toStatus: string | null;
    note: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> => {
    await db.insert(memoryAudit).values({
      id: genId('aud'),
      memoryId: a.memoryId,
      action: a.action,
      actor: a.actor,
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      note: a.note,
      detail: a.detail ?? null,
    });
  };

  return {
    // ---- existing incident-recall seam (map #4) — unchanged, backed by incident_memory ----
    recall(i) {
      return recallSimilar(db, i.tags, i.excludeInvestigationId, i.project);
    },
    record(i) {
      return storeIncidentMemory(db, i.investigationId, i.report);
    },
    async loadScoped(i) {
      const p = i.project.trim();
      if (p === '') return [];
      try {
        const rows = await db
          .select()
          .from(incidentMemory)
          .where(eq(incidentMemory.project, p))
          .limit(200);
        const tagSet = new Set(i.tokens);
        return rows.filter((row) => {
          if (row.project !== p) return false; // defense in depth
          const rowTags = row.tags ?? [];
          if (tagOverlap(i.tokens, rowTags) <= 0) return false;
          const shared = rowTags.filter((t) => tagSet.has(t));
          // Only meaningful if it shares a SPECIFIC tag, not generic categories/env labels (HOR-39).
          if (shared.length > 0 && shared.every((t) => isGenericTag(t))) return false;
          return true;
        });
      } catch {
        return [];
      }
    },

    // ---- MemoryItem substrate (new) — backed by memory_item/_link/_audit ----
    async add(item: NewMemoryItem, audit: AuditCtx): Promise<MemoryItem> {
      // Gate first — a claim carrying a secret must never be persisted (spec §7).
      assertClaimClean(item.claim);

      const repo = (item.repo ?? '').trim();
      if (repo === '') throw new Error('memory_item requires a repo (HOR-46 fail-closed)');

      const id = (item.id ?? '').trim() || genId('mem');
      const status = item.status ?? 'fresh';
      // Confirmed-outcome items stay private; never auto-promote to team (spec §7).
      const isConfirmedOutcome =
        item.source === 'confirmed-outcome' || item.kind === 'confirmed-outcome';
      const visibility = isConfirmedOutcome ? 'private' : (item.visibility ?? 'private');

      // Incident-family recall keys are populated at WRITE for incident-derived kinds only; every
      // other kind stores neither (so it can never be a recurrence candidate). These are CONTEXT for
      // the auto-detectors and are NEVER read by the confidence/verdict scoring path (spec §8).
      const isIncidentDerived = INCIDENT_DERIVED_KINDS.has(item.kind);
      const signature = isIncidentDerived ? normalizeStoredSignature(item.signature) : null;
      const tags = isIncidentDerived ? normalizeStoredTags(item.tags) : null;

      const inserted = await db
        .insert(memoryItem)
        .values({ ...item, id, repo, status, visibility, signature, tags })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new Error('memory_item insert returned no row');

      await appendAudit({
        memoryId: id,
        action: 'add',
        actor: audit.actor,
        fromStatus: null,
        toStatus: status,
        note: audit.note ?? null,
      });
      return row;
    },

    async update(id: string, patch: MemoryUpdate, opts: UpdateOpts): Promise<MemoryItem> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // A cloud-owned cache row is server-authoritative — refuse a local edit (HOR-464).
      if (current.origin === 'cloud') throw new MemoryCacheReadonlyError(id);

      // Assemble only the fields the caller actually changed (an absent field is left untouched).
      // HONESTY: `status` is NEVER updatable here — a refresh of claim/confidence/payload can never
      // double as a status transition, and nothing here is read by the confidence/verdict scoring path.
      const set: Partial<typeof memoryItem.$inferInsert> = {};
      if (patch.claim !== undefined) {
        assertClaimClean(patch.claim); // a refreshed claim is re-scanned for secrets (spec §7)
        set.claim = patch.claim;
      }
      if (patch.confidence !== undefined) set.confidence = patch.confidence;
      if (patch.payload !== undefined) set.payload = patch.payload;

      if (Object.keys(set).length > 0) {
        await db.update(memoryItem).set(set).where(eq(memoryItem.id, id));
      }

      await appendAudit({
        memoryId: id,
        action: opts.action ?? 'update',
        actor: opts.audit.actor,
        fromStatus: null,
        toStatus: null,
        note: opts.audit.note ?? null,
        detail: {
          ...(opts.detection ? { detection: opts.detection } : {}),
          ...(opts.detail ?? {}),
        },
      });

      const updated = await getById(id);
      if (updated === null) throw new Error(`memory item vanished during update: ${id}`);
      return updated;
    },

    get: getById,

    async query(q: MemoryQuery): Promise<MemoryItem[]> {
      const repo = q.repo.trim();
      if (repo === '') return []; // HOR-46 fail-closed — no repo identity sees nothing

      const conds = [eq(memoryItem.repo, repo)];
      if (q.scope !== undefined) conds.push(eq(memoryItem.scope, q.scope));
      if (q.origin !== undefined) conds.push(eq(memoryItem.origin, q.origin));
      if (q.visibility !== undefined) conds.push(eq(memoryItem.visibility, q.visibility));
      if (q.orgId !== undefined) conds.push(eq(memoryItem.orgId, q.orgId));
      if (q.workspaceId !== undefined) conds.push(eq(memoryItem.workspaceId, q.workspaceId));
      if (q.userId !== undefined) conds.push(eq(memoryItem.userId, q.userId));
      if (q.status && q.status.length > 0) {
        const ors = q.status.map((s) => eq(memoryItem.status, s));
        conds.push(ors.length === 1 ? ors[0]! : or(...ors)!);
      }
      if (q.kind && q.kind.length > 0) {
        const ors = q.kind.map((k) => eq(memoryItem.kind, k));
        conds.push(ors.length === 1 ? ors[0]! : or(...ors)!);
      }

      let rows = await db
        .select()
        .from(memoryItem)
        .where(and(...conds))
        // Deterministic: newest first, id as the stable tie-break.
        .orderBy(desc(memoryItem.createdAt), memoryItem.id);

      rows = rows.filter((r) => r.repo === repo); // defense in depth (never leak another repo)
      if (q.limit !== undefined && q.limit > 0) rows = rows.slice(0, Math.floor(q.limit));
      return rows;
    },

    async setStatus(id: string, status: MemoryStatus, audit: AuditCtx): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // A cloud-owned cache row is server-authoritative — refuse a local status flip (HOR-464).
      if (current.origin === 'cloud') throw new MemoryCacheReadonlyError(id);
      await db.update(memoryItem).set({ status }).where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: statusAction(status),
        actor: audit.actor,
        fromStatus: current.status,
        toStatus: status,
        note: audit.note ?? null,
      });
    },

    async setVisibility(id: string, v: Visibility, audit: AuditCtx): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // A cloud-owned cache row is server-authoritative — refuse a local visibility flip (HOR-464).
      if (current.origin === 'cloud') throw new MemoryCacheReadonlyError(id);
      await db.update(memoryItem).set({ visibility: v }).where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: 'set-visibility',
        actor: audit.actor,
        fromStatus: null,
        toStatus: null,
        note: audit.note ?? `visibility -> ${v}`,
      });
    },

    async verify(
      id: string,
      snap: { lastVerifiedHash: string | null },
      audit: AuditCtx,
    ): Promise<void> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // Re-scan at confirm time (defense in depth — covers items added before the gate existed).
      assertClaimClean(current.claim);
      // Confirm resets possibly-stale -> fresh (spec §5). Other statuses are left untouched:
      // pinned stays pinned; forgotten/deprecated/contradicted are not silently resurrected.
      const nextStatus: MemoryStatus =
        current.status === 'possibly-stale' ? 'fresh' : (current.status as MemoryStatus);
      await db
        .update(memoryItem)
        .set({
          lastVerifiedHash: snap.lastVerifiedHash,
          lastVerifiedAt: new Date(),
          status: nextStatus,
        })
        .where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: 'verify',
        actor: audit.actor,
        fromStatus: current.status,
        toStatus: nextStatus,
        note: audit.note ?? null,
      });
    },

    async addLink(link: NewMemoryLink, opts?: AddLinkOpts): Promise<MemoryLink> {
      const rel = link.rel;
      const isMemoryRel = MEMORY_RELS.has(rel as Rel);

      // Gate: an M1 rel (any toKind) OR a memory rel that explicitly targets another memory item.
      if (!M1_RELS.has(rel as Rel) && !(isMemoryRel && link.toKind === 'memory')) {
        throw new Error(`unsupported memory_link rel in M1: ${rel} (toKind=${link.toKind})`);
      }

      let fromId = link.fromMemoryId;
      let toRef = link.toRef;

      // Memory→memory edges are validated against the live store: both endpoints must exist, share a
      // repo, and not be a self-link. `recurs-with` is canonicalized + deduped (symmetric).
      if (isMemoryRel) {
        if (fromId === toRef) {
          throw new Error(`memory_link rejects a self-link: ${rel} ${fromId} -> ${toRef}`);
        }
        const fromItem = await getById(fromId);
        if (fromItem === null) throw new Error(`memory_link from item not found: ${fromId}`);
        const toItem = await getById(toRef);
        if (toItem === null) throw new Error(`memory_link to item not found: ${toRef}`);
        if (fromItem.repo !== toItem.repo) {
          throw new Error(
            `memory_link rejects a cross-repo edge: ${fromItem.repo} -> ${toItem.repo}`,
          );
        }

        if (isSymmetricRel(rel)) {
          // Canonicalize the unordered pair so (a,b) and (b,a) collapse to one stored row.
          if (fromId > toRef) [fromId, toRef] = [toRef, fromId];
          // Dedupe: if the canonical edge already exists, return it rather than inserting a twin.
          const existing = await db
            .select()
            .from(memoryLink)
            .where(
              and(
                eq(memoryLink.fromMemoryId, fromId),
                eq(memoryLink.rel, rel),
                eq(memoryLink.toRef, toRef),
                eq(memoryLink.toKind, 'memory'),
              ),
            )
            .limit(1);
          const dup = existing[0];
          if (dup !== undefined) return dup;
        }
      }

      const id = (link.id ?? '').trim() || genId('lnk');
      const inserted = await db
        .insert(memoryLink)
        .values({ ...link, id, fromMemoryId: fromId, toRef })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new Error('memory_link insert returned no row');

      // Append a `link` audit row keyed to the FROM item — honest provenance for every edge.
      // `detection` is NON-OPTIONAL and defaults to `manual`; auto-detectors pass their own label.
      await appendAudit({
        memoryId: row.fromMemoryId,
        action: 'link',
        actor: opts?.audit?.actor ?? { kind: 'system' },
        fromStatus: null,
        toStatus: null,
        note: opts?.audit?.note ?? null,
        detail: {
          rel: row.rel,
          toKind: row.toKind,
          toRef: row.toRef,
          detection: opts?.detection ?? 'manual',
          ...(opts?.audit?.note ? { note: opts.audit.note } : {}),
          // Extra structured provenance (e.g. auto:contradiction → the two investigationIds). Recorded
          // context only — never read by the confidence/verdict scoring path (spec §8).
          ...(opts?.detail ?? {}),
        },
      });
      return row;
    },

    async removeLink(spec: RemoveLinkSpec, opts?: RemoveLinkOpts): Promise<number> {
      const rel = spec.rel;
      // Only the FROZEN memory rels are hand-removable (M1 derived edges are not managed here).
      if (!MEMORY_RELS.has(rel as Rel)) {
        throw new Error(`unsupported memory_link rel for unlink: ${rel}`);
      }

      let fromId = spec.fromMemoryId;
      let toRef = spec.toRef;
      // `recurs-with` is stored canonically (smaller id first) — canonicalize the query the same way
      // so either authored orientation removes the one stored row.
      if (isSymmetricRel(rel) && fromId > toRef) [fromId, toRef] = [toRef, fromId];

      const deleted = await db
        .delete(memoryLink)
        .where(
          and(
            eq(memoryLink.fromMemoryId, fromId),
            eq(memoryLink.rel, rel),
            eq(memoryLink.toRef, toRef),
            eq(memoryLink.toKind, 'memory'),
          ),
        )
        .returning();

      // No matching edge → a no-op (not an error), and nothing is audited.
      if (deleted.length === 0) return 0;

      // Append an `unlink` audit row keyed to the (canonical) FROM item — honest provenance for the
      // removal. HONESTY: this drops the CONTEXT edge only; neither item's status/confidence changes.
      await appendAudit({
        memoryId: fromId,
        action: 'unlink',
        actor: opts?.audit?.actor ?? { kind: 'system' },
        fromStatus: null,
        toStatus: null,
        note: opts?.audit?.note ?? null,
        detail: {
          rel,
          toKind: 'memory',
          toRef,
          removed: deleted.length,
          ...(opts?.audit?.note ? { note: opts.audit.note } : {}),
        },
      });
      return deleted.length;
    },

    async links(id: string, opts?: LinksOpts): Promise<AnnotatedMemoryLink[]> {
      const direction = opts?.direction ?? 'both';
      const relFilter =
        opts?.rels && opts.rels.length > 0
          ? (opts.rels.length === 1
              ? eq(memoryLink.rel, opts.rels[0]!)
              : or(...opts.rels.map((r) => eq(memoryLink.rel, r)))!)
          : undefined;

      const out: AnnotatedMemoryLink[] = [];

      if (direction === 'out' || direction === 'both') {
        const conds = [eq(memoryLink.fromMemoryId, id)];
        if (relFilter) conds.push(relFilter);
        const rows = await db.select().from(memoryLink).where(and(...conds));
        for (const r of rows) out.push({ ...r, direction: 'out' });
      }

      if (direction === 'in' || direction === 'both') {
        // Incoming = a memory→memory edge pointing AT this item.
        const conds = [eq(memoryLink.toKind, 'memory'), eq(memoryLink.toRef, id)];
        if (relFilter) conds.push(relFilter);
        const rows = await db.select().from(memoryLink).where(and(...conds));
        for (const r of rows) out.push({ ...r, direction: 'in' });
      }

      // Deterministic order: oldest-first by createdAt, id as the stable tie-break.
      // Coerce createdAt (pglite may hand it back as a timestamp string, not a Date).
      return out.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    },

    async history(id: string): Promise<MemoryAudit[]> {
      return db
        .select()
        .from(memoryAudit)
        .where(eq(memoryAudit.memoryId, id))
        // Most-recent-first; id as the stable tie-break for same-instant rows.
        .orderBy(desc(memoryAudit.at), desc(memoryAudit.id));
    },

    // ---- HOR-464 / M4: disposable team-memory read-cache + one-way promote ----
    async upsertCached(item: NewMemoryItem, audit: AuditCtx): Promise<MemoryItem> {
      // Gate first — even a pulled claim is re-scanned for obvious secrets (defense in depth, §7).
      assertClaimClean(item.claim);

      const repo = (item.repo ?? '').trim();
      if (repo === '') throw new Error('memory_item requires a repo (HOR-46 fail-closed)');
      const id = (item.id ?? '').trim();
      if (id === '') throw new Error('upsertCached requires a stable item id (the origin client id)');

      const status = item.status ?? 'fresh';
      const now = new Date();
      // FORCE origin='cloud' + stamp pulledAt. Cache rows carry NO incident-family recall keys
      // (LOCAL-ONLY context, like vectors — a pulled row never participates in recurrence).
      const values = {
        ...item,
        id,
        repo,
        status,
        origin: 'cloud' as const,
        pulledAt: now,
        signature: null,
        tags: null,
      };
      // Upsert-on-id so a refresh overwrites the prior cache row IN PLACE (add() is insert-only).
      await db
        .insert(memoryItem)
        .values(values)
        .onConflictDoUpdate({
          target: memoryItem.id,
          set: {
            kind: values.kind,
            claim: values.claim,
            scope: values.scope,
            source: values.source,
            status,
            confidence: values.confidence,
            visibility: values.visibility ?? 'team',
            evidence: values.evidence,
            cloudId: values.cloudId ?? null,
            authorName: values.authorName ?? null,
            lastVerifiedAt: values.lastVerifiedAt ?? null,
            lastVerifiedHash: values.lastVerifiedHash ?? null,
            origin: 'cloud',
            // Re-scope to the repo we're pulling into. The cache is disposable and
            // project-isolated (HOR-46): a team item's id is the promoter's local id and is
            // stable across a workspace, so pulling it from a different repo on the same store
            // must move the cache row to the current repo — otherwise "pull here" silently
            // leaves it invisible here, stuck in whichever repo first pulled it.
            repo: values.repo,
            pulledAt: now,
          },
        });

      const row = await getById(id);
      if (row === null) throw new Error('memory_item upsertCached returned no row');

      // Exactly ONE audit row per refresh — the append-only trail records the pull, never a
      // replayed history of the item's cloud-side edits.
      await appendAudit({
        memoryId: id,
        action: 'pulled',
        actor: audit.actor,
        fromStatus: null,
        toStatus: status,
        note: audit.note ?? null,
        detail: { origin: 'cloud', ...(values.cloudId ? { cloudId: values.cloudId } : {}) },
      });
      return row;
    },

    async reconcileCache(repo: string, keepIds: string[]): Promise<number> {
      const r = repo.trim();
      if (r === '') return 0; // HOR-46 fail-closed — never reconcile without a repo identity.
      // Delete only the repo's CLOUD-origin cache rows that the latest full pull no longer returned;
      // origin='local' authored rows are never touched. An empty keepIds means the team is empty →
      // every cache row for the repo is stale (drop them all).
      const conds =
        keepIds.length > 0
          ? and(
              eq(memoryItem.repo, r),
              eq(memoryItem.origin, 'cloud'),
              notInArray(memoryItem.id, keepIds),
            )
          : and(eq(memoryItem.repo, r), eq(memoryItem.origin, 'cloud'));
      const deleted = await db.delete(memoryItem).where(conds).returning();
      return deleted.length;
    },

    async markPromoted(
      id: string,
      provenance: { cloudId: string; authorName?: string | null },
      audit: AuditCtx,
    ): Promise<MemoryItem> {
      const current = await getById(id);
      if (current === null) throw new Error(`memory item not found: ${id}`);
      // Flip the authored row to a server-owned team item: visibility=team, origin=cloud, stamp the
      // cloud id. Vector stays local (untouched). Idempotent — re-promoting is a harmless no-op flip.
      await db
        .update(memoryItem)
        .set({
          visibility: 'team',
          origin: 'cloud',
          cloudId: provenance.cloudId,
          authorName: provenance.authorName ?? current.authorName ?? null,
        })
        .where(eq(memoryItem.id, id));
      await appendAudit({
        memoryId: id,
        action: 'promote',
        actor: audit.actor,
        fromStatus: null,
        toStatus: null,
        note: audit.note ?? `promoted to team (cloud id ${provenance.cloudId})`,
        detail: { origin: 'cloud', visibility: 'team', cloudId: provenance.cloudId },
      });
      const updated = await getById(id);
      if (updated === null) throw new Error(`memory item vanished during promote: ${id}`);
      return updated;
    },
  };
}
