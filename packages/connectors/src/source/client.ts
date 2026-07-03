import type {
  SourceCommunitiesResult,
  SourceContentHit,
  SourceCouplingResult,
  SourceCypherResult,
  SourceDeadCodeResult,
  SourceFilesContainingResult,
  SourceDiffResult,
  SourceExactSymbol,
  SourceFlowsResult,
  SourceHealth,
  SourceHostInfo,
  SourceImpactResult,
  SourceLabelSymbol,
  SourceMemorySearchHit,
  SourceMemorySearchRequest,
  SourceMemorySearchResult,
  SourceMemoryUpsertRequest,
  SourceNode,
  SourceNodeDetail,
  SourceNodeLine,
  SourceOverview,
  SourceProcessesResult,
  SourceSearchResult,
} from './types.js';

/**
 * Encode a graph node id for use as a URL PATH segment (HOR-445). `encodeURI` is intentionally used
 * to keep `/` and `:` literal (the backend's node ids are path-shaped, e.g.
 * `method:source/foo.ts:Bar.baz`), but it leaves `#` and `?` UNescaped — and a `#private` method id
 * (`Bar.#baz`) would otherwise truncate the URL at the fragment, hitting the wrong route (404). Escape
 * exactly those two structural delimiters; the backend percent-decodes them back to the real id.
 */
export function encodeNodePath(nodeId: string): string {
  return encodeURI(nodeId).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

export class SourceHttpError extends Error {
  public status: number;
  public body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'SourceHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface SourceClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class SourceHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: SourceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {};
    let bodyStr: string | undefined;

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await fetch(url, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });

        if (res.status >= 500) {
          const text = await res.text();
          if (attempt < this.maxRetries) {
            await this.sleep(150 * 2 ** attempt);
            continue;
          }
          throw new SourceHttpError(
            `Source request failed: ${method} ${path} -> HTTP ${res.status}`,
            res.status,
            text,
          );
        }

        if (!res.ok) {
          // 4xx — never retry
          const text = await res.text();
          throw new SourceHttpError(
            `Source request failed: ${method} ${path} -> HTTP ${res.status}`,
            res.status,
            text,
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof SourceHttpError) {
          throw err;
        }
        // Distinguish AbortError (timeout/cancel) from network errors
        if (err instanceof Error && err.name === 'AbortError') {
          throw err;
        }
        // Network error — retry if attempts remain
        if (attempt < this.maxRetries) {
          await this.sleep(150 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable — TypeScript needs a return here
    throw new Error('Unexpected end of retry loop');
  }

  async version(): Promise<string | null> {
    const url = `${this.baseUrl}/openapi.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { info?: { version?: string } };
      return data.info?.version ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<SourceHealth> {
    const url = `${this.baseUrl}/api/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  hostInfo(): Promise<SourceHostInfo> {
    return this.request<SourceHostInfo>('GET', '/api/host');
  }

  overview(): Promise<SourceOverview> {
    return this.request<SourceOverview>('GET', '/api/overview');
  }

  cypher(query: string): Promise<SourceCypherResult> {
    return this.request<SourceCypherResult>('POST', '/api/cypher', { query });
  }

  async search(query: string, limit = 20): Promise<SourceSearchResult[]> {
    const res = await this.request<{ results: SourceSearchResult[] }>('POST', '/api/search', {
      query,
      limit,
    });
    return res.results;
  }

  /** Blast radius. Product-only by default; `includeTests` restores test/docs/example callers. */
  impact(nodeId: string, depth = 3, opts?: { includeTests?: boolean }): Promise<SourceImpactResult> {
    const includeTests = opts?.includeTests ? '&include_tests=true' : '';
    return this.request<SourceImpactResult>(
      'GET',
      `/api/impact/${encodeNodePath(nodeId)}?depth=${depth}${includeTests}`,
    );
  }

  diff(base: string, compare: string): Promise<SourceDiffResult> {
    return this.request<SourceDiffResult>('POST', '/api/diff', { base, compare });
  }

  async nodeCount(): Promise<number> {
    const o = await this.overview();
    return Number(o.totalNodes) || 0;
  }

  // -------------------------------------------------------------------------
  // Typed read-path endpoints (HOR-392). These replace the CLI's raw Cypher:
  // the host owns the queries and returns shaped JSON, so the client never
  // emits or escapes Cypher on the read path.
  // -------------------------------------------------------------------------

  /** Nodes whose full content contains ANY of `tokens` — full (untruncated) content. */
  async contentSearch(tokens: string[], limit = 500): Promise<SourceContentHit[]> {
    const res = await this.request<{ results: SourceContentHit[] }>('POST', '/api/content-search', {
      tokens,
      limit,
    });
    return res.results ?? [];
  }

  /** Exact-name symbol lookup (file label excluded), with line ranges. */
  async exactSymbols(name: string, limit = 10): Promise<SourceExactSymbol[]> {
    const res = await this.request<{ results: SourceExactSymbol[] }>(
      'GET',
      `/api/symbols/exact?name=${encodeURIComponent(name)}&limit=${limit}`,
    );
    return res.results ?? [];
  }

  /** Symbol nodes for the given comma-joinable lowercase labels (source-graph extraction). */
  async symbolsByLabel(labels: string[], limit = 1000): Promise<SourceLabelSymbol[]> {
    const res = await this.request<{ symbols: SourceLabelSymbol[] }>(
      'GET',
      `/api/symbols?labels=${encodeURIComponent(labels.join(','))}&limit=${limit}`,
    );
    return res.symbols ?? [];
  }

  /** Batch-resolve node ids to their line ranges (CLI line hydration). */
  async nodesLines(ids: string[]): Promise<Record<string, SourceNodeLine>> {
    const res = await this.request<{ lines: Record<string, SourceNodeLine> }>(
      'POST',
      '/api/nodes/lines',
      { ids },
    );
    return res.lines ?? {};
  }

  /** Process flows a symbol participates in, with each flow's named ordered steps.
   *  Product-only by default; `includeTests` restores steps living in test files. */
  flows(nodeId: string, opts?: { includeTests?: boolean }): Promise<SourceFlowsResult> {
    const includeTests = opts?.includeTests ? '?include_tests=true' : '';
    return this.request<SourceFlowsResult>('GET', `/api/flows/${encodeNodePath(nodeId)}${includeTests}`);
  }

  /** Method symbols of `className` defined in `file`, ordered by start line. */
  async classMethods(file: string, className: string): Promise<SourceNode[]> {
    const res = await this.request<{ methods: SourceNode[] }>(
      'GET',
      `/api/class-methods?file=${encodeURIComponent(file)}&class=${encodeURIComponent(className)}`,
    );
    return res.methods ?? [];
  }

  /** Extended node detail — node + content + callers/callees/typeRefs + imports + coupling + communities. */
  node(nodeId: string): Promise<SourceNodeDetail> {
    return this.request<SourceNodeDetail>('GET', `/api/node/${encodeNodePath(nodeId)}`);
  }

  /** Community clusters with their member nodes (source-graph extraction). */
  async communities(): Promise<SourceCommunitiesResult['communities']> {
    const res = await this.request<SourceCommunitiesResult>('GET', '/api/communities');
    return res.communities ?? [];
  }

  /** Discovered execution processes with their ordered steps (source-graph extraction). */
  async processes(): Promise<SourceProcessesResult['processes']> {
    const res = await this.request<SourceProcessesResult>('GET', '/api/processes');
    return res.processes ?? [];
  }

  /** Dead-code report — total count + symbols grouped by file. */
  deadCode(): Promise<SourceDeadCodeResult> {
    return this.request<SourceDeadCodeResult>('GET', '/api/dead-code');
  }

  /** Temporal (co-change) coupling pairs between files. */
  async coupling(): Promise<SourceCouplingResult['pairs']> {
    const res = await this.request<SourceCouplingResult>('GET', '/api/coupling');
    return res.pairs ?? [];
  }

  /**
   * Per-token distinct FILE paths whose content contains the token (external-system
   * detection). `limit` is a PER-TOKEN budget so a common token can't crowd out rare ones.
   */
  async filesContaining(tokens: string[], limit = 500): Promise<Record<string, string[]>> {
    const res = await this.request<SourceFilesContainingResult>('POST', '/api/content-search', {
      tokens,
      limit,
      filesOnly: true,
    });
    return res.matches ?? {};
  }

  // -------------------------------------------------------------------------
  // Memory vector bridge (M2). These reuse `request<T>` (retry/timeout/4xx) so
  // a host-down / 404 / 503 surfaces as a throw the caller treats as best-effort.
  // The host is the sole RW owner of the isolated `.horus/source/memory` dir;
  // upsert is accepted async (202) and never blocks memory add.
  // -------------------------------------------------------------------------

  /** Index (or re-index) a single claim. Host returns 202/{ok} when accepted. */
  async memoryUpsert(body: SourceMemoryUpsertRequest): Promise<void> {
    await this.request<{ ok?: boolean }>('POST', '/api/memory/upsert', body);
  }

  /** Vector-search claims in a repo. Returns the (possibly empty) hit list. */
  async memorySearch(body: SourceMemorySearchRequest): Promise<SourceMemorySearchHit[]> {
    const res = await this.request<SourceMemorySearchResult>('POST', '/api/memory/search', body);
    return res.results ?? [];
  }

  /** Drop a claim's vectors. Host returns {ok} when removed. */
  async memoryRemove(memoryId: string): Promise<void> {
    await this.request<{ ok?: boolean }>('POST', '/api/memory/remove', { memoryId });
  }
}
