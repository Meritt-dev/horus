import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import type { Symbol } from '@horus/core';
import { listInvestigations, listInvestigationsWithReports } from '@horus/db';
import { discoverArchitecture, type ArchitectureModel } from './architecture.js';
import { estimateOwnership, type OwnershipEstimate } from './ownership.js';
import { deriveTags } from './memory.js';
import type { InvestigationReport } from './types.js';

export interface PastIncident {
  id: string;
  title: string;
  createdAt: string | null;
}

export interface OnboardingGuide {
  area: string | null;
  architecture: ArchitectureModel;
  ownership: OwnershipEstimate | null;
  pastIncidents: PastIncident[];
  summary: string;
}

/** Tokenize a string into lowercase alphanumeric words, splitting camelCase/PascalCase. */
function tokenize(text: string): string[] {
  const withSpaces = text
    .replace(/[^a-zA-Z0-9/_.-]+/g, ' ')
    // Split camelCase / PascalCase transitions.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const parts = withSpaces.toLowerCase().split(/[\s/_.-]+/).filter((t) => t.length > 0);
  return [...new Set(parts)];
}

/** Generic programming/directory tokens that are not useful for area filtering. */
const GENERIC_PATH_TOKENS = new Set([
  'src',
  'lib',
  'app',
  'test',
  'tests',
  'spec',
  'dist',
  'node',
  'modules',
  'common',
  'shared',
  'public',
  'private',
  'types',
  'interfaces',
  'constants',
  'config',
  'index',
  'main',
  'server',
  'client',
  'api',
  'http',
  'db',
  'database',
  'model',
  'models',
  'schema',
  'migration',
  'seed',
  'fixture',
  'mock',
  'hook',
  'context',
  'provider',
  'factory',
  'middleware',
  'route',
  'router',
  'routes',
  'service',
  'services',
  'controller',
  'controllers',
  'resolver',
  'resolvers',
  'worker',
  'workers',
  'helper',
  'helpers',
  'util',
  'utils',
]);

/** Build a relevance token set from the area string and resolved symbols.
 *  The area tokens are always kept; symbol/path tokens are filtered to avoid
 *  generic programming terms (e.g. "service", "src") that would produce false
 *  positives when filtering architecture components.
 */
export function buildAreaTokens(area: string, symbols: Symbol[]): Set<string> {
  const tokens = new Set<string>(tokenize(area));
  for (const sym of symbols) {
    for (const t of tokenize(sym.name)) {
      if (t.length >= 3 && !GENERIC_PATH_TOKENS.has(t)) tokens.add(t);
    }
    for (const t of tokenize(sym.filePath)) {
      if (t.length >= 3 && !GENERIC_PATH_TOKENS.has(t)) tokens.add(t);
    }
  }
  return tokens;
}

/** True when text contains at least one area token. */
export function matchesArea(text: string, tokens: Set<string>): boolean {
  const textTokens = new Set(tokenize(text));
  for (const t of tokens) {
    if (textTokens.has(t)) return true;
  }
  return false;
}

/** Score a symbol by how many area tokens appear in its name/path. */
function areaMatchScore(symbol: Symbol, tokens: Set<string>): number {
  let score = 0;
  const nameTokens = tokenize(symbol.name);
  const pathTokens = tokenize(symbol.filePath);
  for (const t of tokens) {
    if (nameTokens.includes(t)) score += 2;
    if (pathTokens.includes(t)) score += 1;
  }
  return score;
}

/** Pick the symbol that best matches the area string from a search result. */
export function bestAreaSymbol(area: string, symbols: Symbol[]): Symbol | null {
  if (symbols.length === 0) return null;
  const areaOnlyTokens = new Set(tokenize(area));
  let best: Symbol | null = null;
  let bestScore = -1;
  for (const sym of symbols) {
    const score = areaMatchScore(sym, areaOnlyTokens);
    if (score > bestScore) {
      bestScore = score;
      best = sym;
    }
  }
  return best;
}

/** Filter architecture components to those whose names overlap with the area tokens. */
export function filterArchitecture(
  architecture: ArchitectureModel,
  tokens: Set<string>,
): ArchitectureModel {
  return {
    ...architecture,
    subsystems: architecture.subsystems.filter((s) => matchesArea(s.name, tokens)),
    asyncBoundaries: architecture.asyncBoundaries.filter(
      (b) =>
        matchesArea(b.queueName, tokens) ||
        b.producers.some((p) => matchesArea(p.symbol, tokens)) ||
        b.workers.some((w) => matchesArea(w.symbol, tokens)),
    ),
    keyFlows: architecture.keyFlows.filter((f) => matchesArea(f, tokens)),
    externalSystems: architecture.externalSystems.filter((e) => matchesArea(e.name, tokens)),
  };
}

export async function buildOnboarding(
  input: { area?: string },
  deps: { code: CodeProvider; db: HorusDb; repoPath: string; project?: string },
): Promise<OnboardingGuide> {
  const architecture = await discoverArchitecture({
    code: deps.code,
    db: deps.db,
    project: deps.project,
  });

  const area = input.area?.trim();
  let filteredArchitecture = architecture;
  let pastIncidents: PastIncident[] = [];
  let areaSymbol: Symbol | null = null;

  if (area != null && area !== '') {
    // Resolve area to candidate symbols once; reuse the token set for every filter.
    const symbols = await deps.code.searchSymbols(area, 20);
    const tokens = buildAreaTokens(area, symbols);
    areaSymbol = bestAreaSymbol(area, symbols);
    filteredArchitecture = filterArchitecture(architecture, tokens);

    // Past incidents: prefer reports with tag overlap, fall back to title matching.
    const invs = await listInvestigationsWithReports(deps.db, 50, { project: deps.project });
    const areaTokenArray = [...tokens];
    const seenIds = new Set<string>();

    for (const inv of invs) {
      if (!inv.report || seenIds.has(inv.id)) continue;
      seenIds.add(inv.id);

      let relevant = false;
      try {
        const report = inv.report as InvestigationReport;
        const tags = deriveTags(report);
        const tagSet = new Set(tags.map((t) => t.toLowerCase()));
        relevant = areaTokenArray.some((t) => tagSet.has(t.toLowerCase()));
      } catch {
        relevant = false;
      }

      if (!relevant && inv.title != null) {
        relevant = matchesArea(inv.title, tokens);
      }

      if (relevant) {
        pastIncidents.push({
          id: inv.id,
          title: inv.title,
          createdAt: inv.createdAt != null ? new Date(inv.createdAt).toISOString() : null,
        });
      }
    }

    pastIncidents = pastIncidents.slice(0, 8);
  } else {
    // No area supplied — show the whole-repo view as before.
    const invs = await listInvestigations(deps.db, 8, { project: deps.project });
    pastIncidents = invs.map((i) => ({
      id: i.id,
      title: i.title,
      createdAt: i.createdAt != null ? new Date(i.createdAt).toISOString() : null,
    }));
  }

  const ownership =
    area != null && area !== ''
      ? await estimateOwnership(area, {
          code: deps.code,
          repoPath: deps.repoPath,
          symbol: areaSymbol,
        })
      : null;

  const largestName = filteredArchitecture.subsystems[0]?.name ?? 'n/a';
  const summary =
    (area != null ? 'Onboarding for "' + area + '": ' : 'System onboarding: ') +
    filteredArchitecture.subsystems.length +
    ' subsystems (largest ' +
    largestName +
    '), ' +
    filteredArchitecture.asyncBoundaries.length +
    ' async queue boundaries, ' +
    filteredArchitecture.externalSystems.length +
    ' external systems, ' +
    pastIncidents.length +
    ' past investigation(s) on record.' +
    (area != null ? ' Filtered toward "' + area + '".' : '');

  return {
    area: area ?? null,
    architecture: filteredArchitecture,
    ownership,
    pastIncidents,
    summary,
  };
}
