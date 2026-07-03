/**
 * Read-only Shopify Admin GraphQL client for @horus/connectors.
 *
 * The Admin API is a single GraphQL endpoint. This client embeds NO queries: the caller
 * supplies the GraphQL document + variables and the client runs it verbatim against
 * `https://{store}/admin/api/{version}/graphql.json` with an `X-Shopify-Access-Token`
 * header — exactly the generic transport the maison-safqa store client uses.
 *
 * Auth is a read-only **Client-Credentials grant**: the app `client_id` (accessId) +
 * `client_secret` (secret) are exchanged for a short-lived Admin API token at
 * `/admin/oauth/access_token`, cached with an expiry margin and refreshed on 401. When no
 * `accessId` is configured the `secret` is treated as a direct Admin API token (no grant).
 *
 * Safety: every request is bounded by an 8s AbortSignal.timeout; GraphQL `THROTTLED`
 * errors and HTTP 429 are retried with bounded backoff. `graphql()` throws on a hard
 * failure (its provider degrades to []); `health()` returns a structured `{ ok, detail }`
 * and never throws. No `@shopify/*` SDK — `fetch` only.
 */

import type { HealthStatus } from '@horus/core';
import { redactErrorMessage, redactSecrets, redactUpstreamBody } from '@horus/core';

export interface ShopifyClientOpts {
  /** Store subdomain, e.g. "my-store" — `.myshopify.com` is added internally (a full domain also works). */
  store: string;
  /** Admin API version segment, e.g. "2025-10". Normalized/defaulted when omitted/invalid. */
  apiVersion?: string;
  /** App client_id for the Client-Credentials grant. When absent, `secret` is used directly. */
  accessId?: string;
  /** App client_secret (or, when `accessId` is absent, a direct Admin API access token). */
  secret: string;
  /** Base URL override (tests). Defaults to `https://{store}`. Trailing slash trimmed. */
  baseUrl?: string;
}

/** Shopify Admin GraphQL throttle status (from `extensions.cost.throttleStatus`). */
export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

/** The `extensions.cost` block Shopify returns on every GraphQL response. */
export interface ShopifyCost {
  requestedQueryCost?: number;
  actualQueryCost?: number;
  throttleStatus?: ShopifyThrottleStatus;
}

/** A parsed Admin GraphQL response — `data`, GraphQL `errors`, and the cost extension. */
export interface ShopifyGraphQLResult {
  data?: unknown;
  errors?: Array<{ message: string; [k: string]: unknown }>;
  extensions?: { cost?: ShopifyCost };
}

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_API_VERSION = '2025-10';
/** Refresh the CC token this many seconds before its stated expiry. */
const TOKEN_REFRESH_MARGIN_S = 120;
/** Bounded retries for HTTP 429 / GraphQL THROTTLED. */
const MAX_RETRIES = 2;
/** Cap a single backoff wait so a throttled store can't stall an investigation. */
const MAX_BACKOFF_MS = 5000;

/** Normalize a store to its host: strip scheme/trailing slash, append `.myshopify.com` if bare. */
export function normalizeStore(raw: string): string {
  const s = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return s.includes('.') ? s : `${s}.myshopify.com`;
}

/** Return `raw` if it is a valid `YYYY-MM` Admin API version, else the current default. */
export function normalizeApiVersion(raw?: string): string {
  const v = (raw ?? '').trim();
  return /^20\d{2}-\d{2}$/.test(v) ? v : DEFAULT_API_VERSION;
}

/** True when a GraphQL response carries a THROTTLED error (rate-limit backpressure). */
export function isThrottled(result: ShopifyGraphQLResult): boolean {
  return (result.errors ?? []).some(
    (e) => (e as { extensions?: { code?: string } }).extensions?.code === 'THROTTLED',
  );
}

export class ShopifyAdminClient {
  private readonly store: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly accessId: string | undefined;
  private readonly secret: string;

  private token: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(opts: ShopifyClientOpts) {
    this.store = normalizeStore(opts.store);
    this.apiVersion = normalizeApiVersion(opts.apiVersion);
    this.baseUrl = (opts.baseUrl ?? `https://${this.store}`).replace(/\/$/, '');
    this.accessId = opts.accessId;
    this.secret = opts.secret;
  }

  /**
   * Resolve a valid Admin API token. With an `accessId`, runs the Client-Credentials
   * grant and caches the result until (expiry - margin); without one, returns `secret`
   * as a direct token. Throws on a failed grant.
   */
  private async ensureToken(): Promise<string> {
    if (this.accessId === undefined || this.accessId === '') return this.secret;
    if (this.token !== null && Date.now() < this.tokenExpiresAtMs) return this.token;

    // Form-encoded body — matches Shopify's OAuth token endpoint (and the maison-safqa
    // reference). Shopify rejects a JSON body on this endpoint for some app configs.
    const res = await fetch(`${this.baseUrl}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.accessId,
        client_secret: this.secret,
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Redact + cap: this body is the OAuth endpoint's response to a request
      // carrying client_id + client_secret — it can echo them back.
      throw new Error(`Shopify token exchange -> ${res.status}: ${redactUpstreamBody(text)}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Shopify token exchange returned no access_token');
    }
    this.token = json.access_token;
    const ttl = typeof json.expires_in === 'number' ? json.expires_in : 86_400;
    this.tokenExpiresAtMs = Date.now() + Math.max(0, ttl - TOKEN_REFRESH_MARGIN_S) * 1000;
    return this.token;
  }

  /** Drop any cached token so the next request re-runs the grant (used after a 401). */
  private invalidateToken(): void {
    this.token = null;
    this.tokenExpiresAtMs = 0;
  }

  /**
   * Run a GraphQL document verbatim against the Admin API and return the parsed result.
   * Retries HTTP 429 / GraphQL THROTTLED with bounded backoff; refreshes the token once
   * on 401. Throws on a non-retryable HTTP error.
   */
  async graphql(query: string, variables?: Record<string, unknown>): Promise<ShopifyGraphQLResult> {
    const url = `${this.baseUrl}/admin/api/${this.apiVersion}/graphql.json`;
    let httpRetries = 0;
    let throttleRetries = 0;
    let refreshedOn401 = false;

    for (;;) {
      const token = await this.ensureToken();
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        this.invalidateToken();
        continue;
      }
      if (res.status === 429 && httpRetries < MAX_RETRIES) {
        httpRetries += 1;
        await sleep(retryAfterMs(res, httpRetries));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Shopify GraphQL -> ${res.status}: ${redactUpstreamBody(text)}`);
      }

      const result = (await res.json()) as ShopifyGraphQLResult;
      if (isThrottled(result) && throttleRetries < MAX_RETRIES) {
        throttleRetries += 1;
        await sleep(throttleBackoffMs(result, throttleRetries));
        continue;
      }
      return result;
    }
  }

  /**
   * Liveness probe: run a minimal `{ shop { name } }` query — the connector's ONLY owned
   * query, used purely for health / connect-time validation, NEVER for evidence. It
   * validates both the auth (the CC grant or the static token, resolved inside `graphql`)
   * AND that the token can actually read — so a bad/expired static token is caught here
   * rather than silently reported as "reachable". Never throws.
   */
  async health(): Promise<HealthStatus> {
    try {
      const result = await this.graphql('{ shop { name } }');
      if (result.errors !== undefined && result.errors.length > 0) {
        // GraphQL error text is upstream-controlled — redact before display.
        return { ok: false, detail: redactSecrets(result.errors[0]!.message) };
      }
      return { ok: true, detail: `shopify reachable (${this.store})` };
    } catch (err) {
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }
}

/** Milliseconds to wait after a 429, from the `Retry-After` header (seconds) or a backoff. */
function retryAfterMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  const secs = header !== null ? Number(header) : NaN;
  const ms = Number.isFinite(secs) ? secs * 1000 : 500 * 2 ** (attempt - 1);
  return Math.min(Math.max(0, ms), MAX_BACKOFF_MS);
}

/**
 * Milliseconds to wait after a GraphQL THROTTLED, derived from how long the leaky bucket
 * needs to restore the requested cost (`requestedQueryCost / restoreRate`), else a backoff.
 */
function throttleBackoffMs(result: ShopifyGraphQLResult, attempt: number): number {
  const cost = result.extensions?.cost;
  const requested = cost?.requestedQueryCost ?? 0;
  const rate = cost?.throttleStatus?.restoreRate ?? 0;
  const ms = requested > 0 && rate > 0 ? (requested / rate) * 1000 : 500 * 2 ** (attempt - 1);
  return Math.min(Math.max(0, ms), MAX_BACKOFF_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
