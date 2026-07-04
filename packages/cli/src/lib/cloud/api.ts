/**
 * Thin client for the Horus Cloud `/v1` API (HOR-236). The CLI talks to the
 * cloud ONLY through this contract — it never holds DB credentials (HOR-221).
 */

export const DEFAULT_API_BASE_URL = "https://api.horus.sh";

export class CloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

/** Network/connection failure (offline, DNS, refused) — distinct from HTTP errors. */
export class CloudOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudOfflineError";
  }
}

export interface MeResponse {
  user: { id: string; primaryEmail: string; displayName?: string | null };
  memberships: { organizationId: string; role: "owner" | "admin" | "member"; workspaceIds: string[] }[];
}

/** Response from POST /v1/cli-sessions/start (device-login init). */
export interface CliSessionStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** Response from POST /v1/cli-sessions/poll. `token` is present only once, on approval. */
export interface CliSessionPoll {
  status: "pending" | "slow_down" | "approved" | "denied" | "expired";
  interval?: number;
  token?: string;
  account?: { userId: string; email: string };
}

export interface ContextResponse {
  user: { id: string; primaryEmail: string; displayName?: string | null };
  organizations: { id: string; slug: string; name: string; role: "owner" | "admin" | "member" }[];
  workspaces: { id: string; slug: string; name: string; organizationId: string }[];
  // A project IS the repository/codebase (HOR-280). The cloud `/v1/context`
  // returns repo/sync metadata on each project (HOR-277); the fields are optional
  // so the CLI degrades gracefully against an older cloud build.
  projects: {
    id: string;
    slug: string;
    name: string;
    workspaceId: string;
    organizationId: string;
    provider?: string | null;
    remoteUrl?: string | null;
    defaultBranch?: string | null;
    lastSeenCommit?: string | null;
    lastSyncedAt?: string | null;
  }[];
}

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvestigationRecord {
  id: string;
  projectId: string;
  workspaceId: string;
  organizationId: string;
  title: string;
  hint: string | null;
  status: string;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestigationDetail extends InvestigationRecord {
  repositoryIds: string[];
}

/**
 * The human outcome label that rides the tenant-scoped investigation sync (HOR-390 → cloud).
 *
 * FROZEN CONTRACT: this is the durable eval-store verdict (did Horus point at the real cause?)
 * keyed to the investigation being synced. Additive + back-compat — absent when the local eval
 * store carries no label for the investigation. This is the SAME tenant-scoped, visibility-enforced
 * investigation payload as the rest of the sync; it is distinct from the anonymous vendor telemetry.
 */
export interface InvestigationOutcome {
  resolved: "yes" | "partly" | "no";
  note?: string;
  confirmedCause?: string;
  source: "feedback" | "confirm";
  /** ISO-8601 attestation time of the label. */
  labeledAt: string;
}

export interface EvidenceRecord {
  id: string;
  investigationId: string;
  projectId: string;
  organizationId: string;
  type: string;
  source: string;
  title: string;
  content: string;
  contentFormat: string;
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AgentRunRecord {
  id: string;
  investigationId: string;
  projectId: string;
  organizationId: string;
  repositoryId: string | null;
  status: string;
  cliVersion: string | null;
  summary: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

// ── Investigation provenance graph (Stage 1 dual-write) ─────────────────────

/**
 * The typed nodes a citation edge spans. Mirrors the engine report's structure:
 * an `investigation` root, scored `cause`s, validated `hypothesis`es, deterministic
 * `finding`s, the cited `evidence` leaves, and (future) confirmed `outcome`s.
 */
export type CitationNodeType =
  | "investigation"
  | "cause"
  | "hypothesis"
  | "finding"
  | "evidence"
  | "outcome";

/**
 * The relationship a citation edge asserts. NOTE: `contradicts` is part of the
 * frozen vocabulary but is NOT emitted yet (no backing data) — the writer cuts
 * contradicting edges rather than fabricate them.
 */
export type CitationRole = "derives" | "supports" | "contradicts" | "cites" | "explains";

/**
 * One endpoint of a citation edge. `ref` is the node's stable identity:
 * - evidence → the CLOUD evidence id (resolved cross-seam from the engine `ev_…`
 *   id via the engineRef→cloudId map); never a fake link — unresolved refs are cut.
 * - cause / hypothesis → the engine's deterministic id.
 * - finding → a stable synthetic ref (`<reportId>:finding:<index>`).
 * - investigation → the cloud investigation id.
 */
export interface CitationNode {
  type: CitationNodeType;
  ref: string;
  label: string;
  confidence?: number;
  band?: string;
  verdict?: string;
  subject?: { service?: string; environment?: string };
}

/** A directed, typed citation edge (additive provenance; scoring untouched). */
export interface CitationEdgeInput {
  from: CitationNode;
  to: CitationNode;
  role: CitationRole;
}

/**
 * A per-item evidence row materialized from the engine report (Stage 1). Carries
 * the new cloud evidence columns — `engineRef` (the engine `ev_…` id), `service`,
 * `environment` — alongside the existing cloud evidence table columns (kept for
 * back-compat) plus the additive provenance carriers.
 */
export interface ProvenanceEvidenceInput {
  // Cloud evidence table columns (required; back-compat).
  type: string;
  source: string;
  title: string;
  content: string;
  contentFormat: string;
  payload?: unknown;
  idempotencyKey?: string;
  // New cloud evidence columns (frozen contract): engine_ref, service, environment.
  engineRef: string;
  service?: string;
  environment?: string;
  // Additive provenance carriers.
  provenance?: { query: string; collectedAt: string };
  filePath?: string;
  symbolName?: string;
  kind: string;
}

/** A created per-item evidence row, echoing its engine ref for cross-seam mapping. */
export interface EvidenceBatchRecord {
  id: string;
  engineRef: string;
}

/**
 * A knowledge snapshot record stored in Horus Cloud (HOR-296). The cloud stores
 * the structured snapshot + manifest keyed by content hash for dedup + freshness;
 * it never owns indexing (the CLI is the source of truth).
 */
export interface KnowledgeSnapshotRecord {
  id: string;
  projectId: string;
  schemaVersion: number;
  contentHash: string;
  gitSha: string | null;
  branch: string | null;
  generatedAt: string;
  counts: Record<string, number>;
  /** The serialized KnowledgeSnapshot (present on detail/latest reads). */
  snapshot?: unknown;
  /** The serialized KnowledgeManifest. */
  manifest?: unknown;
  archived: boolean;
  createdAt: string;
}

export interface PushKnowledgeSnapshotBody {
  schemaVersion: number;
  contentHash: string;
  gitSha?: string;
  branch?: string;
  generatedAt: string;
  counts?: Record<string, number>;
  snapshot: unknown;
  manifest: unknown;
  /** Defaults to the content hash — server dedups idempotent re-pushes. */
  idempotencyKey?: string;
}

export interface ChangeReportBody {
  service?: string;
  since?: string;
  until?: string;
  summary: string;
  commitCount?: number;
  contributorCount?: number;
  symbolsAdded?: number;
  symbolsModified?: number;
  symbolsRemoved?: number;
  queueTopologyTouched?: boolean;
  /** The full deterministic WhatChangedReport, stored for the dashboard. */
  payload?: Record<string, unknown>;
}

export interface ChangeReportRecord {
  id: string;
  projectId: string;
  summary: string;
  createdAt: string;
}

/**
 * Horus Memory (M3): one memory item as it travels to the cloud `/v1` sync endpoint.
 *
 * `clientId` is the CLI's stable local ULID (`memory_item.id`) — it is the dedup/join key the
 * cloud upserts on (`ON CONFLICT (organization_id, client_id)`). Tenancy (org/workspace/project +
 * `createdByUserId`) is resolved SERVER-SIDE from the auth principal + the path project, so it is
 * NOT carried here. PRIVACY (non-negotiable): there is NO `payload`/`embedding`/vector field —
 * vectors never cross the trust boundary; the cloud re-embeds from `claim` text if it ever needs to.
 */
export interface MemoryItemSyncInput {
  /** CLI memory_item.id (ULID) — the upsert key. */
  clientId: string;
  kind?: string;
  claim?: string;
  scope?: string;
  source?: string;
  status?: string;
  confidence?: number;
  /** Server CLAMPS confirmed-outcome → 'private'; the CLI only ever sends 'private' in M3. */
  visibility?: "private" | "team";
  /** Evidence refs (NOT vectors). Optional — the cloud may ignore it in the minimal cut. */
  evidence?: unknown;
  lastVerifiedAt?: string | null;
  lastVerifiedHash?: string | null;
  /** The CLI row's created_at (provenance only; cloud ordering uses its own created_at). */
  clientCreatedAt?: string | null;
}

/**
 * Horus Memory (M3): one authored link as it travels to the cloud sync endpoint.
 *
 * `idempotencyKey` is the CLI link row's own stable id (`memory_link.id`) — the cloud dedups on
 * `(organization_id, idempotency_key)`, so re-sync is a no-op. `fromClientId` is the CLI item ULID
 * (`memory_link.from_memory_id`); the cloud resolves it to the cloud item uuid server-side (against
 * the batch's just-upserted items OR pre-existing rows). NO vectors/embeddings here by construction.
 */
export interface MemoryLinkSyncInput {
  /** CLI memory_link.id — the (org, idempotencyKey) dedup key. */
  idempotencyKey: string;
  /** CLI from-item ULID (memory_link.from_memory_id), resolved to the cloud uuid server-side. */
  fromClientId: string;
  rel: string;
  toKind: string;
  toRef: string;
  toFilePath?: string;
}

/**
 * Horus Memory (M3): one APPEND-ONLY audit row mirrored from the CLI. `clientAuditId` is the CLI
 * audit row's own id (`memory_audit.id`) and the `(organization_id, client_audit_id)` dedup key —
 * re-sync NEVER updates an existing row. `memoryClientId` is the CLI item ULID (`memory_audit.
 * memory_id`), resolved to the cloud uuid server-side. `actor` is the verbatim provenance object.
 */
export interface MemoryAuditSyncInput {
  /** CLI memory_audit.id — the (org, clientAuditId) dedup key. */
  clientAuditId: string;
  /** CLI item ULID (memory_audit.memory_id), resolved to the cloud uuid server-side. */
  memoryClientId: string;
  action: string;
  /** Verbatim {kind, id?, name?} provenance — NOT a vector. */
  actor: Record<string, unknown>;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
  /** The CLI audit timestamp (ISO-8601); provenance + ordering on the trail. */
  at: string;
}

/** A memory item as the cloud returns it. `clientId` round-trips the CLI ULID. */
export interface MemoryItemRecord {
  id: string;
  clientId: string;
  organizationId: string;
  workspaceId: string;
  projectId: string | null;
  createdByUserId: string | null;
  visibility: "private" | "team";
  kind: string;
  claim: string;
  scope: string;
  source: string;
  status: string;
  confidence: number;
  evidence?: unknown;
  lastVerifiedAt: string | null;
  lastVerifiedHash: string | null;
  clientCreatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-array outcome of one sync transaction (links/audit) — created vs deduped/skipped. */
export interface MemorySyncBatchCounts {
  created: number;
  skipped: number;
  total: number;
}

export interface MemorySyncResult {
  /** Echoed item records — present only when the cloud build returns them (older builds did). */
  items?: MemoryItemRecord[];
  created?: number;
  updated?: number;
  total?: number;
  /** clientId (ULID) → cloud uuid. */
  idMap?: Record<string, string>;
  /** Outcome of the links half of the transaction. */
  links?: MemorySyncBatchCounts;
  /** Outcome of the audit half of the transaction. */
  audit?: MemorySyncBatchCounts;
}

export interface MemoryListQuery {
  status?: string;
  kind?: string;
  /** ilike on claim. */
  search?: string;
  limit?: number;
  cursor?: string;
}

// ── Team memory (HOR-464 / M4) ──────────────────────────────────────────────
// The SERVER-OWNED shared team-memory store. Distinct from the write-only `memory-items` mirror:
// a locally-authored item is one-way PROMOTED into this store, and every device pulls it back as a
// disposable local read-cache. FROZEN wire contract — do NOT reuse syncMemoryItems/listMemoryItems.
// PRIVACY: the promote body is a POSITIVE allowlist — NO vector/embedding/payload field ever.

/** One item as the server team-memory store returns it (workspace-scoped). */
export interface TeamMemoryItem {
  id: string;
  organizationId: string;
  workspaceId: string;
  sourceProjectId: string | null;
  /** The promoting CLI's local `memory_item.id` — the cross-device dedup + cache join key. */
  originClientId: string;
  /** Joined from `promotedByUserId` → users.name; DISPLAY-ONLY attribution (never feeds rank). */
  authorName: string | null;
  promotedByUserId: string | null;
  kind: string;
  claim: string;
  scope: string;
  source: string;
  status: string;
  confidence: number | null;
  contentHash: string | null;
  provenance: Record<string, unknown>;
  /** bigint serialized as a STRING (avoid JS >2^53 precision loss) — the pull cursor. */
  seq: string;
  deletedAt: string | null;
  promotedAt: string;
  updatedAt: string;
}

/** One item promoted into the team store (POSITIVE allowlist — never a vector/payload). */
export interface TeamMemoryPromoteInput {
  originClientId: string;
  kind: string;
  claim: string;
  scope: string;
  source: string;
  status?: string;
  confidence?: number | null;
  contentHash?: string | null;
  provenance?: Record<string, unknown>;
}

export interface TeamMemoryPromoteResult {
  promoted: number;
  skipped: number;
  total: number;
  items: TeamMemoryItem[];
}

export interface TeamMemoryListQuery {
  /** The seq high-water mark (v1 client pulls `since:'0'` full). */
  since: string;
  limit?: number;
  includeDeleted?: boolean;
  search?: string;
}

export interface TeamMemoryListResult {
  items: TeamMemoryItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export class CloudClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CloudOfflineError(
        `Cannot reach Horus Cloud at ${this.baseUrl} (${(err as Error).message}).`,
      );
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const envelope = json as { error?: { code?: string; message?: string } } | undefined;
      throw new CloudError(
        res.status,
        envelope?.error?.code ?? "http_error",
        envelope?.error?.message ?? `Request failed (${res.status}).`,
      );
    }
    return json as T;
  }

  me(): Promise<MeResponse> {
    return this.request<MeResponse>("GET", "/v1/me");
  }

  /** Begin a browser device-login session (no auth required). */
  startCliSession(): Promise<CliSessionStart> {
    return this.request<CliSessionStart>("POST", "/v1/cli-sessions/start");
  }

  /** Poll a device-login session until it is approved, denied, or expires. */
  pollCliSession(deviceCode: string): Promise<CliSessionPoll> {
    return this.request<CliSessionPoll>("POST", "/v1/cli-sessions/poll", { deviceCode });
  }

  context(): Promise<ContextResponse> {
    return this.request<ContextResponse>("GET", "/v1/context");
  }

  /** Create a workspace in an org (HOR-307 — used by `cloud link` create-from-repo). */
  createWorkspace(
    organizationId: string,
    body: { name: string; slug?: string },
  ): Promise<{ id: string; slug: string; name: string; organizationId: string }> {
    return this.request("POST", `/v1/organizations/${organizationId}/workspaces`, body);
  }

  /** Create a project in a workspace, optionally with its repo identity (HOR-307). */
  createProject(
    organizationId: string,
    workspaceId: string,
    body: { name: string; slug?: string; remoteUrl?: string; provider?: string },
  ): Promise<{ id: string; slug: string; name: string; workspaceId: string; organizationId: string }> {
    return this.request(
      "POST",
      `/v1/organizations/${organizationId}/workspaces/${workspaceId}/projects`,
      body,
    );
  }

  listTokens(): Promise<{ tokens: TokenSummary[] }> {
    return this.request<{ tokens: TokenSummary[] }>("GET", "/v1/cli/tokens");
  }

  revokeToken(id: string): Promise<void> {
    return this.request<void>("DELETE", `/v1/cli/tokens/${id}`);
  }

  createInvestigation(
    projectId: string,
    body: {
      title: string;
      hint?: string;
      repositoryIds?: string[];
      idempotencyKey?: string;
      /** Optional human outcome label (HOR-390); omitted when the eval store has none. */
      outcome?: InvestigationOutcome;
    },
  ): Promise<InvestigationRecord> {
    return this.request<InvestigationRecord>("POST", `/v1/projects/${projectId}/investigations`, body);
  }

  listInvestigations(
    projectId: string,
  ): Promise<{ investigations: InvestigationRecord[]; nextCursor?: string }> {
    return this.request<{ investigations: InvestigationRecord[]; nextCursor?: string }>(
      "GET",
      `/v1/projects/${projectId}/investigations`,
    );
  }

  getInvestigation(projectId: string, investigationId: string): Promise<InvestigationDetail> {
    return this.request<InvestigationDetail>(
      "GET",
      `/v1/projects/${projectId}/investigations/${investigationId}`,
    );
  }

  updateInvestigation(
    projectId: string,
    investigationId: string,
    body: { title?: string; hint?: string; status?: string },
  ): Promise<InvestigationRecord> {
    return this.request<InvestigationRecord>(
      "PATCH",
      `/v1/projects/${projectId}/investigations/${investigationId}`,
      body,
    );
  }

  addInvestigationRepositories(
    projectId: string,
    investigationId: string,
    repositoryIds: string[],
  ): Promise<InvestigationDetail> {
    return this.request<InvestigationDetail>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/repositories`,
      { repositoryIds },
    );
  }

  createEvidence(
    projectId: string,
    investigationId: string,
    body: {
      type: string;
      source: string;
      title: string;
      content: string;
      contentFormat: string;
      payload?: unknown;
      idempotencyKey?: string;
    },
  ): Promise<EvidenceRecord> {
    return this.request<EvidenceRecord>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/evidence`,
      body,
    );
  }

  listEvidence(projectId: string, investigationId: string): Promise<EvidenceRecord[]> {
    return this.request<EvidenceRecord[]>(
      "GET",
      `/v1/projects/${projectId}/investigations/${investigationId}/evidence`,
    );
  }

  /**
   * Batch-materialize per-item evidence rows (Stage 1 dual-write). Single round-trip
   * (no N+1). Each item is idempotent on its own key; the response echoes every row's
   * `engineRef` so the caller can build the engineRef→cloudId map for citation edges.
   */
  createEvidenceBatch(
    projectId: string,
    investigationId: string,
    body: { items: ProvenanceEvidenceInput[] },
  ): Promise<{ evidence: EvidenceBatchRecord[] }> {
    return this.request<{ evidence: EvidenceBatchRecord[] }>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/evidence/batch`,
      body,
    );
  }

  /**
   * Batch-insert citation edges over the typed provenance nodes (Stage 1 dual-write).
   * Evidence endpoints must already carry CLOUD evidence ids (resolved cross-seam).
   * Single round-trip (no N+1).
   */
  createCitations(
    projectId: string,
    investigationId: string,
    body: { edges: CitationEdgeInput[] },
  ): Promise<{ created: number }> {
    return this.request<{ created: number }>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/citations`,
      body,
    );
  }

  createAgentRun(
    projectId: string,
    investigationId: string,
    body: {
      repositoryId?: string;
      status?: string;
      agent?: string;
      model?: string;
      cliVersion?: string;
      summary?: string;
      idempotencyKey?: string;
    },
  ): Promise<AgentRunRecord> {
    return this.request<AgentRunRecord>(
      "POST",
      `/v1/projects/${projectId}/investigations/${investigationId}/agent-runs`,
      body,
    );
  }

  // ── Knowledge snapshots (HOR-296) ──────────────────────────────────────────

  /** Upload a local knowledge snapshot. Content-hash idempotent (server dedups). */
  pushKnowledgeSnapshot(
    projectId: string,
    body: PushKnowledgeSnapshotBody,
  ): Promise<KnowledgeSnapshotRecord> {
    return this.request<KnowledgeSnapshotRecord>(
      "POST",
      `/v1/projects/${projectId}/knowledge-snapshots`,
      body,
    );
  }

  /** Fetch the latest (non-archived) knowledge snapshot for a project. */
  getLatestKnowledgeSnapshot(projectId: string): Promise<KnowledgeSnapshotRecord> {
    return this.request<KnowledgeSnapshotRecord>(
      "GET",
      `/v1/projects/${projectId}/knowledge-snapshots/latest`,
    );
  }

  /** Push a `horus what-changed` report to the linked cloud project. */
  createChangeReport(
    projectId: string,
    body: ChangeReportBody,
  ): Promise<ChangeReportRecord> {
    return this.request<ChangeReportRecord>(
      "POST",
      `/v1/projects/${projectId}/changes`,
      body,
    );
  }

  // ── Memory items (HOR Memory M3) ───────────────────────────────────────────

  /**
   * Batch-upsert authored memory items + links + audit into the linked cloud project, in ONE cloud
   * transaction. Idempotent per element on the CLI's stable ids — items on `clientId` (cloud
   * `ON CONFLICT (organization_id, client_id) DO UPDATE`), links on `(organization_id,
   * idempotency_key) DO NOTHING`, audit on `(organization_id, client_audit_id) DO NOTHING` (audit is
   * append-only) — so the whole call is re-runnable. `links`/`audit` default to empty server-side, so
   * `{ items }` alone stays valid. Vectors are NEVER part of the body (privacy invariant).
   */
  syncMemoryItems(
    projectId: string,
    body: {
      items?: MemoryItemSyncInput[];
      links?: MemoryLinkSyncInput[];
      audit?: MemoryAuditSyncInput[];
    },
  ): Promise<MemorySyncResult> {
    return this.request<MemorySyncResult>(
      "POST",
      `/v1/projects/${projectId}/memory-items/sync`,
      body,
    );
  }

  /** List a project's memory items (server-side org + visibility filtered). */
  listMemoryItems(
    projectId: string,
    q?: MemoryListQuery,
  ): Promise<{ items: MemoryItemRecord[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (q?.status) params.set("status", q.status);
    if (q?.kind) params.set("kind", q.kind);
    if (q?.search) params.set("search", q.search);
    if (q?.limit !== undefined) params.set("limit", String(q.limit));
    if (q?.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return this.request<{ items: MemoryItemRecord[]; nextCursor?: string }>(
      "GET",
      `/v1/projects/${projectId}/memory-items${qs ? `?${qs}` : ""}`,
    );
  }

  // ── Team memory (HOR-464 / M4) ────────────────────────────────────────────

  /**
   * One-way PROMOTE local items into the workspace's shared team-memory store. Server-wins &
   * idempotent (`ON CONFLICT (workspace_id, origin_client_id) DO NOTHING`); it clamps/skips
   * confirmed-outcome (privacy). The body is a positive allowlist — vectors NEVER cross the wire.
   */
  promoteTeamMemory(
    projectId: string,
    body: { items: TeamMemoryPromoteInput[] },
  ): Promise<TeamMemoryPromoteResult> {
    return this.request<TeamMemoryPromoteResult>(
      "POST",
      `/v1/projects/${projectId}/team-memory/promote`,
      body,
    );
  }

  /**
   * Read the workspace's team-memory items with `seq > since`, ORDER BY seq ASC. The v1 client pulls
   * `since:'0'` and paginates on `nextCursor` until `hasMore` is false, then reconciles the local
   * cache. `includeDeleted` surfaces tombstones (deletedAt) so the cache can drop removed rows.
   */
  listTeamMemorySince(
    projectId: string,
    q: TeamMemoryListQuery,
  ): Promise<TeamMemoryListResult> {
    const params = new URLSearchParams();
    params.set("since", q.since);
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    if (q.includeDeleted) params.set("includeDeleted", "true");
    if (q.search) params.set("search", q.search);
    return this.request<TeamMemoryListResult>(
      "GET",
      `/v1/projects/${projectId}/team-memory?${params.toString()}`,
    );
  }
}
