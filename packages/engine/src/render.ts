/**
 * Human-facing renderers for an InvestigationReport. Pure, deterministic, no I/O.
 */

import type { Evidence } from '@horus/core';
import type { InvestigationReport, RouteStep } from './types.js';
import { formatRouteStep } from './router.js';

/** Short, citable evidence id (first 8 chars). */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * HOR-386 — the human form of the router's `RouteStep[]`. The router (router.ts) is the
 * single decision point; this only RENDERS its output, so the same `report.nextSteps`
 * drives `--json` and the MCP surface identically. `bullet` differs only by section style.
 */
function renderRouteSteps(steps: RouteStep[] | undefined, bullet: string): string[] {
  if (!steps || steps.length === 0) return [];
  return steps.map((s) => `${bullet} ${formatRouteStep(s)}`);
}

/**
 * Display name for a symbol (HOR-214). Qualifies class members with their owning class
 * so caller/blast-radius lists don't render bare `constructor, constructor, constructor`
 * — instead `GaiaController.constructor`, `SaleService.constructor`. Falls back to the
 * bare name when no class context is available, and avoids double-qualifying a name that
 * already contains a dot.
 */
export function symbolDisplayName(sym: { name: string; className?: string }): string {
  if (sym.className && sym.className.length > 0 && !sym.name.includes('.')) {
    return `${sym.className}.${sym.name}`;
  }
  return sym.name;
}

/**
 * Format a symbol location (HOR-211). Renders `path:start-end` when an end line is
 * known, `path:start` for a single line, and bare `path` when there's no line range
 * (e.g. File nodes) — never the meaningless `path:0`.
 */
export function formatSymbolLocation(
  filePath: string,
  startLine?: number,
  endLine?: number,
): string {
  if (startLine === undefined || startLine <= 0) return filePath;
  if (endLine !== undefined && endLine > startLine) return `${filePath}:${startLine}-${endLine}`;
  return `${filePath}:${startLine}`;
}

// ── Queue runtime rendering helpers (HOR-13) ─────────────────────────────────

type QueuePayload = {
  waiting?: number;
  active?: number;
  failed?: number;
  delayed?: number;
  isPaused?: boolean;
};

/** True for queue-state evidence that represents a "summary" signal (raw counts). */
function isQueueSummary(e: Evidence): boolean {
  const p = (e.payload ?? {}) as QueuePayload;
  return 'isPaused' in p;
}

/** Format summary counts as a compact inline string. */
function fmtQueueCounts(p: QueuePayload): string {
  return [
    `${p.waiting ?? 0} waiting`,
    `${p.active ?? 0} active`,
    `${p.failed ?? 0} failed`,
    `${p.delayed ?? 0} delayed`,
  ].join(' · ');
}

/** Remove the "{queueName}: " prefix from a signal title for grouped display. */
function stripQueueName(title: string, name: string): string {
  const pfx = `${name}: `;
  return title.startsWith(pfx) ? title.slice(pfx.length) : title;
}

/**
 * Group queue-state evidence by queue name, with anomaly signals first and
 * the summary signal last within each group.
 */
export function groupQueueEvidence(evidence: Evidence[]): Map<string, Evidence[]> {
  const map = new Map<string, Evidence[]>();
  for (const e of evidence) {
    if (e.source !== 'queue' || e.kind !== 'queue-state') continue;
    const name = (e.links as { queueName?: string } | undefined)?.queueName ?? 'unknown';
    const group = map.get(name) ?? [];
    group.push(e);
    map.set(name, group);
  }
  for (const [, evs] of map) {
    evs.sort((a, b) => {
      const as_ = isQueueSummary(a);
      const bs_ = isQueueSummary(b);
      if (as_ && !bs_) return 1;
      if (!as_ && bs_) return -1;
      return b.relevance - a.relevance;
    });
  }
  return map;
}

/** Set of IDs for all queue-state evidence in the report. */
function queueEvidenceIds(evidence: Evidence[]): Set<string> {
  const ids = new Set<string>();
  for (const e of evidence) {
    if (e.source === 'queue' && e.kind === 'queue-state') ids.add(e.id);
  }
  return ids;
}

/** Confidence at or above this value suppresses the "why not higher" section. */
export const CONFIDENCE_EXPLAIN_THRESHOLD = 0.80;

/**
 * Returns a list of human-readable reasons why confidence is below
 * CONFIDENCE_EXPLAIN_THRESHOLD, or null when confidence meets the bar.
 * Draws from gapAnalysis, sourceStatus, and correlation.missing — no duplication
 * of the full gap detail section, just the top-priority signal per category.
 */
export function explainLowConfidence(r: InvestigationReport): string[] | null {
  if (r.confidence >= CONFIDENCE_EXPLAIN_THRESHOLD) return null;

  const reasons: string[] = [];

  // Missing runtime sources
  if (r.sourceStatus) {
    const notConfigured = r.sourceStatus.sources
      .filter((s) => s.status === 'not-configured')
      .map((s) => s.source);
    if (notConfigured.length > 0) {
      reasons.push(`no runtime data — ${notConfigured.join(', ')} not configured`);
    }
  }

  // Top gap by confidence impact
  if (r.gapAnalysis.gaps.length > 0) {
    const top = [...r.gapAnalysis.gaps].sort((a, b) => b.confidenceImpact - a.confidenceImpact)[0]!;
    reasons.push(
      `top gap: ${top.dimension} (−${top.confidenceImpact.toFixed(2)} conf) — ${top.why}`,
    );
  }

  // First missing-evidence note from correlation
  if (r.correlation.missing.length > 0) {
    reasons.push(`missing evidence: ${r.correlation.missing[0]!.note}`);
  }

  // Confidence ceiling
  if (r.gapAnalysis.confidenceCeiling < 1.0) {
    reasons.push(
      `confidence ceiling: ${r.gapAnalysis.confidenceCeiling} — filling gaps above would raise it`,
    );
  }

  return reasons.length > 0 ? reasons : null;
}

/**
 * Returns a short caveat string when no runtime source contributed evidence,
 * listing which dimensions were not configured. Returns null when runtime data
 * is present or when sourceStatus is absent (pre-HOR-70 reports).
 */
export function runtimeSourceCaveat(r: InvestigationReport): string | null {
  const status = r.sourceStatus;
  if (!status) return null;
  const contributed = status.sources.some((s) => s.status === 'contributed');
  if (contributed) return null;
  // Configured-but-unavailable (missing secret/URL env) is a different truth from
  // not-configured — name it and point at the diagnosis, not at connector setup.
  const unavailable = status.sources
    .filter((s) => s.status === 'unavailable')
    .map((s) => s.source);
  if (unavailable.length > 0) {
    return `${unavailable.join(', ')} configured but unavailable in this run (missing credentials or URL) — see \`horus doctor\``;
  }
  const notConfigured = status.sources
    .filter((s) => s.status === 'not-configured')
    .map((s) => s.source);
  if (notConfigured.length === 0) return null;
  // Config drives behavior: state the evidence basis; never pitch connector setup here.
  return `no runtime evidence — ${notConfigured.join(', ')} not in this config; findings rest on code, git, and topology`;
}

/** A clean, sectioned text report suitable for a terminal or a log. */
export function renderReport(r: InvestigationReport): string {
  const lines: string[] = [];

  lines.push(`# Investigation ${r.id}`);
  lines.push(`Hint: ${r.input.hint}`);
  if (r.input.repo) lines.push(`Repo: ${r.input.repo}`);
  if (r.input.service) lines.push(`Service: ${r.input.service}`);
  if (r.input.since) lines.push(`Since: ${r.input.since}`);
  // Gap #5: a behavioral "how does X work" report renders the flow walkthrough and skips the
  // incident pipeline entirely (no confidence/causes/hypotheses/similar-incidents — not a fault hunt).
  if (r.behavioral) {
    lines.push('');
    lines.push('## Summary');
    lines.push(r.summary);
    lines.push('');
    lines.push(`## Flow${r.behavioral.entry ? ` — ${r.behavioral.entry.name}` : ''}`);
    if (r.behavioral.steps.length === 0) {
      lines.push('(no execution flow could be reconstructed from the source graph)');
    } else {
      r.behavioral.steps.slice(0, 20).forEach((s, i) => {
        lines.push(`  ${i + 1}. ${s.name} (${formatSymbolLocation(s.filePath, s.startLine, s.endLine)})`);
      });
      if (r.behavioral.steps.length > 20) lines.push(`  … and ${r.behavioral.steps.length - 20} more`);
    }
    if (r.behavioral.externalCalls.length > 0 || r.behavioral.persistence.length > 0) lines.push('');
    if (r.behavioral.externalCalls.length > 0) lines.push(`External calls: ${r.behavioral.externalCalls.join(', ')}`);
    if (r.behavioral.persistence.length > 0) lines.push(`Persistence: ${r.behavioral.persistence.join(', ')}`);
    lines.push('');
    if (r.nextActions.length > 0) {
      lines.push('## Next actions');
      for (const a of r.nextActions) lines.push(`- ${a}`);
      lines.push('');
    }
    const behavioralSteps = renderRouteSteps(r.nextSteps, '-');
    if (behavioralSteps.length > 0) {
      lines.push('## Suggested next');
      lines.push(...behavioralSteps);
      lines.push('');
    }
    lines.push(
      '— Behavioral walkthrough, not a fault hunt. Phrase it as a symptom (e.g. "X failing") for an incident investigation.',
    );
    return lines.join('\n');
  }
  lines.push(`Confidence: ${r.confidence.toFixed(2)}`);
  const caveat = runtimeSourceCaveat(r);
  if (caveat) lines.push(`  ↳ ${caveat}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(r.summary);
  lines.push('');

  const explainLines = explainLowConfidence(r);
  if (explainLines) {
    lines.push('## Why confidence is not higher');
    for (const reason of explainLines) {
      lines.push(`  - ${reason}`);
    }
    lines.push('');
  }

  lines.push('## Similar past incidents');
  if (r.similarIncidents.length === 0) {
    lines.push('(none on record)');
  } else {
    for (const s of r.similarIncidents) {
      lines.push(
        `- ${s.title} (overlap ${(s.overlap * 100).toFixed(0)}%) — shared: ${s.sharedTags.join(', ')}`,
      );
      if (s.summary) {
        const truncated =
          s.summary.length > 80 ? s.summary.slice(0, 77) + '...' : s.summary;
        lines.push(`    ${truncated}`);
      }
    }
    lines.push(
      'Context only — past incidents inform, but never override, the current evidence.',
    );
  }
  lines.push('');

  lines.push('## Seed(s)');
  if (r.seeds.length === 0) {
    lines.push('(none)');
  } else {
    for (const s of r.seeds) {
      const sig = s.signature ? ` — ${s.signature}` : '';
      lines.push(`- ${s.name} (${formatSymbolLocation(s.filePath, s.startLine, s.endLine)})${sig}`);
    }
  }
  lines.push('');

  lines.push('## Findings');
  if (r.findings.length === 0) {
    lines.push('(none)');
  } else {
    for (const f of r.findings) {
      lines.push(`- [${f.confidence.toFixed(2)}] ${f.title}`);
      if (f.detail) lines.push(`    ${f.detail}`);
      if (f.evidenceIds.length > 0) {
        lines.push(`    evidence: ${f.evidenceIds.map(shortId).join(', ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## Timeline');
  if (r.timeline.events.length === 0) {
    lines.push('(none)');
  } else {
    for (const ev of r.timeline.events) {
      const at = ev.at ?? 'structural';
      lines.push(`  ${ev.order}. [${at}] ${ev.title}`);
    }
  }
  lines.push('');

  lines.push('## Boundary crossings');
  if (r.timeline.boundaryCrossings.length === 0) {
    lines.push('(none)');
  } else {
    for (const bc of r.timeline.boundaryCrossings) {
      const producer = bc.producer ?? '?';
      const worker = bc.worker ?? '?';
      lines.push(`  ${bc.queueName}: ${producer} -> ${worker}`);
    }
  }
  lines.push('');

  lines.push('## Correlation');

  lines.push('### Cause chains');
  if (r.correlation.chains.length === 0) {
    lines.push('  (none)');
  } else {
    for (const chain of r.correlation.chains) {
      lines.push(`  [${chain.strength.toFixed(2)}] ${chain.title} — ${chain.rationale}`);
    }
  }

  lines.push('### Related evidence groups');
  if (r.correlation.groups.length === 0) {
    lines.push('  (none)');
  } else {
    for (const group of r.correlation.groups) {
      lines.push(`  ${group.reason} (${group.evidenceIds.length} items)`);
    }
  }

  lines.push('### Missing evidence');
  if (r.correlation.missing.length === 0) {
    lines.push('  none');
  } else {
    for (const m of r.correlation.missing) {
      lines.push(`  - ${m.note}`);
    }
  }
  lines.push('');

  const queueIds = queueEvidenceIds(r.evidence);

  lines.push('## Suspected causes (ranked)');
  if (r.suspectedCauses.length === 0) {
    lines.push('(none)');
  } else {
    r.suspectedCauses.forEach((c, i) => {
      const queueTag = c.sourceEvidenceIds.some((id) => queueIds.has(id)) ? ' [↑ queue]' : '';
      lines.push(`${i + 1}. [${c.finalScore.toFixed(2)} / ${c.band}] ${c.title}${queueTag}`);
      if (c.sourceEvidenceIds.length > 0) {
        lines.push(`    evidence: ${c.sourceEvidenceIds.map(shortId).join(', ')}`);
      }
    });
  }
  lines.push('');

  lines.push('## Hypotheses');
  const allUnconfirmed =
    r.hypotheses.length > 0 && r.hypotheses.every((h) => h.verdict === 'unconfirmed');
  if (allUnconfirmed) {
    lines.push(
      '_All hypotheses below are unconfirmed placeholders — runtime evidence is required to validate them._',
    );
  }
  if (r.hypotheses.length === 0) {
    lines.push('(none)');
  } else {
    for (const h of r.hypotheses) {
      lines.push(
        `  [${h.verdict}] [${h.confidence.toFixed(2)} (was ${h.priorConfidence.toFixed(2)})] ${h.category}: ${h.statement}`,
      );
      lines.push(`      ${h.rationale}`);
      if (h.missingEvidence.length > 0) {
        lines.push(`      · missing: ${h.missingEvidence.join('; ')}`);
      }
    }
  }
  lines.push('');

  if (r.causeChains !== undefined && r.causeChains.length > 0) {
    lines.push('## Cause chains');
    for (const chain of r.causeChains) {
      lines.push(`  [${chain.confidence.toFixed(2)}] ${chain.category}: ${chain.summary}`);
      for (let i = 0; i < chain.steps.length; i++) {
        const step = chain.steps[i]!;
        const prefix = i === chain.steps.length - 1 ? '    └─' : '    ├─';
        const evCite =
          step.evidenceIds.length > 0
            ? ` (evidence: ${step.evidenceIds.map(shortId).join(', ')})`
            : '';
        lines.push(`${prefix} [${step.role}] ${step.label}${evCite}`);
      }
    }
    lines.push('');
  }

  lines.push('## Evidence gaps (what we don\'t know)');
  if (r.gapAnalysis.gaps.length === 0) {
    lines.push('(no major evidence gaps)');
  } else {
    for (const gap of r.gapAnalysis.gaps) {
      lines.push(
        `  - ${gap.dimension}: ${gap.why}  → next: ${gap.nextSource}  (−${gap.confidenceImpact.toFixed(2)} conf)`,
      );
    }
    lines.push('');
    lines.push('Blind spots:');
    for (const bs of r.gapAnalysis.blindSpots) {
      lines.push(`  - ${bs}`);
    }
    lines.push('');
    lines.push(
      `Confidence ceiling: ${r.gapAnalysis.confidenceCeiling} (current confidence is capped at this until the gaps are filled).`,
    );
  }
  lines.push('');

  lines.push('## Evidence');
  if (r.evidence.length === 0) {
    lines.push('(none)');
  } else {
    for (const e of r.evidence) {
      lines.push(`- ${shortId(e.id)} [${e.source}/${e.kind}] ${e.title}`);
    }
  }
  lines.push('');

  const queueGroups = groupQueueEvidence(r.evidence);
  const queueGap = r.gapAnalysis.gaps.find((g) => g.dimension === 'queue runtime state');
  if (queueGroups.size > 0 || queueGap) {
    lines.push('## Queue runtime');
    if (queueGroups.size === 0) {
      lines.push(`  (${queueGap!.why})`);
    } else {
      for (const [name, evs] of queueGroups) {
        lines.push(`  ${name}`);
        for (const e of evs) {
          const detail = isQueueSummary(e)
            ? fmtQueueCounts(e.payload as QueuePayload)
            : stripQueueName(e.title, name);
          lines.push(`    [${e.relevance.toFixed(2)}] ${detail}`);
        }
      }
    }
    lines.push('');
  }

  const rc = r.recentChanges;
  if (rc && rc.commits.length > 0) {
    const until = rc.window.until ? `..${rc.window.until}` : '..HEAD';
    lines.push('## Recent changes');
    lines.push(`  Window: ${rc.window.since}${until}`);
    lines.push(`  Commits: ${rc.commits.length}${rc.truncated ? '+' : ''}`);
    for (const c of rc.commits.slice(0, 10)) {
      lines.push(`  ${c.shortSha} ${c.subject}`);
    }
    if (rc.fileStats.length > 0) {
      const fileCount = rc.changedFiles.length;
      lines.push(`  Files: ${fileCount}${rc.truncated ? '+' : ''}`);
      for (const f of rc.fileStats.slice(0, 8)) {
        lines.push(`    +${f.insertions} -${f.deletions} ${f.path}`);
      }
    }
    if (rc.truncated && rc.truncatedReason) {
      lines.push(`  (truncated: ${rc.truncatedReason})`);
    }
    lines.push('');
  }

  lines.push('## Next actions');
  if (r.nextActions.length === 0) {
    lines.push('(none)');
  } else {
    for (const a of r.nextActions) {
      lines.push(`- ${a}`);
    }
  }

  const suggested = renderRouteSteps(r.nextSteps, '-');
  if (suggested.length > 0) {
    lines.push('');
    lines.push('## Suggested next');
    lines.push(...suggested);
  }

  return lines.join('\n');
}

/** Stable JSON serialization of the full report. */
export function reportToJSON(r: InvestigationReport): string {
  return JSON.stringify(r, null, 2);
}

/**
 * A concise, shareable Markdown report — the deterministic output contract for
 * `horus investigate` (HOR-9). Suitable for pasting into a Linear ticket, Slack,
 * or a postmortem. Distinct from `renderReport` (the verbose terminal/log dump):
 * this is the at-a-glance brief with the six required sections.
 */
export function reportToMarkdown(r: InvestigationReport): string {
  const out: string[] = [];

  out.push(`# Investigation Report — ${r.input.hint}`);
  out.push('');
  const mdCaveat = runtimeSourceCaveat(r);
  out.push(`**Confidence:** ${r.confidence.toFixed(2)}${mdCaveat ? ` _(${mdCaveat})_` : ''}`);
  if (r.input.service) out.push(`**Service:** ${r.input.service}`);
  if (r.input.since) out.push(`**Since:** ${r.input.since}`);
  out.push('');
  out.push('## Summary');
  out.push(r.summary);
  out.push('');

  const mdExplain = explainLowConfidence(r);
  if (mdExplain) {
    out.push('## Why confidence is not higher');
    for (const reason of mdExplain) {
      out.push(`- ${reason}`);
    }
    out.push('');
  }

  out.push('## Similar past incidents');
  if (r.similarIncidents.length === 0) {
    out.push('(none on record)');
  } else {
    for (const s of r.similarIncidents) {
      out.push(
        `- ${s.title} (overlap ${(s.overlap * 100).toFixed(0)}%) — shared: ${s.sharedTags.join(', ')}`,
      );
      if (s.summary) {
        const truncated =
          s.summary.length > 80 ? s.summary.slice(0, 77) + '...' : s.summary;
        out.push(`  _${truncated}_`);
      }
    }
    out.push(
      '_Context only — past incidents inform, but never override, the current evidence._',
    );
  }
  out.push('');

  const mdQueueIds = queueEvidenceIds(r.evidence);

  out.push('## Suspected causes');
  if (r.suspectedCauses.length === 0) {
    out.push('_none_');
  } else {
    r.suspectedCauses.forEach((c, i) => {
      const queueTag = c.sourceEvidenceIds.some((id) => mdQueueIds.has(id)) ? ' `[↑ queue]`' : '';
      out.push(`${i + 1}. **(${c.finalScore.toFixed(2)}, ${c.band})**${queueTag} ${c.title}`);
    });
  }
  out.push('');

  out.push('## Hypotheses');
  const mdAllUnconfirmed =
    r.hypotheses.length > 0 && r.hypotheses.every((h) => h.verdict === 'unconfirmed');
  if (mdAllUnconfirmed) {
    out.push(
      '_All hypotheses below are unconfirmed placeholders — runtime evidence is required to validate them._',
    );
  }
  if (r.hypotheses.length === 0) {
    out.push('_none_');
  } else {
    for (const h of r.hypotheses) {
      out.push(
        `- \`${h.verdict}\` **${h.confidence.toFixed(2)}** (was ${h.priorConfidence.toFixed(2)}) — ${h.category}: ${h.statement}`,
      );
    }
  }
  out.push('');

  out.push('## Evidence gaps (what we don\'t know)');
  if (r.gapAnalysis.gaps.length === 0) {
    out.push('_(no major evidence gaps)_');
  } else {
    for (const gap of r.gapAnalysis.gaps) {
      out.push(
        `- **${gap.dimension}**: ${gap.why}  → _next: ${gap.nextSource}_ (−${gap.confidenceImpact.toFixed(2)} conf)`,
      );
    }
    out.push('');
    out.push('**Blind spots:**');
    for (const bs of r.gapAnalysis.blindSpots) {
      out.push(`- ${bs}`);
    }
    out.push('');
    out.push(
      `_Confidence ceiling: **${r.gapAnalysis.confidenceCeiling}** — current confidence is capped at this until the gaps are filled._`,
    );
  }
  out.push('');

  out.push('## Timeline');
  if (r.timeline.events.length === 0) {
    out.push('_none_');
  } else {
    for (const ev of r.timeline.events) {
      out.push(`${ev.order}. \`${ev.at ?? 'structural'}\` ${ev.title}`);
    }
  }
  out.push('');

  out.push(`## Evidence (${r.evidence.length})`);
  if (r.evidence.length === 0) {
    out.push('_none_');
  } else {
    for (const e of r.evidence) {
      out.push(`- \`${shortId(e.id)}\` [${e.source}/${e.kind}] ${e.title}`);
    }
  }
  out.push('');

  const mdQueueGroups = groupQueueEvidence(r.evidence);
  const mdQueueGap = r.gapAnalysis.gaps.find((g) => g.dimension === 'queue runtime state');
  if (mdQueueGroups.size > 0 || mdQueueGap) {
    out.push('## Queue runtime');
    if (mdQueueGroups.size === 0) {
      out.push(`_${mdQueueGap!.why}_`);
    } else {
      for (const [name, evs] of mdQueueGroups) {
        out.push(`**${name}**`);
        for (const e of evs) {
          const detail = isQueueSummary(e)
            ? fmtQueueCounts(e.payload as QueuePayload)
            : stripQueueName(e.title, name);
          out.push(`- \`${e.relevance.toFixed(2)}\` ${detail}`);
        }
      }
    }
    out.push('');
  }

  out.push('## Next actions');
  if (r.nextActions.length === 0) {
    out.push('_none_');
  } else {
    for (const a of r.nextActions) {
      out.push(`- [ ] ${a}`);
    }
  }
  out.push('');
  const mdSuggested = renderRouteSteps(r.nextSteps, '- [ ]');
  if (mdSuggested.length > 0) {
    out.push('## Suggested next');
    out.push(...mdSuggested);
    out.push('');
  }
  out.push('---');
  out.push('_Generated by Horus — deterministic report, no AI._');

  return out.join('\n');
}
