/**
 * HOR-362 — Investigation freshness.
 *
 * A clean-looking report shouldn't hide that it was built on a stale code index or on
 * runtime evidence outside the incident window. This computes, from the repo's index
 * metadata (`.horus/source/meta.json`, written by horus-source) and the report's own
 * evidence timestamps, how fresh the inputs are — surfaced as a banner so the reader can
 * trust (or distrust) the headline accordingly.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pc from 'picocolors';

const execFileAsync = promisify(execFile);

/**
 * How many commits on HEAD landed after `sinceIso` — i.e. how far the code index is behind
 * the working tree. Returns null when it can't be determined (not a git repo, bad date, etc.).
 */
export async function commitsSince(repoRoot: string, sinceIso: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'rev-list', '--count', `--since=${sinceIso}`, 'HEAD'],
      { timeout: 5000 },
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Runtime evidence ages; code/history don't carry a meaningful "window". */
const RUNTIME_SOURCES = new Set(['logs', 'metrics', 'state', 'queue']);
/** Code index older than this is flagged stale. */
export const STALE_INDEX_MS = 7 * 24 * 60 * 60 * 1000;

export interface IndexMeta {
  lastIndexedAt?: string;
  version?: string;
  stats?: Record<string, number>;
  /** HOR-375: false until the (possibly background) embedding phase persisted vectors. */
  embeddingsComplete?: boolean;
}

/** Read `.horus/source/meta.json` for the repo, or null when absent/unreadable. */
export function readIndexMeta(repoRoot: string): IndexMeta | null {
  try {
    const raw = readFileSync(join(repoRoot, '.horus', 'source', 'meta.json'), 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastIndexedAt: typeof j.last_indexed_at === 'string' ? j.last_indexed_at : undefined,
      version: typeof j.version === 'string' ? j.version : undefined,
      stats: (j.stats as Record<string, number>) ?? undefined,
      embeddingsComplete:
        typeof j.embeddings_complete === 'boolean' ? j.embeddings_complete : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Whether a repo's index has usable semantic-search vectors (HOR-373/375). An index with symbols
 * but zero embeddings — or an explicit `embeddings_complete: false` — silently degrades search to
 * keyword/FTS only, so callers (readiness/doctor) can surface it instead of letting recall vanish.
 */
export function semanticSearchReady(meta: IndexMeta | null): boolean {
  if (meta === null) return false;
  if (meta.embeddingsComplete === false) return false;
  const embeddings = meta.stats?.embeddings ?? 0;
  const symbols = meta.stats?.symbols ?? 0;
  return !(symbols > 0 && embeddings === 0);
}

export interface Freshness {
  /** ms since the repo was indexed, or null when unknown. */
  indexAgeMs: number | null;
  indexAgeLabel: string;
  indexStale: boolean;
  /** Commits on HEAD since the index was built (how far behind the working tree it is). */
  commitsSinceIndex: number | null;
  /** Span of runtime evidence actually used, when any carried timestamps. */
  runtimeWindow: { fromIso: string; toIso: string } | null;
  /** Distinct runtime sources that contributed evidence (logs/metrics/state/queue). */
  runtimeSources: string[];
  caveats: string[];
}

/** Compact human age, e.g. `45s`, `12m`, `3h`, `5d`. */
export function humanAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface FreshnessEvidence {
  source?: string;
  timestamp?: string;
}

/** Derive a freshness summary from the index metadata + the report's evidence. */
export function computeFreshness(opts: {
  repoRoot: string;
  evidence: FreshnessEvidence[];
  nowIso: string;
  /** Injectable for tests; defaults to reading meta.json under repoRoot. */
  meta?: IndexMeta | null;
  /** Commits since the index was built (from `commitsSince`); null/undefined when unknown. */
  commitsSinceIndex?: number | null;
}): Freshness {
  const now = Date.parse(opts.nowIso);
  const meta = opts.meta !== undefined ? opts.meta : readIndexMeta(opts.repoRoot);
  const commitsSinceIndex = opts.commitsSinceIndex ?? null;
  const caveats: string[] = [];

  // ── Code index age ──────────────────────────────────────────────────────
  let indexAgeMs: number | null = null;
  let indexAgeLabel = 'index age unknown';
  let indexStale = false;
  const indexedAt = meta?.lastIndexedAt ? Date.parse(meta.lastIndexedAt) : NaN;
  if (!Number.isNaN(indexedAt)) {
    indexAgeMs = Math.max(0, now - indexedAt);
    indexAgeLabel = `indexed ${humanAge(indexAgeMs)} ago`;
    indexStale = indexAgeMs > STALE_INDEX_MS;
    if (indexStale) {
      caveats.push(
        `code index is ${humanAge(indexAgeMs)} old — re-run \`horus init\` so analysis reflects current code`,
      );
    }
  } else {
    caveats.push('code index age unknown (no .horus/source/meta.json) — freshness unverified');
  }

  // ── Index drift vs git ───────────────────────────────────────────────────
  // Even a recently-built index can be behind new commits; flag that explicitly.
  if (typeof commitsSinceIndex === 'number' && commitsSinceIndex > 0) {
    caveats.push(
      `${commitsSinceIndex} commit(s) since the last index — re-run \`horus init\` so analysis reflects current code`,
    );
  }

  // ── Runtime evidence window ─────────────────────────────────────────────
  const runtime = opts.evidence.filter((e) => e.source && RUNTIME_SOURCES.has(e.source));
  const runtimeSources = [...new Set(runtime.map((e) => e.source as string))].sort();
  const stamps = runtime
    .map((e) => (e.timestamp ? Date.parse(e.timestamp) : NaN))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const runtimeWindow =
    stamps.length > 0
      ? { fromIso: new Date(stamps[0]!).toISOString(), toIso: new Date(stamps[stamps.length - 1]!).toISOString() }
      : null;
  if (runtime.length === 0) {
    caveats.push(
      'no runtime evidence — source-only investigation; connect logs/metrics/queues for deeper grounding',
    );
  }

  return {
    indexAgeMs,
    indexAgeLabel,
    indexStale,
    commitsSinceIndex,
    runtimeWindow,
    runtimeSources,
    caveats,
  };
}

/** Render the freshness summary as a dim banner (text/markdown output). */
export function renderFreshness(f: Freshness): string {
  const lines: string[] = [];
  const behind = f.commitsSinceIndex && f.commitsSinceIndex > 0 ? ` (${f.commitsSinceIndex} behind)` : '';
  const label = f.indexAgeLabel + behind;
  const idx = f.indexStale || behind ? pc.yellow(label) : label;
  const runtime =
    f.runtimeWindow !== null
      ? `runtime ${f.runtimeWindow.fromIso.slice(0, 10)}→${f.runtimeWindow.toIso.slice(0, 10)}` +
        (f.runtimeSources.length ? ` (${f.runtimeSources.join(', ')})` : '')
      : 'no runtime window';
  lines.push(pc.dim(`Freshness: code ${idx} · ${runtime}`));
  for (const c of f.caveats) lines.push(pc.yellow(`  ⚠ ${c}`));
  return lines.join('\n');
}
