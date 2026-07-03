/**
 * Weak-evidence investigations must not contradict themselves.
 *
 * Dogfood: broad recent changes produced "no specific cause identified" in the
 * summary/causes while the Hypotheses section still said deployment-regression was
 * SUPPORTED (and a cause-chain was narrated for it). The broad/low-confidence seed
 * signals now propagate into causes, hypotheses, AND cause chains via one shared
 * verdict (`seedTouchingCommitFocus` / BROAD_CHANGE_FILE_THRESHOLD).
 *
 * Uses a REAL temp git repo (like the connectors git tests) so the bounded
 * git-collector path runs exactly as in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';

const SEED_FILE = 'src/services/checkout.service.ts';

const SEED: Symbol = {
  id: 'sym:services:CheckoutService.processOrder',
  name: 'processOrder',
  filePath: SEED_FILE,
  startLine: 10,
  endLine: 60,
  score: 1,
};

const ctx: SymbolContext = {
  symbol: SEED,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [SEED]; },
  async context() { return ctx; },
  async impact(): Promise<ImpactResult> { return { target: SEED, affected: 0, byDepth: [] }; },
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

/**
 * Build a temp git repo whose LAST commit touches the seed file + `extraFiles` others.
 * The baseline commit is BACKDATED far outside the auto change window so the window's
 * diff base (`oldest-in-window^`) resolves — a repo whose entire history sits inside
 * the window is treated as a degenerate (undiffable) change range by the collector.
 */
function makeRepo(extraFiles: number): string {
  const repo = mkdtempSync(join(tmpdir(), 'horus-weak-ev-'));
  const git = (args: string[], dateIso?: string) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
        ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}),
      },
    });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, dirname(SEED_FILE)), { recursive: true });
  writeFileSync(join(repo, SEED_FILE), 'export const processOrder = 1;\n');
  git(['add', '.']);
  const longAgo = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
  git(['commit', '-q', '-m', 'chore: seed baseline'], longAgo);

  writeFileSync(join(repo, SEED_FILE), 'export const processOrder = 2;\n');
  for (let i = 0; i < extraFiles; i++) {
    const f = join(repo, `src/other/module-${i}.ts`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `export const m${i} = ${i};\n`);
  }
  git(['add', '.']);
  git([
    'commit',
    '-q',
    '-m',
    extraFiles > 0 ? 'feat: integrate huge subsystem' : 'fix: adjust processOrder rounding',
  ]);
  return repo;
}

let broadRepo: string;
let focusedRepo: string;

beforeAll(() => {
  broadRepo = makeRepo(21); // 22 files incl. the seed — broad churn
  focusedRepo = makeRepo(1); // 2 files incl. the seed — focused change
});

afterAll(() => {
  for (const r of [broadRepo, focusedRepo]) rmSync(r, { recursive: true, force: true });
});

describe('broad-change runs stay consistent across causes / hypotheses / chains', () => {
  it('no section calls the broad change a supported regression', async () => {
    const report = await investigate(
      { hint: 'processOrder failures' },
      { code: fakeCode, db: fakeDb, repoPath: broadRepo },
    );

    // 1. The suspected cause reframes honestly instead of blaming the broad change.
    const regressionCause = report.suspectedCauses.find(
      (c) => c.category === 'deployment-regression',
    );
    expect(regressionCause).toBeDefined();
    expect(regressionCause!.title).toContain('broad recent change');
    expect(regressionCause!.title).toContain('No specific cause identified');

    // 2. The hypothesis deflates the same way — never `supported`.
    const regressionHyp = report.hypotheses.find(
      (h) => h.category === 'deployment-regression',
    );
    expect(regressionHyp).toBeDefined();
    expect(regressionHyp!.statement).toContain('broad recent change');
    expect(regressionHyp!.verdict).not.toBe('supported');
    expect(regressionHyp!.supportingEvidenceIds).toEqual([]);

    // 3. No deployment-regression cause-chain is narrated off the broad change.
    const chains = report.causeChains ?? [];
    expect(chains.some((c) => c.category === 'deployment-regression')).toBe(false);
  });

  it('a FOCUSED seed-touching change keeps the full regression signal (control)', async () => {
    const report = await investigate(
      { hint: 'processOrder failures' },
      { code: fakeCode, db: fakeDb, repoPath: focusedRepo },
    );
    const regressionCause = report.suspectedCauses.find(
      (c) => c.category === 'deployment-regression',
    );
    expect(regressionCause!.title).toContain('may have introduced the regression');
    const regressionHyp = report.hypotheses.find(
      (h) => h.category === 'deployment-regression',
    );
    expect(regressionHyp!.supportingEvidenceIds.length).toBeGreaterThan(0);
    expect(regressionHyp!.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('bounded per-commit timeline events', () => {
  it('each non-noise commit becomes a TIMED event, capped', async () => {
    const report = await investigate(
      { hint: 'processOrder failures' },
      { code: fakeCode, db: fakeDb, repoPath: focusedRepo },
    );
    const perCommit = report.timeline.events.filter(
      (e) => e.kind === 'commit' && /^Commit [0-9a-f]/.test(e.title),
    );
    expect(perCommit.length).toBeGreaterThan(0);
    expect(perCommit.length).toBeLessThanOrEqual(8);
    for (const e of perCommit) {
      expect(e.at).toBeTruthy(); // timed, not the untimed aggregate blob
    }
    // The aggregate range event still exists exactly once.
    const aggregate = report.timeline.events.filter(
      (e) => e.kind === 'commit' && /^Git history /.test(e.title),
    );
    expect(aggregate).toHaveLength(1);
  });
});

describe('vague perf hint + no metrics + low-confidence seed', () => {
  it('structural causes demote to explicit unconfirmed guesses; hypothesis agrees', async () => {
    // Hint names a symptom with NO token overlap with the seed, and the search score is
    // weak — the seed is a fuzzy guess (seedIsLowConfidence).
    const lowConfCode: CodeProvider = {
      ...fakeCode,
      async searchSymbols() { return [{ ...SEED, score: 0.2 }]; },
    };
    const report = await investigate(
      { hint: 'payments latency spike' },
      { code: lowConfCode, db: fakeDb, repoPath: focusedRepo },
    );
    const regressionCause = report.suspectedCauses.find(
      (c) => c.category === 'deployment-regression',
    );
    expect(regressionCause).toBeDefined();
    expect(regressionCause!.title).toContain('unconfirmed structural guess');
    expect(regressionCause!.finalScore).toBeLessThanOrEqual(0.18);

    const regressionHyp = report.hypotheses.find(
      (h) => h.category === 'deployment-regression',
    );
    expect(regressionHyp!.statement).toContain('unconfirmed structural guess');
    expect(regressionHyp!.verdict).not.toBe('supported');
  });
});

describe('stale-index freshness feeds routing', () => {
  it('deps.staleIndex routes `horus init` as the first next step', async () => {
    const report = await investigate(
      { hint: 'processOrder failures' },
      { code: fakeCode, db: fakeDb, repoPath: focusedRepo, staleIndex: true },
    );
    expect(report.nextSteps?.[0]).toMatchObject({ nextTool: 'init' });
  });

  it('without staleIndex, init is not routed (host healthy, index fresh)', async () => {
    const report = await investigate(
      { hint: 'processOrder failures' },
      { code: fakeCode, db: fakeDb, repoPath: focusedRepo },
    );
    expect((report.nextSteps ?? []).every((s) => s.nextTool !== 'init')).toBe(true);
  });
});
