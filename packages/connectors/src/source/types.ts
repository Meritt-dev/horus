export interface SourceNode {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  language: string;
  className: string;
  isDead: boolean;
  isEntryPoint: boolean;
  isExported: boolean;
  /** B2: for a public export-alias stub, the impl symbol name it redirects to (else absent). */
  aliasOf?: string | null;
}

export interface SourceSearchResult {
  nodeId: string;
  score: number;
  name: string;
  filePath: string;
  label: string;
  snippet: string;
}

export interface SourceCypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
}

export interface SourceImpactResult {
  target: SourceNode;
  affected: number;
  depths: Record<string, SourceNode[]>;
}

export interface SourceDiffResult {
  added: SourceNode[];
  removed: SourceNode[];
  modified: { before: SourceNode; after: SourceNode }[];
  addedEdges: unknown[];
  removedEdges: unknown[];
}

export interface SourceOverview {
  nodesByLabel: Record<string, number>;
  edgesByType: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

// ---------------------------------------------------------------------------
// Typed read-path endpoints (HOR-392) — the host now serves these instead of the
// CLI emitting raw Cypher. Shapes mirror horus-source (kuzu-retire) route serializers.
// ---------------------------------------------------------------------------

/** POST /api/content-search result row — full (untruncated) node content. */
export interface SourceContentHit {
  nodeId: string;
  name: string;
  filePath: string;
  content: string;
}

/** GET /api/symbols/exact result row — exact-name hit with line ranges (file label excluded). */
export interface SourceExactSymbol {
  nodeId: string;
  name: string;
  filePath: string;
  label: string;
  startLine: number;
  endLine: number;
}

/** GET /api/symbols result row — symbol node for the requested label(s). */
export interface SourceLabelSymbol {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  className: string;
  isEntryPoint: boolean;
  isExported: boolean;
  signature: string;
}

/** POST /api/nodes/lines value — line range for one resolved node id. */
export interface SourceNodeLine {
  filePath: string;
  startLine: number;
  endLine: number;
}

/** GET /api/flows/{id} step — a flow step carrying its symbol name/file (no second round-trip). */
export interface SourceFlowStep {
  nodeId: string;
  name: string;
  filePath: string;
  startLine: number;
  stepNumber: number | null;
}

/** GET /api/flows/{id} response — the processes a symbol is a step in + their merged ordered steps. */
export interface SourceFlowsResult {
  processes: { id: string; name: string }[];
  steps: SourceFlowStep[];
}

/** GET /api/communities response. */
export interface SourceCommunitiesResult {
  communities: {
    id: string;
    name: string;
    memberCount: number;
    cohesion: number | null;
    members: string[];
  }[];
}

/** GET /api/dead-code response — total + symbols grouped by file. */
export interface SourceDeadCodeResult {
  total: number;
  byFile: Record<string, { name: string; type: string; line: number }[]>;
}

/** GET /api/coupling response — temporal (co-change) coupling pairs between files. */
export interface SourceCouplingResult {
  pairs: { fileA: string; fileB: string; strength: number; coChanges: number }[];
}

/** POST /api/content-search filesOnly response — per-token distinct FILE paths. */
export interface SourceFilesContainingResult {
  matches: Record<string, string[]>;
}

/** GET /api/processes response. */
export interface SourceProcessesResult {
  processes: {
    name: string;
    kind: string | null;
    stepCount: number;
    steps: { nodeId: string; stepNumber: number | null }[];
  }[];
}

/** One caller/callee neighbour with its edge confidence (GET /api/node). */
export interface SourceNeighbour {
  node: SourceNode;
  confidence: number;
}

/** GET /api/node/{id} extended detail — node + content + neighbours + file context + communities. */
export interface SourceNodeDetail {
  node: SourceNode & { content?: string | null };
  callers: SourceNeighbour[];
  callees: SourceNeighbour[];
  typeRefs: SourceNode[];
  processMemberships?: unknown[];
  imports: string[];
  coupledWith: { file: string; strength: number | null; coChanges: number }[];
  communities: { id: string; name: string }[];
}

export interface SourceHostInfo {
  repoPath: string;
  hostUrl: string;
  mcpUrl: string;
  watch: boolean;
  mode: string;
  /**
   * B1.4 symbol-only degraded-mode contract. `structuralReady` is true once the
   * structural index (symbols + edges) is persisted and searchable; `embeddingsPending`
   * is true while it is usable but semantic vectors are still warming in the background.
   * Optional for back-compat: older backends omit them (treated as absent).
   */
  structuralReady?: boolean;
  embeddingsPending?: boolean;
}

export interface SourceHealth {
  ok: boolean;
  status: number;
}

// ---------------------------------------------------------------------------
// Memory vector bridge (M2) — wire shapes for the host's /api/memory/* routes.
// Vectors are a DERIVED index; Postgres (M1) stays source-of-truth. These types
// mirror the host bridge in the spec (contract C: memory_index_upsert/search/remove).
// ---------------------------------------------------------------------------

/** POST /api/memory/upsert body. `scope` carries the recall specificity (symbol:/module:/repo/global). */
export interface SourceMemoryUpsertRequest {
  memoryId: string;
  claim: string;
  repo: string;
  scope: string;
}

/** POST /api/memory/search body. `repo` is required (fail-closed isolation, HOR-46). */
export interface SourceMemorySearchRequest {
  query: string;
  repo: string;
  limit: number;
}

/** A single scored candidate returned by the host vector search. `score` is cosine in 0..1. */
export interface SourceMemorySearchHit {
  memoryId: string;
  score: number;
}

/** POST /api/memory/search response envelope. */
export interface SourceMemorySearchResult {
  results: SourceMemorySearchHit[];
}
