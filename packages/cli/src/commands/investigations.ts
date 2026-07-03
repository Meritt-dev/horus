/**
 * `horus investigations` — list saved investigation IDs.
 *
 * The LOCAL audit store is the primary source: its ids are what `horus replay`,
 * `horus ask`, and `horus postmortem` accept. When the repo is cloud-linked,
 * team investigations that don't exist locally are appended as clearly-marked
 * `[cloud]` extras (browsable at cloud.horus.sh, not locally replayable) —
 * previously the cloud list REPLACED the local one, so every printed id was
 * un-replayable.
 */
import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { openDb, listInvestigations } from '@horus/db';
import { formatDateTime } from '../lib/format.js';
import { resolveDbUrl } from '../lib/db-url.js';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { listCloudInvestigations } from '../lib/cloud/investigation-sync.js';
import type { InvestigationRecord } from '../lib/cloud/api.js';

/**
 * The CLI pushes investigations with `idempotencyKey = "<localReportId>:investigation"`,
 * so the local (replayable) id is recoverable from a cloud row it originated from.
 */
function localIdFromCloudRow(row: InvestigationRecord): string | null {
  const key = row.idempotencyKey;
  if (!key) return null;
  const idx = key.lastIndexOf(':investigation');
  if (idx <= 0 || idx + ':investigation'.length !== key.length) return null;
  return key.slice(0, idx);
}

function printRow(id: string, createdAt: Date, title: string | null, marker?: string): void {
  const ts = formatDateTime(createdAt);
  const t = (title ?? '').length > 60 ? (title ?? '').slice(0, 57) + '...' : (title ?? '');
  console.log(`${id}  ${ts}  ${t}${marker !== undefined ? `  ${pc.dim(marker)}` : ''}`);
}

export async function runInvestigations(opts: {
  config?: string;
  limit?: number;
  /** Emit compact machine-readable JSON on stdout instead of human text. */
  json?: boolean;
}): Promise<number> {
  const json = opts.json === true;
  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);
  const cloudLinked = isCloudActive(cloudCfg);

  // 1. Local rows — the replayable source of truth, scoped to THIS project: the
  // shared DB holds every project's investigations and an unscoped list leaked
  // other projects' incident titles into this repo (dogfood N1).
  let project: string | undefined;
  try {
    project = resolveEnvironment(await loadConfig(opts.config)).project;
  } catch {
    /* unresolvable — leave unscoped */
  }
  let localRows: Array<{ id: string; createdAt: Date; title: string | null }> = [];
  let localError: Error | null = null;
  try {
    const { db, sql } = await openDb(await resolveDbUrl(opts.config));
    try {
      localRows = await listInvestigations(db, opts.limit ?? 20, { project });
    } finally {
      await sql.end();
    }
  } catch (err) {
    localError = err as Error;
  }
  if (localError && !cloudLinked) {
    // stdout must stay VALID JSON under --json (agents parse it); the human
    // message still goes to stderr in both modes.
    if (json) {
      console.log(JSON.stringify({ error: localError.message, investigations: [], count: 0 }, null, 2));
    }
    console.error(pc.red(localError.message));
    return 1;
  }

  const items: Array<{ id: string; createdAt: string; title: string | null; cloud: boolean }> =
    localRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      title: r.title,
      cloud: false,
    }));

  const localIds = new Set(localRows.map((r) => r.id));
  if (!json) {
    for (const row of localRows) {
      printRow(row.id, row.createdAt, row.title);
    }
  }

  // 2. Cloud-linked: append team investigations that don't exist locally.
  let cloudOnly = 0;
  let cloudNote: string | null = null;
  if (cloudLinked) {
    const session = authedClient();
    if (!session) {
      cloudNote = 'cloud-linked — run `horus login` to include team investigations';
    } else {
      try {
        const rows = await listCloudInvestigations(session.client, cloudCfg!);
        for (const row of rows) {
          const localId = localIdFromCloudRow(row);
          if (localId !== null && localIds.has(localId)) continue; // already listed locally
          cloudOnly += 1;
          items.push({
            id: row.id,
            createdAt: new Date(row.createdAt).toISOString(),
            title: row.title,
            cloud: true,
          });
          if (!json) printRow(row.id, new Date(row.createdAt), row.title, '[cloud]');
        }
        if (cloudOnly > 0) {
          cloudNote = '[cloud] entries live in Horus Cloud (cloud.horus.sh) — not locally replayable';
        }
      } catch {
        cloudNote = 'cloud list unavailable — showing local investigations only';
      }
    }
  }

  if (json) {
    const notes: string[] = [];
    if (localError) {
      notes.push(`local audit store unavailable — replay needs it (${localError.message})`);
    }
    if (cloudNote !== null) notes.push(cloudNote);
    console.log(
      JSON.stringify(
        {
          investigations: items,
          count: items.length,
          ...(notes.length > 0 ? { notes } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (localRows.length === 0 && cloudOnly === 0 && localError === null) {
    console.log('No investigations yet. Run: horus investigate "<hint>"');
  } else if (localRows.length > 0) {
    console.log(pc.dim('Replay locally: horus replay <id>  ·  postmortem: horus postmortem <id>'));
  }
  if (localError) {
    console.log(pc.dim(`local audit store unavailable — replay needs it (${localError.message})`));
  }
  if (cloudNote !== null) console.log(pc.dim(cloudNote));
  return 0;
}
