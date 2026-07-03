/**
 * Source-graph → knowledge bridge (HOR-408).
 *
 * `horus init` analyses a repo with the source-intelligence backend
 * (`horus-source analyze`), producing a rich code graph: functions, classes,
 * interfaces, type aliases, enums, semantic communities, and execution-flow
 * processes. The first-version knowledge pass (`buildProjectKnowledge`) only
 * ever derived the per-repo *landscape* from dependency manifests, so every
 * other knowledge category (operations / types / enums / domainConcepts /
 * dataFlows / runtimeComponents / externalIntegrations) came out EMPTY even
 * though the graph was full of exactly that information — the analyse→KB bridge
 * dropped it on the floor (the symbols/graph/embeddings were never read back).
 *
 * This module is the missing bridge. It is PURE and local-first: it takes a
 * plain `SourceGraphExtract` (what the CLI pulls back over read-only Cypher from
 * the running host) and maps it onto the knowledge schema. Keeping it free of
 * any network/connector dependency means it round-trips a fixture in tests and
 * preserves the package's "no source-intelligence required" boundary — the CLI
 * owns the Cypher, this owns the honest mapping.
 *
 * Honesty: every produced item is `sourceType: 'parsed'` and cites the file +
 * line range it was extracted from. Nothing is invented; categories with no
 * matching graph nodes stay empty rather than being padded.
 */
import type {
  DomainConcept,
  EnumDefinition,
  ExternalIntegration,
  DataFlow,
  Operation,
  Provenance,
  RepositoryProfile,
  RuntimeComponent,
  TypeDefinition,
} from '../schema.js';

/** A code symbol pulled from the source graph (one Function/Class/Enum/... node). */
export interface SourceSymbolInput {
  /** Raw graph label, case-insensitive: function | method | class | interface | type_alias | enum. */
  label: string;
  name: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  /** Owning class for methods (graph `class_name`). */
  className?: string;
  signature?: string;
  /** Source-graph `is_exported` flag (the symbol is part of the module's public surface). */
  isExported?: boolean;
  /** Source-graph `is_entry_point` flag (a runtime entry point — route, command, main). */
  isEntryPoint?: boolean;
  /** Enum member names, when the label is `enum` and they could be parsed. */
  enumValues?: string[];
}

/** A semantic community (cluster of related code) — the graph's own domain grouping. */
export interface SourceCommunityInput {
  id?: string;
  name: string;
  summary?: string;
}

/** One ordered step of an execution-flow process. */
export interface SourceProcessStepInput {
  component: string;
  detail?: string;
}

/** A traced execution flow (a `Process` node + its ordered steps). */
export interface SourceProcessInput {
  id?: string;
  name: string;
  steps?: SourceProcessStepInput[];
}

/**
 * Everything the CLI reads back from a repo's analysed source graph. All fields
 * are optional so a partial pull (e.g. a backend that can't answer one query)
 * still bridges whatever it does have.
 */
export interface SourceGraphExtract {
  symbols?: SourceSymbolInput[];
  communities?: SourceCommunityInput[];
  processes?: SourceProcessInput[];
  /** Repository name the host serves — recorded on each item's scope/provenance. */
  repo?: string;
}

export interface SourceGraphMapOptions {
  project?: string;
  /** Repository the graph belongs to (overrides `extract.repo`). */
  repo?: string;
  gitSha?: string;
  now?: string;
  /**
   * Defensive per-category cap so a pathologically large monorepo can't write a
   * multi-hundred-MB knowledge base. Symbols are taken in graph order.
   */
  maxPerCategory?: number;
}

/** Categories this bridge can populate from the source graph. */
export interface SourceGraphKnowledge {
  operations: Operation[];
  types: TypeDefinition[];
  enums: EnumDefinition[];
  domainConcepts: DomainConcept[];
  dataFlows: DataFlow[];
  runtimeComponents: RuntimeComponent[];
}

const DEFAULT_MAX_PER_CATEGORY = 5000;

/**
 * Normalize a graph label to a lowercase, separator-free token so both the kùzu
 * table form (`TypeAlias`) and the model form (`type_alias`) collapse to the same
 * comparison key (`typealias`).
 */
function norm(label: string): string {
  return label.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** A non-empty, trimmed string, or undefined. */
function clean(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/**
 * Build per-item provenance: always `parsed`/`high`, citing the file + line
 * range the node was extracted from (omitting an empty line range so we never
 * cite a phantom `file:0`).
 */
function provenanceFor(
  sym: { filePath?: string; startLine?: number; endLine?: number },
  opts: SourceGraphMapOptions,
  repo: string | undefined,
): Provenance {
  const start = sym.startLine;
  const end = sym.endLine ?? sym.startLine;
  const hasRange =
    typeof start === 'number' && start > 0 && typeof end === 'number' && end >= start;
  return {
    sourceType: 'parsed',
    confidence: 'high',
    ...(repo ? { repo } : {}),
    ...(clean(sym.filePath) ? { filePath: sym.filePath } : {}),
    ...(hasRange ? { lineRange: [start as number, end as number] as [number, number] } : {}),
    ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
    ...(opts.now ? { generatedAt: opts.now } : {}),
  };
}

/** Stable scope for every item (project + repository), omitting empty parts. */
function scopeFor(opts: SourceGraphMapOptions, repo: string | undefined) {
  const scope: { project?: string; repository?: string } = {};
  if (opts.project) scope.project = opts.project;
  if (repo) scope.repository = repo;
  return Object.keys(scope).length ? scope : undefined;
}

/**
 * Map a source-graph extract onto knowledge categories. Pure: deterministic in,
 * deterministic out. IDs are stable + collision-resistant (kind:file:name).
 */
export function buildKnowledgeFromSourceGraph(
  extract: SourceGraphExtract,
  opts: SourceGraphMapOptions = {},
): SourceGraphKnowledge {
  const repo = clean(opts.repo) ?? clean(extract.repo);
  const cap = opts.maxPerCategory ?? DEFAULT_MAX_PER_CATEGORY;
  const scope = scopeFor(opts, repo);

  const operations: Operation[] = [];
  const types: TypeDefinition[] = [];
  const enums: EnumDefinition[] = [];
  const runtimeComponents: RuntimeComponent[] = [];

  // De-dupe by id: the graph can carry overloads / re-declarations that hash to
  // the same kind:file:name. First write wins (graph order is stable).
  const seen = { op: new Set<string>(), ty: new Set<string>(), en: new Set<string>(), rt: new Set<string>() };

  const idFor = (kind: string, sym: SourceSymbolInput, displayName: string): string =>
    `${kind}:${sym.filePath ?? ''}:${displayName}`;

  for (const sym of extract.symbols ?? []) {
    const label = norm(sym.label);
    const name = clean(sym.name);
    if (!name) continue;
    const prov = provenanceFor(sym, opts, repo);

    if (label === 'class' || label === 'interface' || label === 'typealias') {
      if (types.length >= cap) continue;
      // class → object, interface → interface, type_alias → alias (kind is free-form).
      const kind = label === 'typealias' ? 'alias' : label === 'interface' ? 'interface' : 'object';
      const id = idFor('type', sym, name);
      if (seen.ty.has(id)) continue;
      seen.ty.add(id);
      types.push({
        id,
        ...(scope ? { scope } : {}),
        provenance: prov,
        name,
        kind,
        fields: [],
        ...(clean(sym.filePath) ? { sourceFile: sym.filePath } : {}),
      });
      continue;
    }

    if (label === 'enum') {
      if (enums.length >= cap) continue;
      const id = idFor('enum', sym, name);
      if (seen.en.has(id)) continue;
      seen.en.add(id);
      enums.push({
        id,
        ...(scope ? { scope } : {}),
        provenance: prov,
        name,
        values: (sym.enumValues ?? []).map((v) => v.trim()).filter(Boolean),
        ...(clean(sym.filePath) ? { sourceFile: sym.filePath } : {}),
      });
      continue;
    }

    if (label === 'function' || label === 'method') {
      // Methods carry their owning class so `Service.create` reads unambiguously.
      const displayName =
        label === 'method' && clean(sym.className) ? `${sym.className}.${name}` : name;

      if (operations.length < cap) {
        const id = idFor('operation', sym, displayName);
        if (!seen.op.has(id)) {
          seen.op.add(id);
          operations.push({
            id,
            ...(scope ? { scope } : {}),
            provenance: prov,
            name: displayName,
            kind: label, // function | method
            protocol: 'function',
            args: [],
            ...(clean(sym.filePath) ? { resolverFile: sym.filePath } : {}),
          });
        }
      }

      // Runtime entry points (a `main`, a route handler, a CLI command, a worker)
      // are the repo's runtime surface — surface them separately, honestly tagged.
      if (sym.isEntryPoint && runtimeComponents.length < cap) {
        const id = idFor('runtime', sym, displayName);
        if (!seen.rt.has(id)) {
          seen.rt.add(id);
          runtimeComponents.push({
            id,
            ...(scope ? { scope } : {}),
            provenance: prov,
            name: displayName,
            type: 'function',
            ...(repo ? { repo } : {}),
            entrypoints: clean(sym.filePath) ? [sym.filePath as string] : [],
          });
        }
      }
    }
  }

  // Communities → domain concepts: the graph's own semantic grouping of code is
  // the closest honest analogue to a "domain concept" (inferred, not parsed).
  const domainConcepts: DomainConcept[] = [];
  const seenDc = new Set<string>();
  for (const c of extract.communities ?? []) {
    if (domainConcepts.length >= cap) break;
    const name = clean(c.name);
    if (!name) continue;
    const id = `domain:${clean(c.id) ?? name}`;
    if (seenDc.has(id)) continue;
    seenDc.add(id);
    domainConcepts.push({
      id,
      ...(scope ? { scope } : {}),
      // A community is a derived clustering, not a parsed source span (honesty).
      provenance: {
        sourceType: 'inferred',
        confidence: 'medium',
        ...(repo ? { repo } : {}),
        ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
        ...(opts.now ? { generatedAt: opts.now } : {}),
      },
      name,
      ...(clean(c.summary) ? { summary: c.summary } : {}),
      relatedOperations: [],
      relatedTypes: [],
    });
  }

  // Processes → data flows: a `Process` is a traced ordered path through the code.
  const dataFlows: DataFlow[] = [];
  const seenFlow = new Set<string>();
  for (const p of extract.processes ?? []) {
    if (dataFlows.length >= cap) break;
    const name = clean(p.name);
    if (!name) continue;
    const id = `flow:${clean(p.id) ?? name}`;
    if (seenFlow.has(id)) continue;
    seenFlow.add(id);
    dataFlows.push({
      id,
      ...(scope ? { scope } : {}),
      provenance: {
        sourceType: 'inferred',
        confidence: 'medium',
        ...(repo ? { repo } : {}),
        ...(opts.gitSha ? { gitSha: opts.gitSha } : {}),
        ...(opts.now ? { generatedAt: opts.now } : {}),
      },
      name,
      steps: (p.steps ?? [])
        .map((s) => ({ component: clean(s.component) ?? '', ...(clean(s.detail) ? { detail: s.detail } : {}) }))
        .filter((s) => s.component),
      sources: [],
      sinks: [],
    });
  }

  return { operations, types, enums, domainConcepts, dataFlows, runtimeComponents };
}

/**
 * Derive external integrations from the per-repo landscape profiles (data
 * sources + third-party integrations the manifest analysis already detected).
 * These are genuine external systems the project talks to, so surfacing them as
 * `ExternalIntegration` items makes the runtime map non-empty without inventing
 * anything — provenance stays tied to the profile's manifest.
 */
export function deriveExternalIntegrations(
  profiles: RepositoryProfile[],
): ExternalIntegration[] {
  const byName = new Map<string, ExternalIntegration>();
  for (const profile of profiles) {
    const repo = profile.key || profile.name;
    const add = (name: string, kind: string): void => {
      const clean0 = name.trim();
      if (!clean0) return;
      const id = `integration:${clean0}`;
      const existing = byName.get(id);
      if (existing) {
        if (!existing.usedBy.includes(repo)) existing.usedBy.push(repo);
        return;
      }
      byName.set(id, {
        id,
        ...(profile.scope ? { scope: profile.scope } : {}),
        // Inherit the profile's manifest provenance — same source, same honesty.
        provenance: { ...profile.provenance, sourceType: 'parsed' },
        name: clean0,
        kind,
        usedBy: [repo],
      });
    };
    for (const ds of profile.dataSources) add(ds, 'db');
    for (const integ of profile.integrations) add(integ, 'api');
  }
  return [...byName.values()];
}
