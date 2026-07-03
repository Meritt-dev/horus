/**
 * HOR-384 — Agent Packet.
 *
 * A compact, honesty-framed projection of an `InvestigationReport` for an agent's
 * context window. Pure, synchronous, no I/O — `buildPacket` projects the already-
 * assembled report into a small structured shape; `renderPacketMarkdown` and
 * `packetToJSON` serialise it. No new engine computation happens here: the packet is
 * a projection + honesty-framing layer over fields the engine already produced.
 *
 * Freshness is computed in the CLI (the engine has no freshness field) and passed in
 * through `opts.freshness`; this module depends only on `types.ts`, `score-cause.ts`
 * (band thresholds), `gaps.ts` types, and `render.ts` formatting helpers — never the
 * connector/DB layer.
 *
 * Remembered context (memory) follows the SAME discipline: `recallMemory` is async I/O against
 * the MemoryStore, so the recall runs in the CLI and the already-recalled items are passed in
 * through `opts.memory` (only their TYPES — `RecalledMemory`/`MemoryStatus`/`FreshnessLabel` — are
 * imported here). The packet surfaces them as CONTEXT ONLY: never live evidence, never fed to the
 * confidence/verdict scoring path, and never allowed to override the current run's evidence
 * (honesty invariant, Memory spec §8). The packet preserves recall's order verbatim — it never
 * re-ranks remembered context.
 */

import type {
  Evidence,
  ProviderKind,
  EvidenceCategory,
  EvidencePriority,
} from '@horus/core';
import type { InvestigationReport, RouteStep } from './types.js';
import type { CauseBand } from './score-cause.js';
import type { RecalledMemory, FreshnessLabel } from './memory-recall.js';
import type { MemoryStatus } from './memory-store.js';
import { getBand } from './score-cause.js';
import { formatSymbolLocation } from './render.js';
import { formatRouteStep } from './router.js';
import { isTestOrExamplePath } from './architecture.js';

// ── Public types ─────────────────────────────────────────────────────────────

/** A thin presentation preset selected via `--for <agent>`. Presentation-only. */
export type AgentPreset = 'claude' | 'cursor' | 'generic';

/** Honesty band for the headline confidence (mirrors `CauseBand`). */
export type HonestyBand = CauseBand;

export interface HonestyHeader {
  /** report.confidence */
  confidence: number;
  /** Derived from confidence via the same thresholds as `getBand`. */
  band: HonestyBand;
  /** True when a confidence ceiling capped the headline below its base. */
  workingHypothesis: boolean;
  /** Caveats, integrity-ordered (never truncated). */
  caveats: string[];
  /** Gap `nextSource` lines, highest confidence-impact first (never truncated). */
  toRaiseConfidence: string[];
  /**
   * HOR-386 — the router's deterministic next-step suggestions (`report.nextSteps`),
   * co-assembled here so caveats + routing share ONE assembly point and cannot drift
   * across the human/--json/MCP surfaces. Advisory data only; nothing auto-runs.
   */
  routing: RouteStep[];
  /** Which sources backed the run, preserving empty-vs-failed honesty. */
  sources: { source: string; status: 'contributed' | 'empty' | 'failed' | 'not-configured' }[];
}

export interface ProblemSection {
  /** The user's investigation hint/input. */
  hint: string;
  /** report.summary (carries the seed disclaimer prefix + scope clause). */
  summary: string;
  headlineCause?: {
    title: string;
    band: CauseBand;
    finalScore: number;
    /** Re-derived: does the headline cite the seed's evidence/nodes? */
    seedLinked: boolean;
    category: string;
  };
  /** formatSymbolLocation(report.seeds[0]) → "file:start-end". */
  seedLocation?: string;
}

export interface RelevantFile {
  path: string;
  symbol?: string;
  line?: number;
  why: string;
}

export interface EvidenceItem {
  title: string;
  source: ProviderKind;
  category?: EvidenceCategory;
  priority?: EvidencePriority;
  relevance: number;
  timestamp?: string;
  link?: { file?: string; line?: number; commit?: string; traceId?: string };
}

export interface LowerPriorityArea {
  area: string;
  reasons: string[];
}

/**
 * A remembered claim surfaced as CONTEXT in the packet — prior knowledge Horus has already stored
 * for this area. NOT live evidence: it never feeds the confidence/verdict scoring path and never
 * overrides the current run's evidence (honesty invariant, Memory spec §8). It carries the
 * read-time freshness/status so a months-old or drifted claim reads as exactly that, never as a
 * confident present-tense fact.
 */
export interface MemoryContextItem {
  id: string;
  claim: string;
  kind: string;
  scope: string;
  /** The claim's OWN stored confidence (0..1) — never the investigation's confidence. */
  confidence: number;
  /** EFFECTIVE (display) status from read-time freshness — may differ from the stored status. */
  status: MemoryStatus;
  /** Human freshness label (fresh/recent/aging/stale/possibly-stale/pinned/unverified). */
  freshness: FreshnessLabel;
  /** Days since last verification (or creation when never verified); null when no anchor. */
  ageDays: number | null;
  /** True when a read-time re-hash detected the linked symbol changed underneath. */
  driftDetected: boolean;
}

export interface Packet {
  honesty: HonestyHeader;
  problem: ProblemSection;
  relevantFiles: RelevantFile[];
  evidence: EvidenceItem[];
  lowerPriority: LowerPriorityArea[];
  /** Remembered context — prior knowledge, clearly marked as NOT live evidence. */
  memory: MemoryContextItem[];
  nextSteps: string[];
  /** Per-section drop counts (how many items were cut by the hard caps). */
  truncation: {
    relevantFiles: number;
    evidence: number;
    lowerPriority: number;
    memory: number;
    nextSteps: number;
  };
  meta: {
    investigationId?: string;
    generatedAt: string;
    scope?: string;
    service?: string;
    truncated: boolean;
    /** Presentation preset (render hint only; data is never dropped from the packet). */
    preset?: AgentPreset;
  };
}

/**
 * Freshness inputs consumed by the honesty header. Structurally compatible with the
 * CLI's `Freshness` (freshness.ts) plus the `semanticSearchReady` flag, which is not
 * part of `computeFreshness().caveats` today and must be passed explicitly.
 */
export interface PacketFreshness {
  indexStale?: boolean;
  commitsSinceIndex?: number | null;
  runtimeWindow?: { fromIso: string; toIso: string } | null;
  /** Verbatim freshness caveat strings (freshness.ts). */
  caveats?: string[];
  /** `semanticSearchReady(meta)` — false adds the recall-reduced caveat. */
  semanticSearchReady?: boolean;
}

export interface PacketOptions {
  topFiles?: number; // default 5
  topEvidence?: number; // default 5
  topLower?: number; // default 3
  topSteps?: number; // default 5
  topMemory?: number; // default 5
  preset?: AgentPreset;
  freshness?: PacketFreshness;
  /**
   * Remembered context, ALREADY recalled in the CLI (`recallMemory` is async I/O) and passed in so
   * `buildPacket` stays pure + synchronous. Order is honoured verbatim — the packet never re-ranks.
   */
  memory?: RecalledMemory[];
  /** Injectable clock for deterministic `meta.generatedAt`. Defaults to now. */
  now?: string;
}

/** Machine-facing serialisation: arrays stay clean; truncation is a sibling count. */
export interface PacketSection<T> {
  items: T[];
  truncatedCount: number;
}

export interface PacketJSON {
  honesty: HonestyHeader;
  problem: ProblemSection;
  relevantFiles: PacketSection<RelevantFile>;
  evidence: PacketSection<EvidenceItem>;
  lowerPriority: PacketSection<LowerPriorityArea>;
  memory: PacketSection<MemoryContextItem>;
  nextSteps: PacketSection<string>;
  meta: Packet['meta'];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TOP_FILES = 5;
const DEFAULT_TOP_EVIDENCE = 5;
const DEFAULT_TOP_LOWER = 3;
const DEFAULT_TOP_STEPS = 5;
const DEFAULT_TOP_MEMORY = 5;

/** Thin presentation presets — only lower caps and toggle render verbosity. */
const PRESETS: Record<
  AgentPreset,
  { topFiles?: number; topEvidence?: number; topMemory?: number; showTimestamps: boolean }
> = {
  claude: { topFiles: 4, topEvidence: 4, topMemory: 4, showTimestamps: false },
  cursor: { topFiles: 3, topEvidence: 3, topMemory: 3, showTimestamps: false },
  generic: { showTimestamps: true },
};

/** Priority tiers, critical → info, for evidence ranking. */
const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Structural/topology evidence kinds — the path, not the evidence. */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set(['symbol', 'flow', 'impact', 'queue-edge']);

/** Runtime anomaly evidence kinds that can attribute a signal to an area. */
const RUNTIME_KINDS: ReadonlySet<string> = new Set(['log', 'metric', 'queue-state', 'state', 'commit']);

/** The standing blast-radius caveat attached to every lower-priority entry. */
const BLAST_RADIUS_CAVEAT =
  'the component reporting an error is often not the cause; static reachability misses dynamic dispatch, event buses, and cross-service calls.';

const WORKING_HYPOTHESIS_LINE = 'Working hypothesis, not a root-cause conclusion.';

/** Fixed, conservative section title — never "ruled out" / "safe to ignore". */
export const LOWER_PRIORITY_TITLE = 'Lower-priority areas based on current evidence';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Mirror of graph.ts `isExcludedFromImplication`: drop info-priority / structural kinds. */
function isStructuralEvidence(ev: Evidence): boolean {
  if (ev.priority !== undefined) return ev.priority === 'info';
  return STRUCTURAL_KINDS.has(ev.kind);
}

/** Whether the seed reads as a low-confidence / fuzzy semantic guess (CAP C). */
function isSeedLowConfidence(report: InvestigationReport): boolean {
  if (report.summary.startsWith('⚠ No symbol closely matched')) return true;
  const seed = report.seeds[0];
  // A strong exact/colocated match (score ≥ 0.5) is authoritative; only flag fuzzy seeds
  // when a score is present and below the bar (mirrors engine.ts seedIsLowConfidence).
  return seed !== undefined && seed.score !== undefined && seed.score < 0.5;
}

/** Extract the engine's "⚠ … precisely." seed disclaimer from the summary, if present. */
function extractSeedDisclaimer(summary: string): string | null {
  const m = summary.match(/⚠[^]*?precisely\./);
  return m ? m[0].trim() : null;
}

/** Evidence ids and node ids that identify the seed, for seed-link re-derivation. */
function seedIdentity(report: InvestigationReport): { evidenceIds: Set<string>; nodeIds: Set<string> } {
  const evidenceIds = new Set<string>();
  const nodeIds = new Set<string>();
  const seed = report.seeds[0];
  if (!seed) return { evidenceIds, nodeIds };
  nodeIds.add(`symbol:${seed.name}`);
  nodeIds.add(`file:${seed.filePath}`);
  for (const ev of report.evidence) {
    const linkedToSeed =
      ev.links.symbolId === seed.id ||
      (ev.links.file !== undefined && ev.links.file === seed.filePath && STRUCTURAL_KINDS.has(ev.kind));
    if (linkedToSeed) evidenceIds.add(ev.id);
  }
  return { evidenceIds, nodeIds };
}

/** True when a cause cites the seed's evidence or affected nodes (CAP A re-derivation). */
function isCauseSeedLinked(
  cause: { sourceEvidenceIds: string[]; affectedNodeIds: string[] },
  seed: { evidenceIds: Set<string>; nodeIds: Set<string> },
): boolean {
  return (
    cause.sourceEvidenceIds.some((id) => seed.evidenceIds.has(id)) ||
    cause.affectedNodeIds.some((id) => seed.nodeIds.has(id))
  );
}

/** De-duplicate strings, preserving first-seen order. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// ── Honesty header ───────────────────────────────────────────────────────────

function buildHonesty(
  report: InvestigationReport,
  seed: { evidenceIds: Set<string>; nodeIds: Set<string> },
  seedLowConfidence: boolean,
  freshness: PacketFreshness | undefined,
): { header: HonestyHeader; seedLinked: boolean } {
  const confidence = report.confidence;
  const band = getBand(confidence);
  const headline = report.suspectedCauses[0];
  const seedLinked = headline ? isCauseSeedLinked(headline, seed) : true;

  const ceiling = report.gapAnalysis.confidenceCeiling;
  const gapCeilingBit = ceiling < 1.0 && confidence >= ceiling - 0.001;
  const singleSourceCeiling =
    headline?.explanations.some((e) => e.factor === 'single-source-ceiling') ?? false;

  // A ceiling "bit" below the base whenever any of these capping conditions hold.
  const ceilingPresent = gapCeilingBit || singleSourceCeiling || !seedLinked || seedLowConfidence;
  const workingHypothesis =
    !seedLinked || seedLowConfidence || (band !== 'highly-likely' && ceilingPresent);

  // ── Caveats, assembled in integrity order ──────────────────────────────────
  const caveats: string[] = [];
  if (workingHypothesis) caveats.push(WORKING_HYPOTHESIS_LINE);

  // 2 + CAP C — the fuzzy-seed disclaimer.
  if (seedLowConfidence) {
    const disclaimer = extractSeedDisclaimer(report.summary);
    caveats.push(
      disclaimer ??
        'Seed is a low-confidence semantic guess — refine with an exact symbol or error code to target precisely.',
    );
  }

  // CAP A — unlinked headline.
  if (headline && !seedLinked) {
    caveats.push(
      'No cause is structurally linked to the seed; the strongest signal is a lead to verify, not a diagnosis.',
    );
  }
  // CAP B — gap ceiling.
  if (gapCeilingBit) {
    caveats.push(`Confidence is capped at ${ceiling} until evidence gaps are filled.`);
  }
  // CAP E — single-source ceiling.
  if (singleSourceCeiling) {
    caveats.push('Headline rests on a single provider — no multi-source corroboration.');
  }

  // 4 — blind spots.
  for (const bs of report.gapAnalysis.blindSpots) caveats.push(bs);

  // 5 — freshness caveats + the semantic-search-off caveat.
  if (freshness?.caveats) caveats.push(...freshness.caveats);
  if (freshness?.semanticSearchReady === false) {
    caveats.push(
      'semantic search degraded to keyword/FTS (index embeddings incomplete) — recall may be reduced; re-run `horus init`',
    );
  }

  // 6 — degraded banner.
  if (report.degraded?.sourceIntelligence) {
    caveats.push('Runtime-only (source intelligence unavailable)');
  }

  // toRaiseConfidence — gap nextSource lines, highest impact first (never truncated).
  const toRaiseConfidence = [...report.gapAnalysis.gaps]
    .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
    .map((g) => g.nextSource);

  const sources = (report.sourceStatus?.sources ?? []).map((s) => ({
    source: s.source,
    status: s.status,
  }));

  return {
    header: {
      confidence,
      band,
      workingHypothesis,
      caveats: dedupe(caveats),
      toRaiseConfidence,
      // HOR-386 — carry the router's decision verbatim; the packet never re-routes.
      routing: report.nextSteps ?? [],
      sources,
    },
    seedLinked,
  };
}

// ── Relevant files ───────────────────────────────────────────────────────────

interface FileAccum {
  path: string;
  symbol?: string;
  line?: number;
  why: string;
  rank: number; // 0 = seed, 1 = implicated node, 2 = evidence-derived
  relevance: number;
}

function buildRelevantFiles(report: InvestigationReport): FileAccum[] {
  const byPath = new Map<string, FileAccum>();
  const evById = new Map(report.evidence.map((e) => [e.id, e]));

  const consider = (acc: FileAccum) => {
    const existing = byPath.get(acc.path);
    if (!existing) {
      byPath.set(acc.path, acc);
      return;
    }
    // Keep the stronger provenance (lower rank wins; then higher relevance).
    if (acc.rank < existing.rank || (acc.rank === existing.rank && acc.relevance > existing.relevance)) {
      byPath.set(acc.path, { ...acc, symbol: acc.symbol ?? existing.symbol, line: acc.line ?? existing.line });
    }
  };

  // Primary: the seed file.
  const seed = report.seeds[0];
  if (seed) {
    consider({
      path: seed.filePath,
      symbol: seed.name,
      line: seed.startLine,
      why: 'seed symbol resolved from hint',
      rank: 0,
      relevance: 1,
    });
  }

  // Files attached to suspected-cause evidence.
  const headlineId = report.suspectedCauses[0]?.id;
  report.suspectedCauses.forEach((cause) => {
    for (const eid of cause.sourceEvidenceIds) {
      const ev = evById.get(eid);
      const file = ev?.links.file;
      if (!ev || !file) continue;
      consider({
        path: file,
        line: ev.links.line,
        why:
          cause.id === headlineId
            ? 'file referenced by headline cause evidence'
            : 'file referenced by suspected-cause evidence',
        rank: 2,
        relevance: ev.relevance,
      });
    }
  });

  // Implicated graph nodes (file/symbol). Symbol/file nodes are structural and never
  // marked implicated today, but honour the contract for forward-compatibility.
  const seedName = seed?.name;
  for (const node of report.graph.nodes) {
    if (!(node.type === 'file' || node.type === 'symbol') || !node.implicated) continue;
    let path: string | undefined;
    if (node.type === 'file') {
      path = node.label;
    } else {
      // symbol node: resolve a file via its attached evidence.
      for (const eid of node.evidenceIds) {
        const f = evById.get(eid)?.links.file;
        if (f) {
          path = f;
          break;
        }
      }
    }
    if (!path) continue;
    consider({
      path,
      symbol: node.type === 'symbol' ? node.label : undefined,
      why: seedName
        ? `caller within blast radius of ${seedName}`
        : 'implicated node within blast radius',
      rank: 1,
      relevance: node.implicationScore,
    });
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a.path.localeCompare(b.path);
  });
}

// ── Evidence ─────────────────────────────────────────────────────────────────

function buildEvidence(report: InvestigationReport): EvidenceItem[] {
  const items = report.evidence
    .filter((ev) => !isStructuralEvidence(ev))
    .map((ev) => {
      const link: EvidenceItem['link'] = {};
      if (ev.links.file !== undefined) link.file = ev.links.file;
      if (ev.links.line !== undefined) link.line = ev.links.line;
      if (ev.links.commit !== undefined) link.commit = ev.links.commit;
      if (ev.links.traceId !== undefined) link.traceId = ev.links.traceId;
      const item: EvidenceItem & { _id: string } = {
        _id: ev.id,
        title: ev.title,
        source: ev.source,
        relevance: ev.relevance,
      };
      if (ev.category !== undefined) item.category = ev.category;
      if (ev.priority !== undefined) item.priority = ev.priority;
      if (ev.timestamp !== undefined) item.timestamp = ev.timestamp;
      if (Object.keys(link).length > 0) item.link = link;
      return item;
    });

  items.sort((a, b) => {
    const ra = PRIORITY_RANK[a.priority ?? ''] ?? 5;
    const rb = PRIORITY_RANK[b.priority ?? ''] ?? 5;
    if (ra !== rb) return ra - rb;
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return a._id.localeCompare(b._id);
  });

  return items.map(({ _id, ...rest }) => rest);
}

// ── Lower-priority areas (conservative anti-context) ──────────────────────────

function buildLowerPriority(
  report: InvestigationReport,
  seedLowConfidence: boolean,
  effectiveTopLower: number,
): { items: LowerPriorityArea[]; total: number } {
  const seed = report.seeds[0];

  // Hard gating — suppress the entire list unless ALL hold.
  const codePresent = !report.degraded?.sourceIntelligence;
  const seedResolved = seed !== undefined;
  const changesKnown = report.recentChanges !== undefined;
  if (!codePresent || !seedResolved || seedLowConfidence || !changesKnown || effectiveTopLower <= 0) {
    return { items: [], total: 0 };
  }

  // Only claim negative runtime evidence when a runtime dimension actually ran:
  // 'empty' (ran, found nothing) and 'contributed' both qualify; failed/not-configured do not.
  const runtimeRan =
    report.sourceStatus?.sources.some((s) => s.status === 'contributed' || s.status === 'empty') ?? false;
  if (!runtimeRan) return { items: [], total: 0 };

  const recent = report.recentChanges!;
  const changedFiles = new Set(recent.changedFiles);
  const changeRangeLabel = `${recent.window.since}..${recent.window.until ?? 'HEAD'}`;
  const seedName = seed!.name;
  const seedFile = seed!.filePath;
  const seedIds = seedIdentity(report);
  const evById = new Map(report.evidence.map((e) => [e.id, e]));

  const headlineEvidenceIds = new Set(report.suspectedCauses[0]?.sourceEvidenceIds ?? []);
  const onPathEvidenceIds = new Set<string>([...headlineEvidenceIds, ...seedIds.evidenceIds]);

  // Protected names: alternative seeds surfaced as "Candidate areas (ranked)" must never
  // be lower-prioritised.
  const protectedNames = new Set<string>();
  for (const f of report.findings) {
    if (f.title.startsWith('Candidate areas (ranked):')) {
      const list = f.title.slice('Candidate areas (ranked):'.length);
      for (const token of list.split(',')) {
        const name = token.trim().split(' [')[0]?.trim();
        if (name) protectedNames.add(name.toLowerCase());
      }
    }
  }

  // Candidate areas: external-system integrations + test/example/docs file clusters.
  interface Candidate {
    area: string;
    evidenceIds: string[];
    files: Set<string>;
    implicated: boolean;
  }
  const candidates: Candidate[] = [];
  for (const node of report.graph.nodes) {
    if (node.type === 'external_system') {
      const files = new Set<string>();
      for (const eid of node.evidenceIds) {
        const f = evById.get(eid)?.links.file;
        if (f) files.add(f);
      }
      candidates.push({ area: node.label, evidenceIds: node.evidenceIds, implicated: node.implicated, files });
    } else if (node.type === 'file' && isTestOrExamplePath(node.label)) {
      candidates.push({
        area: node.label,
        evidenceIds: node.evidenceIds,
        implicated: node.implicated,
        files: new Set([node.label]),
      });
    }
  }

  const out: LowerPriorityArea[] = [];
  for (const c of candidates) {
    if (protectedNames.has(c.area.toLowerCase())) continue;
    if (c.files.has(seedFile)) continue; // never the seed's own file

    // Leg 1 — off-path.
    const offPath = !c.evidenceIds.some((id) => onPathEvidenceIds.has(id)) && !c.files.has(seedFile);
    if (!offPath) continue;

    // Leg 2 — no attributed evidence (and the runtime dimensions ran, checked above).
    const hasRuntimeEvidence = c.evidenceIds.some((id) => {
      const ev = evById.get(id);
      return ev !== undefined && RUNTIME_KINDS.has(ev.kind) && !isStructuralEvidence(ev);
    });
    const noEvidence = !c.implicated && !hasRuntimeEvidence;
    if (!noEvidence) continue;

    // Leg 3 — not in the change window.
    const inWindow = [...c.files].some((f) => changedFiles.has(f));
    if (inWindow) continue;

    out.push({
      area: c.area,
      reasons: [
        `not reachable from ${seedName} within the analyzed blast radius; no queue-boundary link.`,
        'no error logs, metric anomalies, or queue state attributed here.',
        `no commits in ${changeRangeLabel} touched files here.`,
        BLAST_RADIUS_CAVEAT,
      ],
    });
  }

  out.sort((a, b) => a.area.localeCompare(b.area));
  const items = out.slice(0, effectiveTopLower);
  return { items, total: out.length };
}

// ── Remembered context (memory) ───────────────────────────────────────────────

/**
 * Project recalled memory into the packet's CONTEXT section. The recall itself (async I/O against
 * the MemoryStore) runs in the CLI; here we only flatten the already-ranked `RecalledMemory[]` into
 * the compact, honesty-framed `MemoryContextItem` shape, capped. Order is preserved verbatim from
 * `recallMemory` (confidence × read-time freshness, status-adjusted) — the packet never re-ranks.
 */
function buildMemoryContext(
  recalled: RecalledMemory[],
  cap: number,
): { items: MemoryContextItem[]; total: number } {
  if (cap <= 0 || recalled.length === 0) return { items: [], total: recalled.length };
  const items: MemoryContextItem[] = recalled.slice(0, cap).map((r) => ({
    id: r.item.id,
    claim: r.item.claim,
    kind: r.item.kind,
    scope: r.item.scope,
    // The claim's own stored confidence — NEVER the investigation's confidence.
    confidence: r.item.confidence,
    // EFFECTIVE (display) status + freshness from the read-time recall (may be downgraded vs stored).
    status: r.freshness.status,
    freshness: r.freshness.label,
    ageDays: r.freshness.ageDays,
    driftDetected: r.freshness.driftDetected,
  }));
  return { items, total: recalled.length };
}

// ── buildPacket ──────────────────────────────────────────────────────────────

export function buildPacket(report: InvestigationReport, opts: PacketOptions = {}): Packet {
  const preset = opts.preset ? PRESETS[opts.preset] : undefined;

  // Caps: defaults, lowered by an explicit option, then lowered (never raised) by a preset.
  const cap = (explicit: number | undefined, def: number, presetVal: number | undefined): number => {
    let n = explicit ?? def;
    if (presetVal !== undefined) n = Math.min(n, presetVal);
    return Math.max(0, n);
  };
  const topFiles = cap(opts.topFiles, DEFAULT_TOP_FILES, preset?.topFiles);
  const topEvidence = cap(opts.topEvidence, DEFAULT_TOP_EVIDENCE, preset?.topEvidence);
  const topSteps = cap(opts.topSteps, DEFAULT_TOP_STEPS, undefined);
  const topMemory = cap(opts.topMemory, DEFAULT_TOP_MEMORY, preset?.topMemory);
  const baseTopLower = cap(opts.topLower, DEFAULT_TOP_LOWER, undefined);

  const seedLowConfidence = isSeedLowConfidence(report);
  const seedIds = seedIdentity(report);

  const { header, seedLinked } = buildHonesty(report, seedIds, seedLowConfidence, opts.freshness);

  // ── Problem ────────────────────────────────────────────────────────────────
  const headlineCause = report.suspectedCauses[0];
  const seed = report.seeds[0];
  const problem: ProblemSection = {
    hint: report.input.hint,
    summary: report.summary,
  };
  if (headlineCause) {
    problem.headlineCause = {
      title: headlineCause.title,
      band: headlineCause.band,
      finalScore: headlineCause.finalScore,
      seedLinked,
      category: headlineCause.category,
    };
  }
  if (seed) {
    problem.seedLocation = formatSymbolLocation(seed.filePath, seed.startLine, seed.endLine);
  }

  // ── Sections ─────────────────────────────────────────────────────────────
  const allFiles = buildRelevantFiles(report);
  const relevantFiles = allFiles.slice(0, topFiles).map(({ rank: _rank, relevance: _rel, ...f }) => f);
  const filesTrunc = Math.max(0, allFiles.length - relevantFiles.length);

  const allEvidence = buildEvidence(report);
  const evidence = allEvidence.slice(0, topEvidence);
  const evidenceTrunc = Math.max(0, allEvidence.length - evidence.length);

  const allSteps = report.nextActions;
  const nextSteps = allSteps.slice(0, topSteps);
  const stepsTrunc = Math.max(0, allSteps.length - nextSteps.length);

  // List length tracks honesty: wider gaps → shorter or empty list.
  const ceiling = report.gapAnalysis.confidenceCeiling;
  const effectiveTopLower = ceiling >= 0.7 ? baseTopLower : ceiling >= 0.5 ? Math.min(1, baseTopLower) : 0;
  const lower = buildLowerPriority(report, seedLowConfidence, effectiveTopLower);
  const lowerTrunc = Math.max(0, lower.total - lower.items.length);

  // Remembered context — recalled in the CLI, passed in via opts.memory (context only, not evidence).
  const mem = buildMemoryContext(opts.memory ?? [], topMemory);
  const memoryTrunc = Math.max(0, mem.total - mem.items.length);

  const truncation = {
    relevantFiles: filesTrunc,
    evidence: evidenceTrunc,
    lowerPriority: lowerTrunc,
    memory: memoryTrunc,
    nextSteps: stepsTrunc,
  };
  const truncated =
    filesTrunc > 0 || evidenceTrunc > 0 || lowerTrunc > 0 || memoryTrunc > 0 || stepsTrunc > 0;

  const meta: Packet['meta'] = {
    generatedAt: opts.now ?? new Date().toISOString(),
    truncated,
  };
  if (report.id) meta.investigationId = report.id;
  if (report.input.scope !== undefined) meta.scope = report.input.scope;
  if (report.input.service !== undefined) meta.service = report.input.service;
  if (opts.preset !== undefined) meta.preset = opts.preset;

  return {
    honesty: header,
    problem,
    relevantFiles,
    evidence,
    lowerPriority: lower.items,
    memory: mem.items,
    nextSteps,
    truncation,
    meta,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Append a single synthetic "+N more" line when a section was truncated. */
function moreLine(out: string[], n: number): void {
  if (n > 0) out.push(`+${n} more`);
}

export function renderPacketMarkdown(packet: Packet): string {
  const showTimestamps = packet.meta.preset ? PRESETS[packet.meta.preset].showTimestamps : true;
  const out: string[] = [];

  // ── Honesty header (never truncated) ───────────────────────────────────────
  out.push(`# Agent Packet — ${packet.problem.hint}`);
  out.push('');
  const wh = packet.honesty.workingHypothesis ? ' · working hypothesis' : '';
  out.push(`**Confidence:** ${packet.honesty.confidence.toFixed(2)} (${packet.honesty.band})${wh}`);
  out.push('');

  if (packet.honesty.caveats.length > 0) {
    out.push('## Honesty');
    for (const c of packet.honesty.caveats) out.push(`- ${c}`);
    out.push('');
  }
  if (packet.honesty.toRaiseConfidence.length > 0) {
    out.push('### To raise confidence');
    for (const t of packet.honesty.toRaiseConfidence) out.push(`- ${t}`);
    out.push('');
  }
  if (packet.honesty.sources.length > 0) {
    const src = packet.honesty.sources.map((s) => `${s.source}: ${s.status}`).join(' · ');
    out.push(`**Sources:** ${src}`);
    out.push('');
  }

  // ── Problem ────────────────────────────────────────────────────────────────
  out.push('## Problem');
  out.push(packet.problem.summary);
  if (packet.problem.seedLocation) out.push(`- Seed: \`${packet.problem.seedLocation}\``);
  if (packet.problem.headlineCause) {
    const h = packet.problem.headlineCause;
    const link = h.seedLinked ? 'seed-linked' : 'not seed-linked';
    out.push(`- Headline cause: ${h.title} _(${h.finalScore.toFixed(2)}, ${h.band}, ${link})_`);
  }
  out.push('');

  // ── Relevant files ─────────────────────────────────────────────────────────
  out.push('## Relevant files');
  if (packet.relevantFiles.length === 0) {
    out.push('_none_');
  } else {
    for (const f of packet.relevantFiles) {
      const loc = f.line !== undefined ? `${f.path}:${f.line}` : f.path;
      const sym = f.symbol ? ` \`${f.symbol}\`` : '';
      out.push(`- \`${loc}\`${sym} — ${f.why}`);
    }
    moreLine(out, packet.truncation.relevantFiles);
  }
  out.push('');

  // ── Evidence ───────────────────────────────────────────────────────────────
  out.push('## Evidence');
  if (packet.evidence.length === 0) {
    out.push('_none_');
  } else {
    for (const e of packet.evidence) {
      const tags = [e.source, e.priority, e.category].filter(Boolean).join('/');
      const ts = showTimestamps && e.timestamp ? ` _(${e.timestamp})_` : '';
      out.push(`- [${tags}] ${e.title}${ts}`);
    }
    moreLine(out, packet.truncation.evidence);
  }
  out.push('');

  // ── Lower-priority ─────────────────────────────────────────────────────────
  out.push(`## ${LOWER_PRIORITY_TITLE}`);
  if (packet.lowerPriority.length === 0) {
    out.push('_none surfaced — insufficient evidence to lower-prioritise any area_');
  } else {
    for (const a of packet.lowerPriority) {
      out.push(`- **${a.area}**`);
      for (const r of a.reasons) out.push(`  - ${r}`);
    }
    moreLine(out, packet.truncation.lowerPriority);
  }
  out.push('');

  // ── Remembered context (memory) — prior knowledge, NOT live evidence ─────────
  // Omitted entirely when there is nothing remembered (keeps the packet compact); when present it
  // carries its own honesty disclaimer so an agent can never mistake it for current-run evidence.
  if (packet.memory.length > 0) {
    out.push('## Remembered context (not live evidence)');
    out.push(
      "_Prior knowledge Horus has stored for this area. Context only — it does not feed " +
        "confidence and never overrides the current run's evidence; it may be stale._",
    );
    for (const m of packet.memory) {
      const conf = `${Math.round(m.confidence * 100)}%`;
      const drift = m.driftDetected ? ', drift-detected' : '';
      const age = showTimestamps && m.ageDays !== null ? `, ${Math.round(m.ageDays)}d old` : '';
      out.push(`- ${m.claim} _(${m.kind} · ${m.freshness}${drift}${age} · ${conf} confidence)_`);
    }
    moreLine(out, packet.truncation.memory);
    out.push('');
  }

  // ── Next steps ─────────────────────────────────────────────────────────────
  out.push('## Suggested next steps');
  if (packet.nextSteps.length === 0 && packet.honesty.routing.length === 0) {
    out.push('_none_');
  } else {
    for (const s of packet.nextSteps) out.push(`- [ ] ${s}`);
    moreLine(out, packet.truncation.nextSteps);
    // HOR-386 — the router's structured suggestions (a runnable command + reason),
    // rendered from the same `RouteStep[]` the --json/MCP surfaces emit.
    for (const r of packet.honesty.routing) out.push(`- [ ] ${formatRouteStep(r)}`);
  }

  return out.join('\n');
}

/** Stable serialization: arrays stay clean, truncation is a sibling count. */
export function packetToJSON(packet: Packet): PacketJSON {
  return {
    honesty: packet.honesty,
    problem: packet.problem,
    relevantFiles: { items: packet.relevantFiles, truncatedCount: packet.truncation.relevantFiles },
    evidence: { items: packet.evidence, truncatedCount: packet.truncation.evidence },
    lowerPriority: { items: packet.lowerPriority, truncatedCount: packet.truncation.lowerPriority },
    memory: { items: packet.memory, truncatedCount: packet.truncation.memory },
    nextSteps: { items: packet.nextSteps, truncatedCount: packet.truncation.nextSteps },
    meta: packet.meta,
  };
}
