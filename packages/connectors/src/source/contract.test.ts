import { describe, it, expect, beforeAll } from 'vitest';
import { SourceHttpClient, SourceHttpError } from './index.js';

const baseUrl = process.env['HORUS_SOURCE_HOST_URL'] ?? 'http://127.0.0.1:8420';
const client = new SourceHttpClient({ baseUrl });

let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('source-intelligence HTTP API contract', () => {
  it('query console returns a node count (read-only SQL since HOR-392)', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const r = await client.cypher('SELECT count(*) AS n FROM nodes');
    expect(r.rowCount).toBe(1);
    expect(Array.isArray(r.rows)).toBe(true);
    expect(Number(r.rows[0]?.[0])).toBeGreaterThan(0);
    expect(Array.isArray(r.columns)).toBe(true);
  });

  it('search returns symbols for a semantic query', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const res = await client.search('refresh token', 5);
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThan(0);
    const first = res[0];
    expect(typeof first?.nodeId).toBe('string');
    expect(typeof first?.name).toBe('string');
    expect(typeof first?.filePath).toBe('string');
    expect(typeof first?.score).toBe('number');
  });

  it('impact returns target and affected', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const [seed] = await client.symbolsByLabel(['method', 'function'], 1);
    if (!seed) return ctx.skip();
    const imp = await client.impact(seed.id, 2);
    expect(imp.target.id).toBe(seed.id);
    expect(typeof imp.affected).toBe('number');
    expect(typeof imp.depths).toBe('object');
  });

  it('diff returns added/removed/modified arrays', async (ctx) => {
    if (!hostUp) return ctx.skip();

    try {
      const d = await client.diff('HEAD~3', 'HEAD');
      expect(Array.isArray(d.added)).toBe(true);
      expect(Array.isArray(d.removed)).toBe(true);
      expect(Array.isArray(d.modified)).toBe(true);
    } catch (e) {
      // 400: host rejects the ref; 500: repo can't resolve HEAD~3 (shallow clone).
      if (e instanceof SourceHttpError && (e.status === 400 || e.status === 500)) {
        return ctx.skip();
      }
      throw e;
    }
  }, 30_000);

  it('overview exposes node label counts', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const o = await client.overview();
    expect(typeof o.totalNodes).toBe('number');
    expect(typeof o.nodesByLabel).toBe('object');
  });

  // Architecture read path (dogfood P1) — the sections `horus architecture` renders.

  it('deadCode returns a total + byFile grouping', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const d = await client.deadCode();
    expect(typeof d.total).toBe('number');
    expect(typeof d.byFile).toBe('object');
  });

  it('coupling returns pairs with coChanges', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const pairs = await client.coupling();
    expect(Array.isArray(pairs)).toBe(true);
    for (const p of pairs.slice(0, 3)) {
      expect(typeof p.fileA).toBe('string');
      expect(typeof p.coChanges).toBe('number');
    }
  });

  it('filesContaining returns per-token file paths (filesOnly content search)', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const matches = await client.filesContaining(['import', 'zz_no_such_token_zz'], 5);
    // A host that supports filesOnly echoes EVERY requested token as a key; a
    // pre-filesOnly host ignores the flag and yields {} — skip, don't false-fail.
    if (!('import' in matches)) return ctx.skip();
    expect(Array.isArray(matches['import'])).toBe(true);
    expect(matches['zz_no_such_token_zz']).toEqual([]);
    expect((matches['import'] ?? []).length).toBeLessThanOrEqual(5);
  });
});
