/**
 * The deterministic investigation pipeline (HOR-5). NO AI/LLM.
 *
 * Given a free-text hint, it resolves seed symbols via the code provider, gathers
 * structural context (callers/callees, impact blast radius, execution flows, queue
 * boundaries, and optionally a change range), distills typed Evidence, derives
 * deterministic findings + ranked suspected causes, and persists everything.
 *
 * Determinism is a hard requirement: identical inputs and provider responses must
 * produce the same report (modulo generated UUIDs and timestamps).
 */

import type {
  ChangeSet,
  Evidence,
  EvidenceKind,
  EvidenceLinks,
  EvidenceSubject,
  ImpactResult,
  ProviderKind,
  Symbol,
  SymbolContext,
  Flow,
} from '@horus/core';
import type {
  CodeProvider,
  GitCommit,
  LogsProvider,
  LogAnalysis,
  StateProvider,
  StateAnalysis,
  QueueRuntimeProvider,
  QueueRuntimeState,
  MetricsProvider,
  RedisStateProvider,
  RedisStateAnalysis,
  SentryProvider,
  AxiomProvider,
  ShopifyProvider,
  DurationDimensionOptions,
  DurationByDimension,
} from '@horus/connectors';
import { shortTs, selectStateSignals, tokenize, analyzeQueueRuntime } from '@horus/connectors';
import { formatSymbolLocation } from './render.js';
import { estimateOwnership } from './ownership.js';
import type { OwnershipEstimate } from './ownership.js';
import type { HorusDb, QueueEdge } from '@horus/db';
import {
  evidence as evidenceTable,
  findings as findingsTable,
  hypotheses as hypothesesTable,
  investigations as investigationsTable,
  listQueueEdges,
  listInvestigationsWithReports,
  eq,
} from '@horus/db';
import { buildGraph } from './graph.js';
import { buildCauseChains } from './cause-chain.js';
import { rankCauses, selectHeadlineCause, type CauseInput, type CauseCandidate } from './score-cause.js';
import { detectDataFlowCauseAcross } from './detect-data-flow-cause.js';
import { selectHintMatchedSignal } from './hint-matched-signal.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';
import { recallSimilar, storeIncidentMemory, deriveTags } from './memory.js';
import type { AuditCtx, MemoryStore } from './memory-store.js';
import {
  autoInvestigationMemoryEnabled,
  captureInvestigationMemory,
} from './auto-investigation-memory.js';
import { detectMissingEvidence, gapNextActions, type ConnectorFlags } from './gaps.js';
import { route } from './router.js';
import { buildRuntimeSourceStatus } from './source-status.js';
import type {
  InvestigationInput,
  InvestigationReport,
  BehavioralWalkthrough,
  ReportFinding,
} from './types.js';
import { buildTimeline } from './timeline.js';
import { correlate } from './correlate.js';
import { rankSeeds, isTypeLikeName, executableBaseName, parseSeedQualifier, parseNamedSymbols } from './seeds.js';
import { normalizeEvidence } from './normalize.js';
import { computeWeightedEvidenceConfidence } from './confidence.js';
import {
  collectGitChanges,
  defaultChangeWindowSince,
  DEFAULT_CHANGE_WINDOW_DAYS,
  classifyConfigChangeFiles,
} from './git-collector.js';
import type { BoundedGitChange, ConfigChangeFile } from './git-collector.js';

/** Dependencies the engine needs: a code provider and a database handle. */
export interface EngineDeps {
  /**
   * Source-intelligence provider. Optional (HOR-319 layer-2): when null/absent the
   * engine runs a degraded, RUNTIME-ONLY investigation — no seed resolution, no
   * structural evidence (context/impact/flows/changes/ownership), confidence capped.
   * The CLI passes null only after a down code host could not be self-healed.
   */
  code?: CodeProvider | null;
  db: HorusDb;
  /**
   * Optional learned reranker (HOR-404). Injected as a pure REORDER function so the engine never
   * imports the model layer (`@horus/eval`) — the dependency stays one-way. When supplied, it picks
   * the headline cause among the ALREADY-ELIGIBLE candidates (the ≥0.2 + seed-linked gates are
   * unchanged); it can NEVER promote an ineligible cause, alter finalScore/confidence/bands, or raise
   * any ceiling. Absent (the default) ⇒ headline selection is the hand-tuned finalScore argmax.
   */
  rerank?: (causes: readonly CauseCandidate[]) => CauseCandidate[];
  /** Optional Elasticsearch logs provider — when absent the investigation runs source-intelligence-only. */
  logs?: LogsProvider | null;
  /** Optional MongoDB state provider — folds application-state anomalies as evidence. */
  mongo?: StateProvider | null;
  /** Optional Postgres state provider — same state-evidence contract as `mongo`. */
  postgres?: StateProvider | null;
  /**
   * Optional Sentry error-evidence provider — folds grouped exceptions (issues) into the
   * same error-signature / directSignatures / seed path as Elasticsearch logs. Each issue
   * carries a direct code seed (top in-app stack frame). A configured-but-empty Sentry is
   * negative evidence, not a gap; one failing provider never aborts the investigation.
   */
  sentry?: SentryProvider | null;
  /**
   * Optional Axiom logs-evidence provider — folds structured log rows (APL query) into the
   * same log-evidence path as Elasticsearch / Sentry. A configured-but-empty Axiom is
   * negative evidence, not a gap; one failing provider never aborts the investigation.
   */
  axiom?: AxiomProvider | null;
  /**
   * Optional Shopify Admin evidence provider — runs caller-supplied (`input.shopifyQueries`)
   * or config-declared GraphQL queries verbatim and folds each result as `state` (or
   * `log`/`metric`) evidence. Present whenever auth is configured; it collects only when
   * queries are supplied. A configured-but-empty Shopify is negative evidence, not a gap;
   * one failing query never aborts the investigation.
   */
  shopify?: ShopifyProvider | null;
  /** Optional BullMQ queue runtime provider — folds queue depth/failure evidence. */
  queue?: QueueRuntimeProvider | null;
  /** Optional Redis state provider — folds cache/state/locks/rate-limit evidence (HOR-201). */
  redisState?: RedisStateProvider | null;
  /** Optional Grafana metrics provider — folds anomaly evidence + clears metrics gap (HOR-40). */
  metrics?: MetricsProvider | null;
  /** Absolute path to the local git repository — enables ownership estimation (HOR-40). */
  repoPath?: string;
  /**
   * Look-back window (in days) for the auto-derived git change window used when no explicit
   * `--since` is supplied (HOR-333). Defaults to {@link DEFAULT_CHANGE_WINDOW_DAYS}. Overridable
   * so a caller can widen/narrow the default; ignored when `input.since` is set.
   */
  changeWindowDays?: number;
  /** Which connectors are configured for the env — drives honest gap text. */
  connectors?: ConnectorFlags;
  /**
   * Optional authored-memory store (HOR-432). When supplied, every investigation auto-captures a
   * `kind:investigation` memory and links recurrences (`recurs-with`). Best-effort + CONTEXT-ONLY:
   * the memory is never read by the confidence/verdict scoring path, and a failure never blocks the
   * report. Absent ⇒ auto-memory is skipped gracefully (no API break).
   */
  store?: MemoryStore;
}

/** Map an evidence kind to its originating provider. */
function sourceForKind(kind: EvidenceKind): ProviderKind {
  switch (kind) {
    case 'queue-edge':
    case 'queue-state':
      return 'queue';
    case 'commit':
      return 'history';
    case 'log':
      return 'logs';
    case 'metric':
      return 'metrics';
    case 'redis-key':
    case 'state':
      return 'state';
    default:
      return 'code';
  }
}

/**
 * The entity under investigation, derived from the investigation scope (Stage 0).
 * Returns `undefined` (inert) when neither a service nor an environment is given —
 * a subject field is emitted only with a real value, never fabricated. Used to
 * stamp the report subject and, via `normalizeEvidence`, each evidence item.
 */
function investigationSubject(input: InvestigationInput): EvidenceSubject | undefined {
  const subject: EvidenceSubject = {};
  if (input.service !== undefined && input.service !== '') subject.service = input.service;
  if (input.environment !== undefined && input.environment !== '') {
    subject.environment = input.environment;
  }
  return subject.service !== undefined || subject.environment !== undefined ? subject : undefined;
}

/** Clamp a number into the inclusive [0, 1] range. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Severity tiers for a seed-emitted runtime signal, highest first. Used to rank and label
// cross-signal joins by SEVERITY rather than raw count, so a frequent warning/debug code
// is never presented as "the likely failure" over a real error (dogfood GAP A).
const SEV_ERROR = 2;
const SEV_WARN = 1;
const SEV_INFO = 0;

// Symbol names too generic to identify a specific function — they must not be used to match
// queue-edge producers/workers (dogfood GAP G), or a foreign edge keyed by "constructor"
// matches any seed that has one.
const GENERIC_SYMBOL_NAMES = new Set<string>([
  '',
  'constructor',
  'unknown',
  'unknown-producer',
  'unknown-worker',
  'anonymous',
  'default',
]);

/**
 * Classify a seed-emitted code's severity. Prefers the captured ES log `level` (authoritative
 * and cross-repo), then the event_code prefix convention (E_/F_ = error, W_ = warn, D_/I_/T_
 * = debug/info), then message keywords. Returns {@link SEV_ERROR} for anything we cannot
 * positively classify as lower — so unprefixed real errors (e.g. `HTTP_FLT_001`, logged via
 * `logger.error`) keep their failure framing and only KNOWN warn/info codes are downgraded.
 */
export function seedEmittedSeverityTier(
  level: string | null | undefined,
  code: string,
  message: string | undefined,
): number {
  const lv = level?.toLowerCase();
  if (lv === 'error' || lv === 'fatal' || lv === 'critical') return SEV_ERROR;
  if (lv === 'warn' || lv === 'warning') return SEV_WARN;
  if (lv === 'info' || lv === 'debug' || lv === 'trace') return SEV_INFO;

  // No usable level — fall back to the event_code prefix convention.
  const m = /^([A-Z])_/.exec(code);
  const prefix = m?.[1];
  if (prefix === 'W') return SEV_WARN;
  if (prefix === 'D' || prefix === 'I' || prefix === 'T') return SEV_INFO;
  if (prefix === 'E' || prefix === 'F' || prefix === 'C') return SEV_ERROR;

  // No prefix — last-resort message keywords; positive-evidence downgrade only.
  const text = `${code} ${message ?? ''}`.toLowerCase();
  if (/\b(skip|skipping|skipped|deprecat|info|debug|trace|notice)\b/.test(text)) return SEV_INFO;
  if (/\bwarn(ing)?\b/.test(text)) return SEV_WARN;

  // Unknown — treat as an error so we never silently downgrade a real failure.
  return SEV_ERROR;
}

/**
 * Bind the overall-confidence CEILING to the headline suspected cause's finalScore
 * (HOR-336 extended). Overall confidence must track DIAGNOSIS strength: a weak
 * "observation" cause cannot license a high headline number just because a seed
 * localized + lots of evidence accrued.
 *
 * The mapping is MONOTONIC (higher cause score → higher allowed confidence) and is
 * applied as a Math.min ceiling by the caller — it never raises confidence:
 *   score < 0.20        → 0.60  (sub-threshold; "localized, cause unknown" — HOR-336)
 *   score in [0.20,0.50)→ 0.60 … 0.78 (a modest cause caps to the upper-mid range)
 *   score in [0.50,0.85)→ 0.78 … 1.00 (a strong cause permits high confidence)
 *   score >= 0.85       → 1.00  (no additional ceiling from the cause)
 */
export function confidenceCeilingForCause(score: number): number {
  const s = clamp01(score);
  if (s < 0.2) return 0.6;
  if (s < 0.5) {
    // [0.20,0.50) → [0.60,0.78]
    return 0.6 + ((s - 0.2) / (0.5 - 0.2)) * (0.78 - 0.6);
  }
  if (s < 0.85) {
    // [0.50,0.85) → [0.78,1.00]
    return 0.78 + ((s - 0.5) / (0.85 - 0.5)) * (1.0 - 0.78);
  }
  return 1.0;
}

/** Heuristic relevance per kind, kept deterministic. */
function relevanceForKind(kind: EvidenceKind): number {
  switch (kind) {
    case 'symbol':
      return 0.9;
    case 'impact':
      return 0.7;
    case 'queue-edge':
      return 0.75;
    case 'flow':
      return 0.6;
    case 'commit':
      return 0.65;
    case 'log':
      return 0.5;
    default:
      return 0.5;
  }
}

/**
 * Classify a thrown connector error into a short, leak-safe failure category.
 * Returns ONLY the category — never the raw message — because raw connector
 * errors embed hosts/ports/URLs ('connect ECONNREFUSED 127.0.0.1:6379') and
 * the category flows into the persisted report (gap.why, sourceStatus.detail).
 */
export function connectorFailureReason(err: unknown): string {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const text = [
    typeof e?.name === 'string' ? e.name : '',
    typeof e?.message === 'string' ? e.message : '',
  ].join(' ');
  if (/abort|timed?\s*out|timeout|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|fetch failed/i.test(text)) {
    return 'connection failed';
  }
  // All HTTP connector clients throw `<Name> <METHOD> <path> -> <status>: <body>`;
  // classify from that anchored status FIRST so URL/path/body content (a PromQL
  // expr containing "auth", a "401" in an index name) can never override it.
  // `HTTP <status>` (no arrow) covers driver-style messages.
  const status = (/->\s*(?:HTTP\s+)?(\d{3})\b/.exec(text) ?? /\bHTTP\s+(\d{3})\b/.exec(text))?.[1];
  if (status !== undefined) {
    if (status === '401' || status === '403') return 'auth failure';
    if (status === '429') return 'rate limited';
    if (status.startsWith('5')) return 'server error';
    return 'request failed';
  }
  // Keyword fallbacks for non-HTTP errors (DB/queue drivers). Bare "auth" and
  // unanchored status digits are deliberately absent — too collision-prone.
  if (/unauthoriz|forbidden|WRONGPASS|NOAUTH|authenticat|invalid[^']*(token|key|credential|password)/i.test(text)) {
    return 'auth failure';
  }
  if (/rate.?limit|too many requests/i.test(text)) return 'rate limited';
  if (/internal server error/i.test(text)) return 'server error';
  return 'request failed';
}

/**
 * Compute the start of the log query window from `since`.
 * Accepts duration strings like 24h, 7d, 30m, 90s; anything else defaults to
 * 7 days ago. Returns an ISO-8601 timestamp.
 */
export function logWindowFrom(since: string | undefined): string {
  const DURATION_RE = /^(\d+)([smhd])$/;
  const now = Date.now();
  if (since !== undefined) {
    const m = DURATION_RE.exec(since.trim());
    if (m !== null) {
      const value = Number(m[1]);
      const unit = m[2] as 's' | 'm' | 'h' | 'd';
      const msMap: Record<typeof unit, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
      };
      return new Date(now - value * msMap[unit]).toISOString();
    }
  }
  // Default: 7 days ago
  return new Date(now - 7 * 86_400_000).toISOString();
}

export type LogRelevanceClass = 'direct' | 'ambient';

/**
 * Classify a log signature's relevance to the investigation seed (HOR-156).
 *
 * A signature is 'direct' when its key or affected services share tokens with
 * the seed name, hint, or service.  Everything else is 'ambient' — real
 * production noise, but unrelated to the thing being investigated.
 */
export function classifyLogRelevance(
  sigKey: string,
  sigServices: string[],
  seedTerms: string[],
  inputService: string | undefined,
): { relevanceClass: LogRelevanceClass; relevanceReason: string } {
  // Generic error/severity words ("error", "errors", "failing") appear in EVERY error
  // signature, so matching on them marks every unrelated error "direct" — narrating a
  // louder error from another service onto this seed/path (HOR-338). Relevance must come
  // from DOMAIN terms, not the word "error".
  const GENERIC_TERMS = new Set([
    'error', 'errors', 'err', 'fail', 'failed', 'failing', 'failure', 'exception',
    'exceptions', 'crash', 'crashing', 'issue', 'problem', 'slow', 'timeout', 'broken',
    'down', 'production', 'prod', 'staging',
  ]);
  const domainTerms = seedTerms.filter((t) => !GENERIC_TERMS.has(t));
  if (domainTerms.length === 0) {
    return { relevanceClass: 'direct', relevanceReason: 'no specific seed context — included by default' };
  }

  const keyTokens = tokenize(sigKey);
  const serviceTokens = sigServices.flatMap((s) => tokenize(s));
  const combined = [...keyTokens, ...serviceTokens];

  const matchingTerms = domainTerms.filter(
    (t) => combined.some((c) => c.includes(t) || t.includes(c)),
  );

  if (matchingTerms.length > 0) {
    return {
      relevanceClass: 'direct',
      relevanceReason: `matches seed terms: ${matchingTerms.slice(0, 3).join(', ')}`,
    };
  }

  // Service-scoped: if the log's services match the input service, treat as direct
  if (
    inputService &&
    sigServices.some((s) => s.toLowerCase().includes(inputService.toLowerCase()))
  ) {
    return {
      relevanceClass: 'direct',
      relevanceReason: `from configured service: ${inputService}`,
    };
  }

  return {
    relevanceClass: 'ambient',
    relevanceReason: 'no structural link to seed — ambient runtime noise',
  };
}

/** Axiom row field names that hold the log message body, in priority order (HOR-429). */
const AXIOM_MESSAGE_FIELDS = ['message', 'msg', 'body', 'event', 'log', '_raw'];
/** Axiom row field names that hold the log level/severity, in priority order (HOR-429). */
const AXIOM_LEVEL_FIELDS = ['level', 'severity', 'lvl', 'loglevel', 'status'];
/** Axiom row field names that hold the originating service/logger, in priority order. */
const AXIOM_SERVICE_FIELDS = ['service', 'app', 'logger', 'source', 'namespace'];

/** Pick the first present, non-empty string-ish value among `candidates` from a row. */
function pickAxiomField(
  fields: Record<string, unknown>,
  candidates: string[],
): string | undefined {
  for (const key of candidates) {
    const v = fields[key];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/**
 * Extract code-shaped tokens (meritt `event_code` values like HTTPFLT001 or
 * E_FULFILLMENT_SYNC_ERROR_04) from free text — the hint, a seed name, or seed
 * source. An event_code is BOTH a source raise-signature (a string literal) AND a
 * structured Elasticsearch field, so a code named by the seed/hint can be JOINED
 * to ES even when it isn't a top-N error aggregation bucket (the "no logs" vs 438
 * HTTPFLT001 errors miss). Match shape: an UPPER_SNAKE/alnum token of length ≥4
 * that contains at least one digit or underscore (so plain words like "ERROR" or
 * "FETCH" are excluded but "HTTPFLT001"/"E_SYNC_04" qualify). De-duplicated,
 * original order preserved.
 */
export function extractEventCodes(...texts: (string | undefined)[]): string[] {
  const RE = /\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b/g;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (text === undefined || text === '') continue;
    for (const m of text.matchAll(RE)) {
      const code = m[0];
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
  }
  return out;
}

/**
 * Detect context field names that look like entity identifiers worth aggregating
 * (HOR-215) — brand_id, order_id, userId, etc. Used to surface "16 brands × 50
 * orders affected" instead of only an error-signature count. Returns at most
 * `limit` field names, in object order, with scalar values only.
 */
export function detectEntityFields(
  context: Record<string, unknown> | undefined,
  limit = 2,
): string[] {
  if (context === undefined) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === null || (typeof v !== 'string' && typeof v !== 'number')) continue;
    const looksLikeId =
      /(^|_)ids?$/i.test(k) ||
      /id$/.test(k) ||
      /^(brand|order|user|customer|account|tenant|shop|merchant|product|seller)/i.test(k);
    if (looksLikeId) {
      out.push(k);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Result of seeding an investigation from a log match instead of the hint (HOR-216). */
export interface LogReseed {
  seeds: Symbol[];
  /** Human note: what the hint matched in logs and which symbol it resolved to. */
  note: string;
  /** The component the matching log named, if any. */
  component?: string;
  /** The event_code the matching log carried, if any. */
  eventCode?: string;
}

/**
 * Fallback seed resolution for raw error-string hints (HOR-216).
 *
 * When the hint matches no source symbol, search the logs for it across message +
 * detail + context.* (broadText), then back-resolve the matching log's component to
 * a source symbol so a normal structural investigation can proceed. Returns null
 * when logs are unavailable, nothing matches, or no component resolves to a symbol.
 */
export async function reseedFromLogs(
  hint: string,
  input: InvestigationInput,
  deps: EngineDeps,
): Promise<LogReseed | null> {
  if (!deps.logs || typeof deps.logs.searchLogs !== 'function') return null;
  // Back-resolving a log component to a symbol needs source intelligence; in degraded
  // runtime-only mode (no code provider) there is nothing to reseed against.
  if (!deps.code) return null;
  const code = deps.code;
  try {
    const from = logWindowFrom(input.logsSince ?? input.since);
    const records = await deps.logs.searchLogs({
      text: hint,
      broadText: true,
      from,
      limit: 5,
      service: input.service,
    });
    if (records.length === 0) return null;

    // Components are the most likely class/file names to resolve to a symbol.
    const candidates = [...new Set(records.map((r) => r.component).filter((c): c is string => !!c))];
    for (const name of candidates) {
      const syms = await code.searchSymbols(name, 5);
      if (syms.length > 0) {
        const rankedSeeds = rankSeeds(syms, [...new Set(tokenize(name))]);
        const first = records[0];
        const componentLabel = first?.component ?? 'log entry';
        const codeLabel = first?.eventCode ? ` (${first.eventCode})` : '';
        const seedName = rankedSeeds[0]?.symbol.name ?? name;
        return {
          seeds: rankedSeeds.map((r) => r.symbol),
          note: `Hint matched no symbol; resolved via logs: ${componentLabel}${codeLabel} → ${seedName}`,
          ...(first?.component !== undefined ? { component: first.component } : {}),
          ...(first?.eventCode !== undefined ? { eventCode: first.eventCode } : {}),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Derive the confidence for the queue-runtime anomaly finding.
 * Exported for unit testing — logic must stay in sync with the inline usage below.
 *
 * Rule: starvation-only (no pure-backlog queues) → 0.65 (hedged single snapshot).
 * Any pure backlog or failure → 0.85 (higher certainty from depth counts).
 */
export function queueFindingConfidence(opts: {
  starvedCount: number;
  backloggedCount: number;
  failingCount: number;
}): number {
  const { starvedCount, backloggedCount, failingCount } = opts;
  return starvedCount > 0 && backloggedCount === 0 && failingCount === 0 ? 0.65 : 0.85;
}

/**
 * HOR-438: a per-segment queue STRUCTURE detected from queue-edge topology.
 * `baseName` is the shared logical job; `segments` are the distinct, segment-looking
 * suffixes it fans out to (markets/regions/tenants/shards/zones).
 */
export interface PerSegmentQueueStructure {
  baseName: string;
  segments: string[];
  count: number;
}

/** Segment delimiter used by per-segment queue naming (`MANAGE_SALES:KSA`). */
const SEGMENT_DELIMITER = ':';

/**
 * A segment suffix is a SHORT token — a region/market/tenant/shard/zone code such as
 * `KSA`, `UAE`, `US-EAST`, `eu1`, `tenant-a`, `shard3` — not an arbitrary long string.
 * This light sanity check keeps an incidental `:` (namespaced keys, URLs, timestamps)
 * from being read as a segment fan-out.
 */
const SEGMENT_SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

/**
 * HOR-438: detect a per-segment queue STRUCTURE from the queue-edge topology already
 * collected (Approach A — the most reliable signal; the data is already present).
 *
 * Many systems fan a single logical job out into one queue PER market/region/tenant/
 * shard/zone (e.g. `MANAGE_SALES:KSA`, `MANAGE_SALES:UAE`). When such a structure is
 * present, an anomaly on one segment is far more likely EXPECTED per-segment variance
 * than a uniform failure — so this is a real, CODE-GROUNDED support for the
 * benign-variance hypothesis. It is never a verdict on its own.
 *
 * Detection: split each queue name on the `:` segment delimiter, group by the base name,
 * and flag a base when 2+ queues share it with DISTINCT, segment-looking suffixes.
 * False-positive guard: a single queue that merely contains a `:` is NOT a pattern — we
 * require ≥2 distinct segment suffixes on a shared base.
 */
export function detectPerSegmentQueues(
  queueHits: ReadonlyArray<Pick<QueueEdge, 'queueName'>>,
): PerSegmentQueueStructure[] {
  const byBase = new Map<string, Set<string>>();
  for (const { queueName } of queueHits) {
    if (typeof queueName !== 'string') continue;
    const idx = queueName.indexOf(SEGMENT_DELIMITER);
    // Need both a non-empty base (before the delimiter) and a non-empty suffix (after).
    if (idx <= 0 || idx >= queueName.length - 1) continue;
    const base = queueName.slice(0, idx).trim();
    const suffix = queueName.slice(idx + 1).trim();
    if (base === '' || suffix === '') continue;
    // Dimension-name sanity check: the suffix must LOOK like a segment code.
    if (!SEGMENT_SUFFIX_RE.test(suffix)) continue;
    const set = byBase.get(base) ?? new Set<string>();
    set.add(suffix);
    byBase.set(base, set);
  }
  const out: PerSegmentQueueStructure[] = [];
  for (const [baseName, segs] of byBase) {
    // False-positive guard: ≥2 DISTINCT segment suffixes sharing the SAME base.
    if (segs.size < 2) continue;
    const segments = [...segs].sort();
    out.push({ baseName, segments, count: segments.length });
  }
  // Deterministic order for stable evidence ids / output.
  out.sort((a, b) => a.baseName.localeCompare(b.baseName));
  return out;
}

/**
 * HOR-438b: a per-segment DISPATCH detected from the seed's CODE — a function whose
 * signature takes a SEGMENT DIMENSION parameter (market/region/tenant/shard/…) and is
 * therefore invoked once per segment (e.g. `manageSalesForMarket(marketType: MarketType)`
 * called per market). `symbol` is the seed; `paramName`/`paramType` are the segment-dimension
 * parameter that proves it; `fanOut` records how the per-segment invocation is corroborated
 * (a queue dispatch, a caller loop, or none — the param signal alone is sufficient).
 */
export interface PerSegmentDispatch {
  symbol: string;
  paramName: string;
  paramType: string;
  fanOut: 'queue' | 'caller-loop' | 'none';
  /** Which signal proved the segment dimension: the param NAME or its TYPE. */
  matchedBy: 'name' | 'type';
}

/**
 * Curated segment-dimension vocabulary. INTENTIONALLY TIGHT to avoid false positives: only
 * words that genuinely denote a per-segment processing axis (market/region/tenant/shard/…),
 * never generic data words. Used for both the param-NAME regex and the param-TYPE root set.
 */
const SEGMENT_DIM_NAME_RE =
  /\b(market|markets|region|regions|tenant|tenants|segment|shard|zone|locale|country|org|account)\b/i;
const SEGMENT_DIM_TYPE_ROOTS = new Set<string>([
  'market',
  'region',
  'tenant',
  'segment',
  'shard',
  'zone',
  'locale',
  'country',
  'org',
  'account',
]);
/**
 * Generic parameter names that must NEVER fire the detector even if they appear near a
 * segment word — a guard against reading an arbitrary `data`/`payload`/`id` as a segment axis.
 */
const GENERIC_DISPATCH_PARAM_NAMES = new Set<string>([
  'id',
  'data',
  'input',
  'item',
  'payload',
  'ctx',
  'context',
  'options',
  'opts',
  'args',
  'arg',
  'params',
  'param',
  'value',
  'val',
  'obj',
  'config',
  'req',
  'res',
]);

/** Top-level index of a delimiter char, ignoring `<> () [] {}` nesting. -1 if none. */
function topLevelIndexOf(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** Extract the parenthesized parameter list from a signature/source-body head. '' if none. */
function extractParamList(sig: string): string {
  const open = sig.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    const c = sig[i]!;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return sig.slice(open + 1, i);
    }
  }
  return '';
}

/** Split a parameter list on top-level commas (respecting generic/tuple/object nesting). */
function splitTopLevelParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of list) {
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim() !== '') out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * HOR-438 polish: a decorated parameter — TypeGraphQL `@Arg('name', ...)` or NestJS
 * `@Param('name')`/`@Query('name')`/`@Body('name')` — carries its REAL name in the decorator's
 * first quoted string. Return that clean name, or null when the param is not a decorated argument
 * (or the decorator has no quoted name, e.g. `@Body()`). This only affects the DISPLAYED paramName;
 * the segment-dimension match still runs on the same parsed name so firing is unchanged.
 */
const DECORATED_ARG_RE = /^@(?:Arg|Param|Query|Body)\s*\(\s*['"`]([^'"`]+)['"`]/;
function decoratedArgName(raw: string): string | null {
  const m = raw.trim().match(DECORATED_ARG_RE);
  return m ? m[1]! : null;
}

/** Strip leading parameter decorators (`@Arg(...) `, `@Body() `, …), respecting nested parens. */
function stripLeadingDecorators(s: string): string {
  let cur = s.trim();
  while (cur.startsWith('@')) {
    const m = cur.match(/^@[A-Za-z_]\w*/);
    if (!m) break;
    let i = m[0].length;
    while (i < cur.length && /\s/.test(cur[i]!)) i++;
    if (cur[i] === '(') {
      let depth = 0;
      let j = i;
      for (; j < cur.length; j++) {
        const c = cur[j]!;
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      cur = cur.slice(j).trim();
    } else {
      cur = cur.slice(i).trim();
    }
  }
  return cur;
}

/** Parse one parameter into {name, type}. Returns null for destructured/empty params. */
function parseParam(raw: string): { name: string; type: string } | null {
  let s = raw.trim();
  // Strip TS access modifiers and rest spread.
  s = s.replace(/^(?:public|private|protected|readonly)\s+/g, '').replace(/^\.\.\./, '');
  // Destructured params ({ a, b } / [a, b]) have no single name — skip (conservative).
  if (s.startsWith('{') || s.startsWith('[')) return null;
  // Capture the decorator's quoted name BEFORE stripping it (TypeGraphQL `@Arg('name', ...)`,
  // NestJS `@Param/@Query/@Body('name')`).
  const decorated = decoratedArgName(s);
  // Strip leading decorators so the identifier + type parse cleanly: a decorator body contains
  // `=>`, commas, and nested parens that confuse the top-level bracket scanner.
  const stripped = stripLeadingDecorators(s);
  const colon = topLevelIndexOf(stripped, ':');
  let namePart = colon >= 0 ? stripped.slice(0, colon) : stripped;
  let typePart = colon >= 0 ? stripped.slice(colon + 1) : '';
  // Drop default values on either side.
  const typeEq = topLevelIndexOf(typePart, '=');
  if (typeEq >= 0) typePart = typePart.slice(0, typeEq);
  const type = typePart.trim();

  let name: string;
  if (decorated !== null) {
    // Use the decorator's quoted name as the clean DISPLAY name — not the raw decorator text
    // (which previously leaked through as `@Arg('marketType', ()`).
    name = decorated;
  } else {
    const nameEq = namePart.indexOf('=');
    if (nameEq >= 0) namePart = namePart.slice(0, nameEq);
    name = namePart.replace(/\?$/, '').trim();
  }
  if (name === '') return null;
  return { name, type };
}

/** Insert spaces at camelCase / snake / kebab boundaries so `\bword\b` can match `marketType`. */
function deCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

/**
 * Leading PascalCase word of a type, lowercased — or null if the type is not a PascalCase
 * named type (primitives like `string`/`number`, or anything starting lowercase, return null).
 * `MarketType` -> `market`, `Region` -> `region`, `TenantId` -> `tenant`, `string` -> null.
 */
function pascalTypeRoot(type: string): string | null {
  const m = type.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!m) return null;
  const ident = m[1]!;
  if (!/^[A-Z]/.test(ident)) return null; // must be a PascalCase named type, not a primitive
  const word = ident.match(/^[A-Z][a-z0-9]*/);
  return (word ? word[0] : ident).toLowerCase();
}

/**
 * HOR-438b: detect that the seed is a per-segment DISPATCHER from its CODE alone — no
 * telemetry required. This is the sibling to {@link detectPerSegmentQueues} for the case the
 * queue-suffix detector cannot see: ONE logical queue, but the per-segment split lives in the
 * code (e.g. `manageSalesForMarket(marketType)` invoked once per market).
 *
 * PRIMARY (required): the seed signature has a parameter that is a SEGMENT DIMENSION — its
 * NAME matches the curated vocabulary (market/region/tenant/shard/zone/locale/country/org/
 * account), OR its TYPE is a segment-like PascalCase enum/alias whose root is a segment word
 * (`MarketType`, `Region`, `TenantId`). Generic params (id/data/input/payload/ctx/…) NEVER
 * fire. The param signal alone is sufficient to support benign-variance, modestly.
 *
 * STRENGTHEN (optional corroboration, recorded in `fanOut`): the seed is fanned out
 * per-segment — it appears as a producer/worker in the queue topology (per-key dispatch), or a
 * caller body loops over a segment collection and calls the seed. Corroboration is reported,
 * not required.
 *
 * HONESTY: this is a MODEST, code-grounded SUPPORT for benign-variance (a per-segment
 * processor naturally has per-segment duration variance), NEVER a verdict. Returns null unless
 * a clear segment-dimension param is present.
 */
export function detectPerSegmentDispatch(
  seedContext: SymbolContext,
  queueHits: ReadonlyArray<Pick<QueueEdge, 'queueName' | 'producerSymbol' | 'workerSymbol'>>,
  callers: ReadonlyArray<{ name?: string; sourceBody?: string }>,
): PerSegmentDispatch | null {
  const seedName = seedContext.symbol.name ?? '';
  // STEP 0 — signature source: prefer the dedicated `symbol.signature` field; otherwise parse
  // the signature from the START of the full source body (where the declaration always sits).
  const dedicated = seedContext.symbol.signature;
  const sig =
    dedicated !== undefined && dedicated.trim() !== ''
      ? dedicated
      : (seedContext.sourceBody ?? '').slice(0, 600);
  const paramList = extractParamList(sig);
  if (paramList === '') return null;

  // PRIMARY — find a segment-dimension parameter (by NAME or TYPE), never a generic one.
  let match: { name: string; type: string; by: 'name' | 'type' } | null = null;
  for (const p of splitTopLevelParams(paramList)) {
    const parsed = parseParam(p);
    if (parsed === null) continue;
    if (GENERIC_DISPATCH_PARAM_NAMES.has(parsed.name.toLowerCase())) continue;
    if (SEGMENT_DIM_NAME_RE.test(parsed.name) || SEGMENT_DIM_NAME_RE.test(deCamel(parsed.name))) {
      match = { ...parsed, by: 'name' };
      break;
    }
    const root = pascalTypeRoot(parsed.type);
    if (root !== null && SEGMENT_DIM_TYPE_ROOTS.has(root)) {
      match = { ...parsed, by: 'type' };
      break;
    }
  }
  if (match === null) return null;

  // STRENGTHEN — corroborate the per-segment fan-out (optional; param signal already fired).
  let fanOut: PerSegmentDispatch['fanOut'] = 'none';
  const inQueue =
    seedName !== '' &&
    queueHits.some(
      (q) =>
        (q.producerSymbol !== null && q.producerSymbol === seedName) ||
        (q.workerSymbol !== null && q.workerSymbol === seedName),
    );
  if (inQueue) {
    fanOut = 'queue';
  } else {
    const callerLoops = callers.some((c) => {
      const body = c.sourceBody ?? '';
      if (body === '') return false;
      const hasLoop = /\b(for|forEach|map|while)\b/.test(body);
      const overSegment = SEGMENT_DIM_NAME_RE.test(body);
      const callsSeed = seedName !== '' && body.includes(seedName);
      return hasLoop && overSegment && callsSeed;
    });
    if (callerLoops) fanOut = 'caller-loop';
  }

  return { symbol: seedName, paramName: match.name, paramType: match.type, fanOut, matchedBy: match.by };
}

/** Does `since` look like a range or a concrete ref worth diffing? */
export function looksDiffable(since: string): boolean {
  const s = since.trim();
  if (s.length === 0) return false;
  if (s.includes('..')) return true;
  // Duration strings like "24h", "7d", "30m", "90s" are log-window specifiers,
  // not git refs — exclude them so detectChanges is not called with a non-ref.
  if (/^\d+[smhd]$/i.test(s)) return false;
  // A bare ref (tag, branch, sha) or relative ref (HEAD~5, v1.2~3) is diffable.
  return /^[A-Za-z0-9._/~^-]+$/.test(s);
}

/**
 * HOR-385: the SINGLE source of truth for "this hint describes a live symptom /
 * incident". BOTH `looksExplanatory` (to demote a symptom-bearing interrogative out
 * of the explanatory walkthrough) and `classifyIntent` (to force the incident path
 * before any structural intent) consume this one constant, so the safety guard can
 * never drift into being narrower than the explanatory demotion list. Infra cues
 * (500/5xx/oom/panic/p95/p99/throttl/spike) are folded in here too. Word-boundary,
 * case-insensitive, NOT global (safe to reuse with `.test`).
 */
export const INCIDENT_SYMPTOM_RE =
  /\b(fail|fails|failed|failing|failure|break|breaks|breaking|broke|broken|crash|crashes|crashing|down|outage|incident|regress(?:ion|ed)?|degrad(?:e|ed|ing)?|slow|stuck|hang|hangs|hung|timeout|timing\s*out|latency|wrong|exception|error|errors|leak|leaking|stopped|throwing|throws|reject|rejected|denied|not\s+work|doesn'?t\s+work|isn'?t\s+work|can'?t|cannot|caus(?:e|es|ing)|misbehav|500|5xx|oom|out\s+of\s+memory|panic|p9[59]|throttl|spike|stack\s*trace|flap)/i;

/**
 * HOR-334: does the hint read as a behavioral "how does X work" question rather
 * than an incident report? Such hints want an explanation of a code path, not a
 * fault hunt — when there is no real incident signal, the investigation should
 * point the user at `horus explain <symbol>` instead of dumping empty incident
 * sections. Conservative: matches a how/what/why question paired with a
 * behavior/flow verb, or a leading interrogative/"explain".
 */
export function looksExplanatory(hint: string): boolean {
  const h = hint.trim();
  if (h.length === 0) return false;
  // Explicit explanation requests are always explanatory, even if they name an error path.
  if (/^\s*(explain|describe|walk\s+me\s+through|tell\s+me\s+(?:about|how))\b/i.test(h)) {
    return true;
  }
  // dogfood GAP E: a REGRESSION phrasing ("what recently changed", "what changed in X",
  // "did Y regress") is a change-diff hunt, never an explanation — the strongest guard, it
  // overrides the behavior pairing below (so "what changed in the auth flow" is NOT routed to
  // a walkthrough just because it says "flow").
  if (/\b(recently\s+changed|what\s+changed|changed\s+recently|regress|regression)\b/i.test(h)) {
    return false;
  }
  // Question/behavior pairing: "how does X work", "what happens when a payment fails",
  // "why does … flow". Explanatory even when a failure path is named.
  if (/\b(how|what|why|when|where)\b.*\b(work|works|working|do|does|done|happen|happens|flow|flows|behave|called|invoked|triggered|used)\b/i.test(h)) {
    return true;
  }
  // dogfood GAP E: a bare leading interrogative carrying SYMPTOM terms is an incident hunt,
  // not an explanation ("what is breaking", "why are products failing", "what's causing the
  // errors") — so it must NOT route to a behavioral walkthrough.
  if (INCIDENT_SYMPTOM_RE.test(h)) {
    return false;
  }
  // Bare leading interrogative with no fault terms: "what is the order pipeline".
  if (/^\s*(how|what|why|when|where)\b/i.test(h)) {
    return true;
  }
  return false;
}

/**
 * Gap 4 — does the hint read as a latency/performance question ("everything is slow",
 * "high latency")? Such a question needs runtime METRICS to answer — without a metrics
 * connector there is nothing structural to anchor to, so the report should say so rather
 * than seed an arbitrary symbol.
 */
export function looksPerformance(hint: string): boolean {
  return /\b(slow|slowness|sluggish|laggy|\blag\b|latency|perf|performance|throughput|degraded|degradation|response\s*time|p9[59])\b/i.test(
    hint,
  );
}

/**
 * HOR-435 (lever #2): does the hint read as a duration/latency/anomaly question that
 * warrants the INFO-level per-dimension duration breakdown? Broader than `looksPerformance`
 * — it also fires on bare "duration"/"took"/"anomaly"/"variance" wording so a "job duration
 * anomaly" hint (not literally "slow") still triggers the per-segment query.
 */
export function looksDurationThemed(hint: string): boolean {
  return (
    looksPerformance(hint) ||
    /\b(duration|took|elapsed|anomal(?:y|ies|ous)|spike|variance|regress(?:ion|ed)?|p\d{2})\b/i.test(
      hint,
    )
  );
}

/**
 * HOR-435 (lever #1, de-anchor): parse the alert/hint TEXT for *suggested* causes — phrases
 * like "could indicate X", "may be a Y", "suggests Z", "possibly", "likely caused by",
 * "points to", "consistent with" — and map them to hypothesis categories. The returned
 * categories are CONTEXT ONLY: the hypothesis layer must NOT raise their prior off this signal
 * (alert text is never a confidence prior). The point is the opposite of anchoring — we name
 * what the alert proposed precisely so the engine can de-anchor and demand independent evidence
 * before any of them earns confidence. Returns [] when the text carries no suggestive framing.
 */
export function parseSuggestedCauses(hint: string): string[] {
  // Only treat keywords as *suggested causes* when the text frames them as a guess. A bare
  // symptom ("orders are slow") names no cause; "slow — could indicate a DB issue" does.
  const SUGGESTIVE =
    /\b(could indicate|may be|might be|maybe|possibly|suggest(?:s|ing|ed)?|likely (?:caused|due)|points? to|consistent with|indicat(?:es|ive)|appears? to be|seems? to be|probably)\b/i;
  if (!SUGGESTIVE.test(hint)) return [];

  // category → cue words. Conservative: only well-known incident vocabulary maps to a category.
  const CATEGORY_CUES: Array<[string, RegExp]> = [
    ['deployment-regression', /\b(deploy(?:ment|ed)?|release|rollout|regression|recent change|shipped)\b/i],
    ['infrastructure', /\b(database|db|infra(?:structure)?|network|cache|disk|memory|cpu|oom|out of memory|connection pool|datastore|redis|mongo|postgres)\b/i],
    ['external-api-latency', /\b(upstream|external api|third[- ]party|downstream|api latency|timeout|slow (?:api|service)|gateway)\b/i],
    ['retry-storm', /\b(retr(?:y|ies)|retry storm|thundering herd|amplif)/i],
    ['queue-backlog', /\b(queue|backlog|consumer lag|enqueue)\b/i],
    ['worker-slowdown', /\b(worker|consumer)\b/i],
    ['benign-variance', /\b(per[- ]segment|per[- ]region|skew(?:ed)?|variance|expected variation|noise)\b/i],
  ];
  const out: string[] = [];
  for (const [category, cue] of CATEGORY_CUES) {
    if (cue.test(hint)) out.push(category);
  }
  return out;
}

/**
 * HOR-435 (lever #2): format a millisecond duration as a compact human string
 * ("2m10s", "19ms", "1.5s", "1h2m"). Used in the `Duration by <dimension>` evidence row.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    const s = Math.round(totalSec * 10) / 10;
    return `${s}s`;
  }
  const totalMin = Math.floor(totalSec / 60);
  const remSec = Math.round(totalSec % 60);
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin}m${remSec}s` : `${totalMin}m`;
  }
  const h = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  return remMin > 0 ? `${h}h${remMin}m` : `${h}h`;
}

/**
 * HOR-385: the deterministic structural-intent surface.
 *   - `incident`      → the default; full runtime evidence, regression hypotheses
 *                       and confidence ceilings all apply.
 *   - `source-impact` → a blast-radius / "what depends on X" / verify-isolation
 *                       question; the answer is structural, runtime evidence is
 *                       irrelevant, so source-impact mode suppresses it (downstream).
 *   - `explain`       → a behavioral "how does it work" walkthrough.
 *
 * NOTE: there is deliberately NO `architecture` mode — architecture is only ever a
 * ROUTE target, never an intent that disables ceilings (a "how is X structured"
 * question over a degraded system must keep its incident honesty).
 */
export type Intent = 'incident' | 'source-impact' | 'explain';

/** Blast-radius / refactor-impact cues (HOR-385). */
const SOURCE_IMPACT_RE: RegExp[] = [
  /\bwhat depends on\b/i,
  /\bblast[- ]?radius\b/i,
  /\bimpact of (?:adding|serving|removing|changing|renaming|moving|deleting)\b/i,
  /\baffected by\b/i,
  /\bwho (?:calls|uses|imports|consumes)\b/i,
  /\bdownstream of\b/i,
  /\bupstream of\b/i,
  /\bripple\b/i,
  /\bif i (?:change|remove|rename|move|delete)\b/i,
  /\bsafe to (?:remove|delete|rename|change)\b/i,
];

/** Verify-isolation sub-flavour cues — these name two symbols X and Y (HOR-385). */
const VERIFY_ISOLATION_RE: RegExp[] = [
  /\bverify\b.*\b(?:does ?n[o']?t|not) affect\b/i,
  /\bis\b.+\bisolated\b/i,
  /\bisolated\??$/i,
  /\bdoes\b.+\baffect\b/i,
  /\bany (?:impact|effect) on\b/i,
  /\bcontained to\b/i,
  /\bbleed (?:in)?to\b/i,
  /\bcoupled to\b/i,
];

/** Does the hint read as a "is X isolated from Y / does X affect Y" question? */
export function looksVerifyIsolation(hint: string): boolean {
  return VERIFY_ISOLATION_RE.some((re) => re.test(hint));
}

/** Does the hint read as a structural blast-radius / refactor-impact question? */
export function looksSourceImpact(hint: string): boolean {
  return SOURCE_IMPACT_RE.some((re) => re.test(hint)) || looksVerifyIsolation(hint);
}

/**
 * HOR-385: deterministic intent classifier. Precedence is conservative — a live
 * symptom ALWAYS wins so a real incident never loses its runtime evidence:
 *   1. `--since` set & diffable → incident (a diff is always a regression framing).
 *   2. any SYMPTOM cue (shared `INCIDENT_SYMPTOM_RE`) → incident.
 *   3. structural blast-radius / verify-isolation cue → source-impact.
 *   4. behavioral how/what/why → explain.
 *   5. default → incident.
 * Pure: same inputs ⇒ same output (byte-stable for snapshot tests).
 */
export function classifyIntent(hint: string, since: string | undefined): Intent {
  if (since !== undefined && looksDiffable(since)) return 'incident';
  if (INCIDENT_SYMPTOM_RE.test(hint)) return 'incident';
  if (looksSourceImpact(hint)) return 'source-impact';
  if (looksExplanatory(hint)) return 'explain';
  return 'incident';
}

/**
 * Gap #5 — build a behavioral "how does X work" walkthrough from the seed's pre-computed
 * execution Flow (or its direct callees as a fallback), plus heuristic detection of the
 * external calls and persistence the path touches. Rendered INSTEAD of the incident
 * pipeline (seeds/causes/confidence) when the hint is explanatory.
 */
export function buildBehavioralWalkthrough(
  hint: string,
  top: Symbol | undefined,
  ctx: SymbolContext | undefined,
  flows: Flow[],
  /**
   * Methods of the seed when it resolves to a CLASS (dogfood GAP C). A class node has no
   * outgoing calls of its own, so without this the walkthrough collapses to just the class
   * name. Its methods ARE the entry points a "how does X work" answer should list.
   */
  classMethods: Symbol[] = [],
): BehavioralWalkthrough {
  const shortFile = (f: string): string => f.replace(/^.*?((?:src|app|lib|packages)\/.*)$/, '$1');
  // Loggers / tracers are called by almost everything and tell you nothing about the flow.
  const isNoise = (s: Symbol): boolean =>
    /logger|logging|\.log\b|telemetry/i.test(s.filePath) ||
    /^(forcontext|getlogger|child|debug|info|warn|error|log|trace|tracer)$/i.test(s.name);
  // The richest pre-computed execution flow the seed participates in — it already starts at
  // an entry point and lists the ordered steps, so it yields the real entry even when the
  // seed itself sits mid-flow (e.g. an injected service).
  const flow = flows.slice().sort((a, b) => b.steps.length - a.steps.length)[0];
  const rawSteps: Symbol[] =
    flow && flow.steps.length > 1 ? flow.steps : top ? [top, ...(ctx?.callees ?? [])] : ctx?.callees ?? [];
  const steps = rawSteps.filter((s) => !isNoise(s));
  const entry = steps[0] ?? top ?? null;

  const dedup = (xs: Symbol[]): Symbol[] => {
    const seen = new Set<string>();
    return xs.filter((s) => {
      const k = `${s.name}:${s.filePath}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  // File-anchored where possible; only DB/IO-specific verbs in names (generic verbs like
  // `create`/`post` are too service-y and over-flag).
  const PERSIST_RE =
    /(^|[._])(save|insert|upsert|persist|bulkwrite|find|findone|findmany|aggregate|delete|remove)\b|repositor|\brepo\b|\.model|entity|prisma|mongoose|typeorm|knex|\bdao\b|datasource/i;
  const EXTERNAL_RE =
    /(^|[._])(request|publish|enqueue|dispatch|emit|notify)\b|http|axios|\bapi\b|webhook|\bqueue\b|processor|producer|gateway|\.client\b/i;
  const pool = dedup([...steps, ...(ctx?.callees ?? []), ...classMethods]).filter((s) => !isNoise(s));
  const persistence = dedup(pool.filter((s) => PERSIST_RE.test(s.name) || PERSIST_RE.test(s.filePath)))
    .slice(0, 6)
    .map((s) => `${s.name} (${shortFile(s.filePath)})`);
  const persistNames = new Set(persistence.map((p) => p.split(' (')[0]));
  const externalCalls = dedup(
    pool.filter((s) => (EXTERNAL_RE.test(s.name) || EXTERNAL_RE.test(s.filePath)) && !persistNames.has(s.name)),
  )
    .slice(0, 6)
    .map((s) => `${s.name} (${shortFile(s.filePath)})`);

  const lines: string[] = [];
  if (entry) {
    const loc = entry.startLine ? `${shortFile(entry.filePath)}:${entry.startLine}` : shortFile(entry.filePath);
    lines.push(`Entry point: \`${entry.name}\` (${loc}).`);
  }
  const methodList = dedup(classMethods.filter((s) => !isNoise(s)));
  if (steps.length > 1) {
    const chain = steps.slice(0, 12).map((s) => s.name).join(' → ');
    lines.push(`Flow: ${chain}${steps.length > 12 ? ' → …' : ''}${flow ? ` (${flow.steps.length} steps)` : ''}.`);
  } else if (entry && methodList.length > 0) {
    // The seed is a class: its methods are the entry points, not a single call chain.
    const names = methodList.slice(0, 12).map((s) => s.name).join(', ');
    lines.push(
      `\`${entry.name}\` is a class — its methods are the entry points: ${names}${methodList.length > 12 ? ', …' : ''}. Trace one with \`horus explain <method>\`.`,
    );
  } else if (entry) {
    lines.push(`No multi-step execution flow was indexed for \`${entry.name}\` — showing its direct calls.`);
  }
  if (externalCalls.length > 0) lines.push(`Calls out to: ${externalCalls.join(', ')}.`);
  if (persistence.length > 0) lines.push(`Persists via: ${persistence.join(', ')}.`);
  if (lines.length === 0) lines.push('No execution flow could be reconstructed for this query from the source graph.');

  return { question: hint, entry, steps, externalCalls, persistence, narrative: lines.join('\n') };
}

/** True when a symbol id resolves to a CLASS node (ids are prefixed by their graph label). */
function isClassSymbol(sym: Symbol | undefined): boolean {
  return sym !== undefined && sym.id.split(':', 1)[0]?.toLowerCase() === 'class';
}

/**
 * Fetch the methods of a class symbol from the source graph (dogfood GAP C). A class node
 * has no outgoing calls, so a behavioral walkthrough rooted at a class needs its methods to
 * be useful. Uses the typed /api/class-methods endpoint (HOR-392). Best-effort: returns []
 * on any error or when the provider doesn't expose class-method lookup.
 */
async function fetchClassMethods(code: CodeProvider, cls: Symbol): Promise<Symbol[]> {
  const name = cls.name?.trim();
  if (!name || typeof code.classMethods !== 'function') return [];
  try {
    return await code.classMethods(cls.filePath ?? '', name);
  } catch {
    return [];
  }
}

/**
 * HOR-406: a commit is "noise" for deployment-regression attribution when it could not
 * plausibly have introduced a runtime fault — a dependency-bot bump, a pure merge, a
 * release-prep / version bump, or a pre-commit autoupdate. Such a commit being the most
 * recent change in the window must NOT inflate the regression cause. Pure + deterministic;
 * only the subject and author are consulted (no I/O).
 */
export function isNoiseCommit(commit: Pick<GitCommit, 'subject' | 'author'>): boolean {
  const subject = (commit.subject ?? '').trim();
  const author = (commit.author ?? '').trim();

  // Bot authors — dependabot[bot], renovate[bot], github-actions[bot], pre-commit-ci[bot], …
  if (/\[bot\]/i.test(author)) return true;
  if (/\b(dependabot|renovate)\b/i.test(author)) return true;

  // Dependency bumps — dependabot/renovate subjects, "Bump X from a to b", build/chore(deps).
  if (/^bump\s/i.test(subject)) return true;
  if (/\b(dependabot|renovate)\b/i.test(subject)) return true;
  if (/^(build|chore|fix|deps)\(deps(-dev)?\)/i.test(subject)) return true;

  // Pure merge commits — "Merge branch …", "Merge pull request …".
  if (/^merge\b/i.test(subject)) return true;

  // Release-prep / version bumps — "Prepare release", "chore(release): 1.2.3", "Bump version".
  if (/^(prepare release|release|bump version|version bump|chore\(release\))/i.test(subject)) {
    return true;
  }

  // pre-commit autoupdate / pre-commit.ci.
  if (/pre-commit.*autoupdate/i.test(subject) || /\[pre-commit\.ci\]/i.test(subject)) return true;

  // HOR-451: NON-CAUSAL commit types/intents — documentation, formatting/style, tests, CI config —
  // do not change runtime behaviour, so they must not earn the seed-touched regression boost.
  // (maison dogfood: a `feat(...): add comprehensive documentation` docs commit was headlined as
  // the cause of a "scheduler config save" failure, and a `refactor: clean up code formatting`
  // commit headlined 5 unrelated incidents — both merely touched the seed's file.)
  // Conventional-commit type prefix declaring non-causal intent.
  if (/^(docs|style|test|ci)(\([^)]*\))?[:!]/i.test(subject)) return true;
  // Formatting / lint-only intents (catches a mistyped `refactor: clean up code formatting`).
  if (/\b(reformat|whitespace|prettier|eslint)\b/i.test(subject)) return true;
  if (/\bcode\s*(style|formatting)\b/i.test(subject)) return true;
  if (/\bclean\s*up\b[^.]*\bformat/i.test(subject)) return true;
  // Documentation-only intents, even when mislabelled `feat`/`chore` (catches the maison
  // `feat(horus): add comprehensive documentation` case) — but SPARE commits that touch a code
  // artifact (a docs *endpoint/API/service*), which are behavioural and can regress.
  if (
    /\b(documentation|docs|readme)\b/i.test(subject) &&
    !/\b(endpoint|api|service|handler|controller|component|module|feature|migration|schema|query|cache|queue|webhook|sdk|cli|route)\b/i.test(subject)
  ) {
    return true;
  }

  return false;
}

/**
 * HOR-406: the deployment-regression cause earns its full base score ONLY when a RELEVANT
 * change shipped — a commit that (a) actually touches the seed's file, (b) is part of a
 * non-trivial diff (the change window is not a +0/-0 no-op), and (c) is not bot / merge /
 * release / autoupdate noise. A recent-but-irrelevant commit (a dependabot bump, a pure
 * merge across many files, a "Prepare release", a pre-commit autoupdate, or a +0/-0 no-op)
 * no longer inflates the cause — it gets the un-boosted base score and an honest title.
 * Pure + deterministic.
 */
export function seedTouchedByRelevantChange(
  recentChanges: BoundedGitChange | undefined,
  seedFile: string | undefined,
): boolean {
  if (recentChanges === undefined || seedFile === undefined) return false;
  // HOR-423: a degenerate window (wrong/absent base, +0/-0 no-op, or an over-reaching diff)
  // carries no usable change signal — it can never be a regression driver.
  if (recentChanges.degenerate) return false;
  // No-op window: nothing actually changed (e.g. a pure merge: +0/-0 across many files).
  if (recentChanges.totalInsertions + recentChanges.totalDeletions === 0) return false;
  const matchesSeed = (f: string): boolean =>
    f === seedFile || seedFile.endsWith(f) || f.endsWith(seedFile);
  return recentChanges.commits.some(
    (c) => !isNoiseCommit(c) && c.files.some(matchesSeed),
  );
}

/**
 * HOR-451: how FOCUSED is the change that touched the seed? Returns the smallest changed-file count
 * among the non-noise commits that actually touched the seed's file (the most-focused such commit),
 * or null when none did. A tightly-scoped commit (a few files incl. the seed) is strong regression
 * evidence; a broad commit (e.g. a 22-file integration that incidentally touched the seed along with
 * everything else) is weak. Pure + deterministic.
 */
export function seedTouchingCommitFocus(
  recentChanges: BoundedGitChange | undefined,
  seedFile: string | undefined,
): number | null {
  if (recentChanges === undefined || seedFile === undefined) return null;
  if (recentChanges.degenerate) return null;
  const matchesSeed = (f: string): boolean =>
    f === seedFile || seedFile.endsWith(f) || f.endsWith(seedFile);
  let min: number | null = null;
  for (const c of recentChanges.commits) {
    if (isNoiseCommit(c)) continue;
    if (!c.files.some(matchesSeed)) continue;
    const n = c.files.length;
    if (min === null || n < min) min = n;
  }
  return min;
}

/**
 * HOR-451: the deployment-regression prior, scaled by how focused the seed-touching change was.
 * A focused commit earns the full prior; a broad/diffuse one is demoted toward the un-boosted floor
 * so an evidence-backed runtime cause (a data-state anomaly, a real error) is no longer outranked by
 * "a 22-file commit happened to touch this file" (maison dogfood). Pure.
 */
export function regressionSeedTouchedScore(focus: number | null): number {
  if (focus === null) return 0.18; // no relevant commit touched the seed
  if (focus <= 4) return 0.45; // tightly-scoped change incl. the seed — strong
  if (focus <= 8) return 0.38;
  if (focus <= 14) return 0.3;
  return 0.2; // broad/diffuse commit (touched ~everything) — weak; yields to runtime evidence
}

/**
 * HOR-333: build the commit + changed-symbol citation clauses for the regression
 * cause title. Cites the most-recent 1-2 commits (short SHA + subject) from the
 * bounded git history and the changed symbol name(s) from the source-backend
 * ChangeSet. Bounded so the headline stays scannable. Returns empty clauses when
 * no commits/symbols are available, so the title degrades to the prior wording.
 */
export function formatRegressionCitation(
  recentChanges: BoundedGitChange | undefined,
  changes: ChangeSet | null,
  seedFile?: string,
): { commitClause: string; symbolClause: string } {
  const matchesSeed = (f: string): boolean =>
    seedFile === undefined || f === seedFile || seedFile.endsWith(f) || f.endsWith(seedFile);

  // #3 (dogfood): attribute to the commit(s) that ACTUALLY touched the seed's file — NOT the two
  // newest commits in the --since window. The old behaviour blamed unrelated recent commits and
  // tripped the off-by-one release-tag trap (the touching commit is an ancestor of the tag). When
  // no in-window commit touched the seed, cite nothing — the caller frames that honestly rather
  // than fabricating a culprit.
  // HOR-406: never cite bot/merge/release/autoupdate noise as the culprit — the score gate
  // ignores those commits, so the headline must not name one either.
  const all = (recentChanges?.commits ?? []).filter((c) => !isNoiseCommit(c));
  const seedCommits = seedFile ? all.filter((c) => c.files.some(matchesSeed)) : all;
  const commits = seedCommits.slice(0, 2);
  const commitParts = commits.map((c) => {
    const sha = c.shortSha || c.sha.slice(0, 7);
    const subject = (c.subject ?? '').replace(/\s+/g, ' ').trim();
    return subject ? `${sha} "${subject.slice(0, 50)}"` : sha;
  });
  const commitClause = commitParts.length > 0 ? ` (${commitParts.join(', ')})` : '';

  // Changed symbol names — restricted to the seed's file so cross-service symbols from the same
  // window aren't narrated onto this seed (prefer the post-change name).
  const modified = (changes?.modified ?? []).filter((m) =>
    matchesSeed(((m.after ?? m.before) as { filePath?: string }).filePath ?? ''),
  );
  const symbolNames: string[] = [];
  for (const m of modified) {
    const name = m.after?.name ?? m.before?.name;
    if (name && !symbolNames.includes(name)) symbolNames.push(name);
    if (symbolNames.length >= 3) break;
  }
  let symbolClause = '';
  if (symbolNames.length > 0) {
    const shown = symbolNames.join(', ');
    const more = modified.length > symbolNames.length ? ', …' : '';
    symbolClause = ` touched ${shown}${more}`;
  }

  return { commitClause, symbolClause };
}

export async function investigate(
  input: InvestigationInput,
  deps: EngineDeps,
): Promise<InvestigationReport> {
  const { code, db, rerank } = deps;

  // a. PARSE
  const hint = input.hint.trim();

  // HOR-385: classify the structural intent BEFORE seed resolution so source-impact mode can
  // steer seeding onto the PROMPT-named symbol (not the central node). EVERY source-impact branch
  // below is gated on `sourceImpactHint` and defaults to the incident behavior, so an incident
  // hint's report is byte-identical. `namedSymbols` is read positionally for verify-isolation
  // (`[0]` = the seed X, `[1]` = the isolation target Y).
  const intent = classifyIntent(hint, input.since);
  const namedSymbols = parseNamedSymbols(hint);
  // HOR-435 (lever #1, de-anchor): causes the alert/hint TEXT merely *suggested* ("could
  // indicate a DB issue / may be a retry storm"). Parsed here (text only) and threaded into
  // hypothesis generation as CONTEXT — they earn confidence solely from independent evidence,
  // never from the alert wording (which would re-anchor the very bias this defuses).
  const alertSuggestedCategories = parseSuggestedCauses(hint);
  const sourceImpactHint = intent === 'source-impact';
  const preferNamed =
    sourceImpactHint && namedSymbols.length > 0 ? namedSymbols[0] : undefined;

  // Evidence accumulator + factory. ids double as the persisted PKs.
  const evidence: Evidence[] = [];
  const collectedAt = new Date().toISOString();
  function mkEv(
    kind: EvidenceKind,
    title: string,
    payload: unknown,
    links: EvidenceLinks,
    timestamp?: string,
    relevance?: number,
  ): Evidence {
    const ev: Evidence = {
      id: globalThis.crypto.randomUUID(),
      source: sourceForKind(kind),
      kind,
      title,
      relevance: relevance !== undefined ? relevance : relevanceForKind(kind),
      payload,
      links,
      provenance: { query: hint, collectedAt },
    };
    if (timestamp !== undefined) ev.timestamp = timestamp;
    evidence.push(ev);
    return ev;
  }

  // b. RESOLVE seeds — rank candidates so we prefer architectural entry points
  // (resolver/controller/service/route) over tiny helpers/scripts (HOR-39).
  // Pass hint tokens so domain-specific symbols (e.g. ShopifyWebhookController)
  // beat generic architectural matches (e.g. BrandService) when the hint names
  // the domain explicitly.
  // HOR-319 layer-2: with no source-intelligence provider the engine runs RUNTIME-ONLY.
  // Skip seed resolution entirely — there are no symbols to resolve against.
  const degradedNoSource = !code;
  // HOR-94 / HOR-193 — bounded git change summary for the incident window. Computed FIRST
  // (independent of source intelligence) so commit evidence works in degraded runtime-only
  // mode, when the source-backend ChangeSet is unavailable, or when --since is a relative
  // ref (HEAD~5) detectChanges can't take — AND so a --since regression investigation can
  // steer the seed toward changed code: the culprit lives in the diff, not an unrelated
  // unchanged function (HOR-328 round-3).
  // HOR-333: an explicit --since always wins. When it is absent but a repo is available, auto-derive
  // a bounded default window (DEFAULT_CHANGE_WINDOW_DAYS, overridable via deps.changeWindowDays) so
  // change analysis + the deployment-regression hypothesis run instead of staying dormant. The window
  // is anchored to the repo's LAST COMMIT (not a bare Date.now()) so it stays deterministic for a
  // given repo state.
  const changeWindowDays = deps.changeWindowDays ?? DEFAULT_CHANGE_WINDOW_DAYS;
  // Human-readable range label for findings/causes — the literal range for an explicit since, or a
  // relative phrase for the auto window (its ISO anchor would be noise in user-facing text).
  const changeRangeLabel =
    input.since !== undefined ? `${input.since}..HEAD` : `the last ${changeWindowDays} days`;
  let recentChanges: BoundedGitChange | undefined;
  if (deps.repoPath) {
    try {
      const since =
        input.since ?? (await defaultChangeWindowSince(deps.repoPath, changeWindowDays));
      if (since !== undefined) {
        recentChanges = await collectGitChanges({ repoPath: deps.repoPath, since });
      }
    } catch {
      // Best-effort; skip on error
    }
  }
  const changedFilePaths =
    recentChanges && recentChanges.changedFiles.length > 0
      ? new Set(recentChanges.changedFiles)
      : undefined;
  // HOR-356: when a path scope is given, resolve the seed only from symbols under it — search
  // wider then keep in-scope — so a backend hint doesn't seed a co-located frontend in a monorepo.
  const scopePrefix = input.scope
    ? input.scope.replace(/^\.?\/+/, '').replace(/\/+$/, '')
    : undefined;
  const inScope = (s: Symbol): boolean => {
    if (!scopePrefix) return true;
    const fp = (s.filePath ?? '').replace(/^\.?\/+/, '');
    return fp === scopePrefix || fp.startsWith(scopePrefix + '/');
  };
  // HOR-361: retrieve a WIDER candidate pool and rank it before truncating, so a real
  // implementation the raw search ranks below the top few (e.g. behind same-named tests)
  // can still be promoted by rankSeeds (which demotes tests/types/getters). Slicing to 5
  // BEFORE ranking used to starve the ranker of the very candidate we want.
  const seedSearchLimit = scopePrefix ? 30 : 20;
  const rawSeeds = code
    ? (await code.searchSymbols(hint, seedSearchLimit)).filter(inScope)
    : [];
  const hintTokens = [...new Set(tokenize(hint))];
  // gap-3 rebalance: a CODE-shaped hint (HTTPFLT001, E_SYNC_04…) makes the search's exact-content/
  // colocated score authoritative; a prose hint does not (a `Brand` schema must not beat the real
  // fulfillment function on raw score alone — caught by the dogfood re-run).
  const hintHasCode = /\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b/.test(hint);
  // HOR-337: a `Class.method` (ProductService.syncProduct) or `path/to/file:symbol` token in the
  // hint pins the seed to that EXACT symbol — strongly prefer the candidate whose name and
  // class/file both match, not an unrelated same-named symbol.
  const seedQualifier = parseSeedQualifier(hint);
  const ranked = rankSeeds(rawSeeds, hintTokens, changedFilePaths, hintHasCode, seedQualifier, preferNamed);
  // Keep the top-ranked handful as candidate seeds — the wider pool was only needed so the
  // ranker could see (and promote) a lower-search-ranked implementation (HOR-361).
  let seeds = ranked.map((r) => r.symbol).slice(0, 5);
  // noUncheckedIndexedAccess: a non-empty array could still index to undefined.
  let top: Symbol | undefined = seeds[0];

  // HOR-337: when a qualifier is present but the top seed isn't the exact symbol it names,
  // the full-hint search may not have surfaced it — re-search for the bare symbol name and
  // re-rank with the qualifier, promoting an exact (name + container) match when found.
  if (seedQualifier && code && (!top || top.name.toLowerCase() !== seedQualifier.symbol.toLowerCase())) {
    const altRanked = rankSeeds(
      (await code.searchSymbols(seedQualifier.symbol, seedSearchLimit)).filter(inScope),
      hintTokens,
      changedFilePaths,
      hintHasCode,
      seedQualifier,
    );
    const altTop = altRanked[0]?.symbol;
    // Only adopt the alternate when it actually satisfies the qualifier (name matches and its
    // score reflects a container match — i.e. it outscores a bare-name-only candidate).
    if (
      altTop &&
      altTop.name.toLowerCase() === seedQualifier.symbol.toLowerCase() &&
      altTop.id !== top?.id
    ) {
      seeds = [altTop, ...seeds.filter((s) => s.id !== altTop.id)].slice(0, 5);
      top = altTop;
    }
  }

  // HOR-337: if the best seed is a TYPE/DTO declaration (e.g. `SyncBrandFulfillmentsResult`),
  // the fault lives in the same-named EXECUTABLE, not the type. Search often only returns
  // the type (its name hugs the hint), so demotion alone can't help — derive the base name
  // and re-search for a method/function counterpart, preferring it when one is found.
  if (top && code && isTypeLikeName(top.name)) {
    const base = executableBaseName(top.name);
    if (base) {
      const altTop = rankSeeds((await code.searchSymbols(base, seedSearchLimit)).filter(inScope), hintTokens, undefined, hintHasCode).find(
        (r) => !isTypeLikeName(r.symbol.name),
      )?.symbol;
      if (altTop && altTop.id !== top.id) {
        seeds = [altTop, ...seeds.filter((s) => s.id !== altTop.id)];
        top = altTop;
      }
    }
  }

  // HOR-385: source-impact mode pins the seed to the PROMPT-named symbol, not a central node.
  // When the named symbol isn't already the top (the full-hint search may rank a central
  // controller/resolver higher), re-search for it and adopt — mirroring the HOR-337 qualifier
  // re-search/adopt mechanism, with `preferNamed` forcing the decisive boost on the re-rank.
  if (preferNamed && code && (!top || top.name.toLowerCase() !== preferNamed.toLowerCase())) {
    const altRanked = rankSeeds(
      (await code.searchSymbols(preferNamed, seedSearchLimit)).filter(inScope),
      hintTokens,
      changedFilePaths,
      hintHasCode,
      seedQualifier,
      preferNamed,
    );
    const altTop = altRanked[0]?.symbol;
    if (
      altTop &&
      altTop.name.toLowerCase() === preferNamed.toLowerCase() &&
      altTop.id !== top?.id
    ) {
      seeds = [altTop, ...seeds.filter((s) => s.id !== altTop.id)].slice(0, 5);
      top = altTop;
    }
  }

  // HOR-216: a raw error string (e.g. "getaddrinfo ENOTFOUND host") matches no
  // source symbol. Before giving up, search the logs for the hint (across message,
  // detail, and context.*), then back-resolve the matching log's component to a
  // source symbol and seed the investigation from there. Best-effort.
  let logReseed: LogReseed | null = null;
  if (!top && !degradedNoSource) {
    logReseed = await reseedFromLogs(hint, input, deps);
    if (logReseed !== null) {
      seeds = logReseed.seeds;
      top = seeds[0];
    }
  }

  // HOR-335: a seed with ZERO hint-token overlap (and not log-reseeded) is a
  // semantic/fuzzy guess — not a match to anything the hint actually named. Flag it
  // so we disclose the low confidence and damp the headline, else investigate
  // fabricates a confident result for input that matches no real symbol (e.g.
  // "ZzzNonexistentService is throwing" silently resolved to the helper `err`).
  const seedHay = top ? `${top.name} ${top.filePath}`.toLowerCase() : '';
  // Generic architectural/severity words match almost any file path ("service" is in
  // every *.service.ts) — they don't indicate the seed is what the hint actually named.
  const GENERIC_HINT_TOKENS = new Set([
    'service', 'services', 'controller', 'controllers', 'resolver', 'resolvers', 'worker',
    'workers', 'repository', 'provider', 'module', 'manager', 'util', 'utils', 'helper',
    'handler', 'error', 'errors', 'exception', 'exceptions', 'fail', 'failed', 'failing',
    'failure', 'throw', 'throwing', 'thrown', 'fatal', 'crash', 'crashing', 'timeout',
    'production', 'prod', 'staging', 'application', 'issue', 'problem', 'broken', 'slow',
  ]);
  const meaningfulHintTokens = hintTokens.filter((t) => !GENERIC_HINT_TOKENS.has(t));
  const seedIsLowConfidence =
    top !== undefined &&
    logReseed === null &&
    (top.score ?? 0) < 0.5 && // a strong exact-content/colocated source match is authoritative (gap 6)
    meaningfulHintTokens.length > 0 &&
    !meaningfulHintTokens.some((t) => seedHay.includes(t));

  // Empty-result only when source intelligence WAS available but resolved nothing.
  // In degraded runtime-only mode we fall through and build a report from runtime
  // evidence instead (HOR-319 layer-2).
  if (!top && !degradedNoSource) {
    const report: InvestigationReport = {
      id: globalThis.crypto.randomUUID(),
      input,
      ...(investigationSubject(input) !== undefined
        ? { subject: investigationSubject(input) }
        : {}),
      summary: 'No source symbols matched the hint',
      seeds: [],
      evidence: [],
      timeline: { events: [], boundaryCrossings: [] },
      correlation: { groups: [], chains: [], missing: correlate([]).missing },
      findings: [],
      suspectedCauses: [],
      hypotheses: [],
      similarIncidents: [],
      gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 0 },
      graph: { nodes: [], edges: [] },
      confidence: 0,
      nextActions: [
        deps.logs != null
          ? `No symbols matched "${hint}", and no recent error log matched it either. Try a more specific hint — an exact function, class, or file name — or widen --since.`
          : `No symbols matched "${hint}". Try a more specific hint — an exact function, class, or file name.`,
      ],
      // HOR-386 — empty-return: route to `search` for the right name (deterministic).
      nextSteps: route({ command: 'investigate', empty: true, query: hint }),
    };
    const persistedEmpty = await persist(db, input, report);
    if (persistedEmpty) report.id = persistedEmpty.id;
    return report;
  }

  // (recentChanges — the bounded git change summary — is computed up front, before seed
  // resolution above, so a --since regression investigation can steer the seed toward
  // changed code.)

  // Structural-evidence accumulators. Populated only when a seed resolved (full run);
  // they stay at these runtime-only defaults in degraded mode (HOR-319 layer-2), where
  // the report is built from runtime evidence (logs/metrics/state/queues) alone.
  let label = input.service ?? hint;
  let seedLoc = '';
  let ctx: SymbolContext | null = null;
  let impact: ImpactResult | null = null;
  let flows: Awaited<ReturnType<CodeProvider['flowsFor']>> = [];
  let seedEv: Evidence | null = null;
  let impactEv: Evidence | null = null;
  const flowEvIds: string[] = [];
  let queueHits: QueueEdge[] = [];
  const queueEvByName = new Map<string, string[]>();
  // HOR-438: evidence ids for any code-detected per-segment queue STRUCTURE (one queue per
  // market/region/tenant/shard). Feeds the benign-variance hypothesis as code-grounded support.
  const perSegmentQueueStructureEvIds: string[] = [];
  let changes: ChangeSet | null = null;
  let changeEvId: string | null = null;

  if (top && code) {
    // A "constructor" seed is really its class — surface a friendlier label in the report.
    label =
      top.name === 'constructor'
        ? `${(top.id.split(':').pop() ?? '').replace(/\.constructor$/, '') || top.name} (constructor)`
        : top.name;

    // c. GATHER. HOR-445: degrade the per-symbol source queries (impact, flows) rather than abort —
    // a single failing query (e.g. an impact 404 on an exotic seed id like a `#private` method) must
    // NOT sink the whole investigation; each already has a supported empty state (impact=null,
    // flows=[]). context() stays required (its failure is a fundamental seed-context loss handled by
    // the outer catch), which also preserves its non-null narrowing downstream.
    [ctx, impact, flows] = await Promise.all([
      code.context(top.id),
      code.impact(top.id, 2).catch(() => null),
      code.flowsFor(top.id).catch(() => []),
    ]);
    let edges: QueueEdge[] = [];
    try {
      edges = await listQueueEdges(db, { project: input.repo });
    } catch {
      // Investigation-store DB unreachable — degrade (HOR-319 spirit) rather than
      // aborting the whole investigation: skip queue-edge evidence. persist() already
      // tolerates a down DB, so the report still runs, renders, and reports telemetry.
      edges = [];
    }

    // dogfood GAP G: do NOT match queue edges on GENERIC symbol names. "constructor" (every
    // class has one) and "unknown" let a foreign edge — e.g. a stale/cross-project queue in a
    // shared investigation DB (producer "constructor" -> worker "ZohoBatchProcessor") — match
    // any seed that merely has a constructor, leaking another repo's topology into the report.
    const symbolNames = new Set<string>(
      [top.name, ...ctx.callers.map((s) => s.name), ...ctx.callees.map((s) => s.name)].filter(
        (n) => n && !GENERIC_SYMBOL_NAMES.has(n),
      ),
    );
    queueHits = edges.filter((e) => {
      const bySymbol =
        (e.producerSymbol !== null && symbolNames.has(e.producerSymbol)) ||
        (e.workerSymbol !== null && symbolNames.has(e.workerSymbol));
      const byFile =
        e.producerFile === top.filePath || e.workerFile === top.filePath;
      return bySymbol || byFile;
    });

    // GAP G: drop any matched edge whose cited symbols don't RESOLVE in THIS repo's source
    // graph — a stale or cross-project edge (e.g. ZohoBatchProcessor, which exists in another
    // repo) must never be presented as a boundary crossing here. Best-effort; on a search
    // failure we keep the edge rather than silently dropping real evidence.
    if (queueHits.length > 0 && typeof code.searchSymbols === 'function') {
      const resolvesInRepo = async (name: string | null): Promise<boolean> => {
        if (!name || GENERIC_SYMBOL_NAMES.has(name)) return false;
        try {
          return (await code.searchSymbols(name, 3)).some((s) => s.name === name);
        } catch {
          return true; // can't verify → don't drop
        }
      };
      const validated: QueueEdge[] = [];
      for (const e of queueHits) {
        if ((await resolvesInRepo(e.producerSymbol)) || (await resolvesInRepo(e.workerSymbol))) {
          validated.push(e);
        }
      }
      queueHits = validated;
    }

    if (input.since !== undefined && looksDiffable(input.since)) {
      try {
        changes = await code.detectChanges({ base: input.since, compare: 'HEAD' });
      } catch {
        changes = null;
      }
    }

    // d. BUILD Evidence
    seedLoc = formatSymbolLocation(top.filePath, top.startLine, top.endLine);
    seedEv = mkEv(
      'symbol',
      `Seed symbol ${top.name} (${seedLoc})`,
      { symbol: top, snippet: ctx.snippet ?? null },
      top.startLine !== undefined && top.startLine > 0
        ? { symbolId: top.id, file: top.filePath, line: top.startLine }
        : { symbolId: top.id, file: top.filePath },
    );

    for (const flow of flows) {
      const ev = mkEv(
        'flow',
        `Flow "${flow.name}" (${flow.steps.length} step(s))`,
        { flowId: flow.id, name: flow.name, steps: flow.steps.map((s) => s.name) },
        { symbolId: top.id, file: top.filePath },
      );
      flowEvIds.push(ev.id);
    }

    // HOR-445: only when the impact query succeeded — a degraded (failed) impact contributes no
    // blast-radius evidence rather than a fabricated "0 affected".
    if (impact) {
      impactEv = mkEv(
        'impact',
        `Impact of ${top.name}: ${impact.affected} affected symbol(s)`,
        { affected: impact.affected },
        { symbolId: top.id, file: top.filePath },
      );
    }

    // One queue-edge evidence per hit; track ids per distinct queue for findings/causes.
    for (const edge of queueHits) {
      const producer = edge.producerSymbol ?? 'unknown-producer';
      const worker = edge.workerSymbol ?? 'unknown-worker';
      const ev = mkEv(
        'queue-edge',
        `Queue "${edge.queueName}": ${producer} -> ${worker}`,
        {
          queueName: edge.queueName,
          producerSymbol: edge.producerSymbol,
          producerFile: edge.producerFile,
          workerSymbol: edge.workerSymbol,
          workerFile: edge.workerFile,
          source: edge.source,
        },
        { queueName: edge.queueName },
      );
      const list = queueEvByName.get(edge.queueName) ?? [];
      list.push(ev.id);
      queueEvByName.set(edge.queueName, list);
    }

    // HOR-438: detect a per-segment queue STRUCTURE (one queue per market/region/tenant/
    // shard) from the topology just collected. When present, emit ONE code-grounded
    // evidence item (modest relevance) per detected base — an anomaly on a single segment
    // is more likely EXPECTED per-segment variance than a uniform failure. This SUPPORTS the
    // benign-variance hypothesis; it is never a verdict on its own.
    for (const struct of detectPerSegmentQueues(queueHits)) {
      const ev = mkEv(
        'queue-edge',
        `Per-segment queue structure: "${struct.baseName}" fans out to ${struct.count} segment(s) (${struct.segments.join(', ')})`,
        {
          kind: 'per-segment-queue-pattern',
          baseName: struct.baseName,
          segments: struct.segments,
          count: struct.count,
        },
        { queueName: struct.baseName },
        undefined,
        0.4,
      );
      perSegmentQueueStructureEvIds.push(ev.id);
    }

    // HOR-438b: detect a per-segment DISPATCH from the seed's CODE (no telemetry needed) — a
    // sibling to the queue-suffix structure above for the case it cannot see: ONE logical queue,
    // but the per-market/region/tenant split lives in the code (e.g. `manageSalesForMarket(
    // marketType)` called per market). The seed signature carrying a segment-dimension param is a
    // modest, code-grounded SUPPORT for benign-variance (a per-segment processor naturally has
    // per-segment duration variance). Reuse the SAME benignSupport channel as the queue structure
    // — both are per-segment structure support; neither is ever a verdict.
    const dispatch = detectPerSegmentDispatch(ctx, queueHits, ctx.callers);
    if (dispatch) {
      const fanOutNote =
        dispatch.fanOut === 'none' ? '' : ` (fan-out: ${dispatch.fanOut})`;
      const ev = mkEv(
        'symbol',
        `Per-segment dispatch: ${dispatch.symbol} takes segment-dimension param "${dispatch.paramName}"${dispatch.paramType ? `: ${dispatch.paramType}` : ''}${fanOutNote}`,
        {
          kind: 'per-segment-dispatch',
          symbol: dispatch.symbol,
          paramName: dispatch.paramName,
          paramType: dispatch.paramType,
          fanOut: dispatch.fanOut,
        },
        top.startLine !== undefined && top.startLine > 0
          ? { symbolId: top.id, file: top.filePath, line: top.startLine }
          : { symbolId: top.id, file: top.filePath },
        undefined,
        0.4,
      );
      perSegmentQueueStructureEvIds.push(ev.id);
    }

    if (changes) {
      const addedN = changes.added.length;
      const removedN = changes.removed.length;
      const modifiedN = changes.modified.length;
      const ev = mkEv(
        'commit',
        `Change range ${input.since}..HEAD: +${addedN} -${removedN} ~${modifiedN} symbol(s)`,
        { added: addedN, removed: removedN, modified: modifiedN },
        {},
      );
      changeEvId = ev.id;
    }
  }

  // HOR-193: when the source-backend ChangeSet is unavailable but git history was
  // collected (e.g. --since HEAD~5, source backend down, or degraded runtime-only mode),
  // synthesize a commit evidence entry so hypotheses + gaps receive the change signal.
  if (
    changes === null &&
    recentChanges !== undefined &&
    recentChanges.commits.length > 0 &&
    // HOR-423: a degenerate diff (wrong/absent base, +0/-0 no-op, or over-reach) carries no
    // usable change signal — don't synthesize change evidence off it, which would otherwise
    // cascade into a bogus "N file(s) changed (+0 -0)" finding and deployment-regression cause.
    !recentChanges.degenerate
  ) {
    const { commits, changedFiles, totalInsertions, totalDeletions } = recentChanges;
    const ev = mkEv(
      'commit',
      `Git history ${changeRangeLabel}: ${commits.length} commit(s), ${changedFiles.length} file(s) changed (+${totalInsertions} -${totalDeletions})`,
      { commits: commits.slice(0, 10), changedFiles: changedFiles.slice(0, 30), totalInsertions, totalDeletions, source: 'git' },
      {},
    );
    changeEvId = ev.id;
  }

  // HOR-332: classify CHANGED CONFIG/MIGRATION files in the window as a distinct,
  // visible "config/data change" source alongside code commits — many prod incidents
  // are caused by a migration or a config edit, not a code change. Reuses the
  // changed-files list already collected from git detection (no new I/O); classifies
  // and surfaces only. Runtime-config / feature-flag ingestion remains out of scope.
  let configChangeEvId: string | undefined;
  let configChanges: ConfigChangeFile[] = [];
  // HOR-423: skip config/migration attribution when the change window is degenerate — a
  // wrong/too-far base ("9 migrations + 6 configs from a checkout bump") must not be framed
  // as a non-code change source.
  if (
    recentChanges !== undefined &&
    !recentChanges.degenerate &&
    recentChanges.changedFiles.length > 0
  ) {
    configChanges = classifyConfigChangeFiles(recentChanges.changedFiles);
    if (configChanges.length > 0) {
      const migrationN = configChanges.filter((c) => c.category === 'migration').length;
      const configN = configChanges.length - migrationN;
      const parts: string[] = [];
      if (migrationN > 0) parts.push(`${migrationN} migration/schema file(s)`);
      if (configN > 0) parts.push(`${configN} config/data file(s)`);
      const ev = mkEv(
        'commit',
        `Config/migration change ${changeRangeLabel}: ${parts.join(', ')} changed`,
        {
          source: 'git',
          kind: 'config-change',
          files: configChanges.slice(0, 30),
          migrationCount: migrationN,
          configCount: configN,
        },
        {},
      );
      configChangeEvId = ev.id;
    }
  }

  // e0. RUNTIME LOG EVIDENCE (HOR-10/13) — synthesize error SIGNATURES, not raw log
  // dumps. Optional; never breaks the investigation on failure.
  let analysis: LogAnalysis | null = null;
  const logEvIds: string[] = [];
  const directLogEvIds: string[] = [];
  const ambientLogEvIds: string[] = [];
  // HOR-435 (lever #2): ids of per-dimension duration breakdown evidence rows
  // (`Duration by region: KSA 2m10s, UAE 19ms`) — feed the benign-variance hypothesis.
  const perDimensionDurationEvIds: string[] = [];
  // HOR-338: track the DIRECT signatures (not just their evidence ids) so the
  // error-correlation cause cites the errors actually linked to the seed/path — not
  // the global top error, which co-occurrence would otherwise cross-wire onto an
  // unrelated path (e.g. a scheduler error narrated onto a webhook worker).
  const directSignatures: { key: string; count: number; message: string }[] = [];
  // HOR-341: signature key → its DIRECT log evidence id, so a seed-emitted code that
  // is ALSO a top signature (deduped by the join) can still be linked to its existing
  // evidence when promoted to a headline cause.
  const directEvIdByKey = new Map<string, string>();
  // HOR-341: a runtime error EMITTED FROM THE SEED FUNCTION (its literal appears in the
  // seed's own source body) that also has live Elasticsearch occurrences is the strongest
  // possible link — the seed RAISES this recurring error. Track those joined codes (with
  // the evidence id that backs them) so a dedicated headline cause can be formed and the
  // "#1/#2 no cause structurally linked" reframing yields to them. Hint-only codes are NOT
  // recorded here — they stay direct evidence but are not promoted to a cause.
  const seedEmittedJoins: {
    code: string;
    count: number;
    message: string;
    evId: string;
    isNew: boolean;
    /** Log level of a representative occurrence, when known — drives severity-aware ranking. */
    level: string | null;
    /**
     * True when the code is raised by the SEED ITSELF (its literal is in the seed body, or
     * its raise-site resolves to the seed). False when it is raised by a CALLEE. A seed-local
     * error is preferred over a generic error from a shared callee (dogfood GAP F): e.g.
     * `draftProductsForSale` raises its own `E_DRAFT_SALE_PRODUCTS_02`, while the generic
     * `ERR243_05` "Store client error" is raised by the shared `maisonAxios` transport — the
     * latter must not headline as the seed's "likely failure".
     */
    raisedBySeed: boolean;
    /** The actual raising symbol's name (the seed, or the callee when raisedBySeed is false). */
    raiserName: string;
  }[] = [];
  // HOR-215: distinct-failing-entity evidence (e.g. "16 brand_id, 50 order_id").
  const entityEvIds: string[] = [];
  const entitySummaries: string[] = [];
  let logsCollected = false;
  let logsCompatibilityError: string | undefined;
  let logsFailureReason: string | undefined;

  if (deps.logs) {
    try {
      // Validate field mapping against the actual index before querying so an
      // incompatible config surfaces as an honest gap rather than empty evidence.
      // Pass requiresService so a missing service field is an error, not a warning.
      const compat = await deps.logs.checkCompatibility({
        requiresService: input.service !== undefined,
        requiresServiceAggregation: true,
        requiresEventCode: true,
      });
      const compatErrors = compat.issues.filter((i) => i.severity === 'error');
      if (compatErrors.length > 0) {
        logsCompatibilityError = compatErrors
          .map((i) => `${i.field}: ${i.message}`)
          .join('; ')
          .slice(0, 300);
      } else {
        const logsSince = input.logsSince ?? input.since;
        const from = logWindowFrom(logsSince);
        // Error signatures are scoped by service + window, NOT by the hint text:
        // the errors that matter to an incident rarely contain the hint words in
        // their message (the hint resolves the code seed; the service scopes logs).
        analysis = await deps.logs.analyzeErrors({ service: input.service, from });
        // Auto-widen: the 7-day default frequently misses a real incident only slightly older
        // — a common false "no error logs matched". When nothing matched and no window was
        // pinned (--logs-since / a duration --since), retry once at 30d and keep it only if it
        // actually surfaces signatures.
        if (analysis.signatures.length === 0 && logsSince === undefined) {
          const retry = await deps.logs.analyzeErrors({
            service: input.service,
            from: logWindowFrom('30d'),
          });
          if (retry.signatures.length > 0) analysis = retry;
        }
        logsCollected = true;

        // Seed relevance terms: used to classify each signature as 'direct' or
        // 'ambient' so unrelated high-volume errors don't dominate (HOR-156). In
        // degraded runtime-only mode there is no seed symbol, so terms come from the
        // hint alone (classifyLogRelevance handles an empty seed-term set).
        const seedBase = top ? top.filePath.split('/').pop() ?? '' : '';
        const logSeedTerms = top
          ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(seedBase)])]
          : [...new Set(tokenize(hint))];

        for (const s of analysis.signatures.slice(0, 15)) {
          const { relevanceClass, relevanceReason } = classifyLogRelevance(
            s.key,
            s.services,
            logSeedTerms,
            input.service,
          );

          const tags: string[] = [];
          if (relevanceClass === 'ambient') tags.push('ambient');
          if (s.isNew) tags.push('NEW');
          else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
            tags.push(`spike x${s.ratio.toFixed(1)}`);
          }
          const svc = s.services.length > 0 ? ` · ${s.services.slice(0, 3).join(', ')}` : '';
          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
          // HOR-330: surface a representative message so the error means something beyond a
          // bare count — e.g. "Error checking brand order fulfillment" points straight at the
          // (data) cause that the signature key + count alone never reveal.
          const msgStr = s.sampleMessage
            ? ` — "${s.sampleMessage.replace(/\s+/g, ' ').trim().slice(0, 90)}"`
            : '';
          const ev = mkEv(
            'log',
            `Error ${s.key}: ${s.count}x (first ${shortTs(s.firstSeen)}, last ${shortTs(s.lastSeen)})${svc}${tagStr}${msgStr}`.slice(
              0,
              220,
            ),
            {
              signature: s.key,
              count: s.count,
              firstSeen: s.firstSeen,
              lastSeen: s.lastSeen,
              services: s.services,
              isNew: s.isNew ?? false,
              ratio: s.ratio ?? null,
              sampleMessage: s.sampleMessage ?? null,
              relevanceClass,
              relevanceReason,
            },
            {},
            s.lastSeen || undefined,
            // Direct evidence: full recurrence weight. Ambient: demoted baseline.
            // This prevents unrelated high-volume errors from inflating confidence.
            relevanceClass === 'direct'
              ? s.isNew
                ? 0.95
                : s.ratio !== undefined && s.ratio >= 1.5
                  ? 0.90
                  : 0.85
              : s.isNew
                ? 0.70
                : s.ratio !== undefined && s.ratio >= 1.5
                  ? 0.55
                  : 0.35,
          );
          // Normalize recurrence signals to top-level Evidence fields so the
          // Cause Scoring Engine can read them without inspecting the payload.
          if (s.isNew) ev.isNew = s.isNew;
          if (typeof s.ratio === 'number' && Number.isFinite(s.ratio)) ev.ratio = s.ratio;
          logEvIds.push(ev.id);
          if (relevanceClass === 'direct') {
            directLogEvIds.push(ev.id);
            directSignatures.push({ key: s.key, count: s.count, message: s.sampleMessage ?? '' });
            if (!directEvIdByKey.has(s.key)) directEvIdByKey.set(s.key, ev.id);
          } else ambientLogEvIds.push(ev.id);
        }

        // CROSS-SIGNAL event_code JOIN — meritt's `event_code` is BOTH a source
        // raise-signature (a string literal in code) AND a structured Elasticsearch
        // field. analyzeErrors above only aggregates the top-N signatures, so a
        // SPECIFIC code the seed/hint cares about — but that isn't a top bucket — is
        // missed (the real "no logs" while ES held 438 HTTPFLT001 errors). Here we
        // pull the exact codes named by the source signal (hint + seed name + seed
        // source snippet) and query ES for each by its keyword field. A code that
        // returns count > 0 is an EXACT structured match to the source signal — the
        // strongest possible runtime link — so it becomes DIRECT, seed-linked
        // evidence. Best-effort: a logs failure never breaks the investigation.
        // Prefer the FULL seed body (sourceBody) over the bounded display snippet: a
        // runtime error RAISED FROM the seed has its code literal anywhere in the body,
        // often near the end — past the snippet cutoff (the maison
        // `E_FULFILLMENT_SYNC_ERROR_04` at order.service.ts:613 lives ~110 lines into the
        // function). Fall back to snippet when no full body is available.
        const seedSnippet =
          (ctx?.sourceBody !== undefined && ctx.sourceBody !== null
            ? ctx.sourceBody
            : undefined) ??
          (ctx?.snippet !== undefined && ctx.snippet !== null ? ctx.snippet : undefined);
        const sourceCodes = extractEventCodes(input.hint, top?.name, seedSnippet);
        // HOR-341: codes whose LITERAL appears in the seed's own source body are
        // seed-EMITTED — the seed RAISES them. A seed-emitted code with live ES
        // occurrences is the strongest possible link (not just a co-occurring code the
        // hint mentioned), so it is promoted to a dedicated headline cause below.
        const seedEmittedCodes = new Set(
          seedSnippet !== undefined ? extractEventCodes(seedSnippet) : [],
        );
        const joinedCodes = new Set(directSignatures.map((d) => d.key));
        for (const code of sourceCodes) {
          const alreadyJoined = joinedCodes.has(code);
          joinedCodes.add(code);
          try {
            const codeAnalysis = await deps.logs.analyzeErrors({
              service: input.service,
              from,
              eventCode: code,
            });
            const sig = codeAnalysis.signatures.find((s) => s.key === code);
            if (sig === undefined || sig.count <= 0) continue;

            // Dedup: a code already surfaced as a top signature is not re-added as
            // evidence — but if it is SEED-EMITTED it must still be promoted to a cause.
            // Reuse its existing direct evidence id when one exists.
            if (alreadyJoined) {
              if (seedEmittedCodes.has(code)) {
                const existingEvId = directEvIdByKey.get(code);
                if (existingEvId !== undefined) {
                  seedEmittedJoins.push({
                    code,
                    count: sig.count,
                    message: sig.sampleMessage ?? '',
                    evId: existingEvId,
                    isNew: sig.isNew ?? false,
                    level: sig.level ?? null,
                    raisedBySeed: true, // literal is in the seed's own body
                    raiserName: top?.name ?? '',
                  });
                }
              }
              continue;
            }

            const links: EvidenceLinks =
              top !== undefined
                ? top.startLine !== undefined && top.startLine > 0
                  ? { symbolId: top.id, file: top.filePath, line: top.startLine }
                  : { symbolId: top.id, file: top.filePath }
                : {};
            const ev = mkEv(
              'log',
              `event_code ${code}: ${sig.count}x in Elasticsearch (exact structured match to the source signal)`.slice(
                0,
                220,
              ),
              {
                signature: code,
                count: sig.count,
                firstSeen: sig.firstSeen,
                lastSeen: sig.lastSeen,
                services: sig.services,
                isNew: sig.isNew ?? false,
                ratio: sig.ratio ?? null,
                sampleMessage: sig.sampleMessage ?? null,
                relevanceClass: 'direct',
                relevanceReason: `exact event_code match to the source signal (${code})`,
                crossSignalJoin: true,
                seedEmitted: seedEmittedCodes.has(code),
              },
              links,
              sig.lastSeen || undefined,
              0.9,
            );
            if (sig.isNew) ev.isNew = sig.isNew;
            if (typeof sig.ratio === 'number' && Number.isFinite(sig.ratio)) ev.ratio = sig.ratio;
            logEvIds.push(ev.id);
            directLogEvIds.push(ev.id);
            directSignatures.push({
              key: code,
              count: sig.count,
              message: sig.sampleMessage ?? '',
            });
            if (!directEvIdByKey.has(code)) directEvIdByKey.set(code, ev.id);
            if (seedEmittedCodes.has(code)) {
              seedEmittedJoins.push({
                code,
                count: sig.count,
                message: sig.sampleMessage ?? '',
                evId: ev.id,
                isNew: sig.isNew ?? false,
                level: sig.level ?? null,
                raisedBySeed: true, // literal is in the seed's own body
                raiserName: top?.name ?? '',
              });
            }
          } catch {
            // best-effort per-code; a logs failure must never break the investigation
          }
        }

        // GAP D (dogfood): a runtime error RAISED FROM the seed — or a direct callee — is
        // seed-emitted even when its literal is NOT in the seed's own body. The literal scan
        // above misses two real cases: (1) the code is referenced by a constant KEY that
        // differs from the logged CODE value (`Logs.E_SYNC_PRODUCT_UPDATE_EXISTING` ↔ ES
        // `ERR4624`), and (2) it is raised in a callee (syncProduct → EmodaService.fetchProducts
        // → `EMODA_011`). Here we INVERT: for each observed ES code, resolve its raise-site
        // symbol via the backend (searchSymbols runs HOR-329 code→raise-site resolution, which
        // already handles the key↔code colocation) and treat the code as seed-emitted when its
        // raiser IS the seed or one of the seed's direct callees. The id match against the seed
        // scope is the precision guard; bounded by count + a hard cap to keep it cheap.
        if (top !== undefined && typeof deps.code?.searchSymbols === 'function') {
          const GAP_D_MAX_RESOLVE = 12;
          const seedScope = new Set<string>([top.id, ...(ctx?.callees ?? []).map((c) => c.id)]);
          const alreadyEmitted = new Set(seedEmittedJoins.map((j) => j.code));
          const eligible = analysis.signatures.filter(
            (s) => s.key !== '' && s.key !== '(none)' && s.count > 0 && !alreadyEmitted.has(s.key),
          );
          // Resolve the top codes BY COUNT, plus any code whose key/message is HINT-RELEVANT
          // even at lower volume (dogfood M1: "publishing products keeps failing" must reach
          // ERR_PROD_PUB_002 "Error occurred while publishing product" (5x) even though louder
          // unrelated codes crowd the top-N). Bounded so the extra resolution stays cheap.
          const meaningful = meaningfulHintTokens.filter((t) => t.length >= 4);
          const hintRelevant = (s: { key: string; sampleMessage?: string }): boolean =>
            meaningful.some(
              (t) =>
                s.key.toLowerCase().includes(t) ||
                (s.sampleMessage ?? '').toLowerCase().includes(t),
            );
          const candidates = [
            ...new Set([
              ...[...eligible].sort((a, b) => b.count - a.count).slice(0, GAP_D_MAX_RESOLVE),
              ...eligible.filter(hintRelevant).slice(0, GAP_D_MAX_RESOLVE),
            ]),
          ].slice(0, GAP_D_MAX_RESOLVE * 2);
          for (const sig of candidates) {
            let raisers: Symbol[] = [];
            try {
              raisers = await deps.code.searchSymbols(sig.key, 3);
            } catch {
              continue; // best-effort — a search failure must never break the investigation
            }
            // Prefer the SEED itself among the resolved raise sites, then a direct callee.
            // A code's search can rank a co-referencing function above its true raise site
            // (e.g. SALE_015_02's raise site `draftProductsForSale` is the 3rd hit), so check
            // the top few rather than only [0] — otherwise the seed's OWN error is missed and
            // a generic callee error headlines instead (dogfood GAP F).
            const raiser =
              raisers.find((r) => r.id === top.id) ?? raisers.find((r) => seedScope.has(r.id));
            if (raiser === undefined) continue;

            // Reuse the code's existing direct evidence if it already surfaced; otherwise
            // synthesize one tying the code to its raise site so the join cites real,
            // seed-linked evidence.
            let evId = directEvIdByKey.get(sig.key);
            if (evId === undefined) {
              const where = raiser.id === top.id ? 'the seed' : 'a callee of the seed';
              const links: EvidenceLinks =
                raiser.startLine !== undefined && raiser.startLine > 0
                  ? { symbolId: raiser.id, file: raiser.filePath, line: raiser.startLine }
                  : { symbolId: raiser.id, file: raiser.filePath };
              const ev = mkEv(
                'log',
                `event_code ${sig.key}: ${sig.count}x in Elasticsearch — raised by ${raiser.name} (${where})`.slice(
                  0,
                  220,
                ),
                {
                  signature: sig.key,
                  count: sig.count,
                  firstSeen: sig.firstSeen,
                  lastSeen: sig.lastSeen,
                  services: sig.services,
                  isNew: sig.isNew ?? false,
                  ratio: sig.ratio ?? null,
                  sampleMessage: sig.sampleMessage ?? null,
                  relevanceClass: 'direct',
                  relevanceReason: `event_code ${sig.key} is raised by ${raiser.name} (${where})`,
                  crossSignalJoin: true,
                  seedEmitted: true,
                },
                links,
                sig.lastSeen || undefined,
                0.9,
              );
              if (sig.isNew) ev.isNew = sig.isNew;
              if (typeof sig.ratio === 'number' && Number.isFinite(sig.ratio)) ev.ratio = sig.ratio;
              logEvIds.push(ev.id);
              directLogEvIds.push(ev.id);
              directSignatures.push({ key: sig.key, count: sig.count, message: sig.sampleMessage ?? '' });
              directEvIdByKey.set(sig.key, ev.id);
              evId = ev.id;
            }
            seedEmittedJoins.push({
              code: sig.key,
              count: sig.count,
              message: sig.sampleMessage ?? '',
              evId,
              isNew: sig.isNew ?? false,
              level: sig.level ?? null,
              raisedBySeed: raiser.id === top.id,
              raiserName: raiser.name,
            });
          }
        }

        // HOR-215: surface the DISTINCT failing entities behind the dominant error
        // signature (e.g. "16 brands × 50 orders") instead of only a signature count.
        // Pick the top signature that carries id-like context fields and aggregate
        // each, scoped to that signature. Best-effort — never breaks the investigation.
        if (typeof deps.logs.aggregateErrors === 'function') {
          const sigForEntities = analysis.signatures.find(
            (s) => detectEntityFields(s.sampleContext).length > 0,
          );
          if (sigForEntities !== undefined) {
            for (const f of detectEntityFields(sigForEntities.sampleContext)) {
              try {
                const buckets = await deps.logs.aggregateErrors(
                  {
                    service: input.service,
                    from,
                    eventCode:
                      sigForEntities.key !== '(none)' ? sigForEntities.key : undefined,
                  },
                  `context.${f}`,
                );
                if (buckets.length > 0) {
                  const top3 = buckets
                    .slice(0, 3)
                    .map((b) => `${b.key} (${b.count}x)`)
                    .join(', ');
                  // aggregateErrors caps at 20 buckets — show "N+" when saturated.
                  const plus = buckets.length >= 20 ? '+' : '';
                  const ev = mkEv(
                    'log',
                    `Distinct context.${f} for ${sigForEntities.key}: ${buckets.length}${plus} value(s) (top: ${top3})`.slice(
                      0,
                      180,
                    ),
                    {
                      field: `context.${f}`,
                      signature: sigForEntities.key,
                      distinctShown: buckets.length,
                      capped: buckets.length >= 20,
                      top: buckets.slice(0, 10),
                    },
                    {},
                    undefined,
                    0.6,
                  );
                  entityEvIds.push(ev.id);
                  entitySummaries.push(`${buckets.length}${plus} ${f}`);
                }
              } catch {
                // best-effort per-field; skip on error
              }
            }
          }
        }
      }
    } catch (logsErr) {
      // Logs failure must never break the investigation — continue without log evidence.
      // logsCollected stays false — gap detector will report the failure + reason.
      analysis = null;
      logsFailureReason = connectorFailureReason(logsErr);
    }
  }

  // e0a2. SENTRY ERROR EVIDENCE (HOR-CONNECTORS) — grouped exceptions (issues) folded
  // into the SAME error-signature / directSignatures / seed path as Elasticsearch logs.
  // Each issue is both "what's the error" (title + culprit + count + frequency) AND a
  // direct code seed (its latest event's top in-app stack frame → filePath:fn:line).
  // Optional; a configured-but-empty Sentry is negative evidence (not a gap). One failing
  // provider must never abort the investigation.
  let sentryCollected = false;
  let sentryFailureReason: string | undefined;
  let sentryIssueCount = 0;
  if (deps.sentry) {
    try {
      const from = logWindowFrom(input.logsSince ?? input.since);
      const to = new Date().toISOString();
      // Seed terms mirror the log block: hint + seed symbol + seed file base, so a Sentry
      // frame that points at the implicated code is classified 'direct' (HOR-156).
      const sentrySeedBase = top ? top.filePath.split('/').pop() ?? '' : '';
      const sentryTerms = top
        ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(sentrySeedBase)])]
        : [...new Set(tokenize(hint))];
      const seedFileBase = top ? (top.filePath.split('/').pop() ?? '').toLowerCase() : '';

      const signatures = await deps.sentry.collect({ from, to, hintTerms: sentryTerms });
      sentryCollected = true;
      sentryIssueCount = signatures.length;

      for (const sig of signatures.slice(0, 15)) {
        const { issue, frame } = sig;
        // A signature "key" the relevance classifier can tokenize: the issue title plus
        // culprit + frame symbol/file (so domain terms in any of them count).
        const sigKey = [issue.title, issue.culprit ?? '', frame?.function ?? '', frame?.filename ?? '']
          .filter(Boolean)
          .join(' ');
        // The frame's file is the strongest link: when it matches the resolved seed file,
        // this issue IS the error at the seed — force 'direct'.
        const frameFileBase = (frame?.filename ?? '').split('/').pop()?.toLowerCase() ?? '';
        const frameMatchesSeed =
          seedFileBase.length > 0 && frameFileBase.length > 0 &&
          (frameFileBase === seedFileBase || frameFileBase.includes(seedFileBase) || seedFileBase.includes(frameFileBase));

        const { relevanceClass: classified, relevanceReason } = classifyLogRelevance(
          sigKey,
          frame?.filename ? [frame.filename] : [],
          sentryTerms,
          input.service,
        );
        const relevanceClass: LogRelevanceClass = frameMatchesSeed ? 'direct' : classified;
        const reason = frameMatchesSeed
          ? `Sentry frame at seed file ${frame?.filename ?? ''}`
          : relevanceReason;

        const frameLoc = frame?.filename
          ? ` @ ${frame.filename}${frame.lineno !== undefined ? `:${frame.lineno}` : ''}`
          : '';
        const culprit = issue.culprit ? ` · ${issue.culprit}` : '';
        const tag = relevanceClass === 'ambient' ? ' [ambient]' : '';
        const title =
          `Sentry ${issue.title}: ${issue.count}x${issue.userCount > 0 ? ` · ${issue.userCount} user(s)` : ''} (last ${shortTs(issue.lastSeen ?? '')})${culprit}${frameLoc}${tag}`.slice(
            0,
            220,
          );

        const links: EvidenceLinks = {};
        if (frame?.filename !== undefined) links.file = frame.filename;
        if (frame?.lineno !== undefined) links.line = frame.lineno;

        const ev = mkEv(
          'log',
          title,
          {
            source: 'sentry',
            issueId: issue.id,
            signature: issue.title,
            count: issue.count,
            userCount: issue.userCount,
            culprit: issue.culprit ?? null,
            level: issue.level ?? null,
            lastSeen: issue.lastSeen ?? null,
            firstSeen: issue.firstSeen ?? null,
            permalink: issue.permalink ?? null,
            // Direct code seed — same fields the engine reads off a code symbol.
            filePath: frame?.filename ?? null,
            symbolName: frame?.function ?? null,
            lineStart: frame?.lineno ?? null,
            relevanceClass,
            relevanceReason: reason,
          },
          links,
          issue.lastSeen || undefined,
          // Direct: full error weight, boosted when the raise-site frame is resolved.
          // Ambient: demoted so unrelated high-volume groups don't inflate confidence.
          relevanceClass === 'direct'
            ? frame?.filename
              ? 0.95
              : 0.85
            : 0.4,
        );
        logEvIds.push(ev.id);
        if (relevanceClass === 'direct') {
          directLogEvIds.push(ev.id);
          directSignatures.push({ key: issue.title, count: issue.count, message: issue.title });
        } else {
          ambientLogEvIds.push(ev.id);
        }
      }
    } catch (sentryErr) {
      // Sentry failure must never break the investigation — continue without it.
      sentryCollected = false;
      sentryFailureReason = connectorFailureReason(sentryErr);
    }
  }

  // e0a3. AXIOM LOG EVIDENCE (HOR-429) — structured log rows from an APL query folded
  // into the SAME log-evidence path as Elasticsearch + Sentry. Each row becomes one
  // kind:'log' Evidence, relevance-classified against the seed via classifyLogRelevance
  // (direct rows seed directSignatures; ambient rows are demoted noise). Optional; a
  // configured-but-empty Axiom is negative evidence (not a gap). One failing provider
  // must never abort the investigation.
  let axiomCollected = false;
  let axiomFailureReason: string | undefined;
  if (deps.axiom) {
    try {
      const from = logWindowFrom(input.logsSince ?? input.since);
      const to = new Date().toISOString();
      // Seed terms mirror the log/Sentry blocks: hint + seed symbol + seed file base, so a
      // row that mentions the implicated code/domain is classified 'direct' (HOR-156).
      const axiomSeedBase = top ? top.filePath.split('/').pop() ?? '' : '';
      const axiomTerms = top
        ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(axiomSeedBase)])]
        : [...new Set(tokenize(hint))];

      const records = await deps.axiom.collect({ from, to, hintTerms: axiomTerms });
      axiomCollected = true;

      for (const rec of records.slice(0, 15)) {
        const msg = pickAxiomField(rec.fields, AXIOM_MESSAGE_FIELDS);
        const level = pickAxiomField(rec.fields, AXIOM_LEVEL_FIELDS);
        const svc = pickAxiomField(rec.fields, AXIOM_SERVICE_FIELDS) ?? '';
        // sigKey the classifier can tokenize: message body + service so domain terms count.
        const sigKey = [msg ?? '', svc].filter(Boolean).join(' ');

        const { relevanceClass, relevanceReason } = classifyLogRelevance(
          sigKey,
          svc ? [svc] : [],
          axiomTerms,
          input.service,
        );

        const lvl = level ? `[${level}] ` : '';
        const body = msg ?? '(log event)';
        const tag = relevanceClass === 'ambient' ? ' [ambient]' : '';
        const title = `Axiom log: ${lvl}${body}${tag}`.slice(0, 220);

        const isError = ['error', 'fatal', 'critical'].includes((level ?? '').toLowerCase());
        const ev = mkEv(
          'log',
          title,
          {
            source: 'axiom',
            signature: msg ?? null,
            level: level ?? null,
            service: svc || null,
            relevanceClass,
            relevanceReason,
            fields: rec.fields,
          },
          {},
          rec.timestamp,
          // Direct: weighted up for error-level rows. Ambient: demoted so unrelated
          // high-volume log lines don't inflate confidence.
          relevanceClass === 'direct' ? (isError ? 0.9 : 0.75) : 0.4,
        );
        logEvIds.push(ev.id);
        if (relevanceClass === 'direct') {
          directLogEvIds.push(ev.id);
          directSignatures.push({ key: msg ?? '(log event)', count: 1, message: msg ?? '' });
        } else {
          ambientLogEvIds.push(ev.id);
        }
      }
    } catch (axiomErr) {
      // Axiom failure must never break the investigation — continue without it.
      axiomCollected = false;
      axiomFailureReason = connectorFailureReason(axiomErr);
    }
  }

  // e0a4. DURATION-BY-DIMENSION (HOR-435, lever #2) — the ERROR-only log path is blind to the
  // ground truth for a duration/latency anomaly, which lives in INFO completion lines
  // ("Completed MANAGE_SALES:KSA ~2m10s / UAE ~19ms"). For a duration/latency/anomaly-themed
  // hint we ALSO run the connector `analyzeDurations` query (on Elasticsearch AND Axiom) and
  // fold a `Duration by <dimension>: KSA 2m10s, UAE 19ms` evidence row with per-segment stats
  // in the payload. This is what lets the engine see per-segment variance — and SUPPORTS the
  // benign-variance hypothesis — instead of reading a skewed average as a uniform regression.
  // Best-effort + opt-in by hint shape: a provider without `analyzeDurations`, a null result,
  // or a thrown query simply contributes nothing. Never breaks the investigation.
  if (looksDurationThemed(hint)) {
    const from = logWindowFrom(input.logsSince ?? input.since);
    const baseDurationOpts: DurationDimensionOptions = input.durationDimension ?? {
      // Conservative default for the common `Completed <JOB>:<REGION> ~2m10s` shape: extract an
      // alphanumeric token after a colon as the dimension, scoped to completion lines, parsing
      // the duration out of the message. A non-matching corpus yields null (graceful).
      dimension: { name: 'region', pattern: ':\\s*([A-Za-z][\\w-]+)' },
      completionText: 'Completed',
    };
    const durationOpts: DurationDimensionOptions = {
      ...baseDurationOpts,
      from: baseDurationOpts.from ?? from,
      ...(input.service !== undefined && baseDurationOpts.service === undefined
        ? { service: input.service }
        : {}),
      level: baseDurationOpts.level ?? 'info',
    };
    const durationProviders: Array<{
      source: string;
      analyze: (o: DurationDimensionOptions) => Promise<DurationByDimension | null>;
    }> = [];
    if (deps.logs && typeof deps.logs.analyzeDurations === 'function') {
      durationProviders.push({ source: 'elasticsearch', analyze: (o) => deps.logs!.analyzeDurations(o) });
    }
    if (deps.axiom && typeof deps.axiom.analyzeDurations === 'function') {
      durationProviders.push({ source: 'axiom', analyze: (o) => deps.axiom!.analyzeDurations(o) });
    }
    for (const provider of durationProviders) {
      try {
        const result = await provider.analyze(durationOpts);
        if (result === null) continue;
        const values = Object.entries(result.byValue);
        if (values.length === 0) continue;
        // "KSA 2m10s, UAE 19ms" — sorted slowest-first so the variance reads at a glance.
        const summary = values
          .sort((a, b) => b[1].avg - a[1].avg)
          .map(([val, st]) => `${val} ${formatDurationMs(st.avg)}`)
          .join(', ');
        const ev = mkEv(
          'log',
          `Duration by ${result.dimension}: ${summary}`.slice(0, 220),
          {
            source: provider.source,
            kind: 'duration-by-dimension',
            dimension: result.dimension,
            unit: result.unit,
            byValue: result.byValue,
            sampleCount: result.sampleCount,
          },
          {},
          undefined,
          0.6,
        );
        perDimensionDurationEvIds.push(ev.id);
      } catch {
        // Best-effort per provider — a duration query failure never breaks the investigation.
      }
    }
  }

  // e0b. MONGODB STATE (HOR-33) — application-state anomalies as evidence. Optional;
  // never breaks the investigation on failure. Counts/state only — no raw documents.
  let stateAnalysis: StateAnalysis | null = null;
  const stateEvIds: string[] = [];
  const stateCollections = new Set<string>();
  // HOR-332: anomaly state signals (records stuck in a failed/stale state) are a data
  // CAUSE class, not just a finding — many prod incidents are data, not code.
  const dataAnomalyEvIds: string[] = [];
  const dataAnomalyCollections: string[] = [];

  // Any configured state provider (Mongo and/or Postgres) contributes the same
  // state-evidence shape; one provider failing must not abort the others.
  const stateProviders: Array<{ name: 'mongodb' | 'postgres'; provider: StateProvider }> = [
    ...(deps.mongo ? [{ name: 'mongodb' as const, provider: deps.mongo }] : []),
    ...(deps.postgres ? [{ name: 'postgres' as const, provider: deps.postgres }] : []),
  ];
  // Undefined when NO state provider (Mongo/Postgres/Redis state) is configured, so old
  // reports and provider-less runs never fire the 'application state' gap; false when at
  // least one configured provider threw. Failures carry only leak-safe categories.
  let stateCollected: boolean | undefined =
    stateProviders.length > 0 || deps.redisState != null ? true : undefined;
  const stateFailures: string[] = [];
  for (const { name, provider } of stateProviders) {
    try {
      const analysis = await provider.analyzeState();
      stateAnalysis = analysis;
      // Relevance terms: hint tokens only. Using seed name/file tokens (e.g. "service"
      // from BrandService) causes generic architectural words to match unrelated
      // collections (e.g. "services", "handlers"). Domain context lives in the hint.
      const stateTerms = [...new Set(tokenize(hint))];
      for (const s of selectStateSignals(analysis, stateTerms)) {
        const ev = mkEv('state', s.title, s.payload, {}, s.timestamp, s.relevance);
        stateEvIds.push(ev.id);
        stateCollections.add(s.collection);
        if (s.kind === 'anomaly') {
          dataAnomalyEvIds.push(ev.id);
          dataAnomalyCollections.push(s.collection);
        }
      }
    } catch (stateErr) {
      // Leave any prior provider's analysis intact.
      stateCollected = false;
      stateFailures.push(`${name}: ${connectorFailureReason(stateErr)}`);
    }
  }

  // e0b2. REDIS RUNTIME STATE (HOR-201) — cache/state/locks/rate-limit summaries as
  // evidence. Optional; never breaks the investigation on failure. Counts/prefixes
  // only — no key values.
  let redisStateAnalysis: RedisStateAnalysis | null = null;
  const redisStateEvIds: string[] = [];
  if (deps.redisState) {
    try {
      redisStateAnalysis = await deps.redisState.analyzeRedisState();
      const redisTerms = [...new Set(tokenize(hint))];
      for (const s of redisStateAnalysis.signals) {
        // Boost relevance when a hint term appears in the signal's match text.
        const matched = redisTerms.some((t) => t.length > 2 && s.matchText.includes(t));
        const relevance = matched ? Math.min(1, s.relevance + 0.3) : s.relevance;
        const ev = mkEv('redis-key', s.title, s.payload, {}, redisStateAnalysis.collectedAt, relevance);
        redisStateEvIds.push(ev.id);
      }
    } catch (redisErr) {
      redisStateAnalysis = null;
      // Redis-key evidence maps to the same 'state' source (sourceForKind), so a Redis
      // failure folds into the state dimension exactly like a Mongo/Postgres throw.
      stateCollected = false;
      stateFailures.push(`redis: ${connectorFailureReason(redisErr)}`);
    }
  }
  const stateFailureReason =
    stateFailures.length > 0 ? stateFailures.join('; ').slice(0, 160) : undefined;

  // e0c. QUEUE RUNTIME STATE (HOR-12) — backlog, failures, starvation as evidence.
  // Scoped to the queues that appear in the stitcher edges so we only query what's
  // relevant to this investigation. Optional; never breaks on failure.
  let queueRuntimeState: QueueRuntimeState | null = null;
  const queueRuntimeEvIds: string[] = [];
  // Per-queue evidence IDs — three views: all, backlog-only, starvation-only.
  // Keeping them separate prevents cross-queue evidence contamination in hypotheses.
  const queueRuntimeEvIdsByQueue = new Map<string, string[]>();
  const queueBacklogEvIdsByQueue = new Map<string, string[]>();
  const queueStarvationEvIdsByQueue = new Map<string, string[]>();
  // HOR-328 round-2: dominant queue failed-job reasons (e.g. "getaddrinfo ENOTFOUND"),
  // captured so a network/dependency failure that only surfaces in queue forensics — not
  // the live error-log stream — can still be promoted to a cause (the GAIA DNS case).
  const queueFailureSignals: {
    reason: string;
    queueName: string;
    evId: string;
    count: number;
    stale: boolean;
  }[] = [];
  // False + queue configured means live collection was attempted but failed — the gap
  // detector keys on the strict false so provider-less runs / old reports stay silent.
  let queueCollected = false;
  let queueFailureReason: string | undefined;

  if (deps.queue) {
    try {
      // Probe the UNION of statically-known queues (from stitcher edges) and queues
      // discovered live in Redis (HOR-205) — the same union `horus queues --live`
      // uses. Static-only probing (queueHits) skipped live queue evidence entirely
      // whenever the hint matched no static queue edge, and hid runtime-only queues
      // (present in BullMQ with no static producer/worker mapping, e.g. a failing
      // sync job) even when a queue was hit. Discovery is best-effort: a failure
      // falls back to the static names so a flaky scan never drops known queues.
      const staticNames = [...new Set(queueHits.map((e) => e.queueName))];
      // Follow-up: a discovery failure with zero static names silently skips live
      // collection — surfacing that case is deferred (the analyzeQueues catch below
      // covers explicit collection failures).
      const discovered = await deps.queue.discoverQueues().catch(() => [] as string[]);
      const queueNames = [...new Set([...staticNames, ...discovered])];
      if (queueNames.length > 0) {
        queueRuntimeState = await deps.queue.analyzeQueues({ queueNames });
      }
      for (const s of analyzeQueueRuntime(queueRuntimeState ?? { prefix: '', collectedAt: '', queues: [] })) {
        const ev = mkEv('queue-state', s.title, s.payload, { queueName: s.queueName }, s.timestamp, s.relevance);
        queueRuntimeEvIds.push(ev.id);
        const perQueue = queueRuntimeEvIdsByQueue.get(s.queueName) ?? [];
        perQueue.push(ev.id);
        queueRuntimeEvIdsByQueue.set(s.queueName, perQueue);
        if (s.kind === 'backlog') {
          const bl = queueBacklogEvIdsByQueue.get(s.queueName) ?? [];
          bl.push(ev.id);
          queueBacklogEvIdsByQueue.set(s.queueName, bl);
        } else if (s.kind === 'worker-starvation') {
          const st = queueStarvationEvIdsByQueue.get(s.queueName) ?? [];
          st.push(ev.id);
          queueStarvationEvIdsByQueue.set(s.queueName, st);
        }
        if (s.kind === 'failed-breakdown') {
          const p = s.payload as { topReason?: unknown; topCount?: unknown; topStale?: unknown };
          if (typeof p.topReason === 'string') {
            queueFailureSignals.push({
              reason: p.topReason,
              queueName: s.queueName,
              evId: ev.id,
              count: typeof p.topCount === 'number' ? p.topCount : 0,
              stale: p.topStale === true,
            });
          }
        }
      }
      // Set only after the full collection + analysis loop completes without error.
      queueCollected = true;
    } catch (queueErr) {
      // queueCollected stays false — gap detector will report the failure + reason.
      queueRuntimeState = null;
      queueFailureReason = connectorFailureReason(queueErr);
    }
  }

  // e0d. METRIC EVIDENCE (HOR-11 / HOR-40) — Grafana anomaly findings scoped by hint.
  // Optional; never breaks the investigation on failure.
  // Timeout is generous (30 s) because dashboard discovery + dual-window queries
  // per panel can easily exceed 10 s on a real Grafana instance. `horus metrics`
  // has no timeout, so we match its effective behaviour here.
  const METRICS_TIMEOUT_MS = 30_000;
  const metricEvIds: string[] = [];
  const latencyMetricEvIds: string[] = [];
  // HOR-435 (lever #3): ids of `bimodal-population` metric findings (a high-spike cluster AND
  // a low/zero cluster co-present on one panel) — possible per-segment variance, not a uniform
  // regression. These SUPPORT the benign-variance hypothesis and carry lower relevance.
  const bimodalMetricEvIds: string[] = [];
  const queueMetricEvIds: string[] = [];
  // Per-queue metric IDs — queue-growth anomalies attributed to the matching queue name.
  const queueMetricEvIdsByQueue = new Map<string, string[]>();
  // Neutral/contradicting metric evidence: metrics WERE checked but found no anomaly.
  // Recorded so replay/postmortem show metrics were inspected (and weaken metric-driven
  // causes) rather than the result staying external to the investigation (HOR-203).
  const nominalMetricEvIds: string[] = [];
  let metricsCollected = false;
  let metricsFailureReason: string | undefined;
  let metricSeriesChecked = 0;

  if (deps.metrics) {
    const ac = new AbortController();
    let metricsTimerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const fromMs = new Date(logWindowFrom(input.logsSince ?? input.since)).getTime();
      const toMs = Date.now();
      metricsTimerId = setTimeout(() => ac.abort(new Error('metrics timeout')), METRICS_TIMEOUT_MS);
      // unref() prevents the timer from keeping the Node process alive.
      (metricsTimerId as { unref?: () => void }).unref?.();
      const mFindings = await deps.metrics.analyze({
        hint: input.hint,
        from: Math.floor(fromMs / 1000),
        to: Math.floor(toMs / 1000),
        signal: ac.signal,
      });

      const mEvidence = deps.metrics.toEvidence(mFindings);
      const anomalous = mFindings.filter((f) => f.anomaly !== 'none');
      // findingsToEvidence produces sequential ev_metric_N ids; replace with UUIDs
      // so they are unique across investigations in the DB.
      // Correlate each anomaly to the implicated path before wiring to hypotheses:
      // queue-growth must reference a known queue name; latency/error-rate must match
      // the investigated service when one is given — without a service scope the
      // correlation is too loose to be causal evidence.
      // Canonical-to-normalized map: match using normalized form, store under original case.
      // A queue named 'OrderSync' lowercases to 'ordersync', which is what appears in
      // panel titles. Storing by canonical name ensures hypothesis lookup succeeds.
      const queueNormToCanonical = new Map<string, string>();
      for (const edge of queueHits) {
        const norm = edge.queueName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!queueNormToCanonical.has(norm)) queueNormToCanonical.set(norm, edge.queueName);
      }
      const serviceFilter = (input.service ?? '').toLowerCase();
      const collectedAt = new Date().toISOString();
      // Tracks which evidence IDs have already been added to queueMetricEvIds so
      // a panel matching multiple queues doesn't insert the same ID twice.
      const seenQueueMetricEvIds = new Set<string>();

      for (let i = 0; i < mEvidence.length; i++) {
        const ev = mEvidence[i];
        if (ev === undefined) continue;
        ev.id = globalThis.crypto.randomUUID();
        // Override sequential provenance with the actual investigation hint.
        ev.provenance = { query: hint, collectedAt };
        evidence.push(ev);
        metricEvIds.push(ev.id);

        const f = anomalous[i];
        if (f === undefined) continue;

        const panelLower = f.panelTitle.toLowerCase();
        const labelVals = Object.values(f.labels).map((v) => v.toLowerCase());

        if (f.anomaly === 'latency-spike' || f.anomaly === 'error-rate-change') {
          // Promote a latency/error-rate spike to a CAUSE when it's scoped to the
          // investigated service OR — with no --service — when the panel/labels match the
          // hint (HOR-328 round-2: a "scheduler run duration latency spike" hint must lift
          // the matching x139 anomaly into a cause, not leave it unranked in evidence).
          const matchesService =
            serviceFilter.length > 0 &&
            (panelLower.includes(serviceFilter) || labelVals.some((v) => v.includes(serviceFilter)));
          // Only promote on a hint match when the hint is actually PERFORMANCE-flavored —
          // else a latency panel named after a domain noun (e.g. "GetProduct p95") gets
          // lifted into the cause for any "product …" hint and metric-anomaly headlines
          // everything (round-2 over-fire).
          const hintIsPerf =
            /\b(latenc|slow|spike|perf|throughput|duration|p9[5-9]|timeout|response\s*time|degrad)/i.test(
              hint,
            );
          const matchesHint =
            serviceFilter.length === 0 &&
            hintIsPerf &&
            hintTokens.some(
              (t) => t.length >= 4 && (panelLower.includes(t) || labelVals.some((v) => v.includes(t))),
            );
          // GAP B: a generic latency hint ("checkout is slow") rarely shares a token with a
          // latency PANEL ("GraphQL p95 Latency"), so the token match above misses and the
          // latency spike never becomes a cause — leaving the headline to fall to an unrelated
          // log code. For an explicitly performance-flavored hint with no --service, a
          // latency-spike anomaly IS the relevant evidence; promote it. Scoped to latency
          // spikes (not error-rate) and gated on hintIsPerf so non-perf hints never over-fire.
          const genericPerf =
            serviceFilter.length === 0 && hintIsPerf && f.anomaly === 'latency-spike';
          if (matchesService || matchesHint || genericPerf) latencyMetricEvIds.push(ev.id);
        } else if (f.anomaly === 'bimodal-population') {
          // HOR-435 (lever #3): a two-population panel (high-spike cluster AND low/zero
          // cluster) is possible per-segment variance, not a uniform regression — wire it to
          // the benign-variance hypothesis rather than treating it as a confident latency cause.
          bimodalMetricEvIds.push(ev.id);
        } else if (f.anomaly === 'queue-growth') {
          // Attribute each queue-growth anomaly to the specific queue(s) it matches.
          // Match using normalized panel/label strings with word-boundary checks so
          // 'orders' does not match inside 'preorders'. Store under canonical queue name
          // so hypothesis lookup (which uses original case) finds the entry.
          const panelNorm = f.panelTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const labelNorms = Object.values(f.labels).map(
            (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          );
          for (const [norm, canonical] of queueNormToCanonical) {
            const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^| )${escaped}(?:$| )`);
            const matchesQueue = re.test(panelNorm) || labelNorms.some((lv) => re.test(lv));
            if (matchesQueue) {
              if (!seenQueueMetricEvIds.has(ev.id)) {
                seenQueueMetricEvIds.add(ev.id);
                queueMetricEvIds.push(ev.id);
              }
              const list = queueMetricEvIdsByQueue.get(canonical) ?? [];
              if (!list.includes(ev.id)) list.push(ev.id);
              queueMetricEvIdsByQueue.set(canonical, list);
            }
          }
        }
      }
      // Metrics were collected but found NO anomaly: record a neutral evidence item so
      // the result is part of the investigation (visible in replay/postmortem, closes the
      // metrics gap, and acts as contradicting context for any metric-driven hypothesis).
      metricSeriesChecked = mFindings.length;
      if (metricEvIds.length === 0 && mFindings.length > 0) {
        const panels = [...new Set(mFindings.map((f) => f.panelTitle))];
        const ev = mkEv(
          'metric',
          `Metrics checked — ${mFindings.length} series across ${panels.length} panel(s), no anomalies in window`,
          { seriesChecked: mFindings.length, panelCount: panels.length, panels: panels.slice(0, 10), anomalies: 0, stance: 'neutral' },
          {},
          collectedAt,
          0.2,
        );
        nominalMetricEvIds.push(ev.id);
      }
      // Set only after the full collection + conversion loop completes without error.
      metricsCollected = true;
    } catch (metricsErr) {
      // Metrics failure (including timeout) must never break the investigation.
      // metricsCollected stays false — gap detector will report the failure + reason.
      // Category only — a raw Grafana error can embed the instance URL, which must
      // never land verbatim in gap.why / the persisted report.
      metricsFailureReason = connectorFailureReason(metricsErr);
    } finally {
      // Always clear the timer to prevent it from firing after a fast response
      // and to release the reference regardless of the outcome.
      if (metricsTimerId !== undefined) clearTimeout(metricsTimerId);
    }
  }

  // e0e. OWNERSHIP (HOR-20 / HOR-40) — estimate likely maintainer from git history.
  // Reuses the already-resolved seed symbol to skip a duplicate source-intelligence search.
  // Optional; needs repoPath AND a resolved seed + source provider — skipped in
  // degraded runtime-only mode. Never breaks on failure.
  let ownershipEstimate: OwnershipEstimate | null = null;
  if (deps.repoPath && top && code) {
    try {
      ownershipEstimate = await estimateOwnership(top.name, {
        code,
        repoPath: deps.repoPath,
        symbol: top,
      });
    } catch {
      ownershipEstimate = null;
    }
  }

  // e0e2. SHOPIFY EVIDENCE — run the caller-supplied (`input.shopifyQueries`) or, as a
  // fallback, config-declared Shopify Admin GraphQL queries verbatim and fold each result as
  // `state` (or `log`/`metric`) evidence. The engine binds only the investigation window into
  // `$from`/`$to`; the query text is never built here. hint + seed terms weight relevance,
  // exactly like the log/Sentry/Axiom blocks. Best-effort: a failing query contributes nothing
  // and never aborts the investigation.
  let shopifyCollected = false;
  let shopifyFailureReason: string | undefined;
  if (deps.shopify) {
    try {
      const from = logWindowFrom(input.logsSince ?? input.since);
      const to = new Date().toISOString();
      const shopifySeedBase = top ? top.filePath.split('/').pop() ?? '' : '';
      const shopifyTerms = top
        ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(shopifySeedBase)])]
        : [...new Set(tokenize(hint))];

      const records = await deps.shopify.collect({
        from,
        to,
        hintTerms: shopifyTerms,
        ...(input.shopifyQueries !== undefined ? { queries: input.shopifyQueries } : {}),
      });
      shopifyCollected = true;

      const collectedAt = new Date().toISOString();
      for (const ev of deps.shopify.toEvidence(records, shopifyTerms, collectedAt)) {
        // Re-stamp the per-query id with a UUID so it is unique across investigations in the
        // DB; the provider's per-query provenance (`shopify <store> <name>`) is preserved.
        ev.id = globalThis.crypto.randomUUID();
        evidence.push(ev);
      }
    } catch (shopifyErr) {
      // Shopify failure must never break the investigation — continue without it.
      shopifyCollected = false;
      shopifyFailureReason = connectorFailureReason(shopifyErr);
    }
  }

  // e0f. NORMALIZE — fill in cross-provider priority + category (and, when the
  // scope is known, the subject) before any downstream step reads them. Idempotent;
  // safe to call even if a provider failed and contributed zero items. Subject is
  // derived from the investigation scope, the same discipline as priority/category.
  normalizeEvidence(evidence, { service: input.service, environment: input.environment });

  // e0g. GRAPH — derive infrastructure topology from normalized evidence. Built
  // here so implication scores are available when scoring suspected causes below.
  const graph = buildGraph(evidence);

  // e. TIMELINE (deterministic; built after all evidence is accumulated)
  const timeline = buildTimeline(evidence);

  // HOR-406 (round 2): is the most-recent in-window change RELEVANT to the seed — a non-noise
  // commit (not bot/merge/release/pre-commit-autoupdate) that actually touches the seed's file
  // within a non-trivial diff? Computed ONCE and threaded into BOTH the correlation cause-chains
  // and hypothesis generation so neither asserts "a recent change to <seed> introduced the fault"
  // off noise. Round 1 gated only the suspected-causes ranker (which deflates to ~0.18 "none
  // touched <seed>"); without this, the Hypotheses + Cause-chains sections still inflated the same
  // regression to 0.80/0.88 off a bot/merge/release/no-op most-recent commit — the report then
  // self-contradicted ("[0.80] recent change to X" vs "[0.18] none touched X"), a false-grounding
  // honesty violation. The flag deflates those sections consistently with the ranker.
  const recentChangeRelevant = seedTouchedByRelevantChange(recentChanges, top?.filePath);

  // e2. CORRELATION (deterministic grouping + cause chains + missing evidence)
  // HOR-410 (round 2): pass real queue topology so the missing-evidence list does not
  // fabricate a queue subsystem (and its Redis/BullMQ tooling) on non-queue stacks.
  const hasQueueTopology = queueEvByName.size > 0;
  const correlation = correlate(evidence, { recentChangeRelevant, hasQueueTopology });

  // e3. HYPOTHESES (HOR-24) — deterministic competing set
  const queueNames = [...queueEvByName.keys()];
  const hyps = generateHypotheses(evidence, correlation, {
    seedLabel: label,
    queues: queueNames,
    latencyMetricEvIds,
    queueBacklogEvIdsByQueue,
    queueStarvationEvIdsByQueue,
    queueMetricEvIdsByQueue,
    sinceProvided: input.since !== undefined,
    suppressRuntimeHypotheses: sourceImpactHint,
    recentChangeRelevant,
    graph,
    // HOR-435: per-segment duration breakdown (#2) + bimodal-population metric (#3) support
    // the benign-variance hypothesis (#4); the suggested categories de-anchor alert text (#1).
    perDimensionDurationEvIds,
    bimodalMetricEvIds,
    // HOR-438: code-detected per-segment queue structure — a real, code-grounded support
    // for benign-variance (one queue per market/region/tenant ⇒ per-segment variance is
    // expected, not a uniform failure).
    perSegmentQueueStructureEvIds,
    benignVarianceApplicable:
      looksDurationThemed(hint) ||
      perDimensionDurationEvIds.length > 0 ||
      bimodalMetricEvIds.length > 0 ||
      latencyMetricEvIds.length > 0,
    alertSuggestedCategories,
  });

  // e4. HYPOTHESIS VALIDATION (HOR-25) — adjust confidence + assign verdicts
  const validated = validateHypotheses(hyps, evidence);

  // e4a. CAUSE CHAINS (HOR-196) — build ordered causal sequences for supported hypotheses
  const causeChains = buildCauseChains(validated, evidence, graph, label);

  // f. FINDINGS (label kept as 'e' externally but shifted to 'f' internally)
  const findings: ReportFinding[] = [];

  // The seed is the best-ranked candidate (architectural entry point preferred).
  // Structural seed findings are present only on a full run (HOR-319 layer-2).
  if (top && seedEv) {
    // Reflect the REAL seed match strength — never a hardcoded 1.00 (HOR-367). A weak/closest
    // match must not read as certainty (it contradicted the "low-confidence closest match"
    // disclaimer in the same report). Low-confidence seeds cap low; otherwise use the search
    // relevance, floored/ceilinged so seed resolution is never presented as absolute certainty.
    const seedConfidence = seedIsLowConfidence
      ? Math.min(0.4, top.score ?? 0.3)
      : Math.min(0.95, Math.max(0.5, top.score ?? 0.75));
    findings.push({
      kind: 'observation',
      title: `Seed resolves to ${label} at ${seedLoc}`,
      detail: top.signature ?? undefined,
      confidence: +seedConfidence.toFixed(2),
      evidenceIds: [seedEv.id],
    });
  }

  // HOR-216: when the seed came from a log match (raw error-string hint), record
  // how it was resolved so the trail from "error string" → symbol is transparent.
  if (logReseed !== null && seedEv) {
    findings.push({
      kind: 'observation',
      title: logReseed.note,
      detail: 'Seed was resolved by matching the hint against recent logs, not source search.',
      confidence: 0.6,
      evidenceIds: [seedEv.id],
    });
  }

  // Surface the other ranked candidate areas so a narrow pick is transparent.
  if (ranked.length > 1 && seedEv) {
    const candidates = ranked
      .slice(0, 4)
      .map((r) => `${r.symbol.name} [${r.role}]`)
      .join(', ');
    findings.push({
      kind: 'observation',
      title: `Candidate areas (ranked): ${candidates}`,
      detail: `Investigating ${label} [${ranked[0]?.role}]; re-run with a more specific hint to target another.`,
      confidence: 0.5,
      evidenceIds: [seedEv.id],
    });
  }

  if (flows.length > 0) {
    findings.push({
      kind: 'observation',
      title: `Participates in ${flows.length} execution flow(s)`,
      detail: flows.map((f) => f.name).join(', ') || undefined,
      confidence: clamp01(0.5 + flows.length * 0.1),
      evidenceIds: flowEvIds,
    });
  }

  if (top && impactEv && impact && impact.affected > 0) {
    findings.push({
      kind: 'observation',
      title: `Changing ${top.name} impacts ${impact.affected} symbol(s) (blast radius)`,
      confidence: clamp01(0.4 + Math.min(impact.affected, 20) / 40),
      evidenceIds: [impactEv.id],
    });
  }

  for (const [queueName, evIds] of queueEvByName) {
    const edge = queueHits.find((e) => e.queueName === queueName);
    const producer = edge?.producerSymbol ?? 'unknown-producer';
    const worker = edge?.workerSymbol ?? 'unknown-worker';
    findings.push({
      kind: 'correlation',
      title: `Crosses a queue boundary: ${queueName} (${producer} -> ${worker})`,
      confidence: 0.7,
      evidenceIds: evIds,
    });
  }

  if (changes && changeEvId) {
    const m =
      changes.added.length + changes.removed.length + changes.modified.length;
    findings.push({
      kind: 'observation',
      title: `${m} symbol(s) changed in range ${input.since}..HEAD`,
      confidence: clamp01(0.4 + Math.min(m, 20) / 40),
      evidenceIds: [changeEvId],
    });
  } else if (!changes && changeEvId && recentChanges) {
    findings.push({
      kind: 'observation',
      title: `${recentChanges.commits.length} commit(s) in ${changeRangeLabel} touching ${recentChanges.changedFiles.length} file(s)`,
      confidence: clamp01(0.3 + Math.min(recentChanges.commits.length, 10) / 20),
      evidenceIds: [changeEvId],
    });
  }

  // HOR-332: surface a config/migration change in the window as its own candidate
  // change source so a non-code change (schema migration, env/config edit) is VISIBLE
  // rather than buried in the commit file count.
  if (configChangeEvId && configChanges.length > 0) {
    const migrationN = configChanges.filter((c) => c.category === 'migration').length;
    const configN = configChanges.length - migrationN;
    const label =
      migrationN > 0 && configN > 0
        ? `${migrationN} migration/schema + ${configN} config/data file(s)`
        : migrationN > 0
          ? `${migrationN} migration/schema file(s)`
          : `${configN} config/data file(s)`;
    findings.push({
      kind: 'observation',
      title: `Config/migration change in ${changeRangeLabel}: ${label} — possible non-code change source`,
      confidence: clamp01(0.35 + Math.min(configChanges.length, 10) / 20),
      evidenceIds: [configChangeEvId],
    });
  }

  // Runtime error-signature findings (only when log evidence was synthesized)
  if (analysis !== null && analysis.signatures.length > 0) {
    const newN = analysis.newSignatures.length;
    const affected =
      analysis.affectedServices.length > 0
        ? analysis.affectedServices.join(', ')
        : (input.service ?? 'the service');

    const hasDirectEvidence = directLogEvIds.length > 0;
    const ambientCount = ambientLogEvIds.length;

    // Summary finding — label when evidence is entirely ambient so users know
    // these errors have no established link to the seed.
    const ambientSuffix =
      !hasDirectEvidence && ambientCount > 0
        ? ` (${ambientCount} ambient — no direct link to seed established)`
        : ambientCount > 0
          ? ` (${directLogEvIds.length} direct, ${ambientCount} ambient)`
          : '';

    findings.push({
      kind: 'observation',
      title: `${analysis.signatures.length} error signature(s) (${newN} new, ${analysis.totalErrors} error(s)) — affected: ${affected}${ambientSuffix}`,
      confidence: hasDirectEvidence ? 0.65 : 0.40,
      evidenceIds: logEvIds,
    });

    // Top-signature finding: prefer the top direct hit; fall back to top overall
    // with an explicit "ambient" label so the user knows it's unlinked.
    const topDirectId = directLogEvIds[0];
    const topSig = analysis.signatures[0];
    if (topDirectId !== undefined && topSig !== undefined) {
      const flag = topSig.isNew
        ? ' (NEW)'
        : topSig.ratio !== undefined && Number.isFinite(topSig.ratio) && topSig.ratio >= 1.5
          ? ` (spike x${topSig.ratio.toFixed(1)})`
          : '';
      findings.push({
        kind: 'anomaly',
        title: `Top error signature: ${topSig.key} — ${topSig.count}x${flag}, last ${shortTs(topSig.lastSeen)}`,
        confidence: 0.7,
        evidenceIds: [topDirectId],
      });
    } else if (topSig !== undefined && ambientCount > 0) {
      const flag = topSig.isNew
        ? ' (NEW)'
        : topSig.ratio !== undefined && Number.isFinite(topSig.ratio) && topSig.ratio >= 1.5
          ? ` (spike x${topSig.ratio.toFixed(1)})`
          : '';
      findings.push({
        kind: 'observation',
        title: `Top error signature (ambient): ${topSig.key} — ${topSig.count}x${flag} — no structural link to seed`,
        confidence: 0.35,
        evidenceIds: ambientLogEvIds.slice(0, 1),
      });
    }
  }

  // Distinct failing-entity finding (HOR-215) — aggregated entity counts behind
  // the dominant error signature, so the report names what's actually stuck.
  if (entityEvIds.length > 0) {
    findings.push({
      kind: 'observation',
      title: `Distinct failing entities: ${entitySummaries.join(' × ')}`,
      confidence: 0.6,
      evidenceIds: entityEvIds,
    });
  }

  // Application-state findings (MongoDB, HOR-33)
  if (stateAnalysis !== null && stateEvIds.length > 0) {
    findings.push({
      kind: 'anomaly',
      title: `Application state: ${stateEvIds.length} relevant signal(s) across ${stateCollections.size} collection(s) in ${stateAnalysis.database}`,
      confidence: 0.6,
      evidenceIds: stateEvIds,
    });
  }

  // Redis runtime-state findings (HOR-201)
  if (redisStateAnalysis !== null && redisStateEvIds.length > 0) {
    const dbCount = redisStateAnalysis.databases.filter((d) => d.keyCount > 0).length;
    findings.push({
      kind: 'observation',
      title: `Redis runtime state: ${redisStateEvIds.length} signal(s) across ${dbCount} DB(s)`,
      confidence: 0.5,
      evidenceIds: redisStateEvIds,
    });
  }

  // Queue runtime findings (HOR-12)
  if (queueRuntimeState !== null && queueRuntimeEvIds.length > 0) {
    const starved = queueRuntimeState.queues.filter((q) => q.waiting >= 10 && q.active === 0);
    // Exclude starved queues: the analyzer emits worker-starvation instead of backlog for
    // them, so treating them as backlogged here would inflate finding confidence to 0.85.
    const starvedNames = new Set(starved.map((q) => q.queueName));
    const backlogged = queueRuntimeState.queues.filter(
      (q) => q.waiting > 100 && !starvedNames.has(q.queueName),
    );
    const failing = queueRuntimeState.queues.filter((q) => q.failed > 20);

    if (backlogged.length > 0 || starved.length > 0 || failing.length > 0) {
      const parts: string[] = [];
      if (starved.length > 0)
        parts.push(
          `possible starvation: ${starved.map((q) => q.queueName).join(', ')} (0 active workers in snapshot)`,
        );
      if (backlogged.length > 0)
        parts.push(
          `backlog: ${backlogged.map((q) => `${q.queueName} (${q.waiting})`).join(', ')}`,
        );
      if (failing.length > 0)
        parts.push(`failures: ${failing.map((q) => `${q.queueName} (${q.failed})`).join(', ')}`);
      findings.push({
        kind: 'anomaly',
        title: `Queue runtime anomalies — ${parts.join('; ')}`,
        confidence: queueFindingConfidence({
          starvedCount: starved.length,
          backloggedCount: backlogged.length,
          failingCount: failing.length,
        }),
        evidenceIds: queueRuntimeEvIds,
      });
    } else {
      const summary = queueRuntimeState.queues
        .map((q) => `${q.queueName}: ${q.waiting} waiting`)
        .join(', ');
      findings.push({
        kind: 'observation',
        title: `Queue runtime healthy — ${summary}`,
        confidence: 0.5,
        evidenceIds: queueRuntimeEvIds,
      });
    }
  }

  // Metric findings (HOR-40)
  if (metricEvIds.length > 0) {
    const anomalyLabels: string[] = [];
    if (latencyMetricEvIds.length > 0) anomalyLabels.push('latency/error-rate');
    if (queueMetricEvIds.length > 0) anomalyLabels.push('queue-growth');
    const desc = anomalyLabels.join(', ') || 'metric';
    findings.push({
      kind: 'anomaly',
      title: `Metric anomalies: ${metricEvIds.length} signal(s) — ${desc}`,
      confidence: 0.7,
      evidenceIds: metricEvIds,
    });
  } else if (nominalMetricEvIds.length > 0) {
    // Metrics checked, nothing anomalous — record as a neutral observation so the
    // investigation reflects that metrics were inspected and are not implicated (HOR-203).
    findings.push({
      kind: 'observation',
      title: `Metrics nominal — ${metricSeriesChecked} series checked, no anomalies in window`,
      confidence: 0.5,
      evidenceIds: nominalMetricEvIds,
    });
  }

  // f. SUSPECTED CAUSES — build CauseInput list; scoring + ranking via rankCauses (HOR-15).
  const causeInputs: CauseInput[] = [];
  const blastRadius = impact?.affected ?? 0;

  // Queue runtime causes: backlog and starvation elevate the queue-path hypothesis.
  if (queueRuntimeState !== null) {
    for (const q of queueRuntimeState.queues) {
      const isStarved = q.waiting >= 10 && q.active === 0;
      const isBacklogged = q.waiting > 100;
      if (isStarved || isBacklogged) {
        const edge = queueHits.find((e) => e.queueName === q.queueName);
        const producer = edge?.producerSymbol ?? 'producer';
        const worker = edge?.workerSymbol ?? 'worker';
        const detail = isStarved
          ? `${q.waiting} waiting, no active workers`
          : `${q.waiting} waiting jobs`;
        causeInputs.push({
          id: `cause:queue-backlog:${q.queueName}`,
          title: `Queue "${q.queueName}" is backed up (${detail}) — ${producer} → ${worker} path implicated`,
          category: 'queue-backlog',
          sourceEvidenceIds: queueRuntimeEvIdsByQueue.get(q.queueName) ?? [],
          baseScore: clamp01(isStarved ? 0.45 : 0.45 + Math.min(q.waiting / 5_000, 0.20)),
          metadata: { waitingCount: q.waiting, isStarved, blastRadius },
        });
      }
    }
  }

  // Queue-path cause(s) — structural; runtime evidence needed to elevate to likely.
  for (const [queueName, evIds] of queueEvByName) {
    const edge = queueHits.find((e) => e.queueName === queueName);
    const producer = edge?.producerSymbol ?? 'unknown-producer';
    const worker = edge?.workerSymbol ?? 'unknown-worker';
    causeInputs.push({
      id: `cause:queue-path:${queueName}`,
      title: `The ${queueName} processing path (${producer} -> ${worker}) is implicated`,
      category: 'queue-path',
      sourceEvidenceIds: [...evIds, ...(impactEv ? [impactEv.id] : [])],
      baseScore: 0.35,
      metadata: { blastRadius },
    });
  }

  // HOR-385: source-impact mode never frames a structural question as a deployment regression —
  // suppress the cause at its source (the hypothesis is suppressed in generateHypotheses).
  if (changeEvId && !sourceImpactHint) {
    // Relevance-gated boost (HOR-406): the seed's file appearing among changed files is NOT
    // enough — a recent-but-irrelevant commit (dependabot bump, pure merge, "Prepare release",
    // pre-commit autoupdate, or a +0/-0 no-op) used to inflate this cause to 0.45–0.80 off the
    // single most-recent commit even when the seed was never touched. The boost now requires a
    // RELEVANT change: a non-noise commit that actually touches the seed's file within a
    // non-trivial diff window. In degraded runtime-only mode there is no seed, so the cause is
    // offered generically off the git-history evidence alone (un-boosted).
    const seedFile = top?.filePath;
    // HOR-406 round 2: reuse the single relevance verdict computed above so the ranker, the
    // hypotheses engine, and the correlation cause-chains all agree on whether a recent change
    // is causal — they can never contradict one another.
    const seedInChanges = recentChangeRelevant;
    // HOR-333: cite the actual culprit — the most-recent commit(s) (short SHA + subject)
    // and the changed symbol name(s) — so the cause names what to look at, not just the
    // seed + range. Bounded to 1-2 commits and a few symbols to stay scannable.
    const citation = formatRegressionCitation(recentChanges, changes, seedFile);
    // HOR-451: how focused was the seed-touching change? Reused for BOTH the score and the title.
    const seedFocus = seedInChanges ? seedTouchingCommitFocus(recentChanges, top?.filePath) : null;
    // A BROAD/diffuse commit (touched many files) that merely included the seed's file is not a
    // credible specific culprit — naming it ("integrate PrestaShop API client may have caused
    // [unrelated symptom]") misleads, especially when no runtime evidence corroborates it. Reframe
    // honestly rather than confidently blaming the broad change.
    const isBroadChange = seedFocus !== null && seedFocus > 14;
    // #3: only attribute the regression to the seed when an in-window commit actually touched the
    // seed's file. Otherwise be honest — changes shipped, but none to the seed — instead of
    // pinning it on the newest unrelated commit.
    const regressionTitle =
      top && seedInChanges && !isBroadChange
        ? `Recent change${citation.commitClause} to ${top.name}${citation.symbolClause} in ${changeRangeLabel} may have introduced the regression`
        : top && seedInChanges && isBroadChange
          ? `No specific cause identified from the available evidence — a broad recent change (${seedFocus} files) in ${changeRangeLabel} touched ${top.name}'s file but isn't clearly linked to the symptom; connect runtime evidence (logs/metrics) for a code-aware cause`
          : top
            ? `Changes shipped in ${changeRangeLabel} but none touched ${top.name} — a regression here is unlikely to be a code change to the seed itself (check upstream deps, data, or config)`
            : `Recent change${citation.commitClause}${citation.symbolClause} in ${changeRangeLabel} may have introduced the regression`;
    causeInputs.push({
      id: 'cause:deployment-regression',
      title: regressionTitle,
      category: 'deployment-regression',
      sourceEvidenceIds: [changeEvId, ...(seedEv ? [seedEv.id] : [])],
      // A regression NOT backed by a seed-touching commit must not score like one that is.
      // HOR-451: scale the seed-touched prior by commit focus — a broad/diffuse commit that merely
      // touched the seed no longer outranks an evidence-backed runtime cause.
      baseScore: clamp01(
        (seedInChanges ? regressionSeedTouchedScore(seedFocus) : 0.18) +
          (queueHits.length > 0 ? 0.05 : 0),
      ),
      metadata: { blastRadius },
    });
  }

  // Blast-radius cause: offered only when a resolved symbol has GENUINE reach.
  // "1 affected" is no fan-out — offering it produced a tautological top cause
  // ("sits on a high-fan-out path (1 affected)") that led the ranking on pure
  // topology while real (error/data) signals sat unranked (HOR-340). Require a
  // real fan-out threshold before this structural observation can be a cause.
  const MIN_FANOUT_FOR_CAUSE = 3;
  if (top && impactEv && seedEv && impact && impact.affected >= MIN_FANOUT_FOR_CAUSE) {
    causeInputs.push({
      id: 'cause:blast-radius',
      title: `${top.name} has wide code reach (${impact.affected} dependent symbols) and may propagate the fault`,
      category: 'blast-radius',
      sourceEvidenceIds: [impactEv.id, seedEv.id],
      baseScore: clamp01(0.15 + (queueHits.length > 0 ? 0.05 : 0)),
      metadata: { blastRadius },
    });
  }

  // HOR-341: SEED-EMITTED runtime-error cause — the strongest possible link. When a
  // runtime error's literal is RAISED FROM the seed's own source body (e.g. maison's
  // `E_FULFILLMENT_SYNC_ERROR_04` thrown inside `checkBrandOrderFulfillment`) AND that
  // exact code has live Elasticsearch occurrences, the seed is observably failing in
  // production — not merely co-occurring. The cross-signal join surfaced it as direct
  // evidence but it never became a CAUSE (and when the code was also a top signature the
  // dedup buried it as a "lead to verify"). Promote it to a dedicated headline cause that
  // cites BOTH the join evidence and the seed symbol, so the #1/#2 structural-link gate
  // treats it LINKED and the "no cause is structurally linked" reframing yields to it.
  if (seedEmittedJoins.length > 0 && top && seedEv) {
    // Rank by SEVERITY first, then volume — a high-count warn/debug code (e.g. maison's
    // `W_FULFILLMENT_SYNC_SKIP_02` "Order not found → skip" at 168x, or a `logger.debug`
    // "Processing order" at 338x) must NOT outrank or be mislabelled as the actual error
    // (`E_FULFILLMENT_SYNC_ERROR_04`). Severity comes from the ES log level when captured,
    // else the event_code prefix (E_/W_/D_…) or message keywords. Codes we cannot classify
    // default to error tier, preserving prior behaviour for unprefixed codes (e.g.
    // leadcall's `HTTP_FLT_001`, which IS a logger.error).
    // dogfood GAP I: when the hint NAMES specific code(s), prefer them — the user asked about
    // that code, so a tie among equally-seed-raised errors should headline the named one (e.g.
    // hint "EMODA_017D errors reserving products" must headline EMODA_017D, not a same-count
    // sibling error from the same function).
    const hintNamedCodes = new Set(extractEventCodes(hint));
    const ordered = [...seedEmittedJoins].sort((a, b) => {
      // dogfood GAP F: prefer a code raised by the SEED ITSELF over one raised by a CALLEE —
      // a generic error from a shared infra dependency (e.g. ERR243_05 "Store client error"
      // from the `maisonAxios` transport) must not outrank the seed's own error (e.g.
      // `draftProductsForSale`'s SALE_015_02 "Error drafting sale products").
      if (a.raisedBySeed !== b.raisedBySeed) return a.raisedBySeed ? -1 : 1;
      const ha = hintNamedCodes.has(a.code);
      const hb = hintNamedCodes.has(b.code);
      if (ha !== hb) return ha ? -1 : 1; // GAP I: a hint-named code wins among equal-altitude codes
      const ta = seedEmittedSeverityTier(a.level, a.code, a.message);
      const tb = seedEmittedSeverityTier(b.level, b.code, b.message);
      if (ta !== tb) return tb - ta; // higher severity tier first
      return b.count - a.count; // then by volume
    });
    const lead = ordered[0];
    if (lead !== undefined) {
      const sourceEvidenceIds = [
        ...new Set([...ordered.map((j) => j.evId), seedEv.id]),
      ];
      const tier = seedEmittedSeverityTier(lead.level, lead.code, lead.message);
      const volumeBoost = Math.min(0.1, Math.log10(Math.max(1, lead.count)) * 0.025);
      const msgClause = lead.message
        ? ` — "${lead.message.replace(/\s+/g, ' ').trim().slice(0, 90)}"`
        : '';
      // GAP F: name the ACTUAL raiser. A code raised by the seed itself is a direct failure;
      // one raised by a CALLEE (often shared infra) is a weaker, generic link — attribute it
      // to the callee ("surfaces on X, a dependency of <seed>"), never "raised by <seed>",
      // and demote it so it cannot headline as the seed's "likely failure".
      const bySeed = lead.raisedBySeed;
      const raiser = bySeed ? top.name : lead.raiserName || top.name;
      const depClause = bySeed ? '' : `, a dependency of ${top.name}`;
      const calleePenalty = bySeed ? 0 : 0.18;
      // Label and weight HONESTLY by severity. An error is "the likely failure"; a warning
      // is a frequent warning (not asserted as the failure); a debug/info code is a
      // diagnostic signal. Only an error-tier code gets the strong failure prior.
      // HOR-451: an INFO/DEBUG-tier diagnostic (e.g. a `D_…` code logged 428x) is informational by
      // definition — it must NEVER become a headline-eligible root cause. A high-volume debug signal
      // was boosting to finalScore 1.000 over a real data-state anomaly (maison fulfillment-sync
      // dogfood). Emit a CAUSE only for error/warn tiers; the diagnostic still rides in evidence +
      // timeline. (If every joined signal is info/debug, no seed-emitted cause is offered.)
      if (tier === SEV_ERROR || tier === SEV_WARN) {
        let title: string;
        let baseScore: number;
        if (tier === SEV_ERROR) {
          title = bySeed
            ? `Runtime error ${lead.code} (${lead.count}x in Elasticsearch) is raised by ${raiser} — the likely failure${msgClause}`
            : `Runtime error ${lead.code} (${lead.count}x in Elasticsearch) surfaces on ${raiser}${depClause}${msgClause}`;
          baseScore = clamp01(0.6 + volumeBoost - calleePenalty);
        } else {
          title = `Warning ${lead.code} (${lead.count}x in Elasticsearch) ${bySeed ? 'is raised by' : 'surfaces on'} ${raiser}${depClause}${msgClause}`;
          baseScore = clamp01(0.42 + volumeBoost - calleePenalty);
        }
        causeInputs.push({
          id: 'cause:seed-emitted-error',
          title: title.slice(0, 220),
          category: 'error-correlation',
          sourceEvidenceIds,
          baseScore,
          metadata: {
            blastRadius,
            seedEmitted: true,
            code: lead.code,
            count: lead.count,
            severity: tier === SEV_ERROR ? 'error' : 'warn',
          },
        });
      }
    }
  }

  // f-hint-matched (HOR-453): when NO error is structurally linked to the seed, the dominant
  // signal that names the symptom is often WARN-level and never becomes a candidate, so the
  // headline falls back to a speculative deployment-regression. Do ONE bounded, hint-text-scoped
  // WARN fetch and surface a symptom-matching signal — PRECISION-GATED by selectHintMatchedSignal
  // (event_code shares a distinctive hint token, or message shares >=2), so a loud unrelated
  // "...not found" warning can't false-match. Hedged; ranks above a speculative regression, below
  // a seed-linked error. Skipped in source-impact mode.
  if (
    deps.logs &&
    typeof deps.logs.analyzeErrors === 'function' &&
    seedEmittedJoins.length === 0 &&
    !sourceImpactHint &&
    meaningfulHintTokens.length > 0
  ) {
    try {
      const warnAnalysis = await deps.logs.analyzeErrors({
        service: input.service,
        from: logWindowFrom(input.logsSince ?? input.since),
        level: 'warn',
        // Plain message match (OR semantics) — NOT broadText, whose phrase-match would
        // require the hint words to appear contiguously (e.g. "Sale with link not found"
        // wouldn't match the phrase "sale links found"). selectHintMatchedSignal then
        // applies the precision gate on the returned signatures.
        text: meaningfulHintTokens.filter((t) => t.length >= 4).join(' '),
      });
      const picked = selectHintMatchedSignal(warnAnalysis.signatures ?? [], meaningfulHintTokens);
      if (picked) {
        const tier = seedEmittedSeverityTier(null, picked.code, picked.message);
        const volumeBoost = Math.min(0.1, Math.log10(Math.max(1, picked.count)) * 0.03);
        const msgClause = picked.message
          ? ` — "${picked.message.replace(/\s+/g, ' ').trim().slice(0, 80)}"`
          : '';
        const ev = mkEv(
          'log',
          `event_code ${picked.code}: ${picked.count}x in Elasticsearch — matches the reported symptom`.slice(0, 220),
          {
            signature: picked.code,
            count: picked.count,
            sampleMessage: picked.message || null,
            relevanceClass: 'direct',
            relevanceReason: `event_code ${picked.code} matches the reported symptom (not structurally linked to the seed)`,
            hintMatched: true,
          },
          {},
          undefined,
          0.75,
        );
        logEvIds.push(ev.id);
        causeInputs.push({
          id: 'cause:hint-matched-signal',
          title: `Runtime signal ${picked.code} (${picked.count}x in Elasticsearch) matches the reported symptom but isn't structurally linked to ${top?.name ?? 'the seed'}${msgClause} — verify`.slice(0, 220),
          category: 'error-correlation',
          sourceEvidenceIds: [ev.id],
          // A signal whose event_code/message names the symptom is stronger evidence than a
          // diffuse recent commit that merely touched the seed's file (order-of-trust), so it
          // ranks above the broad-commit regression floor (~0.54). Still below a seed-LINKED error.
          baseScore: clamp01((tier === SEV_ERROR ? 0.6 : 0.56) + volumeBoost),
          metadata: { blastRadius, hintMatched: true, code: picked.code, count: picked.count },
        });
      }
    } catch {
      // best-effort — a warn fetch failure must never break the investigation
    }
  }

  // f-data-flow (HOR-446): a SOURCE-ONLY mechanism read from the seed's OWN body — in-place
  // mutation, an unawaited async write, a fixed polling cadence, or a hardcoded threshold/bound.
  // The dogfood showed the real cause is usually here yet never a candidate. Pushed at a LOW prior
  // (~0.2, hedged "could explain … verify against runtime evidence") so any genuine runtime/source
  // cause still outranks it; the single-source ceiling keeps it in the observation/possible band.
  // Skipped in source-impact mode (its summary is a structural impact result, not a cause headline).
  if (top && seedEv && ctx && code && !sourceImpactHint) {
    // HOR-448: the mechanism is often ONE HOP from the #1 seed (the reducer an action dispatches to,
    // the lib fn a wrapper calls, a sibling method), so scan the top seed PLUS the next few ranked
    // seeds and the seed's direct callees (bounded). Each extra context is a best-effort fetch.
    const scanIds = [
      ...new Set([...seeds.slice(1, 4).map((s) => s.id), ...(ctx.callees ?? []).slice(0, 4).map((c) => c.id)]),
    ].filter((id) => id !== top.id);
    const extraCtxs = (
      await Promise.all(scanIds.map((id) => code.context(id).catch(() => null)))
    ).filter((c): c is SymbolContext => c !== null);
    const dataFlow = detectDataFlowCauseAcross([ctx, ...extraCtxs]);
    if (dataFlow) {
      causeInputs.push({
        id: 'cause:seed-data-flow',
        title: dataFlow.title.slice(0, 220),
        category: 'data-flow',
        sourceEvidenceIds: [seedEv.id],
        baseScore: dataFlow.baseScore,
        metadata: { dataFlowPattern: dataFlow.pattern, matched: dataFlow.matched, blastRadius },
      });
    }
  }

  // Runtime-errors + queue-path cause: only when we have DIRECT error evidence AND a queue path.
  // Ambient-only signatures have no structural link to the seed and must not drive
  // cause ranking — they inflate confidence on unrelated high-volume errors.
  if (analysis !== null && analysis.signatures.length > 0 && queueHits.length > 0 && directLogEvIds.length > 0) {
    const firstQueue = queueHits[0];
    const queueLabel =
      firstQueue !== undefined
        ? `"${firstQueue.queueName}" (${firstQueue.producerSymbol ?? 'unknown'} -> ${firstQueue.workerSymbol ?? 'unknown'})`
        : 'the queue path';
    // HOR-338: cite the DIRECT errors (those linked to the seed/path), not the global
    // top/total — otherwise a louder, unrelated error from another service/host is
    // narrated onto this path purely by co-occurrence.
    const directTotal = directSignatures.reduce((sum, d) => sum + d.count, 0);
    const directTop = directSignatures[0];
    causeInputs.push({
      id: 'cause:error-correlation',
      title: `Runtime errors (${directTotal}${directTop ? `, top ${directTop.key}` : ''}) directly linked to the implicated queue path ${queueLabel}`,
      category: 'error-correlation',
      sourceEvidenceIds: directLogEvIds.slice(0, 3),
      baseScore: 0.30,
      metadata: { blastRadius },
    });
  }

  // HOR-328 round-2: synthesize a network/dependency cause from the dominant DIRECT error
  // MESSAGE. The real cause (a DNS/connection failure like "getaddrinfo ENOTFOUND host") is
  // often verbatim in the message yet never promoted, so the headline defaulted to a
  // co-occurring metric/stale signal instead of the actual outage. This is a strong,
  // evidence-backed cause that should lead.
  const INFRA_RE =
    /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|getaddrinfo|socket hang up|connection (?:refused|reset|timed out)|network (?:error|timeout)|DNS)\b/i;
  const infraSig = directSignatures.find((d) => INFRA_RE.test(d.message));
  // Only headline a queue failure that is RELEVANT to this investigation — otherwise a single
  // stale failing queue (e.g. one GAIA DNS error days old) gets narrated onto every unrelated
  // hint (round-3 over-fire). Relevant = the queue is a static hit for this investigation, or
  // its name overlaps the hint tokens (so "gaia stock sync" matches GAIA_STOCK_SYNC, but an
  // Emoda/HMAC/fulfillment hint does not).
  const queueHitNames = new Set(queueHits.map((e) => e.queueName.toLowerCase()));
  const infraQueue = queueFailureSignals.find((q) => {
    if (!INFRA_RE.test(q.reason)) return false;
    if (queueHitNames.has(q.queueName.toLowerCase())) return true;
    const qTokens = new Set(tokenize(q.queueName));
    return hintTokens.some((t) => t.length >= 3 && qTokens.has(t));
  });
  if (infraSig) {
    causeInputs.push({
      id: 'cause:dependency-failure',
      title: `Dependency/network failure: ${infraSig.count}x ${infraSig.key} — "${infraSig.message.replace(/\s+/g, ' ').trim().slice(0, 100)}"`,
      category: 'infrastructure',
      sourceEvidenceIds: directLogEvIds.slice(0, 3),
      baseScore: 0.5,
      metadata: { blastRadius },
    });
  } else if (infraQueue) {
    // The DNS/connection failure can surface ONLY in queue forensics, never the live error
    // stream (the GAIA case: the real cause was an ENOTFOUND in the queue's failed jobs).
    // Promote it so the headline is the actual outage, not a co-occurring stale-collection.
    causeInputs.push({
      id: 'cause:dependency-failure',
      title: `Dependency/network failure on queue ${infraQueue.queueName}: ${infraQueue.count} failed job(s) — "${infraQueue.reason.replace(/\s+/g, ' ').trim().slice(0, 100)}"${infraQueue.stale ? ' (stale — reflects a past run)' : ''}`,
      category: 'infrastructure',
      sourceEvidenceIds: [infraQueue.evId],
      // A stale-only queue failure is weaker than a live error, but still the best
      // explanation — and far better than a co-occurring stale-collection guess.
      baseScore: infraQueue.stale ? 0.34 : 0.5,
      metadata: { blastRadius },
    });
  }

  // HOR-332: data-state anomaly cause — records stuck in a failed/stale state are a
  // data-quality root-cause class, not just a finding. Many prod incidents are data
  // (stale/orphaned records), not code, and Horus otherwise anchors only on code.
  if (dataAnomalyEvIds.length > 0) {
    const collections = [...new Set(dataAnomalyCollections)];
    const example = collections[0];
    causeInputs.push({
      id: 'cause:data-state-anomaly',
      // Co-occurring, NOT asserted as the root cause: the stale collection is selected by
      // hint relevance, not proven reachable from the seed's call graph, so claiming it is
      // the cause mislead on e.g. a Shopify-fulfillment error citing unrelated gaia sync logs.
      title: `Data-state anomaly (co-occurring): ${collections.length} collection(s) hold records in a failed/stale state${example ? ` (e.g. ${example})` : ''} — verify whether it relates to this failure`,
      category: 'data-state-anomaly',
      sourceEvidenceIds: dataAnomalyEvIds.slice(0, 3),
      baseScore: 0.22,
      metadata: { blastRadius },
    });
  }

  // Metric-driven causes (HOR-40): latency/error-rate anomalies → external-api-latency cause.
  if (latencyMetricEvIds.length > 0) {
    causeInputs.push({
      id: 'cause:metric-latency',
      title: `Metric anomalies (${latencyMetricEvIds.length} latency/error-rate signal(s)) — upstream dependency or component under load`,
      category: 'external-api-latency',
      sourceEvidenceIds: latencyMetricEvIds,
      baseScore: 0.45,
      metadata: { blastRadius },
    });
  }

  // Metric-driven causes (HOR-40): queue-growth anomaly → queue-backlog cause.
  if (queueMetricEvIds.length > 0) {
    causeInputs.push({
      id: 'cause:metric-queue-growth',
      title: `Queue-growth metric anomalies (${queueMetricEvIds.length} signal(s)) — worker throughput may be insufficient`,
      category: 'queue-backlog',
      sourceEvidenceIds: queueMetricEvIds,
      baseScore: 0.40,
      metadata: { blastRadius },
    });
  }

  // Score + rank via the Cause Scoring Engine — graph proximity, evidence quality,
  // source diversity, recency, recurrence, blast radius, and finding
  // corroboration applied as factors.
  // Keys must match Evidence.source values (not provider .id) — see factorProviderReliability.
  const providerReliability: Record<string, number> = {
    code: 0.80,
    ...(deps.logs != null ? { logs: 0.70 } : {}),
    ...(deps.mongo != null || deps.redisState != null ? { state: 0.85 } : {}),
    ...(deps.queue != null ? { queue: 0.90 } : {}),
    ...(deps.metrics != null ? { metrics: 0.75 } : {}),
  };
  // Incident memory (HOR-363): code areas touched by PRIOR credible investigations corroborate
  // a cause. Best-effort — never required, and the bounded boost can't outrun the confidence
  // ceiling. Build a node-id → prior-count map from the recent incident store.
  const priorIncidents = new Map<string, number>();
  try {
    const priors = await listInvestigationsWithReports(deps.db, 50);
    for (const row of priors) {
      const rep = row.report as InvestigationReport | null | undefined;
      if (!rep || !Array.isArray(rep.evidence) || rep.evidence.length === 0) continue;
      // Only learn from credible priors — a low-confidence prior isn't a real "incident".
      if (typeof rep.confidence === 'number' && rep.confidence < 0.5) continue;
      const priorGraph = buildGraph(rep.evidence);
      const seen = new Set<string>();
      for (const n of priorGraph.nodes) {
        if ((n.type === 'symbol' || n.type === 'file') && !seen.has(n.id)) {
          seen.add(n.id);
          priorIncidents.set(n.id, (priorIncidents.get(n.id) ?? 0) + 1);
        }
      }
    }
  } catch {
    // Incident memory is corroborating signal, never a hard dependency.
  }

  const rankedCauses = rankCauses(causeInputs, {
    evidence,
    graph,
    findings,
    providerReliability,
    request: { hint: input.hint, service: input.service },
    ...(priorIncidents.size > 0 ? { priorIncidents } : {}),
    // HOR-385: drop the structural-only / finding-uncertainty / info-priority penalties so the
    // blast-radius cause (the actual answer) is not demoted as a weak topology guess.
    ...(sourceImpactHint ? { mode: 'source-impact' as const } : {}),
  });

  // g. confidence
  // Pass ambient log IDs so unlinked runtime noise is weighted like structural
  // evidence rather than live confirmed signal (HOR-158).
  const evidenceConfidence = computeWeightedEvidenceConfidence(
    evidence,
    ambientLogEvIds.length > 0 ? new Set(ambientLogEvIds) : undefined,
  );
  // Without a seed (degraded runtime-only mode) seedResolved is 0, so this formula
  // already caps confidence at ≤0.5 — runtime evidence can never look as certain as a
  // full structural run (HOR-319 layer-2).
  // A fuzzy/zero-support seed (HOR-335) is only partially "resolved" — it must not
  // earn the full +0.5 a real, hint-matched seed does.
  const seedResolved = seeds.length === 0 ? 0 : seedIsLowConfidence ? 0.3 : 1;
  let confidence = clamp01(0.5 * evidenceConfidence + 0.5 * seedResolved);

  // h. summary
  const area = ctx?.community?.name ?? top?.filePath ?? (input.service ?? 'runtime evidence');
  // HOR — gate the headline on a STRUCTURAL LINK to the seed. A cause is "linked" when it cites
  // the seed's own evidence (its symbol / blast-impact) or a direct (seed-tied) log signature —
  // as opposed to purely co-occurring runtime noise (an unrelated stale queue, a data-state
  // anomaly on another table, ambient errors). Prefer the strongest LINKED cause; an unlinked
  // top cause only headlines when nothing linked clears the bar, and is then framed honestly.
  const seedLinkedEvIds = new Set<string>([
    ...directLogEvIds,
    ...(seedEv ? [seedEv.id] : []),
    ...(impactEv ? [impactEv.id] : []),
    // GAP B: for a performance hint, a latency/error-rate anomaly is the structural answer,
    // not co-occurring noise — let the metric-latency cause headline rather than yielding to
    // a higher-volume but lower-severity log code.
    ...(looksPerformance(hint) ? latencyMetricEvIds : []),
  ]);
  const isLinkedToSeed = (ids: string[]): boolean => ids.some((id) => seedLinkedEvIds.has(id));
  // HOR-402 substage-1a: select the headline by finalScore ARGMAX (not array position) so the
  // confidence + unlinked-headline cap below stay correct even if rankCauses' output order ever
  // changes. No-op today — rankCauses already sorts by finalScore desc, so argmax == [0].
  // (HOR-340/336: a sub-threshold cause must not headline; selectHeadlineCause enforces the ≥0.2 bar.)
  const { headlineCause, headlineLinked } = selectHeadlineCause(rankedCauses, isLinkedToSeed, rerank);
  // #2 calibration — a headline that isn't structurally linked to the seed is a co-occurring
  // signal, not a verified diagnosis: cap it in the "possible" band so it never reads as a
  // confident "likely" diagnosis (and so confidence actually discriminates linked vs not).
  // HOR-385: in source-impact mode the summary is the structural impact result, not a cause
  // headline, so the unlinked-headline cap is irrelevant — skip it.
  if (headlineCause && !headlineLinked && !sourceImpactHint) confidence = Math.min(confidence, 0.6);
  const banner = degradedNoSource ? 'Runtime-only (source intelligence unavailable). ' : '';
  // HOR-355: never present a weak semantic guess as "resolved to X" — it reads as a (wrong)
  // answer and undercuts the disclaimer. Only claim localization for a confident seed match;
  // otherwise say we couldn't localize and let the disclaimer point at how to refine.
  const scope = top
    ? seedIsLowConfidence
      ? 'could not be confidently localized from source alone'
      : `resolved to ${label} (${area})`
    : `over runtime evidence (${area})`;
  // HOR-335: lead with an honest disclaimer when the seed is only a semantic guess.
  const seedDisclaimer =
    seedIsLowConfidence && top
      ? `⚠ No symbol closely matched "${hint}" — "${top.name}" is a low-confidence closest match (semantic). Refine with an exact symbol or error code to target precisely. `
      : '';
  let summary = headlineCause
    ? headlineLinked
      ? `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. Top suspected cause: ${headlineCause.title}.`
      : `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. No cause is structurally linked to the seed; the strongest co-occurring signal (a lead to verify, not a diagnosis) is: ${headlineCause.title}.`
    : `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. No dominant suspected cause emerged from the available ${degradedNoSource ? 'runtime' : 'structural'} evidence.`;

  // HOR-334: a behavioral "how does X work" hint with NO real incident signal is a
  // request for an explanation, not a fault hunt. Rather than dumping empty incident
  // sections (no errors, no anomalies, no failing queues), lead the user to the
  // focused `horus explain <symbol>` answer. Conservative: only fires when the hint
  // reads as a question AND nothing actually looks wrong — a real incident (even with
  // a question-shaped hint) still gets a normal investigation.
  const hasIncidentSignal =
    directLogEvIds.length > 0 ||
    latencyMetricEvIds.length > 0 ||
    queueMetricEvIds.length > 0 ||
    dataAnomalyEvIds.length > 0 ||
    queueFailureSignals.length > 0 ||
    findings.some((f) => f.kind === 'anomaly') ||
    headlineCause !== undefined;
  // dogfood GAP E: `--since <ref>` is an explicit request to analyse what changed across a
  // commit range — a regression hunt, never a "how does it work" explanation. Suppress the
  // behavioral route when it is set so the deployment-regression path runs.
  // HOR-385: a structural source-impact hint ("what depends on X") also reads as a leading
  // interrogative to `looksExplanatory`, so source-impact must take precedence over the
  // behavioral walkthrough — exclude it here and lead with the impact result below instead.
  // (Incident and pure-explain hints are unaffected: sourceImpactHint is false for them.)
  const explanatoryHint = looksExplanatory(hint) && input.since === undefined && !sourceImpactHint;
  let behavioral: BehavioralWalkthrough | undefined;
  if (explanatoryHint) {
    // Gap #5: a "how does X work" hint is a request for an explanation, not a fault hunt —
    // route to a flow walkthrough REGARDLESS of ambient incident noise. (Previously this was
    // gated on `!hasIncidentSignal`, but a prod graph always carries SOME error signals, so the
    // branch never fired and behavioral hints got the full incident treatment on a wrong seed.)
    // Prefer the richest execution flow: the seed's own, else — when it sits mid-flow (an
    // injected service or a bare class) — the flow of an entry-point-like caller, so the
    // walkthrough roots at the controller/route rather than the service in the middle.
    let flowPool = flows;
    const richestSeedFlow = flows.slice().sort((a, b) => b.steps.length - a.steps.length)[0];
    if (code && (richestSeedFlow === undefined || richestSeedFlow.steps.length <= 1) && ctx?.callers?.length) {
      const ENTRY_RE =
        /controller|resolver|route|handler|command|consumer|listener|gateway|cron|scheduler|webhook|middleware/i;
      const entryCallers = ctx.callers
        .filter((c) => ENTRY_RE.test(c.name) || ENTRY_RE.test(c.filePath))
        .slice(0, 3);
      for (const c of entryCallers) {
        try {
          flowPool = flowPool.concat(await code.flowsFor(c.id));
        } catch {
          /* best-effort — a missing caller flow must not break the walkthrough */
        }
      }
    }
    // GAP C: when the seed resolves to a CLASS with no rich flow, its methods are the entry
    // points — fetch them so the walkthrough lists them instead of collapsing to the class.
    let classMethods: Symbol[] = [];
    if (code && isClassSymbol(top)) {
      const richest = flowPool.slice().sort((a, b) => b.steps.length - a.steps.length)[0];
      if (richest === undefined || richest.steps.length <= 1) {
        classMethods = await fetchClassMethods(code, top as Symbol);
      }
    }
    behavioral = buildBehavioralWalkthrough(hint, top, ctx ?? undefined, flowPool, classMethods);
    const noisy = hasIncidentSignal
      ? ' (note: live error signals also exist in this codebase — rephrase as a symptom like "X failing" for a fault hunt)'
      : '';
    summary =
      `${seedDisclaimer}${banner}"${hint}" reads as a "how does it work" question — here is the code path${noisy}:\n\n` +
      behavioral.narrative;
  }

  // Gap 4: a latency/performance hint with no metrics connector has nothing structural to
  // anchor to — say so instead of presenting an arbitrary low-confidence symbol as the finding.
  if (!explanatoryHint && looksPerformance(hint) && deps.metrics == null && seedIsLowConfidence) {
    summary =
      `${banner}"${hint}" reads as a latency/performance question, but no metrics connector ` +
      `(Grafana) is configured — response-time and error-rate trends can't be assessed from source ` +
      `structure alone${top ? ` (the closest structural match, ${top.name}, is a low-confidence guess, not a diagnosis)` : ''}. ` +
      `Connect a metrics source (\`horus connect grafana\`) and re-run, or name the specific slow operation.`;
  }

  // HOR-385: source-impact mode LEADS with the structural impact result (blast radius, or an
  // isolation verdict) instead of a runtime cause headline — runtime evidence is irrelevant to
  // "what depends on X / is X isolated from Y". Placed last so it wins over the cause/explanatory/
  // performance summaries above. The impact data already exists (`impact` = code.impact(top, 2)).
  if (sourceImpactHint && top && impact) {
    const affected = impact.affected;
    const depthChain = impact.byDepth
      .filter((d) => d.symbols.length > 0)
      .map((d) => `depth ${d.depth}: ${d.symbols.length}`)
      .join(', ');
    // verify-isolation: namedSymbols are positional — [0] = X (the seed), [1] = Y (isolation
    // target). Check whether Y is reachable in the impact set and render a verdict.
    const isolationTarget =
      looksVerifyIsolation(hint) && namedSymbols.length >= 2 ? namedSymbols[1] : undefined;
    if (isolationTarget !== undefined) {
      const reachDepth = impact.byDepth.find((d) =>
        d.symbols.some((s) => s.name.toLowerCase() === isolationTarget.toLowerCase()),
      )?.depth;
      summary =
        reachDepth !== undefined
          ? `${top.name} DOES affect ${isolationTarget} via a dependency path (reaches it at depth ${reachDepth}; ${affected} affected symbol(s) total).`
          : `${top.name} is isolated from ${isolationTarget} — no dependency path found (${affected} affected symbol(s) total, none matching ${isolationTarget}).`;
    } else {
      summary =
        `Impact of ${top.name}: ${affected} affected symbol(s)` +
        (depthChain ? ` (${depthChain}).` : '.');
    }
  }

  // i. nextActions
  const nextActions = buildNextActions(top, ctx, impact, queueHits, changes, input);
  // Gap #5: for a behavioral hint, point the user at the entry point for a deeper structural trace.
  if (explanatoryHint && behavioral?.entry) {
    nextActions.unshift(
      `Trace the full call graph of the entry point: \`horus explain ${behavioral.entry.name}\`.`,
    );
  }
  if (degradedNoSource) {
    nextActions.unshift(
      'Source intelligence was unavailable — run `horus init` to enable code-aware analysis, then re-run for a full investigation.',
    );
  }

  // Prepend owner routing when ownership is known (HOR-40) — but not for a fuzzy
  // seed (HOR-335): routing a maintainer for a fabricated seed is false authority.
  if (ownershipEstimate?.likelyMaintainer && !seedIsLowConfidence) {
    nextActions.unshift(
      `Route to likely maintainer: ${ownershipEstimate.likelyMaintainer} (${Math.round(ownershipEstimate.maintainerShare * 100)}% of commits to ${ownershipEstimate.file ?? top?.filePath ?? 'the implicated file'})`,
    );
  }

  const report: InvestigationReport = {
    id: globalThis.crypto.randomUUID(),
    input,
    ...(investigationSubject(input) !== undefined
      ? { subject: investigationSubject(input) }
      : {}),
    summary,
    intent,
    seeds,
    evidence,
    timeline,
    correlation,
    findings,
    suspectedCauses: rankedCauses,
    hypotheses: validated,
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph,
    confidence,
    nextActions,
    ownership: ownershipEstimate,
    causeChains: causeChains.length > 0 ? causeChains : undefined,
    ...(recentChanges !== undefined ? { recentChanges } : {}),
    ...(behavioral !== undefined ? { behavioral } : {}),
    ...(degradedNoSource
      ? { degraded: { sourceIntelligence: false, reason: 'source-intelligence host unreachable' } }
      : {}),
  };

  // HOR-19 — compute gap analysis and cap confidence BEFORE persisting so the
  // persisted record reflects the capped value.
  const connectorFlags: ConnectorFlags = deps.connectors
    ? {
        ...deps.connectors,
        // The queue connector is configured iff a BullMQ provider was constructed
        // (queueForEnv returns null without a bullmq/queues Redis DB) — HOR-205.
        queue: deps.queue != null,
        // Sentry is configured iff a provider was built; sentryCollected tracks whether
        // its collection ran (distinguishes "no open issues" from "collection failed").
        sentry: deps.sentry != null,
        sentryCollected,
        sentryFailureReason,
        // Axiom is configured iff a provider was built; axiomCollected tracks whether its
        // collection ran (distinguishes "no matching rows" from "collection failed").
        axiom: deps.axiom != null,
        axiomCollected,
        axiomFailureReason,
        // Shopify is configured iff a provider was built (auth present); shopifyCollected
        // tracks whether its query collection ran (vs "no queries supplied / failed").
        shopify: deps.shopify != null,
        shopifyCollected,
        shopifyFailureReason,
        metricsCollected,
        metricsFailureReason,
        logsCollected,
        logsCompatibilityError,
        logsFailureReason,
        stateCollected,
        stateFailureReason,
        queueCollected,
        queueFailureReason,
        sinceProvided: input.since !== undefined,
      }
    : {
        elasticsearch: deps.logs != null,
        mongodb: deps.mongo != null,
        postgres: deps.postgres != null,
        sentry: deps.sentry != null,
        sentryCollected,
        sentryFailureReason,
        axiom: deps.axiom != null,
        axiomCollected,
        axiomFailureReason,
        shopify: deps.shopify != null,
        shopifyCollected,
        shopifyFailureReason,
        grafana: deps.metrics != null,
        // Without CLI-supplied flags, redis is configured iff a Redis state provider was
        // built — the queue-gap routeHint and state-configured checks depend on it.
        redis: deps.redisState != null,
        queue: deps.queue != null,
        metricsCollected,
        metricsFailureReason,
        logsCollected,
        logsCompatibilityError,
        logsFailureReason,
        stateCollected,
        stateFailureReason,
        queueCollected,
        queueFailureReason,
        sinceProvided: input.since !== undefined,
      };
  // HOR-385: in source-impact mode the gap detector suppresses the runtime gaps and forces the
  // ceiling to 1.0 (a complete structural answer is not "missing" runtime data).
  const gapAnalysis = detectMissingEvidence(
    report,
    connectorFlags,
    sourceImpactHint ? 'source-impact' : undefined,
  );
  report.gapAnalysis = gapAnalysis;
  // HOR-385: each confidence ceiling below is an INCIDENT honesty guard — skip them in
  // source-impact mode where the structural answer is complete and the named seed is intentional.
  if (!sourceImpactHint) {
    report.confidence = Math.min(report.confidence, gapAnalysis.confidenceCeiling);
  }
  // HOR-335: a fuzzy/zero-support seed can never claim more than low confidence,
  // regardless of how much (unrelated) runtime evidence happens to be present. The named seed in
  // source-impact mode is intentional, not a weak guess — exempt it.
  if (seedIsLowConfidence && !sourceImpactHint) report.confidence = Math.min(report.confidence, 0.45);
  // HOR-336: the headline must reflect DIAGNOSIS strength, not just localization +
  // evidence volume. A run can localize a seed and surface lots of evidence yet
  // produce no meaningful root cause — that is "localized, cause unknown", not a
  // confident diagnosis. When no cause clears a meaningful bar (the cause scale is
  // compressed; real causes score ~0.3+), cap the headline so it can't read 0.85
  // over a 0.08 cause (or none at all). The ceiling is MONOTONIC in the headline
  // cause score: a modest cause (0.2–0.5) caps confidence to ~0.6–0.78; only a
  // strong cause (>=~0.5) permits high confidence. It is only ever a ceiling —
  // it never raises confidence.
  const topCauseScore = report.suspectedCauses[0]?.finalScore ?? 0;
  if (!sourceImpactHint) {
    report.confidence = Math.min(report.confidence, confidenceCeilingForCause(topCauseScore));
  }
  report.nextActions.push(...gapNextActions(gapAnalysis.gaps));
  // HOR-386 — deterministic next-step routing. The router is the SINGLE source of truth:
  // it decides here once and every surface (human/--json/MCP) renders this same
  // RouteStep[]. Computed AFTER the final confidence so `lowConfidence` reflects the capped
  // value. `topRoutableGap` is the highest-impact gap that has a real remedy (the `traces`
  // gap has none), since `gapAnalysis.gaps` is in insertion order, not impact order.
  const topRoutableGap = [...gapAnalysis.gaps]
    .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
    .find((g) => g.routeHint != null);
  const anyRuntimeConnector = Boolean(
    connectorFlags.elasticsearch ||
      connectorFlags.sentry ||
      connectorFlags.grafana ||
      connectorFlags.redis ||
      connectorFlags.postgres ||
      connectorFlags.mongodb,
  );
  report.nextSteps = route({
    command: 'investigate',
    intent,
    empty: false,
    lowConfidence: report.confidence < 0.5,
    topGap: topRoutableGap,
    noConnectors: intent === 'incident' && !anyRuntimeConnector,
    metricsNull: looksPerformance(hint) && deps.metrics == null,
    degradedSourceIntelligence: report.degraded != null,
    seedName: top?.name,
    query: hint,
  });
  report.sourceStatus = buildRuntimeSourceStatus(evidence, connectorFlags);

  // j. PERSIST — may overwrite report.id with the DB-assigned id.
  const persisted = await persist(db, input, report);
  const persistedId = persisted?.id ?? null;
  if (persistedId !== null) report.id = persistedId;
  // Record whether the report actually reached the investigation store so callers
  // can warn that a display-only run won't be retrievable via `horus ask`.
  report.persisted = persistedId !== null;

  // k. INCIDENT MEMORY (HOR-18) — recall similar past incidents THEN store.
  //    Past incidents are CONTEXT ONLY; they must never override report.confidence.
  if (persistedId !== null) {
    const tags = deriveTags(report);
    report.similarIncidents = await recallSimilar(db, tags, persistedId, input.repo ?? null);
    await storeIncidentMemory(db, persistedId, report);

    // HOR-432 — auto-capture a recurrence-CONSOLIDATING memory from THIS investigation. Default ON
    // (HORUS_AUTO_INVESTIGATION_MEMORY=0/false disables). A recurrence UPDATES the existing
    // investigation memory IN PLACE (bump count + refresh latest finding) instead of minting a twin.
    // CONTEXT-ONLY: the captured memory is never read by the confidence/verdict scoring path.
    // NON-BLOCKING: every failure is swallowed so auto-memory can never block report delivery.
    const store = deps.store;
    if (store !== undefined && autoInvestigationMemoryEnabled()) {
      try {
        const audit: AuditCtx = {
          actor: { kind: 'system' },
          note: 'auto: investigation memory (HOR-432)',
        };
        // Deterministic "seen at" stamp — the persisted investigation's createdAt (never Date.now()
        // in the scoring path); falls back to a fresh Date only when the DB did not echo createdAt.
        const reportTime = persisted?.createdAt ?? new Date();
        await captureInvestigationMemory(store, persistedId, report, reportTime, audit);
      } catch {
        // Non-blocking — auto-memory must never prevent investigation delivery (spec §7/§8).
      }
    }
  }
  // If persist failed (db down / no id), similarIncidents stays [] and we skip store.

  // l. AUDIT BUNDLE (HOR-16) — write the fully-finalized report to the investigations row
  //    so it can be re-rendered later without re-querying production.
  if (persistedId !== null) {
    try {
      await db
        .update(investigationsTable)
        .set({ report: report })
        .where(eq(investigationsTable.id, persistedId));
    } catch {
      // Non-fatal: the investigation row already exists; the audit bundle is best-effort.
    }
  }

  return report;
}

/**
 * Deterministic, name-bearing next-step suggestions. `top`/`ctx`/`impact` are absent in
 * degraded runtime-only mode (HOR-319 layer-2), where the suggestions key off the queue
 * and service scope instead of a resolved symbol.
 */
function buildNextActions(
  top: Symbol | undefined,
  _ctx: SymbolContext | null,
  impact: ImpactResult | null,
  queueHits: QueueEdge[],
  changes: ChangeSet | null,
  input: InvestigationInput,
): string[] {
  const actions: string[] = [];
  const seenQueues = new Set<string>();
  for (const edge of queueHits) {
    if (seenQueues.has(edge.queueName)) continue;
    seenQueues.add(edge.queueName);
    const worker = edge.workerSymbol ?? 'the consumer';
    actions.push(`Inspect logs for worker ${worker} on queue ${edge.queueName}`);
    actions.push(`Check depth/failures of queue ${edge.queueName}`);
  }
  if (top && impact && impact.affected > 0) {
    actions.push(`Review impact set of ${top.name} (${impact.affected} affected symbol(s))`);
  }
  if (top) {
    if (changes && input.since !== undefined) {
      actions.push(`Diff recent commits touching ${top.filePath} in ${input.since}..HEAD`);
    } else {
      actions.push(`Diff recent commits touching ${top.filePath}`);
    }
  }
  if (actions.length === 0) {
    actions.push(
      top
        ? `Inspect the source of ${top.name} at ${top.filePath}`
        : input.service
          ? `Inspect runtime logs and metrics for service "${input.service}"`
          : 'Inspect runtime logs and metrics for the affected service',
    );
  }
  return actions;
}

/**
 * Persist an investigation, its evidence, and findings. Never throws — if the DB is
 * down the investigation still returns. Returns the persisted investigation id when
 * available, else null.
 */
async function persist(
  db: HorusDb,
  input: InvestigationInput,
  report: InvestigationReport,
): Promise<{ id: string; createdAt: Date | null } | null> {
  try {
    const inserted = await db
      .insert(investigationsTable)
      .values({
        title: input.hint.trim() || 'Investigation',
        incidentInput: input,
        status: 'open',
        summary: report.summary,
      })
      .returning({ id: investigationsTable.id, createdAt: investigationsTable.createdAt });

    const row = inserted[0];
    if (!row) return null;
    const investigationId = row.id;

    if (report.evidence.length > 0) {
      await db.insert(evidenceTable).values(
        report.evidence.map((e) => ({
          id: e.id,
          investigationId,
          source: e.source,
          kind: e.kind,
          title: e.title,
          timestamp: e.timestamp ? new Date(e.timestamp) : null,
          relevance: e.relevance,
          payload: e.payload,
          links: e.links,
          provenance: e.provenance,
        })),
      );
    }

    if (report.findings.length > 0) {
      await db.insert(findingsTable).values(
        report.findings.map((f) => ({
          investigationId,
          kind: f.kind,
          title: f.title,
          detail: f.detail ?? null,
          confidence: f.confidence,
          evidenceIds: f.evidenceIds,
        })),
      );
    }

    if (report.hypotheses.length > 0) {
      await db.insert(hypothesesTable).values(
        report.hypotheses.map((hyp, i) => ({
          investigationId,
          rank: i + 1,
          statement: hyp.statement,
          score: hyp.confidence,
          supportingEvidence: hyp.supportingEvidenceIds,
          verdict: hyp.verdict,
        })),
      );
    }

    return { id: investigationId, createdAt: row.createdAt ?? null };
  } catch {
    return null;
  }
}
