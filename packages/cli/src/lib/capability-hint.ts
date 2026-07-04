import pc from 'picocolors';
import { indexCapabilityStale } from '@horus/connectors';
import { EXPECTED_INDEX_CAPABILITY } from '@horus/core';
import { repoRootOrCwd } from './cloud/session.js';

/**
 * The single line rendered when an inheritance-dependent command runs against an index
 * that predates inheritance-aware blast radius (D6). Kept as one string so blast-radius
 * and explain stay byte-identical.
 */
export const CAPABILITY_HINT_TEXT =
  'Index predates inheritance-aware blast radius — subclasses/implementors may be missing. ' +
  'Run `horus init --reindex` to complete them.';

/** True when the seed's node id denotes a class or interface (the only inheritance-bearing seeds). */
export function isInheritanceSeed(seedId: string | undefined): boolean {
  if (!seedId) return false;
  return seedId.startsWith('class:') || seedId.startsWith('interface:');
}

/**
 * Print ONE dim reindex hint when (a) the seed is a class/interface — the only seeds with
 * subtypes — and (b) the on-disk index's capability stamp is below the current expectation
 * (built by a pre-B3.4 host, so its blast radius omits inheritance edges). Never blocks;
 * suppressed under --json (the caller must pass `json`), and a no-op when there is no local
 * index/meta to be stale about.
 *
 * @param seedId  the resolved seed's node id (`class:...` / `interface:...` / `function:...`).
 * @param opts.json  when true, print nothing — machine output must not carry prose.
 */
export function printCapabilityHint(
  seedId: string | undefined,
  opts: { json?: boolean } = {},
): void {
  if (opts.json) return;
  if (!isInheritanceSeed(seedId)) return;
  const root = repoRootOrCwd();
  if (!indexCapabilityStale(root, EXPECTED_INDEX_CAPABILITY)) return;
  console.log(pc.dim(`  ${CAPABILITY_HINT_TEXT}`));
}
