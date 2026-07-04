/**
 * Horus Memory M3 — the cloud-backed `MemoryStore` (the second factory behind the M1 seam).
 *
 * This is the cloud counterpart to `createLocalMemoryStore(db)`: it implements the SAME
 * `MemoryStore` interface (`@horus/engine`) but its bodies call the `/v1` API via `CloudClient`
 * instead of drizzle. It lives in the CLI's cloud layer — the engine NEVER imports cloud, so the
 * seam stays clean (mirrors investigation-sync).
 *
 * PRIVACY (non-negotiable, spec §5):
 *   - VECTORS NEVER LEAVE THE DEVICE. `toSyncInput` sends ONLY scalar/record fields; it never sends
 *     `payload` (where an embedding could hide) — see `toSyncInput`. The `MemoryVectorIndex` stays
 *     local-only in cloud mode; nothing here touches it.
 *   - `confirmed-outcome` is clamped to `visibility:'private'` before it leaves (the server clamps
 *     too — defense in depth). There is NO promotion path on the CLI side in M3.
 *
 * HONESTY (spec §6): this is a pure record store. `confidence`/`status`/`evidence` are opaque
 * authored attributes; nothing here computes or reads them into a scoring path.
 *
 * SCOPE: `memory_items`, `memory_links`, AND the append-only `memory_audit` trail are all mirrored
 * (one cloud transaction per the `/v1/.../memory-items/sync` endpoint). Links go out through
 * `addLink`; audit rows are mirrored by the dual-write wrapper via `pushAudit`, ALWAYS carrying the
 * CLI's real local ids so a later bulk `horus memory sync` dedupes (links on idempotencyKey, audit
 * on clientAuditId). Reads (`links`/`history`) and the legacy incident-recall seam
 * (`recall`/`record`/`loadScoped`) stay local-only via the dual-write wrapper below — the cloud is a
 * write mirror, never the read path.
 */

import type {
  MemoryStore,
  MemoryItem,
  NewMemoryItem,
  NewMemoryLink,
  MemoryQuery,
  MemoryStatus,
  Visibility,
  AuditCtx,
  MemoryLink,
  AnnotatedMemoryLink,
  MemoryAudit,
  MemoryEvidence,
  AddLinkOpts,
  RemoveLinkSpec,
  RemoveLinkOpts,
  MemoryUpdate,
  UpdateOpts,
} from "@horus/engine";
import {
  CloudClient,
  CloudError,
  type MemoryItemRecord,
  type MemoryItemSyncInput,
  type MemoryLinkSyncInput,
  type MemoryAuditSyncInput,
} from "./api.js";
import type { CloudConfig } from "./context-store.js";

/** Per-request cap so a runaway store never POSTs a multi-MB body (mirrors the cloud zod `.max`). */
const SYNC_BATCH_MAX = 500;
/** Default page size when scanning items back out of the cloud. */
const LIST_PAGE_LIMIT = 200;

/** confirmed-outcome can never be 'team' (spec §5.2) — clamp before anything leaves the device. */
function clampVisibility(
  kind: string | undefined | null,
  source: string | undefined | null,
  v: Visibility | undefined,
): Visibility {
  if (kind === "confirmed-outcome" || source === "confirmed-outcome") return "private";
  return v ?? "private";
}

/**
 * Map a CLI `NewMemoryItem` → the cloud sync wire shape. PRIVACY CHOKE POINT: this is an explicit
 * positive allowlist — `payload` is intentionally absent so no vector/embedding (which the CLI may
 * stash in `payload`) can ever be serialized over the wire.
 */
function toSyncInput(item: NewMemoryItem): MemoryItemSyncInput {
  const clientId = (item.id ?? "").trim();
  if (clientId === "") throw new Error("cloud memory sync requires a client item id");
  return {
    clientId,
    kind: item.kind,
    claim: item.claim,
    scope: item.scope,
    source: item.source,
    status: item.status ?? "fresh",
    confidence: item.confidence,
    visibility: clampVisibility(item.kind, item.source, item.visibility as Visibility | undefined),
    evidence: item.evidence as MemoryEvidence[] | undefined,
    lastVerifiedAt:
      item.lastVerifiedAt instanceof Date ? item.lastVerifiedAt.toISOString() : (item.lastVerifiedAt ?? null),
    lastVerifiedHash: item.lastVerifiedHash ?? null,
    clientCreatedAt:
      item.createdAt instanceof Date ? item.createdAt.toISOString() : (item.createdAt ?? null),
  };
}

/**
 * Map a CLI `NewMemoryLink` → the cloud link sync wire shape. `idempotencyKey` is the CLI link row's
 * own stable id (the cloud dedup key); `fromClientId` is the CLI item ULID the cloud resolves to its
 * own uuid. A blank id is rejected — a link with no stable id cannot be deduped on re-sync.
 */
export function toLinkSyncInput(link: NewMemoryLink): MemoryLinkSyncInput {
  const idempotencyKey = (link.id ?? "").trim();
  if (idempotencyKey === "") throw new Error("cloud memory sync requires a client link id");
  return {
    idempotencyKey,
    fromClientId: link.fromMemoryId,
    rel: link.rel,
    toKind: link.toKind,
    toRef: link.toRef,
    // The cloud schema omits (not nulls) an absent file path; map null/undefined away.
    ...(link.toFilePath ? { toFilePath: link.toFilePath } : {}),
  };
}

/**
 * Map a CLI `MemoryAudit` row → the cloud audit sync wire shape. `clientAuditId` is the CLI audit
 * row's own id (the append-only dedup key); `memoryClientId` is the CLI item ULID the cloud resolves.
 * `actor` is the verbatim provenance object (NOT a vector). Optional status/note fields are omitted
 * when absent so the body matches the cloud zod `.optional()` (which rejects null).
 */
export function toAuditSyncInput(row: MemoryAudit): MemoryAuditSyncInput {
  return {
    clientAuditId: row.id,
    memoryClientId: row.memoryId,
    action: row.action,
    actor: (row.actor as Record<string, unknown> | null) ?? {},
    ...(row.fromStatus ? { fromStatus: row.fromStatus } : {}),
    ...(row.toStatus ? { toStatus: row.toStatus } : {}),
    ...(row.note ? { note: row.note } : {}),
    // Coerce to RFC3339 — the local Postgres hands `at` back as a timestamp string
    // ("YYYY-MM-DD HH:MM:SS.ffffff+00"), which the cloud's strict z.string().datetime() rejects.
    // new Date(...) parses both that string and a Date, then toISOString() yields a valid `...Z`.
    at: new Date(row.at).toISOString(),
  };
}

/**
 * Map a cloud record → the `MemoryItem` row shape callers expect. `id` is ALWAYS the local ULID
 * (`clientId`) so callers stay unaware of cloud uuids. `repo` is stamped from context (the cloud
 * keys on `projectId`, not the local repo string). `payload` is never returned (it never left).
 */
function fromWire(r: MemoryItemRecord, repo: string): MemoryItem {
  return {
    id: r.clientId,
    kind: r.kind,
    claim: r.claim,
    scope: r.scope,
    source: r.source,
    evidence: (r.evidence as MemoryEvidence[] | undefined) ?? [],
    confidence: r.confidence,
    status: r.status,
    createdAt: new Date(r.clientCreatedAt ?? r.createdAt),
    lastVerifiedAt: r.lastVerifiedAt ? new Date(r.lastVerifiedAt) : null,
    lastVerifiedHash: r.lastVerifiedHash,
    orgId: r.organizationId ?? null,
    workspaceId: r.workspaceId ?? null,
    repo,
    userId: r.createdByUserId ?? null,
    visibility: r.visibility,
    // This is the write-only private mirror path (dualWrite reads local): a round-tripped record is
    // the device's OWN authored item, so it carries no team-cache provenance (HOR-464).
    origin: 'local',
    cloudId: null,
    authorName: null,
    pulledAt: null,
    payload: null,
    // Incident-family recall keys are LOCAL-ONLY context (like vectors): they never enter the
    // cloud-sync path, so a cloud-read row carries neither.
    signature: null,
    tags: null,
  };
}

/**
 * The cloud-backed store. Supersets `MemoryStore` with `pushAudit`: the append-only audit trail is
 * NOT writable through any standard seam method (the local store mints audit rows internally), so the
 * dual-write wrapper forwards the freshly-persisted local rows here, by their real ids.
 */
export interface CloudMemoryStore extends MemoryStore {
  /** Mirror already-persisted local audit rows (real ids → re-sync dedupes on clientAuditId). */
  pushAudit(rows: MemoryAudit[]): Promise<void>;
}

/**
 * The cloud-backed `MemoryStore`. `cfg.project.id` is required (HOR-46 fail-closed: a CLI with no
 * linked project cannot sync at all). Maps the M1 record's tenancy onto the cloud project/org via
 * `cloud.json` + the auth principal (server-resolved) — see the tenancy table in the spec §4.
 */
export function createCloudMemoryStore(client: CloudClient, cfg: CloudConfig): CloudMemoryStore {
  const projectId = cfg.project?.id;
  if (!projectId) throw new Error("cloud memory store requires a linked cloud project");
  // The cloud keys on projectId; we stamp this back onto read rows for the local `repo` field.
  const repoFallback = cfg.project?.slug ?? "";

  const findInList = async (clientId: string): Promise<MemoryItem | null> => {
    let cursor: string | undefined;
    // Bounded scan: the minimal-cut list has no clientId filter, so page until found/exhausted.
    for (let page = 0; page < 50; page++) {
      const { items, nextCursor } = await client.listMemoryItems(projectId, {
        limit: LIST_PAGE_LIMIT,
        cursor,
      });
      const hit = items.find((it) => it.clientId === clientId);
      if (hit) return fromWire(hit, repoFallback);
      if (!nextCursor) return null;
      cursor = nextCursor;
    }
    return null;
  };

  const upsertOne = async (item: MemoryItemSyncInput): Promise<void> => {
    await client.syncMemoryItems(projectId, { items: [item] });
  };

  return {
    // ---- legacy incident-recall seam: NOT cloud-backed in M3 (stays local via dual-write) ----
    async recall() {
      return [];
    },
    async record() {
      /* no-op: incident memory is local-only in M3 */
    },
    async loadScoped() {
      return [];
    },

    // ---- authored MemoryItem substrate over /v1 ----
    async add(item: NewMemoryItem): Promise<MemoryItem> {
      const input = toSyncInput(item);
      const res = await client.syncMemoryItems(projectId, { items: [input] });
      const record = res.items?.find((r) => r.clientId === input.clientId);
      if (record) return fromWire(record, item.repo ?? repoFallback);
      // The cloud accepted the upsert but did not echo the row — synthesize from local input so the
      // caller still gets a coherent MemoryItem (id is the local ULID, as always).
      return {
        id: input.clientId,
        kind: input.kind ?? item.kind,
        claim: input.claim ?? item.claim,
        scope: input.scope ?? item.scope,
        source: input.source ?? item.source,
        evidence: (item.evidence as MemoryEvidence[] | undefined) ?? [],
        confidence: item.confidence,
        status: input.status ?? "fresh",
        createdAt: item.createdAt instanceof Date ? item.createdAt : new Date(),
        lastVerifiedAt: item.lastVerifiedAt instanceof Date ? item.lastVerifiedAt : null,
        lastVerifiedHash: item.lastVerifiedHash ?? null,
        orgId: item.orgId ?? null,
        workspaceId: item.workspaceId ?? null,
        repo: item.repo ?? repoFallback,
        userId: item.userId ?? null,
        visibility: input.visibility ?? "private",
        origin: "local",
        cloudId: null,
        authorName: null,
        pulledAt: null,
        payload: null,
        // Incident-family recall keys stay LOCAL-ONLY — never synced, so the cloud echo carries neither.
        signature: null,
        tags: null,
      };
    },

    // HOR-432 consolidation mirror: refresh the scalar fields the cloud accepts (claim/confidence).
    // PRIVACY: `payload` NEVER leaves the device (it can stash a vector) — it is intentionally dropped
    // here, exactly like `add`/`toSyncInput`. The return is the server echo (or a synthesized stub) and
    // is only consumed by the dual-write wrapper, which discards it; reads always come from local.
    async update(id: string, patch: MemoryUpdate, _opts: UpdateOpts): Promise<MemoryItem> {
      const input: MemoryItemSyncInput = { clientId: id };
      if (patch.claim !== undefined) input.claim = patch.claim;
      if (patch.confidence !== undefined) input.confidence = patch.confidence;
      const res = await client.syncMemoryItems(projectId, { items: [input] });
      const record = res.items?.find((r) => r.clientId === id);
      if (record) return fromWire(record, repoFallback);
      // The cloud accepted the upsert but did not echo the row — synthesize a coherent stub (id stays
      // the local ULID). Discarded by the dual-write wrapper; the local store is the read source.
      return {
        id,
        kind: "investigation",
        claim: patch.claim ?? "",
        scope: "repo",
        source: "investigation",
        evidence: [],
        confidence: patch.confidence ?? 0,
        status: "fresh",
        createdAt: new Date(),
        lastVerifiedAt: null,
        lastVerifiedHash: null,
        orgId: null,
        workspaceId: null,
        repo: repoFallback,
        userId: null,
        visibility: "private",
        origin: "local",
        cloudId: null,
        authorName: null,
        pulledAt: null,
        payload: null,
        signature: null,
        tags: null,
      };
    },

    async get(id: string): Promise<MemoryItem | null> {
      try {
        return await findInList(id);
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) return null;
        throw e;
      }
    },

    async query(q: MemoryQuery): Promise<MemoryItem[]> {
      const repo = q.repo.trim();
      if (repo === "") return []; // HOR-46 fail-closed — no repo identity sees nothing

      const { items } = await client.listMemoryItems(projectId, {
        status: q.status && q.status.length === 1 ? q.status[0] : undefined,
        kind: q.kind && q.kind.length === 1 ? q.kind[0] : undefined,
        limit: q.limit,
      });

      // Server already org + visibility filtered; apply the remaining client-side predicates so the
      // contract matches the local store regardless of which filters the cloud supports.
      const statusSet = q.status && q.status.length > 0 ? new Set<MemoryStatus>(q.status) : null;
      const kindSet = q.kind && q.kind.length > 0 ? new Set<string>(q.kind) : null;
      let rows = items
        .filter((r) => (q.scope === undefined ? true : r.scope === q.scope))
        .filter((r) => (q.visibility === undefined ? true : r.visibility === q.visibility))
        .filter((r) => (statusSet ? statusSet.has(r.status as MemoryStatus) : true))
        .filter((r) => (kindSet ? kindSet.has(r.kind) : true))
        .map((r) => fromWire(r, repo));

      if (q.limit !== undefined && q.limit > 0) rows = rows.slice(0, Math.floor(q.limit));
      return rows;
    },

    async setStatus(id: string, status: MemoryStatus): Promise<void> {
      await upsertOne({ clientId: id, status });
    },

    async setVisibility(id: string, v: Visibility): Promise<void> {
      // Passthrough; the server clamps confirmed-outcome. No promotion semantics on the CLI (spec §5).
      await upsertOne({ clientId: id, visibility: v });
    },

    async verify(id: string, snap: { lastVerifiedHash: string | null }): Promise<void> {
      await upsertOne({
        clientId: id,
        lastVerifiedHash: snap.lastVerifiedHash,
        lastVerifiedAt: new Date().toISOString(),
      });
    },

    // ---- links / audit: WRITE-mirrored to the cloud; reads stay local via dual-write ----
    // `opts` (detection/audit) is accepted for interface fidelity; the cloud mirror carries the link
    // itself, while its audit row is forwarded separately via `pushAudit` (the trail stays append-only).
    async addLink(link: NewMemoryLink, _opts?: AddLinkOpts): Promise<MemoryLink> {
      const input = toLinkSyncInput(link);
      await client.syncMemoryItems(projectId, { links: [input] });
      // Echo a coherent MemoryLink — `id` is the CLI link id (cloud uuids stay hidden, as for items).
      return {
        id: input.idempotencyKey,
        fromMemoryId: link.fromMemoryId,
        rel: link.rel,
        toKind: link.toKind,
        toRef: link.toRef,
        toFilePath: link.toFilePath ?? null,
        createdAt: link.createdAt instanceof Date ? link.createdAt : new Date(),
      };
    },

    // Unlink has NO cloud endpoint in M3 (the sync API is additive/append-only). The local store is
    // authoritative for removals; a future cloud `unlink` endpoint will mirror this. No-op for now so
    // the dual-write wrapper never blocks a local unlink on the cloud.
    async removeLink(_spec: RemoveLinkSpec, _opts?: RemoveLinkOpts): Promise<number> {
      return 0;
    },

    async pushAudit(rows: MemoryAudit[]): Promise<void> {
      if (rows.length === 0) return;
      await client.syncMemoryItems(projectId, { audit: rows.map(toAuditSyncInput) });
    },

    // Reads are never cloud-backed (the cloud is a write mirror); the dual-write reads from local.
    async links(): Promise<AnnotatedMemoryLink[]> {
      return [];
    },
    async history(): Promise<MemoryAudit[]> {
      return [];
    },
  };
}

/**
 * Compose a LOCAL (authoritative) store with a CLOUD (best-effort mirror) into one `MemoryStore`.
 *
 * Writes go to local FIRST (local Postgres stays source-of-truth), then to the cloud best-effort —
 * a cloud failure NEVER throws (memory must never block local work; spec §3c/§7). Reads always come
 * from local. The legacy recall seam + links/history reads stay local; the cloud is a write mirror.
 *
 * Every mirrored mutation ALSO forwards the append-only audit row the local store just appended, by
 * its REAL local id (read back via `local.history`), so a later bulk `horus memory sync` dedupes
 * rather than double-writing the trail. A `cloud` that lacks `pushAudit` (e.g. another local store in
 * tests) simply skips audit mirroring. Links are forwarded with the persisted link's real id too.
 *
 * `onCloudError` lets the caller surface the failure (e.g. `reportCloudError`) without this layer
 * importing the command layer.
 */
export function dualWriteMemoryStore(
  local: MemoryStore,
  cloud: MemoryStore,
  onCloudError: (err: unknown) => void = () => {},
): MemoryStore {
  const mirror = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      onCloudError(err);
    }
  };

  // Present only on the cloud store (CloudMemoryStore) — a plain MemoryStore cannot accept audit.
  const pushAudit = (cloud as Partial<CloudMemoryStore>).pushAudit?.bind(cloud);
  /** Mirror the newest local audit row for `memoryId` (history is most-recent-first). */
  const mirrorLatestAudit = async (memoryId: string): Promise<void> => {
    if (!pushAudit) return;
    const trail = await local.history(memoryId);
    const latest = trail[0];
    if (latest) await pushAudit([latest]);
  };

  return {
    // reads → local
    recall: (i) => local.recall(i),
    loadScoped: (i) => local.loadScoped(i),
    get: (id) => local.get(id),
    query: (q) => local.query(q),
    links: (id, opts) => local.links(id, opts),
    history: (id) => local.history(id),

    // writes → local first (authoritative), then best-effort cloud mirror
    async record(i) {
      await local.record(i);
      await mirror(() => cloud.record(i));
    },
    async add(item, audit) {
      const row = await local.add(item, audit);
      // Mirror with the persisted row's id so the cloud upserts on the same ULID, then the audit row.
      await mirror(async () => {
        await cloud.add({ ...item, id: row.id }, audit);
        await mirrorLatestAudit(row.id);
      });
      return row;
    },
    async update(id, patch, opts) {
      const row = await local.update(id, patch, opts);
      await mirror(async () => {
        await cloud.update(id, patch, opts);
        await mirrorLatestAudit(id);
      });
      return row;
    },
    async setStatus(id, status, audit) {
      await local.setStatus(id, status, audit);
      await mirror(async () => {
        await cloud.setStatus(id, status, audit);
        await mirrorLatestAudit(id);
      });
    },
    async setVisibility(id, v, audit) {
      await local.setVisibility(id, v, audit);
      await mirror(async () => {
        await cloud.setVisibility(id, v, audit);
        await mirrorLatestAudit(id);
      });
    },
    async verify(id, snap, audit) {
      await local.verify(id, snap, audit);
      await mirror(async () => {
        await cloud.verify(id, snap, audit);
        await mirrorLatestAudit(id);
      });
    },
    async addLink(link, opts) {
      const row = await local.addLink(link, opts);
      // Forward the persisted link's REAL id so the cloud dedupes on the same idempotencyKey. The
      // link audit row (written locally with its detection provenance) is mirrored by `memory sync`.
      await mirror(() => cloud.addLink({ ...link, id: row.id }, opts));
      return row;
    },
    async removeLink(spec, opts) {
      // Local is authoritative for removals; the cloud has no unlink endpoint in M3, so this is a
      // local-only mutation (the cloud `removeLink` is a no-op). Reads/local stay the source of truth.
      const removed = await local.removeLink(spec, opts);
      await mirror(() => cloud.removeLink(spec, opts));
      return removed;
    },
  };
}
