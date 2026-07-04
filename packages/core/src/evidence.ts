/**
 * The Evidence model — the universal currency between providers, the engine, and the
 * LLM. Everything the AI sees is a typed, attributable `Evidence`; no raw provider
 * blobs reach the model. See architecture.md §2.5.
 */

/** Which kind of system produced a piece of evidence. */
export type ProviderKind =
  | 'code' // source intelligence
  | 'logs' // Elasticsearch
  | 'metrics' // Prometheus
  | 'state' // Redis / MongoDB
  | 'queue' // BullMQ
  | 'history'; // Git

/**
 * Investigation-priority tier, assigned by the normalization layer (never by
 * providers). Reflects how much attention the investigator should give this
 * evidence item, derived from relevance and kind — NOT operational impact.
 * `critical` and `high` warrant immediate attention; `info` is structural
 * context that enriches the picture without signalling a broken system.
 */
export type EvidencePriority = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Broad functional category for grouping and filtering across providers.
 * Assigned by the normalization layer, not by individual providers.
 */
export type EvidenceCategory =
  | 'queue'      // BullMQ backlog, starvation, failures
  | 'database'   // MongoDB state anomalies
  | 'cache'      // Redis, Memcached — in-memory key/value state
  | 'logs'       // Elasticsearch error patterns
  | 'code'       // source-intelligence symbols, flows, impact blast-radius
  | 'deployment' // Git commits
  | 'metrics'    // Grafana time-series
  | 'other';

/** The shape of a single evidence item. */
export type EvidenceKind =
  | 'log'
  | 'metric'
  | 'symbol'
  | 'flow'
  | 'commit'
  | 'queue-state'
  | 'queue-edge'
  | 'redis-key'
  | 'state' // application/DB state (MongoDB)
  | 'impact';

/**
 * The entity an evidence item pertains to — the service and/or environment scope.
 * Assigned by the NORMALIZATION layer (never by providers), derived from connector
 * config + investigation scope; the same discipline as `priority`/`category`.
 * Inert when unknown: a field is present only when a real value is known, never
 * fabricated.
 */
export interface EvidenceSubject {
  service?: string;
  environment?: string;
}

/** Graph back-references that let a human (or the engine) jump to the source. */
export interface EvidenceLinks {
  file?: string;
  line?: number;
  symbolId?: string;
  commit?: string;
  traceId?: string;
  queueName?: string;
}

export interface Evidence {
  /** Stable, citable id, e.g. `ev_log_01H...`. The AI must reference these. */
  id: string;
  source: ProviderKind;
  kind: EvidenceKind;
  /** Human-readable one-line summary. */
  title: string;
  /** ISO timestamp, for timeline alignment. */
  timestamp?: string;
  /** Engine-assigned relevance, 0–1. */
  relevance: number;
  /** Typed per `kind`; opaque to the engine, structured for the renderer/AI. */
  payload: unknown;
  links: EvidenceLinks;
  /** Reproducibility: the query that produced this and when. */
  provenance: { query: string; collectedAt: string };
  /** Investigation-priority tier; assigned by the normalization layer. Not operational severity. */
  priority?: EvidencePriority;
  /** Broad functional grouping; assigned by the normalization layer. */
  category?: EvidenceCategory;
  /**
   * Entity under investigation this item pertains to (service/environment).
   * Assigned by the normalization layer from connector config + investigation
   * scope — never by providers. Absent when unknown (inert, never fabricated).
   */
  subject?: EvidenceSubject;
  /**
   * Normalized recurrence signal: true when this error/event is a brand-new
   * signature that has never been seen before. Providers set this field so the
   * scorer can read it without inspecting provider-specific payload shapes.
   */
  isNew?: boolean;
  /**
   * Normalized recurrence signal: current-window count divided by baseline.
   * Values ≥ 3.0 indicate a significant spike. Providers set this field so the
   * scorer can read it without inspecting provider-specific payload shapes.
   */
  ratio?: number;
}

/** A resolved code symbol, as returned by the code provider. */
export interface Symbol {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  language?: string;
  className?: string;
  /**
   * Search relevance (0–1) carried from the source provider, when available. A strong
   * exact-content / colocated-code match (≈1.0) must outweigh a coincidental architectural
   * match in seed ranking — without this the score was dropped and a service-named weak
   * semantic hit could outrank the real raise site (dogfood gap 3).
   */
  score?: number;
  /**
   * B2 (anonymous/default-export synthesis): the NAME of the implementation symbol this
   * public export name aliases, when this symbol is an export-alias stub. The parser emits
   * `export { BaseComponent as Component }` (preact) and `module.exports = { sign: signImpl }`
   * as an EXPORTS_ALIAS edge public→impl plus a searchable stub carrying `alias_of` in
   * `properties_json`; the source host surfaces it here. The resolver
   * ({@link resolveSymbolQuery}) follows it to REDIRECT a hit on the public name to the
   * implementation, so explain/blast-radius/search land on product code, not the empty alias
   * stub (whose callers/callees belong to the impl). Same-file only. Undefined for the vast
   * majority of symbols.
   */
  aliasOf?: string;
}

/** A reference to a source-intelligence community cluster. */
export interface CommunityRef {
  id: string;
  name: string;
}

/** A file that co-changes frequently with another (git coupling). */
export interface CoupledFile {
  file: string;
  coChanges: number;
}

/** Raw result from a Cypher query. */
export interface CypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** Result of an impact analysis rooted at a symbol. */
export interface ImpactResult {
  target: Symbol;
  affected: number;
  byDepth: { depth: number; symbols: Symbol[] }[];
}

/** Added/removed/modified symbols between two refs. */
export interface ChangeSet {
  added: Symbol[];
  removed: Symbol[];
  modified: { before: Symbol; after: Symbol }[];
}

/** Callers + callees of a symbol, enriched with source-intelligence graph neighbours. */
export interface SymbolContext {
  symbol: Symbol;
  snippet?: string; // short excerpt of the symbol's source (display)
  /**
   * The symbol's FULL source body, for analysis that must scan the whole function —
   * not just the display excerpt. Used by the cross-signal event_code join to detect
   * runtime error codes RAISED FROM the seed (their literal lives anywhere in the body,
   * often near the end, beyond the snippet cutoff). Optional; falls back to snippet.
   */
  sourceBody?: string;
  callers: Symbol[];
  callees: Symbol[];
  imports: string[]; // file paths the symbol's defining file imports
  usesType: Symbol[]; // TypeAlias/Interface the symbol uses
  community: CommunityRef | null;
  coupledWith: CoupledFile[]; // git-coupled files
  isDead?: boolean;
}

/** A pre-computed multi-hop execution flow (source-intelligence `Process` node). */
export interface Flow {
  id: string;
  name: string;
  steps: Symbol[];
}

/** Status of a provider, surfaced by `horus status`. */
export interface HealthStatus {
  ok: boolean;
  detail: string;
}
