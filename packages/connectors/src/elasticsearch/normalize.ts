/**
 * Pure normalization helpers for Elasticsearch log documents (HOR-10, HOR-47).
 * No I/O — all functions are exhaustively unit-testable.
 */

import type { Evidence } from '@horus/core';
import { redactSecrets } from '@horus/core';

// ---------------------------------------------------------------------------
// Level utilities
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** Map a pino numeric level to the nearest floor bucket. */
export function valueToLevel(n: number): LogLevel {
  if (n >= 60) return 'fatal';
  if (n >= 50) return 'error';
  if (n >= 40) return 'warn';
  if (n >= 30) return 'info';
  if (n >= 20) return 'debug';
  return 'trace';
}

export function levelToValue(l: LogLevel): number {
  return LEVEL_VALUE[l];
}

// ---------------------------------------------------------------------------
// Field mapping (HOR-47)
// ---------------------------------------------------------------------------

/**
 * Maps abstract log concepts to actual Elasticsearch field names.
 *
 * Configure this to match your index schema. Both the Meritt shared logger
 * shape and ECS (Elastic Common Schema) are supported out of the box via
 * MERITT_FIELD_MAPPING and ECS_FIELD_MAPPING. For custom schemas, supply
 * your own values.
 */
export interface ElasticsearchFieldMapping {
  /**
   * ISO timestamp field used for range filtering and sorting.
   * Meritt: 'time'. ECS: '@timestamp'.
   */
  timestampField: string;
  /**
   * Severity / log-level field.
   * Meritt: 'level' (numeric long). ECS: 'log.level' (string keyword).
   */
  levelField: string;
  /**
   * Whether levelField stores Pino numeric values (10/20/30/40/50/60)
   * or string labels ('debug'/'info'/'warn'/'error'/'fatal').
   *
   * For string format, levelField must be a keyword-typed field (or include
   * the .keyword suffix for text+keyword mappings).
   */
  levelFormat: 'numeric' | 'string';
  /**
   * Service/application name field.
   * Meritt: 'service_name' (text+keyword). ECS: 'service.name' (keyword).
   */
  serviceField: string;
  /**
   * Whether serviceField has a .keyword sub-field for exact term matching.
   * Set false when the field is already keyword-typed (e.g. ECS service.name).
   * Default: true (Meritt service_name is text+keyword).
   */
  serviceKeyword: boolean;
  /** Primary message field. */
  messageField: string;
  /** Fallback message field when messageField is absent (e.g. Pino 'msg'). */
  messageFallbackField?: string;
  /**
   * Top-level trace/correlation ID field.
   * Meritt: 'trace_id'. ECS: 'trace.id'.
   * When set, normalizeHit reads this field directly instead of trying to
   * parse it from a serialised context blob.
   */
  traceIdField?: string;
  /** Top-level request ID field, if distinct from traceIdField. */
  requestIdField?: string;
  /**
   * Structured event/error code field used for signature aggregations.
   * Meritt: 'event_code'. ECS: 'event.code'.
   */
  eventCodeField: string;
  /**
   * Whether eventCodeField has a .keyword sub-field for terms aggregations.
   * Set false when the field is already keyword-typed (e.g. ECS event.code).
   * Default: true (Meritt event_code is text+keyword).
   */
  eventCodeKeyword: boolean;
}

/**
 * Default mapping for the Meritt shared logger (pino-based).
 * Matches field names produced by the @meritt/utils Logger as observed in
 * real Elasticsearch indices (maison-safqa-prod-new-*, leadcall-api-prod-*).
 */
export const MERITT_FIELD_MAPPING: ElasticsearchFieldMapping = {
  timestampField: 'time',
  levelField: 'level',
  levelFormat: 'numeric',
  serviceField: 'service_name',
  serviceKeyword: true,
  messageField: 'message',
  messageFallbackField: 'msg',
  traceIdField: 'trace_id',
  eventCodeField: 'event_code',
  eventCodeKeyword: true,
};

/**
 * Mapping for ECS (Elastic Common Schema) deployments.
 * Compatible with Filebeat, Metricbeat, APM agents, and most managed
 * Elastic offerings that follow ECS conventions.
 *
 * ECS uses nested _source documents (e.g. { service: { name: 'x' } }).
 * normalizeHit resolves dotted field paths correctly for both nested and
 * pre-flattened ECS variants.
 */
export const ECS_FIELD_MAPPING: ElasticsearchFieldMapping = {
  timestampField: '@timestamp',
  levelField: 'log.level',
  levelFormat: 'string',
  // ECS service.name is already keyword-typed — no .keyword sub-field needed.
  serviceField: 'service.name',
  serviceKeyword: false,
  messageField: 'message',
  traceIdField: 'trace.id',
  requestIdField: 'http.request.id',
  // ECS event.code is already keyword-typed — no .keyword sub-field needed.
  eventCodeField: 'event.code',
  eventCodeKeyword: false,
};

/**
 * Validate a field mapping and throw an actionable error for invalid config.
 * Call this once at provider construction time.
 */
export function validateFieldMapping(m: ElasticsearchFieldMapping): void {
  if (!m.timestampField) {
    throw new Error(
      "[Horus/Elasticsearch] timestampField must be non-empty. Common values: 'time' (Meritt), '@timestamp' (ECS).",
    );
  }
  if (!m.levelField) {
    throw new Error(
      "[Horus/Elasticsearch] levelField must be non-empty. Common values: 'level' (Meritt numeric), 'log.level' (ECS string).",
    );
  }
  if (!m.serviceField) {
    throw new Error(
      "[Horus/Elasticsearch] serviceField must be non-empty. Common values: 'service_name' (Meritt), 'service.name' (ECS).",
    );
  }
  if (!m.messageField) {
    throw new Error('[Horus/Elasticsearch] messageField must be non-empty.');
  }
  if (!m.eventCodeField) {
    throw new Error('[Horus/Elasticsearch] eventCodeField must be non-empty.');
  }
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  levelValue: number;
  message: string;
  service?: string;
  component?: string;
  eventCode?: string;
  traceId?: string;
  requestId?: string;
  host?: string;
  /**
   * Structured context object attached to the log (Meritt `context.*`). Carries the
   * fields that make a raw error line actionable — entity ids, error strings, etc.
   * (HOR-215). Parsed from a JSON string when the logger serialised it.
   */
  context?: Record<string, unknown>;
  /**
   * Free-form `detail` field — where some loggers bury the real error (e.g. the
   * AxiosError / `getaddrinfo ENOTFOUND ...` string). Surfaced for raw output and
   * searched by broad text queries (HOR-216).
   */
  detail?: string;
  index: string;
  raw: Record<string, unknown>;
}

/** A structured field-equality filter, e.g. `context.brand_id = 42` (HOR-344). */
export interface WhereClause {
  field: string;
  value: string;
}

export interface LogQuery {
  service?: string;
  index?: string;
  from?: string;
  to?: string;
  level?: LogLevel;
  text?: string;
  /**
   * Structured field-equality filters (HOR-344). Each entry AND-combines a term
   * match on a (dotted) field path, e.g. `{ field: 'context.brand_id', value: '42' }`.
   * Matches whether the field is keyword-mapped or carries a `.keyword` subfield —
   * so `--where` finds records `--grep` can't (grep only matches the message).
   */
  where?: WhereClause[];
  /**
   * When true, `text` is matched across the message, `detail`, and `context.*`
   * fields (not just the message) so error strings buried in `detail`/`context`
   * are found (HOR-216). Default false preserves the message-only match.
   */
  broadText?: boolean;
  /**
   * Scope an aggregation to a single error signature (event_code). Only applied
   * by `buildErrorAggBody` — used to count distinct failing entities for one
   * signature (HOR-215).
   */
  eventCode?: string;
  limit?: number;
}

export interface ErrorBucket {
  key: string;
  count: number;
}

export interface ErrorDelta {
  key: string;
  baseline: number;
  current: number;
  delta: number;
  ratio: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported so analyze.ts can reuse them)
// ---------------------------------------------------------------------------

/**
 * Read a (possibly dotted) field path from an Elasticsearch _source object.
 *
 * Handles both:
 * - Flattened keys: { "service_name": "api", "@timestamp": "..." } — Meritt/Pino
 * - Nested objects: { "service": { "name": "api" }, "log": { "level": "error" } } — ECS
 * - Pre-flattened ECS: { "service.name": "api" } — Logstash ingest pipelines
 */
export function getField(src: Record<string, unknown>, path: string): unknown {
  // Fast path: literal key match (covers flattened Meritt, '@timestamp', etc.)
  if (Object.prototype.hasOwnProperty.call(src, path)) return src[path];
  // Dotted path: navigate nested object (covers standard ECS _source)
  const parts = path.split('.');
  let node: unknown = src;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Return the term-query field name for service filtering. */
export function serviceTermField(m: ElasticsearchFieldMapping): string {
  return m.serviceKeyword ? `${m.serviceField}.keyword` : m.serviceField;
}

/** Return the terms-aggregation field name for event/error code. */
export function signatureTermField(m: ElasticsearchFieldMapping): string {
  return m.eventCodeKeyword ? `${m.eventCodeField}.keyword` : m.eventCodeField;
}

/**
 * Build a level filter clause for an ES bool query.
 *
 * Numeric format: range filter on the numeric field (Pino convention).
 * String format: terms filter matching all level labels at or above minLevel.
 */
export function buildLevelFilter(
  m: ElasticsearchFieldMapping,
  minLevel: LogLevel,
): unknown {
  if (m.levelFormat === 'numeric') {
    return { range: { [m.levelField]: { gte: levelToValue(minLevel) } } };
  }
  const minValue = levelToValue(minLevel);
  const stringLevels = (Object.keys(LEVEL_VALUE) as LogLevel[]).filter(
    (l) => LEVEL_VALUE[l] >= minValue,
  );
  return { terms: { [m.levelField]: stringLevels } };
}

/**
 * Build AND-combined term filters for structured `--where field=value` clauses
 * (HOR-344). Each clause matches whether the field is keyword-mapped or carries a
 * `.keyword` subfield, so callers don't need to know the index mapping.
 */
export function buildWhereFilters(where: WhereClause[] | undefined): unknown[] {
  if (where === undefined || where.length === 0) return [];
  return where.map((w) => ({
    bool: {
      should: [
        { term: { [w.field]: w.value } },
        { term: { [`${w.field}.keyword`]: w.value } },
      ],
      minimum_should_match: 1,
    },
  }));
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

/**
 * Build the `must` clause for a text query. By default matches only the message
 * field; when `q.broadText` is set, matches the query as a phrase across the
 * message, `detail`, and `context.*` fields so error strings buried outside the
 * message (e.g. an AxiosError in `detail`) are still found (HOR-216).
 */
export function buildTextMust(
  q: LogQuery,
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): unknown[] {
  if (q.text === undefined) return [{ match_all: {} }];
  if (q.broadText === true) {
    const fields = [mapping.messageField];
    if (mapping.messageFallbackField !== undefined) fields.push(mapping.messageFallbackField);
    fields.push('detail', 'context.*');
    return [{ multi_match: { query: q.text, fields, type: 'phrase', lenient: true } }];
  }
  return [{ match: { [mapping.messageField]: q.text } }];
}

export function buildSearchBody(
  q: LogQuery,
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): Record<string, unknown> {
  const filters: unknown[] = [];

  if (q.level !== undefined) {
    filters.push(buildLevelFilter(mapping, q.level));
  }

  if (q.from !== undefined || q.to !== undefined) {
    const rangeClause: Record<string, string> = {};
    if (q.from !== undefined) rangeClause['gte'] = q.from;
    if (q.to !== undefined) rangeClause['lte'] = q.to;
    filters.push({ range: { [mapping.timestampField]: rangeClause } });
  }

  if (q.service !== undefined) {
    filters.push({ term: { [serviceTermField(mapping)]: q.service } });
  }

  filters.push(...buildWhereFilters(q.where));

  const mustClause = buildTextMust(q, mapping);

  return {
    query: {
      bool: {
        filter: filters,
        must: mustClause,
      },
    },
    sort: [{ [mapping.timestampField]: { order: 'desc' } }],
    size: q.limit ?? 50,
  };
}

export function buildErrorAggBody(
  q: LogQuery,
  field: string,
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): Record<string, unknown> {
  const filters: unknown[] = [];

  // Force level >= error unless q.level is set higher.
  const minLevel: LogLevel =
    q.level !== undefined && levelToValue(q.level) > 50 ? q.level : 'error';
  filters.push(buildLevelFilter(mapping, minLevel));

  if (q.from !== undefined || q.to !== undefined) {
    const rangeClause: Record<string, string> = {};
    if (q.from !== undefined) rangeClause['gte'] = q.from;
    if (q.to !== undefined) rangeClause['lte'] = q.to;
    filters.push({ range: { [mapping.timestampField]: rangeClause } });
  }

  if (q.service !== undefined) {
    filters.push({ term: { [serviceTermField(mapping)]: q.service } });
  }

  if (q.eventCode !== undefined) {
    filters.push({ term: { [signatureTermField(mapping)]: q.eventCode } });
  }

  filters.push(...buildWhereFilters(q.where));

  // Use the mapping's keyword-aware term field when the field matches the
  // configured eventCodeField; otherwise fall back to appending .keyword
  // (for explicit field overrides from callers that pre-date HOR-47).
  const aggField =
    field === mapping.eventCodeField ? signatureTermField(mapping) : `${field}.keyword`;

  return {
    size: 0,
    query: {
      bool: {
        filter: filters,
        must: buildTextMust(q, mapping),
      },
    },
    aggs: {
      by_key: {
        terms: {
          field: aggField,
          size: 20,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Hit normalization
// ---------------------------------------------------------------------------

function resolveLevelFromSource(
  src: Record<string, unknown>,
  m: ElasticsearchFieldMapping,
): { levelValue: number; level: LogLevel } {
  const raw = getField(src, m.levelField);
  if (m.levelFormat === 'numeric') {
    if (typeof raw === 'number') {
      return { levelValue: raw, level: valueToLevel(raw) };
    }
    if (typeof raw === 'string') {
      const n = Number(raw);
      if (!Number.isNaN(n)) return { levelValue: n, level: valueToLevel(n) };
      const mapped = LEVEL_VALUE[raw.toLowerCase() as LogLevel];
      if (mapped !== undefined) {
        return { levelValue: mapped, level: raw.toLowerCase() as LogLevel };
      }
    }
  } else {
    if (typeof raw === 'string') {
      const lower = raw.toLowerCase() as LogLevel;
      const val = LEVEL_VALUE[lower];
      if (val !== undefined) return { levelValue: val, level: lower };
    }
  }
  // Graceful fallbacks for Meritt shape when a non-standard mapping is in use
  if (typeof src['level'] === 'number') {
    const lv = src['level'];
    return { levelValue: lv, level: valueToLevel(lv) };
  }
  if (typeof src['log_level'] === 'string') {
    const ll = src['log_level'] as string;
    const lower = ll.toLowerCase() as LogLevel;
    const val = LEVEL_VALUE[lower];
    if (val !== undefined) return { levelValue: val, level: lower };
  }
  return { levelValue: 30, level: 'info' };
}

export function normalizeHit(
  hit: unknown,
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): LogRecord {
  const h = hit as Record<string, unknown>;
  const src = (h['_source'] ?? {}) as Record<string, unknown>;

  // getField handles both flattened keys ('service_name', '@timestamp') and
  // nested ECS objects ('service.name', 'log.level', 'trace.id').

  // Timestamp: use configured field, fall back to common alternatives.
  const tsRaw = getField(src, mapping.timestampField);
  const timestamp =
    typeof tsRaw === 'string'
      ? tsRaw
      : typeof src['@timestamp'] === 'string'
        ? (src['@timestamp'] as string)
        : typeof src['time'] === 'string'
          ? (src['time'] as string)
          : '';

  const { levelValue, level } = resolveLevelFromSource(src, mapping);

  // Message: use configured field, then fallback, then 'msg'.
  const msgRaw = getField(src, mapping.messageField);
  const msgFbRaw =
    mapping.messageFallbackField !== undefined
      ? getField(src, mapping.messageFallbackField)
      : undefined;
  const message =
    typeof msgRaw === 'string'
      ? msgRaw
      : typeof msgFbRaw === 'string'
        ? msgFbRaw
        : typeof src['msg'] === 'string'
          ? (src['msg'] as string)
          : '';

  const svcRaw = getField(src, mapping.serviceField);
  const service = typeof svcRaw === 'string' ? svcRaw : undefined;

  const component =
    typeof src['component'] === 'string'
      ? src['component']
      : typeof src['log_logger'] === 'string'
        ? src['log_logger']
        : undefined;

  const ecRaw = getField(src, mapping.eventCodeField);
  const eventCode =
    typeof ecRaw === 'string'
      ? ecRaw
      : typeof src['code'] === 'string'
        ? src['code']
        : undefined;

  // Trace ID: check configured field (using getField for nested ECS paths),
  // then fall back to parsing a serialised context blob (legacy Meritt pattern).
  let traceId: string | undefined;
  if (mapping.traceIdField !== undefined) {
    const raw = getField(src, mapping.traceIdField);
    if (typeof raw === 'string') traceId = raw;
  }
  if (traceId === undefined) {
    const ctxRaw = src['context'];
    if (typeof ctxRaw === 'string') {
      try {
        const parsed = JSON.parse(ctxRaw) as Record<string, unknown>;
        const tid = parsed['traceId'] ?? parsed['trace_id'];
        if (typeof tid === 'string') traceId = tid;
      } catch {
        // not parseable — leave undefined
      }
    }
  }

  let requestId: string | undefined;
  if (mapping.requestIdField !== undefined) {
    const raw = getField(src, mapping.requestIdField);
    if (typeof raw === 'string') requestId = raw;
  }

  const host =
    typeof src['hostname'] === 'string'
      ? src['hostname']
      : typeof src['host_name'] === 'string'
        ? src['host_name']
        : undefined;

  // Structured context: an object directly, or a JSON string the logger serialised.
  // Surfaced so raw output can show the fields that actually identify a failure
  // (entity ids, error strings) instead of just the generic message (HOR-215).
  let context: Record<string, unknown> | undefined;
  const ctxRaw = src['context'];
  if (ctxRaw !== null && typeof ctxRaw === 'object' && !Array.isArray(ctxRaw)) {
    context = ctxRaw as Record<string, unknown>;
  } else if (typeof ctxRaw === 'string') {
    try {
      const parsed = JSON.parse(ctxRaw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        context = parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON — leave context undefined
    }
  }

  // `detail`: where some loggers bury the real error (e.g. AxiosError / ENOTFOUND).
  const detailRaw = getField(src, 'detail');
  const detail =
    typeof detailRaw === 'string'
      ? detailRaw
      : detailRaw !== null && typeof detailRaw === 'object'
        ? safeStringify(detailRaw)
        : undefined;

  const index = typeof h['_index'] === 'string' ? h['_index'] : '';

  return {
    timestamp,
    level,
    levelValue,
    message,
    service,
    component,
    eventCode,
    traceId,
    requestId,
    host,
    ...(context !== undefined ? { context } : {}),
    ...(detail !== undefined ? { detail } : {}),
    index,
    raw: src,
  };
}

/** Compact one-line JSON, defensively bounded. Returns undefined on failure. */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Raw context display (HOR-215)
// ---------------------------------------------------------------------------

export interface ContextField {
  key: string;
  value: string;
}

/** Stringify a scalar context value for display; objects/arrays compacted. */
function displayValue(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return safeStringify(v);
}

/**
 * Flatten a record's structured fields (eventCode + context.* + detail) into an
 * ordered, displayable key/value list for `horus logs --raw` (HOR-215). One level
 * deep — nested objects are compacted to JSON. Empty/blank values are skipped.
 */
export function extractContextFields(record: LogRecord, limit = 16): ContextField[] {
  const out: ContextField[] = [];
  const seen = new Set<string>();
  const push = (key: string, raw: unknown) => {
    if (out.length >= limit || seen.has(key)) return;
    const value = displayValue(raw);
    if (value === undefined || value.trim() === '') return;
    seen.add(key);
    out.push({ key, value });
  };

  if (record.eventCode !== undefined) push('code', record.eventCode);
  if (record.context !== undefined) {
    for (const [k, v] of Object.entries(record.context)) {
      // traceId/requestId already shown via their own columns when present.
      if (k === 'traceId' || k === 'trace_id') continue;
      push(k, v);
    }
  }
  if (record.detail !== undefined) push('detail', record.detail);
  return out;
}

export function hitsToRecords(
  searchResponse: unknown,
  mapping: ElasticsearchFieldMapping = MERITT_FIELD_MAPPING,
): LogRecord[] {
  const res = searchResponse as Record<string, unknown>;
  const hits = res['hits'] as Record<string, unknown> | undefined;
  const hitsArr = (hits?.['hits'] ?? []) as unknown[];
  return hitsArr.map((h) => normalizeHit(h, mapping));
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export function aggToErrorBuckets(searchResponse: unknown): ErrorBucket[] {
  const res = searchResponse as Record<string, unknown>;
  const aggs = res['aggregations'] as Record<string, unknown> | undefined;
  const byKey = aggs?.['by_key'] as Record<string, unknown> | undefined;
  const buckets = (byKey?.['buckets'] ?? []) as Array<Record<string, unknown>>;
  return buckets.map((b) => ({
    key: typeof b['key'] === 'string' ? b['key'] : String(b['key'] ?? ''),
    count: typeof b['doc_count'] === 'number' ? b['doc_count'] : 0,
  }));
}

export function computeErrorDeltas(
  baseline: ErrorBucket[],
  current: ErrorBucket[],
): ErrorDelta[] {
  const allKeys = new Set<string>();
  for (const b of baseline) allKeys.add(b.key);
  for (const c of current) allKeys.add(c.key);

  const baselineMap = new Map<string, number>(baseline.map((b) => [b.key, b.count]));
  const currentMap = new Map<string, number>(current.map((c) => [c.key, c.count]));

  const deltas: ErrorDelta[] = [];
  for (const key of allKeys) {
    const b = baselineMap.get(key) ?? 0;
    const c = currentMap.get(key) ?? 0;
    const delta = c - b;
    const ratio = b === 0 ? (c > 0 ? Infinity : 0) : c / b;
    deltas.push({ key, baseline: b, current: c, delta, ratio });
  }

  deltas.sort((a, b) => b.delta - a.delta);
  return deltas;
}

// ---------------------------------------------------------------------------
// Evidence conversion
// ---------------------------------------------------------------------------

/**
 * Recursively redact secret-bearing string leaves in a structured value.
 * Logger `context` is commonly nested (`context.error.url`, request config, driver
 * details), so a top-level-only pass leaves secrets in nested objects/arrays that
 * still survive into `JSON.stringify(payload)` and flow to reports/AI input. Walks
 * objects and arrays, redacting every string leaf; non-string scalars pass through.
 * Context originates from Elasticsearch `_source` (already JSON), so it is acyclic.
 */
function deepRedactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(deepRedactSecrets);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepRedactSecrets(v)]),
    );
  }
  return value;
}

export function logsToEvidence(
  records: LogRecord[],
  query: string,
  collectedAt: string,
): Evidence[] {
  return records.map((r, i) => {
    const componentOrService = r.component ?? r.service ?? '';
    // Raw log messages go straight into the title — redact like the other providers do.
    const title = redactSecrets(`[${r.level}] ${componentOrService}: ${r.message}`).slice(0, 160);

    const relevance =
      r.level === 'fatal'
        ? 1
        : r.level === 'error'
          ? 0.9
          : r.level === 'warn'
            ? 0.6
            : 0.3;

    // The payload persists in the report and feeds AI input — the secret scrubbed
    // from the title must not survive in the record's string fields. `raw` (the
    // full ES _source, message included) is dropped: nothing reads it from
    // evidence payloads, and it can't be redacted without mangling its shape.
    const { raw: _raw, ...rest } = r;
    const payload = {
      ...rest,
      message: redactSecrets(r.message),
      ...(r.detail !== undefined ? { detail: redactSecrets(r.detail) } : {}),
      ...(r.context !== undefined
        ? { context: deepRedactSecrets(r.context) as Record<string, unknown> }
        : {}),
    };

    return {
      id: `ev_log_${i}`,
      source: 'logs' as const,
      kind: 'log' as const,
      title,
      timestamp: r.timestamp,
      relevance,
      payload,
      links: { traceId: r.traceId, requestId: r.requestId },
      provenance: { query, collectedAt },
    };
  });
}

export function errorBucketsToEvidence(
  buckets: ErrorBucket[],
  field: string,
  query: string,
  collectedAt: string,
): Evidence[] {
  return buckets.map((b, i) => ({
    id: `ev_logagg_${i}`,
    source: 'logs' as const,
    kind: 'log' as const,
    title: `${b.count}x ${field}=${b.key}`,
    relevance: Math.min(1, b.count / 100),
    payload: { field, ...b },
    links: {},
    provenance: { query, collectedAt },
  }));
}
