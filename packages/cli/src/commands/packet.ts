/**
 * HOR-384 — `horus packet`: a compact, honesty-framed projection of an investigation
 * for an agent's context window.
 *
 * Two input modes, auto-detected:
 *   - saved investigation id (UUID) → load the persisted report (no re-query) and project it.
 *   - hint → run a fresh investigation, then project it. There is no hint-keyed reuse/TTL cache
 *     in the codebase today, so the honest implementation is a fresh run (follow-up: HOR — add
 *     hint-keyed recent-investigation reuse / TTL cache).
 *
 * Output: `--json` emits `packetToJSON` (clean for piping into agents); otherwise the Markdown
 * rendering. `--for <agent>` is a thin presentation preset that only tightens caps / drops
 * timestamps — it never changes which evidence or caveats are computed.
 *
 * Remembered context (memory): the packet is enriched with what Horus already KNOWS — relevant
 * stored Memory items recalled via `recallMemory` against the local `MemoryStore`, scoped by the
 * packet's project + seed/hint/scope. This is the ONLY async I/O the packet adds, so it runs here
 * (the engine `buildPacket` stays pure and receives the recalled items via `opts.memory`). Recall is
 * BEST-EFFORT: a missing project, a down store, or any error simply yields no memory section — it
 * NEVER blocks packet delivery, and memory is CONTEXT ONLY (never live evidence, never scoring).
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import type { ResolvedEnvironment } from '@horus/core';
import { openDb, getInvestigation } from '@horus/db';
import type { HorusDb } from '@horus/db';
import { memoryIndexForEnv, collectRepoState } from '@horus/connectors';
import type { CodeProvider } from '@horus/connectors';
import {
  buildPacket,
  renderPacketMarkdown,
  packetToJSON,
  migrateReport,
  createLocalMemoryStore,
  recallMemory,
  recallCodeProviderFromCodeProvider,
  NoopVectorIndex,
} from '@horus/engine';
import type {
  InvestigationReport,
  AgentPreset,
  PacketFreshness,
  RecalledMemory,
  RecallQuery,
  RecallOptions,
  MemoryVectorIndex,
  RepoIdentity,
} from '@horus/engine';
import { repoRootOrCwd } from '../lib/cloud/session.js';
import {
  computeFreshness,
  readIndexMeta,
  commitsSince,
  semanticSearchReady,
} from '../lib/freshness.js';
import {
  buildInvestigationContext,
  runOneInvestigation,
  disposeInvestigationContext,
} from '../lib/investigation-runner.js';

/** Standard UUID (the id `engine.investigate()` mints via crypto.randomUUID). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valid `--for` presets; anything else is rejected with a clear message. */
const PRESETS: ReadonlySet<AgentPreset> = new Set(['claude', 'cursor', 'generic']);

/**
 * Compute the freshness inputs the honesty header consumes, from the repo's index metadata
 * + the report's evidence timestamps, plus the semantic-search-readiness flag (which is NOT
 * part of `computeFreshness().caveats` and must be passed explicitly — see freshness.ts).
 */
async function computePacketFreshness(
  repoRoot: string,
  report: InvestigationReport,
): Promise<PacketFreshness> {
  const meta = readIndexMeta(repoRoot);
  const commitsSinceIndex = meta?.lastIndexedAt
    ? await commitsSince(repoRoot, meta.lastIndexedAt)
    : null;
  const f = computeFreshness({
    repoRoot,
    evidence: report.evidence,
    nowIso: new Date().toISOString(),
    meta,
    commitsSinceIndex,
    anyRuntimeConnector: report.sourceStatus?.sources.some((s) => s.configured) ?? false,
  });
  return {
    indexStale: f.indexStale,
    commitsSinceIndex: f.commitsSinceIndex,
    runtimeWindow: f.runtimeWindow,
    caveats: f.caveats,
    semanticSearchReady: semanticSearchReady(meta),
  };
}

/** Cap on remembered-context items recalled for a packet (buildPacket caps the surfaced subset). */
const PACKET_MEMORY_LIMIT = 8;

/**
 * The free-text relevance query handed to `recallMemory` — built from the packet's seed/scope: the
 * hint, the path scope, the resolved seed symbol, and the headline cause title. The vector index
 * (M2: Source-when-available, Jaccard fallback) uses it to PROPOSE relevance; the store's
 * deterministic filter/rank stays authoritative.
 */
function packetMemoryQuery(report: InvestigationReport, project: string): RecallQuery {
  const parts = [
    report.input.hint,
    report.input.scope,
    report.seeds[0]?.name,
    report.suspectedCauses[0]?.title,
  ];
  return {
    repo: project,
    text: parts.filter((p): p is string => !!p && p.trim() !== '').join(' '),
  };
}

/**
 * Resolve the Source-when-available {@link MemoryVectorIndex} for an env (nomic embeddings on the
 * local source host), composed over a deterministic Jaccard `NoopVectorIndex` fallback. Never throws
 * — an unresolvable env / down host degrades recall to scope+freshness ranking. LOCAL-ONLY: the
 * source index talks only to the local host; memory vectors never enter any cloud path.
 */
function packetVectorIndex(renv: ResolvedEnvironment): MemoryVectorIndex {
  const fallback = new NoopVectorIndex();
  try {
    return (memoryIndexForEnv(renv, fallback) as MemoryVectorIndex | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Recall relevant remembered context for the packet. BEST-EFFORT and fail-closed (HOR-46): no
 * db/project → no memory; any store/recall error → no memory. Memory is additive CONTEXT and must
 * NEVER block or fail packet delivery (honesty invariant). A live `code` provider, when present,
 * enables read-time drift detection on `about-symbol` links.
 */
async function recallPacketMemory(args: {
  db: HorusDb | undefined;
  project: string | undefined;
  report: InvestigationReport;
  vectorIndex?: MemoryVectorIndex;
  code?: CodeProvider | null;
}): Promise<RecalledMemory[]> {
  const { db, project, report } = args;
  if (!db || !project || project.trim() === '') return [];
  try {
    const store = createLocalMemoryStore(db);
    const recallOpts: RecallOptions = { limit: PACKET_MEMORY_LIMIT };
    if (args.vectorIndex) recallOpts.vectorIndex = args.vectorIndex;
    if (args.code) recallOpts.code = recallCodeProviderFromCodeProvider(args.code);
    return await recallMemory(store, packetMemoryQuery(report, project), recallOpts);
  } catch {
    // Best-effort — a memory failure leaves the packet whole, just without remembered context.
    return [];
  }
}

/**
 * Repo identity for the packet — WHICH checkout produced the evidence. Best-effort git:
 * a missing/broken repo simply yields null fields (never blocks packet delivery). The repo
 * NAME is the resolved project (config-derived), branch/commit come from the working tree.
 */
async function collectPacketRepo(
  name: string | undefined,
  repoPath: string,
): Promise<RepoIdentity> {
  const state = await collectRepoState(repoPath);
  return {
    name: name && name.trim() !== '' ? name : null,
    branch: state?.branch ?? null,
    commit: state?.headSha ?? null,
  };
}

/** Emit the packet in the requested format. */
function emitPacket(
  report: InvestigationReport,
  opts: {
    json?: boolean;
    for_?: AgentPreset;
    freshness?: PacketFreshness;
    memory?: RecalledMemory[];
    repo?: RepoIdentity;
  },
): void {
  const packet = buildPacket(report, {
    ...(opts.for_ !== undefined ? { preset: opts.for_ } : {}),
    ...(opts.freshness !== undefined ? { freshness: opts.freshness } : {}),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
    ...(opts.repo !== undefined ? { repo: opts.repo } : {}),
  });
  if (opts.json) {
    console.log(JSON.stringify(packetToJSON(packet), null, 2));
  } else {
    console.log(renderPacketMarkdown(packet));
  }
}

export async function runPacket(
  hintOrId: string,
  opts: {
    config?: string;
    env?: string;
    scope?: string;
    service?: string;
    since?: string;
    timeout?: string;
    for?: string;
    json?: boolean;
  },
): Promise<number> {
  // `--for` is presentation-only; validate up front so an agent gets a clear error, not silence.
  let preset: AgentPreset | undefined;
  if (opts.for !== undefined) {
    if (!PRESETS.has(opts.for as AgentPreset)) {
      console.error(
        pc.red(
          `Unknown --for preset "${opts.for}". Expected one of: ${[...PRESETS].join(', ')}.`,
        ),
      );
      return 1;
    }
    preset = opts.for as AgentPreset;
  }

  // ── Saved-id path: load the persisted report, no re-query ───────────────────
  if (UUID_RE.test(hintOrId)) {
    const { db, sql } = await openDb();
    try {
      const row = await getInvestigation(db, hintOrId);
      if (!row) {
        console.error(pc.red('No investigation found: ' + hintOrId));
        return 1;
      }
      if (!row.report) {
        console.error(
          pc.red(
            'Investigation ' +
              hintOrId +
              ' has no stored report (run a newer investigation).',
          ),
        );
        return 1;
      }
      const report = migrateReport(row.report) as InvestigationReport;
      const repoRoot = repoRootOrCwd();
      const freshness = await computePacketFreshness(repoRoot, report);
      const repo = await collectPacketRepo(report.input.repo, repoRoot);
      // Remembered context: scoped to the report's own project (HOR-46 fail-closed via
      // recallPacketMemory). No live source host here, so drift detection is skipped — recall ranks
      // by stored confidence × read-time freshness; a missing project simply yields no memory.
      const memory = await recallPacketMemory({
        db,
        project: report.input.repo,
        report,
      });
      emitPacket(report, { json: opts.json, for_: preset, freshness, memory, repo });
      return 0;
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      console.error(pc.red(msg.trim() ? msg : 'Failed to load investigation.'));
      if (process.env.HORUS_DEBUG)
        console.error(pc.dim((err as Error)?.stack ?? String(err)));
      return 1;
    } finally {
      await sql.end();
    }
  }

  // ── Hint path: run a fresh investigation, then project it ────────────────────
  try {
    const config = await loadConfig(opts.config);
    let renv;
    try {
      renv = resolveEnvironment(config, { env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const repoRoot = repoRootOrCwd(renv.path);

    let ctx;
    try {
      ctx = await buildInvestigationContext(renv, {
        databaseUrl: config.database.url,
        ...(opts.service !== undefined ? { service: opts.service } : {}),
      });
    } catch (err) {
      // No source-intelligence connector configured — same hard requirement as `investigate`.
      console.error(pc.red((err as Error).message));
      return 1;
    }

    try {
      const timeoutSec =
        (opts.timeout !== undefined ? Number(opts.timeout) : 0) ||
        Number(process.env.HORUS_INVESTIGATE_TIMEOUT_S) ||
        120;
      const report = await runOneInvestigation(
        {
          hint: hintOrId,
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          ...(opts.service !== undefined ? { service: opts.service } : {}),
        },
        ctx,
        { timeoutMs: timeoutSec * 1000 },
      );
      const freshness = await computePacketFreshness(repoRoot, report);
      const repo = await collectPacketRepo(renv.project, repoRoot);
      // Remembered context: recall against the SAME open DB + project, with the Source-when-available
      // vector index for relevance and the live code provider for read-time drift detection. Reuses
      // ctx's handles (no extra connections) and is best-effort — a recall failure never blocks here.
      const memory = await recallPacketMemory({
        db: ctx.dbHandle?.db,
        project: renv.project,
        report,
        vectorIndex: packetVectorIndex(renv),
        code: ctx.code,
      });
      emitPacket(report, { json: opts.json, for_: preset, freshness, memory, repo });
    } finally {
      // Close EVERY connector + the DB or the process lingers forever (unclosed pg/ioredis handle).
      await disposeInvestigationContext(ctx);
    }
    return 0;
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error(pc.red(msg.trim() ? msg : 'Packet generation failed (unknown error).'));
    if (process.env.HORUS_DEBUG)
      console.error(pc.dim((err as Error)?.stack ?? String(err)));
    return 1;
  }
}
