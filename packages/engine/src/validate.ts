/**
 * HOR-25 — Deterministic hypothesis validation.
 *
 * For every generated hypothesis, intersects its supporting/contradicting
 * evidence id sets with the evidence actually present and adjusts confidence
 * and verdict accordingly. Pure and synchronous; no I/O, no randomness.
 */

import type { Evidence } from '@horus/core';
import type { Hypothesis } from './hypotheses.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Verdict = 'supported' | 'unconfirmed' | 'weakened' | 'eliminated';

export interface ValidatedHypothesis extends Hypothesis {
  verdict: Verdict;
  /** Confidence value before validation adjustment. */
  priorConfidence: number;
  /** Number of supporting evidence ids that are present in the evidence set. */
  supportingPresent: number;
  /** Number of contradicting evidence ids that are present in the evidence set. */
  contradictingPresent: number;
  /** Human-readable sentence explaining the verdict. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Validate a set of hypotheses against the available evidence.
 *
 * Deterministic: same inputs → same outputs every time.
 * Sorting: by adjusted confidence descending, with 'eliminated' verdicts
 * always pushed to the end regardless of confidence.
 */
export function validateHypotheses(
  hyps: Hypothesis[],
  evidence: Evidence[],
): ValidatedHypothesis[] {
  const present = new Set(evidence.map((e) => e.id));

  const validated: ValidatedHypothesis[] = hyps.map((h) => {
    const supportingPresent = h.supportingEvidenceIds.filter((id) =>
      present.has(id),
    ).length;
    const contradictingPresent = h.contradictingEvidenceIds.filter((id) =>
      present.has(id),
    ).length;

    let confidence = clamp01(
      h.confidence + 0.15 * supportingPresent - 0.3 * contradictingPresent,
    );

    // Many correlated metric series must not outvote a directly observed failure.
    if (h.category === 'benign-variance' && contradictingPresent > 0) confidence = Math.min(confidence, 0.1);

    let verdict: Verdict;
    if (contradictingPresent > 0 && confidence < 0.1) {
      verdict = 'eliminated';
    } else if (contradictingPresent > 0) {
      verdict = 'weakened';
    } else if (supportingPresent > 0) {
      verdict = 'supported';
    } else {
      verdict = 'unconfirmed';
    }

    const firstMissing = h.missingEvidence[0];
    const awaitingClause =
      verdict === 'unconfirmed' && firstMissing !== undefined
        ? '; awaiting ' + firstMissing
        : '';

    const rationale =
      supportingPresent +
      ' supporting / ' +
      contradictingPresent +
      ' contradicting evidence present' +
      awaitingClause +
      '.';

    return {
      ...h,
      confidence,
      priorConfidence: h.confidence,
      verdict,
      supportingPresent,
      contradictingPresent,
      rationale,
    };
  });

  // HOR-435 (lever #5, calibration): when 2+ hypotheses are supported by the SAME evidence
  // and nothing distinguishes or contradicts them, they are correlated red herrings — none is
  // more proven than the others, and purely-correlated support must NOT let any of them reach
  // certainty just because nothing happened to contradict them. Cap the shared cohort.
  //
  // Gate (to avoid penalizing legitimately distinct hypotheses): the cohort must be 2+
  // hypotheses sharing an IDENTICAL, NON-EMPTY set of PRESENT supporting evidence, with NO
  // contradicting evidence present on any member. Hypotheses backed by different evidence —
  // i.e. genuinely distinguished — are grouped separately and left untouched.
  const SHARED_EVIDENCE_CEILING = 0.75;
  const bySupport = new Map<string, ValidatedHypothesis[]>();
  for (const v of validated) {
    if (v.contradictingPresent > 0) continue;
    const presentSupport = v.supportingEvidenceIds.filter((id) => present.has(id)).sort();
    if (presentSupport.length === 0) continue;
    const key = presentSupport.join('|');
    const list = bySupport.get(key);
    if (list === undefined) bySupport.set(key, [v]);
    else list.push(v);
  }
  for (const cohort of bySupport.values()) {
    if (cohort.length < 2) continue;
    for (const v of cohort) {
      if (v.confidence > SHARED_EVIDENCE_CEILING) {
        v.confidence = SHARED_EVIDENCE_CEILING;
        v.rationale =
          v.rationale.replace(/\.$/, '') +
          `; capped at ${SHARED_EVIDENCE_CEILING} — shares all supporting evidence with ${
            cohort.length - 1
          } other hypothesis(es) and nothing distinguishes them.`;
      }
    }
  }

  // Sort: by confidence desc, BUT push 'eliminated' verdicts to the end.
  validated.sort((a, b) => {
    const aElim = a.verdict === 'eliminated' ? 1 : 0;
    const bElim = b.verdict === 'eliminated' ? 1 : 0;
    if (aElim !== bElim) return aElim - bElim;
    return b.confidence - a.confidence;
  });

  return validated;
}
