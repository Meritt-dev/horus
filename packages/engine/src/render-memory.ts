/**
 * Renderers for `horus memory show <scope>` (HOR). Markdown + machine JSON, modeled on
 * render-architecture.ts / render-onboard.ts. Pure — no I/O.
 */

import type { AsyncBoundary } from './architecture.js';
import type { MemoryView } from './memory-view.js';

/** Render a queue's producers/workers with files so same-named ones don't read as `x -> x`. */
function fmtEndpoints(endpoints: AsyncBoundary['producers']): string {
  if (endpoints.length === 0) return '(unknown)';
  return endpoints
    .map((e) => (e.file ? `${e.symbol} (${e.file.split('/').pop()})` : e.symbol))
    .join(', ');
}

export function renderMemoryView(v: MemoryView): string {
  const lines: string[] = [];

  lines.push(`# Memory: ${v.scope}`);
  lines.push('');
  lines.push(`Project: ${v.project} · area: ${v.area || '(repo)'}`);
  lines.push('');
  lines.push(v.summary);
  lines.push('');
  if (!v.sourceAvailable) {
    lines.push('> ⚠ Source-intelligence host unreachable — run `horus init`.');
    lines.push(
      '> Showing **incident memory only**; code structure (owned areas, runtime paths, external systems) is unavailable, not absent.',
    );
    lines.push('');
  }

  // --- Owned areas ------------------------------------------------------
  lines.push('## Owned areas');
  lines.push('');
  if (v.ownedAreas.subsystems.length === 0) {
    lines.push(
      v.sourceAvailable
        ? 'No scope-matched subsystems.'
        : '_Unavailable — source host unreachable (run `horus init`)._',
    );
  } else {
    for (const s of v.ownedAreas.subsystems) {
      const tag = s.testy ? ' (tests)' : '';
      lines.push(`- ${s.name} — ${s.members} members${tag}`);
    }
  }
  lines.push('');
  if (v.ownedAreas.seedSymbol != null) {
    lines.push(`Seed symbol: ${v.ownedAreas.seedSymbol.name} (${v.ownedAreas.seedSymbol.file})`);
  }
  const own = v.ownedAreas.ownership;
  if (own != null && own.file != null) {
    const pct = (own.confidence * 100).toFixed(0);
    lines.push(`Likely maintainer: ${own.likelyMaintainer ?? '(unknown)'} (${pct}% confidence)`);
    if (own.mostActiveRecent != null) {
      lines.push(`Most active recently: ${own.mostActiveRecent}`);
    }
    lines.push('_Probabilistic — git commit history only, not an org chart._');
  } else {
    lines.push(
      v.sourceAvailable
        ? '_Ownership unavailable — no source symbol matched the scope._'
        : '_Ownership unavailable — source host unreachable._',
    );
  }
  lines.push('');

  // --- Runtime paths & queues -------------------------------------------
  lines.push('## Runtime paths & queues');
  lines.push('');
  if (v.runtimePaths.asyncBoundaries.length === 0) {
    lines.push(
      v.sourceAvailable
        ? 'No scope-matched async boundaries.'
        : '_Unavailable — source host unreachable._',
    );
  } else {
    for (const b of v.runtimePaths.asyncBoundaries) {
      lines.push(`- ${b.queueName}: ${fmtEndpoints(b.producers)} -> ${fmtEndpoints(b.workers)}`);
    }
  }
  lines.push('');
  if (v.runtimePaths.keyFlows.length > 0) {
    lines.push('Key flows:');
    for (const f of v.runtimePaths.keyFlows) lines.push(`- ${f}`);
    lines.push('');
  }
  if (v.runtimePaths.queuesSeenInIncidents.length > 0) {
    lines.push('Queues seen in past incidents:');
    for (const q of v.runtimePaths.queuesSeenInIncidents) lines.push(`- ${q}`);
    lines.push('');
  }

  // --- External systems --------------------------------------------------
  lines.push('## External systems');
  lines.push('');
  if (v.externalSystems.length === 0) {
    lines.push(
      v.sourceAvailable
        ? 'No scope-matched external systems.'
        : '_Unavailable — source host unreachable._',
    );
  } else {
    for (const e of v.externalSystems) lines.push(`- ${e.name} (${e.files} files)`);
  }
  lines.push('');

  // --- Past investigations ----------------------------------------------
  lines.push('## Past investigations');
  lines.push('');
  if (v.pastInvestigations.length === 0) {
    lines.push('_none on record_');
  } else {
    for (const p of v.pastInvestigations) {
      const date = p.date ?? '(no date)';
      lines.push(`- ${date} — ${p.title}`);
      if (p.suspectedCause != null) {
        lines.push(
          `  - suspected cause: ${p.suspectedCause.title} ` +
            `[${p.suspectedCause.category}, ${p.suspectedCause.band}]`,
        );
      }
      const conf = p.confidence != null ? `${(p.confidence * 100).toFixed(0)}%` : 'n/a';
      lines.push(`  - confidence: ${conf}; confirmed (proxy): ${p.confirmedProxy ? 'yes' : 'no'}`);
      if (p.sources.length > 0) {
        lines.push(`  - evidence channels: ${p.sources.join(', ')}`);
      }
    }
  }
  lines.push('');
  if (v.recurringPatterns.length > 0) {
    lines.push('Recurring patterns (same incident shape, repeated):');
    for (const r of v.recurringPatterns) {
      lines.push(`- ${r.signature} ×${r.count}`);
    }
    lines.push('');
  }

  // --- Useful evidence sources ------------------------------------------
  lines.push('## Useful evidence sources');
  lines.push('');
  if (v.evidenceSources.channels.length > 0) {
    lines.push('Channels that have produced evidence for this area before:');
    for (const c of v.evidenceSources.channels) lines.push(`- ${c}`);
  } else {
    lines.push('No incident-evidence channels recorded for this area yet.');
  }
  lines.push('');
  lines.push('Always available:');
  for (const a of v.evidenceSources.alwaysAvailable) lines.push(`- ${a}`);
  lines.push('');

  // --- Weak spots --------------------------------------------------------
  lines.push('## Weak spots');
  lines.push('');
  lines.push(
    `- Unreferenced symbols (repo-wide): ${v.weakSpots.fragile.deadCode}`,
  );
  lines.push(
    `- High-coupling pairs, co-changes ≥ 3 (repo-wide): ${v.weakSpots.fragile.highCouplingPairs}`,
  );
  if (v.weakSpots.testLightSubsystems.length > 0) {
    lines.push(`- Test/example-heavy subsystems: ${v.weakSpots.testLightSubsystems.join(', ')}`);
  }
  if (v.weakSpots.lowPriorEvidence) {
    lines.push(`- Low prior evidence: ${v.weakSpots.lowPriorEvidenceReason}`);
  }
  lines.push('');

  lines.push(
    '_Generated from live code structure + git + deterministic incident memory — no AI. ' +
      'Past incidents are context only; "confirmed" is a display proxy, not a stored fact._',
  );

  return lines.join('\n');
}

export function memoryViewToJSON(v: MemoryView): string {
  return JSON.stringify(v, null, 2);
}
