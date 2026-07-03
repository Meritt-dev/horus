import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/**
 * pglite (the embedded local database) loads its WASM/FS assets at runtime via
 * `new URL("./pglite.wasm", import.meta.url)`. Once bundled into the single-file
 * `dist/index.cjs`, that base resolves to the bundle's own directory — so the assets
 * MUST sit next to index.cjs. tsup/esbuild bundles the JS but never copies these binary
 * assets, so we copy them here after the build (and ship them via `files: ["dist"]`).
 */
const PGLITE_ASSETS = ['pglite.wasm', 'pglite.data', 'initdb.wasm'];

function copyPgliteAssets(): void {
  const require = createRequire(import.meta.url);
  // Resolve the pglite package's dist directory from its main entry.
  const pgliteDist = dirname(require.resolve('@electric-sql/pglite'));
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'dist');
  mkdirSync(outDir, { recursive: true });
  for (const asset of PGLITE_ASSETS) {
    copyFileSync(join(pgliteDist, asset), join(outDir, asset));
  }
  console.log(`[tsup] copied ${PGLITE_ASSETS.length} pglite asset(s) into dist/`);
}

/**
 * The source-intelligence backend ships INSIDE the bundle as a Python wheel
 * (one bundle, one version — no PyPI). scripts/release/build-source-wheel.sh
 * builds it into packages/source-py/dist/horus_source.whl before the app
 * build; here we place it next to index.cjs so `files: ["dist"]` publishes it
 * and `horus update` installs from it. Absent in plain dev builds — skipped
 * with a note (the CLI degrades to the installer hint).
 */
function copyBundledSourceWheel(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const wheel = join(here, '..', '..', 'packages', 'source-py', 'dist', 'horus_source.whl');
  const outDir = join(here, 'dist');
  if (!existsSync(wheel)) {
    console.log('[tsup] no bundled source wheel (dev build) — run scripts/release/build-source-wheel.sh to include it');
    return;
  }
  mkdirSync(outDir, { recursive: true });
  copyFileSync(wheel, join(outDir, 'horus_source.whl'));
  console.log('[tsup] copied bundled source wheel into dist/');
}

export default defineConfig({
  entry: ['src/index.ts'],
  // Source is ESM ("type":"module" in package.json); tsup emits CJS.
  // The .cjs extension tells Node to run it as CommonJS regardless of
  // the package-level "type":"module", so require() and built-ins work.
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  platform: 'node',
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  shims: true,
  define: {
    __HORUS_VERSION__: JSON.stringify(version),
    // Marks the single-file bundle so runtime code can tell it's packaged (vs. running
    // from unbundled source/tests). The db layer uses this to decide where pglite's
    // WASM/FS assets must live — next to this bundle — and to fail gracefully if absent.
    __HORUS_BUNDLED__: 'true',
  },
  // Bundle all npm + workspace deps — output is self-contained.
  // Node.js built-ins stay external (platform:'node' ensures this).
  noExternal: [/.*/],
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Ship pglite's WASM/FS assets next to the bundle (see note above).
  async onSuccess() {
    copyPgliteAssets();
    copyBundledSourceWheel();
  },
});
