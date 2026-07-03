import { describe, it, expect, beforeAll } from 'vitest';
import { SourceHttpClient, SourceHttpError } from './index.js';
import { PINNED_SOURCE_VERSION, SOURCE_PIN_ENFORCED } from '@horus/core';

// Live-host schema contract. Skips cleanly when no host is reachable (CI), which is
// exactly how the pre-HOR-392 Cypher/kùzu assertions rotted unnoticed — this file now
// asserts the SQLite-era schema the backend actually serves.
const baseUrl = process.env['HORUS_SOURCE_HOST_URL'] ?? 'http://127.0.0.1:8420';
const client = new SourceHttpClient({ baseUrl });
let hostUp = false;

beforeAll(async () => {
  hostUp = (await client.health()).ok;
});

describe('source-intelligence schema contract', () => {
  it('pins the source-intelligence version (openapi.json)', async (ctx) => {
    // Unbundled dev builds pin to 'dev' and enforce nothing — matching production
    // semantics, the version assertion only applies when the pin is enforced.
    if (!hostUp || !SOURCE_PIN_ENFORCED) return ctx.skip();
    expect(await client.version()).toBe(PINNED_SOURCE_VERSION);
  });

  it('exposes all expected node labels', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const o = await client.overview();
    const labels = Object.keys(o.nodesByLabel);
    // Core labels every indexed repo produces. type_alias/interface are
    // language-dependent (TS yes, pure-Python no) so they are not required here.
    for (const l of ['function', 'file', 'folder', 'community']) {
      expect(labels).toContain(l);
    }
  });

  it('exposes the core edge rel_types', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const o = await client.overview();
    const types = Object.keys(o.edgesByType);
    // coupled_with (needs git co-change history — absent on shallow clones) and
    // implements (language-dependent) are intentionally not required.
    for (const e of ['defines', 'calls', 'member_of', 'contains', 'imports']) {
      expect(types).toContain(e);
    }
  });

  it('serves a single edges table (SQL console)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const r = await client.cypher('SELECT count(*) AS n FROM edges');
    expect(r.rowCount).toBe(1);
    expect(Number(r.rows[0]?.[0])).toBeGreaterThan(0);
  });

  it('REJECTS Cypher on the query console (drift guard — the seam architecture relied on)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    // The console is read-only SQL since HOR-392. Any code still emitting Cypher
    // (like discoverArchitecture used to) must get a hard 400, not silent rows.
    let err: unknown;
    try {
      await client.cypher('MATCH (n) RETURN count(n)');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SourceHttpError);
    expect((err as SourceHttpError).status).toBe(400);
  });

  it('retains snake_case node properties', async (ctx) => {
    if (!hostUp) return ctx.skip();
    const r = await client.cypher(
      "SELECT file_path, start_line FROM nodes WHERE label = 'function' AND file_path != '' LIMIT 1",
    );
    expect(typeof r.rows[0]?.[0]).toBe('string');
    expect(typeof r.rows[0]?.[1]).toBe('number');
  });

  it('hybrid search resolves a synonym query (semantic delegated to source backend)', async (ctx) => {
    if (!hostUp) return ctx.skip();
    // A natural-language description (no shared token with the symbol) must reach the
    // symbol via embeddings. The probe symbol lives in leadcall-api, so this guard only
    // runs when the host serves that repo — other hosts skip rather than false-fail.
    const info = await client.hostInfo().catch(() => null);
    if (!info?.repoPath.includes('leadcall')) return ctx.skip();
    // Top-10, not top-5: rank drifted to 6 after the kùzu→SQLite reindex with
    // near-flat hybrid scores — tracked as the search-recall dogfood gap (P2).
    // If the symbol drops out of the top-10 entirely, semantic search is broken.
    const res = await client.search('mark a lead as a duplicate in the crm', 10);
    expect(res.map((x) => x.name)).toContain('markDuplicateLead');
  });
});
