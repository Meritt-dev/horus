/**
 * Read-only Lens (Horus Cloud) client for @horus/connectors (HOR-CONNECTORS / HOR-470).
 *
 * Lens is Horus's issue-capture product: users file bug reports from the running app.
 * Each report carries a comment, frontend error stacks, console/network tails, the
 * capture env (url/route/browser), app context (release/gitSha/featureFlags), and the
 * target element (domPath + reactComponents). Reports live in Horus Cloud and are read
 * through the workspace-scoped management API (`/v1/workspaces/:workspaceId/lens/...`).
 *
 * NATIVE CONNECTOR (HOR-470): there is no `horus connect lens` and no config stanza —
 * this client is constructed straight from the CLI's cloud auth state (bearer token +
 * apiBaseUrl) and the repo's cloud-linked `workspace.id`. See `lensForCloud`.
 *
 * Safety: only read (GET) endpoints are used. Auth is `Authorization: Bearer <token>`.
 * Transport goes through the shared fetchWithRetry helper — every request is bounded by
 * a per-attempt timeout with bounded retry on 429/5xx/network errors. `listSites` /
 * `listReports` / `getReport` PROPAGATE non-2xx + transport failures so the engine can
 * tell "Lens is down/misconfigured" from "no reports matched"; `health()` returns a
 * structured `{ ok, detail }` and never throws. No SDK — `fetch` only.
 */

import type { HealthStatus } from '@horus/core';
import { redactErrorMessage, redactUpstreamBody } from '@horus/core';
import { fetchWithRetry, type HttpRequestOptions } from '../http.js';

export interface LensClientOpts {
  /** Horus Cloud API base URL (from the CLI auth state's `apiBaseUrl`). */
  apiBaseUrl: string;
  /** Cloud bearer token (from the CLI auth state's `token`). */
  token: string;
  /** The cloud-linked workspace id (from `<repo>/.horus/cloud.json`'s `workspace.id`). */
  workspaceId: string;
  /** Transport overrides (timeout / retry) forwarded to fetchWithRetry. */
  http?: HttpRequestOptions;
}

/** A Lens site the workspace owns — the discovery unit reports hang off. */
export interface LensSite {
  id: string;
  name: string;
}

/** A condensed report row from the list endpoint (no heavy metadata). */
export interface LensReportSummary {
  id: string;
  lensSiteId: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  externalIssue: unknown | null;
  lensIssueId: string | null;
  issueOccurrenceCount: number | null;
  comment?: string;
  url?: string;
  errorCount: number;
  hasReplay: boolean;
}

/** One frontend error captured on a report. */
export interface LensErrorEntry {
  message: string;
  stack?: string;
  source: string;
  timestamp: number;
}

/** One network request captured in the report's network tail. */
export interface LensNetworkEntry {
  method: string;
  url: string;
  status: number | null;
  ok: boolean | null;
  durationMs: number | null;
  requestType: string;
  startedAt: number;
  error?: string;
}

/** The target element the user was pointing at when they filed the report. */
export interface LensTargetElement {
  domPath?: string;
  tagName?: string;
  text?: string;
  reactComponents?: string[];
}

/** The capture environment (page URL / route / browser). */
export interface LensEnvContext {
  url: string;
  route?: string;
  userAgent?: string;
  browser?: string;
  os?: string;
}

/** App-level context the SDK attached (release / gitSha / flags). */
export interface LensAppContext {
  release?: string;
  gitSha?: string;
  environment?: string;
  featureFlags?: Record<string, string | number | boolean>;
  /** Present in the wire shape but NEVER read — PII (email/name) must not leak into evidence. */
  user?: unknown;
}

/** The report metadata blob (everything except heavy S3 assets). */
export interface LensReportMetadata {
  comment?: string;
  target?: LensTargetElement;
  env?: LensEnvContext;
  app?: LensAppContext;
  errors: LensErrorEntry[];
  networkTail: LensNetworkEntry[];
  trigger?: string;
}

/** A full Lens report (from the single-report read). */
export interface LensReport {
  id: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  metadata: LensReportMetadata | null;
}

export class LensCloudClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly workspaceId: string;
  private readonly http: HttpRequestOptions;

  constructor(opts: LensClientOpts) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.workspaceId = opts.workspaceId;
    this.http = opts.http ?? {};
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.apiBaseUrl}${path}`;
    const res = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      },
      this.http,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Lens GET ${path} -> ${res.status}: ${redactUpstreamBody(text)}`);
    }
    return res.json();
  }

  private get base(): string {
    return `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/lens`;
  }

  /**
   * List the Lens sites the workspace owns. Reports are site-scoped, so this is the
   * discovery step before `listReports`. Transport/auth failures PROPAGATE (like Sentry's
   * `listIssues`) so an outage reads as a gap, not as "no sites".
   */
  async listSites(): Promise<LensSite[]> {
    const raw = await this.request(`${this.base}/sites`);
    // The route returns a BARE array (verified against production 2026-07-11); tolerate a
    // `{ sites: [...] }` wrapper too so a future envelope change degrades gracefully.
    const sites = Array.isArray(raw) ? raw : (raw as Record<string, unknown> | null)?.['sites'];
    if (!Array.isArray(sites)) return [];
    return (sites as Array<Record<string, unknown>>)
      .map((s) => ({
        id: typeof s['id'] === 'string' ? s['id'] : '',
        name:
          typeof s['name'] === 'string' && s['name'] !== ''
            ? (s['name'] as string)
            : typeof s['id'] === 'string'
              ? (s['id'] as string)
              : '',
      }))
      .filter((s) => s.id !== '');
  }

  /** Build the site-reports query path with the incident-window + filter params. */
  reportsPath(
    siteId: string,
    opts: { from?: string; to?: string; q?: string; status?: string; limit?: number } = {},
  ): string {
    const params = new URLSearchParams();
    if (opts.from !== undefined) params.set('from', opts.from);
    if (opts.to !== undefined) params.set('to', opts.to);
    if (opts.q !== undefined && opts.q !== '') params.set('q', opts.q);
    if (opts.status !== undefined) params.set('status', opts.status);
    params.set('limit', String(Math.max(1, Math.min(opts.limit ?? 25, 200))));
    return `${this.base}/sites/${encodeURIComponent(siteId)}/reports?${params.toString()}`;
  }

  /**
   * List reports for a site within an optional incident window. `from`/`to` are inclusive
   * `createdAt` ISO-8601 bounds; `q` is a single case-insensitive substring over the
   * comment + env URL (NOT hint fan-out — the provider relevance-ranks client-side).
   * Returns the first page; transport/auth failures PROPAGATE.
   */
  async listReports(
    siteId: string,
    opts: { from?: string; to?: string; q?: string; status?: string; limit?: number } = {},
  ): Promise<LensReportSummary[]> {
    const raw = await this.request(this.reportsPath(siteId, opts));
    const reports = (raw as Record<string, unknown> | null)?.['reports'];
    if (!Array.isArray(reports)) return [];
    return (reports as Array<Record<string, unknown>>).map((r) => parseSummary(r, siteId));
  }

  /**
   * Fetch one full report (with metadata) by id, scoped to its site. Transport/auth
   * failures PROPAGATE; the provider wraps each call so one bad report never aborts a
   * collection.
   */
  async getReport(siteId: string, reportId: string): Promise<LensReport> {
    const raw = await this.request(
      `${this.base}/sites/${encodeURIComponent(siteId)}/reports/${encodeURIComponent(reportId)}`,
    );
    return parseReport(raw);
  }

  /** Cheap reachability probe: `listSites` succeeds → ok. Never throws. */
  async health(): Promise<HealthStatus> {
    try {
      const sites = await this.listSites();
      return { ok: true, detail: `lens reachable (workspace ${this.workspaceId}, ${sites.length} site(s))` };
    } catch (err) {
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Coerce a list-endpoint report row into a LensReportSummary. */
export function parseSummary(raw: Record<string, unknown>, siteId: string): LensReportSummary {
  const summary: LensReportSummary = {
    id: String(raw['id'] ?? ''),
    lensSiteId: typeof raw['lensSiteId'] === 'string' ? raw['lensSiteId'] : siteId,
    status: typeof raw['status'] === 'string' ? raw['status'] : '',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    submittedAt: typeof raw['submittedAt'] === 'string' ? raw['submittedAt'] : null,
    externalIssue: raw['externalIssue'] ?? null,
    lensIssueId: typeof raw['lensIssueId'] === 'string' ? raw['lensIssueId'] : null,
    issueOccurrenceCount:
      typeof raw['issueOccurrenceCount'] === 'number' ? raw['issueOccurrenceCount'] : null,
    errorCount: toNumber(raw['errorCount']),
    hasReplay: raw['hasReplay'] === true,
  };
  if (typeof raw['comment'] === 'string') summary.comment = raw['comment'];
  if (typeof raw['url'] === 'string') summary.url = raw['url'];
  return summary;
}

/** Coerce the single-report JSON into a LensReport, tolerating a null/partial metadata. */
export function parseReport(raw: unknown): LensReport {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(o['id'] ?? ''),
    status: typeof o['status'] === 'string' ? o['status'] : '',
    createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : '',
    submittedAt: typeof o['submittedAt'] === 'string' ? o['submittedAt'] : null,
    metadata: parseMetadata(o['metadata']),
  };
}

function parseMetadata(raw: unknown): LensReportMetadata | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const meta: LensReportMetadata = {
    errors: parseErrors(m['errors']),
    networkTail: parseNetworkTail(m['networkTail']),
  };
  if (typeof m['comment'] === 'string') meta.comment = m['comment'];
  if (typeof m['trigger'] === 'string') meta.trigger = m['trigger'];

  const target = m['target'];
  if (target && typeof target === 'object') {
    const t = target as Record<string, unknown>;
    const parsed: LensTargetElement = {};
    if (typeof t['domPath'] === 'string') parsed.domPath = t['domPath'];
    if (typeof t['tagName'] === 'string') parsed.tagName = t['tagName'];
    if (typeof t['text'] === 'string') parsed.text = t['text'];
    if (Array.isArray(t['reactComponents'])) {
      parsed.reactComponents = (t['reactComponents'] as unknown[]).filter(
        (c): c is string => typeof c === 'string',
      );
    }
    meta.target = parsed;
  }

  const env = m['env'];
  if (env && typeof env === 'object') {
    const e = env as Record<string, unknown>;
    const parsed: LensEnvContext = { url: typeof e['url'] === 'string' ? e['url'] : '' };
    if (typeof e['route'] === 'string') parsed.route = e['route'];
    if (typeof e['userAgent'] === 'string') parsed.userAgent = e['userAgent'];
    if (typeof e['browser'] === 'string') parsed.browser = e['browser'];
    if (typeof e['os'] === 'string') parsed.os = e['os'];
    meta.env = parsed;
  }

  const app = m['app'];
  if (app && typeof app === 'object') {
    const a = app as Record<string, unknown>;
    const parsed: LensAppContext = {};
    if (typeof a['release'] === 'string') parsed.release = a['release'];
    if (typeof a['gitSha'] === 'string') parsed.gitSha = a['gitSha'];
    if (typeof a['environment'] === 'string') parsed.environment = a['environment'];
    if (a['featureFlags'] && typeof a['featureFlags'] === 'object') {
      parsed.featureFlags = a['featureFlags'] as Record<string, string | number | boolean>;
    }
    meta.app = parsed;
  }
  return meta;
}

function parseErrors(raw: unknown): LensErrorEntry[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>)
    .filter((e) => typeof e['message'] === 'string')
    .map((e) => {
      const err: LensErrorEntry = {
        message: e['message'] as string,
        source: typeof e['source'] === 'string' ? e['source'] : '',
        timestamp: toNumber(e['timestamp']),
      };
      if (typeof e['stack'] === 'string') err.stack = e['stack'];
      return err;
    });
}

function parseNetworkTail(raw: unknown): LensNetworkEntry[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((n) => {
    const entry: LensNetworkEntry = {
      method: typeof n['method'] === 'string' ? n['method'] : '',
      url: typeof n['url'] === 'string' ? n['url'] : '',
      status: typeof n['status'] === 'number' ? n['status'] : null,
      ok: typeof n['ok'] === 'boolean' ? n['ok'] : null,
      durationMs: typeof n['durationMs'] === 'number' ? n['durationMs'] : null,
      requestType: typeof n['requestType'] === 'string' ? n['requestType'] : '',
      startedAt: toNumber(n['startedAt']),
    };
    if (typeof n['error'] === 'string') entry.error = n['error'];
    return entry;
  });
}
