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
}): Promise<number> {
  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);
  const cloudLinked = isCloudActive(cloudCfg);

  // 1. Local rows — the replayable source of truth.
  let localRows: Array<{ id: string; createdAt: Date; title: string | null }> = [];
  let localError: Error | null = null;
  try {
    const { db, sql } = await openDb(await resolveDbUrl(opts.config));
    try {
      localRows = await listInvestigations(db, opts.limit ?? 20);
    } finally {
      await sql.end();
    }
  } catch (err) {
    localError = err as Error;
  }
  if (localError && !cloudLinked) {
    console.error(pc.red(localError.message));
    return 1;
  }

  const localIds = new Set(localRows.map((r) => r.id));
  for (const row of localRows) {
    printRow(row.id, row.createdAt, row.title);
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
          printRow(row.id, new Date(row.createdAt), row.title, '[cloud]');
        }
        if (cloudOnly > 0) {
          cloudNote = '[cloud] entries live in Horus Cloud (cloud.horus.sh) — not locally replayable';
        }
      } catch {
        cloudNote = 'cloud list unavailable — showing local investigations only';
      }
    }
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
