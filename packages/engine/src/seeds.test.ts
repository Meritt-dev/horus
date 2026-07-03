import { describe, it, expect } from 'vitest';
import type { Symbol } from '@horus/core';
import {
  rankSeeds,
  rankExactCandidates,
  seedRole,
  scoreSeed,
  executableBaseName,
  parseSeedQualifier,
  parseNamedSymbols,
  qualifierBoost,
  isAnchoredExactSeed,
  isCodegenPath,
  isTypeDeclarationSymbol,
} from './seeds.js';

function sym(name: string, filePath: string): Symbol {
  return { id: `x:${filePath}:${name}`, name, filePath };
}

// The exact seeds from the maison "orders are slow" run.
const SEEDS: Symbol[] = [
  sym('inferSupplierScopeFromLegacyOrder', 'src/utils/orderSupplierScope.ts'),
  sym('OrderResolver', 'src/resolvers/order.resolver.ts'),
  sym('sortReplica', 'src/services/sale.service.ts'),
  sym('run', 'scripts/backfill-order-supplier-scope.ts'),
  sym('getRecentOrders', 'src/services/order-analytics.service.ts'),
];

describe('rankSeeds — a real candidate beats a hint-hugging test fixture (HOR-376)', () => {
  it('hard-demotes test/fixture paths below real source when a real candidate exists', () => {
    const fixture = sym('Model', 'tests/mypy/modules/plugin_fail.py'); // name hugs the hint
    const real = sym('build_schema', 'pydantic/_internal/_core_utils.py'); // weaker name match
    const hint = ['model', 'validation', 'recursion'];
    expect(rankSeeds([fixture, real], hint).map((r) => r.symbol.name)[0]).toBe('build_schema');
  });

  it('still allows a test seed when every candidate is a test (test-only repo)', () => {
    const t1 = sym('test_alpha', 'tests/test_alpha.py');
    const t2 = sym('test_beta', 'tests/test_beta.py');
    expect(rankSeeds([t1, t2], ['alpha']).map((r) => r.symbol.name)[0]).toBe('test_alpha');
  });
});

describe('rankSeeds — soft de-prioritization of examples/demo/test paths (HOR-430)', () => {
  it('ranks an examples/ candidate below an EQUAL-strength src/ candidate (shared keyword)', () => {
    // Same name + same search score; only the path differs. Core source must outrank the demo.
    const demo: Symbol = { id: 'd', name: 'createServer', filePath: 'examples/basic/app.ts', score: 0.5 };
    const core: Symbol = { id: 'c', name: 'createServer', filePath: 'src/server.ts', score: 0.5 };
    const ranked = rankSeeds([demo, core], ['server'], undefined, false);
    expect(ranked[0]?.symbol.id).toBe('c');
    expect(ranked.map((r) => r.symbol.id)).toContain('d'); // never filtered out — honesty
  });

  it('an EXACT, anchored match in examples/ still surfaces above a weak real candidate (qualifier)', () => {
    // The user explicitly pointed at the example file: `examples/express/app.ts:configureApp`.
    // That decisive anchor must let the example surface, even though a same-named real symbol exists.
    const exampleExact = sym('configureApp', 'examples/express/app.ts');
    const weakReal: Symbol = { id: 'w', name: 'configureApp', filePath: 'src/legacy/old-setup.ts', score: 0.01 };
    const q = parseSeedQualifier('examples/express/app.ts:configureApp')!;
    // Without the anchor the example is hard-demoted below the real candidate.
    expect(rankSeeds([exampleExact, weakReal], ['configureapp'])[0]?.symbol.id).toBe('w');
    // With the decisive qualifier anchor, the exact example surfaces first.
    const ranked = rankSeeds([exampleExact, weakReal], ['configureapp'], undefined, false, q);
    expect(ranked[0]?.symbol.filePath).toBe('examples/express/app.ts');
  });

  it('a high-confidence exact-content hit in examples/ surfaces on a CODE hint, but stays below an equal real hit', () => {
    // A code hint (e.g. ERR_SYNC_04) resolves to a near-1.0 exact-content match. A strong hit in
    // an example surfaces above a weak real candidate (anchored), yet an equal-strength real hit
    // still wins thanks to the soft path penalty.
    const exampleHit: Symbol = { id: 'eh', name: 'syncOnce', filePath: 'examples/sync/run.ts', score: 1 };
    const weakReal: Symbol = { id: 'wr', name: 'syncOnce', filePath: 'src/util/misc.ts', score: 0.02 };
    const strongReal: Symbol = { id: 'sr', name: 'syncOnce', filePath: 'src/sync/engine.ts', score: 1 };
    expect(isAnchoredExactSeed(exampleHit, null, true)).toBe(true);
    // vs a WEAK real candidate: the anchored example surfaces.
    expect(rankSeeds([exampleHit, weakReal], ['err_sync_04'], undefined, true)[0]?.symbol.id).toBe('eh');
    // vs an EQUAL-strength real candidate: the soft path penalty keeps core source on top.
    expect(rankSeeds([exampleHit, strongReal], ['err_sync_04'], undefined, true)[0]?.symbol.id).toBe('sr');
  });

  it('a mere shared-keyword match in a test fixture is NOT anchored (HOR-376 still holds)', () => {
    // A prose/keyword hint with no qualifier, no prompt-name, and no high-confidence score is not
    // an anchor — the fixture stays hard-demoted below real source.
    const fixture = sym('Model', 'tests/mypy/modules/plugin_fail.py');
    const real = sym('build_schema', 'pydantic/_internal/_core_utils.py');
    expect(isAnchoredExactSeed(fixture, null, false)).toBe(false);
    expect(rankSeeds([fixture, real], ['model', 'validation', 'recursion'])[0]?.symbol.name).toBe(
      'build_schema',
    );
  });

  it('isAnchoredExactSeed: prose high-score is NOT an anchor (only code hints), bare-name qualifier is NOT decisive', () => {
    const schema: Symbol = { id: 's', name: 'Brand', filePath: 'docs/snippets/brand.py', score: 1 };
    expect(isAnchoredExactSeed(schema, null, false)).toBe(false); // prose, not code
    const bareNameElsewhere = sym('run', 'examples/app.ts');
    const q = parseSeedQualifier('SyncService.run')!; // name matches but container does not
    expect(isAnchoredExactSeed(bareNameElsewhere, q, false)).toBe(false);
  });
});

describe('scoreSeed — test files demoted below the implementation (HOR-361)', () => {
  it('ranks the implementation above a same-topic test (tests/ + test_x.py)', () => {
    const impl = sym('login', 'backend/app/api/routes/login.py');
    const test = sym('test_login_incorrect_password', 'backend/tests/api/routes/test_login.py');
    const hint = ['login'];
    expect(scoreSeed(impl, 1, hint)).toBeGreaterThan(scoreSeed(test, 0, hint));
    expect(rankSeeds([test, impl], hint).map((r) => r.symbol.name)[0]).toBe('login');
  });

  it('demotes the test path conventions DEMOTE\\b misses', () => {
    const impl = sym('handler', 'src/app/handler.ts');
    const hint = ['handler'];
    for (const p of [
      'src/__tests__/handler.ts',
      'src/app/handler.test.ts',
      'src/app/handler.spec.ts',
      'tests/test_handler.py',
      'app/handler_test.py',
    ]) {
      expect(scoreSeed(sym('handler', p), 0, hint)).toBeLessThan(scoreSeed(impl, 0, hint));
    }
  });

  it('demotes examples/docs/tutorial files below real source (HOR-365)', () => {
    // sqlmodel: real ORM `Relationship` should beat the tutorial `Relationship` example.
    const impl = sym('Relationship', 'sqlmodel/main.py');
    const hint = ['relationship'];
    for (const p of [
      'docs_src/tutorial/relationship_attributes/tutorial001.py',
      'examples/web-service/index.js',
      'example/app.py',
      'samples/demo.ts',
      'docs/snippets/usage.py',
    ]) {
      expect(scoreSeed(sym('Relationship', p), 0, hint)).toBeLessThan(scoreSeed(impl, 0, hint));
    }
    expect(
      rankSeeds(
        [sym('Relationship', 'docs_src/tutorial/read_relationships/tutorial001.py'), impl],
        hint,
      ).map((r) => r.symbol.filePath)[0],
    ).toBe('sqlmodel/main.py');
  });
});

describe('parseSeedQualifier (HOR-337)', () => {
  it('parses Class.method into container + symbol', () => {
    expect(parseSeedQualifier('ProductService.syncProduct is failing')).toEqual({
      symbol: 'syncProduct',
      container: 'ProductService',
      isPath: false,
    });
  });

  it('parses path/to/file:symbol into container path + symbol', () => {
    expect(parseSeedQualifier('error in src/services/product.service.ts:syncProduct')).toEqual({
      symbol: 'syncProduct',
      container: 'src/services/product.service.ts',
      isPath: true,
    });
  });

  it('does not treat a lowercase obj.method or a bare file.ext as a Class.method qualifier', () => {
    expect(parseSeedQualifier('the order.total is wrong')).toBeNull();
    expect(parseSeedQualifier('see config.ts for details')).toBeNull();
  });

  it('ignores single-letter containers/symbols (e.g. U.S.)', () => {
    expect(parseSeedQualifier('the U.S. region is down')).toBeNull();
  });

  it('returns null for an unqualified prose hint', () => {
    expect(parseSeedQualifier('orders are slow in production')).toBeNull();
  });
});

describe('qualifierBoost (HOR-337)', () => {
  const q = parseSeedQualifier('ProductService.syncProduct')!;

  it('decisively boosts the exact name + class-file match', () => {
    const exact = sym('syncProduct', 'src/services/product.service.ts');
    expect(qualifierBoost(exact, q)).toBeGreaterThan(40);
  });

  it('matches the container via className', () => {
    const s: Symbol = { id: 'c', name: 'syncProduct', filePath: 'src/sync.ts', className: 'ProductService' };
    expect(qualifierBoost(s, q)).toBeGreaterThan(40);
  });

  it('only mildly boosts a same-named symbol in an unrelated container', () => {
    const wrong = sym('syncProduct', 'src/jobs/inventory-sync.ts');
    const boost = qualifierBoost(wrong, q);
    expect(boost).toBeGreaterThan(0);
    expect(boost).toBeLessThan(40);
  });

  it('does not boost a different symbol name', () => {
    expect(qualifierBoost(sym('syncOrder', 'src/services/product.service.ts'), q)).toBe(0);
  });
});

describe('rankSeeds — Class.method / path:symbol EXACT disambiguator (HOR-337)', () => {
  it('resolves ProductService.syncProduct to that exact method, not an unrelated same-named symbol', () => {
    // The exact method lives in a plainly-named runner (no service suffix) but its className is
    // ProductService; the unrelated one sits in a *.service.ts (architectural role + suffix boost).
    const exact: Symbol = {
      id: 'exact',
      name: 'syncProduct',
      filePath: 'src/sync/product-sync-runner.ts',
      className: 'ProductService',
    };
    const unrelated = sym('syncProduct', 'src/services/catalog.service.ts');
    const q = parseSeedQualifier('ProductService.syncProduct')!;
    // Without the qualifier the unrelated *.service.ts wins on role; the qualifier flips it.
    expect(rankSeeds([unrelated, exact], ['syncproduct'])[0]?.symbol.id).toBe(unrelated.id);
    const ranked = rankSeeds([unrelated, exact], ['syncproduct'], undefined, false, q);
    expect(ranked[0]?.symbol.id).toBe('exact');
  });

  it('prefers the path-qualified symbol over a same-named one elsewhere', () => {
    const target = sym('handle', 'src/modules/billing/billing.controller.ts');
    const other = sym('handle', 'src/modules/auth/auth.controller.ts');
    const q = parseSeedQualifier('src/modules/billing/billing.controller.ts:handle')!;
    const ranked = rankSeeds([other, target], ['handle'], undefined, false, q);
    expect(ranked[0]?.symbol.filePath).toBe('src/modules/billing/billing.controller.ts');
  });

  it('uses the signature reference to disambiguate when the file path does not contain Foo', () => {
    const exact: Symbol = {
      id: 'a',
      name: 'syncProduct',
      filePath: 'src/sync/runner.ts',
      signature: 'class ProductService { syncProduct(): Promise<void> }',
    };
    const unrelated = sym('syncProduct', 'src/jobs/inventory.ts');
    const q = parseSeedQualifier('ProductService.syncProduct')!;
    const ranked = rankSeeds([unrelated, exact], ['syncproduct'], undefined, false, q);
    expect(ranked[0]?.symbol.id).toBe('a');
  });

  it('does not change ranking when no qualifier is present (no regression)', () => {
    const a = sym('syncProduct', 'src/jobs/inventory-sync.worker.ts');
    const b = sym('syncProduct', 'src/services/product.service.ts');
    const ranked = rankSeeds([a, b], ['syncproduct']);
    // service-suffix beats a plain worker file here; qualifier-free behaviour is unchanged.
    expect(ranked[0]?.symbol.filePath).toBe('src/services/product.service.ts');
  });
});

describe('seedRole', () => {
  it('labels architectural roles', () => {
    expect(seedRole(SEEDS[1]!)).toBe('resolver');
    expect(seedRole(SEEDS[2]!)).toBe('service');
    expect(seedRole(SEEDS[0]!)).toBe('util');
    expect(seedRole(SEEDS[3]!)).toBe('script');
  });
});

describe('rankSeeds', () => {
  it('prefers resolver/service entry points over utils and scripts', () => {
    const ranked = rankSeeds(SEEDS);
    expect(ranked[0]?.symbol.name).toBe('OrderResolver');
    // util + script should rank last
    const order = ranked.map((r) => r.symbol.name);
    expect(order.indexOf('OrderResolver')).toBeLessThan(
      order.indexOf('inferSupplierScopeFromLegacyOrder'),
    );
    expect(order.indexOf('run')).toBe(order.length - 1); // the backfill script is last
  });

  it('ranks an executable method above a same-named …Result type (HOR-337)', () => {
    const method = sym('syncBrandFulfillments', 'src/services/order.service.ts');
    const resultType = sym('SyncBrandFulfillmentsResult', 'src/services/order.service.ts');
    expect(scoreSeed(method, 1)).toBeGreaterThan(scoreSeed(resultType, 0));
    // even when the type comes first in search order, the method should win the rank
    const ranked = rankSeeds([resultType, method]);
    expect(ranked[0]?.symbol.name).toBe('syncBrandFulfillments');
  });

  it('derives the executable counterpart name for type-like names (HOR-337)', () => {
    expect(executableBaseName('SyncBrandFulfillmentsResult')).toBe('SyncBrandFulfillments');
    expect(executableBaseName('CreateOrderInput')).toBe('CreateOrder');
    expect(executableBaseName('IOrderService')).toBe('OrderService');
    expect(executableBaseName('syncProduct')).toBeNull(); // already executable
  });

  it('demotes a thin getter below the real method (HOR-337)', () => {
    const getter: Symbol = {
      id: 'x:getter',
      name: 'shopifyClientId',
      filePath: 'src/resolvers/brand.resolver.ts',
      startLine: 267,
      endLine: 270, // 4-line field-resolver
    };
    const service: Symbol = {
      id: 'x:svc',
      name: 'exchangeToken',
      filePath: 'src/services/shopify-token-manager.service.ts',
      startLine: 410,
      endLine: 508,
    };
    expect(scoreSeed(service, 1)).toBeGreaterThan(scoreSeed(getter, 0));
  });

  it('boosts a seed that lives in a --since changed file (HOR-328)', () => {
    const s = sym('Foo', 'src/services/sale.service.ts');
    const changedFiles = new Set(['src/services/sale.service.ts']);
    expect(scoreSeed(s, 0, [], changedFiles)).toBeGreaterThan(scoreSeed(s, 0, []));
  });

  it('a changed-file seed outranks an otherwise-equal unchanged one (HOR-328)', () => {
    const changed = sym('AService', 'src/services/a.service.ts');
    const unchanged = sym('BService', 'src/services/b.service.ts');
    // Without a change set they tie → search order keeps BService first; the change set flips it.
    const ranked = rankSeeds([unchanged, changed], undefined, new Set(['src/services/a.service.ts']));
    expect(ranked[0]?.symbol.name).toBe('AService');
  });

  it('scores a resolver above a util', () => {
    expect(scoreSeed(SEEDS[1]!, 1)).toBeGreaterThan(scoreSeed(SEEDS[0]!, 0));
  });

  it('is stable for equal scores (search order preserved)', () => {
    const a = sym('aService', 'src/services/a.service.ts');
    const b = sym('bService', 'src/services/b.service.ts');
    expect(rankSeeds([a, b]).map((r) => r.symbol.name)).toEqual(['aService', 'bService']);
  });

  it('hint tokens boost domain-specific symbols above generic architectural matches', () => {
    // Without hint tokens, BrandService (service bonus) can beat ShopifyWebhookRegistrationService
    // if it appears earlier in search results. With hint tokens it should always lose.
    const brandService = sym('BrandService', 'src/services/brand.service.ts');
    const shopifyController = sym('ShopifyWebhookRegistrationService', 'src/shopify/shopify-app-webhook.controller.ts');
    const hintTokens = ['shopify', 'webhook', 'uninstall'];
    const ranked = rankSeeds([brandService, shopifyController], hintTokens);
    expect(ranked[0]?.symbol.name).toBe('ShopifyWebhookRegistrationService');
  });

  it('weights source relevance: a strong exact-content match outranks a coincidental service-named seed (gap 3)', () => {
    // A code hint (e.g. HTTPFLT001) resolves to its raise site — a filter `catch` — at search
    // score ~1.0; a coincidental same-named `catch` in a *.service.ts (architectural PREFER +
    // file-suffix) must NOT win now that source relevance is weighted.
    const raiseSite: Symbol = { id: 'm1', name: 'catch', filePath: 'src/common/filters/http-exception.filter.ts', score: 1 };
    const coincidental: Symbol = { id: 'm2', name: 'catch', filePath: 'src/modules/legal/legal.service.ts', score: 0.02 };
    // hintHasCode=true: a code hint makes the exact-content score authoritative.
    const ranked = rankSeeds([coincidental, raiseSite], ['httpflt001'], undefined, true);
    expect(ranked[0]?.symbol.id).toBe('m1');
  });

  it('does NOT let a high-score generic match beat a hint-relevant function for a PROSE hint (gap 3 must not regress seed-emitted cases)', () => {
    // "fulfillment failing for brand orders": the `Brand` schema scores 1.0 (matches "brand")
    // but the real raise site `checkBrandOrderFulfillment` scores 0.03. With no code token the
    // raw score is weighted MILDLY, so hint-tokens + role pick the function.
    const schema: Symbol = { id: 's1', name: 'Brand', filePath: 'src/schemas/brand.schema.ts', score: 1 };
    const fn: Symbol = { id: 's2', name: 'checkBrandOrderFulfillment', filePath: 'src/services/order.service.ts', score: 0.03 };
    const ranked = rankSeeds([schema, fn], ['fulfillment', 'brand', 'orders'], undefined, false);
    expect(ranked[0]?.symbol.id).toBe('s2');
  });

  it('HOR-430: with equal lexical footing, the semantically-related candidate outranks the lexical-only one', () => {
    // Both symbols match the same single hint token ("socket") — identical lexical boost (+2)
    // and identical (function) role. The only differentiator is the search/vector score: the real
    // cause `closeIdleSockets` is semantically related (0.9) while `socketEventLog` merely shares
    // the word (0.05). The conservative prose-score bump lets semantic relevance decide.
    const lexicalOnly: Symbol = { id: 'l', name: 'socketEventLog', filePath: 'src/events.ts', score: 0.05 };
    const semantic: Symbol = { id: 's', name: 'closeIdleSockets', filePath: 'src/pool.ts', score: 0.9 };
    const ranked = rankSeeds([lexicalOnly, semantic], ['socket'], undefined, false);
    expect(ranked[0]?.symbol.id).toBe('s');
  });

  it('a code hint follows the exact-content raise site, not a same-score service-named co-occurrence (gap 9)', () => {
    // ERR243 resolves to its raise site `createCostAwareLink` in lib/ (exact-content head, earlier
    // in search order); `updateSingleProductQuantity` in a *.service.ts merely co-occurs at the same
    // score. For a code hint the architectural role is suppressed, so the raise site wins.
    const raiseSite: Symbol = { id: 'r1', name: 'createCostAwareLink', filePath: 'src/lib/storeclients.ts', score: 1 };
    const coOccur: Symbol = { id: 'r2', name: 'updateSingleProductQuantity', filePath: 'src/services/product.service.ts', score: 1 };
    const ranked = rankSeeds([raiseSite, coOccur], ['err243'], undefined, true);
    expect(ranked[0]?.symbol.id).toBe('r1');
  });

  it('gap H: a thin boolean predicate (the decision) outranks a presentation builder', () => {
    // "duplicate leads not being detected before pushing" — the detection lives in the 2-line
    // predicate `isDuplicateLeadSet`, but it used to lose to `buildDuplicateLeadMessage` (a Cliq
    // string formatter) because the predicate got the short-symbol getter penalty and the
    // formatter did not. Now the formatter is demoted and the predicate is exempt.
    const formatter: Symbol = {
      id: 'f',
      name: 'buildDuplicateLeadMessage',
      filePath: 'src/modules/zoho/zoho-cliq.service.ts',
      startLine: 155,
      endLine: 178,
    };
    const predicate: Symbol = {
      id: 'p',
      name: 'isDuplicateLeadSet',
      filePath: 'src/modules/zoho/zoho-pusher.service.ts',
      startLine: 673,
      endLine: 675,
    };
    const ranked = rankSeeds([formatter, predicate], ['duplicate', 'leads', 'detected']);
    expect(ranked[0]?.symbol.name).toBe('isDuplicateLeadSet');
  });
});

// ---------------------------------------------------------------------------
// HOR-385 — parseNamedSymbols (tiered extraction, source-string X/Y ordering)
// ---------------------------------------------------------------------------
describe('parseNamedSymbols — tiered extraction', () => {
  it('extracts a PascalCase name (≥2 humps)', () => {
    expect(parseNamedSymbols('what depends on SlideEditorProvider')).toEqual(['SlideEditorProvider']);
  });

  it('extracts a backticked / quoted symbol', () => {
    expect(parseNamedSymbols('what depends on `field`')).toEqual(['field']);
    expect(parseNamedSymbols("who calls 'getUser'")).toEqual(['getUser']);
    expect(parseNamedSymbols('impact of removing "OrderService"')).toEqual(['OrderService']);
  });

  it('extracts a Class.method qualifier as the method, not the container twice', () => {
    expect(parseNamedSymbols('what depends on ProductService.syncProduct')).toEqual(['syncProduct']);
  });

  it('extracts a path:symbol qualifier as the symbol', () => {
    expect(parseNamedSymbols('what depends on src/orders/order.service.ts:createOrder')).toEqual([
      'createOrder',
    ]);
  });

  it('extracts camelCase and snake_case names', () => {
    expect(parseNamedSymbols('who calls getUser')).toEqual(['getUser']);
    expect(parseNamedSymbols('who calls get_user_by_id')).toEqual(['get_user_by_id']);
  });

  it('rejects sentence words (Does / Verify / Is) — only ≥2-hump Pascal counts', () => {
    expect(parseNamedSymbols('Verify Does Is It Work')).toEqual([]);
  });

  it('dedupes while preserving source order', () => {
    expect(parseNamedSymbols('SlideEditorProvider then SlideEditorProvider again')).toEqual([
      'SlideEditorProvider',
    ]);
  });
});

describe('parseNamedSymbols — verify-isolation X/Y by SOURCE-STRING index, not tier', () => {
  it('both quoted: sentence order preserved (X = first)', () => {
    const got = parseNamedSymbols('verify `SlideEditorProvider` does not affect `field`');
    expect(got).toEqual(['SlideEditorProvider', 'field']);
  });

  it('mixed tiers: an earlier unquoted PascalCase X beats a later backticked Y', () => {
    // The critique inversion case: backticked `field` is extracted in an EARLIER tier
    // than the unquoted PascalCase X, but source-string ordering keeps X first.
    const got = parseNamedSymbols('verify SlideEditorProvider does not affect `field`');
    expect(got[0]).toBe('SlideEditorProvider');
    expect(got[1]).toBe('field');
  });

  it('isolation target Y after X for a plain "does X affect Y" question', () => {
    const got = parseNamedSymbols('does OrderService affect InventoryService');
    expect(got).toEqual(['OrderService', 'InventoryService']);
  });
});

describe('HOR-447 — codegen + type-declaration seed demotion', () => {
  it('isCodegenPath flags generated artifacts, not real source', () => {
    expect(isCodegenPath('src/graphql/generated.tsx')).toBe(true);
    expect(isCodegenPath('src/api/schema.generated.ts')).toBe(true);
    expect(isCodegenPath('src/__generated__/types.ts')).toBe(true);
    expect(isCodegenPath('src/queries.graphql.ts')).toBe(true);
    expect(isCodegenPath('src/reducers/cart.ts')).toBe(false);
    expect(isCodegenPath('src/services/sale.service.ts')).toBe(false);
  });

  it('isTypeDeclarationSymbol flags type-alias/interface/enum kinds, not functions/methods/classes', () => {
    expect(isTypeDeclarationSymbol({ id: 'type_alias:src/x.ts:Cart', name: 'Cart', filePath: 'src/x.ts' })).toBe(true);
    expect(isTypeDeclarationSymbol({ id: 'interface:src/x.ts:IFoo', name: 'IFoo', filePath: 'src/x.ts' })).toBe(true);
    expect(isTypeDeclarationSymbol({ id: 'enum:src/x.ts:Status', name: 'Status', filePath: 'src/x.ts' })).toBe(true);
    expect(isTypeDeclarationSymbol({ id: 'function:src/x.ts:doThing', name: 'doThing', filePath: 'src/x.ts' })).toBe(false);
    expect(isTypeDeclarationSymbol({ id: 'method:src/x.ts:Svc.run', name: 'run', filePath: 'src/x.ts' })).toBe(false);
    expect(isTypeDeclarationSymbol({ id: 'class:src/x.ts:Svc', name: 'Svc', filePath: 'src/x.ts' })).toBe(false);
  });

  it('hard-demotes a generated Cart type alias below the real cartReducer (the dogfood case)', () => {
    const cartType: Symbol = { id: 'type_alias:src/graphql/generated.tsx:Cart', name: 'Cart', filePath: 'src/graphql/generated.tsx', score: 1 };
    const cartReducer: Symbol = { id: 'function:src/reducers/cart.ts:cartReducer', name: 'cartReducer', filePath: 'src/reducers/cart.ts', score: 0.03 };
    // prose hint "cart" (hintHasCode=false): without HOR-447 the type's 1.0 search score wins.
    const ranked = rankSeeds([cartType, cartReducer], ['cart'], undefined, false);
    expect(ranked[0]?.symbol.name).toBe('cartReducer');
  });

  it('still surfaces a type seed the request explicitly qualifies (anchored exemption)', () => {
    const cartType: Symbol = { id: 'type_alias:src/graphql/generated.tsx:Cart', name: 'Cart', filePath: 'src/graphql/generated.tsx', score: 1 };
    const cartReducer: Symbol = { id: 'function:src/reducers/cart.ts:cartReducer', name: 'cartReducer', filePath: 'src/reducers/cart.ts', score: 0.03 };
    const q = parseSeedQualifier('src/graphql/generated.tsx:Cart')!;
    const ranked = rankSeeds([cartType, cartReducer], ['cart'], undefined, false, q);
    expect(ranked[0]?.symbol.name).toBe('Cart');
  });
});


describe('rankExactCandidates (dogfood P1 — explain disambiguation)', () => {
  const sym = (
    id: string,
    name: string,
    filePath: string,
    startLine = 1,
    endLine = 1,
  ): Symbol => ({ id, name, filePath, startLine, endLine });

  it('hono: the 545-line base class outranks the 10-line preset subclass', () => {
    const preset = sym('class:src/preset/tiny.ts:Hono', 'Hono', 'src/preset/tiny.ts', 11, 20);
    const base = sym('class:src/hono-base.ts:Hono', 'Hono', 'src/hono-base.ts', 98, 543);
    const ranked = rankExactCandidates('Hono', [preset, base]);
    expect(ranked[0]?.id).toBe('class:src/hono-base.ts:Hono');
  });

  it('clap: the Command struct outranks a 1-line method `command` (case + kind)', () => {
    const method = sym('method:clap_builder/src/derive.rs:command', 'command', 'clap_builder/src/derive.rs', 120, 120);
    const struct = sym('class:clap_builder/src/builder/command.rs:Command', 'Command', 'clap_builder/src/builder/command.rs', 54, 260);
    const ranked = rankExactCandidates('Command', [method, struct]);
    expect(ranked[0]?.name).toBe('Command');
    // Both collide case-insensitively — the method is still IN the ranking.
    expect(ranked).toHaveLength(2);
  });

  it('test/example paths lose to real code of the same size', () => {
    const testDouble = sym('class:tests/fake.ts:Widget', 'Widget', 'tests/fake.ts', 1, 100);
    const real = sym('class:src/widget.ts:Widget', 'Widget', 'src/widget.ts', 1, 100);
    expect(rankExactCandidates('Widget', [testDouble, real])[0]?.id).toBe('class:src/widget.ts:Widget');
  });

  it('returns empty when nothing matches the query exactly (fuzzy fallback preserved)', () => {
    expect(rankExactCandidates('HonoBase', [sym('class:a.ts:Hono', 'Hono', 'a.ts')])).toEqual([]);
  });
});
