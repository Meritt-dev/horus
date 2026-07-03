/**
 * @horus/connectors — provider contracts + implementations.
 *
 * HOR-3 defines the `Provider` / `CodeProvider` contracts and `ConnectorFactory`,
 * plus the source-intelligence provider (HTTP/MCP transport only — no CLI shell-outs
 * for queries). HOR-5 adds the runtime providers (ES, Prometheus, Redis, BullMQ, Git).
 * See architecture.md §2.2.
 */

export * from './source/index.js';
export * from './contract.js';
export * from './duration.js';
export * from './factory.js';
// Shared HTTP transport: explicit re-export — `HttpRequestOptions` is part of the
// public `*ClientOpts` surface (the `http?:` field on ES/Grafana/Sentry/Axiom opts).
export { fetchWithRetry, DEFAULT_HTTP_TIMEOUT_MS } from './http.js';
export type { HttpRequestOptions } from './http.js';
export * from './source/provider.js';
export * from './compat.js';
export * from './git/index.js';
export * from './elasticsearch/index.js';
export * from './grafana/index.js';
export * from './state/index.js';
export * from './mongodb/index.js';
export * from './postgres/index.js';
export * from './sentry/index.js';
// Axiom: explicit re-export of the public surface — the pure helpers `buildTitle`
// and `computeRelevance` are intentionally NOT re-exported here to avoid a barrel
// name-clash with Sentry's same-named helpers (both are tested via their local
// `./axiom/index.js` / `./sentry/index.js` barrels).
export {
  AxiomClient,
  AxiomProvider,
  buildApl,
  parseTabular,
  parseDataset,
} from './axiom/index.js';
export type {
  AxiomClientOpts,
  AxiomDataset,
  AxiomLogRecord,
  AxiomProviderOpts,
} from './axiom/index.js';
export * from './bullmq/index.js';
export * from './redis/index.js';
// Shopify: explicit re-export of the public surface — the pure helpers `buildTitle` and
// `computeRelevance` are intentionally NOT re-exported here to avoid a barrel name-clash
// with Sentry/Axiom's same-named helpers (all are tested via their local barrels).
export {
  ShopifyAdminClient,
  ShopifyProvider,
  normalizeStore,
  normalizeApiVersion,
  isThrottled,
} from './shopify/index.js';
export type {
  ShopifyClientOpts,
  ShopifyGraphQLResult,
  ShopifyThrottleStatus,
  ShopifyCost,
  ShopifyProviderOpts,
  ShopifyRecord,
} from './shopify/index.js';
