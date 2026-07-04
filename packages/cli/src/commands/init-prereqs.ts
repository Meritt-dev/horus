/**
 * Prerequisite check for `horus init` (HOR-37, HOR-84): the Horus
 * source-intelligence backend. Advisory only — the check prints a status line
 * and guides fixes, but never gates init's exit code (config write and indexing
 * degrade gracefully instead).
 *
 * Local persistence is embedded (pglite) — there is no Postgres to check. The old
 * standalone `horus setup` command was merged into `horus init` and then removed
 * entirely — `horus init` is the only onboarding command.
 */

import pc from 'picocolors';
import { PINNED_SOURCE_VERSION, SOURCE_PIN_ENFORCED } from '@horus/core';
import { getSourceVersion } from '@horus/connectors';

export interface PrereqStatus {
  /** horus-source binary responded with a version. */
  backendPresent: boolean;
  /** Version matches the pin (false when absent or drifted). */
  backendVersionOk: boolean;
}

export async function checkPrerequisites(
  opts: { config?: string; write?: (line: string) => void } = {},
): Promise<PrereqStatus> {
  const write = opts.write ?? ((line: string) => console.log(line));
  const status: PrereqStatus = {
    backendPresent: false,
    backendVersionOk: false,
  };

  // 1. Source-intelligence backend — presence and version.
  let backendVersion: string | null = null;
  try {
    backendVersion = await getSourceVersion();
  } catch {
    // Probe failure reads as "not found" — advisory either way.
  }
  if (backendVersion === null) {
    write(`  ${pc.red('●')} Horus source-intelligence backend not found`);
    write(
      pc.dim(
        `      install it (Python 3.11+ required):\n` +
        `        curl -fsSL https://horus.sh/install.sh | bash\n` +
        `      ensure ~/.local/bin is on your PATH`,
      ),
    );
  } else if (SOURCE_PIN_ENFORCED && backendVersion !== PINNED_SOURCE_VERSION) {
    status.backendPresent = true;
    write(
      `  ${pc.yellow('●')} Horus source-intelligence backend version mismatch` +
      pc.dim(` (installed: ${backendVersion}, required: ${PINNED_SOURCE_VERSION})`),
    );
    write(
      pc.dim(
        `      update it:\n` +
        `        horus update`,
      ),
    );
  } else {
    status.backendPresent = true;
    status.backendVersionOk = true;
    write(
      `  ${pc.green('●')} Horus source-intelligence backend ` +
      pc.dim(`(${backendVersion})`),
    );
  }

  return status;
}
