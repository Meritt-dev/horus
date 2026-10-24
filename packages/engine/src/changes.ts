/**
 * HOR-8 change-impact primitive.
 * Computes which execution flows are affected by a set of code changes.
 */

import type { Symbol, Flow, ChangeSet } from '@horus/core';
import { isProductPath } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';

export interface AffectedFlow {
  flowId: string;
  flowName: string;
  changedSymbols: string[];
}

/**
 * Derived/synthetic graph nodes (communities, processes, folder rollups, or anything
 * with no real file) must never be reported as structural changes — `changes HEAD HEAD`
 * was reporting fake diffs made entirely of them.
 */
function isDerivedNode(s: Symbol): boolean {
  return (
    /^(community|process|folder):/.test(s.id) ||
    s.filePath == null ||
    s.filePath.trim() === ''
  );
}

/** Is this flow rooted in a test/fixture file (its entry step)? Empty flows count as product. */
function flowIsTestScoped(f: Flow): boolean {
  const entry = f.steps[0]?.filePath;
  return entry !== undefined && entry !== '' && !isProductPath(entry);
}

export interface ChangeImpactReport {
  base: string;
  compare: string;
  added: Symbol[];
  removed: Symbol[];
  modified: { before: Symbol; after: Symbol }[];
  affectedFlows: AffectedFlow[];
  summary: string;
  /** Saved investigations whose code footprint this change touches (context only, never a verdict). */
  relatedIncidents?: RelatedIncident[];
}

/** A past investigation whose top code seeds include a symbol this change modifies or removes. */
export interface RelatedIncident {
  investigationId: string;
  createdAt: string;
  hint: string;
  topCause: string;
  matchedSymbols: string[];
}

/** Only causes Horus itself rated at least `likely`: their code links were ~2x as reliable as the rest. */
const RELATED_INCIDENT_BANDS = new Set(['highly-likely', 'likely']);
const RELATED_INCIDENT_LIMIT = 5;

/**
 * Past incidents whose footprint (top-3 method/function seeds) this change touches, newest first.
 * Validated on 409 commits / 200 investigations: such links point at the code later changed for the
 * incident about twice as often as chance, but do NOT predict the next incident — so this is review
 * context ("code behind incident X"), never a risk score or merge gate.
 */
export function incidentsTouchingChanges(
  r: Pick<ChangeImpactReport, 'modified' | 'removed'>,
  saved: ReadonlyArray<{ id: string; createdAt: Date; report: unknown }>,
): RelatedIncident[] {
  const changed = new Set([
    ...r.modified.map((m) => m.before.id),
    ...r.modified.map((m) => m.after.id),
    ...r.removed.map((s) => s.id),
  ]);
  const out: RelatedIncident[] = [];
  for (const row of [...saved].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )) {
    const report = row.report as {
      input?: { hint?: unknown };
      seeds?: Array<{ id?: unknown }>;
      suspectedCauses?: Array<{ title?: unknown; band?: unknown }>;
    } | null;
    const cause = report?.suspectedCauses?.[0];
    if (!cause || !RELATED_INCIDENT_BANDS.has(String(cause.band))) continue;
    const footprint = (report?.seeds ?? [])
      .slice(0, 3)
      .map((s) => String(s.id ?? ''))
      .filter((id) => /^(method|function):/.test(id));
    const matched = footprint.filter((id) => changed.has(id));
    if (!matched.length) continue;
    const hint = String(report?.input?.hint ?? '');
    // Re-runs of the same question add nothing; the newest one wins (rows are newest first).
    if (out.some((o) => o.hint.trim().toLowerCase() === hint.trim().toLowerCase()))
      continue;
    out.push({
      investigationId: row.id,
      createdAt: row.createdAt.toISOString(),
      hint,
      topCause: String(cause.title ?? ''),
      matchedSymbols: matched,
    });
    if (out.length === RELATED_INCIDENT_LIMIT) break;
  }
  return out;
}

export async function changeImpact(
  input: { base: string; compare?: string },
  deps: { code: CodeProvider },
): Promise<ChangeImpactReport> {
  const compare = input.compare ?? 'HEAD';

  // Identical refs cannot differ — short-circuit before the source index gets a
  // chance to fabricate structural changes from derived nodes (`changes HEAD HEAD`).
  if (input.base === compare) {
    return {
      base: input.base,
      compare,
      added: [],
      removed: [],
      modified: [],
      affectedFlows: [],
      summary: `base and compare are the same ref (${compare}) — no changes.`,
    };
  }

  const raw: ChangeSet = await deps.code.detectChanges({ base: input.base, compare });
  // Defensive: derived/synthetic nodes are index artifacts, not code changes.
  const changes: ChangeSet = {
    added: raw.added.filter((s) => !isDerivedNode(s)),
    removed: raw.removed.filter((s) => !isDerivedNode(s)),
    modified: raw.modified.filter(
      (m) => !isDerivedNode(m.after) && !isDerivedNode(m.before),
    ),
  };

  // All "present-day" changed symbols — added + modified afters
  const presentSymbols: Symbol[] = [
    ...changes.added,
    ...changes.modified.map((m) => m.after),
  ];

  // Cap at 25 to bound source-intelligence calls; skip file-label ids for flow mapping
  const capped = presentSymbols.filter((s) => !s.id.startsWith('file:')).slice(0, 25);

  // For each changed symbol, fetch flows (treat errors as no flows)
  const flowsPerSymbol: Flow[][] = await Promise.all(
    capped.map(async (s) => {
      try {
        return await deps.code.flowsFor(s.id);
      } catch {
        return [];
      }
    }),
  );

  // Accumulate into a Map<flowId, { flowName, changedSymbols: Set<string> }>
  const flowMap = new Map<string, { flowName: string; changedSymbols: Set<string> }>();

  for (let i = 0; i < capped.length; i++) {
    const sym = capped[i];
    if (sym === undefined) continue;
    const flows = flowsPerSymbol[i] ?? [];
    const symIsTestScoped = !isProductPath(sym.filePath);
    for (const flow of flows) {
      // Test-derived flows only count when the changed symbol itself is test-scoped —
      // a product change "affecting" 40 test flows is noise, not blast radius.
      if (flowIsTestScoped(flow) && !symIsTestScoped) continue;
      const existing = flowMap.get(flow.id);
      if (existing !== undefined) {
        existing.changedSymbols.add(sym.name);
      } else {
        flowMap.set(flow.id, {
          flowName: flow.name,
          changedSymbols: new Set([sym.name]),
        });
      }
    }
  }

  // Rank by how much of the change lands in the flow (most changed symbols first),
  // name as the deterministic tie-break.
  const affectedFlows: AffectedFlow[] = [...flowMap]
    .map(([flowId, v]) => ({
      flowId,
      flowName: v.flowName,
      changedSymbols: [...v.changedSymbols],
    }))
    .sort(
      (a, b) =>
        b.changedSymbols.length - a.changedSymbols.length ||
        a.flowName.localeCompare(b.flowName),
    );

  const summary =
    changes.added.length +
    ' added, ' +
    changes.modified.length +
    ' modified, ' +
    changes.removed.length +
    ' removed between ' +
    input.base +
    '..' +
    compare +
    '; ' +
    affectedFlows.length +
    ' execution flow(s) affected.';

  return {
    base: input.base,
    compare,
    added: changes.added,
    removed: changes.removed,
    modified: changes.modified,
    affectedFlows,
    summary,
  };
}
