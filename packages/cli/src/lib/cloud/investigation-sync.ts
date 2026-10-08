import { workerRunLogs, type WorkerActivity } from "../worker-activity.js";
import { createHash } from 'node:crypto';
/**
 * Reusable cloud write-path library (HOR-239): persist and retrieve a Horus
 * investigation through the Horus Cloud API. The CLI never touches cloud
 * Postgres directly. (The `horus investigate`/`ask` command wiring that calls
 * these helpers is HOR-228.)
 */
import type {
  CitationEdgeInput,
  CitationNode,
  CloudClient,
  EvidenceRecord,
  InvestigationOutcome,
  InvestigationRecord,
  ProvenanceEvidenceInput,
} from "./api.js";
import { CloudError, CloudOfflineError } from "./api.js";
import type { CloudConfig } from "./context-store.js";
import type { InvestigationReport } from "@horus/engine";
import { HORUS_VERSION, redactSecrets } from "@horus/core";
import { getLatestOutcomeLabel, isOutcomeResolved, isOutcomeSource } from "@horus/db";
import type { HorusDb, OutcomeLabel } from "@horus/db";

// The cloud evidence schema (HOR-227/HOR-233) requires a valid `type` enum plus
// title/content/contentFormat. A Horus report snapshot is stored as a `note`
// with the full report serialized into `content` (and mirrored in `payload` for
// convenient structured retrieval). `payload.kind` marks it as our snapshot.
const REPORT_EVIDENCE_TYPE = "note";
const REPORT_EVIDENCE_SOURCE = "cli";
const REPORT_EVIDENCE_TITLE = "Investigation report snapshot";
const REPORT_EVIDENCE_KIND = "horus:report";
const REPORT_CONTENT_FORMAT = "application/json";

/** `payload.kind` marker for a per-item evidence row (vs the `horus:report` blob). */
const EVIDENCE_ITEM_KIND = "horus:evidence";

/**
 * Map an engine `EvidenceKind` onto the cloud evidence-table `type` enum
 * (`code_snippet | log | db_result | runtime_evidence | file_reference |
 * command_output | note`). The real engine kind is carried verbatim in the
 * `kind` column; this is only the coarse cloud bucket. Unknown → `note`.
 */
const CLOUD_EVIDENCE_TYPE_BY_KIND: Record<string, string> = {
  log: "log",
  metric: "runtime_evidence",
  "queue-state": "runtime_evidence",
  "queue-edge": "runtime_evidence",
  "redis-key": "runtime_evidence",
  state: "runtime_evidence",
  symbol: "code_snippet",
  flow: "code_snippet",
  impact: "code_snippet",
  commit: "file_reference",
};

function cloudEvidenceType(kind: string): string {
  return CLOUD_EVIDENCE_TYPE_BY_KIND[kind] ?? "note";
}

export interface CloudInvestigationRefs {
  agentRunId?: string;
  projectId: string;
  investigationId: string;
}

function idempotencyKey(reportId: string, suffix: string): string {
  return `${reportId}:${suffix}`;
}

/** Apply existing secret redaction recursively to exported records; vectors and credentials are excluded. */
export function redactCloudValue<T>(value: T): T {
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([key]) => !/^(embedding|embeddings|vector|vectors)$/i.test(key))
      .map(([key, item]) => [key, /^(password|secret|token|authorization|api[_-]?key|access[_-]?token)$/i.test(key) ? '[REDACTED]' : clean(item)]));
    return v;
  };
  return clean(value) as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Materialize the report's evidence as per-item cloud evidence rows (Stage 1).
 *
 * Each row carries the engine `ev_…` id (`engineRef`), its subject (service/
 * environment), source, reproducibility provenance, the engine `kind`, and the
 * mapped `filePath`/`symbolName`. `filePath`/`symbolName` resolve from the
 * evidence links (and the seed symbol table) ONLY when a real value exists —
 * never fabricated. Pure: same report → same rows.
 */
export function buildEvidenceItems(report: InvestigationReport): ProvenanceEvidenceInput[] {
  // Resolve symbolId → {name, filePath} from the seed symbols (real values only).
  const symbolName = new Map<string, string>();
  const symbolFile = new Map<string, string>();
  for (const s of report.seeds ?? []) {
    if (!s?.id) continue;
    if (s.name) symbolName.set(s.id, s.name);
    if (s.filePath) symbolFile.set(s.id, s.filePath);
  }

  return (report.evidence ?? []).map((ev) => {
    const symbolId = ev.links?.symbolId;
    const filePath = ev.links?.file ?? (symbolId ? symbolFile.get(symbolId) : undefined);
    const sName = symbolId ? symbolName.get(symbolId) : undefined;
    const item: ProvenanceEvidenceInput = {
      type: cloudEvidenceType(ev.kind),
      source: ev.source,
      title: ev.title,
      content: JSON.stringify(ev),
      contentFormat: REPORT_CONTENT_FORMAT,
      payload: { kind: EVIDENCE_ITEM_KIND, engineRef: ev.id },
      idempotencyKey: idempotencyKey(report.id, `ev:${ev.id}`),
      engineRef: ev.id,
      kind: ev.kind,
    };
    if (ev.subject?.service !== undefined) item.service = ev.subject.service;
    if (ev.subject?.environment !== undefined) item.environment = ev.subject.environment;
    if (ev.provenance) item.provenance = ev.provenance;
    if (filePath !== undefined) item.filePath = filePath;
    if (sName !== undefined) item.symbolName = sName;
    return item;
  });
}

/**
 * Build the citation graph (Stage 1): cause → evidence (`derives`), hypothesis →
 * evidence (`supports`), finding → evidence (`cites`), each rooted at the
 * investigation node. Edges are built ONLY from the report's real evidence ids
 * (`sourceEvidenceIds` / `supportingEvidenceIds` / `evidenceIds`) that resolve to
 * an actual evidence item — a dangling ref is inert (cut), never a fake link.
 * Contradicting hypothesis edges are CUT (no backing data yet).
 *
 * Evidence-node `ref`s here are still the ENGINE `ev_…` ids; the writer resolves
 * them to cloud ids via {@link resolveCitationEdges} before posting. Pure.
 */
export function buildCitationEdges(
  report: InvestigationReport,
  investigationId: string,
): CitationEdgeInput[] {
  const byId = new Map((report.evidence ?? []).map((e) => [e.id, e]));
  const subject = report.subject;
  const edges: CitationEdgeInput[] = [];

  const investigationNode: CitationNode = {
    type: "investigation",
    ref: investigationId,
    label: report.input?.hint?.slice(0, 200) || "Investigation",
    confidence: report.confidence,
    ...(subject ? { subject } : {}),
  };

  // An evidence node, ONLY when the engine id resolves to a real item (else null).
  const evidenceNode = (engineRef: string): CitationNode | null => {
    const ev = byId.get(engineRef);
    if (!ev) return null;
    return {
      type: "evidence",
      ref: ev.id,
      label: ev.title,
      ...(ev.subject ? { subject: ev.subject } : {}),
    };
  };

  for (const c of report.suspectedCauses ?? []) {
    const causeNode: CitationNode = {
      type: "cause",
      ref: c.id,
      label: c.title,
      confidence: c.confidence,
      band: c.band,
      ...(subject ? { subject } : {}),
    };
    let cited = false;
    for (const evId of c.sourceEvidenceIds ?? []) {
      const en = evidenceNode(evId);
      if (en) {
        edges.push({ from: causeNode, to: en, role: "derives" });
        cited = true;
      }
    }
    if (cited) edges.push({ from: investigationNode, to: causeNode, role: "derives" });
  }

  for (const h of report.hypotheses ?? []) {
    const hypNode: CitationNode = {
      type: "hypothesis",
      ref: h.id,
      label: h.statement,
      confidence: h.confidence,
      verdict: h.verdict,
      ...(subject ? { subject } : {}),
    };
    let cited = false;
    for (const evId of h.supportingEvidenceIds ?? []) {
      const en = evidenceNode(evId);
      if (en) {
        edges.push({ from: hypNode, to: en, role: "supports" });
        cited = true;
      }
    }
    // CUT: contradicting hypothesis edges are not emitted (no backing data yet).
    if (cited) edges.push({ from: investigationNode, to: hypNode, role: "explains" });
  }

  (report.findings ?? []).forEach((f, i) => {
    const findingNode: CitationNode = {
      type: "finding",
      ref: `${report.id}:finding:${i}`,
      label: f.title,
      confidence: f.confidence,
      ...(subject ? { subject } : {}),
    };
    let cited = false;
    for (const evId of f.evidenceIds ?? []) {
      const en = evidenceNode(evId);
      if (en) {
        edges.push({ from: findingNode, to: en, role: "cites" });
        cited = true;
      }
    }
    if (cited) edges.push({ from: investigationNode, to: findingNode, role: "cites" });
  });

  return edges;
}

/**
 * Resolve evidence-node `ref`s from engine `ev_…` ids to cloud ids using the
 * engineRef→cloudId map returned by the evidence batch. An edge whose evidence
 * endpoint does not resolve is CUT (inert) — we never emit a fake link. Pure.
 */
export function resolveCitationEdges(
  edges: CitationEdgeInput[],
  idMap: Map<string, string>,
): CitationEdgeInput[] {
  const resolveNode = (n: CitationNode): CitationNode | null => {
    if (n.type !== "evidence") return n;
    const cloudId = idMap.get(n.ref);
    if (!cloudId) return null;
    return { ...n, ref: cloudId };
  };

  const out: CitationEdgeInput[] = [];
  for (const e of edges) {
    const from = resolveNode(e.from);
    const to = resolveNode(e.to);
    if (!from || !to) continue;
    out.push({ from, to, role: e.role });
  }
  return out;
}

/**
 * Stage 1 dual-write: materialize per-item evidence rows + citation edges in the
 * cloud, in batched calls (no N+1). Best-effort enrichment — the report blob
 * remains the source of truth, so a provenance failure (older cloud / transient)
 * is swallowed and never fails the upload. Additive: scoring/verdict untouched.
 */
async function writeInvestigationProvenance(
  client: CloudClient,
  projectId: string,
  investigationId: string,
  report: InvestigationReport,
): Promise<void> {
  try {
    const items = buildEvidenceItems(report);
    if (items.length === 0) return;

    const { evidence: created } = await client.createEvidenceBatch(projectId, investigationId, {
      items,
    });

    const idMap = new Map<string, string>();
    for (const row of created ?? []) {
      if (row?.engineRef && row?.id) idMap.set(row.engineRef, row.id);
    }

    const edges = resolveCitationEdges(buildCitationEdges(report, investigationId), idMap);
    if (edges.length > 0) {
      await client.createCitations(projectId, investigationId, { edges });
    }
  } catch (err) {
    // Older cloud (endpoint absent → 404) or a transient cloud/network failure:
    // the blob upload already succeeded, so keep the upload green. Re-throw only
    // genuinely unexpected (non-cloud) errors so real bugs still surface.
    if (err instanceof CloudError || err instanceof CloudOfflineError) return;
    throw err;
  }
}

/**
 * Map an eval-store outcome label (HOR-390) onto the frozen-contract `outcome` payload that rides
 * the investigation sync. Returns `undefined` for no label — and, defensively, for a label whose
 * `resolved`/`source` fail the validate-on-read firewall — so a bad row never pollutes the sync.
 * Pure: same label → same payload. `note`/`confirmedCause` are included only when non-empty.
 */
export function toInvestigationOutcome(
  label: OutcomeLabel | null | undefined,
): InvestigationOutcome | undefined {
  if (!label) return undefined;
  if (!isOutcomeResolved(label.resolved) || !isOutcomeSource(label.source)) return undefined;
  const labeledAt =
    label.at instanceof Date ? label.at.toISOString() : new Date(label.at).toISOString();
  const outcome: InvestigationOutcome = {
    resolved: label.resolved,
    source: label.source,
    labeledAt,
  };
  const note = label.note?.trim();
  if (note) outcome.note = note;
  const confirmedCause = label.confirmedCause?.trim();
  if (confirmedCause) outcome.confirmedCause = confirmedCause;
  return outcome;
}

/**
 * Resolve the current human outcome label for an investigation from the local eval store and map it
 * onto the frozen-contract `outcome` payload. Best-effort: a missing/unreachable store (or a bad
 * row) yields `undefined` so the sync stays additive and never fails on the label lookup. The label
 * is keyed by the engine investigation id (`report.id`) — the same cross-seam id `horus feedback` /
 * `horus memory confirm` write under.
 */
async function resolveOutcomeForSync(
  db: HorusDb | undefined,
  investigationId: string,
): Promise<InvestigationOutcome | undefined> {
  if (!db) return undefined;
  try {
    const label = await getLatestOutcomeLabel(db, investigationId);
    return toInvestigationOutcome(label);
  } catch {
    return undefined;
  }
}

/**
 * Upload the results of a locally-run investigation to Horus Cloud.
 *
 * Creates the investigation, attaches a snapshot of the full report as
 * evidence, and records the CLI execution as an AgentRun. This keeps the
 * deterministic engine local while sharing results through the cloud API.
 *
 * When `opts.db` is provided, the current human outcome label for this investigation (HOR-390 eval
 * store) rides the tenant-scoped create payload as an additive `{outcome}` object (frozen contract);
 * no label → no `outcome` field (back-compat). The anonymous feedback telemetry path is untouched.
 */
export async function uploadInvestigationToCloud(
  client: CloudClient,
  cfg: CloudConfig,
  report: InvestigationReport,
  opts: { db?: HorusDb; runTiming?: { startedAt: string; endedAt: string }; runActivity?: WorkerActivity[] } = {},
): Promise<CloudInvestigationRefs> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }

  report = redactCloudValue(report);
  const projectId = cfg.project.id;
  const repositoryIds = cfg.repository?.id ? [cfg.repository.id] : undefined;

  const outcome = await resolveOutcomeForSync(opts.db, report.id);

  const investigation = await client.createInvestigation(projectId, {
    title: report.input.hint.slice(0, 500) || "Untitled investigation",
    hint: report.input.hint,
    repositoryIds,
    idempotencyKey: idempotencyKey(report.id, "investigation"),
    ...(outcome ? { outcome } : {}),
  });

  await client.createEvidence(projectId, investigation.id, {
    type: REPORT_EVIDENCE_TYPE,
    source: REPORT_EVIDENCE_SOURCE,
    title: REPORT_EVIDENCE_TITLE,
    content: JSON.stringify(report),
    contentFormat: REPORT_CONTENT_FORMAT,
    payload: { kind: REPORT_EVIDENCE_KIND, report: clone(report) },
    idempotencyKey: idempotencyKey(report.id, `report:${createHash('sha256').update(JSON.stringify(report)).digest('hex')}`),
  });

  // Stage 1 dual-write: in addition to the back-compat blob above, materialize the
  // structured provenance graph (per-item evidence rows + citation edges). Additive
  // and best-effort — never affects the blob or the upload result.
  await writeInvestigationProvenance(client, projectId, investigation.id, report);

  const runMetadata = {
    agent: report.unattended?.engineOnly ? "Horus background worker · engine only" : report.unattended ? "Horus background worker" : "Horus CLI",
    model: report.unattended?.status === 'completed' ? report.unattended.model : undefined,
    ...opts.runTiming,
    ...(opts.runActivity ? workerRunLogs(opts.runActivity, report.aiJudgment) : {}),
    cliVersion: HORUS_VERSION,
    summary: report.summary,
  };
  const run = await client.createAgentRun(projectId, investigation.id, {
    ...runMetadata, repositoryId: cfg.repository?.id, status: "completed",
    idempotencyKey: idempotencyKey(report.id, "run"),
  });
  // Memory sync may have created this stable run before inference completed.
  // Enrich that same record; a later metadata-only backfill must not erase timing/model.
  if (report.unattended || opts.runTiming || opts.runActivity)
    await client.updateAgentRun(projectId, investigation.id, run.id, runMetadata);

  await client.updateInvestigation(projectId, investigation.id, { status: "completed" });

  return { projectId, investigationId: investigation.id, agentRunId: run.id };
}

function findReportEvidence(evidence: EvidenceRecord[]): InvestigationReport | null {
  const record = [...evidence].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).find((e) => {
    const payload = e.payload as { kind?: unknown } | undefined;
    return e.source === REPORT_EVIDENCE_SOURCE && payload?.kind === REPORT_EVIDENCE_KIND;
  });
  if (!record) return null;
  // Prefer the structured payload mirror; fall back to the serialized content.
  const payload = record.payload as { report?: unknown } | undefined;
  if (payload?.report) return clone(payload.report) as InvestigationReport;
  try {
    return JSON.parse(record.content) as InvestigationReport;
  } catch {
    return null;
  }
}

/**
 * Fetch a cloud investigation and reconstruct the saved report from its
 * evidence. Returns null when no report snapshot is attached.
 */
export async function fetchInvestigationReportFromCloud(
  client: CloudClient,
  cfg: CloudConfig,
  investigationId: string,
): Promise<InvestigationReport | null> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }

  const projectId = cfg.project.id;
  await client.getInvestigation(projectId, investigationId);
  const evidence = await client.listEvidence(projectId, investigationId);
  return findReportEvidence(evidence);
}

export async function listCloudInvestigations(
  client: CloudClient,
  cfg: CloudConfig,
): Promise<InvestigationRecord[]> {
  if (!cfg.project) {
    throw new Error("Cloud config is missing a linked project.");
  }
  const result = await client.listInvestigations(cfg.project.id);
  return result.investigations;
}
