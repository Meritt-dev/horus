/**
 * Shopify Admin evidence provider (HOR-CONNECTORS).
 *
 * Shopify admin/business data (orders, inventory, fulfillment, …) is application state, so
 * each configured/supplied query becomes one `kind: 'state'` Evidence (or `'log'`/`'metric'`
 * when the query declares it) that folds into the engine's existing state-evidence machinery.
 *
 * The provider embeds NO queries. `collect()` runs the GraphQL documents it is HANDED — from
 * the caller at investigation time (`--shopify-query`) or, when none are supplied, the
 * config-declared defaults (`connectors.shopify.queries[]`, used by `horus watch`). One
 * Evidence is synthesized per query result; the returned `data` rides on the payload and the
 * query name + a short result summary form the title.
 *
 * Privacy: the title is redacted. priority / category / subject are NOT set here — the
 * normalization layer stamps those.
 */

import type { Evidence, HealthStatus, ProviderKind, ShopifyQuerySpec } from '@horus/core';
import { redactSecrets } from '@horus/core';
import type { Provider } from '../contract.js';
import { ShopifyAdminClient } from './client.js';

export interface ShopifyProviderOpts {
  /** Store domain — used for evidence provenance + title. */
  store: string;
  /** Default queries run when the caller supplies none (e.g. `horus watch`). */
  queries?: ShopifyQuerySpec[];
}

/** The result of running one Shopify query, before it becomes Evidence. */
export interface ShopifyRecord {
  /** Query label (provenance + title). */
  name: string;
  /** EvidenceKind the result maps onto. */
  kind: 'state' | 'log' | 'metric';
  /** The GraphQL `data` payload, verbatim. */
  data: unknown;
  /** Base relevance seed from config, before hint-term weighting. */
  relevance?: number;
  /** GraphQL-level errors, when the query returned any. */
  errors?: Array<{ message: string }>;
  /** The `extensions.cost` block, for rate-budget visibility. */
  cost?: unknown;
  /** Collection timestamp (window end). */
  timestamp?: string;
}

/** Map a per-query EvidenceKind onto the ProviderKind (`source`) it belongs to. */
const KIND_TO_SOURCE: Record<ShopifyRecord['kind'], ProviderKind> = {
  state: 'state',
  log: 'logs',
  metric: 'metrics',
};

export class ShopifyProvider implements Provider {
  readonly id = 'shopify';
  readonly kind: ProviderKind = 'state';

  constructor(
    private readonly client: ShopifyAdminClient,
    private readonly opts: ShopifyProviderOpts,
  ) {}

  /**
   * Run each supplied (or, as a fallback, config-declared) query verbatim and return one
   * record per success. The investigation window is injected as `$from`/`$to` variables for
   * queries that opt in (`bindWindow`); `hintTerms` are NOT used to rewrite the query — only
   * to weight relevance later. A single failing query is dropped (one bad document never
   * aborts the investigation), but when EVERY query fails the first error is rethrown —
   * a total outage (revoked token, dead shop) must reach the engine as a failure, not as
   * an empty result set.
   */
  async collect(
    opts: {
      from?: string;
      to?: string;
      hintTerms?: string[];
      queries?: ShopifyQuerySpec[];
    } = {},
  ): Promise<ShopifyRecord[]> {
    const specs =
      opts.queries !== undefined && opts.queries.length > 0
        ? opts.queries
        : (this.opts.queries ?? []);
    if (specs.length === 0) return [];

    const to = opts.to ?? new Date().toISOString();
    const from = opts.from;

    let firstError: unknown;
    const records = await Promise.all(
      specs.map(async (q): Promise<ShopifyRecord | null> => {
        try {
          const result = await this.client.graphql(q.query, bindWindowVars(q, from, to));
          const rec: ShopifyRecord = { name: q.name, kind: q.kind, data: result.data, timestamp: to };
          if (q.relevance !== undefined) rec.relevance = q.relevance;
          if (result.errors !== undefined && result.errors.length > 0) {
            // GraphQL error text is upstream-controlled and lands in the evidence payload.
            rec.errors = result.errors.map((e) => ({ message: redactSecrets(e.message) }));
          }
          if (result.extensions?.cost !== undefined) rec.cost = result.extensions.cost;
          return rec;
        } catch (err) {
          firstError ??= err;
          return null;
        }
      }),
    );
    const ok = records.filter((r): r is ShopifyRecord => r !== null);
    if (ok.length === 0 && firstError !== undefined) throw firstError;
    return ok;
  }

  /** Synthesize one Evidence per record. Preserves per-query provenance. */
  toEvidence(records: ShopifyRecord[], hintTerms: string[], collectedAt: string): Evidence[] {
    return records.map((rec, i) => this.recordToEvidence(rec, hintTerms, collectedAt, i));
  }

  /**
   * One-shot evidence query: collect + convert. Degrades to [] on any failure so a flaky
   * Shopify never aborts an investigation.
   */
  async queryEvidence(
    opts: {
      from?: string;
      to?: string;
      hintTerms?: string[];
      collectedAt?: string;
      queries?: ShopifyQuerySpec[];
    } = {},
  ): Promise<Evidence[]> {
    try {
      const hintTerms = opts.hintTerms ?? [];
      const records = await this.collect({
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        ...(opts.queries !== undefined ? { queries: opts.queries } : {}),
        hintTerms,
      });
      return this.toEvidence(records, hintTerms, opts.collectedAt ?? new Date().toISOString());
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  private recordToEvidence(
    rec: ShopifyRecord,
    hintTerms: string[],
    collectedAt: string,
    index: number,
  ): Evidence {
    const payload: Record<string, unknown> = {
      source: 'shopify',
      shop: this.opts.store,
      queryName: rec.name,
      data: rec.data,
    };
    if (rec.cost !== undefined) payload['cost'] = rec.cost;
    if (rec.errors !== undefined) payload['errors'] = rec.errors;

    const ev: Evidence = {
      id: `ev_shopify_${index}`,
      source: KIND_TO_SOURCE[rec.kind],
      kind: rec.kind,
      title: buildTitle(rec, this.opts.store),
      relevance: computeRelevance(rec, hintTerms),
      payload,
      links: {},
      provenance: { query: `shopify ${this.opts.store} ${rec.name}`, collectedAt },
    };
    if (rec.timestamp !== undefined) ev.timestamp = rec.timestamp;
    return ev;
  }
}

/** Merge static query variables with the injected `$from`/`$to` window (opt-in per query). */
function bindWindowVars(
  q: ShopifyQuerySpec,
  from: string | undefined,
  to: string | undefined,
): Record<string, unknown> {
  const base = q.variables ?? {};
  if (q.bindWindow !== true) return { ...base };
  const window: Record<string, unknown> = {};
  if (from !== undefined) window['from'] = from;
  if (to !== undefined) window['to'] = to;
  return { ...base, ...window };
}

/**
 * Build the human one-line title: store, query name, a short result summary (edge/node
 * count or the first GraphQL error), and a short timestamp. Redacted. Pure + exported for
 * unit testing.
 */
export function buildTitle(rec: ShopifyRecord, store: string): string {
  const ts = rec.timestamp ? ` · ${shortTs(rec.timestamp)}` : '';
  return redactSecrets(`Shopify ${store} ${rec.name}: ${summarize(rec)}${ts}`).slice(0, 220);
}

/** One-line summary of a query result: "N results", the first error, or "ok". */
function summarize(rec: ShopifyRecord): string {
  if (rec.errors !== undefined && rec.errors.length > 0) return `error: ${rec.errors[0]!.message}`;
  const count = countResults(rec.data);
  if (count !== null) return `${count} result${count === 1 ? '' : 's'}`;
  return 'ok';
}

/** Sum the sizes of any top-level GraphQL connections (`edges`/`nodes`), or null if none. */
function countResults(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null;
  let total = 0;
  let found = false;
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      const conn = value as Record<string, unknown>;
      if (Array.isArray(conn['edges'])) {
        total += conn['edges'].length;
        found = true;
      } else if (Array.isArray(conn['nodes'])) {
        total += conn['nodes'].length;
        found = true;
      }
    }
  }
  return found ? total : null;
}

/**
 * Relevance-weight a record: the config seed (default 0.6) plus a bump when a hint term
 * appears anywhere in the result. Clamped 0.5–0.95. Pure + exported for unit testing.
 */
export function computeRelevance(rec: ShopifyRecord, hintTerms: string[]): number {
  let score = rec.relevance ?? 0.6;
  const hay = JSON.stringify(rec.data ?? {}).toLowerCase();
  const domainTerms = hintTerms.filter((t) => t.length > 2);
  if (domainTerms.some((t) => hay.includes(t.toLowerCase()))) score += 0.2;
  return Math.min(0.95, Math.max(0.5, score));
}

/** Short, human "MM-DD HH:MM" form of an ISO timestamp (empty-safe). */
function shortTs(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
