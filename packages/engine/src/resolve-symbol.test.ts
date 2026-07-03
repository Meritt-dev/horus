/**
 * THE canonical symbol resolver — cross-command consistency regressions.
 *
 * Dogfood across OSS repos: `search`, `explain`, `investigate`, and `blast-radius`
 * resolved the same query to DIFFERENT symbols, and qualified `Class.method` /
 * `receiver.method` lookups fell back to fuzzy bare-name matches. Every case here
 * mirrors a real repro (express/fastify/starlette/celery/rq/gin/axum/dubbo) as a
 * small fixture; the resolver must pick the same symbol for every command.
 */
import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import {
  parseSymbolQuery,
  resolveSymbolQuery,
  resolveSeedSymbol,
  rankSeeds,
  parseSeedQualifier,
} from './seeds.js';
import { analyzeBlastRadius } from './blast-radius.js';

function sym(
  kind: string,
  filePath: string,
  name: string,
  extra: Partial<Symbol> = {},
): Symbol {
  return {
    id: `${kind}:${filePath}:${extra.className ? `${extra.className}.` : ''}${name}`,
    name,
    filePath,
    startLine: 10,
    endLine: 40,
    ...extra,
  };
}

/** A code provider whose search returns `byQuery[query]` (else `fallback`). */
function providerFor(byQuery: Record<string, Symbol[]>, fallback: Symbol[] = []): CodeProvider {
  return {
    id: 'fake',
    kind: 'code',
    async health() { return { ok: true, detail: 'fake' }; },
    async searchSymbols(q: string) { return byQuery[q] ?? fallback; },
    async context() { return { symbol: fallback[0]!, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] }; },
    async impact() { return { target: fallback[0]!, affected: 0, byDepth: [] }; },
    async flowsFor() { return []; },
    async detectChanges() { return { added: [], removed: [], modified: [] }; },
    async cypher() { return { columns: [], rows: [], rowCount: 0 }; },
  } as unknown as CodeProvider;
}

const fakeDb = {
  select() { return { from: () => Promise.resolve([]) }; },
} as unknown as HorusDb;

// ── parseSymbolQuery — whole-query qualified forms ──────────────────────────

describe('parseSymbolQuery', () => {
  it('accepts Capitalized, lowercase, and chained receivers', () => {
    expect(parseSymbolQuery('Reply.hijack')).toEqual({ symbol: 'hijack', container: 'Reply', isPath: false });
    expect(parseSymbolQuery('reply.hijack')).toEqual({ symbol: 'hijack', container: 'reply', isPath: false });
    expect(parseSymbolQuery('app.use')).toEqual({ symbol: 'use', container: 'app', isPath: false });
    expect(parseSymbolQuery('celery.app.Task.apply_async')).toEqual({ symbol: 'apply_async', container: 'Task', isPath: false });
  });

  it('keeps filenames and prose out', () => {
    expect(parseSymbolQuery('index.js')).toBeNull();
    expect(parseSymbolQuery('config.yaml')).toBeNull();
    expect(parseSymbolQuery('checkout latency spike')).toBeNull();
    expect(parseSymbolQuery('Starlette')).toBeNull();
  });

  it('parses the path:symbol form', () => {
    expect(parseSymbolQuery('lib/reply.js:hijack')).toEqual({ symbol: 'hijack', container: 'lib/reply.js', isPath: true });
  });

  it('the prose parser stays conservative (lowercase receivers ONLY as whole query)', () => {
    // In a sentence, `reply.hijack` could be `file.ext`-ish noise — prose keeps Capitalized-only…
    expect(parseSeedQualifier('users say reply.hijack is broken')).toBeNull();
    // …but the whole-query parser owns the bare form.
    expect(parseSymbolQuery('reply.hijack')).not.toBeNull();
  });
});

// ── The nine dogfood repros ─────────────────────────────────────────────────

describe('resolveSymbolQuery — dogfood repros', () => {
  it('express: `app.use` prefers the real method over test/app.use.js (JS)', () => {
    const lib = sym('method', 'lib/application.js', 'use', { className: 'app', endLine: 80 });
    const test = sym('function', 'test/app.use.js', 'use', {});
    const res = resolveSymbolQuery('app.use', [test, lib]); // host ranked the test first
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(lib);
  });

  it('fastify: `Reply.hijack` and `reply.hijack` resolve the qualified method (JS)', () => {
    const method = sym('method', 'lib/reply.js', 'hijack', { className: 'Reply' });
    const testHelper = sym('function', 'test/reply-hijack.test.js', 'hijack', {});
    for (const q of ['Reply.hijack', 'reply.hijack', 'hijack']) {
      const res = resolveSymbolQuery(q, [testHelper, method]);
      expect(res.candidates[0], q).toBe(method);
      expect(res.kind, q).toBe(q === 'hijack' ? 'exact' : 'exact-qualified');
    }
  });

  it('starlette: `Starlette` resolves the class, not _exception_handler.py (Python)', () => {
    const klass = sym('class', 'starlette/applications.py', 'Starlette', { endLine: 200 });
    const handler = sym('function', 'starlette/_exception_handler.py', 'wrap_app_handling_exceptions', {});
    // Host ranked the handler first (semantic noise); exact-name tier must win.
    const res = resolveSymbolQuery('Starlette', [handler, klass]);
    expect(res.kind).toBe('exact');
    expect(res.candidates[0]).toBe(klass);
  });

  it('celery: `Task.apply_async` prefers app/task.py:Task over canvas.py:_basemap (Python)', () => {
    const task = sym('method', 'celery/app/task.py', 'apply_async', { className: 'Task', endLine: 120 });
    const basemap = sym('method', 'celery/canvas.py', 'apply_async', { className: '_basemap' });
    const res = resolveSymbolQuery('Task.apply_async', [basemap, task]);
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(task);
  });

  it('rq: `Queue.enqueue` prefers rq/queue.py:Queue.enqueue over cli.py:enqueue (Python)', () => {
    const queue = sym('method', 'rq/queue.py', 'enqueue', { className: 'Queue', endLine: 90 });
    const cli = sym('function', 'rq/cli/cli.py', 'enqueue', {});
    const res = resolveSymbolQuery('Queue.enqueue', [cli, queue]);
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(queue);
  });

  it('gin: `Engine.Run` is exact-qualified, never fuzzy (Go)', () => {
    const run = sym('method', 'gin.go', 'Run', { className: 'Engine' });
    const otherRun = sym('function', 'examples/basic/main.go', 'run', {});
    const res = resolveSymbolQuery('Engine.Run', [otherRun, run]);
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(run);
  });

  it('axum: `Router.route` resolves the method, not the Route struct (Rust)', () => {
    const method = sym('method', 'axum/src/routing/mod.rs', 'route', { className: 'Router' });
    const struct = sym('class', 'axum/src/routing/route.rs', 'Route', { endLine: 300 });
    const res = resolveSymbolQuery('Router.route', [struct, method]);
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(method);
  });

  it('dubbo: ambiguous `submitOrder` stays deterministic and DISCLOSES ambiguity (Java)', () => {
    const a = sym('method', 'order-service-a/src/main/java/OrderServiceImpl.java', 'submitOrder', { className: 'OrderServiceImpl' });
    const b = sym('method', 'order-service-b/src/main/java/OrderServiceImpl.java', 'submitOrder', { className: 'OrderServiceImpl' });
    const res1 = resolveSymbolQuery('submitOrder', [a, b]);
    const res2 = resolveSymbolQuery('submitOrder', [a, b]);
    expect(res1.ambiguous).toBe(true);
    expect(res1.candidates.map((s) => s.id)).toEqual(res2.candidates.map((s) => s.id)); // deterministic
    expect(res1.candidates[0]).toBe(a); // stable input-order tie-break, never a silent flip
  });

  it('undici: `Pool.dispatch` picks the INHERITED product method over a test namesake the path-qualifier matches (JS)', () => {
    // The real method is inherited from DispatcherBase (owner ≠ Pool), so the container qualifier
    // does NOT match it; the test namesake in `test/pool.js` DOES container-match (path contains
    // "pool") + owner-matches nothing. The product tier must dominate the qualified path so the
    // test file can never win.
    const inherited = sym('method', 'lib/dispatcher/dispatcher-base.js', 'dispatch', { className: 'DispatcherBase', startLine: 150, endLine: 210 });
    const fake = sym('method', 'test/pool.js', 'dispatch', { className: 'FakeClient' });
    const res = resolveSymbolQuery('Pool.dispatch', [fake, inherited]); // host ranked the test first
    expect(res.candidates[0]).toBe(inherited);
    expect(res.kind).toBe('exact'); // inherited ⇒ matched by name, container is an ancestor class
  });

  it('oclif: bare `Command` picks the 1 product class over MANY fixture namesakes (count never beats product-ness)', () => {
    const product = sym('class', 'src/command.ts', 'Command', { endLine: 120 });
    const fixtures = Array.from({ length: 16 }, (_, i) =>
      sym('class', `test/fixtures/cmd-${i}/command.ts`, 'Command', { endLine: 200 }),
    );
    const res = resolveSymbolQuery('Command', [...fixtures, product]); // 16 fixtures ranked first
    expect(res.kind).toBe('exact');
    expect(res.candidates[0]).toBe(product);
  });

  it('hono: `Hono.get` prefers the product method over the co-located `src/hono.test.ts` namesake (JS)', () => {
    const method = sym('method', 'src/hono-base.ts', 'get', { className: 'Hono', endLine: 60 });
    const coLocated = sym('method', 'src/hono.test.ts', 'get', { className: 'Hono' });
    const res = resolveSymbolQuery('Hono.get', [coLocated, method]);
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]).toBe(method);
  });

  it('pino: a `.tst.ts` type-test namesake is demoted like any test file (JS)', () => {
    const product = sym('method', 'lib/pino.js', 'child', { className: 'Pino', endLine: 90 });
    const typeTest = sym('function', 'test/types/pino.tst.ts', 'child', {});
    const res = resolveSymbolQuery('pino.child', [typeTest, product]);
    expect(res.candidates[0]).toBe(product);
  });

  it('product-over-tests lifts with includeTests', () => {
    const lib = sym('method', 'lib/application.js', 'use', { className: 'app' });
    const test = sym('function', 'test/app.use.js', 'use', { endLine: 500 });
    expect(resolveSymbolQuery('use', [test, lib]).candidates[0]).toBe(lib);
    // Explicit test inclusion lets the (larger) test symbol compete naturally.
    expect(resolveSymbolQuery('use', [test, lib], { includeTests: true }).candidates[0]).toBe(test);
  });
});

// ── Cross-command consistency: explain / blast-radius / investigate agree ───

describe('one resolver, four commands', () => {
  const method = sym('method', 'lib/reply.js', 'hijack', { className: 'Reply', endLine: 60 });
  const testHelper = sym('function', 'test/reply-hijack.test.js', 'hijack', {});
  const pool = [testHelper, method];

  it('resolveSeedSymbol merges a bare-name search for qualified queries', async () => {
    // The dotted query itself returns nothing from the host — only the bare name hits.
    const code = providerFor({ 'Reply.hijack': [], hijack: pool }, pool);
    const res = await resolveSeedSymbol(code, 'Reply.hijack');
    expect(res.kind).toBe('exact-qualified');
    expect(res.candidates[0]!.id).toBe(method.id);
  });

  it('blast-radius picks the SAME seed as the resolver (and reports the resolution)', async () => {
    const code = providerFor({ hijack: pool, 'Reply.hijack': [] }, pool);
    for (const q of ['hijack', 'Reply.hijack']) {
      const report = await analyzeBlastRadius(q, { code, db: fakeDb });
      expect(report!.seed.id, q).toBe(method.id);
      expect(report!.resolution, q).toBe(q === 'hijack' ? 'exact' : 'exact-qualified');
    }
  });

  it('investigate-layer ranking (rankSeeds + shared qualifier) picks the same seed', () => {
    const qualifier = parseSymbolQuery('Reply.hijack');
    const top = rankSeeds(pool, ['reply', 'hijack'], undefined, false, qualifier)[0]!.symbol;
    expect(top.id).toBe(method.id);
  });

  it('search-layer ranking (resolveSymbolQuery over host rows) leads with the same symbol', () => {
    expect(resolveSymbolQuery('hijack', pool).candidates[0]!.id).toBe(method.id);
    expect(resolveSymbolQuery('Reply.hijack', pool).candidates[0]!.id).toBe(method.id);
  });
});
