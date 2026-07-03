/**
 * Regression tests for three engine fixes:
 *
 *  - HOR-333: the deployment-regression cause cites the most-recent commit(s)
 *    (short SHA + subject) and the changed symbol name(s), not just the seed + range.
 *  - HOR-336 (extended): overall confidence ceiling is MONOTONIC in the headline
 *    suspected cause's finalScore — a weak headline reads lower than a strong one.
 *  - HOR-334: a behavioral "how does X work" hint with no incident signal points the
 *    user at `horus explain <symbol>` instead of dumping empty incident sections.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Symbol, SymbolContext, Flow, ImpactResult, ChangeSet, CypherResult, Evidence } from '@horus/core';
import type {
  CodeProvider,
  GitCommit,
  LogsProvider,
  LogAnalysis,
  MetricsProvider,
  MetricFinding,
} from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import type { BoundedGitChange } from './git-collector.js';

// ---------------------------------------------------------------------------
// collectGitChanges is mocked so the regression-citation test controls the
// bounded git history without touching a real repository.
// ---------------------------------------------------------------------------

vi.mock('./git-collector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-collector.js')>();
  return { ...actual, collectGitChanges: vi.fn(), defaultChangeWindowSince: vi.fn(), commitsTouchingRange: vi.fn() };
});

import { investigate, confidenceCeilingForCause, looksExplanatory, looksPerformance, classifyIntent, looksSourceImpact, looksVerifyIsolation, INCIDENT_SYMPTOM_RE, formatRegressionCitation, buildBehavioralWalkthrough, seedEmittedSeverityTier, isNoiseCommit, isChoreLikeCommit, seedTouchedByRelevantChange, seedTouchingCommitFocus, regressionSeedTouchedScore } from './engine.js';
import { collectGitChanges, defaultChangeWindowSince, commitsTouchingRange } from './git-collector.js';

const mockCollectGitChanges = vi.mocked(collectGitChanges);
const mockDefaultChangeWindowSince = vi.mocked(defaultChangeWindowSince);
const mockCommitsTouchingRange = vi.mocked(commitsTouchingRange);
// Default: the symbol-line-range intersection is unavailable (as on a shallow clone) so the
// regression cause falls back to file-level attribution. Individual tests override this to
// exercise the confirmed-range ("to <seed>") path.
mockCommitsTouchingRange.mockResolvedValue(null);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEED_SYMBOL: Symbol = {
  id: 'sym:services:SaleService',
  name: 'SaleService',
  filePath: 'src/services/sale.service.ts',
  startLine: 40,
  endLine: 120,
};

const fakeCtx: SymbolContext = {
  symbol: SEED_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

function makeCommit(sha: string, subject: string, files: string[] = ['src/services/sale.service.ts']): GitCommit {
  return { sha, shortSha: sha.slice(0, 7), subject, author: 'Dev', dateIso: '2026-01-01', files };
}

function makeChangedSymbol(name: string): Symbol {
  return { id: `sym:services:${name}`, name, filePath: 'src/services/sale.service.ts', startLine: 50, endLine: 60 };
}

// Raise site of an arbitrary observed event_code — a DIFFERENT symbol than the seed, so
// GAP D (code→raise-site resolution) does not promote codes the seed doesn't raise.
const OTHER_RAISER: Symbol = {
  id: 'sym:other:someOtherFn',
  name: 'someOtherFn',
  filePath: 'src/other/other.service.ts',
  startLine: 5,
};

const baseCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  // Realistic code→raise-site resolution (GAP D): a bare event_code resolves to its raise
  // site (a non-seed symbol here); a hint phrase resolves to the seed.
  async searchSymbols(query = '') { return /^[A-Z][A-Z0-9_]{3,}$/.test(query.trim()) ? [OTHER_RAISER] : [SEED_SYMBOL]; },
  async context() { return fakeCtx; },
  async impact(): Promise<ImpactResult> { return { target: SEED_SYMBOL, affected: 0, byDepth: [] }; },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> { return { added: [], removed: [], modified: [] }; },
  async cypher(): Promise<CypherResult> { return { columns: [], rows: [], rowCount: 0 }; },
};

const fakeDb = {
  select() { return { from(_t: unknown) { return Promise.resolve([]); } }; },
  insert(_t: unknown) {
    return {
      values(_r: unknown) {
        return {
          returning(_c: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_t: unknown) {
    return { set(_v: unknown) { return { where(_c: unknown): Promise<void> { return Promise.resolve(); } }; } };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// HOR-333: regression cause cites commit (short SHA + subject) + changed symbols
// ---------------------------------------------------------------------------

describe('investigate() — regression cause cites commit + changed functions (HOR-333)', () => {
  it('enriches the deployment-regression title with commit SHA, subject, and changed symbol names', async () => {
    // The seed-touching commit provably edits the seed's LINE RANGE → the title names the SYMBOL.
    mockCommitsTouchingRange.mockResolvedValueOnce(['a1b2c3d4e5f6']);
    mockCollectGitChanges.mockResolvedValue({
      commits: [
        makeCommit('a1b2c3d4e5f6', 'fix throttle'),
        makeCommit('99887766abcd', 'tidy imports'),
      ],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 10,
      totalDeletions: 3,
      window: { since: 'a1b2c3d', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const codeWithChanges: CodeProvider = {
      ...baseCode,
      async detectChanges(): Promise<ChangeSet> {
        return {
          added: [],
          removed: [],
          modified: [
            { before: makeChangedSymbol('activateSale'), after: makeChangedSymbol('activateSale') },
            { before: makeChangedSymbol('priceSale'), after: makeChangedSymbol('priceSale') },
          ],
        };
      },
    };

    const report = await investigate(
      { hint: 'SaleService regression', since: 'a1b2c3d' },
      { code: codeWithChanges, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    // Cites the most-recent commit short SHA + subject.
    expect(regression?.title).toContain('a1b2c3d');
    expect(regression?.title).toContain('"fix throttle"');
    // Cites the changed symbol name(s).
    expect(regression?.title).toContain('activateSale');
    // Still names the seed + range.
    expect(regression?.title).toContain('SaleService');
    expect(regression?.title).toContain('a1b2c3d..HEAD');
  });

  it('auto-derives a default change window when --since is absent, enabling the deployment-regression cause', async () => {
    // No explicit since: the engine asks for a default window anchored to the repo's last commit.
    mockDefaultChangeWindowSince.mockResolvedValue('2025-12-18T00:00:00.000Z');
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 5,
      totalDeletions: 1,
      window: { since: '2025-12-18T00:00:00.000Z', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    // The default window was requested (NOT a bare wall-clock read) and the change window ran.
    expect(mockDefaultChangeWindowSince).toHaveBeenCalledWith('/repo', 14);
    expect(report.recentChanges).toBeDefined();
    // The deployment-regression cause is no longer dormant; it labels the relative window.
    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    expect(regression?.title).toContain('the last 14 days');
    expect(regression?.title).not.toContain('undefined');
  });

  it('honors deps.changeWindowDays as an overridable default window length', async () => {
    mockDefaultChangeWindowSince.mockResolvedValue('2025-12-25T00:00:00.000Z');
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: [],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: '2025-12-25T00:00:00.000Z', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression' },
      { code: baseCode, db: fakeDb, repoPath: '/repo', changeWindowDays: 7 },
    );

    expect(mockDefaultChangeWindowSince).toHaveBeenCalledWith('/repo', 7);
    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression?.title).toContain('the last 7 days');
  });

  it('does not auto-derive a window when --since is explicit (explicit behavior unchanged)', async () => {
    // Call history accumulates across tests (no global clearMocks) — reset before asserting.
    mockDefaultChangeWindowSince.mockClear();
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('a1b2c3d4e5f6', 'fix throttle')],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 1,
      totalDeletions: 0,
      window: { since: 'a1b2c3d', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    await investigate(
      { hint: 'SaleService regression', since: 'a1b2c3d' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    expect(mockDefaultChangeWindowSince).not.toHaveBeenCalled();
    expect(mockCollectGitChanges).toHaveBeenCalledWith({ repoPath: '/repo', since: 'a1b2c3d' });
  });

  it('degrades to the plain title when no commits/changed symbols are available', () => {
    const { commitClause, symbolClause } = formatRegressionCitation(undefined, null);
    expect(commitClause).toBe('');
    expect(symbolClause).toBe('');
  });

  it('bounds the citation to 2 commits and 3 symbols', () => {
    const recent = {
      commits: [
        makeCommit('1111111', 'one'),
        makeCommit('2222222', 'two'),
        makeCommit('3333333', 'three'),
      ],
      fileStats: [],
      changedFiles: [],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: 'x', until: undefined },
      truncated: false,
    } as BoundedGitChange;
    const changes: ChangeSet = {
      added: [],
      removed: [],
      modified: ['a', 'b', 'c', 'd'].map((n) => ({ before: makeChangedSymbol(n), after: makeChangedSymbol(n) })),
    };
    const { commitClause, symbolClause } = formatRegressionCitation(recent, changes);
    // Only the first 2 commits appear; the third does not.
    expect(commitClause).toContain('1111111');
    expect(commitClause).toContain('2222222');
    expect(commitClause).not.toContain('3333333');
    // Only the first 3 symbols are named, with a "…" overflow marker.
    expect(symbolClause).toContain('a, b, c');
    expect(symbolClause).not.toContain('d,');
    expect(symbolClause).toContain('…');
  });

  it('#3: attributes only to commits/symbols touching the seed file, not the newest in-window', () => {
    const seedFile = 'src/services/sale.service.ts';
    const recent = {
      // newest-first; the newest commit touched an UNRELATED file, the older one the seed file.
      commits: [
        makeCommit('newaaaa', 'newest, unrelated file', ['src/other/x.ts']),
        makeCommit('touchbb', 'the real change to the seed', [seedFile]),
      ],
      fileStats: [],
      changedFiles: [seedFile, 'src/other/x.ts'],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: 'x', until: undefined },
      truncated: false,
    } as BoundedGitChange;
    const unrelated: Symbol = { id: 's:x', name: 'unrelatedFn', filePath: 'src/other/x.ts', startLine: 1, endLine: 2 };
    const changes: ChangeSet = {
      added: [],
      removed: [],
      modified: [
        { before: unrelated, after: unrelated },
        { before: makeChangedSymbol('manageSales'), after: makeChangedSymbol('manageSales') },
      ],
    };
    const { commitClause, symbolClause } = formatRegressionCitation(recent, changes, seedFile);
    // Blame the seed-touching commit, NOT the newest unrelated-file commit.
    expect(commitClause).toContain('touchbb');
    expect(commitClause).not.toContain('newaaaa');
    // Changed symbols restricted to the seed file.
    expect(symbolClause).toContain('manageSales');
    expect(symbolClause).not.toContain('unrelatedFn');
  });
});

// ---------------------------------------------------------------------------
// HOR-406: a recent-but-irrelevant commit must NOT inflate the regression cause.
// ---------------------------------------------------------------------------

describe('isNoiseCommit (HOR-406)', () => {
  it('flags dependency-bot bumps (author + subject shapes)', () => {
    expect(isNoiseCommit({ subject: 'Bump actions/checkout from 6 to 7', author: 'dependabot[bot]' })).toBe(true);
    expect(isNoiseCommit({ subject: 'Bump lodash from 4.17.20 to 4.17.21', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'chore(deps): update eslint', author: 'renovate[bot]' })).toBe(true);
    expect(isNoiseCommit({ subject: 'build(deps-dev): bump vitest', author: 'Dev' })).toBe(true);
  });

  it('flags pure merge, release-prep, and pre-commit autoupdate commits', () => {
    expect(isNoiseCommit({ subject: 'Merge branch main into release', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'Merge pull request #42 from foo/bar', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'Prepare release 1.2.0', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'chore(release): 0.0.53 [skip ci]', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: '[pre-commit.ci] pre-commit autoupdate', author: 'pre-commit-ci[bot]' })).toBe(true);
  });

  it('does NOT flag an ordinary code-change commit', () => {
    expect(isNoiseCommit({ subject: 'fix throttle on SaleService', author: 'Dev' })).toBe(false);
    expect(isNoiseCommit({ subject: 'add retry to activateSale', author: 'Dev' })).toBe(false);
    // "release" must be at the start to count as release-prep — a fix mentioning it is real work.
    expect(isNoiseCommit({ subject: 'fix the release-blocking sale bug', author: 'Dev' })).toBe(false);
  });

  it('flags non-causal docs / formatting / style / test / ci commits (HOR-451)', () => {
    // Conventional-commit type prefixes that declare non-causal intent.
    expect(isNoiseCommit({ subject: 'docs(api): document the sync endpoint', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'style: run prettier across services', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'test(order): add fulfillment specs', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'ci: bump node version in workflow', author: 'Dev' })).toBe(true);
    // The maison smoking guns — a mistyped refactor/feat that is really formatting/docs.
    expect(isNoiseCommit({ subject: 'refactor(order): clean up code formatting and imports', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'feat(horus): add comprehensive documentation for Horus', author: 'Dev' })).toBe(true);
    expect(isNoiseCommit({ subject: 'chore: fix eslint warnings', author: 'Dev' })).toBe(true);
  });

  it('does NOT over-flag behavioural commits that merely mention format/docs words', () => {
    // A real behavioural fix to currency formatting must stay causal (not the bare "format" word).
    expect(isNoiseCommit({ subject: 'fix(currency): correct price rounding in checkout', author: 'Dev' })).toBe(false);
    expect(isNoiseCommit({ subject: 'feat: add a documentation export API endpoint', author: 'Dev' })).toBe(false);
  });
});

describe('seedTouchedByRelevantChange (HOR-406)', () => {
  const seedFile = 'src/services/sale.service.ts';
  const change = (over: Partial<BoundedGitChange>): BoundedGitChange => ({
    commits: [],
    fileStats: [],
    changedFiles: [],
    totalInsertions: 0,
    totalDeletions: 0,
    window: { since: 'x', until: undefined },
    truncated: false,
    degenerate: false,
    ...over,
  });

  it('returns false for a degenerate change window even when a real commit touched the seed (HOR-423)', () => {
    const rc = change({
      commits: [makeCommit('real003', 'refactor sale path', [seedFile])],
      changedFiles: [seedFile],
      totalInsertions: 12,
      totalDeletions: 4,
      degenerate: true,
    });
    expect(seedTouchedByRelevantChange(rc, seedFile)).toBe(false);
  });

  it('returns true for a non-noise commit that touches the seed within a non-trivial diff', () => {
    const rc = change({
      commits: [makeCommit('real001', 'fix throttle', [seedFile])],
      changedFiles: [seedFile],
      totalInsertions: 8,
      totalDeletions: 2,
    });
    expect(seedTouchedByRelevantChange(rc, seedFile)).toBe(true);
  });

  it('returns false for a +0/-0 no-op window even when the seed file is listed (pure merge)', () => {
    const rc = change({
      commits: [makeCommit('merge01', 'Merge branch main', [seedFile, 'a.ts', 'b.ts'])],
      changedFiles: [seedFile, 'a.ts', 'b.ts'],
      totalInsertions: 0,
      totalDeletions: 0,
    });
    expect(seedTouchedByRelevantChange(rc, seedFile)).toBe(false);
  });

  it('returns false when only a bot/noise commit touches the seed', () => {
    const rc = change({
      commits: [makeCommit('bot0001', 'Bump actions/checkout from 6 to 7', [seedFile])],
      changedFiles: [seedFile],
      totalInsertions: 2,
      totalDeletions: 2,
    });
    expect(seedTouchedByRelevantChange(rc, seedFile)).toBe(false);
  });

  it('returns false when a real commit shipped but did not touch the seed', () => {
    const rc = change({
      commits: [makeCommit('real002', 'tweak CI', ['.github/workflows/ci.yml'])],
      changedFiles: ['.github/workflows/ci.yml'],
      totalInsertions: 4,
      totalDeletions: 1,
    });
    expect(seedTouchedByRelevantChange(rc, seedFile)).toBe(false);
  });

  it('returns false when there is no change window or no seed', () => {
    expect(seedTouchedByRelevantChange(undefined, seedFile)).toBe(false);
    expect(seedTouchedByRelevantChange(change({ totalInsertions: 5 }), undefined)).toBe(false);
  });
});

describe('commit-focus scaling of the deployment-regression prior (HOR-451)', () => {
  const seedFile = 'src/services/sale.service.ts';
  const change = (commits: GitCommit[]): BoundedGitChange => ({
    commits,
    fileStats: [],
    changedFiles: [],
    totalInsertions: 10,
    totalDeletions: 2,
    window: { since: 'x', until: undefined },
    truncated: false,
    degenerate: false,
  });
  const filesN = (n: number): string[] => [seedFile, ...Array.from({ length: n - 1 }, (_, i) => `src/x${i}.ts`)];

  it('reports the MOST-focused non-noise commit that touched the seed', () => {
    const rc = change([
      makeCommit('broad01', 'feat(presta): integrate PrestaShop API client', filesN(22)),
      makeCommit('focus01', 'feat(gaia): enhance token mgmt', filesN(7)),
      makeCommit('noise01', 'refactor: clean up code formatting', filesN(3)), // non-causal → ignored
    ]);
    expect(seedTouchingCommitFocus(rc, seedFile)).toBe(7);
  });

  it('returns null when only broad-but-noise commits touched the seed, and the broad commit alone yields the floor', () => {
    const onlyBroad = change([makeCommit('broad01', 'feat(presta): integrate PrestaShop API client', filesN(22))]);
    expect(seedTouchingCommitFocus(onlyBroad, seedFile)).toBe(22);
    expect(regressionSeedTouchedScore(22)).toBeCloseTo(0.2); // broad → demoted, yields to runtime evidence
  });

  it('scales the prior: focused commit strong, broad commit weak', () => {
    expect(regressionSeedTouchedScore(null)).toBeCloseTo(0.18);
    expect(regressionSeedTouchedScore(2)).toBeCloseTo(0.45);
    expect(regressionSeedTouchedScore(7)).toBeCloseTo(0.38);
    expect(regressionSeedTouchedScore(12)).toBeCloseTo(0.3);
    expect(regressionSeedTouchedScore(22)).toBeCloseTo(0.2);
    // A broad commit (0.20) no longer outranks a data-state anomaly (~0.21); a focused one (0.45) still does.
    expect(regressionSeedTouchedScore(22)).toBeLessThan(0.21);
    expect(regressionSeedTouchedScore(3)).toBeGreaterThan(0.21);
  });
});

describe('investigate() — irrelevant most-recent commit does not inflate the regression cause (HOR-406)', () => {
  it('a dependabot CI bump (does not touch the seed) leaves the cause un-boosted and honest', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('deadbee1', 'Bump actions/checkout from 6 to 7', ['.github/workflows/ci.yml'])],
      fileStats: [],
      changedFiles: ['.github/workflows/ci.yml'],
      totalInsertions: 2,
      totalDeletions: 2,
      window: { since: 'deadbee', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'deadbee' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    // Un-boosted base score (0.18, not the 0.45 seed-touched boost).
    expect(regression!.baseScore).toBeCloseTo(0.18, 5);
    // Stays in the weak band — a bot bump cannot headline as a likely regression.
    expect(regression!.finalScore).toBeLessThan(0.4);
    // Honest title: changes shipped, but none touched the seed; the bot commit is not cited.
    expect(regression!.title).toContain('none touched SaleService');
    expect(regression!.title).not.toContain('checkout');
  });

  it('a +0/-0 no-op merge that lists the seed file still does not boost', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('merge001', 'Merge branch main into release', ['src/services/sale.service.ts'])],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 0,
      totalDeletions: 0,
      window: { since: 'merge001', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'merge001' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    expect(regression!.baseScore).toBeCloseTo(0.18, 5);
    expect(regression!.title).toContain('none touched SaleService');
  });

  it('a real commit that DOES touch the seed still earns the boost (no regression in behaviour)', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('real0001', 'fix throttle on activateSale', ['src/services/sale.service.ts'])],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 12,
      totalDeletions: 4,
      window: { since: 'real0001', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'real0001' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    // Seed-touched boost preserved (0.45 base).
    expect(regression!.baseScore).toBeCloseTo(0.45, 5);
    expect(regression!.title).toContain('Recent change');
    expect(regression!.title).toContain('real000');
  });
});

// ---------------------------------------------------------------------------
// A7 (dogfood 0.21.2): a change window whose only seed-touching commits are
// maintenance (chore/formatting/lint) is not blamed for a behavioural bug; and
// when the symbol-line-range intersection can't confirm the commit touched the
// seed itself, the title names the FILE ("touching <file>") not the symbol.
// ---------------------------------------------------------------------------

describe('investigate() — chore-only change window is down-weighted (A7)', () => {
  it('a window of ONLY chore/formatting/lint commits halves the score and reads as maintenance', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [
        makeCommit('c0be1234', 'chore: fix typos'),
        makeCommit('f0a71234', 'chore: reapply formatting to fix lint checks'),
      ],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 6,
      totalDeletions: 4,
      window: { since: 'c0be123', until: undefined },
      truncated: false,
      degenerate: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'c0be123' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    // Maintenance wording — never blames the typo/formatting fixup for the regression.
    expect(regression!.title).toContain('only maintenance commits');
    expect(regression!.title).not.toContain('may have introduced the regression');
    // The chore subjects are NOT cited as the anchor culprit.
    expect(regression!.title).not.toContain('fix typos');
    // Confidence halved: the seed-touched prior (0.45) → 0.225.
    expect(regression!.baseScore).toBeCloseTo(0.225, 5);
  });

  it('softens "to <seed>" → "touching <file>" when the range intersection cannot confirm the seed was touched', async () => {
    // The commit touches the seed's FILE, but the line-range helper returns a DIFFERENT commit
    // set (it edited other parts of the file) — so the title must not claim it was "to <seed>".
    mockCommitsTouchingRange.mockResolvedValueOnce(['ffffffffffff']);
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('abcd1234abcd', 'refactor internals', ['src/services/sale.service.ts'])],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 8,
      totalDeletions: 2,
      window: { since: 'abcd123', until: undefined },
      truncated: false,
      degenerate: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'abcd123' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    const regression = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
    expect(regression).toBeDefined();
    expect(regression!.title).toContain('touching src/services/sale.service.ts');
    expect(regression!.title).not.toContain('to SaleService');
    expect(regression!.title).toContain('may have introduced the regression');
  });
});

describe('isChoreLikeCommit (A7)', () => {
  it('flags chore/style/docs/ci/build prefixes and typo/formatting/lint fixups', () => {
    for (const s of [
      'chore: fix typos',
      'chore(deps): bump',
      'style: reindent',
      'docs: update readme',
      'ci: pin runner',
      'build: tweak rollup',
      'fix a nasty typo',
      'reapply formatting to fix lint checks',
    ]) {
      expect(isChoreLikeCommit({ subject: s })).toBe(true);
    }
  });

  it('does NOT flag behavioural commits', () => {
    for (const s of ['fix throttle on activateSale', 'feat: add retry backoff', 'perf: cache lookups']) {
      expect(isChoreLikeCommit({ subject: s })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// HOR-406 (round 2): the SAME relevance gate must also deflate the Hypotheses
// engine and the Cause-chain builders — not just the suspected-causes ranker.
// An irrelevant most-recent commit must NOT leave the report self-contradicting
// ("[0.80] recent change to X introduced the fault" vs "[0.18] none touched X").
// ---------------------------------------------------------------------------

describe('investigate() — irrelevant recent commit deflates hypotheses + cause-chains, no contradiction (HOR-406 r2)', () => {
  // A bot bump and a +0/-0 merge: both irrelevant most-recent changes that must not be framed as
  // a regression anywhere in the report.
  const irrelevantWindows: Array<[string, BoundedGitChange]> = [
    [
      'dependabot CI bump (does not touch the seed)',
      {
        commits: [makeCommit('deadbee1', 'Bump actions/checkout from 6 to 7', ['.github/workflows/ci.yml'])],
        fileStats: [],
        changedFiles: ['.github/workflows/ci.yml'],
        totalInsertions: 2,
        totalDeletions: 2,
        window: { since: 'deadbee', until: undefined },
        truncated: false,
      } as BoundedGitChange,
    ],
    [
      '+0/-0 no-op merge that lists the seed file',
      {
        commits: [makeCommit('merge001', 'Merge branch main into release', ['src/services/sale.service.ts'])],
        fileStats: [],
        changedFiles: ['src/services/sale.service.ts'],
        totalInsertions: 0,
        totalDeletions: 0,
        window: { since: 'merge001', until: undefined },
        truncated: false,
      } as BoundedGitChange,
    ],
  ];

  for (const [label, window] of irrelevantWindows) {
    it(`${label}: deployment-regression hypothesis is NOT inflated and no cause-chain asserts a recent change`, async () => {
      mockCollectGitChanges.mockResolvedValue(window);

      const report = await investigate(
        { hint: 'SaleService regression', since: window.window.since },
        { code: baseCode, db: fakeDb, repoPath: '/repo' },
      );

      // Hypotheses engine: deflated to the un-boosted base, unconfirmed, honest statement.
      const dr = report.hypotheses.find((h) => h.category === 'deployment-regression');
      expect(dr).toBeDefined();
      expect(dr!.confidence).toBe(0.15);
      expect(dr!.verdict).toBe('unconfirmed');
      expect(dr!.statement).toContain('none touched SaleService');
      expect(dr!.statement).not.toContain('introduced the fault');

      // Cause-chain builder (HOR-196): no deployment-regression chain is narrated off the noise.
      const drChain = (report.causeChains ?? []).find((c) => c.category === 'deployment-regression');
      expect(drChain).toBeUndefined();

      // Correlation cause-chains: no "recent change may have introduced the regression" assertion.
      for (const chain of report.correlation.chains) {
        expect(chain.rationale.toLowerCase()).not.toContain('introduced the regression');
        expect(chain.title).not.toContain('Recent change to the implicated code');
      }

      // No part of the report contradicts the ranked-causes section, which already deflates to the
      // honest "none touched SaleService". Assert the consistency holds end-to-end.
      const ranked = report.suspectedCauses.find((c) => c.id === 'cause:deployment-regression');
      expect(ranked!.title).toContain('none touched SaleService');
      const assertsRegression = (s: string): boolean =>
        /recent change.*introduced the (fault|regression)/i.test(s);
      expect(assertsRegression(dr!.statement)).toBe(false);
      expect(report.correlation.chains.some((c) => assertsRegression(`${c.title} ${c.rationale}`))).toBe(false);
      expect(assertsRegression(ranked!.title)).toBe(false);
    });
  }

  it('a genuinely-relevant recent commit still boosts the hypothesis AND narrates the cause-chains', async () => {
    mockCollectGitChanges.mockResolvedValue({
      commits: [makeCommit('real0001', 'fix throttle on activateSale', ['src/services/sale.service.ts'])],
      fileStats: [],
      changedFiles: ['src/services/sale.service.ts'],
      totalInsertions: 12,
      totalDeletions: 4,
      window: { since: 'real0001', until: undefined },
      truncated: false,
    } as BoundedGitChange);

    const report = await investigate(
      { hint: 'SaleService regression', since: 'real0001' },
      { code: baseCode, db: fakeDb, repoPath: '/repo' },
    );

    // Hypotheses engine: boosted as before (0.5 base lifted by the present commit evidence).
    const dr = report.hypotheses.find((h) => h.category === 'deployment-regression');
    expect(dr).toBeDefined();
    expect(dr!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(dr!.verdict).toBe('supported');
    expect(dr!.statement).toContain('introduced the fault');

    // Cause-chain builder: the regression chain is narrated when the change is relevant.
    const drChain = (report.causeChains ?? []).find((c) => c.category === 'deployment-regression');
    expect(drChain).toBeDefined();

    // Correlation cause-chains: the fallback "recent change" chain is asserted (relevant change).
    expect(
      report.correlation.chains.some((c) => /introduced the regression/i.test(c.rationale)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HOR-336 (extended): confidence ceiling tracks the headline cause strength.
// ---------------------------------------------------------------------------

describe('confidenceCeilingForCause — monotonic ceiling bound to headline cause score', () => {
  it('is monotonic non-decreasing in the cause score', () => {
    const samples = [0, 0.1, 0.19, 0.2, 0.3, 0.4, 0.49, 0.5, 0.6, 0.7, 0.84, 0.85, 0.95, 1];
    for (let i = 1; i < samples.length; i++) {
      const prev = confidenceCeilingForCause(samples[i - 1]!);
      const cur = confidenceCeilingForCause(samples[i]!);
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it('caps a sub-threshold cause to 0.6 (preserves HOR-336)', () => {
    expect(confidenceCeilingForCause(0.08)).toBeCloseTo(0.6, 5);
    expect(confidenceCeilingForCause(0.19)).toBeCloseTo(0.6, 5);
  });

  it('caps a modest cause (0.2–0.5) to roughly the 0.6–0.78 range', () => {
    expect(confidenceCeilingForCause(0.2)).toBeCloseTo(0.6, 5);
    expect(confidenceCeilingForCause(0.35)).toBeGreaterThan(0.6);
    expect(confidenceCeilingForCause(0.35)).toBeLessThan(0.78);
    expect(confidenceCeilingForCause(0.49)).toBeLessThanOrEqual(0.78);
  });

  it('permits high confidence only for a strong cause (>=~0.5)', () => {
    expect(confidenceCeilingForCause(0.5)).toBeGreaterThanOrEqual(0.78);
    expect(confidenceCeilingForCause(0.9)).toBeCloseTo(1, 5);
  });
});

function queueProvider(waiting: number, active: number) {
  return {
    async discoverQueues() { return ['SaleQueue']; },
    async analyzeQueues() {
      return {
        prefix: 'bull',
        collectedAt: new Date().toISOString(),
        queues: [
          {
            queueName: 'SaleQueue',
            waiting,
            active,
            failed: 0,
            completed: 0,
            delayed: 0,
            paused: 0,
            isPaused: false,
          },
        ],
      };
    },
  } as unknown as Parameters<typeof investigate>[1]['queue'];
}

// A logs provider with no error signatures + a metrics provider that checked
// cleanly: these close the logs + metrics evidence gaps (raising the gap-analysis
// confidence ceiling) WITHOUT contributing any incident signal, so the headline
// cause's strength — not gap noise — becomes the binding confidence constraint.
const quietLogs: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchLogs() { return []; },
  async aggregateErrors() { return []; },
  async errorDeltas() { return []; },
  async analyzeErrors(): Promise<LogAnalysis> {
    return {
      window: { from: 'x', to: 'y' },
      totalErrors: 4,
      signatures: [
        {
          key: 'SALE_ACTIVATE_FAIL',
          count: 4,
          firstSeen: '2026-06-13T10:00:00.000Z',
          lastSeen: '2026-06-13T15:00:00.000Z',
          services: ['sale-service'],
          isNew: false,
          baselineCount: 4,
          sampleMessage: 'sale activation failed',
        },
      ],
      newSignatures: [],
      affectedServices: ['sale-service'],
    };
  },
  async checkCompatibility() { return { ok: true, indexCount: 1, issues: [] }; },
  toEvidence() { return []; },
  async queryEvidence() { return []; },
  async analyzeDurations() { return null; },
};

function makeNoneMetrics(): MetricsProvider {
  const findings: MetricFinding[] = [
    {
      dashboardUid: 'dash-1',
      panelTitle: 'sale-service p99 latency',
      kind: 'latency',
      anomaly: 'none',
      labels: {},
      baselineAvg: 0.05,
      currentAvg: 0.05,
      ratio: 1,
      lastValue: 0.05,
    },
  ];
  return {
    id: 'grafana',
    kind: 'metrics',
    async health() { return { ok: true, detail: 'fake' }; },
    async findPanels() { return []; },
    async analyze() { return findings; },
    async rawRange() { return []; },
    toEvidence(fs: MetricFinding[]): Evidence[] {
      return fs.filter((f) => f.anomaly !== 'none').map((f, i): Evidence => ({
        id: `ev_metric_${i}`,
        source: 'metrics',
        kind: 'metric',
        title: f.panelTitle,
        relevance: 0.85,
        payload: f,
        links: {},
        provenance: { query: 'grafana.analyze', collectedAt: new Date().toISOString() },
      }));
    },
  } as unknown as MetricsProvider;
}

describe('investigate() — an unlinked (co-occurring) headline is capped regardless of raw strength', () => {
  it('a strong but seed-UNLINKED cause does not escalate confidence past the "possible" band', async () => {
    // Both runs share the same evidence-gap profile (logs + metrics checked, same
    // missing connectors), so the gap-analysis ceiling is identical. They differ ONLY
    // in headline-cause strength: the WEAK run has a healthy queue (no backlog cause),
    // the STRONG run a deep backlog (strong queue-backlog cause). The monotonic
    // cause-ceiling therefore drives the confidence difference.
    const deps = { code: baseCode, db: fakeDb, logs: quietLogs, metrics: makeNoneMetrics() };
    const weakReport = await investigate(
      { hint: 'SaleService' },
      { ...deps, queue: queueProvider(0, 3) }, // healthy: no backlog/starvation cause
    );
    const strongReport = await investigate(
      { hint: 'SaleService' },
      { ...deps, queue: queueProvider(5000, 2) }, // deep backlog: strong cause
    );

    const weakTop = weakReport.suspectedCauses[0]?.finalScore ?? 0;
    const strongTop = strongReport.suspectedCauses[0]?.finalScore ?? 0;
    // Sanity: the strong run genuinely has a stronger headline cause.
    expect(strongTop).toBeGreaterThan(weakTop);
    // #1/#2: neither queue-backlog cause is structurally LINKED to the SaleService seed (no
    // direct log / seed evidence / graph edge), so both headlines are co-occurring signals.
    // Confidence is therefore capped in the "possible" band and does NOT escalate with raw
    // cause strength — the confident-but-wrong "likely" headline from a loud unlinked signal is
    // exactly the gap this closes.
    expect(strongReport.confidence).toBeLessThanOrEqual(0.6);
    expect(weakReport.confidence).toBeLessThanOrEqual(0.6);
  });
});

// ---------------------------------------------------------------------------
// HOR-334: behavioral "how does X work" hint routes to `horus explain`.
// ---------------------------------------------------------------------------

describe('looksExplanatory — detects interrogative/explanatory hints', () => {
  it('matches "how does X work" style questions', () => {
    expect(looksExplanatory('how does SaleService work')).toBe(true);
    expect(looksExplanatory('what happens when a sale is activated')).toBe(true);
    expect(looksExplanatory('explain the checkout flow')).toBe(true);
    expect(looksExplanatory('walk me through SaleService')).toBe(true);
  });

  it('does NOT match an ordinary incident hint', () => {
    expect(looksExplanatory('SaleService is throwing 500s')).toBe(false);
    expect(looksExplanatory('checkout latency spike')).toBe(false);
    expect(looksExplanatory('')).toBe(false);
  });

  it('gap E: a leading interrogative carrying FAULT terms is an incident hunt, not an explanation', () => {
    expect(looksExplanatory('what recently changed that could be breaking product sync')).toBe(false);
    expect(looksExplanatory('what is causing the product errors')).toBe(false);
    expect(looksExplanatory('why are products failing to publish')).toBe(false);
    expect(looksExplanatory('what changed in the auth flow')).toBe(false);
    // genuine explanation requests are still behavioral, even when they mention a failure path
    expect(looksExplanatory('how does the retry-on-failure path work')).toBe(true);
    expect(looksExplanatory('what happens when a payment fails')).toBe(true);
    expect(looksExplanatory('explain how error handling works')).toBe(true);
    // a clean interrogative with no fault terms stays explanatory
    expect(looksExplanatory('what is the order pipeline')).toBe(true);
  });
});

describe('looksPerformance — detects latency/performance hints (gap 4)', () => {
  it('matches performance hints, not ordinary incidents', () => {
    expect(looksPerformance('everything is slow')).toBe(true);
    expect(looksPerformance('high latency on checkout')).toBe(true);
    expect(looksPerformance('p99 degraded')).toBe(true);
    expect(looksPerformance('throughput dropped')).toBe(true);
    expect(looksPerformance('order creation throwing 500s')).toBe(false);
    expect(looksPerformance('zoho oauth callback')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HOR-385 — deterministic intent classifier (incident wins every tie)
// ---------------------------------------------------------------------------
describe('INCIDENT_SYMPTOM_RE — the single shared symptom guard', () => {
  it('matches every legacy explanatory-demotion cue (no drift from looksExplanatory)', () => {
    for (const cue of [
      'failure',
      'breaks',
      'crashes',
      'crashing',
      'hangs',
      'wrong',
      'stopped',
      'throwing',
      'throws',
      'reject',
      'rejected',
      'denied',
      "can't",
      'cannot',
      'causes',
      'causing',
      'leaking',
      "doesn't work",
    ]) {
      expect(INCIDENT_SYMPTOM_RE.test(cue)).toBe(true);
    }
  });

  it('matches the new infra cues folded into the one constant', () => {
    for (const cue of [
      'returning 500',
      '5xx errors',
      'oom killed',
      'process panic',
      'p95 jumped',
      'p99 jumped',
      'requests throttled',
      'latency spike',
      'out of memory',
      'stack trace',
    ]) {
      expect(INCIDENT_SYMPTOM_RE.test(cue)).toBe(true);
    }
  });

  it('is shared by looksExplanatory — a symptom-bearing interrogative is demoted', () => {
    expect(looksExplanatory('what is throttling the workers')).toBe(false);
    expect(looksExplanatory('why is the service oom-ing')).toBe(false);
  });
});

describe('classifyIntent — conservative: any symptom forces incident first', () => {
  it('returns incident for plain incident hints', () => {
    expect(classifyIntent('orders are failing to publish', undefined)).toBe('incident');
    expect(classifyIntent('checkout is throwing 500s', undefined)).toBe('incident');
    expect(classifyIntent('the worker keeps crashing', undefined)).toBe('incident');
  });

  it('returns incident when --since is set (a diff is always a regression framing)', () => {
    // structural phrasing, but a diffable --since wins
    expect(classifyIntent('what depends on SlideEditorProvider', 'HEAD~5..HEAD')).toBe('incident');
    expect(classifyIntent('is SlideEditorProvider isolated', 'v1.2.0')).toBe('incident');
  });

  it('incident-wins-ties: a symptom cue + structural phrasing stays incident', () => {
    // these are the exact misfires the critique flagged — the shared guard fixes them
    expect(
      classifyIntent('users denied access — does the new middleware affect the session store', undefined),
    ).toBe('incident');
    expect(classifyIntent('checkout stopped working, is the payment module isolated', undefined)).toBe(
      'incident',
    );
    expect(classifyIntent("can't load slides — what depends on SlideEditorProvider", undefined)).toBe(
      'incident',
    );
    expect(classifyIntent('did my refactor break Y — what depends on Y', undefined)).toBe('incident');
    expect(classifyIntent('the regression in blast radius of OrderService', undefined)).toBe('incident');
    expect(classifyIntent('this is causing problems, who calls getUser', undefined)).toBe('incident');
    expect(classifyIntent('the cache is leaking, what depends on CacheManager', undefined)).toBe(
      'incident',
    );
  });

  it('returns source-impact for clean structural questions (no symptom)', () => {
    expect(classifyIntent('what depends on SlideEditorProvider', undefined)).toBe('source-impact');
    expect(classifyIntent('blast radius of OrderService', undefined)).toBe('source-impact');
    expect(classifyIntent('who calls getUser', undefined)).toBe('source-impact');
    expect(classifyIntent('impact of removing the legacy adapter', undefined)).toBe('source-impact');
    expect(classifyIntent('if i change the OrderResolver what breaks downstream', undefined)).toBe(
      'incident',
    );
    expect(classifyIntent('if i rename the OrderResolver what is the ripple', undefined)).toBe(
      'source-impact',
    );
    expect(classifyIntent('safe to delete the old migration helper', undefined)).toBe('source-impact');
  });

  it('returns source-impact for verify-isolation questions (no symptom)', () => {
    expect(classifyIntent('verify SlideEditorProvider does not affect field', undefined)).toBe(
      'source-impact',
    );
    expect(classifyIntent('is the billing module isolated', undefined)).toBe('source-impact');
    expect(classifyIntent('does OrderService affect the InventoryService', undefined)).toBe(
      'source-impact',
    );
    expect(classifyIntent('any impact on the checkout flow', undefined)).toBe('source-impact');
    expect(classifyIntent('is OrderService coupled to InventoryService', undefined)).toBe(
      'source-impact',
    );
  });

  it('returns explain for behavioral questions (no symptom, no structural cue)', () => {
    expect(classifyIntent('how does SaleService work', undefined)).toBe('explain');
    expect(classifyIntent('explain the checkout flow', undefined)).toBe('explain');
    expect(classifyIntent('what is the order pipeline', undefined)).toBe('explain');
  });

  it('defaults to incident for an unclassifiable hint', () => {
    expect(classifyIntent('SlideEditorProvider', undefined)).toBe('incident');
    expect(classifyIntent('order pipeline', undefined)).toBe('incident');
  });

  it('looksSourceImpact / looksVerifyIsolation building blocks', () => {
    expect(looksVerifyIsolation('is X isolated')).toBe(true);
    expect(looksVerifyIsolation('what depends on X')).toBe(false);
    expect(looksSourceImpact('what depends on X')).toBe(true);
    expect(looksSourceImpact('how does X work')).toBe(false);
  });
});

describe('investigate() — behavioral "how does X work" hint routes to a flow walkthrough (gap #5)', () => {
  it('produces a flow walkthrough instead of an incident headline', async () => {
    const report = await investigate(
      { hint: 'how does SaleService work' },
      { code: baseCode, db: fakeDb },
    );
    expect(report.behavioral).toBeDefined();
    expect(report.summary.toLowerCase()).toContain('how does it work');
    expect(report.summary).not.toContain('Top suspected cause');
    expect(report.nextActions.some((a) => a.includes('horus explain'))).toBe(true);
  });

  it('routes to the walkthrough even when incident signals are present, with a noisy-signal note', async () => {
    // gap #5: ambient incident noise (a failing queue) must NOT suppress an explanatory hint —
    // the old gate did, so the behavioral branch never fired in production. The walkthrough still
    // flags the live error signals so the user can pivot to a fault hunt.
    const failingQueue = {
      async discoverQueues() { return ['SaleQueue']; },
      async analyzeQueues() {
        return {
          prefix: 'bull',
          collectedAt: new Date().toISOString(),
          queues: [
            {
              queueName: 'SaleQueue',
              waiting: 500,
              active: 0,
              failed: 100,
              completed: 0,
              delayed: 0,
              paused: 0,
              isPaused: false,
            },
          ],
        };
      },
    } as unknown as Parameters<typeof investigate>[1]['queue'];

    const report = await investigate(
      { hint: 'how does SaleService work' },
      { code: baseCode, db: fakeDb, queue: failingQueue },
    );
    expect(report.behavioral).toBeDefined();
    expect(report.summary).toMatch(/error signals|fault hunt/i);
    expect(report.summary).not.toContain('Top suspected cause');
  });
});

describe('buildBehavioralWalkthrough (gap #5)', () => {
  const sym = (name: string, filePath: string): Symbol => ({ id: `${name}:${filePath}`, name, filePath, startLine: 1 });

  it('renders the richest flow, filters logger noise, and detects persistence + external calls', () => {
    const flows: Flow[] = [
      {
        id: 'f1',
        name: 'order-create',
        steps: [
          sym('OrderController', 'src/order/order.controller.ts'),
          sym('createOrder', 'src/order/order.service.ts'),
          sym('forContext', 'src/common/logging/logger.service.ts'), // logger — must be filtered out
          sym('save', 'src/order/order.repository.ts'), // persistence
          sym('postWebhook', 'src/shopify/shopify.client.ts'), // external call
        ],
      },
    ];
    const w = buildBehavioralWalkthrough(
      'how does order creation work',
      sym('createOrder', 'src/order/order.service.ts'),
      undefined,
      flows,
    );
    expect(w.entry?.name).toBe('OrderController'); // roots at the flow entry, not the mid-flow seed
    expect(w.steps.map((s) => s.name)).not.toContain('forContext'); // logger filtered
    expect(w.persistence.join(' ')).toContain('save');
    expect(w.persistence.join(' ')).not.toContain('createOrder'); // generic service verb not over-flagged
    expect(w.externalCalls.join(' ')).toContain('postWebhook');
    expect(w.narrative).toContain('Flow:');
  });

  it('falls back to the seed + its de-noised callees when no multi-step flow exists', () => {
    const seed = sym('handleThing', 'src/x.service.ts');
    const ctx = {
      callees: [sym('doWork', 'src/y.service.ts'), sym('forContext', 'src/common/logger.service.ts')],
    } as unknown as SymbolContext;
    const w = buildBehavioralWalkthrough('how does X work', seed, ctx, []);
    expect(w.entry?.name).toBe('handleThing');
    expect(w.steps.map((s) => s.name)).toContain('doWork');
    expect(w.steps.map((s) => s.name)).not.toContain('forContext');
  });

  it('gap C: lists a class seed\'s methods as the entry points instead of collapsing to the class', () => {
    const cls: Symbol = {
      id: 'class:src/zoho/oauth.service.ts:ZohoOAuthService',
      name: 'ZohoOAuthService',
      filePath: 'src/zoho/oauth.service.ts',
      startLine: 10,
    };
    const methods = [
      sym('exchangeCodeForTokens', 'src/zoho/oauth.service.ts'),
      sym('refreshAccessToken', 'src/zoho/oauth.service.ts'),
    ];
    const w = buildBehavioralWalkthrough('how does zoho oauth work', cls, undefined, [], methods);
    expect(w.narrative).toContain('is a class');
    expect(w.narrative).toContain('exchangeCodeForTokens');
    expect(w.narrative).toContain('refreshAccessToken');
    expect(w.narrative).not.toContain('showing its direct calls');
  });
});

describe('seedEmittedSeverityTier (gap A — severity-aware cross-signal join)', () => {
  const ERROR = 2;
  const WARN = 1;
  const INFO = 0;

  it('uses the ES log level when present (level overrides the code prefix)', () => {
    expect(seedEmittedSeverityTier('error', 'W_FOO', 'x')).toBe(ERROR);
    expect(seedEmittedSeverityTier('fatal', 'D_FOO', 'x')).toBe(ERROR);
    expect(seedEmittedSeverityTier('warn', 'E_FOO', 'x')).toBe(WARN);
    expect(seedEmittedSeverityTier('debug', 'E_FOO', 'x')).toBe(INFO);
    expect(seedEmittedSeverityTier('info', 'X', '')).toBe(INFO);
  });

  it('falls back to the event_code prefix convention when no level', () => {
    expect(seedEmittedSeverityTier(null, 'E_FULFILLMENT_SYNC_ERROR_04', 'Error during sync')).toBe(ERROR);
    expect(seedEmittedSeverityTier(null, 'W_FULFILLMENT_SYNC_SKIP_02', 'Order not found, skipping')).toBe(WARN);
    expect(seedEmittedSeverityTier(null, 'D_FULFILLMENT_SYNC_ORDER_02', 'Processing order')).toBe(INFO);
  });

  it('treats unclassifiable codes as error — never silently downgrades a real failure', () => {
    // leadcall's HTTP_FLT_001 is logged via logger.error but has no E_/W_/D_ prefix.
    expect(seedEmittedSeverityTier(null, 'HTTP_FLT_001', 'request failed')).toBe(ERROR);
    expect(seedEmittedSeverityTier(undefined, 'SOMECODE', '')).toBe(ERROR);
  });

  it('downgrades on positive keyword evidence only (no prefix/level)', () => {
    expect(seedEmittedSeverityTier(null, 'SOMECODE', 'skipping sync, nothing to do')).toBe(INFO);
    expect(seedEmittedSeverityTier(null, 'SOMECODE', 'a warning about config')).toBe(WARN);
  });
});
