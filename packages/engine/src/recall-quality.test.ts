import { expect, it } from 'vitest';
import { scoreRecallQuality, type RecallReview } from './recall-quality.js';

it('scores top-three relevance and unrelated no-match independently and rejects future/self labels', () => {
  const reports = Array.from({ length: 31 }, (_, i) => ({ id: `r${i}`, createdAt: new Date(i * 1000).toISOString() }));
  const review: RecallReview = {
    reviewer: 'Scoring contract fixture, not a pilot review', version: 'fixture-1',
    cases: reports.slice(1).map((r, i) => ({
      id: r.id, relevantReportIds: i < 10 ? ['r0'] : [],
      rationale: i < 10 ? 'Related fixture' : 'Unrelated fixture', sourceRefs: ['fixture:source'],
    })),
  };
  const results = reports.slice(1).map((r, i) => ({
    id: r.id, matches: i < 9 || i === 10 ? [{ reportIds: ['r0'] }] : [],
  }));
  expect(scoreRecallQuality(reports, results, review)).toMatchObject({
    recurrences: 10, topThreeHits: 9, topThreeRate: 0.9,
    unrelated: 20, noMatches: 19, noMatchRate: 0.95,
    misses: ['r10'], falseMatches: [{ id: 'r11', reportIds: ['r0'] }], passed: true,
  });
  results[11]!.matches = [{ reportIds: ['r0'] }];
  expect(scoreRecallQuality(reports, results, review).passed).toBe(false);
  const oneStratum = { ...review, cases: review.cases.slice(0, 10) };
  expect(scoreRecallQuality(reports, results, oneStratum).passed).toBe(false);
  review.cases[0]!.relevantReportIds = ['r1'];
  expect(() => scoreRecallQuality(reports, results, review)).toThrow(/must be earlier/);
  review.cases[0]!.relevantReportIds = ['r2'];
  expect(() => scoreRecallQuality(reports, results, review)).toThrow(/must be earlier/);
  review.cases[0]!.relevantReportIds = ['r0'];
  results[0]!.matches = [{ reportIds: ['r2'] }];
  expect(() => scoreRecallQuality(reports, results, review)).toThrow(/leaked non-earlier/);
});
