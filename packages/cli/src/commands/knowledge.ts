/**
 * `horus knowledge` — query the local `.horus/index/` project-knowledge snapshot
 * built by `horus init` (HOR-294). Offline / local-only: never touches Cloud.
 *
 * Subcommands:
 *   status     — last indexed commit, schema version, generated time, stale/dirty
 *   search     — keyword search across operations/concepts/patterns/runtime/etc.
 *   contracts  — operations/types/enums/auth rules, verbatim (no hallucinated values)
 *   trace      — walk known concept ↔ operation ↔ type / data-flow links
 *   ask        — grounded, retrieval-based answer from the index, with provenance
 *   validate   — schema + content-hash + staleness check (pre-push-friendly)
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pc from 'picocolors';
import { findRepoRoot, getHeadSha, isWorkingTreeDirty } from '@horus/core';
import {
  createJsonKnowledgeStore,
  searchSnapshot,
  knowledgePath,
  KnowledgeSnapshotSchema,
  KnowledgeManifestSchema,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeSnapshot,
  type KnowledgeManifest,
} from '@horus/knowledge';

export interface KnowledgeOpts {
  /** Repo root (defaults to the discovered repo root / cwd). */
  root?: string;
  /** Cap on results for search/ask. */
  limit?: number;
}

function resolveRoot(opts: KnowledgeOpts): string {
  if (opts.root) return opts.root;
  const cwd = process.cwd();
  return findRepoRoot(cwd) ?? cwd;
}

function noIndexMessage(root: string): void {
  console.log(pc.yellow('No project-knowledge index found.'));
  console.log(pc.dim(`  Expected ${root}/.horus/index/. Run ${pc.bold('horus init')} to build one.`));
}

interface Loaded {
  root: string;
  snapshot: KnowledgeSnapshot;
  manifest: KnowledgeManifest | null;
}

function load(opts: KnowledgeOpts): Loaded | null {
  const root = resolveRoot(opts);
  const store = createJsonKnowledgeStore(root);
  if (!store.exists()) return null;
  const snapshot = store.readSnapshot();
  if (!snapshot) return null;
  return { root, snapshot, manifest: store.readManifest() };
}

function short(sha?: string | null): string {
  return sha ? sha.slice(0, 8) : '—';
}

/** Staleness/dirty warnings comparing the index's git state to the working tree. */
function stalenessWarnings(root: string, manifest: KnowledgeManifest | null): string[] {
  const warnings: string[] = [];
  const indexedSha = manifest?.git?.sha;
  const currentSha = getHeadSha(root) ?? undefined;
  if (indexedSha && currentSha && indexedSha !== currentSha) {
    warnings.push(`index is stale: built at ${short(indexedSha)}, repo is now at ${short(currentSha)} — re-run \`horus init\``);
  }
  if (isWorkingTreeDirty(root) === true) {
    warnings.push('working tree is dirty (uncommitted changes) — knowledge may not reflect local edits');
  }
  return warnings;
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.log(pc.yellow(`⚠ ${w}`));
}

function provenanceRef(item: Record<string, unknown>): string {
  const p = item.provenance as Record<string, unknown> | undefined;
  if (!p) return '';
  const parts: string[] = [];
  if (typeof p.filePath === 'string') parts.push(p.filePath);
  if (typeof p.sourceType === 'string') parts.push(p.sourceType);
  if (typeof p.confidence === 'string') parts.push(`${p.confidence} confidence`);
  return parts.length ? pc.dim(`    ↳ ${parts.join(' · ')}`) : '';
}

// ── status ──────────────────────────────────────────────────────────────────

export function runKnowledgeStatus(opts: KnowledgeOpts = {}): number {
  const root = resolveRoot(opts);
  const store = createJsonKnowledgeStore(root);
  if (!store.exists()) {
    noIndexMessage(root);
    return 0;
  }
  const manifest = store.readManifest();
  const snapshot = store.readSnapshot();
  if (!manifest || !snapshot) {
    console.log(pc.red('Knowledge index is present but unreadable. Run `horus knowledge validate`.'));
    return 1;
  }

  console.log(pc.bold('Project knowledge index'));
  if (manifest.project) console.log(`  project:        ${manifest.project}`);
  console.log(`  generator:      ${manifest.generator.tool}${manifest.generator.version ? `@${manifest.generator.version}` : ''}`);
  console.log(`  schema version: ${manifest.schemaVersion}`);
  console.log(`  generated:      ${manifest.generatedAt}`);
  console.log(`  last commit:    ${short(manifest.git?.sha)}${manifest.git?.branch ? ` (${manifest.git.branch})` : ''}`);

  const counts = Object.entries(manifest.counts).filter(([, n]) => n > 0);
  const total = Object.values(manifest.counts).reduce((a, b) => a + b, 0);
  console.log(`  items:          ${total} (${counts.map(([k, n]) => `${k}: ${n}`).join(', ') || 'empty'})`);

  const warnings = stalenessWarnings(root, manifest);
  if (warnings.length) {
    console.log('');
    printWarnings(warnings);
  } else {
    console.log(pc.green('  ✓ up to date with HEAD'));
  }
  console.log(pc.dim(`\nNext: ${pc.bold('horus knowledge search "<query>"')} · ${pc.bold('horus knowledge validate')}`));
  return 0;
}

// ── search ──────────────────────────────────────────────────────────────────

export function runKnowledgeSearch(query: string, opts: KnowledgeOpts = {}): number {
  const loaded = load(opts);
  if (!loaded) {
    noIndexMessage(resolveRoot(opts));
    return 1;
  }
  const matches = searchSnapshot(loaded.snapshot, query, { limit: opts.limit ?? 25 });
  if (matches.length === 0) {
    console.log(pc.yellow(`No matches for "${query}".`));
    console.log(pc.dim('Try a broader term, or run `horus init` if the project changed.'));
    return 0;
  }
  console.log(pc.bold(`${matches.length} match(es) for "${query}":`));
  for (const m of matches) {
    console.log(`  ${pc.cyan(`[${m.category}]`)} ${pc.bold(m.name)} ${pc.dim(m.id)}`);
    const ref = provenanceRef(m.item);
    if (ref) console.log(ref);
  }
  const warnings = stalenessWarnings(loaded.root, loaded.manifest);
  if (warnings.length) {
    console.log('');
    printWarnings(warnings);
  }
  return 0;
}

// ── contracts ─────────────────────────────────────────────────────────────────

const CONTRACT_CATEGORIES = ['operations', 'types', 'enums', 'authRules'] as const;

export function runKnowledgeContracts(name: string, opts: KnowledgeOpts = {}): number {
  const loaded = load(opts);
  if (!loaded) {
    noIndexMessage(resolveRoot(opts));
    return 1;
  }
  const needle = name.trim().toLowerCase();
  const snap = loaded.snapshot;
  let found = 0;

  const printOp = (o: Record<string, unknown>) => {
    console.log(`  ${pc.cyan('operation')} ${pc.bold(String(o.name))}${o.kind ? pc.dim(` (${o.kind})`) : ''}`);
    if (o.domain) console.log(pc.dim(`    domain: ${o.domain}`));
    const args = Array.isArray(o.args) ? (o.args as Record<string, unknown>[]) : [];
    if (args.length) console.log(`    args: ${args.map((a) => `${a.name}: ${a.type}${a.nullable === false ? '!' : ''}`).join(', ')}`);
    if (o.returnType) console.log(`    returns: ${o.returnType}`);
    const auth = o.auth as Record<string, unknown> | undefined;
    if (auth) console.log(`    auth: ${auth.required ? 'required' : 'public'}${Array.isArray(auth.roles) && auth.roles.length ? ` [${auth.roles.join(', ')}]` : ''}`);
    const ref = provenanceRef(o);
    if (ref) console.log(ref);
  };
  const printType = (t: Record<string, unknown>) => {
    console.log(`  ${pc.cyan('type')} ${pc.bold(String(t.name))}${t.kind ? pc.dim(` (${t.kind})`) : ''}`);
    const fields = Array.isArray(t.fields) ? (t.fields as Record<string, unknown>[]) : [];
    for (const f of fields) console.log(`    ${f.name}: ${f.type}${f.nullable === false ? '!' : ''}`);
    const ref = provenanceRef(t);
    if (ref) console.log(ref);
  };
  const printEnum = (e: Record<string, unknown>) => {
    console.log(`  ${pc.cyan('enum')} ${pc.bold(String(e.name))}`);
    const values = Array.isArray(e.values) ? (e.values as string[]) : [];
    console.log(`    values: ${values.join(' | ') || '—'}`);
    const ref = provenanceRef(e);
    if (ref) console.log(ref);
  };
  const printAuth = (a: Record<string, unknown>) => {
    console.log(`  ${pc.cyan('auth rule')} ${pc.bold(String(a.subject))} — ${a.required ? 'required' : 'public'}${Array.isArray(a.roles) && a.roles.length ? ` [${a.roles.join(', ')}]` : ''}`);
  };

  const match = (item: Record<string, unknown>) =>
    String(item.name ?? '').toLowerCase().includes(needle) ||
    String(item.subject ?? '').toLowerCase().includes(needle) ||
    String(item.id ?? '').toLowerCase().includes(needle);

  for (const o of snap.operations as Record<string, unknown>[]) if (match(o)) { printOp(o); found++; }
  for (const t of snap.types as Record<string, unknown>[]) if (match(t)) { printType(t); found++; }
  for (const e of snap.enums as Record<string, unknown>[]) if (match(e)) { printEnum(e); found++; }
  for (const a of snap.authRules as Record<string, unknown>[]) if (match(a)) { printAuth(a); found++; }

  void CONTRACT_CATEGORIES;
  if (found === 0) {
    console.log(pc.yellow(`No contracts matching "${name}".`));
    console.log(pc.dim('`horus knowledge search` searches all categories.'));
    return 0;
  }
  printWarnings(stalenessWarnings(loaded.root, loaded.manifest));
  return 0;
}

// ── trace ─────────────────────────────────────────────────────────────────────

export function runKnowledgeTrace(query: string, opts: KnowledgeOpts = {}): number {
  const loaded = load(opts);
  if (!loaded) {
    noIndexMessage(resolveRoot(opts));
    return 1;
  }
  const snap = loaded.snapshot;
  const q = query.trim().toLowerCase();
  const named = (arr: Record<string, unknown>[]) =>
    arr.find((i) => String(i.name ?? '').toLowerCase().includes(q) || String(i.slug ?? '').toLowerCase().includes(q));

  // Prefer a domain concept (it carries explicit related links), else an operation.
  const concept = named(snap.domainConcepts as Record<string, unknown>[]);
  if (concept) {
    console.log(pc.bold(`Concept: ${concept.name}`));
    if (concept.summary) console.log(pc.dim(`  ${concept.summary}`));
    const ops = Array.isArray(concept.relatedOperations) ? (concept.relatedOperations as string[]) : [];
    const types = Array.isArray(concept.relatedTypes) ? (concept.relatedTypes as string[]) : [];
    if (ops.length) console.log(`  → operations: ${ops.join(', ')}`);
    if (types.length) console.log(`  → types: ${types.join(', ')}`);
    printWarnings(stalenessWarnings(loaded.root, loaded.manifest));
    return 0;
  }

  const op = named(snap.operations as Record<string, unknown>[]);
  if (op) {
    console.log(pc.bold(`Operation: ${op.name}`));
    if (op.returnType) console.log(`  → returns: ${op.returnType}`);
    const usedBy = (snap.domainConcepts as Record<string, unknown>[]).filter((c) =>
      Array.isArray(c.relatedOperations) && (c.relatedOperations as string[]).includes(String(op.name)),
    );
    if (usedBy.length) console.log(`  ← concepts: ${usedBy.map((c) => c.name).join(', ')}`);
    printWarnings(stalenessWarnings(loaded.root, loaded.manifest));
    return 0;
  }

  // Fall back to any data flow whose name matches.
  const flow = named(snap.dataFlows as Record<string, unknown>[]);
  if (flow) {
    console.log(pc.bold(`Data flow: ${flow.name}`));
    const steps = Array.isArray(flow.steps) ? (flow.steps as Record<string, unknown>[]) : [];
    for (const s of steps) console.log(`  → ${s.component}${s.action ? `: ${s.action}` : ''}`);
    return 0;
  }

  console.log(pc.yellow(`Nothing to trace for "${query}".`));
  console.log(pc.dim('Trace walks domain concepts, operations, and data flows. Try `horus knowledge search`.'));
  return 0;
}

// ── ask ───────────────────────────────────────────────────────────────────────

export function runKnowledgeAsk(question: string, opts: KnowledgeOpts = {}): number {
  const loaded = load(opts);
  if (!loaded) {
    noIndexMessage(resolveRoot(opts));
    return 1;
  }
  // Grounded retrieval: answer ONLY from indexed items (offline, no hallucination).
  // Search the whole question, then each significant term, and merge by id.
  const terms = [question, ...question.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 4)];
  const seen = new Set<string>();
  const hits: ReturnType<typeof searchSnapshot> = [];
  for (const term of terms) {
    for (const m of searchSnapshot(loaded.snapshot, term, { limit: 10 })) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        hits.push(m);
      }
    }
    if (hits.length >= (opts.limit ?? 8)) break;
  }

  console.log(pc.bold(`Q: ${question}`));
  if (hits.length === 0) {
    console.log(pc.yellow('No indexed knowledge matched this question.'));
    console.log(pc.dim('This answer is grounded only in the local index. Run `horus init` or try `horus knowledge search`.'));
    return 0;
  }
  console.log(pc.dim('Grounded in the local knowledge index (no external model):'));
  for (const m of hits.slice(0, opts.limit ?? 8)) {
    console.log(`  ${pc.cyan(`[${m.category}]`)} ${pc.bold(m.name)}`);
    const ref = provenanceRef(m.item);
    if (ref) console.log(ref);
  }
  console.log(pc.dim(`\nNext: ${pc.bold(`horus knowledge contracts "${hits[0]?.name ?? ''}"`)} for exact fields.`));
  printWarnings(stalenessWarnings(loaded.root, loaded.manifest));
  return 0;
}

// ── validate ──────────────────────────────────────────────────────────────────

export function runKnowledgeValidate(opts: KnowledgeOpts = {}): number {
  const root = resolveRoot(opts);
  const store = createJsonKnowledgeStore(root);
  if (!store.exists()) {
    noIndexMessage(root);
    return 1;
  }
  const issues: string[] = [];

  // Snapshot parses against the schema.
  let snapshot: KnowledgeSnapshot | null = null;
  try {
    snapshot = store.readSnapshot();
  } catch (err) {
    issues.push(`knowledge-base.json failed schema validation: ${(err as Error).message}`);
  }

  // Manifest parses.
  let manifest: KnowledgeManifest | null = null;
  try {
    manifest = store.readManifest();
  } catch (err) {
    issues.push(`manifest.json failed schema validation: ${(err as Error).message}`);
  }

  // Content hash of knowledge-base.json matches the manifest.
  if (manifest && snapshot) {
    const recorded = manifest.files.find((f) => f.name === 'knowledge-base.json')?.contentHash;
    if (recorded) {
      const actual = createHash('sha256')
        .update(readFileSync(knowledgePath(root, 'knowledgeBase'), 'utf8'))
        .digest('hex');
      if (actual !== recorded) {
        issues.push('knowledge-base.json content hash does not match the manifest (file modified after write)');
      }
    }
    // Counts agree.
    for (const cat of KNOWLEDGE_CATEGORIES) {
      const expected = manifest.counts[cat];
      if (expected !== undefined && expected !== snapshot[cat].length) {
        issues.push(`count mismatch for ${cat}: manifest says ${expected}, snapshot has ${snapshot[cat].length}`);
      }
    }
  }

  if (issues.length > 0) {
    console.log(pc.red(`✗ knowledge index invalid (${issues.length} issue(s)):`));
    for (const i of issues) console.log(pc.red(`  - ${i}`));
    return 1;
  }

  console.log(pc.green('✓ knowledge index is valid') + pc.dim(` (schema v${manifest?.schemaVersion}, ${Object.values(manifest?.counts ?? {}).reduce((a, b) => a + b, 0)} items)`));
  const warnings = stalenessWarnings(root, manifest);
  printWarnings(warnings);
  return 0;
}
