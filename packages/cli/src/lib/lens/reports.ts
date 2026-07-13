/**
 * Lens report work-queue (HOR-CLI) — the shared "fetch + shape" core behind
 * `horus lens` (list/show) and the MCP `list_lens_reports` / `get_lens_report` tools.
 *
 * Lens is Horus's issue-capture product: clients file bug reports from the running app.
 * HOR-470 folds those reports into `horus investigate` as evidence (window-scoped,
 * relevance-demoted, capped). This module exposes the SAME reports as a first-class
 * backlog the agent can browse and act on directly — every client-reported issue, not
 * just the ones relevant to an incident hint.
 *
 * It is the single owner of report fetch+shape: the CLI command and the MCP tools are
 * thin adapters over `listLensReports` / `getLensReportDetail`. The Cloud read path
 * (`LensCloudClient`) and the seed-resolution (`buildSignal`) are REUSED from
 * `@horus/connectors` — no parallel implementation.
 *
 * NATIVE-CONNECTOR CONTRACT (mirrors HOR-470): available only when the CLI is logged in
 * (`~/.horus/auth.json`) AND the repo is cloud-linked (`<repo>/.horus/cloud.json` carries
 * `workspace.id`). Otherwise it returns a typed `unavailable` reason (never throws) so the
 * caller can print a remedy. Read-only; comments/errors are redacted and reporter identity
 * is never read (the connector helpers already guarantee this).
 */
import { LensCloudClient, buildSignal } from '@horus/connectors';
import type { LensReportSignal, LensReportSummary, LensSite } from '@horus/connectors';
import { readAuth } from '../cloud/auth-store.js';
import { readCloudConfig } from '../cloud/context-store.js';

/** Why the Lens work queue can't be reached (each maps to a one-line remedy). */
export type LensUnavailableReason = 'not-logged-in' | 'not-cloud-linked';

/** One-line remedy per unavailable reason (shown to humans + agents). */
export const LENS_REMEDY: Record<LensUnavailableReason, string> = {
  'not-logged-in': 'not logged into Horus Cloud — run `horus login`',
  'not-cloud-linked': 'repo not cloud-linked — run `horus cloud link`',
};

export interface LensUnavailable {
  unavailable: LensUnavailableReason;
  remedy: string;
}

function isUnavailable<T>(v: T | LensUnavailable): v is LensUnavailable {
  return (v as LensUnavailable).unavailable !== undefined;
}
export { isUnavailable as isLensUnavailable };

interface LensClientHandle {
  client: LensCloudClient;
  workspaceId: string;
}

/**
 * Build a read-only Lens Cloud client from the CLI's cloud auth + the repo's linked
 * workspace, or a typed `unavailable` reason. Same gate as `investigation-runner.ts`.
 */
export function resolveLensClient(root: string): LensClientHandle | LensUnavailable {
  const auth = readAuth();
  if (!auth)
    return { unavailable: 'not-logged-in', remedy: LENS_REMEDY['not-logged-in'] };
  const workspaceId = readCloudConfig(root)?.workspace?.id;
  if (!workspaceId)
    return { unavailable: 'not-cloud-linked', remedy: LENS_REMEDY['not-cloud-linked'] };
  return {
    client: new LensCloudClient({
      apiBaseUrl: auth.apiBaseUrl,
      token: auth.token,
      workspaceId,
    }),
    workspaceId,
  };
}

/** A condensed backlog row — cheap (list endpoint only, no per-report fetch). */
export interface LensReportRow {
  id: string;
  siteId: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  comment?: string;
  /** Pathname of the page the report was filed on (origin stripped), when known. */
  route?: string;
  url?: string;
  errorCount: number;
  hasReplay: boolean;
}

export interface LensListResult {
  reports: LensReportRow[];
  /** Number of Lens sites the workspace owns (reports are merged across them). */
  sites: number;
  notes?: string[];
}

export interface LensListOpts {
  /** Report status filter passed to the API. Default `submitted` (finalized reports). */
  status?: string;
  /** `'all'` (or `--all`) drops the status filter and returns every status. */
  all?: boolean;
  /** Max reports across the merged result. 1–200. Default 50. */
  limit?: number;
  /** Only reports created on/after this ISO date (maps to the API `from` bound). */
  since?: string;
  /** Restrict to a single Lens site id (skips site discovery). */
  siteId?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), MAX_LIMIT));
}

/** Strip a URL down to its pathname (the "route"); tolerate a bare/relative value. */
function routeFromUrl(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith('/') ? url : undefined;
  }
}

/** Sites to query: the single requested one, or all the workspace owns. */
async function sitesFor(handle: LensClientHandle, siteId?: string): Promise<LensSite[]> {
  if (siteId !== undefined && siteId !== '') return [{ id: siteId, name: siteId }];
  return handle.client.listSites();
}

function toRow(summary: LensReportSummary): LensReportRow {
  const row: LensReportRow = {
    id: summary.id,
    siteId: summary.lensSiteId,
    status: summary.status,
    createdAt: summary.createdAt,
    submittedAt: summary.submittedAt,
    errorCount: summary.errorCount,
    hasReplay: summary.hasReplay,
  };
  if (summary.comment !== undefined) row.comment = summary.comment;
  if (summary.url !== undefined) row.url = summary.url;
  const route = routeFromUrl(summary.url);
  if (route !== undefined) row.route = route;
  return row;
}

/**
 * List client-reported Lens issues across every site the workspace owns, newest first.
 * Cheap: one list call per site, no per-report fetch — the code seed lives in
 * `getLensReportDetail`. Returns a typed `unavailable` reason when the queue can't be
 * reached; transport/auth failures from the Cloud API PROPAGATE (an outage must not read
 * as "no reports").
 */
export async function listLensReports(
  root: string,
  opts: LensListOpts = {},
): Promise<LensListResult | LensUnavailable> {
  const handle = resolveLensClient(root);
  if (isUnavailable(handle)) return handle;

  const limit = clampLimit(opts.limit);
  const status =
    opts.all || opts.status === 'all' ? undefined : (opts.status ?? 'submitted');
  const sites = await sitesFor(handle, opts.siteId);

  const rows: LensReportRow[] = [];
  for (const site of sites) {
    const summaries = await handle.client.listReports(site.id, {
      status,
      limit,
      ...(opts.since !== undefined ? { from: opts.since } : {}),
    });
    for (const s of summaries) rows.push(toRow(s));
  }

  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const trimmed = rows.slice(0, limit);

  const result: LensListResult = { reports: trimmed, sites: sites.length };
  if (rows.length > trimmed.length) {
    // Merged across sites exceeded the cap — exact overflow count is known.
    result.notes = [
      `showing ${trimmed.length} of ${rows.length} reports — raise --limit for more`,
    ];
  } else if (trimmed.length === limit) {
    // Hit the per-site API cap exactly; more may exist beyond it (can't tell without paging).
    result.notes = [
      `showing the first ${limit} reports — raise --limit if more may exist`,
    ];
  }
  return result;
}

/** The actionable payload for one report: the shaped signal + a flattened code seed. */
export interface LensReportDetail extends LensReportSignal {
  /** The raise site to work on — top parseable stack frame. Null when no stack seeded one. */
  seed: { file: string; line?: number; symbol?: string } | null;
}

export interface LensDetailOpts {
  /** The report's Lens site id (skips the cross-site scan when known). */
  siteId?: string;
}

export interface LensReportNotFound {
  notFound: true;
  reportId: string;
}

/**
 * Fetch one report in full and shape it into an actionable detail: comment, route,
 * release/gitSha, failing requests, top error message, and the resolved code seed
 * (`file:line:symbol`). Locates the report's site by scanning the workspace's sites when
 * `siteId` isn't supplied. Reuses `buildSignal` (the same shaping the evidence provider
 * uses) so the seed here matches the seed an investigation would surface.
 */
export async function getLensReportDetail(
  root: string,
  reportId: string,
  opts: LensDetailOpts = {},
): Promise<LensReportDetail | LensUnavailable | LensReportNotFound> {
  const handle = resolveLensClient(root);
  if (isUnavailable(handle)) return handle;

  const sites = await sitesFor(handle, opts.siteId);
  for (const site of sites) {
    // Locate the summary (any status) so buildSignal has the list-level fields.
    const summaries = await handle.client.listReports(site.id, { limit: MAX_LIMIT });
    const summary = summaries.find((s) => s.id === reportId);
    if (!summary) continue;
    const report = await handle.client.getReport(site.id, reportId);
    const signal = buildSignal(summary, report);
    const seed = signal.topFrame
      ? {
          file: signal.topFrame.filename,
          ...(signal.topFrame.lineno !== undefined
            ? { line: signal.topFrame.lineno }
            : {}),
          ...(signal.topFrame.function !== undefined
            ? { symbol: signal.topFrame.function }
            : {}),
        }
      : null;
    return { ...signal, seed };
  }
  return { notFound: true, reportId };
}

export function isLensNotFound<T>(v: T | LensReportNotFound): v is LensReportNotFound {
  return (v as LensReportNotFound).notFound === true;
}
