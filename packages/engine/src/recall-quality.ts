import assert from 'node:assert/strict';

export interface RecallReview {
  reviewer: string;
  version: string;
  cases: Array<{ id: string; relevantReportIds: string[]; rationale: string; sourceRefs: string[] }>;
}

/** Score chronological recall reviews, separately from investigation accuracy and dispositions. */
export function scoreRecallQuality(
  reports: Array<{ id: string; createdAt: string }>,
  results: Array<{ id: string; matches: Array<{ reportIds: string[] }> }>,
  review: RecallReview,
) {
  assert(review && typeof review.reviewer === 'string' && review.reviewer.trim());
  assert(typeof review.version === 'string' && review.version.trim());
  assert(Array.isArray(review.cases) && review.cases.length > 0 && review.cases.length <= 1000);
  const times = new Map(reports.map(r => [r.id, Date.parse(r.createdAt)]));
  assert.equal(times.size, reports.length, 'Duplicate source report IDs');
  const recalled = new Map(results.map(r => [r.id, r.matches.slice(0, 3)]));
  const labeled = new Set<string>();
  let recurrences = 0, topThreeHits = 0, unrelated = 0, noMatches = 0;
  const misses: string[] = [];
  const falseMatches: Array<{ id: string; reportIds: string[] }> = [];
  for (const label of review.cases) {
    assert(label && typeof label.id === 'string' && !labeled.has(label.id), 'Duplicate/invalid review ID');
    labeled.add(label.id);
    assert(typeof label.rationale === 'string' && label.rationale.trim(), 'Missing relevance rationale');
    assert(Array.isArray(label.sourceRefs) && label.sourceRefs.length > 0 && label.sourceRefs.every(r => typeof r === 'string' && r.trim()), 'Missing review provenance');
    assert(Array.isArray(label.relevantReportIds) && label.relevantReportIds.every(id => typeof id === 'string'), 'Invalid relevant report IDs');
    assert.equal(new Set(label.relevantReportIds).size, label.relevantReportIds.length, 'Duplicate relevant report IDs');
    const at = times.get(label.id);
    const matches = recalled.get(label.id);
    assert(at !== undefined && Number.isFinite(at) && matches, `Review report unavailable: ${label.id}`);
    for (const id of label.relevantReportIds) {
      const prior = times.get(id);
      assert(prior !== undefined && Number.isFinite(prior) && prior < at, `Relevant report must be earlier: ${id}`);
    }
    for (const match of matches) for (const id of match.reportIds) {
      const prior = times.get(id);
      assert(prior !== undefined && prior < at, `Recall leaked non-earlier report: ${id}`);
    }
    const expected = new Set(label.relevantReportIds);
    if (expected.size) {
      recurrences++;
      if (matches.some(m => m.reportIds.some(id => expected.has(id)))) topThreeHits++;
      else misses.push(label.id);
    } else {
      unrelated++;
      if (!matches.length) noMatches++;
    }
    for (const match of matches) if (!match.reportIds.some(id => expected.has(id))) {
      falseMatches.push({ id: label.id, reportIds: match.reportIds });
    }
  }
  return {
    reviewer: review.reviewer, version: review.version, labeled: labeled.size,
    recurrences, topThreeHits, topThreeRate: recurrences ? topThreeHits / recurrences : null,
    unrelated, noMatches, noMatchRate: unrelated ? noMatches / unrelated : null,
    misses, falseMatches,
    passed: recurrences > 0 && unrelated > 0 && topThreeHits >= 0.9 * recurrences && noMatches >= 0.95 * unrelated,
  };
}
