import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CloudClient } from "./api.js";

// HOR-390: the outcome label rides the sync. getLatestOutcomeLabel is the only DB-touching call we
// stub; the real validate-on-read guards (isOutcomeResolved/isOutcomeSource) stay live so a bad row
// is exercised against the genuine firewall.
const dbMock = vi.hoisted(() => ({ getLatestOutcomeLabel: vi.fn() }));
vi.mock("@horus/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@horus/db")>();
  return { ...actual, getLatestOutcomeLabel: dbMock.getLatestOutcomeLabel };
});

import {
  uploadInvestigationToCloud,
  redactCloudValue,
  fetchInvestigationReportFromCloud,
  listCloudInvestigations,
  buildEvidenceItems,
  buildCitationEdges,
  resolveCitationEdges,
  toInvestigationOutcome,
} from "./investigation-sync.js";
import type { CloudConfig } from "./context-store.js";
import type { InvestigationReport } from "@horus/engine";
import type { HorusDb, OutcomeLabel } from "@horus/db";
import { HORUS_VERSION } from "@horus/core";

/** A fake db handle — never touched, because getLatestOutcomeLabel is mocked. */
const fakeDb = {} as HorusDb;

function labelRow(over: Partial<OutcomeLabel> = {}): OutcomeLabel {
  return {
    id: "ol_1",
    investigationId: "rep-1",
    resolved: "yes",
    source: "feedback",
    confirmedCause: null,
    note: null,
    project: "horus",
    payload: null,
    at: new Date("2026-06-28T12:00:00.000Z"),
    ...over,
  } as OutcomeLabel;
}

const API = "https://api.test";

function makeReport(overrides?: Partial<InvestigationReport>): InvestigationReport {
  return {
    id: "rep-1",
    input: { hint: "test hint", repo: "horus", since: undefined, service: undefined },
    summary: "test summary",
    seeds: [],
    evidence: [],
    timeline: { events: [] },
    correlation: { pairs: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], confidenceImpact: 0 },
    graph: { nodes: [], edges: [] },
    confidence: 0.8,
    nextActions: [],
    ...overrides,
  } as InvestigationReport;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("investigation-sync", () => {
  let client: CloudClient;
  let cfg: CloudConfig;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";

      if (u.endsWith("/evidence/batch") && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          items?: { engineRef: string }[];
        };
        // Simulate the cloud assigning ids while echoing each engine ref.
        return json({
          evidence: (body.items ?? []).map((it) => ({
            id: `cloud-${it.engineRef}`,
            engineRef: it.engineRef,
          })),
        });
      }
      if (u.endsWith("/citations") && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}") as { edges?: unknown[] };
        return json({ created: (body.edges ?? []).length });
      }
      if (u.endsWith("/investigations") && method === "POST") {
        return json({
          id: "inv-1",
          projectId: "p1",
          workspaceId: "w1",
          organizationId: "o1",
          title: "test hint",
          hint: "test hint",
          status: "running",
          idempotencyKey: "rep-1:investigation",
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
        });
      }
      if (u.includes("/investigations/") && u.endsWith("/evidence") && method === "POST") {
        return json({ id: "ev-1" });
      }
      if (u.includes("/investigations/") && u.endsWith("/agent-runs") && method === "POST") {
        return json({ id: "run-1" });
      }
      if (u.includes("/investigations/") && method === "PATCH") {
        return json({ id: "inv-1", status: "completed" });
      }
      if (u.includes("/investigations/") && u.endsWith("/evidence") && method === "GET") {
        return json([
          {
            id: "ev-1",
            investigationId: "inv-1",
            projectId: "p1",
            organizationId: "o1",
            type: "note",
            source: "cli",
            title: "Investigation report snapshot",
            content: JSON.stringify({ id: "rep-1", summary: "from cloud" }),
            contentFormat: "application/json",
            payload: { kind: "horus:report", report: { id: "rep-1", summary: "from cloud" } },
            idempotencyKey: "rep-1:report",
            createdAt: "2026-06-18T10:00:00.000Z",
          },
        ]);
      }
      if (u.includes("/investigations/") && method === "GET") {
        return json({
          id: "inv-1",
          projectId: "p1",
          workspaceId: "w1",
          organizationId: "o1",
          title: "test hint",
          hint: "test hint",
          status: "completed",
          idempotencyKey: null,
          createdAt: "2026-06-18T10:00:00.000Z",
          updatedAt: "2026-06-18T10:00:00.000Z",
          repositoryIds: ["r1"],
        });
      }
      if (u.endsWith("/investigations") && method === "GET") {
        // Cloud list endpoint returns a paginated object (HOR-244), not an array.
        return json({
          investigations: [
            {
              id: "inv-1",
              projectId: "p1",
              workspaceId: "w1",
              organizationId: "o1",
              title: "test hint",
              hint: "test hint",
              status: "completed",
              idempotencyKey: null,
              createdAt: "2026-06-18T10:00:00.000Z",
              updatedAt: "2026-06-18T10:00:00.000Z",
            },
          ],
          nextCursor: undefined,
        });
      }
      return json({ error: { code: "not_found", message: "no route" } }, 404);
    });
    vi.stubGlobal("fetch", fetchSpy);

    client = new CloudClient(API, "token");
    cfg = {
      context: "cloud",
      organization: { id: "o1", slug: "meritt-dev" },
      workspace: { id: "w1", slug: "internal-products" },
      project: { id: "p1", slug: "horus" },
      repository: { id: "r1", slug: "horus" },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dbMock.getLatestOutcomeLabel.mockReset();
  });

  it("uploads measured background timing and the validated model without inventing legacy metadata", async () => {
    const runTiming = { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:05Z" };
    await uploadInvestigationToCloud(client, cfg, makeReport({ unattended: { model: "claude-opus-5-5", status: "completed", sessionId: "session" } }), { runTiming });
    const call = fetchSpy.mock.calls.find((c: unknown[]) => (c[0] as string).endsWith("/agent-runs"))!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ ...runTiming, agent: "Horus background worker", model: "claude-opus-5-5" });
    const patch = fetchSpy.mock.calls.find((c: unknown[]) => (c[0] as string).includes("/agent-runs/") && (c[1] as RequestInit).method === "PATCH")!;
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toMatchObject({ ...runTiming, agent: "Horus background worker", model: "claude-opus-5-5" });
  });

  it("uploads a report snapshot to cloud", async () => {
    const report = makeReport();
    const refs = await uploadInvestigationToCloud(client, cfg, report);
    expect(refs).toEqual({ projectId: "p1", investigationId: "inv-1" });

    const createInvestigation = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).endsWith("/investigations") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createInvestigation).toBeDefined();
    expect(JSON.parse((createInvestigation![1] as RequestInit).body as string)).toMatchObject({
      title: "test hint",
      hint: "test hint",
      repositoryIds: ["r1"],
      idempotencyKey: "rep-1:investigation",
    });

    const createEvidence = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/evidence") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createEvidence).toBeDefined();
    const evidenceBody = JSON.parse((createEvidence![1] as RequestInit).body as string);
    // Must satisfy the cloud createEvidenceSchema: valid enum type + required fields.
    expect(["code_snippet", "log", "db_result", "runtime_evidence", "file_reference", "command_output", "note"]).toContain(evidenceBody.type);
    expect(evidenceBody.source).toBe("cli");
    expect(evidenceBody.title).toBeTruthy();
    expect(evidenceBody.contentFormat).toBe("application/json");
    expect(JSON.parse(evidenceBody.content).id).toBe("rep-1");
    expect(evidenceBody.payload.report.id).toBe("rep-1");

    const createRun = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/agent-runs") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(createRun).toBeDefined();
    const runBody = JSON.parse((createRun![1] as RequestInit).body as string);
    expect(runBody).toMatchObject({
      repositoryId: "r1",
      status: "completed",
      summary: "test summary",
      agent: "Horus CLI",
    });
    // HOR-313 #3: agent runs must report the real, build-injected CLI version
    // (HORUS_VERSION) — not the stale "0.0.0" that npm_package_version yields for
    // the built binary.
    expect(runBody.cliVersion).toBe(HORUS_VERSION);
    expect(runBody.cliVersion).not.toBe("0.0.0");

    const update = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("/investigations/") && (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(update).toBeDefined();
    expect(JSON.parse((update![1] as RequestInit).body as string)).toEqual({ status: "completed" });
  });

  it("fetches a saved cloud report from evidence", async () => {
    const report = await fetchInvestigationReportFromCloud(client, cfg, "inv-1");
    expect(report).not.toBeNull();
    expect(report?.id).toBe("rep-1");
    expect(report?.summary).toBe("from cloud");

    const detailCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).endsWith("/investigations/inv-1") && (c[1] as RequestInit)?.method === "GET",
    );
    expect(detailCall).toBeDefined();
  });

  it("lists cloud investigations", async () => {
    const rows = await listCloudInvestigations(client, cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("inv-1");
  });

  // ── Stage 1 dual-write: per-item evidence + citation edges ─────────────────

  function richReport(): InvestigationReport {
    return makeReport({
      id: "rep-2",
      seeds: [{ id: "sym1", name: "OrderService", filePath: "src/order.ts" }],
      evidence: [
        {
          id: "ev_log_1",
          source: "logs",
          kind: "log",
          title: "Error spike on checkout",
          relevance: 0.9,
          payload: {},
          links: { file: "src/checkout.ts", symbolId: "sym1" },
          provenance: { query: "level:error service:api", collectedAt: "2026-06-28T10:00:00.000Z" },
          subject: { service: "api", environment: "production" },
        },
        {
          id: "ev_metric_1",
          source: "metrics",
          kind: "metric",
          title: "Latency p99 up",
          relevance: 0.7,
          payload: {},
          links: {},
          provenance: { query: "p99", collectedAt: "2026-06-28T10:01:00.000Z" },
        },
      ],
      suspectedCauses: [
        {
          id: "cause1",
          title: "Queue backlog",
          category: "queue-backlog",
          // ev_unknown is dangling → must be cut (inert), never a fake link.
          sourceEvidenceIds: ["ev_log_1", "ev_unknown"],
          affectedNodeIds: [],
          baseScore: 0.5,
          finalScore: 0.8,
          confidence: 0.8,
          band: "likely",
          explanations: [],
        },
      ],
      hypotheses: [
        {
          id: "hyp1",
          category: "saturation",
          statement: "Backlog saturated the worker pool",
          confidence: 0.7,
          supportingEvidenceIds: ["ev_log_1", "ev_metric_1"],
          // contradicting refs must NEVER produce an edge (cut, no backing data).
          contradictingEvidenceIds: ["ev_log_1"],
          missingEvidence: [],
          verdict: "supported",
          priorConfidence: 0.6,
          supportingPresent: 2,
          contradictingPresent: 1,
          rationale: "two supporting items present",
        },
      ],
      findings: [
        {
          kind: "anomaly",
          title: "Latency anomaly",
          confidence: 0.6,
          // ev_gone is dangling → cut.
          evidenceIds: ["ev_metric_1", "ev_gone"],
        },
      ],
    } as Partial<InvestigationReport>);
  }

  it("dual-writes per-item evidence carrying engineRef/subject/provenance + keeps the blob", async () => {
    await uploadInvestigationToCloud(client, cfg, richReport());

    // The back-compat report blob is still written.
    const blob = fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).endsWith("/evidence") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(blob).toBeDefined();
    const blobBody = JSON.parse((blob![1] as RequestInit).body as string);
    expect(blobBody.payload.kind).toBe("horus:report");

    // Per-item evidence batch posted (single round-trip, not N+1).
    const batchCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string).endsWith("/evidence/batch") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(batchCalls).toHaveLength(1);
    const items = JSON.parse((batchCalls[0]![1] as RequestInit).body as string).items as Array<
      Record<string, unknown>
    >;
    expect(items).toHaveLength(2);

    const logItem = items.find((i) => i.engineRef === "ev_log_1")!;
    expect(logItem).toBeDefined();
    expect(logItem.kind).toBe("log");
    expect(logItem.service).toBe("api");
    expect(logItem.environment).toBe("production");
    expect(logItem.filePath).toBe("src/checkout.ts");
    expect(logItem.symbolName).toBe("OrderService"); // resolved from seed symbolId
    expect(logItem.provenance).toMatchObject({ query: "level:error service:api" });
    // Cloud evidence enum must stay valid.
    expect([
      "code_snippet",
      "log",
      "db_result",
      "runtime_evidence",
      "file_reference",
      "command_output",
      "note",
    ]).toContain(logItem.type);

    // Item with no symbolId resolves no symbolName (never fabricated).
    const metricItem = items.find((i) => i.engineRef === "ev_metric_1")!;
    expect(metricItem.symbolName).toBeUndefined();
    expect(metricItem.service).toBeUndefined();
  });

  it("dual-writes citation edges with refs resolved cross-seam; cuts dangling + contradicting", async () => {
    await uploadInvestigationToCloud(client, cfg, richReport());

    const citationCalls = fetchSpy.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as string).endsWith("/citations") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(citationCalls).toHaveLength(1);
    const edges = JSON.parse((citationCalls[0]![1] as RequestInit).body as string).edges as Array<{
      from: { type: string; ref: string };
      to: { type: string; ref: string };
      role: string;
    }>;

    // Evidence endpoints carry the CLOUD id, not the engine ev_ id (cross-seam).
    const evidenceTargets = edges.filter((e) => e.to.type === "evidence");
    expect(evidenceTargets.length).toBeGreaterThan(0);
    for (const e of evidenceTargets) {
      expect(e.to.ref.startsWith("cloud-")).toBe(true);
    }

    // cause → evidence (derives), resolved to cloud id.
    expect(
      edges.some(
        (e) => e.from.type === "cause" && e.to.ref === "cloud-ev_log_1" && e.role === "derives",
      ),
    ).toBe(true);
    // hypothesis → evidence (supports).
    expect(
      edges.some(
        (e) => e.from.type === "hypothesis" && e.to.ref === "cloud-ev_metric_1" && e.role === "supports",
      ),
    ).toBe(true);
    // finding → evidence (cites).
    expect(
      edges.some(
        (e) => e.from.type === "finding" && e.to.ref === "cloud-ev_metric_1" && e.role === "cites",
      ),
    ).toBe(true);
    // investigation root edges connect the typed nodes.
    expect(edges.some((e) => e.from.type === "investigation" && e.to.type === "cause")).toBe(true);

    // Dangling engine refs (ev_unknown / ev_gone) are cut — no cloud-ev_unknown link.
    expect(edges.some((e) => e.to.ref.includes("unknown") || e.to.ref.includes("gone"))).toBe(false);
    // Contradicting edges are cut entirely (no backing data yet).
    expect(edges.some((e) => e.role === "contradicts")).toBe(false);
  });

  it("builders carry engineRef and resolve citations against an engineId→cloudId map", () => {
    const report = richReport();

    const items = buildEvidenceItems(report);
    expect(items.map((i) => i.engineRef)).toEqual(["ev_log_1", "ev_metric_1"]);

    const rawEdges = buildCitationEdges(report, "inv-9");
    // Pre-resolution, evidence endpoints still hold the engine ev_ id.
    expect(rawEdges.some((e) => e.to.type === "evidence" && e.to.ref === "ev_log_1")).toBe(true);

    // Partial map: only ev_log_1 is known → edges to ev_metric_1 are cut (inert).
    const idMap = new Map<string, string>([["ev_log_1", "cloud-ev_log_1"]]);
    const resolved = resolveCitationEdges(rawEdges, idMap);
    expect(resolved.some((e) => e.to.type === "evidence" && e.to.ref === "cloud-ev_log_1")).toBe(true);
    expect(resolved.some((e) => e.to.type === "evidence" && e.to.ref === "ev_metric_1")).toBe(false);
    expect(resolved.some((e) => e.to.type === "evidence" && e.to.ref === "cloud-ev_metric_1")).toBe(
      false,
    );
  });

  it("keeps the upload green when the provenance receiver is absent (older cloud)", async () => {
    // Older cloud: /evidence/batch 404s. The blob upload must still succeed.
    fetchSpy.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      if (u.endsWith("/evidence/batch") && method === "POST") {
        return json({ error: { code: "not_found", message: "no route" } }, 404);
      }
      if (u.endsWith("/investigations") && method === "POST") {
        return json({ id: "inv-1", status: "running" });
      }
      return json({ id: "ok" });
    });

    const refs = await uploadInvestigationToCloud(client, cfg, richReport());
    expect(refs).toEqual({ projectId: "p1", investigationId: "inv-1" });
  });

  // ── HOR-390: human outcome label rides the tenant-scoped investigation sync ──

  function createInvestigationBody(): Record<string, unknown> {
    const call = fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as string).endsWith("/investigations") &&
        (c[1] as RequestInit)?.method === "POST",
    );
    expect(call).toBeDefined();
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it("includes the outcome object when the eval store has a label for the investigation", async () => {
    dbMock.getLatestOutcomeLabel.mockResolvedValue(
      labelRow({
        resolved: "partly",
        source: "confirm",
        note: "  partial fix  ",
        confirmedCause: "N+1 query in OrderService",
        at: new Date("2026-06-28T12:00:00.000Z"),
      }),
    );

    await uploadInvestigationToCloud(client, cfg, makeReport(), { db: fakeDb });

    // The label is looked up by the engine investigation id (report.id), the cross-seam key.
    expect(dbMock.getLatestOutcomeLabel).toHaveBeenCalledWith(fakeDb, "rep-1");
    expect(createInvestigationBody().outcome).toEqual({
      resolved: "partly",
      source: "confirm",
      note: "partial fix",
      confirmedCause: "N+1 query in OrderService",
      labeledAt: "2026-06-28T12:00:00.000Z",
    });
  });

  it("omits empty note/confirmedCause from the outcome (only verdict + source + time)", async () => {
    dbMock.getLatestOutcomeLabel.mockResolvedValue(
      labelRow({ resolved: "yes", source: "feedback", note: "   ", confirmedCause: null }),
    );

    await uploadInvestigationToCloud(client, cfg, makeReport(), { db: fakeDb });

    expect(createInvestigationBody().outcome).toEqual({
      resolved: "yes",
      source: "feedback",
      labeledAt: "2026-06-28T12:00:00.000Z",
    });
  });

  it("omits the outcome field when the investigation has no label (back-compat)", async () => {
    dbMock.getLatestOutcomeLabel.mockResolvedValue(null);

    await uploadInvestigationToCloud(client, cfg, makeReport(), { db: fakeDb });

    expect(dbMock.getLatestOutcomeLabel).toHaveBeenCalledWith(fakeDb, "rep-1");
    expect(createInvestigationBody()).not.toHaveProperty("outcome");
  });

  it("omits the outcome field (and never looks it up) when no db is provided", async () => {
    await uploadInvestigationToCloud(client, cfg, makeReport());

    expect(dbMock.getLatestOutcomeLabel).not.toHaveBeenCalled();
    expect(createInvestigationBody()).not.toHaveProperty("outcome");
  });

  it("is best-effort: an eval-store error never fails the sync (no outcome attached)", async () => {
    dbMock.getLatestOutcomeLabel.mockRejectedValue(new Error("db down"));

    const refs = await uploadInvestigationToCloud(client, cfg, makeReport(), { db: fakeDb });

    expect(refs).toEqual({ projectId: "p1", investigationId: "inv-1" });
    expect(createInvestigationBody()).not.toHaveProperty("outcome");
  });
});

describe("toInvestigationOutcome", () => {
  it("returns undefined for a null/absent label", () => {
    expect(toInvestigationOutcome(null)).toBeUndefined();
    expect(toInvestigationOutcome(undefined)).toBeUndefined();
  });

  it("maps a full label onto the frozen-contract shape", () => {
    expect(
      toInvestigationOutcome(
        labelRow({ resolved: "no", source: "confirm", note: "still broken", confirmedCause: "cache" }),
      ),
    ).toEqual({
      resolved: "no",
      source: "confirm",
      note: "still broken",
      confirmedCause: "cache",
      labeledAt: "2026-06-28T12:00:00.000Z",
    });
  });

  it("drops a row that fails the validate-on-read firewall (bad resolved/source)", () => {
    expect(toInvestigationOutcome(labelRow({ resolved: "maybe" as never }))).toBeUndefined();
    expect(toInvestigationOutcome(labelRow({ source: "telemetry" as never }))).toBeUndefined();
  });
});

it("preserves durable UUID identity and references during recursive export redaction", () => {
  const id = "30826839-0264-4713-9e98-b7db298805d3";
  expect(redactCloudValue({
    operation: { id, baseRevision: "0" },
    items: [{ clientId: id, record: { sourceRefs: [`horus:investigation:${id}`], token: id,
      note: "card 4111-1111-1111-1111", embeddings: [0.5] } }],
  })).toEqual({
    operation: { id, baseRevision: "0" },
    items: [{ clientId: id, record: { sourceRefs: [`horus:investigation:${id}`], token: "[REDACTED]",
      note: "card [REDACTED-CARD]" } }],
  });
});
