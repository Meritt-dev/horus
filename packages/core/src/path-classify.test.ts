/**
 * The shared product/test path classifier — the one definition every TS surface
 * (architecture, flows, impact display, change buckets) filters through.
 */
import { describe, it, expect } from 'vitest';
import { classifyPath, isProductPath, bucketForChange } from './path-classify.js';

describe('classifyPath', () => {
  it('classifies test files across languages', () => {
    for (const p of [
      'src/order.test.ts',
      'src/order.spec.ts',
      'src/ui/Button.test.tsx',
      'pkg/api/handler_test.go',
      'tests/core/test_calls.py',
      'horus_source/util_test.py',
      'src/lib_test.rs',
      'src/main/java/OrderServiceTest.java',
      'tests/conftest.py',
      'src/__tests__/order.ts',
      'spec/models/order.rb',
      'testdata/fixture.json',
      'src/__fixtures__/queue.ts',
      'e2e/checkout.ts',
      // Mirrored with horus_source/core/classify.py (fixture-queue dogfood):
      'lib/api.spec.js', // .spec. on any extension
      'src/test_helpers/factory.py', // test_-prefixed directory
      'src/main/java/TestOwnerController.java', // Test-prefix Java convention
      'pkg/server_test.go',
    ]) {
      expect(classifyPath(p), p).toBe('test');
    }
  });

  it('classifies docs, examples, config, vendored', () => {
    expect(classifyPath('docs/getting-started.md')).toBe('docs');
    expect(classifyPath('README.md')).toBe('docs');
    expect(classifyPath('docs_src/tutorial/t1.py')).toBe('docs');
    expect(classifyPath('website/src/pages/index.tsx')).toBe('docs');
    expect(classifyPath('examples/basic/server.ts')).toBe('example');
    // Bench/demo/sandbox trees are exercised by external runners — non-product.
    expect(classifyPath('benchmarks/http/index.ts')).toBe('example');
    expect(classifyPath('benches/parse.rs')).toBe('example');
    expect(classifyPath('perf-measures/startup/run.ts')).toBe('example');
    expect(classifyPath('sandbox/client.js')).toBe('example');
    expect(classifyPath('tutorials/intro.py')).toBe('example');
    expect(classifyPath('tsconfig.build.json')).toBe('config');
    expect(classifyPath('package.json')).toBe('config');
    expect(classifyPath('pyproject.toml')).toBe('config');
    expect(classifyPath('vitest.config.ts')).toBe('config');
    expect(classifyPath('node_modules/lodash/index.js')).toBe('vendored');
    expect(classifyPath('vendor/lib/x.go')).toBe('vendored');
    expect(classifyPath('dist/index.cjs')).toBe('vendored');
  });

  it('defaults to product — unknown layouts keep their code visible', () => {
    for (const p of [
      'src/services/checkout.service.ts',
      'packages/engine/src/router.ts',
      'horus_source/core/ingestion/calls.py',
      'cmd/root.go',
      'src/lib.rs',
      // "test" embedded in a name is NOT a test marker
      'src/latest-orders.ts',
      'src/contest/scoring.py',
    ]) {
      expect(classifyPath(p), p).toBe('product');
      expect(isProductPath(p), p).toBe(true);
    }
  });
});

describe('bucketForChange', () => {
  it('maps kinds onto change-risk buckets', () => {
    expect(bucketForChange('src/api/orders.ts')).toBe('runtime');
    expect(bucketForChange('src/api/orders.test.ts')).toBe('test');
    expect(bucketForChange('docs/api.md')).toBe('docs');
    expect(bucketForChange('examples/demo.ts')).toBe('docs');
    expect(bucketForChange('tsconfig.json')).toBe('config');
    expect(bucketForChange('dist/bundle.js')).toBe('config');
  });
});
