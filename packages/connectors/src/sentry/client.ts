/**
 * Read-only Sentry REST client for @horus/connectors (HOR-CONNECTORS).
 *
 * Sentry is the error-tracking source: grouped exceptions (issues) carry a title,
 * culprit (function/transaction), event count + frequency, last-seen, level, and a
 * stack trace whose top in-app frame points at `filename:function:lineno` — a direct
 * seed for the investigation engine.
 *
 * Safety: only read (GET) endpoints are used. Auth is `Authorization: Bearer <token>`.
 * Transport goes through the shared fetchWithRetry helper — every request is bounded
 * by an 8s per-attempt timeout with bounded retry on 429/5xx/network errors. The
 * client never throws past its callers — list/event helpers return partial/empty
 * results on any failure, and `health()` returns a structured `{ ok, detail }`.
 * No `@sentry/*` SDK — `fetch` only.
 */

import type { HealthStatus } from '@horus/core';
import { redactErrorMessage, redactUpstreamBody } from '@horus/core';
import { fetchWithRetry, type HttpRequestOptions } from '../http.js';

export interface SentryClientOpts {
  /** API auth token (sent as `Authorization: Bearer <authToken>`). */
  authToken: string;
  /** Sentry org slug. */
  org: string;
  /** Sentry project slug. */
  project: string;
  /** Base URL (default https://sentry.io). Configurable for self-hosted. */
  baseUrl?: string;
  /** Transport overrides (timeout / retry) forwarded to fetchWithRetry. */
  http?: HttpRequestOptions;
}

/** A grouped Sentry issue, trimmed to the fields Horus turns into evidence. */
export interface SentryIssue {
  id: string;
  /** Group title, e.g. "TypeError: Cannot read property 'x' of undefined". */
  title: string;
  /** culprit — the function/transaction where the error surfaced. */
  culprit?: string;
  /** Issue level (error / warning / fatal / …). */
  level?: string;
  /** Total event count for the group (string in the API; coerced to number). */
  count: number;
  /** Distinct users affected. */
  userCount: number;
  /** ISO timestamp of the most-recent event. */
  lastSeen?: string;
  /** ISO timestamp of the first event. */
  firstSeen?: string;
  /** Permalink to the issue in Sentry. */
  permalink?: string;
}

/** The top in-app stack frame of an issue's latest event — a direct code seed. */
export interface SentryTopFrame {
  /** Source file, e.g. "src/services/brand.ts". */
  filename?: string;
  /** Function/symbol name at the raise site. */
  function?: string;
  /** 1-based line number. */
  lineno?: number;
}

export class SentryClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly org: string;
  private readonly project: string;
  private readonly http: HttpRequestOptions;

  constructor(opts: SentryClientOpts) {
    this.baseUrl = (opts.baseUrl ?? 'https://sentry.io').replace(/\/$/, '');
    this.authToken = opts.authToken;
    this.org = opts.org;
    this.project = opts.project;
    this.http = opts.http ?? {};
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          'Content-Type': 'application/json',
        },
      },
      this.http,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Sentry GET ${path} -> ${res.status}: ${redactUpstreamBody(text)}`);
    }
    return res.json();
  }

  /**
   * Build the project-issues query path. The time window is expressed as either a
   * `statsPeriod` (e.g. "24h", "14d") or an explicit `start`/`end` ISO pair; when both
   * are given the explicit range wins (matching Sentry's own precedence).
   */
  issuesPath(
    opts: {
      query?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      limit?: number;
    } = {},
  ): string {
    const params = new URLSearchParams();
    params.set('query', opts.query ?? 'is:unresolved');
    if (opts.start !== undefined && opts.end !== undefined) {
      params.set('start', opts.start);
      params.set('end', opts.end);
    } else if (opts.statsPeriod !== undefined) {
      params.set('statsPeriod', opts.statsPeriod);
    }
    params.set('limit', String(Math.max(1, Math.min(opts.limit ?? 25, 100))));
    return `/api/0/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(
      this.project,
    )}/issues/?${params.toString()}`;
  }

  /**
   * List recent issues for the configured org/project. Transport/auth failures
   * PROPAGATE so the engine can distinguish "Sentry is down/misconfigured" from
   * "no issues matched" — swallowing them here made an auth outage read as
   * negative evidence. Callers that need degrade-to-[] wrap this themselves
   * (provider.queryEvidence, watch's poll loop).
   */
  async listIssues(
    opts: {
      query?: string;
      statsPeriod?: string;
      start?: string;
      end?: string;
      limit?: number;
    } = {},
  ): Promise<SentryIssue[]> {
    const raw = await this.request(this.issuesPath(opts));
    if (!Array.isArray(raw)) return [];
    return (raw as Array<Record<string, unknown>>).map(parseIssue);
  }

  /**
   * Fetch an issue's latest event and extract the top **in-app** stack frame
   * (`filename`, `function`, `lineno`) — the direct raise-site seed. Returns null
   * when the event/frame can't be resolved (never throws past here).
   */
  async latestEventTopFrame(issueId: string): Promise<SentryTopFrame | null> {
    try {
      const raw = await this.request(
        `/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`,
      );
      return extractTopInAppFrame(raw);
    } catch {
      return null;
    }
  }

  /**
   * Cheap reachability probe: hit the project issues endpoint with limit=1.
   * Returns a structured status; never throws.
   */
  async health(): Promise<HealthStatus> {
    try {
      await this.request(this.issuesPath({ limit: 1 }));
      return { ok: true, detail: `sentry reachable (${this.org}/${this.project})` };
    } catch (err) {
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }
}

/** Coerce Sentry's issue JSON (counts come back as strings) into a SentryIssue. */
export function parseIssue(raw: Record<string, unknown>): SentryIssue {
  const issue: SentryIssue = {
    id: String(raw['id'] ?? ''),
    title: typeof raw['title'] === 'string' ? raw['title'] : '(untitled)',
    count: toNumber(raw['count']),
    userCount: toNumber(raw['userCount']),
  };
  if (typeof raw['culprit'] === 'string') issue.culprit = raw['culprit'];
  if (typeof raw['level'] === 'string') issue.level = raw['level'];
  if (typeof raw['lastSeen'] === 'string') issue.lastSeen = raw['lastSeen'];
  if (typeof raw['firstSeen'] === 'string') issue.firstSeen = raw['firstSeen'];
  if (typeof raw['permalink'] === 'string') issue.permalink = raw['permalink'];
  return issue;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Walk a Sentry event payload and return the top **in-app** stack frame.
 *
 * Sentry event shapes vary: frames live under an `exception` entry (newest API) or a
 * `stacktrace` entry (older), each carrying a `frames` array ordered oldest→newest
 * (the crashing frame is LAST). We prefer the last frame with `in_app === true`;
 * failing that, the last frame of the first trace; failing that, null. Pure + exported
 * for unit testing against captured event JSON.
 */
export function extractTopInAppFrame(event: unknown): SentryTopFrame | null {
  if (event === null || event === undefined || typeof event !== 'object') return null;
  const ev = event as Record<string, unknown>;

  const frameLists = collectFrameLists(ev);
  for (const frames of frameLists) {
    // Frames are oldest→newest; the raise site is the last in-app frame.
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (f !== undefined && f['in_app'] === true) {
        return toFrame(f);
      }
    }
  }
  // No in-app frame found — fall back to the very last frame of the first trace, if any.
  const firstList = frameLists[0];
  if (firstList !== undefined && firstList.length > 0) {
    const last = firstList[firstList.length - 1];
    if (last !== undefined) return toFrame(last);
  }
  return null;
}

/** Gather every `frames[]` array reachable from an event's entries / exception / stacktrace. */
function collectFrameLists(ev: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  const out: Array<Array<Record<string, unknown>>> = [];

  const pushFromStacktrace = (node: unknown): void => {
    const st = node as Record<string, unknown> | undefined;
    const frames = st?.['frames'];
    if (Array.isArray(frames)) out.push(frames as Array<Record<string, unknown>>);
  };

  const pushFromExceptionValues = (node: unknown): void => {
    const exc = node as Record<string, unknown> | undefined;
    const values = exc?.['values'];
    if (Array.isArray(values)) {
      for (const v of values as Array<Record<string, unknown>>) {
        pushFromStacktrace(v['stacktrace']);
      }
    }
  };

  // 1. Top-level `entries: [{ type: 'exception'|'stacktrace', data: {...} }]` (events/latest/ shape).
  const entries = ev['entries'];
  if (Array.isArray(entries)) {
    for (const entry of entries as Array<Record<string, unknown>>) {
      const type = entry['type'];
      const data = entry['data'];
      if (type === 'exception') pushFromExceptionValues(data);
      else if (type === 'stacktrace') pushFromStacktrace(data);
    }
  }

  // 2. Top-level `exception: { values: [...] }` and `stacktrace: { frames: [...] }` (SDK/store shape).
  pushFromExceptionValues(ev['exception']);
  pushFromStacktrace(ev['stacktrace']);

  return out;
}

function toFrame(f: Record<string, unknown>): SentryTopFrame {
  const frame: SentryTopFrame = {};
  const filename =
    typeof f['filename'] === 'string'
      ? f['filename']
      : typeof f['absPath'] === 'string'
        ? f['absPath']
        : typeof f['abs_path'] === 'string'
          ? f['abs_path']
          : undefined;
  if (filename !== undefined) frame.filename = filename;
  if (typeof f['function'] === 'string') frame.function = f['function'];
  if (typeof f['lineNo'] === 'number') frame.lineno = f['lineNo'];
  else if (typeof f['lineno'] === 'number') frame.lineno = f['lineno'];
  return frame;
}
