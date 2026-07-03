/**
 * Human-facing renderers for a ChangeImpactReport. Pure, deterministic, no I/O.
 */

import type { Symbol } from '@horus/core';
import type { ChangeImpactReport } from './changes.js';

const LIST_CAP = 15;

function symbolLine(s: Symbol): string {
  return `${s.name} (${s.filePath})`;
}

function renderSymbolList(label: string, symbols: Symbol[]): string[] {
  if (symbols.length === 0) return [];
  const lines: string[] = [`### ${label}`];
  const shown = symbols.slice(0, LIST_CAP);
  for (const s of shown) {
    lines.push(`- ${symbolLine(s)}`);
  }
  const remaining = symbols.length - shown.length;
  if (remaining > 0) {
    lines.push(`  +${remaining} more`);
  }
  return lines;
}

/** Sectioned text report for terminal output. */
export function renderChangeImpact(r: ChangeImpactReport): string {
  const lines: string[] = [];

  lines.push(`# Change Impact: ${r.base}..${r.compare}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(r.summary);
  lines.push('');

  const addedLines = renderSymbolList('Added', r.added);
  if (addedLines.length > 0) {
    lines.push(...addedLines);
    lines.push('');
  }

  const modifiedAfters = r.modified.map((m) => m.after);
  const modifiedLines = renderSymbolList('Modified', modifiedAfters);
  if (modifiedLines.length > 0) {
    lines.push(...modifiedLines);
    lines.push('');
  }

  const removedLines = renderSymbolList('Removed', r.removed);
  if (removedLines.length > 0) {
    lines.push(...removedLines);
    lines.push('');
  }

  lines.push('## Affected flows');
  if (r.affectedFlows.length === 0) {
    lines.push('none');
  } else {
    for (const f of r.affectedFlows) {
      lines.push(`- ${f.flowName} — changed: ${f.changedSymbols.join(', ')}`);
    }
  }

  return lines.join('\n');
}

// Caps for the compact (default) JSON projection. Dogfood: the raw report reached
// multiple MB on fixture-heavy repos (full Symbol arrays for added/removed/modified),
// which agents cannot safely ingest. Compact keeps citable identity (name + filePath),
// drops everything else, and marks what was omitted.
const JSON_SYMBOL_CAP = 25;
const JSON_FLOW_CAP = 20;
const JSON_FLOW_SYMBOL_CAP = 10;

/**
 * Compact object projection of a ChangeImpactReport — shared by `changes --json`
 * and the timeline/what-changed serializers that embed a change impact. Always
 * carries full `counts`; sets `truncated`/`truncatedCount` when lists were capped.
 */
export function changeImpactToCompactObject(r: ChangeImpactReport): Record<string, unknown> {
  const sym = (s: Symbol): { name: string; filePath: string } => ({
    name: s.name,
    filePath: s.filePath,
  });
  const added = r.added.slice(0, JSON_SYMBOL_CAP).map(sym);
  const removed = r.removed.slice(0, JSON_SYMBOL_CAP).map(sym);
  const modified = r.modified.slice(0, JSON_SYMBOL_CAP).map((m) => sym(m.after));
  const affectedFlows = r.affectedFlows.slice(0, JSON_FLOW_CAP).map((f) => ({
    flowName: f.flowName,
    changedSymbols: f.changedSymbols.slice(0, JSON_FLOW_SYMBOL_CAP),
  }));
  const truncatedCount =
    (r.added.length - added.length) +
    (r.removed.length - removed.length) +
    (r.modified.length - modified.length) +
    (r.affectedFlows.length - affectedFlows.length);
  return {
    base: r.base,
    compare: r.compare,
    summary: r.summary,
    counts: {
      added: r.added.length,
      removed: r.removed.length,
      modified: r.modified.length,
      affectedFlows: r.affectedFlows.length,
    },
    added,
    removed,
    modified,
    affectedFlows,
    ...(truncatedCount > 0
      ? { truncated: true, truncatedCount, hint: 're-run with --full for the complete structure' }
      : {}),
  };
}

/** Stable JSON serialization — compact by default; `full` restores the raw report. */
export function changeImpactToJSON(r: ChangeImpactReport, opts?: { full?: boolean }): string {
  if (opts?.full) return JSON.stringify(r, null, 2);
  return JSON.stringify(changeImpactToCompactObject(r), null, 2);
}
