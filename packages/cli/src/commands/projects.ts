/**
 * `horus projects` — list projects registered in the global registry (HOR-37).
 */

import pc from 'picocolors';
import { readRegistry } from '@horus/core';

export async function runProjects(): Promise<number> {
  const reg = readRegistry();
  const names = Object.keys(reg.projects).sort();

  if (names.length === 0) {
    console.log(
      pc.dim('No registered projects. Run `horus init` inside a repo.'),
    );
    return 0;
  }

  console.log(pc.bold('Registered Horus projects'));
  console.log('');
  for (const name of names) {
    const entry = reg.projects[name];
    if (entry === undefined) continue;
    console.log(`  ${pc.bold(name.padEnd(22))} ${pc.dim(entry.root)}`);
  }
  console.log('');
  console.log(pc.dim('  horus investigate --name <name> "<hint>"'));
  return 0;
}
