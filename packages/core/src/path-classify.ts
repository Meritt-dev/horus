/**
 * The ONE product/test path classifier for the TypeScript packages.
 *
 * The source graph and change reports were polluted by test fixtures: architecture
 * showed fixture queues, blast-radius was dominated by `*.test.ts`, and change
 * reports counted docs edits as runtime risk. Every TS consumer (engine
 * architecture/flows/impact display, change bucketing, search ranking) classifies
 * through here; the Python source host mirrors these patterns in
 * `horus_source/core/classify.py` — keep the two lists in sync.
 */

export type PathKind = 'product' | 'test' | 'docs' | 'example' | 'config' | 'vendored';

/** Directory names that mark everything beneath them. */
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testdata', 'fixtures', '__fixtures__', '__testfixtures__', 'testfixtures', '__mocks__', 'e2e']);
// `www` and `site` are the conventional docs/marketing-site trees in OSS libraries
// (trpc/tanstack ship a docusaurus site under `www/`); their content leaked into
// external-system detection (dogfood 0.21: trpc `www/` → graphql/prisma "integrations").
const DOCS_DIRS = new Set(['docs', 'doc', 'docs_src', 'website', 'www', 'site']);
// Bench/demo/sandbox trees are exercised by external runners or exist as
// documentation — grouped with examples because every consumer treats them the same.
const EXAMPLE_DIRS = new Set([
  'examples', 'example', 'samples', 'sample', 'demo', 'demos',
  'bench', 'benches', 'benchmark', 'benchmarks', 'perf', 'perf-measures',
  'runtime-tests', 'sandbox', 'playground', 'tutorial', 'tutorials',
]);
// `.yarn` holds Yarn Berry's vendored release/plugin blobs (`.yarn/releases/*.cjs`);
// `generated`/`__generated__` hold codegen output (`*.d.ts`, GraphQL/protobuf clients).
// Both leaked into external-system detection (dogfood 0.21: apollo-server's generated
// `stripe` d.ts, yarn release blobs) — they're not hand-written integrations.
const VENDORED_DIRS = new Set(['node_modules', 'vendor', 'vendors', 'vendored', 'third_party', 'third-party', 'dist', 'build', '.venv', 'venv', '.yarn', 'generated', '__generated__']);

/** Test-file naming conventions across the indexed languages. `.test.`/`.spec.`/`.tst.`
 *  accept any extension (co-located tests: `router.test.ts`, `api.spec.js`, and pino's
 *  type-test convention `pino.tst.ts`, ...). */
const TEST_FILE_RE =
  /(\.(test|spec|tst)\.[^/.]+$|^test_[^/]*\.[^/.]+$|_test\.(py|go|rs)$|^Test[A-Z][^/]*\.java$|Test\.java$|Spec\.(scala|kt)$|^conftest\.py$)/;

/** Config-ish files that are neither runtime code nor tests. */
const CONFIG_FILE_RE =
  /(^|\.)((eslint|prettier|babel|jest|vitest|tsup|vite|webpack|rollup)\.config\.[cm]?[jt]s$|tsconfig[^/]*\.json$|package\.json$|pnpm-(lock|workspace)\.yaml$|pyproject\.toml$|Cargo\.toml$|go\.(mod|sum)$|Dockerfile$|docker-compose[^/]*\.ya?ml$|\.github\/)/;

// `.markdown`/`.mdown`/`.mkd` are the long-form Markdown extensions — a root
// `CHANGELOG.markdown` (outside any docs/ tree) classified as product and leaked its
// prose mentions into external-system detection (dogfood 0.21: axios from markdown).
const DOCS_FILE_RE = /\.(md|mdx|markdown|mdown|mkd|rst|adoc|txt)$/i;

/**
 * Classify a repo-relative (or absolute) path. Product is the default — the
 * classifier only demotes what it can positively identify, so unknown layouts
 * keep their code visible.
 */
export function classifyPath(path: string): PathKind {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.split('/').pop() ?? normalized;
  const segments = normalized.toLowerCase().split('/').slice(0, -1);

  for (const seg of segments) {
    if (VENDORED_DIRS.has(seg)) return 'vendored';
  }
  if (TEST_FILE_RE.test(base)) return 'test';
  for (const seg of segments) {
    if (TEST_DIRS.has(seg) || seg.startsWith('test_')) return 'test';
    if (DOCS_DIRS.has(seg)) return 'docs';
    if (EXAMPLE_DIRS.has(seg)) return 'example';
  }
  if (DOCS_FILE_RE.test(base)) return 'docs';
  if (CONFIG_FILE_RE.test(normalized)) return 'config';
  return 'product';
}

/** True when the path is product code (the traversal/display default). */
export function isProductPath(path: string): boolean {
  return classifyPath(path) === 'product';
}

/**
 * Bucket for change reports: what kind of risk does editing this file carry?
 * `runtime` = product code shipped to production; the rest is context.
 */
export type ChangeBucket = 'runtime' | 'test' | 'docs' | 'config';

export function bucketForChange(path: string): ChangeBucket {
  switch (classifyPath(path)) {
    case 'test':
      return 'test';
    case 'docs':
      return 'docs';
    case 'config':
    case 'vendored':
      return 'config';
    case 'example':
      return 'docs';
    default:
      return 'runtime';
  }
}
