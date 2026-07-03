/**
 * HOR — `horus memory show <scope>` synthesis (read-only).
 *
 * Composes the live code-knowledge graph (via discoverArchitecture / estimateOwnership)
 * with the deterministic incident memory (via recallSimilar + the incident_memory store)
 * into a single project-scoped view. NO new schema, NO writes — every section reads from a
 * store that already exists. Mirrors the area-scoping flow of buildOnboarding (onboard.ts).
 *
 * Past incidents are CONTEXT ONLY. The "confirmed" flag here is a DISPLAY-ONLY proxy derived
 * from verdict/band — there is no confirmed column in the store.
 */

import type { CodeProvider } from '@horus/connectors';
import type { Symbol } from '@horus/core';
import {
  incidentMemory,
  eq,
  getInvestigation,
  listInvestigationsWithReports,
  type HorusDb,
  type IncidentMemory,
} from '@horus/db';
import {
  discoverArchitecture,
  isTestyCommunity,
  type AsyncBoundary,
  type ExternalSystem,
} from './architecture.js';
import { estimateOwnership, type OwnershipEstimate } from './ownership.js';
import { buildAreaTokens, bestAreaSymbol, filterArchitecture, matchesArea } from './onboard.js';
import { recallSimilar, deriveTags, moduleArea, tagOverlap, isGenericTag } from './memory.js';
import type { InvestigationReport } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryViewDeps {
  /** createConnectors(config).code — source-graph host + searchSymbols + ownership. */
  code: CodeProvider;
  db: HorusDb;
  /** Repo root — for git-history ownership. */
  repoPath: string;
  /** Resolved project name — REQUIRED; memory is project-isolated (HOR-46). */
  project: string;
}

/** A subsystem cluster scoped to the area, carrying the test/example flag (HOR-365). */
export interface MemorySubsystem {
  name: string;
  members: number;
  /** True when the cluster is dominated by test/example/docs symbols. */
  testy: boolean;
}

export interface MemoryOwnedAreas {
  subsystems: MemorySubsystem[];
  seedSymbol: { name: string; file: string } | null;
  /** Probabilistic (git commit history only — not an org chart). */
  ownership: OwnershipEstimate | null;
}

export interface MemoryRuntimePaths {
  asyncBoundaries: AsyncBoundary[];
  keyFlows: string[];
  /** Union of queues seen across scope-matched past incidents (payload.queues). */
  queuesSeenInIncidents: string[];
}

/** One past investigation hydrated for the scope. */
export interface MemoryPastInvestigation {
  investigationId: string | null;
  title: string;
  summary: string | null;
  /** ISO date of the investigation (createdAt), or null. */
  date: string | null;
  /** Jaccard tag overlap with the scope (0 for broader-recall fallback rows). */
  overlap: number;
  sharedTags: string[];
  /** Top suspected cause from the report, when available. */
  suspectedCause: { title: string; category: string; band: string } | null;
  confidence: number | null;
  /**
   * DISPLAY-ONLY proxy — there is no confirmed column. True when the top hypothesis verdict is
   * 'supported' or the top suspected cause band is 'highly-likely'.
   */
  confirmedProxy: boolean;
  /** Distinct evidence source channels that fired for this incident (code|logs|metrics|...). */
  sources: string[];
}

/** Recurrence: how many memory rows share the same incident signature (area|cat|queues). */
export interface MemoryRecurringPattern {
  signature: string;
  count: number;
}

export interface MemoryEvidenceSources {
  /** Distinct evidence channels seen across the matched incidents. */
  channels: string[];
  /** The two evidence planes behind the structural sections — always available. */
  alwaysAvailable: string[];
}

export interface MemoryWeakSpots {
  /** Repo-wide fragility from the graph — NOT narrowed to the scope (see scope). */
  fragile: { deadCode: number; highCouplingPairs: number; scope: 'repo-wide' };
  /** Scope subsystems that are test/example/docs-heavy. */
  testLightSubsystems: string[];
  /** True when this area has little/no confirmed prior evidence. */
  lowPriorEvidence: boolean;
  lowPriorEvidenceReason: string;
}

export interface MemoryView {
  scope: string;
  project: string;
  /** moduleArea(scope) — the first-3-segment area shared with incident signatures/tags. */
  area: string;
  tokens: string[];
  /**
   * False when the source-intelligence host is unreachable — the code-knowledge sections
   * (owned areas / runtime paths / external systems) are then empty because the graph couldn't
   * be queried, NOT because nothing matched. Surfaced so the view says WHY rather than silently
   * degrading to incident-only (honesty — same class as HOR-373).
   */
  sourceAvailable: boolean;
  ownedAreas: MemoryOwnedAreas;
  runtimePaths: MemoryRuntimePaths;
  externalSystems: ExternalSystem[];
  pastInvestigations: MemoryPastInvestigation[];
  recurringPatterns: MemoryRecurringPattern[];
  evidenceSources: MemoryEvidenceSources;
  weakSpots: MemoryWeakSpots;
  summary: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Confidence below this counts as "low prior evidence" for the weak-spots section. */
const LOW_CONFIDENCE = 0.5;

/**
 * Load incident_memory rows scoped to the project AND matched to the area tokens. Mirrors the
 * filter inside recallSimilar (tag overlap, drop generic-only matches) but keeps the pre-dedup
 * rows so recurrence/queues/low-prior-evidence can be computed without a second query.
 */
async function loadScopedMemory(
  db: HorusDb,
  project: string,
  tokens: string[],
): Promise<IncidentMemory[]> {
  const p = project.trim();
  if (p === '') return [];
  try {
    const rows = await db
      .select()
      .from(incidentMemory)
      .where(eq(incidentMemory.project, p))
      .limit(200);
    const tagSet = new Set(tokens);
    return rows.filter((row) => {
      if (row.project !== p) return false; // defense in depth
      const rowTags = row.tags ?? [];
      if (tagOverlap(tokens, rowTags) <= 0) return false;
      const shared = rowTags.filter((t) => tagSet.has(t));
      // Only meaningful if it shares a SPECIFIC tag, not generic categories/env labels (HOR-39).
      if (shared.length > 0 && shared.every((t) => isGenericTag(t))) return false;
      return true;
    });
  } catch {
    return [];
  }
}

/** Safe read of a payload field, returning undefined on any shape mismatch. */
function payloadOf(row: IncidentMemory | undefined): Record<string, unknown> {
  if (row == null) return {};
  const p = row.payload;
  return p != null && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

/** Distinct evidence source channels referenced by a report. */
function reportSources(report: InvestigationReport | null): string[] {
  if (report == null) return [];
  const out = new Set<string>();
  for (const ev of report.evidence ?? []) {
    if (ev.source) out.add(ev.source);
  }
  // Fall back to per-source contribution summary when raw evidence is absent (HOR-70).
  for (const s of report.sourceStatus?.sources ?? []) {
    if (s.status === 'contributed') out.add(s.source);
  }
  return [...out].sort();
}

/** Hydrate one past investigation from its report + memory row into the product shape. */
function hydratePast(args: {
  investigationId: string | null;
  title: string;
  summary: string | null;
  overlap: number;
  sharedTags: string[];
  date: string | null;
  report: InvestigationReport | null;
  memoryRow: IncidentMemory | undefined;
}): MemoryPastInvestigation {
  const { report, memoryRow } = args;
  const payload = payloadOf(memoryRow);

  const cause = report?.suspectedCauses?.[0] ?? null;
  const suspectedCause = cause
    ? { title: cause.title, category: cause.category, band: cause.band }
    : typeof payload.topHypothesis === 'string' && payload.topHypothesis !== ''
      ? { title: payload.topHypothesis, category: payload.topHypothesis, band: 'observation' }
      : null;

  const confidence =
    report != null && typeof report.confidence === 'number'
      ? report.confidence
      : typeof payload.confidence === 'number'
        ? payload.confidence
        : null;

  const topVerdict = report?.hypotheses?.[0]?.verdict;
  const confirmedProxy = topVerdict === 'supported' || cause?.band === 'highly-likely';

  return {
    investigationId: args.investigationId,
    title: args.title,
    summary: args.summary,
    date: args.date,
    overlap: args.overlap,
    sharedTags: args.sharedTags,
    suspectedCause,
    confidence,
    confirmedProxy,
    sources: reportSources(report),
  };
}

/** Read a report jsonb blob defensively. */
function asReport(report: unknown): InvestigationReport | null {
  return report != null && typeof report === 'object' ? (report as InvestigationReport) : null;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the read-only memory view for `scope` within the resolved project. Composes existing
 * functions only — assembles owned areas, runtime paths & queues, external systems, past
 * investigations, useful evidence sources and weak spots. Deterministic; deps are injected.
 */
export async function buildMemoryView(scope: string, deps: MemoryViewDeps): Promise<MemoryView> {
  const { code, db, repoPath, project } = deps;

  // 0. Is the source-intelligence host reachable? If not, the code-knowledge sections below will
  //    be empty because the graph can't be queried — surface that instead of silently showing
  //    "0 subsystems" (honesty). The incident half (DB) still works when the host is down.
  let sourceAvailable = true;
  try {
    const h = await code.health();
    sourceAvailable = h.ok === true;
  } catch {
    sourceAvailable = false;
  }

  // 1. Whole-repo architecture model (queue edges scoped to the project — HOR-207).
  const architecture = await discoverArchitecture({ code, db, project });

  // 2-5. Resolve the scope to tokens + a seed symbol, then narrow the architecture.
  let symbols: Symbol[] = [];
  try {
    symbols = await code.searchSymbols(scope, 20);
  } catch {
    symbols = [];
  }
  const tokens = buildAreaTokens(scope, symbols);
  const tokenArr = [...tokens];
  const areaSymbol = bestAreaSymbol(scope, symbols);
  const filtered = filterArchitecture(architecture, tokens);

  // 6. The module area — the field shared with incident-memory signature/tags.
  const area = moduleArea(scope);

  // --- Owned areas -------------------------------------------------------
  let ownership: OwnershipEstimate | null = null;
  try {
    ownership = await estimateOwnership(scope, { code, repoPath, symbol: areaSymbol });
  } catch {
    ownership = null;
  }
  const subsystems: MemorySubsystem[] = filtered.subsystems.map((s) => ({
    name: s.name,
    members: s.members,
    testy: isTestyCommunity(s.name),
  }));
  const seedSymbol = areaSymbol ? { name: areaSymbol.name, file: areaSymbol.filePath } : null;

  // --- Incident-memory rows (scope-matched, pre-dedup) -------------------
  const scopedMemory = await loadScopedMemory(db, project, tokenArr);
  const memoryByInvestigation = new Map<string, IncidentMemory>();
  for (const row of scopedMemory) {
    if (row.investigationId != null && !memoryByInvestigation.has(row.investigationId)) {
      memoryByInvestigation.set(row.investigationId, row);
    }
  }

  // --- Past investigations ----------------------------------------------
  const similar = await recallSimilar(db, tokenArr, null, project);
  const past: MemoryPastInvestigation[] = [];

  if (similar.length > 0) {
    for (const inc of similar) {
      let report: InvestigationReport | null = null;
      let date: string | null = null;
      if (inc.investigationId != null) {
        const inv = await getInvestigation(db, inc.investigationId);
        report = asReport(inv?.report);
        date = toIso(inv?.createdAt);
      }
      const memoryRow = inc.investigationId
        ? memoryByInvestigation.get(inc.investigationId)
        : undefined;
      if (date == null) date = toIso(memoryRow?.createdAt);
      past.push(
        hydratePast({
          investigationId: inc.investigationId,
          title: inc.title,
          summary: inc.summary,
          overlap: inc.overlap,
          sharedTags: inc.sharedTags,
          date,
          report,
          memoryRow,
        }),
      );
    }
  } else {
    // Broader recall fallback (mirrors buildOnboarding's area path): reports whose derived tags
    // overlap the scope, else title match; capped at 8.
    const invs = await listInvestigationsWithReports(db, 50, { project });
    const seen = new Set<string>();
    for (const inv of invs) {
      if (seen.has(inv.id)) continue;
      const report = asReport(inv.report);
      if (report == null) continue;
      seen.add(inv.id);

      let sharedTags: string[] = [];
      let overlap = 0;
      try {
        const tags = deriveTags(report).map((t) => t.toLowerCase());
        sharedTags = tags.filter((t) => tokens.has(t));
        overlap = tagOverlap(tokenArr, tags);
      } catch {
        sharedTags = [];
      }
      const relevant = sharedTags.length > 0 || (inv.title != null && matchesArea(inv.title, tokens));
      if (!relevant) continue;

      past.push(
        hydratePast({
          investigationId: inv.id,
          title: inv.title,
          summary: report.summary ?? null,
          overlap,
          sharedTags,
          date: toIso(inv.createdAt),
          report,
          memoryRow: memoryByInvestigation.get(inv.id),
        }),
      );
      if (past.length >= 8) break;
    }
  }

  // --- Runtime paths & queues -------------------------------------------
  const queuesSeen = new Set<string>();
  for (const row of scopedMemory) {
    const queues = payloadOf(row).queues;
    if (Array.isArray(queues)) {
      for (const q of queues) if (typeof q === 'string' && q !== '') queuesSeen.add(q);
    }
  }
  const runtimePaths: MemoryRuntimePaths = {
    asyncBoundaries: filtered.asyncBoundaries,
    keyFlows: filtered.keyFlows,
    queuesSeenInIncidents: [...queuesSeen].sort(),
  };

  // --- Recurring patterns (group scope-matched memory rows by signature) -
  const bySignature = new Map<string, number>();
  for (const row of scopedMemory) {
    const sig = row.signature ?? '';
    if (sig === '') continue;
    bySignature.set(sig, (bySignature.get(sig) ?? 0) + 1);
  }
  const recurringPatterns: MemoryRecurringPattern[] = [...bySignature.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .filter((p) => p.count > 1)
    .sort((a, b) => b.count - a.count);

  // --- Useful evidence sources ------------------------------------------
  const channels = new Set<string>();
  for (const p of past) for (const s of p.sources) channels.add(s);
  const evidenceSources: MemoryEvidenceSources = {
    channels: [...channels].sort(),
    alwaysAvailable: ['source-intelligence graph (code structure)', 'git history'],
  };

  // --- Weak spots --------------------------------------------------------
  const testLightSubsystems = subsystems.filter((s) => s.testy).map((s) => s.name);
  let lowPriorEvidence: boolean;
  let lowPriorEvidenceReason: string;
  if (past.length === 0) {
    // Key off the DISPLAYED investigations, not just tag-matched incident_memory rows — the
    // broader-recall fallback can surface investigations even when scopedMemory is empty, so
    // basing this on scopedMemory contradicted the Past-investigations section.
    lowPriorEvidence = true;
    lowPriorEvidenceReason =
      'No prior investigations on record for this area — predictions rest on code structure + git history only.';
  } else {
    const anyConfirmed = past.some((p) => p.confirmedProxy);
    const allLowConfidence = past.every(
      (p) => p.confidence == null || p.confidence < LOW_CONFIDENCE,
    );
    if (!anyConfirmed && allLowConfidence) {
      lowPriorEvidence = true;
      lowPriorEvidenceReason =
        'This area has been investigated before but never with a confirmed cause (recurring-but-never-confirmed).';
    } else {
      lowPriorEvidence = false;
      lowPriorEvidenceReason = '';
    }
  }
  const weakSpots: MemoryWeakSpots = {
    fragile: {
      deadCode: architecture.fragile.deadCode,
      highCouplingPairs: architecture.fragile.highCouplingPairs,
      scope: 'repo-wide',
    },
    testLightSubsystems,
    lowPriorEvidence,
    lowPriorEvidenceReason,
  };

  // --- Summary -----------------------------------------------------------
  const summary =
    `Memory for "${scope}" in ${project}: ` +
    `${subsystems.length} owned subsystem(s), ` +
    `${runtimePaths.asyncBoundaries.length} queue boundary(ies), ` +
    `${filtered.externalSystems.length} external system(s), ` +
    `${past.length} past investigation(s)` +
    (recurringPatterns.length > 0 ? `, ${recurringPatterns.length} recurring pattern(s)` : '') +
    '.';

  return {
    scope,
    project,
    area,
    tokens: tokenArr,
    sourceAvailable,
    ownedAreas: { subsystems, seedSymbol, ownership },
    runtimePaths,
    externalSystems: filtered.externalSystems,
    pastInvestigations: past,
    recurringPatterns,
    evidenceSources,
    weakSpots,
    summary,
  };
}
