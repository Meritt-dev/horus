/**
 * Read-only Axiom logs client for @horus/connectors (HOR-429).
 *
 * Axiom is a structured-log source queried with APL (Axiom Processing Language).
 * Each row is a log event whose fields Horus folds into `kind: 'log'` Evidence — a
 * direct seed for the investigation engine alongside Elasticsearch / Sentry.
 *
 * Safety: only read endpoints are used (dataset listing + APL queries; the `_apl`
 * endpoint is read-only, which is what makes retrying its POST safe). Auth is
 * `Authorization: Bearer <token>`. Transport goes through the shared fetchWithRetry
 * helper — every request is bounded by an 8s per-attempt timeout with bounded retry
 * on 429/5xx/network errors. The client never throws past its callers —
 * `listDatasets`/`query` return [] on any failure and `health()` returns a structured
 * `{ ok, detail }`. No `@axiomhq/*` SDK — `fetch` only.
 */

import type { HealthStatus } from '@horus/core';
import { redactErrorMessage, redactUpstreamBody } from '@horus/core';
import { fetchWithRetry, type HttpRequestOptions } from '../http.js';

export interface AxiomClientOpts {
  /** API token (sent as `Authorization: Bearer <token>`). */
  token: string;
  /** Dataset to query (an Axiom dataset is the rough analogue of an ES index). */
  dataset: string;
  /**
   * Base URL. Defaults to the US region (https://api.axiom.co). Use
   * https://api.eu.axiom.co for the EU region. Trailing slash is trimmed.
   */
  baseUrl?: string;
  /** Transport overrides (timeout / retry) forwarded to fetchWithRetry. */
  http?: HttpRequestOptions;
}

/** A dataset descriptor, trimmed to what Horus needs. */
export interface AxiomDataset {
  name: string;
  description?: string;
}

/** One log event row from an APL query — its fields plus a hoisted `_time`. */
export interface AxiomLogRecord {
  /** ISO timestamp of the event (Axiom's `_time` field) when present. */
  timestamp?: string;
  /** All row fields as a flat record (column name -> value). */
  fields: Record<string, unknown>;
}

const APL_PATH = '/v1/datasets/_apl?format=tabular';

export class AxiomClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly dataset: string;
  private readonly http: HttpRequestOptions;

  constructor(opts: AxiomClientOpts) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.axiom.co').replace(/\/$/, '');
    this.token = opts.token;
    this.dataset = opts.dataset;
    this.http = opts.http ?? {};
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const init: Omit<RequestInit, 'signal'> = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetchWithRetry(url, init, this.http);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Axiom ${method} ${path} -> ${res.status}: ${redactUpstreamBody(text)}`);
    }
    return res.json();
  }

  /**
   * List the datasets reachable with the configured token. Returns [] on any error so
   * callers degrade gracefully (never throws past here).
   */
  async listDatasets(): Promise<AxiomDataset[]> {
    try {
      const raw = await this.request('GET', '/v1/datasets');
      if (!Array.isArray(raw)) return [];
      return (raw as Array<Record<string, unknown>>).map(parseDataset);
    } catch {
      return [];
    }
  }

  /**
   * Run an APL query over the configured time window. `startTime`/`endTime` are ISO
   * strings and bound the query server-side. Transport/auth failures PROPAGATE so
   * the engine can distinguish "Axiom is down/misconfigured" from "no rows matched";
   * callers that need degrade-to-[] wrap this themselves (provider.queryEvidence,
   * provider.analyzeDurations).
   */
  async query(apl: string, startTime: string, endTime: string): Promise<AxiomLogRecord[]> {
    const raw = await this.request('POST', APL_PATH, { apl, startTime, endTime });
    return parseTabular(raw);
  }

  /**
   * Cheap reachability probe: list datasets. Returns a structured status; never throws.
   */
  async health(): Promise<HealthStatus> {
    try {
      await this.request('GET', '/v1/datasets');
      return { ok: true, detail: `axiom reachable (${this.dataset})` };
    } catch (err) {
      return { ok: false, detail: redactErrorMessage(err) };
    }
  }
}

/** Coerce a dataset JSON entry into an AxiomDataset. */
export function parseDataset(raw: Record<string, unknown>): AxiomDataset {
  const ds: AxiomDataset = { name: String(raw['name'] ?? '') };
  if (typeof raw['description'] === 'string' && raw['description'] !== '') {
    ds.description = raw['description'];
  }
  return ds;
}

/**
 * Log levels that signal an active incident. Incident-aware queries bias toward these
 * so a high-volume error storm isn't crowded out by a handful of newest `info` rows.
 */
export const AXIOM_ERROR_LEVELS = ['error', 'warn', 'fatal'] as const;

/** APL-escaped dataset reference: `['name']`. */
function datasetRef(dataset: string): string {
  return `['${dataset.replace(/'/g, '')}']`;
}

/** Domain-relevant hint tokens (length > 2) used in `search`/filter clauses. */
function searchTerms(hintTerms: string[]): string[] {
  return hintTerms.map((t) => t.trim()).filter((t) => t.length > 2);
}

/**
 * OR-joined full-text `search` clause for the supplied terms, or '' when none. APL's
 * `search` scans ALL columns, so it matches the message body AND the structured
 * `error.message` / `error.name` / `error.stack` / `errorMessage` / `errorName` fields.
 */
function searchClause(hintTerms: string[]): string {
  const terms = searchTerms(hintTerms);
  return terms.length > 0
    ? ` | search ${terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' or ')}`
    : '';
}

/** `where` clause restricting to incident-level rows (case-insensitive on `level`). */
function errorLevelClause(): string {
  const levels = AXIOM_ERROR_LEVELS.map((l) => `'${l}'`).join(', ');
  return ` | where tolower(tostring(level)) in (${levels})`;
}

/**
 * Build a broad APL query string over a dataset. When `hintTerms` are supplied, a
 * full-text `search` clause OR-joins the domain-relevant terms (length > 2) so the
 * window is biased toward rows mentioning the investigation hint. Results are sorted
 * newest-first and capped. This is the fallback used only when no error-level row
 * matches the incident-aware queries. Pure + exported for unit testing.
 */
export function buildApl(dataset: string, hintTerms: string[] = [], limit = 100): string {
  const lim = Math.max(1, Math.min(limit, 1000));
  return `${datasetRef(dataset)}${searchClause(hintTerms)} | sort by _time desc | limit ${lim}`;
}

/**
 * Incident-aware query #1 — TOP ERROR SIGNATURES. Restricts to error/warn/fatal rows
 * (AND the hint terms when present), then `summarize count() + max(_time) by message,
 * level` and returns the highest-volume signatures first. This is what surfaces a
 * 3k-row `level=error "Klaviyo API request failed"` storm that a newest-first scan
 * would miss behind 15 fresh `info` rows. Pure + exported for unit testing.
 */
export function buildErrorSignatureApl(dataset: string, hintTerms: string[] = [], topN = 10): string {
  const lim = Math.max(1, Math.min(topN, 1000));
  return (
    `${datasetRef(dataset)}${errorLevelClause()}${searchClause(hintTerms)}` +
    ` | summarize ['count'] = count(), ['_time'] = max(_time) by message, level` +
    ` | sort by ['count'] desc | limit ${lim}`
  );
}

/**
 * Incident-aware query #2 — a few RECENT RAW ERROR examples for grounding (full row
 * fields incl. `error.stack` / `errorStack`). Restricts to error/warn/fatal (AND the
 * hint terms when present), newest-first. Pure + exported for unit testing.
 */
export function buildRecentErrorsApl(dataset: string, hintTerms: string[] = [], limit = 5): string {
  const lim = Math.max(1, Math.min(limit, 1000));
  return `${datasetRef(dataset)}${errorLevelClause()}${searchClause(hintTerms)} | sort by _time desc | limit ${lim}`;
}

/**
 * Parse Axiom's tabular APL response into flat log records. Axiom returns a
 * `tables[]` array; each table carries `fields` (column metadata: `{ name, type }`)
 * plus the data either column-oriented (`columns: [[...col0], [...col1]]`) or
 * row-oriented (`rows: [[...row0], [...row1]]`). Both shapes are supported. `_time`
 * is hoisted to `timestamp`. Pure + exported for unit testing against captured JSON.
 */
export function parseTabular(raw: unknown): AxiomLogRecord[] {
  if (raw === null || raw === undefined || typeof raw !== 'object') return [];
  const tables = (raw as Record<string, unknown>)['tables'];
  if (!Array.isArray(tables)) return [];

  const records: AxiomLogRecord[] = [];
  for (const table of tables as Array<Record<string, unknown>>) {
    const fields = table['fields'];
    if (!Array.isArray(fields)) continue;
    const names = (fields as Array<Record<string, unknown>>).map((f) => String(f['name'] ?? ''));

    const columns = table['columns'];
    const rows = table['rows'];

    if (Array.isArray(columns)) {
      // Column-oriented: columns[c][r] is the value of field c in row r.
      const first = columns[0];
      const rowCount = Array.isArray(first) ? first.length : 0;
      for (let r = 0; r < rowCount; r++) {
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) {
          const col = columns[c];
          if (Array.isArray(col)) row[names[c]!] = col[r];
        }
        records.push(toRecord(row));
      }
    } else if (Array.isArray(rows)) {
      // Row-oriented: rows[r][c] is the value of field c in row r.
      for (const rowVals of rows as unknown[][]) {
        if (!Array.isArray(rowVals)) continue;
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) {
          row[names[c]!] = rowVals[c];
        }
        records.push(toRecord(row));
      }
    }
  }
  return records;
}

function toRecord(fields: Record<string, unknown>): AxiomLogRecord {
  const rec: AxiomLogRecord = { fields };
  const t = fields['_time'];
  if (typeof t === 'string') rec.timestamp = t;
  return rec;
}
