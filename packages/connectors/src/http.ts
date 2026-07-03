/**
 * Shared HTTP transport helper for @horus/connectors.
 *
 * `fetchWithRetry` wraps global fetch with a per-attempt timeout and a bounded
 * retry loop for transient failures (429, 5xx, network errors). It NEVER throws
 * on HTTP status — non-ok Responses are returned as-is so each client keeps its
 * own `!res.ok` error-message contract.
 *
 * READ-ONLY REQUESTS ONLY: every adopting connector hits read-only endpoints
 * (ES `_search`/`_count`, Grafana GETs, Sentry GETs, Axiom's read-only `_apl`
 * POST). Never point this at a mutating endpoint (e.g. Shopify's token-exchange
 * POST) without an idempotency decision — a retry would repeat the mutation.
 *
 * Aborts (per-attempt timeout OR caller signal) are intentionally NOT retried —
 * only 429/5xx/network errors are — bounding worst-case latency at roughly one
 * `timeoutMs` per call. A flaky-but-slow endpoint that times out fails after a
 * single attempt by design; do not "fix" that ad hoc.
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 8000;
export const DEFAULT_HTTP_MAX_RETRIES = 2;
export const DEFAULT_BACKOFF_BASE_MS = 300;
export const DEFAULT_MAX_BACKOFF_MS = 5000;

export interface HttpRequestOptions {
  /** Per-attempt timeout (default 8000ms) — composed with `signal` via AbortSignal.any. */
  timeoutMs?: number;
  /** Extra attempts after the first (default 2 -> up to 3 attempts total). */
  maxRetries?: number;
  /** Exponential backoff base: delay = backoffBaseMs * 2^attempt (default 300ms). */
  backoffBaseMs?: number;
  /** Upper clamp on any single backoff delay, incl. Retry-After (default 5000ms). */
  maxBackoffMs?: number;
  /** Caller abort signal (e.g. the engine's metrics budget) — aborts are never retried. */
  signal?: AbortSignal;
  /** Injectable for tests — the default is setTimeout-based with an unref'd timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * setTimeout-based sleep whose timer is unref'd (never keeps the process alive)
 * and which resolves early when `signal` aborts, so a caller abort mid-backoff
 * is noticed promptly (the retry loop rethrows the abort reason right after).
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Delay before retrying a 429/5xx: the `Retry-After` header when it is a plain
 * number of seconds (HTTP-date values fall through), else exponential backoff.
 * Always clamped into [0, maxBackoffMs].
 */
function retryDelayMs(res: Response, attempt: number, baseMs: number, capMs: number): number {
  const header = res.headers.get('retry-after');
  const secs = header !== null ? Number(header) : NaN;
  const ms = Number.isFinite(secs) ? secs * 1000 : baseMs * 2 ** attempt;
  return Math.min(Math.max(0, ms), capMs);
}

/**
 * fetch with a per-attempt timeout and bounded retries for 429/5xx/network
 * errors. Returns the Response for every completed request — even non-ok ones
 * (after exhausting retries on a retryable status, the LAST Response is
 * returned so the caller formats its own error). Rethrows aborts immediately
 * and rethrows the last network error unchanged once retries are exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, 'signal'> = {},
  opts: HttpRequestOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_HTTP_MAX_RETRIES;
  const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Fresh per-attempt timeout, composed with the caller signal when present.
    const composed = opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: composed });
    } catch (err) {
      // Abort (timeout or caller) — never retried. Callers may abort with a
      // custom reason (the engine uses `new Error('metrics timeout')`), so
      // detection must be `composed.aborted`, never error-name sniffing.
      if (composed.aborted) throw err;
      // Network error — retry with exponential backoff while attempts remain.
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(Math.max(0, backoffBaseMs * 2 ** attempt), maxBackoffMs);
      await sleep(delay, opts.signal);
      opts.signal?.throwIfAborted();
      continue;
    }

    // Every non-retryable status (2xx, 3xx, other 4xx) is the caller's to handle.
    if (res.status !== 429 && res.status < 500) return res;
    // Retryable status with attempts exhausted — return it for the caller to format.
    if (attempt >= maxRetries) return res;

    // Drain the retried body so undici keep-alive sockets don't stall.
    res.body?.cancel().catch(() => {});
    await sleep(retryDelayMs(res, attempt, backoffBaseMs, maxBackoffMs), opts.signal);
    opts.signal?.throwIfAborted();
  }

  // Unreachable: every loop iteration returns, throws, or continues to another
  // iteration; the final iteration always returns or throws.
  throw new Error(`fetchWithRetry: exhausted attempts for ${url}`);
}
