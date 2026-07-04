import type { CodeProvider } from '@horus/connectors';
import type { Symbol } from '@horus/core';
import { listQueueEdges, isDbUnavailable, type HorusDb } from '@horus/db';
import { rankSeeds, parseNamedSymbols, resolveSeedSymbol, type ResolutionKind } from './seeds.js';

export interface AsyncDependency {
  queueName: string;
  counterpart: string;
  counterpartFile: string | null;
}

export interface BlastRadiusReport {
  seed: Symbol;
  /** How the query resolved to the seed (shared resolver semantics — same as explain). */
  resolution: ResolutionKind;
  /** True when multiple exact matches tied — `alternatives` disclose them. */
  ambiguous: boolean;
  /** Runner-up candidates from the same resolution tier (for disambiguation display). */
  alternatives: Symbol[];
  upstream: Symbol[];
  downstream: { depth: number; symbols: Symbol[] }[];
  asyncUpstream: AsyncDependency[];
  asyncDownstream: AsyncDependency[];
  blastRadius: number;
  criticality: 'low' | 'medium' | 'high';
  summary: string;
  note: string;
  /**
   * True when the local database was unavailable (a build shipped without pglite's
   * assets), so the async queue-boundary enrichment was skipped. The command surfaces a
   * dim note; the source-graph blast radius itself is unaffected.
   */
  dbUnavailable: boolean;
}

export async function analyzeBlastRadius(
  query: string,
  deps: { code: CodeProvider; db: HorusDb; project?: string },
  depth = 3,
  opts?: { includeTests?: boolean },
): Promise<BlastRadiusReport | null> {
  // THE canonical resolver (shared with explain/search/investigate): exact-qualified >
  // exact > fuzzy, product code before tests, deterministic ambiguity. Only a FUZZY
  // result falls back to the HOR-385 prompt-named seed ranking — for prose-ish routed-in
  // queries where rankSeeds' heuristics are the right layer.
  const res = await resolveSeedSymbol(deps.code, query, {
    limit: 20,
    includeTests: opts?.includeTests ?? false,
  });
  let top = res.candidates[0];
  if (res.kind === 'fuzzy') {
    const preferNamed = parseNamedSymbols(query)[0];
    top = rankSeeds(res.candidates, undefined, undefined, false, null, preferNamed)[0]?.symbol;
  }
  if (!top) return null;
  // Alternatives: same-tier runners-up (exact matches only) for disambiguation display.
  const alternatives =
    res.kind === 'exact' || res.kind === 'exact-qualified'
      ? res.candidates
          .slice(1)
          .filter((s) => s.name.toLowerCase() === top!.name.toLowerCase())
          .slice(0, 4)
      : [];

  const [ctx, impact] = await Promise.all([
    deps.code.context(top.id),
    deps.code.impact(top.id, depth, opts?.includeTests ? { includeTests: true } : undefined),
  ]);

  // upstream = what the seed depends on (callees)
  const upstream: Symbol[] = ctx.callees;

  // downstream = callers by depth = affected if the seed fails
  const downstream: { depth: number; symbols: Symbol[] }[] = impact.byDepth;

  // Queue edges are the only db-backed enrichment here. A build that ships without
  // pglite's assets (the single-file download) hands us a display-only db that throws
  // HORUS_DB_UNAVAILABLE on access — degrade to no async boundaries rather than crash
  // the whole blast-radius report; the source-graph radius is unaffected.
  let edges: Awaited<ReturnType<typeof listQueueEdges>> = [];
  let dbUnavailable = false;
  try {
    edges = await listQueueEdges(deps.db, { project: deps.project });
  } catch (err) {
    if (!isDbUnavailable(err)) throw err;
    dbUnavailable = true;
  }

  // asyncDownstream: seed is the producer -> workers are downstream
  const asyncDownstreamMap = new Map<string, AsyncDependency>();
  for (const edge of edges) {
    if (edge.producerFile === top.filePath || edge.producerSymbol === top.name) {
      const key = edge.queueName + '|' + (edge.workerSymbol ?? 'unknown-worker');
      if (!asyncDownstreamMap.has(key)) {
        asyncDownstreamMap.set(key, {
          queueName: edge.queueName,
          counterpart: edge.workerSymbol ?? 'unknown-worker',
          counterpartFile: edge.workerFile,
        });
      }
    }
  }
  const asyncDownstream: AsyncDependency[] = Array.from(asyncDownstreamMap.values());

  // asyncUpstream: seed is the worker -> producers are upstream
  const asyncUpstreamMap = new Map<string, AsyncDependency>();
  for (const edge of edges) {
    if (edge.workerFile === top.filePath || edge.workerSymbol === top.name) {
      const key = edge.queueName + '|' + (edge.producerSymbol ?? 'unknown-producer');
      if (!asyncUpstreamMap.has(key)) {
        asyncUpstreamMap.set(key, {
          queueName: edge.queueName,
          counterpart: edge.producerSymbol ?? 'unknown-producer',
          counterpartFile: edge.producerFile,
        });
      }
    }
  }
  const asyncUpstream: AsyncDependency[] = Array.from(asyncUpstreamMap.values());

  const blastRadius = impact.affected + asyncDownstream.length;

  const criticality: 'low' | 'medium' | 'high' =
    blastRadius >= 10 ? 'high' : blastRadius >= 3 ? 'medium' : 'low';

  const summary =
    'If ' +
    top.name +
    ' (' +
    top.filePath +
    ') fails, ~' +
    blastRadius +
    ' symbol(s) are affected downstream' +
    (asyncDownstream.length
      ? ' (incl. ' + asyncDownstream.length + ' across async queue boundaries)'
      : '') +
    '; it depends on ' +
    upstream.length +
    ' symbol(s) upstream' +
    (asyncUpstream.length ? ' + ' + asyncUpstream.length + ' async producer(s)' : '') +
    '. Criticality: ' +
    criticality +
    '.';

  const note =
    'The component reporting an error is often not the cause — inspect the upstream dependencies first.';

  return {
    seed: top,
    resolution: res.kind,
    ambiguous: res.ambiguous,
    alternatives,
    upstream,
    downstream,
    asyncUpstream,
    asyncDownstream,
    blastRadius,
    criticality,
    summary,
    note,
    dbUnavailable,
  };
}
