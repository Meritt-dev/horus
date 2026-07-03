/**
 * Horus database schema — Postgres + Drizzle, NO pgvector (HOR-2).
 *
 * Tables: projects, repositories, investigations, evidence, findings, hypotheses,
 * incident_memory, queue_edges, provider_cache. Semantic search is delegated to the
 * source-intelligence backend, so there are no embedding columns. See architecture.md §2.6.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  real,
  integer,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

/** A project groups one or more repositories under investigation. */
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Repositories Horus knows about. Horus owns this registry (not the source-intelligence backend). */
export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  path: text('path').notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
  sourceStatus: jsonb('source_status'),
  stale: boolean('stale').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A single investigation run and its AI narrative. */
export const investigations = pgTable('investigations', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  incidentInput: jsonb('incident_input').notNull(),
  status: text('status').notNull().default('open'),
  summary: text('summary'),
  narrative: jsonb('narrative'),
  report: jsonb('report'),
  // Project label (nullable for back-compat, like queue_edges/incident_memory).
  // The shared local DB holds every project's investigations — without this,
  // `horus investigations`/onboard in one repo listed another project's incident
  // titles (dogfood N1). Migration 0011 backfills from incident_input->>'repo'.
  project: text('project'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Typed, citable evidence gathered for an investigation. */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // ProviderKind: code|logs|metrics|state|queue|history
    kind: text('kind').notNull(), // EvidenceKind: log|metric|symbol|flow|commit|...
    title: text('title').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }), // event time, for timeline alignment
    relevance: real('relevance').notNull().default(0),
    payload: jsonb('payload'),
    links: jsonb('links'),
    provenance: jsonb('provenance'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('evidence_investigation_idx').on(t.investigationId)],
);

/** Ranked candidate root causes for an investigation. */
export const hypotheses = pgTable(
  'hypotheses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    statement: text('statement').notNull(),
    score: real('score').notNull().default(0),
    supportingEvidence: uuid('supporting_evidence').array(),
    verdict: text('verdict'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('hypotheses_investigation_idx').on(t.investigationId)],
);

/**
 * The queue-boundary graph the stitcher synthesizes — the one thing source intelligence can't do.
 * Denormalized on purpose: one row pairs a producer with the worker that consumes the
 * same queue, so "which worker consumes this queue?" is a single lookup. Either side
 * may be null when only one end is discovered. Normalize later if needed.
 */
export const queueEdges = pgTable(
  'queue_edges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueName: text('queue_name').notNull(),
    producerSymbol: text('producer_symbol'),
    producerFile: text('producer_file'),
    workerSymbol: text('worker_symbol'),
    workerFile: text('worker_file'),
    source: text('source').notNull().default('stitcher'), // who synthesized this edge
    project: text('project'), // nullable for back-compat; set to the project label by the stitcher
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('queue_edges_queue_name_idx').on(t.queueName),
    index('queue_edges_source_project_idx').on(t.source, t.project),
  ],
);

/**
 * Response cache for expensive provider calls (source intelligence, Elasticsearch, Prometheus, Git).
 * Keyed by (provider, cache_key); `expires_at` drives TTL eviction.
 */
export const providerCache = pgTable(
  'provider_cache',
  {
    provider: text('provider').notNull(),
    cacheKey: text('cache_key').notNull(),
    payload: jsonb('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.cacheKey] })],
);

/**
 * A discrete finding within an investigation — an observation or sub-conclusion.
 * Distinct from a `hypothesis` (a ranked candidate root cause): a finding is a fact
 * the engine asserts; a hypothesis is an explanation it is still weighing.
 */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'observation' | 'anomaly' | 'correlation' | ...
    title: text('title').notNull(),
    detail: text('detail'),
    confidence: real('confidence').notNull().default(0),
    evidenceIds: uuid('evidence_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('findings_investigation_idx').on(t.investigationId)],
);

/**
 * Memory of past incidents for pattern recognition (HOR-18). No pgvector — similarity
 * is matched on a normalized `signature` + `tags` + text rather than embeddings.
 * HOR-46: project column scopes recall to the originating repository.
 */
export const incidentMemory = pgTable(
  'incident_memory',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id').references(() => investigations.id, {
      onDelete: 'set null',
    }),
    project: text('project'), // repository/project scope for isolation (HOR-46)
    title: text('title').notNull(),
    summary: text('summary'),
    signature: text('signature'), // normalized incident signature, for recall
    tags: text('tags').array(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incident_memory_signature_idx').on(t.signature),
    index('incident_memory_project_idx').on(t.project),
  ],
);

/**
 * Authored memory items — the durable system-of-record for Horus Memory (M1).
 * Distinct from `incident_memory` (the per-run incident recall index): a MemoryItem is an
 * authored, user-controllable claim that must survive re-analyze and be cloud-syncable.
 * No embedding column — vectors are derived and live in a separate (later) store keyed by `id`.
 * HOR-46: `repo` scopes recall to the originating repository (fail-closed); org/workspace/user
 * are additive tenancy that widen, never weaken, that isolation.
 */
export const memoryItem = pgTable(
  'memory_item',
  {
    id: text('id').primaryKey(), // ULID; the join key to the (later) vector store
    kind: text('kind').notNull(), // code-fact|contract|decision|pitfall|incident-pattern|confirmed-outcome
    claim: text('claim').notNull(), // the NL claim; this is what gets embedded
    scope: text('scope').notNull(), // global|repo|module:<area>|symbol:<node_id>
    source: text('source').notNull(), // derived|human|confirmed-outcome
    evidence: jsonb('evidence').notNull().default([]), // [{kind, ref, shortId?, capturedAt}]
    confidence: real('confidence').notNull(), // 0..1
    status: text('status').notNull().default('fresh'), // fresh|possibly-stale|contradicted|deprecated|pinned|forgotten
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastVerifiedHash: text('last_verified_hash'), // sha256(node.content) snapshot at verify time
    orgId: text('org_id'),
    workspaceId: text('workspace_id'),
    repo: text('repo').notNull(), // == today's `project` scoping key; recall fails CLOSED on null (HOR-46)
    userId: text('user_id'),
    visibility: text('visibility').notNull().default('private'), // private|team
    payload: jsonb('payload'), // forward-compat, zero-migration extension
    // Incident-family recall keys, populated at WRITE for incident-derived kinds
    // (confirmed-outcome|incident-pattern) from the source investigation report. Nullable: a
    // non-incident claim (code-fact/decision/...) carries neither. The CONTEXT-ONLY auto-detectors
    // (`memory detect`) match recurrence on these — they never feed confidence/verdict scoring.
    signature: text('signature'), // normalized incident signature (deriveSignature), for recurrence
    tags: text('tags').array(), // normalized incident tags (deriveTags), for recurrence overlap
  },
  (t) => [
    index('memory_item_repo_idx').on(t.repo),
    index('memory_item_scope_idx').on(t.scope),
    index('memory_item_status_idx').on(t.status),
    index('memory_item_tenancy_idx').on(t.orgId, t.workspaceId, t.repo, t.userId),
    index('memory_item_signature_idx').on(t.signature),
  ],
);

/**
 * Normalized memory edges (traversal-friendly; powers `memory show` + packets).
 * M1 rels are limited to about-symbol|about-file|has-evidence|about-incident (memory→memory
 * rels are deferred). `rel`/`to_kind` are validated in TS, not at the column level.
 * `to_file_path` is the rename/orphan fallback for node links (the code id orphans on rename/move).
 */
export const memoryLink = pgTable(
  'memory_link',
  {
    id: text('id').primaryKey(),
    fromMemoryId: text('from_memory_id')
      .notNull()
      .references(() => memoryItem.id, { onDelete: 'cascade' }),
    rel: text('rel').notNull(), // about-symbol|about-file|has-evidence|about-incident
    toKind: text('to_kind').notNull(), // node|incident|evidence
    toRef: text('to_ref').notNull(), // node_id | investigationId | evidence shortId
    toFilePath: text('to_file_path'), // node links: rename/orphan fallback
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_link_from_idx').on(t.fromMemoryId),
    index('memory_link_to_idx').on(t.toKind, t.toRef),
  ],
);

/**
 * Append-only audit trail for every MemoryItem mutation. Soft-forget + this log gives a
 * complete, reversible provenance record (point 7). `history()` returns the trail.
 */
export const memoryAudit = pgTable(
  'memory_audit',
  {
    id: text('id').primaryKey(),
    memoryId: text('memory_id')
      .notNull()
      .references(() => memoryItem.id, { onDelete: 'cascade' }),
    action: text('action').notNull(), // add|confirm|forget|pin|mark-stale|verify|set-visibility|link|...
    actor: jsonb('actor').notNull(), // {kind: user|agent|system, ...}
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    note: text('note'),
    // Structured provenance for non-status events (e.g. `link`): { rel, toKind, toRef, detection, note? }.
    // `detection` (manual|auto:recurrence|auto:contradiction|structural) is the HONEST record of how an
    // edge was produced — auto-detectors are CONTEXT-ONLY and never feed confidence/verdict scoring.
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_audit_memory_idx').on(t.memoryId)],
);

/**
 * Outcome-label / eval store (HOR-390) — the queryable record of Horus's own investigation
 * accuracy, keyed by `investigationId`. This labeled dataset IS the flywheel's eval/training
 * set (the prerequisite for a reranker/model in the HOR-AI layer). It converges the two
 * entry points that attest an outcome — `horus feedback` and `horus memory confirm` — into
 * ONE persisted, queryable record, where today `feedback` is telemetry-only (no DB row) and
 * `confirm` is not-yet-built.
 *
 * Append-only: every attestation is its own row, so re-confirming or correcting a label keeps
 * the full history rather than overwriting a data point (use `getLatestOutcomeLabel` for the
 * current verdict). `project` is denormalized (like `incident_memory`) so the common
 * "accuracy by project / over a date range" query is a single indexed scan, and survives the
 * investigation row being pruned (the FK is ON DELETE cascade, so labels follow their run).
 */
export const outcomeLabel = pgTable(
  'outcome_label',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id').references(() => investigations.id, {
      onDelete: 'cascade',
    }),
    project: text('project'), // denormalized repo/project scope, for accuracy-by-project queries
    resolved: text('resolved').notNull(), // 'yes' | 'partly' | 'no' — did Horus point at the cause?
    confirmedCause: text('confirmed_cause'), // the actual root cause, when known
    note: text('note'), // free-text context from the attester
    source: text('source').notNull(), // 'feedback' | 'confirm' — which entry point attested it
    payload: jsonb('payload'), // forward-compat (e.g. manualEstimateMinutes, horusSeconds)
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outcome_label_investigation_idx').on(t.investigationId),
    index('outcome_label_project_idx').on(t.project),
    index('outcome_label_at_idx').on(t.at),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Investigation = typeof investigations.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type Hypothesis = typeof hypotheses.$inferSelect;
export type QueueEdge = typeof queueEdges.$inferSelect;
export type NewQueueEdge = typeof queueEdges.$inferInsert;
export type ProviderCacheRow = typeof providerCache.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type IncidentMemory = typeof incidentMemory.$inferSelect;
export type NewIncidentMemory = typeof incidentMemory.$inferInsert;
export type MemoryItem = typeof memoryItem.$inferSelect;
export type NewMemoryItem = typeof memoryItem.$inferInsert;
export type MemoryLink = typeof memoryLink.$inferSelect;
export type NewMemoryLink = typeof memoryLink.$inferInsert;
export type MemoryAudit = typeof memoryAudit.$inferSelect;
export type NewMemoryAudit = typeof memoryAudit.$inferInsert;
export type OutcomeLabel = typeof outcomeLabel.$inferSelect;
export type NewOutcomeLabel = typeof outcomeLabel.$inferInsert;
