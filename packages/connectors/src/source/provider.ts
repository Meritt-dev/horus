/**
 * SourceCodeProvider — the code-graph `CodeProvider` backed by a running `horus-source host`.
 *
 * The read path goes through the host's TYPED endpoints (HOR-392): exact-name lookup,
 * batch line hydration, the extended node-detail endpoint, and the flows endpoint. The
 * CLI no longer emits or escapes raw Cypher — `cypher()` remains ONLY as a passthrough
 * for the user-facing SQL-console path.
 */

import type {
  Symbol,
  SymbolContext,
  ImpactResult,
  ChangeSet,
  CypherResult,
  CommunityRef,
  CoupledFile,
  Flow,
  HealthStatus,
} from '@horus/core';
import { SourceHttpError } from './client.js';
import type { SourceHttpClient } from './client.js';
import type { SourceNode } from './types.js';
import type { CodeProvider } from '../contract.js';

export class SourceCodeProvider implements CodeProvider {
  readonly id = 'source';
  readonly kind = 'code' as const;

  constructor(private readonly client: SourceHttpClient) {}

  // --- helpers -------------------------------------------------------------

  private nodeToSymbol(n: SourceNode): Symbol {
    return {
      id: n.id,
      name: n.name,
      filePath: n.filePath,
      startLine: n.startLine,
      endLine: n.endLine,
      signature: n.signature,
      language: n.language,
      className: n.className,
    };
  }

  /** Map a serialized graph node to a `Symbol`, coercing the host's `0` line sentinel to undefined. */
  private serializedToSymbol(n: SourceNode): Symbol {
    const sym: Symbol = {
      id: n.id ?? '',
      name: n.name ?? '',
      filePath: n.filePath ?? '',
    };
    if (typeof n.startLine === 'number' && n.startLine > 0) sym.startLine = n.startLine;
    if (typeof n.endLine === 'number' && n.endLine > 0) sym.endLine = n.endLine;
    if (n.className) sym.className = n.className;
    if (n.signature) sym.signature = n.signature;
    if (n.language) sym.language = n.language;
    return sym;
  }

  /**
   * Graceful degradation (HOR-353): a 4xx for THIS repo's graph shape must not abort the
   * whole investigation. The caller passes a default the slice degrades to.
   */
  private async degrade<T>(p: Promise<T>, fallback: T): Promise<T> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof SourceHttpError && err.status >= 400 && err.status < 500) {
        return fallback;
      }
      throw err;
    }
  }

  // --- contract ------------------------------------------------------------

  async health(): Promise<HealthStatus> {
    const h = await this.client.health();
    return {
      ok: h.ok,
      detail: h.ok ? 'Source intelligence host responded ' + h.status : 'Source intelligence host unreachable',
    };
  }

  async searchSymbols(query: string, limit = 10): Promise<Symbol[]> {
    // Phase 1: deterministic exact-name lookup via the typed endpoint.
    // Vector search can rank unrelated symbols above exact-name hits when embedding
    // similarity is misleading (HOR-164). An exact-name hit is always authoritative.
    // Phase 2: semantic search — run in parallel with Phase 1.
    const [exactHits, semanticRes] = await Promise.all([
      this.degrade(this.client.exactSymbols(query, limit), []),
      this.client.search(query, limit),
    ]);

    const exactSymbols: Symbol[] = exactHits.map((h) => {
      const sym: Symbol = {
        id: h.nodeId,
        name: h.name,
        filePath: h.filePath,
        score: 1, // an exact-name hit is authoritative
      };
      if (h.startLine > 0) sym.startLine = h.startLine;
      if (h.endLine > 0) sym.endLine = h.endLine;
      return sym;
    });

    const exactIds = new Set(exactSymbols.map((s) => s.id));
    const ql = query.toLowerCase();

    // Re-rank semantic results: partial name matches above pure embedding-only matches,
    // File-label results below all symbol matches. Within a band, PUBLIC declarations
    // outrank private internals (dogfood cycle-2 N9: fastapi `search "router"` filled
    // its top-8 with _RouterIncludeContext/__init__/_contains_router while APIRouter —
    // the symbol the user meant — missed the page; hybrid scores are near-flat, so
    // the underscore prefix is the only discriminating signal available here).
    const semantic = semanticRes
      .filter((r) => !exactIds.has(r.nodeId))
      .map((r) => {
        const nl = r.name.toLowerCase();
        const isFile = r.label === 'File';
        let rank = 0;
        if (!isFile && (nl.includes(ql) || ql.includes(nl))) rank = 2;
        else if (isFile && (nl.includes(ql) || ql.includes(nl))) rank = 1;
        if (r.name.startsWith('_') || r.name.startsWith('#')) rank -= 1; // private convention
        const label = (r.label ?? '').toLowerCase();
        if (label === 'class' || label === 'interface') rank += 0.5; // declarations lead
        return { r, rank };
      });

    semantic.sort((a, b) => b.rank - a.rank || b.r.score - a.r.score);

    const combined: Symbol[] = [
      ...exactSymbols,
      ...semantic.map(({ r }) => ({ id: r.nodeId, name: r.name, filePath: r.filePath, score: r.score })),
    ];

    // Hydrate start/end lines from the graph (HOR-211). Exact hits already carry lines, but
    // semantic results return only id/name/file — without this they render as `file:0`. One
    // batched lookup by id fills real line ranges for the page.
    return this.hydrateLines(combined.slice(0, limit));
  }

  /** Attach start/end line ranges to symbols via a single batched id lookup. */
  private async hydrateLines(symbols: Symbol[]): Promise<Symbol[]> {
    const ids = symbols.map((s) => s.id).filter(Boolean);
    if (ids.length === 0) return symbols;
    const lines = await this.degrade(this.client.nodesLines(ids), {});
    return symbols.map((s) => {
      const l = lines[s.id];
      if (l === undefined) return s;
      const out = { ...s };
      if (typeof l.startLine === 'number' && l.startLine > 0) out.startLine = l.startLine;
      if (typeof l.endLine === 'number' && l.endLine > 0) out.endLine = l.endLine;
      return out;
    });
  }

  async context(symbolId: string): Promise<SymbolContext> {
    // One round-trip: the extended node-detail endpoint returns the node + content +
    // callers/callees/typeRefs + file imports + git coupling + communities (HOR-392).
    const detail = await this.degrade(this.client.node(symbolId), null);

    if (detail === null) {
      // 4xx / unknown node — degrade to an empty-but-honest context.
      return {
        symbol: { id: symbolId, name: '', filePath: '' },
        callers: [],
        callees: [],
        imports: [],
        usesType: [],
        community: null,
        coupledWith: [],
        isDead: false,
      };
    }

    const n = detail.node;
    const symbol: Symbol = {
      id: n.id ?? symbolId,
      name: n.name ?? '',
      filePath: n.filePath ?? '',
    };
    if (typeof n.startLine === 'number' && n.startLine > 0) symbol.startLine = n.startLine;
    if (typeof n.endLine === 'number' && n.endLine > 0) symbol.endLine = n.endLine;
    if (n.signature) symbol.signature = n.signature;
    if (n.className) symbol.className = n.className;
    if (n.language) symbol.language = n.language;

    const content = n.content;
    const snippet = typeof content === 'string' ? content.slice(0, 600) : undefined;
    // Full body for analysis that must scan the whole function (e.g. detecting runtime
    // error codes RAISED FROM the seed, whose literal often sits near the end — past the
    // snippet cutoff). Bounded generously so very large symbols don't bloat memory.
    const sourceBody = typeof content === 'string' ? content.slice(0, 20000) : undefined;

    const callees = (detail.callees ?? []).map((c) => this.serializedToSymbol(c.node));
    const callers = (detail.callers ?? []).map((c) => this.serializedToSymbol(c.node));
    const usesType = (detail.typeRefs ?? []).map((t) => this.serializedToSymbol(t));

    const communityRow = (detail.communities ?? [])[0];
    const community: CommunityRef | null = communityRow
      ? { id: String(communityRow.id ?? ''), name: String(communityRow.name ?? '') }
      : null;

    const imports = (detail.imports ?? []).map((i) => String(i));
    const coupledWith: CoupledFile[] = (detail.coupledWith ?? []).map((c) => ({
      file: String(c.file ?? ''),
      coChanges: Number(c.coChanges ?? 0),
    }));

    return {
      symbol,
      snippet,
      ...(sourceBody !== undefined ? { sourceBody } : {}),
      callers,
      callees,
      imports,
      usesType,
      community,
      coupledWith,
      isDead: Boolean(n.isDead),
    };
  }

  async impact(
    symbolId: string,
    depth = 3,
    opts?: { includeTests?: boolean },
  ): Promise<ImpactResult> {
    const r = await this.client.impact(symbolId, depth, opts);
    return {
      target: this.nodeToSymbol(r.target),
      affected: r.affected,
      byDepth: Object.entries(r.depths)
        .map(([d, nodes]) => ({
          depth: Number(d),
          symbols: nodes.map((n) => this.nodeToSymbol(n)),
        }))
        .sort((a, b) => a.depth - b.depth),
    };
  }

  async flowsFor(symbolId: string, opts?: { includeTests?: boolean }): Promise<Flow[]> {
    // The typed flows endpoint returns the processes a symbol is a step in, plus the
    // merged ordered steps (each step carries its name/file). The host merges steps across
    // a symbol's processes, so each Flow shares that ordered step list.
    const res = await this.degrade(this.client.flows(symbolId, opts), { processes: [], steps: [] });
    const steps: Symbol[] = (res.steps ?? []).map((s) => {
      const sym: Symbol = { id: s.nodeId, name: s.name, filePath: s.filePath };
      if (typeof s.startLine === 'number' && s.startLine > 0) sym.startLine = s.startLine;
      return sym;
    });
    return (res.processes ?? []).map((p) => ({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      steps,
    }));
  }

  /** Method symbols of a class (typed /api/class-methods). Used for class-seed walkthroughs. */
  async classMethods(file: string, className: string): Promise<Symbol[]> {
    const methods = await this.degrade(this.client.classMethods(file, className), []);
    return methods
      .map((m) => this.serializedToSymbol(m))
      .filter((s) => s.id !== '' && s.name !== '');
  }

  async detectChanges(diff: { base: string; compare: string }): Promise<ChangeSet> {
    const d = await this.client.diff(diff.base, diff.compare);
    return {
      added: d.added.map((n) => this.nodeToSymbol(n)),
      removed: d.removed.map((n) => this.nodeToSymbol(n)),
      modified: d.modified.map((m) => ({
        before: this.nodeToSymbol(m.before),
        after: this.nodeToSymbol(m.after),
      })),
    };
  }

  cypher(query: string): Promise<CypherResult> {
    return this.client.cypher(query);
  }

  // Typed read-path passthroughs for architecture discovery — see CodeProvider contract.

  overview(): Promise<{ nodesByLabel: Record<string, number> }> {
    return this.client.overview();
  }

  communities(): Promise<{ name: string; memberCount: number; members?: string[] }[]> {
    return this.client.communities();
  }

  processes(): Promise<{ name: string; stepCount?: number; steps?: { nodeId: string }[] }[]> {
    return this.client.processes();
  }

  deadCode(): Promise<{ total: number }> {
    return this.client.deadCode();
  }

  coupling(): Promise<{ coChanges: number }[]> {
    return this.client.coupling();
  }

  filesContaining(tokens: string[], limit?: number): Promise<Record<string, string[]>> {
    return this.client.filesContaining(tokens, limit);
  }
}
