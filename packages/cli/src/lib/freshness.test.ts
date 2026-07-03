import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  humanAge,
  readIndexMeta,
  computeFreshness,
  renderFreshness,
  semanticSearchReady,
  STALE_INDEX_MS,
} from './freshness.js';

describe('semanticSearchReady (HOR-373/375)', () => {
  it('flags an index with symbols but no embeddings, accepts a complete one', () => {
    expect(semanticSearchReady(null)).toBe(false);
    expect(semanticSearchReady({ stats: { symbols: 100, embeddings: 0 } })).toBe(false);
    expect(
      semanticSearchReady({ embeddingsComplete: false, stats: { symbols: 100, embeddings: 100 } }),
    ).toBe(false);
    expect(semanticSearchReady({ stats: { symbols: 100, embeddings: 100 } })).toBe(true);
    // An empty repo (no symbols) isn't a degradation.
    expect(semanticSearchReady({ stats: { symbols: 0, embeddings: 0 } })).toBe(true);
  });
});

const NOW = '2026-06-27T12:00:00.000Z';
const nowMs = Date.parse(NOW);
const isoAgo = (ms: number) => new Date(nowMs - ms).toISOString();

describe('humanAge', () => {
  it('formats seconds/minutes/hours/days', () => {
    expect(humanAge(45_000)).toBe('45s');
    expect(humanAge(90_000)).toBe('1m');
    expect(humanAge(3 * 3600_000)).toBe('3h');
    expect(humanAge(5 * 86_400_000)).toBe('5d');
  });
});

describe('readIndexMeta', () => {
  it('reads last_indexed_at + stats from .horus/source/meta.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'horus-fresh-'));
    try {
      mkdirSync(join(root, '.horus', 'source'), { recursive: true });
      writeFileSync(
        join(root, '.horus', 'source', 'meta.json'),
        JSON.stringify({ version: '1.5.3', last_indexed_at: NOW, stats: { symbols: 10 } }),
      );
      const meta = readIndexMeta(root);
      expect(meta?.lastIndexedAt).toBe(NOW);
      expect(meta?.version).toBe('1.5.3');
      expect(meta?.stats?.symbols).toBe(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when meta.json is absent', () => {
    expect(readIndexMeta(join(tmpdir(), 'definitely-not-a-repo-xyz'))).toBeNull();
  });
});

describe('computeFreshness', () => {
  it('reports a fresh index with no stale caveat', () => {
    const f = computeFreshness({
      repoRoot: '/x',
      evidence: [],
      nowIso: NOW,
      meta: { lastIndexedAt: isoAgo(2 * 3600_000) },
    });
    expect(f.indexStale).toBe(false);
    expect(f.indexAgeLabel).toBe('indexed 2h ago');
    expect(f.caveats.some((c) => /code index is/.test(c))).toBe(false);
  });

  it('flags a stale index past the threshold', () => {
    const f = computeFreshness({
      repoRoot: '/x',
      evidence: [{ source: 'logs', timestamp: NOW }],
      nowIso: NOW,
      meta: { lastIndexedAt: isoAgo(STALE_INDEX_MS + 86_400_000) },
    });
    expect(f.indexStale).toBe(true);
    expect(f.caveats.some((c) => /re-run `horus init`/.test(c))).toBe(true);
  });

  it('caveats when index age is unknown', () => {
    const f = computeFreshness({ repoRoot: '/x', evidence: [], nowIso: NOW, meta: null });
    expect(f.indexAgeMs).toBeNull();
    expect(f.indexAgeLabel).toBe('index age unknown');
    expect(f.caveats.some((c) => /age unknown/.test(c))).toBe(true);
  });

  it('derives the runtime window + sources from timestamped runtime evidence', () => {
    const f = computeFreshness({
      repoRoot: '/x',
      nowIso: NOW,
      meta: { lastIndexedAt: NOW },
      evidence: [
        { source: 'logs', timestamp: '2026-06-20T00:00:00.000Z' },
        { source: 'metrics', timestamp: '2026-06-27T00:00:00.000Z' },
        { source: 'code' }, // ignored — not runtime
      ],
    });
    expect(f.runtimeWindow).toEqual({
      fromIso: '2026-06-20T00:00:00.000Z',
      toIso: '2026-06-27T00:00:00.000Z',
    });
    expect(f.runtimeSources).toEqual(['logs', 'metrics']);
  });

  it('caveats a source-only investigation (no runtime evidence)', () => {
    const f = computeFreshness({
      repoRoot: '/x',
      nowIso: NOW,
      meta: { lastIndexedAt: NOW },
      evidence: [{ source: 'code' }, { source: 'history' }],
    });
    expect(f.runtimeWindow).toBeNull();
    expect(f.runtimeSources).toEqual([]);
    expect(f.caveats.some((c) => /no runtime evidence/.test(c))).toBe(true);
  });

  it('caveats when the index is behind new commits (drift)', () => {
    const f = computeFreshness({
      repoRoot: '/x',
      nowIso: NOW,
      meta: { lastIndexedAt: NOW },
      evidence: [{ source: 'logs', timestamp: NOW }],
      commitsSinceIndex: 5,
    });
    expect(f.commitsSinceIndex).toBe(5);
    expect(f.caveats.some((c) => /5 commit\(s\) since the last index/.test(c))).toBe(true);
  });

  it('no drift caveat when commitsSinceIndex is 0 or unknown', () => {
    const zero = computeFreshness({
      repoRoot: '/x',
      nowIso: NOW,
      meta: { lastIndexedAt: NOW },
      evidence: [{ source: 'logs', timestamp: NOW }],
      commitsSinceIndex: 0,
    });
    expect(zero.caveats.some((c) => /since the last index/.test(c))).toBe(false);
    const unknown = computeFreshness({ repoRoot: '/x', nowIso: NOW, meta: { lastIndexedAt: NOW }, evidence: [] });
    expect(unknown.commitsSinceIndex).toBeNull();
  });
});

describe('renderFreshness', () => {
  it('renders a banner line and any caveats', () => {
    const out = renderFreshness(
      computeFreshness({ repoRoot: '/x', evidence: [], nowIso: NOW, meta: null }),
    );
    expect(out).toContain('Freshness:');
    expect(out).toContain('age unknown');
  });

  it('shows commits-behind in the banner', () => {
    const out = renderFreshness(
      computeFreshness({
        repoRoot: '/x',
        nowIso: NOW,
        meta: { lastIndexedAt: NOW },
        evidence: [{ source: 'logs', timestamp: NOW }],
        commitsSinceIndex: 3,
      }),
    );
    expect(out).toContain('3 behind');
  });
});
