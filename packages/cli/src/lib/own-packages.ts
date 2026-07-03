/**
 * Manifest-derived package names of the CURRENT repo (dogfood cycle-2 N2).
 *
 * External-system detection matches content markers ("fastapi", "redis", ...) and must
 * skip the repo's OWN package — but the horus project label is often not the package
 * name (a project registered as `df2-fastapi` still IS the `fastapi` package, which
 * then listed ITSELF as an external system). Read the real names from the manifests.
 * Best-effort: unreadable/missing manifests contribute nothing.
 */

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

/** Detect this repo's package names from its manifests (+ the directory basename). */
export function detectOwnPackages(repoRoot: string): string[] {
  const names = new Set<string>();

  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };

  // package.json — strip a scope (@org/name → name matches content markers).
  const pkg = read('package.json');
  if (pkg !== null) {
    try {
      const name = (JSON.parse(pkg) as { name?: string }).name;
      if (typeof name === 'string' && name !== '') {
        names.add(name);
        const bare = name.split('/').pop();
        if (bare) names.add(bare);
      }
    } catch {
      /* malformed manifest — skip */
    }
  }

  // pyproject.toml — [project] name = "..." (PEP 621), or poetry's [tool.poetry] name.
  const pyproject = read('pyproject.toml');
  if (pyproject !== null) {
    const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject);
    if (m?.[1]) names.add(m[1]);
  }

  // go.mod — module github.com/org/name → name.
  const gomod = read('go.mod');
  if (gomod !== null) {
    const m = /^module\s+(\S+)/m.exec(gomod);
    const tail = m?.[1]?.split('/').pop();
    if (tail) names.add(tail);
  }

  // Cargo.toml — [package] name = "...".
  const cargo = read('Cargo.toml');
  if (cargo !== null) {
    const m = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo);
    if (m?.[1]) names.add(m[1]);
  }

  // The directory basename is a decent last-resort candidate (clone dir = package).
  const dir = basename(repoRoot);
  if (dir !== '') names.add(dir);

  return [...names];
}
