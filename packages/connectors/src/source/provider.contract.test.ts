/**
 * SourceCodeProvider — live contract tests (HOR-142).
 *
 * These tests run against a real source-intelligence host. When no host is
 * reachable (CI without the backend), every test skips cleanly so the suite
 * stays green.
 *
 * Set HORUS_SOURCE_HOST_URL to point at a
 * non-default host, e.g.:
 *   HORUS_SOURCE_HOST_URL=http://source.internal:8420 pnpm test provider.contract
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SourceHttpClient, SourceHttpError, SourceCodeProvider } from './index.js';

const baseUrl = process.env['HORUS_SOURCE_HOST_URL'] ?? 'http://127.0.0.1:8420';
const client = new SourceHttpClient({ baseUrl });
const provider = new SourceCodeProvider(client);

let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('SourceCodeProvider contract', () => {
  it('searchSymbols returns symbols', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const s = await provider.searchSymbols('refresh token', 5);
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeGreaterThan(0);
    expect(typeof s[0]?.id).toBe('string');
    expect(typeof s[0]?.name).toBe('string');
    expect(typeof s[0]?.filePath).toBe('string');
  });

  it('context returns the full relationship set', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const [seed] = await client.symbolsByLabel(['method', 'function'], 1);
    if (!seed) return ctx.skip();
    const id = seed.id;
    const c = await provider.context(id);

    expect(c.symbol.id).toBe(id);
    expect(Array.isArray(c.callers)).toBe(true);
    expect(Array.isArray(c.callees)).toBe(true);
    expect(Array.isArray(c.usesType)).toBe(true);
    expect(Array.isArray(c.imports)).toBe(true);
    expect(Array.isArray(c.coupledWith)).toBe(true);
    expect(c.community === null || typeof c.community?.name === 'string').toBe(true);
  });

  it('member_of community resolves for a known symbol (semantic guard)', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const knownId =
      'method:src/modules/zoho/zoho-oauth.service.ts:ZohoOAuthService.refreshAccessToken';
    // Repo-specific probe (leadcall-api) — resolve via the typed line-hydration
    // endpoint and skip on any other host rather than false-failing.
    const exists = Object.keys(await client.nodesLines([knownId])).length > 0;

    if (!exists) return ctx.skip();

    const c = await provider.context(knownId);
    expect(c.community).not.toBeNull();
    expect(typeof c.community?.name).toBe('string');
    expect(c.callees.length + c.callers.length).toBeGreaterThan(0);
  });

  it('flowsFor returns ordered flows', async (ctx) => {
    if (!hostUp) return ctx.skip();

    // Seed with a symbol known to be a process step — the first step of any process.
    const processes = await client.processes();
    const id = processes[0]?.steps[0]?.nodeId;
    if (!id) return ctx.skip();

    const flows = await provider.flowsFor(id);

    expect(flows.length).toBeGreaterThan(0);
    const f = flows[0];
    expect(typeof f?.id).toBe('string');
    expect(typeof f?.name).toBe('string');
    expect(Array.isArray(f?.steps)).toBe(true);
    expect(f?.steps.length ?? 0).toBeGreaterThan(0);
  });

  it('impact returns target + byDepth', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const [seed] = await client.symbolsByLabel(['method', 'function'], 1);
    if (!seed) return ctx.skip();
    const id = seed.id;
    const imp = await provider.impact(id, 2);

    expect(imp.target.id).toBe(id);
    expect(typeof imp.affected).toBe('number');
    expect(Array.isArray(imp.byDepth)).toBe(true);
  });

  it('detectChanges returns change arrays', async (ctx) => {
    if (!hostUp) return ctx.skip();

    try {
      const d = await provider.detectChanges({ base: 'HEAD~3', compare: 'HEAD' });
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

  it('query-console passthrough returns rows (read-only SQL since HOR-392)', async (ctx) => {
    if (!hostUp) return ctx.skip();

    const res = await provider.cypher('SELECT count(*) FROM nodes');
    expect(res.rowCount).toBe(1);
    expect(Array.isArray(res.rows)).toBe(true);
  });
});
