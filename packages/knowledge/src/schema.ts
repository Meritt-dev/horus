/**
 * Local project-knowledge index schema (HOR-291).
 *
 * Defines the first-version contract for the `.horus/index/` knowledge layer that
 * `horus init`, `horus knowledge`, and Horus MCP build against. This is the
 * PROJECT-KNOWLEDGE layer — distinct from:
 *
 *   - SOURCE INTELLIGENCE: the raw code graph in `.horus/source/` (Kùzu),
 *     queried over HTTP. Project knowledge *references* it (file/line/symbol) but
 *     never duplicates the graph.
 *   - RUNTIME EVIDENCE: investigation observations in the CLI's local Postgres
 *     (evidence/findings/hypotheses). Time-stamped, per-incident — not durable
 *     project facts.
 *
 * Local-first: indexing and querying never require Horus Cloud. See
 * docs/knowledge-index-schema.md.
 */
import { z } from 'zod';

/** Bump when the on-disk shape changes incompatibly. */
export const KNOWLEDGE_SCHEMA_VERSION = 1 as const;

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * How a knowledge item was obtained. Drives trust + staleness:
 *  - parsed:          extracted deterministically from source (highest trust)
 *  - inferred:        derived/heuristic (e.g. domain grouping)
 *  - manual:          authored by a human
 *  - runtime:         observed from live runtime evidence
 *  - agent-confirmed: proposed by an agent and confirmed against source
 *  - imported:        brought in from an external knowledge tool (HOR-292, e.g.
 *                     the Maison Safqa MCP knowledge-base), not freshly parsed by Horus
 */
export const SourceTypeSchema = z.enum([
  'parsed',
  'inferred',
  'manual',
  'runtime',
  'agent-confirmed',
  'imported',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Inclusive 1-based source line range `[start, end]`. */
export const LineRangeSchema = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

/**
 * Per-item provenance. Every field is optional except `sourceType` — knowledge
 * is captured "where available", and inferred/cross-repo items may have no single
 * file. `contentHash` + `gitSha` + `lastSeen` are the staleness anchors.
 */
export const ProvenanceSchema = z.object({
  sourceType: SourceTypeSchema,
  confidence: ConfidenceSchema.optional(),
  /** Repository name (matches a RepositoryProfile.key / HorusConfig repository). */
  repo: z.string().optional(),
  filePath: z.string().optional(),
  lineRange: LineRangeSchema.optional(),
  /** Commit the item was generated from. */
  gitSha: z.string().optional(),
  /** ISO-8601 timestamp the item was generated. */
  generatedAt: z.string().datetime().optional(),
  /** ISO-8601 timestamp the item was last confirmed present in source. */
  lastSeen: z.string().datetime().optional(),
  /** Hash of the source span/file the item derives from (staleness check). */
  contentHash: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Optional tenancy scope (which project/repo a fact belongs to). */
export const KnowledgeScopeSchema = z.object({
  project: z.string().optional(),
  repository: z.string().optional(),
});
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

/** Fields shared by every knowledge item: a stable ID, optional scope, provenance. */
const itemBase = {
  /** Stable, deterministic ID (e.g. `operation:createSale`, `type:CreateSaleInput`). */
  id: z.string().min(1),
  scope: KnowledgeScopeSchema.optional(),
  provenance: ProvenanceSchema,
};
export const KnowledgeItemBaseSchema = z.object(itemBase);
export type KnowledgeItemBase = z.infer<typeof KnowledgeItemBaseSchema>;

// ── Categories ──────────────────────────────────────────────────────────────

/** A repository's role/profile in the project landscape (projectProfiles). */
export const RepositoryProfileSchema = KnowledgeItemBaseSchema.extend({
  key: z.string(),
  name: z.string(),
  path: z.string().optional(),
  role: z.string().optional(),
  summary: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  stateManagement: z.array(z.string()).default([]),
  auth: z.array(z.string()).default([]),
  dataSources: z.array(z.string()).default([]),
  mainScripts: z.array(z.string()).default([]),
  integrations: z.array(z.string()).default([]),
  deploymentNotes: z.array(z.string()).default([]),
  importantDirectories: z.array(z.string()).default([]),
});
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

/** A typed argument or field. */
export const FieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean().optional(),
  description: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

/** Auth requirement attached to an operation. */
export const OperationAuthSchema = z.object({
  required: z.boolean(),
  roles: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

/**
 * An API operation / contract entry — protocol-agnostic so GraphQL (first),
 * REST/OpenAPI, and RPC can all be represented.
 */
export const OperationSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  /** query | mutation | subscription | endpoint | rpc | function. */
  kind: z.string(),
  /** graphql | rest | grpc | function | ... (defaults to graphql for the prototype). */
  protocol: z.string().default('graphql'),
  domain: z.string().optional(),
  description: z.string().optional(),
  resolverFile: z.string().optional(),
  /** REST path / GraphQL field path when relevant. */
  path: z.string().optional(),
  auth: OperationAuthSchema.optional(),
  args: z.array(FieldSchema).default([]),
  returnType: z.string().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

/** A type definition: input, response, object, scalar, interface, union. */
export const TypeDefinitionSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  /** input | response | object | scalar | interface | union. */
  kind: z.string(),
  fields: z.array(FieldSchema).default([]),
  sourceFile: z.string().optional(),
  description: z.string().optional(),
});
export type TypeDefinition = z.infer<typeof TypeDefinitionSchema>;

/** An enum and its values. */
export const EnumDefinitionSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  values: z.array(z.string()).default([]),
  description: z.string().optional(),
  sourceFile: z.string().optional(),
});
export type EnumDefinition = z.infer<typeof EnumDefinitionSchema>;

/** An authorization rule (who may invoke what). */
export const AuthRuleSchema = KnowledgeItemBaseSchema.extend({
  /** What the rule guards (operation name, route, resource). */
  subject: z.string(),
  required: z.boolean(),
  roles: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /** Operation/resource IDs this rule applies to. */
  appliesTo: z.array(z.string()).default([]),
});
export type AuthRule = z.infer<typeof AuthRuleSchema>;

/** A higher-level domain concept tying operations + types together. */
export const DomainConceptSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  slug: z.string().optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  relatedOperations: z.array(z.string()).default([]),
  relatedTypes: z.array(z.string()).default([]),
});
export type DomainConcept = z.infer<typeof DomainConceptSchema>;

/** A frontend pattern: hook, store, provider, server-function, component. */
export const FrontendPatternSchema = KnowledgeItemBaseSchema.extend({
  kind: z.string(),
  name: z.string(),
  filePath: z.string().optional(),
  description: z.string().optional(),
});
export type FrontendPattern = z.infer<typeof FrontendPatternSchema>;

/** A data flow: an ordered path data takes across components. */
export const DataFlowStepSchema = z.object({
  component: z.string(),
  action: z.string().optional(),
  detail: z.string().optional(),
});
export const DataFlowSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(DataFlowStepSchema).default([]),
  sources: z.array(z.string()).default([]),
  sinks: z.array(z.string()).default([]),
});
export type DataFlow = z.infer<typeof DataFlowSchema>;

/** A deployable/runtime component: service, worker, cron, queue. */
export const RuntimeComponentSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  /** service | worker | cron | queue | function | gateway | ... */
  type: z.string(),
  description: z.string().optional(),
  repo: z.string().optional(),
  entrypoints: z.array(z.string()).default([]),
});
export type RuntimeComponent = z.infer<typeof RuntimeComponentSchema>;

/** An external system the project integrates with. */
export const ExternalIntegrationSchema = KnowledgeItemBaseSchema.extend({
  name: z.string(),
  provider: z.string().optional(),
  /** api | db | queue | auth | payment | storage | email | ... */
  kind: z.string().optional(),
  description: z.string().optional(),
  usedBy: z.array(z.string()).default([]),
});
export type ExternalIntegration = z.infer<typeof ExternalIntegrationSchema>;

// ── Snapshot ────────────────────────────────────────────────────────────────

/**
 * The canonical in-memory project-knowledge snapshot. Persisted as
 * `.horus/index/knowledge-base.json`; derived per-category view files and the
 * `manifest.json` index are written alongside it (see store.ts / layout.ts).
 */
export const KnowledgeSnapshotSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
  generatedAt: z.string().datetime(),
  project: z.string().optional(),
  repositories: z.array(RepositoryProfileSchema).default([]),
  operations: z.array(OperationSchema).default([]),
  types: z.array(TypeDefinitionSchema).default([]),
  enums: z.array(EnumDefinitionSchema).default([]),
  authRules: z.array(AuthRuleSchema).default([]),
  domainConcepts: z.array(DomainConceptSchema).default([]),
  frontendPatterns: z.array(FrontendPatternSchema).default([]),
  dataFlows: z.array(DataFlowSchema).default([]),
  runtimeComponents: z.array(RuntimeComponentSchema).default([]),
  externalIntegrations: z.array(ExternalIntegrationSchema).default([]),
});
export type KnowledgeSnapshot = z.infer<typeof KnowledgeSnapshotSchema>;

/** Category keys carrying arrays of knowledge items in a snapshot. */
export const KNOWLEDGE_CATEGORIES = [
  'repositories',
  'operations',
  'types',
  'enums',
  'authRules',
  'domainConcepts',
  'frontendPatterns',
  'dataFlows',
  'runtimeComponents',
  'externalIntegrations',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

// ── Manifest ────────────────────────────────────────────────────────────────

/** A repository covered by a snapshot + the commit it was indexed at. */
export const ManifestRepositorySchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  headSha: z.string().optional(),
});

/** A persisted file in the index dir + integrity/coverage info. */
export const ManifestFileSchema = z.object({
  name: z.string(),
  category: z.string().optional(),
  itemCount: z.number().int().min(0).optional(),
  contentHash: z.string().optional(),
});

/**
 * `.horus/index/manifest.json` — the index entrypoint. Cheap to read; lets a
 * tool know what exists, how fresh it is, and what produced it without parsing
 * the full snapshot.
 */
export const KnowledgeManifestSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
  generatedAt: z.string().datetime(),
  /** What produced the snapshot (e.g. horus-cli, maison-safqa-import). */
  generator: z.object({ tool: z.string(), version: z.string().optional() }),
  project: z.string().optional(),
  /** Git state the snapshot was built at (HOR-293). */
  git: z.object({ sha: z.string().optional(), branch: z.string().optional() }).optional(),
  repositories: z.array(ManifestRepositorySchema).default([]),
  files: z.array(ManifestFileSchema).default([]),
  /** Per-category item counts. */
  counts: z.record(z.number().int().min(0)).default({}),
  /** Pointer to the source-intelligence backend this snapshot references. */
  sourceIntelligence: z
    .object({ tool: z.string(), version: z.string().optional() })
    .optional(),
});
export type KnowledgeManifest = z.infer<typeof KnowledgeManifestSchema>;

// ── Staleness ───────────────────────────────────────────────────────────────

export type KnowledgeItemStatus = 'current' | 'stale' | 'unknown';

/**
 * Derive an item's freshness against the current source. An item is `stale` when
 * the source it was parsed from has changed (content hash mismatch, or the repo
 * HEAD advanced past the recorded gitSha for parsed items); `unknown` when there
 * is nothing to compare (no contentHash, or a non-parsed/manual item).
 */
export function itemStatus(
  provenance: Provenance,
  current: { contentHash?: string; headSha?: string } = {},
): KnowledgeItemStatus {
  // Manual/inferred/agent items aren't tied 1:1 to a file hash — don't flag them.
  if (provenance.sourceType !== 'parsed' && provenance.sourceType !== 'runtime') {
    return 'unknown';
  }
  if (provenance.contentHash && current.contentHash) {
    return provenance.contentHash === current.contentHash ? 'current' : 'stale';
  }
  if (provenance.gitSha && current.headSha) {
    return provenance.gitSha === current.headSha ? 'current' : 'unknown';
  }
  return 'unknown';
}
