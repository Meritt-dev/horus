// Injected at build time from apps/horus/package.json via tsup define.
// Falls back to 'dev' in test environments where the define is not applied.
declare const __HORUS_VERSION__: string | undefined;
export const HORUS_VERSION: string = typeof __HORUS_VERSION__ !== 'undefined' ? __HORUS_VERSION__ : 'dev';

/**
 * The exact source-intelligence backend version Horus is validated and pinned against.
 * The source provider asserts the running backend matches this (see architecture.md §1,
 * risk R4). A drifted build must fail loudly rather than silently mis-map results.
 *
 * The backend ships INSIDE the horus bundle (built from packages/source-py at release
 * time, installed from the bundled wheel — no PyPI), so the pin IS the horus version:
 * one bundle, one version.
 */
export const PINNED_SOURCE_VERSION: string = HORUS_VERSION;

/**
 * Whether the pin is enforceable. In unbundled dev/test runs HORUS_VERSION is 'dev',
 * which matches no real backend — enforcing it would block every dev-mode host spawn
 * and reuse. Compatibility checks treat an unenforced pin as matching.
 */
export const SOURCE_PIN_ENFORCED: boolean = HORUS_VERSION !== 'dev';
