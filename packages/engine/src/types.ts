/**
 * Public types for the @horus/engine deterministic investigation pipeline (HOR-5).
 * No AI/LLM yet — every field is computed from typed provider evidence.
 */

import type { Evidence, Symbol, Flow, EvidenceSubject, ShopifyQuerySpec } from '@horus/core';
import type { DurationDimensionOptions } from '@horus/connectors';
import type { Timeline } from './timeline.js';
import type { CorrelationResult } from './correlate.js';
import type { ValidatedHypothesis } from './validate.js';
import type { SimilarIncident } from './memory.js';
import type { GapAnalysis } from './gaps.js';
import type { InvestigationGraph } from './graph.js';
import type { CauseCandidate } from './score-cause.js';
import type { OwnershipEstimate } from './ownership.js';
import type { RuntimeSourceReport } from './source-status.js';
import type { BoundedGitChange } from './git-collector.js';
import type { CauseChain } from './cause-chain.js';

export type { CauseCandidate };

/** The user-supplied incident hint plus optional scoping. */
export interface InvestigationInput {
  /** Durable job identity; interactive callers may omit. */
  reportId?: string;
  incident?: import('./memory-recall.js').IncidentContext;
  /** Free-text hint naming a symbol, file, or behaviour to investigate. */
  hint: string;
  /** Optional repository scope. */
  repo?: string;
  /** Optional git ref or range (e.g. `v1.2.0` or `abc123..HEAD`) to bound history. */
  since?: string;
  /**
   * Optional runtime-log window as a duration (e.g. `30d`, `24h`), independent of `since`.
   * `since` is git-shaped (refs/ranges) and falls back to the 7-day default for logs; set
   * this to look further back for the actual error signatures.
   */
  logsSince?: string;
  /** Optional service name scope. */
  service?: string;
  /**
   * Optional environment-name scope (e.g. `production`, `staging`). Part of the
   * investigation scope used to stamp the subject (service/environment) onto the
   * report and its evidence at normalization time. Additive; never enters scoring.
   */
  environment?: string;
  /**
   * Optional path scope (e.g. `packages/core` or `apps/api`) — resolve the seed only from
   * symbols whose file is under this directory. Lets a backend hint avoid seeding a co-located
   * frontend in a monorepo (HOR-356).
   */
  scope?: string;
  /**
   * HOR-435 (lever #2): how to break a duration/latency anomaly down by an INFO-level
   * dimension (region / market / tenant). When set AND the hint reads as a duration/latency/
   * anomaly question, the engine runs the connector `analyzeDurations` query and folds a
   * `Duration by <dimension>: …` evidence row (per-segment stats in payload) so a skewed
   * average can be seen as per-segment variance, not a uniform regression. The engine fills
   * in `from`/`service`/`level` from the investigation scope; omit to use a conservative
   * default (a `Completed …:REGION ~2m10s` shape). Graceful: a null/empty result adds nothing.
   */
  durationDimension?: DurationDimensionOptions;
  /**
   * Shopify Admin GraphQL queries to run as evidence THIS investigation, supplied by the
   * caller (e.g. `horus investigate --shopify-query @orders.graphql`). Deterministic input,
   * the same trust tier as `hint` — executed verbatim by the Shopify connector, never built
   * in engine/connector code. When omitted, the connector falls back to its config-declared
   * default queries (so `horus watch`, which passes no flag, still collects). Empty/absent
   * ⇒ Shopify contributes nothing.
   */
  shopifyQueries?: ShopifyQuerySpec[];
}

/**
 * HOR-386 — a single deterministic next-step suggestion produced by the shared router.
 * Advisory DATA only: the surfaces print it, nothing shells out or auto-invokes. Every
 * `nextTool` is a REAL `horus` command (or MCP tool) — the router never fabricates one.
 */
export interface RouteStep {
  /** The next command/tool to run, e.g. `blast-radius`, `connect`, `index`, `search`. */
  nextTool: string;
  /** Arguments to pass (a seed name, connector type, `--live`, …); may be empty. */
  args: string;
  /** Why this step is suggested — templated, often verbatim `gap.nextSource`; never LLM prose. */
  reason: string;
}

/**
 * Coarse classification of a deterministic finding. Promoted (Stage 0) from a
 * free string to a closed union so the set is typed at compile time; the members
 * are exactly the values the engine emits today. Typing-only and additive — the
 * `kind` is never read by the scoring/confidence/verdict path.
 */
export type FindingKind = 'observation' | 'anomaly' | 'correlation';

/** A deterministic, evidence-backed finding asserted by the engine. */
export interface ReportFinding {
  /** Coarse classification of the assertion. */
  kind: FindingKind;
  title: string;
  detail?: string;
  /** 0–1 confidence in the assertion. */
  confidence: number;
  /** Ids of the Evidence rows this finding draws from. */
  evidenceIds: string[];
}

/** The full investigation report — also the persisted shape. */
export interface InvestigationReport {
  createdAt?: string;
  unattended?: { model: string; sessionId?: string; status: 'completed' | 'failed'; error?: string; engineOnly?: boolean };
  startupRecall?: import('./memory-recall.js').StartupIncident[];
  recallTrace?: Array<{ memoryId: string; check: string; stage: string; evidenceIds: string[]; error?: string }>;
  memoryCaptureError?: string;
  id: string;
  /**
   * False when the investigation-store DB was unreachable and the report could not
   * be saved — the run is display-only and `horus ask <id>` will not resolve it.
   * Undefined on reports that predate this flag. (HOR-319 DB-resilience.)
   */
  persisted?: boolean;
  input: InvestigationInput;
  /**
   * The entity under investigation — the service and/or environment scope this
   * report concerns (Stage 0). Derived from the investigation scope; absent when
   * neither is known (inert, never fabricated). Additive; never enters the
   * scoring/confidence/verdict path.
   */
  subject?: EvidenceSubject;
  summary: string;
  /**
   * HOR-385: the deterministic structural intent the engine classified the hint as
   * (`incident` | `source-impact` | `explain`). Drives source-impact mode (suppressed
   * runtime evidence + impact-led summary) and is read by the next-step router (HOR-386).
   * Absent on reports that predate the classifier.
   */
  intent?: 'incident' | 'source-impact' | 'explain';
  /** Symbols that the hint resolved to. */
  seeds: Symbol[];
  evidence: Evidence[];
  timeline: Timeline;
  correlation: CorrelationResult;
  findings: ReportFinding[];
  /** Ranked cause candidates produced by the Cause Scoring Engine (HOR-15). */
  suspectedCauses: CauseCandidate[];
  hypotheses: ValidatedHypothesis[];
  /** Similar past incidents recalled from institutional memory (context only). */
  similarIncidents: SimilarIncident[];
  /** Structured analysis of what evidence is absent and its confidence impact (HOR-19). */
  gapAnalysis: GapAnalysis;
  /**
   * Infrastructure topology derived from evidence: queues, services, workers,
   * collections, deployments, and the relationships between them (HOR-14).
   */
  graph: InvestigationGraph;
  /** 0–1 overall confidence in the investigation. */
  confidence: number;
  /**
   * Set when the investigation ran WITHOUT source intelligence (HOR-319 layer-2): the
   * code host was unreachable and could not be self-healed, so only runtime evidence
   * (logs/metrics/state/queues) was available. Confidence is capped and structural
   * findings (seed, blast-radius, flows, ownership) are absent. Undefined = full run.
   */
  degraded?: { sourceIntelligence: boolean; reason: string };
  nextActions: string[];
  /**
   * HOR-386 — structured, deterministic next-step suggestions from the shared router
   * (`router.ts`). Each `RouteStep` names a REAL command to run, with args and a reason.
   * The single source the human/--json/MCP surfaces render. Absent on reports that
   * predate the router; `nextActions` remains the legacy human-string form.
   */
  nextSteps?: RouteStep[];
  /** Ownership estimate for the implicated component (HOR-40). Null when repoPath is not supplied. */
  ownership?: OwnershipEstimate | null;
  /** Per-source runtime contribution summary (HOR-70). */
  sourceStatus?: RuntimeSourceReport;
  /** Bounded git change summary collected near the incident window (HOR-94). */
  recentChanges?: BoundedGitChange;
  /**
   * Ordered causal chains derived from validated hypotheses and the evidence graph (HOR-196).
   * Each chain shows trigger → propagation → symptom steps with cited evidence IDs.
   * Present only for hypotheses with verdict 'supported' or 'weakened'.
   */
  causeChains?: CauseChain[];
  /**
   * Persisted AI judgment stored alongside the deterministic report (HOR-198).
   * Present only when --ai was used and the provider succeeded.
   * Deterministic scoring remains authoritative; this field is an annotation only.
   */
  aiJudgment?: StoredAIJudgment;
  /**
   * Gap #5 — when the hint reads as a behavioral "how does X work" question, the report
   * leads with this flow walkthrough instead of the incident pipeline (seeds/causes/
   * confidence). Present only for explanatory hints.
   */
  behavioral?: BehavioralWalkthrough;
}

/**
 * A "how does X work" behavioral walkthrough — the call flow of a code path, built from
 * the seed's pre-computed execution Flow plus its callees. Rendered instead of the
 * incident sections when the hint is explanatory.
 */
export interface BehavioralWalkthrough {
  /** The behavioral question (the hint). */
  question: string;
  /** The flow entry point (controller/resolver/route/handler), or the seed. */
  entry: Symbol | null;
  /** The ordered execution steps (the Flow's steps, or the seed + its callees). */
  steps: Symbol[];
  /** Detected external calls — HTTP clients, queues, webhooks. */
  externalCalls: string[];
  /** Detected persistence — DB/ORM writes, collections. */
  persistence: string[];
  /** Rendered prose walkthrough. */
  narrative: string;
}

/**
 * AI judgment persisted as part of the investigation report (HOR-198).
 * Mirrors NarrativeOutput from @horus/ai but defined here so @horus/engine
 * stays decoupled from @horus/ai.
 */
export interface StoredAIJudgment {
  what: string;
  why: string;
  whereNext: string[];
  citations: Array<{ evidenceId: string; rationale?: string }>;
  confidence: number;
  mentionedServices?: string[];
  hypothesisJudgments?: Array<{
    hypothesisId: string;
    category: string;
    verdict: 'supported' | 'weakened' | 'eliminated' | 'unconfirmed';
    rationale: string;
    citedEvidenceIds: string[];
    confidence: number;
  }>;
  rootCauseAssessment?: {
    summary: string;
    primaryHypothesisId?: string;
    citedEvidenceIds: string[];
    uncertainty: 'low' | 'medium' | 'high';
  };
  /** AI provider name (e.g. 'anthropic') or 'deterministic' for fallback. */
  provider: string;
  /** ISO 8601 timestamp when the judgment was generated. */
  generatedAt: string;
}

/** Re-exported for convenience so callers can type flow steps without @horus/core. */
export type { Evidence, Symbol, Flow, EvidenceSubject };
