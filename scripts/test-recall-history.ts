/** Opt-in read-only history replay; all memory writes use a fresh disposable PGlite profile. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreRecallQuality } from '../packages/engine/src/recall-quality.js';
import { createLocalDb, memoryItem, eq } from '../packages/db/src/index.ts';
import {
  createLocalMemoryStore,
  recallStartupIncidents,
  captureInvestigationMemory,
  readIncidentDisposition,
} from '../packages/engine/src/index.ts';
const inputPath = process.env.HORUS_RECALL_HISTORY;
if (!inputPath)
  throw new Error(
    'Set HORUS_RECALL_HISTORY to the private history export; this script never opens saved user storage.',
  );
const source = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(source.reports) || source.reports.length > 1000)
  throw new Error('Expected at most 1000 exported reports');
const reports = source.reports
  .filter((r) => r && Array.isArray(r.report?.hypotheses))
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
assert(reports.length, 'No readable reports');
for (const row of reports) {
  assert(row.report.input?.repo?.trim(), `Missing repository: ${row.id}`);
  assert(Number.isFinite(Date.parse(row.createdAt)), `Invalid report time: ${row.id}`);
}
const capturedIds = new Map<string, string>();
const dir = await mkdtemp(join(tmpdir(), 'horus-recall-replay-'));
const h = await createLocalDb({ path: join(dir, 'db') });
const store = createLocalMemoryStore(h.db);
const results = [];
try {
  for (const row of reports) {
    const now = new Date(row.createdAt);
    const input = row.report.input;
    const start = performance.now();
    const matches = await recallStartupIncidents(store, input, { now });
    results.push({
      id: row.id,
      at: row.createdAt,
      hint: row.title,
      elapsedMs: performance.now() - start,
      matches: await Promise.all(
        matches.map(async (m) => {
          const item = await store.get(m.memoryId);
          return {
            incidentId: m.incidentId,
            hint: item?.payload?.hint,
            reportIds: item?.payload?.investigationIds ?? [m.incidentId],
            matchingFields: m.matchingFields,
            relevance: m.relevance,
          };
        }),
      ),
    });
    const captured = await captureInvestigationMemory(store, row.id, row.report, now, {
      actor: { kind: 'system' },
      note: 'chronological replay in isolated storage',
    });
    if (captured.memoryId) capturedIds.set(row.id, captured.memoryId);
    if (captured.action === 'created')
      await h.db
        .update(memoryItem)
        .set({ createdAt: now })
        .where(eq(memoryItem.id, captured.memoryId!));
  }
  // Relevance labels are scored before pilot annotations, independently of accuracy feedback.
  const quality = process.env.HORUS_RECALL_LABELS
    ? scoreRecallQuality(reports, results, JSON.parse(await readFile(process.env.HORUS_RECALL_LABELS, 'utf8')))
    : null;
  // Pilot annotations are added only after chronological replay: never leak future reviews.
  let pilotChecks = 0;
  if (process.env.HORUS_RECALL_PILOT) {
    const pilot = JSON.parse(await readFile(process.env.HORUS_RECALL_PILOT, 'utf8'));
    assert(Array.isArray(pilot.cases) && pilot.cases.length <= 100);
    const annotated = new Set<string>();
    for (const entry of pilot.cases) {
      const outcome = readIncidentDisposition(entry.outcome);
      assert(outcome && outcome.certainty === 'inferred');
      const id = capturedIds.get(outcome.sourceInvestigation);
      assert(id, `Pilot source report unavailable: ${outcome.sourceInvestigation}`);
      assert(!annotated.has(id), 'Distinct pilot cases consolidated into one memory');
      annotated.add(id);
      const item = await store.get(id);
      assert(item);
      await store.update(
        id,
        {
          claim: `Inferred: ${outcome.actualCause}`,
          payload: { ...item.payload, hint: entry.hint, outcome },
        },
        { audit: { actor: { kind: 'system' }, note: pilot.reviewer } },
      );
    }
    for (const entry of pilot.cases) {
      const row = reports.find((r) => r.id === entry.outcome.sourceInvestigation);
      const matches = await recallStartupIncidents(store, {
        ...row.report.input,
        hint: entry.hint,
        environment: entry.outcome.applicability.environment,
        incident: entry.outcome.applicability,
      });
      const own = matches.find((m) => m.memoryId === capturedIds.get(row.id));
      assert(own, `Pilot annotation not recalled: ${entry.id}`);
      assert(
        !matches.some((m) => annotated.has(m.memoryId) && m.memoryId !== own.memoryId),
        `Different pilot family recalled: ${entry.id}`,
      );
      assert.equal(own.outcome?.certainty, 'inferred');
      assert.deepEqual(own.outcome?.checks, entry.outcome.checks);
      pilotChecks++;
    }
  }
  if (process.env.HORUS_RECALL_EVIDENCE_OUT)
    await writeFile(
      process.env.HORUS_RECALL_EVIDENCE_OUT,
      JSON.stringify(results, null, 2),
      { mode: 0o600 },
    );
  console.log(
    JSON.stringify(
      {
        reports: reports.length,
        pilotChecks,
        pilotScope:
          'Annotation retrieval smoke only; not held-out relevance or human attestation',
        excluded: source.reports.length - reports.length,
        matched: results.filter((r) => r.matches.length).length,
        quality,
        scope: 'Chronological replay; match count is not an accuracy score',
        p95RecallMs: results.map((r) => r.elapsedMs).sort((a, b) => a - b)[
          Math.max(0, Math.ceil(results.length * 0.95) - 1)
        ],
      },
      null,
      2,
    ),
  );
  if (quality) assert(quality.passed, 'Labeled recall quality missed the 90% top-three / 95% no-match targets');
} finally {
  await h.sql.end();
  await rm(dir, { recursive: true, force: true });
}
