import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb } from '@horus/db';
import { listQueueEdges } from '@horus/db';
import type { QueueEdge } from '@horus/db';
import { queueForEnv } from '@horus/connectors';
import type { QueueCounts } from '@horus/connectors';
import { renderInterpretation } from '@horus/ai';
import type { InterpretationProvider } from '@horus/ai';
import { renderAiInterpretation } from '../lib/ai-provider.js';

export const QUEUES_AI_CONTRACT = `Provide a clearly separated AI evidence narration with:

Evidence used
- Queue names, waiting/active/failed/delayed counts, and producer/worker mappings Horus found

What stands out
- Queues with high failed counts, unexpected backlog, or paused state
- Runtime-only queues (live in Redis, no static producer/worker mapping)
- Producer/worker mismatches or orphaned queues

What this may indicate
- Use "may suggest", "is consistent with", or "could indicate" — never "proves"
- Do not invent queue names, Redis keys, or job data not in the evidence

What is not proven
- Claims about job contents, specific error messages, or data inside failed jobs

Next checks
- Exact Horus commands or Redis/BullMQ checks to inspect next`;

export async function runQueues(
  name: string | undefined,
  opts: {
    config?: string;
    project?: string;
    name?: string;
    live?: boolean;
    json?: boolean;
    ai?: boolean;
    aiModel?: string;
    /** Injectable AI provider for tests — bypasses credential resolution. */
    _aiProvider?: InterpretationProvider;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config, { name: opts.name });
    const { db, sql } = await openDb(config.database.url);

    try {
      // Scope the topology to the ACTIVE project. listQueueEdges with project=undefined
      // returns every project's rows from the shared Horus database, so without this a
      // repo would show other projects' queues as its own (e.g. another repo's Zoho
      // queues bleeding into this one). Resolve the project the same way the rest of the
      // CLI does: explicit --project, else the single configured project, else infer from
      // the current repo path. If it can't be resolved (multi-project config, no cwd
      // match), fall back to the unscoped listing rather than failing.
      let project = opts.project;
      if (project === undefined) {
        try {
          project = resolveEnvironment(config, { project: opts.project }).project;
        } catch {
          // Unresolvable — leave undefined (unscoped) to preserve prior behavior.
        }
      }
      const rows = await listQueueEdges(db, { project, queueName: name });

      // HOR-343: a named queue with no static topology is likely dynamically registered
      // (e.g. `new Worker(enumValue)`), not unindexed — show its live state instead of
      // dead-ending at "run horus init".
      const showLive = opts.live || (name !== undefined && rows.length === 0);

      // JSON: structured static topology (+ live state when requested or auto-enabled).
      if (opts.json) {
        const topology = topologyToJson(buildQueueMap(rows));
        const out: Record<string, unknown> = { project: project ?? null, topology };
        if (showLive) out['live'] = await gatherLiveState(config, rows, name);
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }

      // ── Source topology ──────────────────────────────────────────────────────
      console.log(
        pc.bold('Queue topology') +
          pc.dim('  ·  source: code / source intelligence  ·  static (run horus init to refresh)'),
      );
      console.log('');

      if (rows.length === 0) {
        console.log(
          name !== undefined
            ? pc.dim(`  No static topology for "${name}" — it may be dynamically registered; showing live state below.`)
            : pc.dim('  No queue edges indexed. Run: horus init'),
        );
      } else {
        const byQueue = buildQueueMap(rows);
        printTopology(byQueue);
      }

      // ── Live queue state ─────────────────────────────────────────────────────
      console.log('');

      if (showLive) {
        await runLiveMode(config, rows, name, opts.ai ? {
          config: opts.config,
          aiModel: opts.aiModel,
          _aiProvider: opts._aiProvider,
        } : undefined);
      } else {
        console.log(
          pc.dim(
            '  Tip: run horus queues --live to show real-time Redis/BullMQ depths and failed-job counts.',
          ),
        );
        if (opts.ai) {
          console.log(pc.dim('  Tip: --ai is most useful with --live (horus queues --live --ai).'));
        }
      }
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Topology helpers
// ---------------------------------------------------------------------------

function buildQueueMap(rows: QueueEdge[]): Map<string, QueueEdge[]> {
  const byQueue = new Map<string, QueueEdge[]>();
  for (const row of rows) {
    const existing = byQueue.get(row.queueName);
    if (existing) {
      existing.push(row);
    } else {
      byQueue.set(row.queueName, [row]);
    }
  }
  return byQueue;
}

/** Distinct {symbol, file} pairs for a queue's producers or workers. */
function endpoints(edges: QueueEdge[], symKey: 'producerSymbol' | 'workerSymbol', fileKey: 'producerFile' | 'workerFile') {
  const seen = new Map<string, { symbol: string; file: string | null }>();
  for (const e of edges) {
    const symbol = e[symKey];
    if (!symbol) continue;
    if (!seen.has(symbol)) seen.set(symbol, { symbol, file: e[fileKey] ?? null });
  }
  return [...seen.values()];
}

/** Structured static topology for --json. */
function topologyToJson(byQueue: Map<string, QueueEdge[]>) {
  return [...byQueue.entries()].map(([queueName, edges]) => ({
    queueName,
    producers: endpoints(edges, 'producerSymbol', 'producerFile'),
    workers: endpoints(edges, 'workerSymbol', 'workerFile'),
  }));
}

/** Gather live BullMQ state as structured data (shared by --live --json). */
async function gatherLiveState(
  config: Awaited<ReturnType<typeof loadConfig>>,
  rows: QueueEdge[],
  nameFilter: string | undefined,
): Promise<Record<string, unknown>> {
  let renv: ReturnType<typeof resolveEnvironment>;
  try {
    renv = resolveEnvironment(config);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const queueProvider = queueForEnv(renv);
  if (!queueProvider) return { ok: false, error: 'Redis not configured' };
  try {
    const health = await queueProvider.health();
    if (!health.ok) return { ok: false, error: health.detail };
    const staticNames = new Set(buildQueueMap(rows).keys());
    let queueNames: string[] | undefined;
    if (nameFilter !== undefined) {
      queueNames = [nameFilter];
    } else {
      const discovered = await queueProvider.discoverQueues().catch(() => [] as string[]);
      const union = new Set<string>([...staticNames, ...discovered]);
      queueNames = union.size > 0 ? [...union] : undefined;
    }
    const state = await queueProvider.analyzeQueues({ queueNames });
    return {
      ok: true,
      prefix: state.prefix,
      collectedAt: state.collectedAt,
      queues: state.queues.map((q) => ({ ...q, runtimeOnly: !staticNames.has(q.queueName) })),
    };
  } finally {
    await queueProvider.close().catch(() => {});
  }
}

function printTopology(byQueue: Map<string, QueueEdge[]>): void {
  for (const [queueName, edges] of byQueue) {
    console.log(pc.bold(queueName));

    // Distinct non-null producerSymbol values
    const producerSet = new Set<string>();
    const producerDetails = new Map<string, string>();
    for (const edge of edges) {
      if (edge.producerSymbol) {
        producerSet.add(edge.producerSymbol);
        if (edge.producerFile) producerDetails.set(edge.producerSymbol, edge.producerFile);
      }
    }

    if (producerSet.size === 0) {
      console.log('  producers: ' + pc.dim('none'));
    } else {
      const list = Array.from(producerSet)
        .map((sym) => {
          const file = producerDetails.get(sym);
          return file ? `${sym} (${file})` : sym;
        })
        .join(', ');
      console.log('  producers: ' + list);
    }

    // Distinct non-null workerSymbol values
    const workerSet = new Set<string>();
    const workerDetails = new Map<string, string>();
    for (const edge of edges) {
      if (edge.workerSymbol) {
        workerSet.add(edge.workerSymbol);
        if (edge.workerFile) workerDetails.set(edge.workerSymbol, edge.workerFile);
      }
    }

    if (workerSet.size === 0) {
      console.log('  workers: ' + pc.dim('none'));
    } else {
      const list = Array.from(workerSet)
        .map((sym) => {
          const file = workerDetails.get(sym);
          return file ? `${sym} (${file})` : sym;
        })
        .join(', ');
      console.log('  workers: ' + list);
    }

    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function runLiveMode(
  config: Awaited<ReturnType<typeof loadConfig>>,
  rows: QueueEdge[],
  nameFilter: string | undefined,
  aiOpts?: { config?: string; aiModel?: string; _aiProvider?: InterpretationProvider },
): Promise<void> {
  let renv: ReturnType<typeof resolveEnvironment>;
  try {
    renv = resolveEnvironment(config);
  } catch (err) {
    console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    console.log(pc.yellow(`  ⚠ Cannot resolve environment: ${(err as Error).message}`));
    return;
  }

  const queueProvider = queueForEnv(renv);

  if (!queueProvider) {
    console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    console.log(
      pc.yellow('  ○ Redis not configured — run: ') + pc.bold('horus connect redis'),
    );
    return;
  }

  let headerPrinted = false;
  try {
    // Probe reachability first
    const health = await queueProvider.health();
    if (!health.ok) {
      console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
      console.log(pc.red(`  ✗ Redis unreachable: ${health.detail}`));
      return;
    }

    // Probe the UNION of statically-known queues and queues discovered live in Redis.
    // Static-only probing hid runtime-only queues (present in BullMQ but with no
    // static producer/worker mapping); discovery-only probing hid idle static queues
    // (no live keys to scan). The union shows both, so the live view matches what a
    // Bull dashboard sees. A single-queue filter still narrows to that one.
    const staticNames = new Set(buildQueueMap(rows).keys());
    let queueNames: string[] | undefined;
    if (nameFilter !== undefined) {
      queueNames = [nameFilter];
    } else {
      const discovered = await queueProvider.discoverQueues().catch(() => [] as string[]);
      const union = new Set<string>([...staticNames, ...discovered]);
      queueNames = union.size > 0 ? [...union] : undefined;
    }

    const state = await queueProvider.analyzeQueues({ queueNames });
    const collectedAt = new Date(state.collectedAt).toLocaleTimeString();

    console.log(
      pc.bold('Live queue state') +
        pc.dim(`  ·  source: Redis/BullMQ (prefix: ${state.prefix})  ·  collected: ${collectedAt}`),
    );
    headerPrinted = true;
    console.log('');

    if (state.queues.length === 0) {
      console.log(pc.dim('  No queues found in Redis.'));
      console.log(
        pc.dim(
          '  If queues exist under a custom prefix, set the BullMQ prefix in your connector config.',
        ),
      );
      return;
    }

    printLiveTable(state.queues, staticNames);

    if (aiOpts) {
      const evidence = {
        prefix: state.prefix,
        collectedAt: state.collectedAt,
        queues: state.queues.map((q) => ({ ...q, runtimeOnly: !staticNames.has(q.queueName) })),
      };
      const result = await renderAiInterpretation({
        command: 'queues',
        evidence,
        promptKind: 'evidence-summary',
        outputContract: QUEUES_AI_CONTRACT,
        config: aiOpts.config,
        modelOverride: aiOpts.aiModel,
        provider: aiOpts._aiProvider,
      });
      console.log('\n' + renderInterpretation(result));
      if (!result.ok) {
        console.error(pc.yellow(`[ai] ${result.warning}`));
      }
    }
  } catch (err) {
    if (!headerPrinted) {
      console.log(pc.bold('Live queue state') + pc.dim('  ·  source: Redis/BullMQ'));
    }
    console.log(pc.red(`  ✗ ${(err as Error).message}`));
  } finally {
    await queueProvider.close().catch(() => {});
  }
}

function printLiveTable(queues: QueueCounts[], staticNames: Set<string> = new Set()): void {
  // Column widths
  const nameWidth = Math.max(10, ...queues.map((q) => q.queueName.length));
  const numWidth = 7;

  const header =
    '  ' +
    'queue'.padEnd(nameWidth) +
    '  ' +
    'waiting'.padStart(numWidth) +
    '  ' +
    'active'.padStart(numWidth) +
    '  ' +
    'failed'.padStart(numWidth) +
    '  ' +
    'delayed'.padStart(numWidth) +
    '  ' +
    'paused'.padStart(numWidth);
  console.log(pc.dim(header));
  console.log(pc.dim('  ' + '─'.repeat(header.length - 2)));

  for (const q of queues) {
    const hasIssue = q.failed > 0 || q.waiting > 100 || q.delayed > 50 || q.isPaused;
    const color = hasIssue ? pc.yellow : (s: string) => s;

    const row =
      '  ' +
      q.queueName.padEnd(nameWidth) +
      '  ' +
      String(q.waiting).padStart(numWidth) +
      '  ' +
      String(q.active).padStart(numWidth) +
      '  ' +
      String(q.failed).padStart(numWidth) +
      '  ' +
      String(q.delayed).padStart(numWidth) +
      '  ' +
      (q.isPaused ? pc.yellow('paused') : String(q.paused).padStart(numWidth));
    console.log(color(row));

    // Flag queues live in Redis that have no static producer/worker mapping —
    // they exist at runtime but weren't discovered in the source graph.
    if (!staticNames.has(q.queueName)) {
      console.log(pc.dim('    runtime-only · no static producer/worker mapping'));
    }

    // Oldest waiting job
    if (q.oldestWaitingMs !== undefined) {
      const age = formatAge(q.oldestWaitingMs);
      console.log(pc.dim(`    oldest waiting: ${age}`));
    }

    // Newest failure age for the queue overall — tells a live failure from a stale
    // pile at a glance (HOR-217). 1h is the staleness cutoff.
    if (q.newestFailedAgeMs !== undefined) {
      const stale = q.newestFailedAgeMs > 3_600_000;
      const ageLine = `    most recent failure: ${formatAge(q.newestFailedAgeMs)} ago`;
      console.log(stale ? pc.yellow(`${ageLine} [STALE]`) : pc.dim(ageLine));
    }

    // Failed breakdown — annotate each reason with how long ago it last failed.
    if (q.failedBreakdown && q.failedBreakdown.length > 0) {
      for (const fb of q.failedBreakdown.slice(0, 3)) {
        let suffix = '';
        if (fb.lastFailedAgeMs !== undefined) {
          const stale = fb.lastFailedAgeMs > 3_600_000;
          suffix = pc.dim(` (last ${formatAge(fb.lastFailedAgeMs)} ago)`) + (stale ? pc.yellow(' [STALE]') : '');
        }
        console.log(pc.red(`    ✗ [${fb.count}x] ${fb.reason}`) + suffix);
      }
    }
  }
  console.log('');
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
