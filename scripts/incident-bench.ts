/**
 * IncidentBench runner (hosted CI only): chronological replay of incident histories through the real
 * startup-recall and auto-capture paths, scored against independent relevance labels.
 *
 *   HORUS_BENCH_CASES=<dir of *.json cases> pnpm exec tsx scripts/incident-bench.ts
 *
 * Case file: { codebase, investigations: [{ id, createdAt, report }], labels: { <name>: [[ids...]] },
 * vectors?: { <hint text>: { q: number[], d: number[] } } }. `report` is the minimal projection that
 * auto-capture reads (input, summary, seeds, hypotheses, timeline, suspectedCauses, confidence).
 * With `vectors`, a fixed index replays the local embedding lane exactly; without, keyword-only.
 * Every memory write goes to a fresh disposable PGlite profile; nothing touches saved user storage.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, memoryItem, eq } from '../packages/db/src/index.ts';
import {
  captureInvestigationMemory,
  createLocalMemoryStore,
  recallStartupIncidents,
  indexIncidentHint,
  type MemoryVectorIndex,
} from '../packages/engine/src/index.ts';

interface BenchCase {
  codebase: string;
  investigations: Array<{ id: string; createdAt: string; report: any }>;
  labels: Record<string, string[][]>;
  vectors?: Record<string, { q: number[]; d: number[] }>;
}

/** Replays the host's memory index from precomputed vectors: cosine of query vs stored hint vectors. */
class FixedVectorIndex implements MemoryVectorIndex {
  private rows = new Map<string, { repo: string; d: number[] }>();
  constructor(private vectors: NonNullable<BenchCase['vectors']>) {}
  async upsert(i: { memoryId: string; claim: string; repo: string }) {
    const v = this.vectors[i.claim];
    if (v) this.rows.set(i.memoryId, { repo: i.repo, d: v.d });
  }
  async search(i: { query: string; repo: string; limit: number }) {
    const q = this.vectors[i.query]?.q;
    if (!q) return [];
    const cos = (a: number[], b: number[]) => {
      let dot = 0,
        na = 0,
        nb = 0;
      for (let k = 0; k < a.length; k++) {
        dot += a[k]! * b[k]!;
        na += a[k]! ** 2;
        nb += b[k]! ** 2;
      }
      return dot / Math.sqrt(na * nb);
    };
    return [...this.rows]
      .filter(([, r]) => r.repo === i.repo)
      .map(([memoryId, r]) => ({ memoryId, score: cos(q, r.d) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, i.limit);
  }
  async remove(memoryId: string) {
    this.rows.delete(memoryId);
  }
}

async function replay(bench: BenchCase, withVectors: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'horus-bench-'));
  const handle = await createLocalDb({ path: join(dir, 'db') });
  const store = createLocalMemoryStore(handle.db);
  const index =
    withVectors && bench.vectors ? new FixedVectorIndex(bench.vectors) : undefined;
  const memoryOf = new Map<string, string>();
  const recalled: Array<{ id: string; reportIds: string[][] }> = [];
  try {
    const rows = [...bench.investigations].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    for (const row of rows) {
      const now = new Date(row.createdAt);
      const matches = await recallStartupIncidents(store, row.report.input, {
        now,
        ...(index ? { index } : {}),
      });
      recalled.push({
        id: row.id,
        reportIds: await Promise.all(
          matches.map(async (m) => {
            const item = await store.get(m.memoryId);
            const ids = (item?.payload as { investigationIds?: string[] } | null)
              ?.investigationIds;
            return ids ?? [m.incidentId ?? ''];
          }),
        ),
      });
      const captured = await captureInvestigationMemory(store, row.id, row.report, now, {
        actor: { kind: 'system' },
        note: 'IncidentBench replay in isolated storage',
      });
      if (captured.memoryId) {
        memoryOf.set(row.id, captured.memoryId);
        if (captured.action === 'created')
          await handle.db
            .update(memoryItem)
            .set({ createdAt: now })
            .where(eq(memoryItem.id, captured.memoryId));
        if (index)
          await indexIncidentHint(
            index,
            row.report.input.repo,
            captured.memoryId,
            row.report.input.hint,
          );
      }
    }
  } finally {
    await handle.sql.end();
    await rm(dir, { recursive: true, force: true });
  }
  return {
    rows: [...bench.investigations].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    ),
    recalled,
  };
}

/** found = repeats whose related earlier incident is recalled; clean = unrelated incidents with no recall. */
function score(
  bench: BenchCase,
  families: string[][],
  run: Awaited<ReturnType<typeof replay>>,
) {
  const fam = new Map(families.flatMap((ids, k) => ids.map((id) => [id, k] as const)));
  const at = new Map(run.rows.map((r) => [r.id, Date.parse(r.createdAt)]));
  let repeats = 0,
    found = 0,
    unrelated = 0,
    clean = 0;
  for (const { id, reportIds } of run.recalled) {
    assert(fam.has(id), `${bench.codebase}: unlabelled investigation ${id}`);
    const relevant = new Set(
      [...fam]
        .filter(([other, k]) => k === fam.get(id) && at.get(other)! < at.get(id)!)
        .map(([other]) => other),
    );
    const hit = reportIds.some((ids) => ids.some((x) => relevant.has(x)));
    if (relevant.size) {
      repeats++;
      found += hit ? 1 : 0;
    } else {
      unrelated++;
      clean += reportIds.length ? 0 : 1;
    }
  }
  return { repeats, found, unrelated, clean };
}

const casesDir = process.env.HORUS_BENCH_CASES;
if (!casesDir)
  throw new Error('Set HORUS_BENCH_CASES to a directory of IncidentBench case files.');
const results: Record<string, unknown>[] = [];
const pooled = new Map<
  string,
  { repeats: number; found: number; unrelated: number; clean: number }
>();
for (const file of (await readdir(casesDir)).filter((f) => f.endsWith('.json')).sort()) {
  const bench = JSON.parse(await readFile(join(casesDir, file), 'utf8')) as BenchCase;
  for (const mode of bench.vectors ? ['embedding', 'keyword-only'] : ['keyword-only']) {
    const run = await replay(bench, mode === 'embedding');
    for (const [labelSet, families] of Object.entries(bench.labels)) {
      const s = score(bench, families, run);
      results.push({ codebase: bench.codebase, mode, labelSet, ...s });
      const key = `${mode}/${labelSet}`;
      const p = pooled.get(key) ?? { repeats: 0, found: 0, unrelated: 0, clean: 0 };
      pooled.set(key, {
        repeats: p.repeats + s.repeats,
        found: p.found + s.found,
        unrelated: p.unrelated + s.unrelated,
        clean: p.clean + s.clean,
      });
    }
  }
}
const summary = [...pooled].map(([key, p]) => ({
  key,
  ...p,
  foundRate: p.repeats ? p.found / p.repeats : null,
  cleanRate: p.unrelated ? p.clean / p.unrelated : null,
}));
const out = {
  benchmark: 'IncidentBench',
  version: 0,
  task: 'startup-recall',
  results,
  pooled: summary,
};
if (process.env.HORUS_BENCH_OUT)
  await writeFile(process.env.HORUS_BENCH_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
