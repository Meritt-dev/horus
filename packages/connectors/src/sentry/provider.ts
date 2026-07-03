/**
 * Sentry error-evidence provider (HOR-CONNECTORS).
 *
 * Sentry is the canonical ERROR source: each grouped issue is both "what's the error"
 * (title + culprit + count + frequency + last-seen) AND a direct code seed — its latest
 * event's top in-app stack frame is `filename:function:lineno`, i.e. the raise site.
 *
 * This provider mirrors the Elasticsearch logs provider: it synthesizes error-signature
 * Evidence (never raw events). Each issue becomes one `kind: 'log'` Evidence so it folds
 * straight into the engine's existing error-signature / directSignatures / seed machinery.
 * The top in-app frame is surfaced both in the payload (`filePath` / `symbolName` /
 * `lineStart`) and in `links.file` / `links.line` so the engine can seed on it.
 *
 * Privacy: counts + signatures + the top frame only — no raw event bodies, no PII beyond
 * the group message (which is redacted) and the frame location.
 */

import type { Evidence, HealthStatus, ProviderKind } from '@horus/core';
import { redactSecrets } from '@horus/core';
import type { Provider } from '../contract.js';
import { SentryClient, type SentryIssue, type SentryTopFrame } from './client.js';

export interface SentryProviderOpts {
  /** Org/project label for evidence provenance. */
  org: string;
  project: string;
  /** Default issues query (Sentry search syntax). Defaults to "is:unresolved". */
  query?: string;
  /** How many recent issues to fold in (capped 1–100). */
  limit?: number;
  /** Default lookback window as a Sentry statsPeriod (e.g. "24h", "14d"). */
  statsPeriod?: string;
}

/** A Sentry issue enriched with its resolved top in-app frame (best-effort). */
export interface SentryErrorSignature {
  issue: SentryIssue;
  frame: SentryTopFrame | null;
}

export class SentryProvider implements Provider {
  readonly id = 'sentry';
  readonly kind: ProviderKind = 'logs';

  constructor(
    private readonly client: SentryClient,
    private readonly opts: SentryProviderOpts,
  ) {}

  /**
   * Collect recent issues and resolve each one's top in-app frame. Frame fetches
   * stay best-effort (`frame: null`), but a failing issue LIST throws so the
   * engine records the failure as an evidence gap instead of reading an outage
   * as "no issues matched". Use queryEvidence() for the degrade-to-[] contract.
   */
  async collect(
    opts: { from?: string; to?: string; hintTerms?: string[] } = {},
  ): Promise<SentryErrorSignature[]> {
    const window =
      opts.from !== undefined && opts.to !== undefined
        ? { start: opts.from, end: opts.to }
        : { statsPeriod: this.opts.statsPeriod ?? '14d' };
    const issues = await this.client.listIssues({
      query: this.opts.query ?? 'is:unresolved',
      limit: this.opts.limit ?? 25,
      ...window,
    });
    // Resolve top frames in parallel — each call is bounded + self-healing.
    const frames = await Promise.all(
      issues.map((i) => this.client.latestEventTopFrame(i.id)),
    );
    return issues.map((issue, i) => ({ issue, frame: frames[i] ?? null }));
  }

  /**
   * Synthesize Evidence from Sentry issues. One `kind: 'log'` Evidence per issue, with
   * the title as the error signature, the culprit + counts + last-seen in the payload,
   * and the top in-app frame surfaced as `filePath`/`symbolName`/`lineStart` (payload)
   * and `file`/`line` (links) so the engine can seed directly on it.
   */
  toEvidence(
    signatures: SentryErrorSignature[],
    hintTerms: string[],
    collectedAt: string,
  ): Evidence[] {
    const query = `sentry ${this.opts.org}/${this.opts.project} (${this.opts.query ?? 'is:unresolved'})`;
    return signatures.map((sig, i) =>
      this.signatureToEvidence(sig, hintTerms, query, collectedAt, i),
    );
  }

  /**
   * One-shot evidence query: collect issues + frames, convert to Evidence, redact the
   * message. Preferred entry point for the investigation engine. Degrades to [] on any
   * failure so a flaky Sentry never aborts an investigation.
   */
  async queryEvidence(
    opts: { from?: string; to?: string; hintTerms?: string[]; collectedAt?: string } = {},
  ): Promise<Evidence[]> {
    try {
      const hintTerms = opts.hintTerms ?? [];
      const signatures = await this.collect({
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.to !== undefined ? { to: opts.to } : {}),
        hintTerms,
      });
      return this.toEvidence(signatures, hintTerms, opts.collectedAt ?? new Date().toISOString());
    } catch {
      return [];
    }
  }

  async health(): Promise<HealthStatus> {
    return this.client.health();
  }

  private signatureToEvidence(
    sig: SentryErrorSignature,
    hintTerms: string[],
    query: string,
    collectedAt: string,
    index: number,
  ): Evidence {
    const { issue, frame } = sig;
    const title = buildTitle(issue, frame);
    const relevance = computeRelevance(issue, frame, hintTerms);

    const payload: Record<string, unknown> = {
      source: 'sentry',
      issueId: issue.id,
      signature: issue.title,
      title: redactSecrets(issue.title),
      count: issue.count,
      userCount: issue.userCount,
      ...(issue.culprit !== undefined ? { culprit: issue.culprit } : {}),
      ...(issue.level !== undefined ? { level: issue.level } : {}),
      ...(issue.lastSeen !== undefined ? { lastSeen: issue.lastSeen } : {}),
      ...(issue.firstSeen !== undefined ? { firstSeen: issue.firstSeen } : {}),
      ...(issue.permalink !== undefined ? { permalink: issue.permalink } : {}),
    };
    // Direct code seed: the engine reads filePath/symbolName/lineStart off the payload
    // to seed the investigation at the raise site (same machinery as a code symbol).
    if (frame?.filename !== undefined) payload['filePath'] = frame.filename;
    if (frame?.function !== undefined) payload['symbolName'] = frame.function;
    if (frame?.lineno !== undefined) payload['lineStart'] = frame.lineno;

    const links: Evidence['links'] = {};
    if (frame?.filename !== undefined) links.file = frame.filename;
    if (frame?.lineno !== undefined) links.line = frame.lineno;

    const ev: Evidence = {
      id: `ev_sentry_${index}`,
      source: 'logs',
      kind: 'log',
      title,
      relevance,
      payload,
      links,
      provenance: { query, collectedAt },
    };
    if (issue.lastSeen !== undefined) ev.timestamp = issue.lastSeen;
    return ev;
  }
}

/**
 * Build the human one-line title. Sentry's issue title is already "<type>: <value>"
 * (e.g. "TypeError: Cannot read properties of undefined"); we append count, last-seen,
 * culprit, and the raise-site frame so the line means something on its own.
 */
export function buildTitle(issue: SentryIssue, frame: SentryTopFrame | null): string {
  const sig = redactSecrets(issue.title);
  const freq = `${issue.count}x`;
  const users = issue.userCount > 0 ? ` · ${issue.userCount} user(s)` : '';
  const last = issue.lastSeen ? ` · last ${shortTs(issue.lastSeen)}` : '';
  const culprit = issue.culprit ? ` · ${issue.culprit}` : '';
  const at = frame?.filename
    ? ` @ ${frame.filename}${frame.lineno !== undefined ? `:${frame.lineno}` : ''}`
    : '';
  return `Sentry ${sig}: ${freq}${users}${last}${culprit}${at}`.slice(0, 220);
}

/**
 * Relevance-weight an issue by hint-term match (title/culprit/frame), recency, and
 * frequency. Range ~0.5–0.95. A frame that points at code the hint names, a fresh
 * last-seen, and a high event count all push relevance up.
 */
export function computeRelevance(
  issue: SentryIssue,
  frame: SentryTopFrame | null,
  hintTerms: string[],
  now: number = Date.now(),
): number {
  let score = 0.6;

  const hay = [
    issue.title,
    issue.culprit ?? '',
    frame?.filename ?? '',
    frame?.function ?? '',
  ]
    .join(' ')
    .toLowerCase();
  const domainTerms = hintTerms.filter((t) => t.length > 2);
  const matched = domainTerms.some((t) => hay.includes(t.toLowerCase()));
  if (matched) score += 0.2;

  // Recency: events seen in the last 24h are the most actionable.
  if (issue.lastSeen) {
    const ageMs = now - Date.parse(issue.lastSeen);
    if (Number.isFinite(ageMs)) {
      if (ageMs <= 86_400_000) score += 0.1;
      else if (ageMs <= 7 * 86_400_000) score += 0.05;
    }
  }

  // Frequency: a high-volume group is more likely the active incident.
  if (issue.count >= 100) score += 0.05;
  if (issue.count >= 1000) score += 0.05;

  // A resolved raise-site frame makes the evidence directly actionable.
  if (frame?.filename !== undefined) score += 0.05;

  return Math.min(0.95, Math.max(0.5, score));
}

/** Short, human "MM-DD HH:MM" form of an ISO timestamp (empty-safe). */
function shortTs(iso: string): string {
  if (!iso || iso.length < 16) return iso || '—';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
