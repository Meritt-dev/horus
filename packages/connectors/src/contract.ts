/**
 * Provider contracts for @horus/connectors.
 *
 * `Provider` is the base interface shared by every data-source adapter.
 * `CodeProvider` extends it with all code-graph operations backed by source intelligence.
 */

import type {
  Symbol,
  SymbolContext,
  Flow,
  HealthStatus,
  ImpactResult,
  ChangeSet,
  CypherResult,
  ProviderKind,
} from '@horus/core';

/** Minimal interface every provider must satisfy. */
export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  health(): Promise<HealthStatus>;
}

/** Full contract for a code-graph provider (source intelligence). */
export interface CodeProvider extends Provider {
  searchSymbols(query: string, limit?: number): Promise<Symbol[]>;
  context(symbolId: string): Promise<SymbolContext>;
  /** Product-only by default; `opts.includeTests` restores test/docs/example callers. */
  impact(symbolId: string, depth?: number, opts?: { includeTests?: boolean }): Promise<ImpactResult>;
  flowsFor(symbolId: string, opts?: { includeTests?: boolean }): Promise<Flow[]>;
  /** Method symbols of a class, for class-seed walkthroughs (typed /api/class-methods). */
  classMethods?(file: string, className: string): Promise<Symbol[]>;
  detectChanges(diff: { base: string; compare: string }): Promise<ChangeSet>;
  cypher(query: string): Promise<CypherResult>;

  // Typed read-path methods for architecture discovery (HOR-392 follow-up). The engine's
  // `discoverArchitecture` previously emitted raw Cypher through `cypher()`, which the
  // SQLite console rejects — every query silently failed and `horus architecture` rendered
  // empty on every repo. These are the REST-backed replacements; optional (`?`) because
  // they're additive to existing CodeProvider mocks/implementations, and the engine
  // degrades per-section when one is absent. Shapes are the minimal structural subsets
  // the engine consumes — the HTTP provider's richer payloads satisfy them.

  /** Aggregate node counts by label (GET /api/overview). */
  overview?(): Promise<{ nodesByLabel: Record<string, number> }>;
  /** Community clusters (Louvain) with member counts (GET /api/communities). `members`
   *  (node ids) lets the engine detect docs/example-dominated clusters by path. */
  communities?(): Promise<{ name: string; memberCount: number; members?: string[] }[]>;
  /** Discovered execution processes (GET /api/processes). Step data lets the engine rank
   *  flows by length/real-path instead of alphabetically. */
  processes?(): Promise<
    { name: string; stepCount?: number; steps?: { nodeId: string }[] }[]
  >;
  /** Dead-code report — the engine consumes `total` (GET /api/dead-code). */
  deadCode?(): Promise<{ total: number }>;
  /** Temporal coupling pairs — the engine counts `coChanges >= 3` (GET /api/coupling). */
  coupling?(): Promise<{ coChanges: number }[]>;
  /** Per-token distinct file paths containing the token (POST /api/content-search filesOnly). */
  filesContaining?(tokens: string[], limit?: number): Promise<Record<string, string[]>>;
}
