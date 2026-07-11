/**
 * Lens user-report evidence provider (HOR-CONNECTORS / HOR-470).
 *
 * Lens is Horus's issue-capture product: users file bug reports from the running app.
 * Each report is BOTH "what the user saw" (the comment + route + captured errors) AND a
 * direct code seed — the top parseable frame of the first captured error stack is
 * `filename:function:lineno`, i.e. the raise site.
 *
 * This provider mirrors the Sentry provider: it synthesizes one `kind: 'log'` Evidence
 * per report (never raw report bodies) so it folds straight into the engine's existing
 * error-signature / directSignatures / seed machinery. The top frame is surfaced in the
 * payload (`filePath`/`symbolName`/`lineStart`) and in `links.file`/`links.line`.
 *
 * Privacy: the comment + captured error messages are the only human text carried, and
 * both are REDACTED (`redactSecrets`). The reporter's identity (`metadata.app.user`
 * email/name) is NEVER read, and console-tail bodies are NEVER included.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import { redactSecrets } from '@horus/core';
import type { Provider } from '../contract.js';
import {
  LensCloudClient,
  type LensErrorEntry,
  type LensNetworkEntry,
  type LensReport,
  type LensReportSummary,
} from './client.js';

export interface LensProviderOpts {
  /** How many recent reports to fold in (capped 1–200). Default 25. */
  limit?: number;
  /** Report status to fetch. Default 'submitted' (a finalized user report). */
  statusFilter?: string;
}

/** A resolved top stack frame — a direct code seed. */
export interface LensTopFrame {
  /** Source file path (URL origin stripped — pathname only), e.g. "/assets/app.js". */
  filename: string;
  /** Function/symbol name at the raise site, when the frame named one. */
  function?: string;
  /** 1-based line number, when present. */
  lineno?: number;
}

/** A failing network request captured on the report (ok===false or status>=500). */
export interface LensFailingRequest {
  method: string;
  url: string;
  status: number | null;
}

/** A Lens report enriched with the fields Horus turns into evidence. */
export interface LensReportSignal {
  id: string;
  lensSiteId: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  issueOccurrenceCount: number | null;
  errorCount: number;
  hasReplay: boolean;
  comment?: string;
  route?: string;
  url?: string;
  release?: string;
  gitSha?: string;
  environment?: string;
  featureFlags?: Record<string, string | number | boolean>;
  trigger?: string;
  /** Message of the error whose stack seeded `topFrame` (or the first error). Redact before display. */
  topErrorMessage?: string;
  topFrame: LensTopFrame | null;
  failingRequests: LensFailingRequest[];
  reactComponents?: string[];
}

export class LensProvider implements Provider {
  readonly id = 'lens';
  readonly kind: ProviderKind = 'logs';

  private sitesCache: string[] | null = null;

  constructor(
    private readonly client: LensCloudClient,
    private readonly opts: LensProviderOpts = {},
  ) {}

  private get limit(): number {
    return this.opts.limit ?? 25;
  }

  private get statusFilter(): string {
    return this.opts.statusFilter ?? 'submitted';
  }

  /**
   * Collect recent reports across every site within the window and resolve each one's
   * top frame + failing requests. Reports are low-volume, so we fetch the full metadata
   * for up to `limit` (relevance-ranked) reports. A failing site LIST or reports LIST
   * PROPAGATES so the engine records a gap; per-report metadata fetches are best-effort
   * (a report still becomes a signal from its summary alone). Use queryEvidence() for the
   * degrade-to-[] contract.
   */
  async collect(
    opts: { from?: string; to?: string; hintTerms?: string[] } = {},
  ): Promise<LensReportSignal[]> {
    const siteIds = await this.sites();
    const hintTerms = opts.hintTerms ?? [];

    // Fetch the window unfiltered per site (q is a single substring, not hint fan-out),
    // then relevance-rank client-side and cap to `limit` before the metadata fetches.
    const summaries: LensReportSummary[] = [];
    for (const siteId of siteIds) {
      const page = await this.client.listReports(siteId, {
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        status: this.statusFilter,
        limit: this.limit,
      });
      summaries.push(...page);
    }

    // Re-apply the window client-side: a cloud build that predates the from/to params
    // silently IGNORES them (unknown query params are not rejected), which would leak
    // out-of-window reports into the incident's evidence. The server-side filter is an
    // efficiency; this is the correctness guarantee.
    const windowed = summaries.filter((s) => inWindow(s.createdAt, opts.from, opts.to));

    const ranked = rankSummaries(windowed, hintTerms).slice(0, this.limit);
    const reports = await Promise.all(
      ranked.map((s) =>
        this.client.getReport(s.lensSiteId, s.id).catch((): LensReport | null => null),
      ),
    );
    return ranked.map((summary, i) => buildSignal(summary, reports[i] ?? null));
  }

  /**
   * Synthesize Evidence from Lens reports. One `kind: 'log'` Evidence per report, with the
   * comment as the human signature, the captured error + failing requests + app context in
   * the payload, and the top frame surfaced as `filePath`/`symbolName`/`lineStart` (payload)
   * and `file`/`line` (links) so the engine can seed directly on it.
   */
  toEvidence(signals: LensReportSignal[], hintTerms: string[], collectedAt: string): Evidence[] {
    const query = `lens reports (status:${this.statusFilter}, up to ${this.limit})`;
    return signals.map((sig, i) => signalToEvidence(sig, hintTerms, query, collectedAt, i));
  }

  /**
   * One-shot evidence query: collect reports, convert to redacted Evidence. Preferred entry
   * point for the investigation engine. Degrades to [] on any failure so a flaky Cloud never
   * aborts an investigation.
   */
  async queryEvidence(
    opts: { from?: string; to?: string; hintTerms?: string[]; collectedAt?: string } = {},
  ): Promise<Evidence[]> {
    try {
      const hintTerms = opts.hintTerms ?? [];
      const signals = await this.collect({
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        hintTerms,
      });
      return this.toEvidence(signals, hintTerms, opts.collectedAt ?? new Date().toISOString());
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  /** In-instance site-id cache — reports are site-scoped and the site list is stable. */
  private async sites(): Promise<string[]> {
    if (this.sitesCache !== null) return this.sitesCache;
    const sites = await this.client.listSites();
    this.sitesCache = sites.map((s) => s.id);
    return this.sitesCache;
  }
}

/* ── Signal building ─────────────────────────────────────────────────────── */

/** Merge a summary with its (optional) full report metadata into a signal. */
export function buildSignal(summary: LensReportSummary, report: LensReport | null): LensReportSignal {
  const meta = report?.metadata ?? null;
  const errors = meta?.errors ?? [];
  const { frame, message } = topFrameFromErrors(errors);

  const signal: LensReportSignal = {
    id: summary.id,
    lensSiteId: summary.lensSiteId,
    status: summary.status,
    createdAt: summary.createdAt,
    submittedAt: summary.submittedAt,
    issueOccurrenceCount: summary.issueOccurrenceCount,
    errorCount: summary.errorCount || errors.length,
    hasReplay: summary.hasReplay,
    topFrame: frame,
    failingRequests: failingRequestsFrom(meta?.networkTail ?? []),
  };

  const comment = meta?.comment ?? summary.comment;
  if (comment !== undefined) signal.comment = comment;
  const route = meta?.env?.route;
  if (route !== undefined) signal.route = route;
  const url = meta?.env?.url && meta.env.url !== '' ? meta.env.url : summary.url;
  if (url !== undefined) signal.url = url;
  if (meta?.app?.release !== undefined) signal.release = meta.app.release;
  if (meta?.app?.gitSha !== undefined) signal.gitSha = meta.app.gitSha;
  if (meta?.app?.environment !== undefined) signal.environment = meta.app.environment;
  if (meta?.app?.featureFlags !== undefined) signal.featureFlags = meta.app.featureFlags;
  if (meta?.trigger !== undefined) signal.trigger = meta.trigger;
  if (message !== undefined) signal.topErrorMessage = message;
  const react = meta?.target?.reactComponents;
  if (react !== undefined && react.length > 0) signal.reactComponents = react;

  return signal;
}

/** Network-tail entries that failed (ok===false OR status>=500), capped ~5. */
export function failingRequestsFrom(tail: LensNetworkEntry[]): LensFailingRequest[] {
  return tail
    .filter((n) => n.ok === false || (typeof n.status === 'number' && n.status >= 500))
    .slice(0, 5)
    .map((n) => ({ method: n.method, url: n.url, status: n.status }));
}

/* ── Stack parsing ───────────────────────────────────────────────────────── */

/**
 * Take the FIRST parseable frame of the FIRST error that has a stack. Returns the frame
 * plus the message of the error it came from (so the two stay paired). When no error has a
 * parseable stack, `frame` is null but `message` is still the first error's message.
 */
export function topFrameFromErrors(
  errors: LensErrorEntry[],
): { frame: LensTopFrame | null; message?: string } {
  let firstMessage: string | undefined;
  for (const err of errors) {
    if (firstMessage === undefined && err.message) firstMessage = err.message;
    if (!err.stack) continue;
    const frame = parseStackTopFrame(err.stack);
    if (frame) return { frame, message: err.message || firstMessage };
  }
  return firstMessage !== undefined ? { frame: null, message: firstMessage } : { frame: null };
}

/** Schemes / markers we never seed on. */
function isSkippableLocation(location: string): boolean {
  if (location === '') return true;
  if (location.includes('node_modules')) return true;
  if (/^[a-z-]+-extension:\/\//i.test(location)) return true; // chrome-extension://, moz-extension://, ...
  if (location.includes('[native code]') || location.includes('<anonymous>')) return true;
  return false;
}

/**
 * Parse the top (first non-skippable) frame of a BROWSER error stack. Handles:
 *   - V8 named:     `    at fn (https://host/path/file.js:LINE:COL)`
 *   - V8 anonymous: `    at https://host/path/file.js:LINE:COL`
 *   - Firefox/Safari: `fn@https://host/path/file.js:LINE:COL` (and `@https://...`)
 * The URL origin is stripped — the pathname becomes `filename`. Frames from node_modules,
 * extension schemes, and blank/native locations are skipped. Pure + exported for tests.
 */
export function parseStackTopFrame(stack: string): LensTopFrame | null {
  const lines = stack.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let fnName: string | undefined;
    let location: string | undefined;

    if (line.startsWith('at ')) {
      // V8 format.
      const body = line.slice(3).trim();
      const parenMatch = /^(.*?)\s*\((.+)\)\s*$/.exec(body);
      if (parenMatch) {
        fnName = parenMatch[1]?.trim() || undefined;
        location = parenMatch[2]!.trim();
      } else {
        location = body;
      }
    } else if (line.includes('@')) {
      // Firefox/Safari format `fn@location`.
      const at = line.lastIndexOf('@');
      fnName = line.slice(0, at).trim() || undefined;
      location = line.slice(at + 1).trim();
    } else {
      continue;
    }

    if (location === undefined || isSkippableLocation(location)) continue;

    const parsed = parseLocation(location);
    if (!parsed) continue;
    if (isSkippableLocation(parsed.filename)) continue;

    const frame: LensTopFrame = { filename: parsed.filename };
    if (fnName !== undefined && fnName !== '') frame.function = fnName;
    if (parsed.lineno !== undefined) frame.lineno = parsed.lineno;
    return frame;
  }
  return null;
}

/**
 * Split a `<url>:LINE[:COL]` location into a pathname filename + line number. The URL may
 * itself contain colons (scheme, `host:port`), so the `:LINE[:COL]` suffix is peeled from
 * the END. The origin is dropped — `https://host/a/b.js` → `/a/b.js`.
 */
function parseLocation(location: string): { filename: string; lineno?: number } | null {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(location);
  const rawUrl = m ? m[1]! : location;
  const lineno = m ? Number(m[2]) : undefined;

  let filename = rawUrl;
  try {
    // Only strip origin when there is a real scheme (http/https). new URL() also parses
    // extension schemes, but those are filtered upstream.
    if (/^[a-z]+:\/\//i.test(rawUrl)) filename = new URL(rawUrl).pathname;
  } catch {
    filename = rawUrl;
  }
  if (filename === '') return null;
  return lineno !== undefined && Number.isFinite(lineno) ? { filename, lineno } : { filename };
}

/* ── Evidence + relevance ────────────────────────────────────────────────── */

function signalToEvidence(
  sig: LensReportSignal,
  hintTerms: string[],
  query: string,
  collectedAt: string,
  index: number,
): Evidence {
  const frame = sig.topFrame;
  const title = buildTitle(sig);
  const relevance = computeRelevance(sig, hintTerms);

  const payload: Record<string, unknown> = {
    source: 'lens',
    reportId: sig.id,
    ...(sig.comment !== undefined ? { comment: redactSecrets(sig.comment) } : {}),
    ...(sig.route !== undefined ? { route: sig.route } : {}),
    ...(sig.url !== undefined ? { url: sig.url } : {}),
    ...(sig.release !== undefined ? { release: sig.release } : {}),
    ...(sig.gitSha !== undefined ? { gitSha: sig.gitSha } : {}),
    ...(sig.trigger !== undefined ? { trigger: sig.trigger } : {}),
    errorCount: sig.errorCount,
    ...(sig.topErrorMessage !== undefined
      ? { topError: redactSecrets(sig.topErrorMessage) }
      : {}),
    ...(sig.failingRequests.length > 0 ? { failingRequests: sig.failingRequests } : {}),
    ...(sig.reactComponents !== undefined ? { reactComponents: sig.reactComponents } : {}),
    ...(sig.featureFlags !== undefined ? { featureFlags: sig.featureFlags } : {}),
  };
  // Direct code seed: the engine reads filePath/symbolName/lineStart off the payload.
  if (frame?.filename !== undefined) payload['filePath'] = frame.filename;
  if (frame?.function !== undefined) payload['symbolName'] = frame.function;
  if (frame?.lineno !== undefined) payload['lineStart'] = frame.lineno;

  const links: Evidence['links'] = {};
  if (frame?.filename !== undefined) links.file = frame.filename;
  if (frame?.lineno !== undefined) links.line = frame.lineno;

  const ev: Evidence = {
    id: `ev_lens_${index}`,
    source: 'logs',
    kind: 'log',
    title,
    relevance,
    payload,
    links,
    provenance: { query, collectedAt },
  };
  const ts = sig.submittedAt ?? sig.createdAt;
  if (ts) ev.timestamp = ts;
  return ev;
}

/**
 * Build the human one-line title:
 *   `Lens report: "<comment ~80>" · <N> error(s) · <route|url> · <shortTs(createdAt)>`.
 * The comment is redacted; a report without a comment falls back to "(no comment)".
 */
export function buildTitle(sig: LensReportSignal): string {
  const rawComment = sig.comment ? redactSecrets(sig.comment) : '';
  const comment = rawComment !== '' ? rawComment.slice(0, 80) : '(no comment)';
  const errs = `${sig.errorCount} error(s)`;
  const where = sig.route ?? sig.url ?? '';
  const whereStr = where !== '' ? ` · ${where}` : '';
  const when = sig.createdAt ? ` · ${shortTs(sig.createdAt)}` : '';
  return `Lens report: "${comment}" · ${errs}${whereStr}${when}`.slice(0, 220);
}

/**
 * Relevance-weight a report by hint-term match (comment/route/error messages/frame),
 * recency, and recurrence. Range ~0.5–0.95. A user-filed comment that names what the hint
 * names, a fresh report, and a recurring fingerprint all push relevance up.
 */
export function computeRelevance(
  sig: LensReportSignal,
  hintTerms: string[],
  now: number = Date.now(),
): number {
  let score = 0.6;

  const hay = [
    sig.comment ?? '',
    sig.route ?? '',
    sig.url ?? '',
    sig.topErrorMessage ?? '',
    sig.topFrame?.filename ?? '',
    sig.topFrame?.function ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const domainTerms = hintTerms.filter((t) => t.length > 2);
  if (domainTerms.some((t) => hay.includes(t.toLowerCase()))) score += 0.2;

  const ts = sig.submittedAt ?? sig.createdAt;
  if (ts) {
    const ageMs = now - Date.parse(ts);
    if (Number.isFinite(ageMs)) {
      if (ageMs <= 86_400_000) score += 0.1;
      else if (ageMs <= 7 * 86_400_000) score += 0.05;
    }
  }

  if ((sig.issueOccurrenceCount ?? 0) >= 3) score += 0.05;

  return Math.min(0.95, Math.max(0.5, score));
}

/** Preliminary client-side ranking used to pick which reports to fully fetch. */
function rankSummaries(
  summaries: LensReportSummary[],
  hintTerms: string[],
  now: number = Date.now(),
): LensReportSummary[] {
  const domainTerms = hintTerms.filter((t) => t.length > 2);
  const score = (s: LensReportSummary): number => {
    let v = 0;
    const hay = `${s.comment ?? ''} ${s.url ?? ''}`.toLowerCase();
    if (domainTerms.some((t) => hay.includes(t.toLowerCase()))) v += 2;
    if (s.createdAt) {
      const ageMs = now - Date.parse(s.createdAt);
      if (Number.isFinite(ageMs) && ageMs <= 86_400_000) v += 1;
    }
    if ((s.issueOccurrenceCount ?? 0) >= 3) v += 0.5;
    return v;
  };
  return [...summaries].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    // Stable-ish tiebreak: newest first.
    return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
  });
}

/** Inclusive createdAt window check; an unparseable bound is treated as unbounded. */
export function inWindow(createdAt: string, from?: string, to?: string): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return true; // never drop a report over a malformed timestamp
  const lo = from !== undefined ? Date.parse(from) : NaN;
  const hi = to !== undefined ? Date.parse(to) : NaN;
  if (Number.isFinite(lo) && t < lo) return false;
  if (Number.isFinite(hi) && t > hi) return false;
  return true;
}

/** Short, human "MM-DD HH:MM" form of an ISO timestamp (empty-safe). */
function shortTs(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
