/**
 * `horus lens` — the client-reported issue work queue (HOR-CLI).
 *
 * Lens reports are client-filed bug reports from the running app. `horus investigate`
 * already folds them in as incident evidence; this command exposes them as a standalone
 * BACKLOG the agent can browse and act on:
 *
 *   horus lens                 list every client report (newest first)
 *   horus lens --json          agent-consumable
 *   horus lens --status open   filter by status
 *   horus lens show <id>       full detail incl. the code seed (file:line to fix)
 *
 * Thin adapter: all fetch+shape lives in `lib/lens/reports.ts` (reused by the MCP tools).
 * NATIVE-CONNECTOR CONTRACT: needs `horus login` + `horus cloud link`; otherwise it prints
 * a remedy and, under --json, still emits valid JSON so agents never choke.
 */
import pc from 'picocolors';
import { formatDateTime } from '../lib/format.js';
import { repoRootOrCwd } from '../lib/cloud/session.js';
import {
  listLensReports,
  getLensReportDetail,
  isLensUnavailable,
  isLensNotFound,
  type LensReportRow,
} from '../lib/lens/reports.js';

function truncate(s: string | undefined, n: number): string {
  if (s === undefined || s === '') return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

function printRow(r: LensReportRow): void {
  const ts = formatDateTime(new Date(r.createdAt));
  const status = pc.dim(`[${r.status || '?'}]`);
  const route = r.route ? pc.cyan(r.route) : pc.dim('(no route)');
  const errs = r.errorCount > 0 ? pc.red(`${r.errorCount}err`) : pc.dim('0err');
  const comment = truncate(r.comment, 60) || pc.dim('(no comment)');
  console.log(`${r.id}  ${ts}  ${status}  ${route}  ${comment}  ${errs}`);
}

export async function runLensList(opts: {
  status?: string;
  all?: boolean;
  limit?: number;
  since?: string;
  site?: string;
  json?: boolean;
}): Promise<number> {
  const json = opts.json === true;
  const root = repoRootOrCwd();

  let result;
  try {
    result = await listLensReports(root, {
      status: opts.status,
      all: opts.all,
      limit: opts.limit,
      since: opts.since,
      siteId: opts.site,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (json)
      console.log(JSON.stringify({ reports: [], count: 0, notes: [message] }, null, 2));
    console.error(pc.red(message));
    return 1;
  }

  if (isLensUnavailable(result)) {
    if (json) {
      console.log(
        JSON.stringify({ reports: [], count: 0, notes: [result.remedy] }, null, 2),
      );
    } else {
      console.log(pc.yellow(`Lens work queue unavailable — ${result.remedy}`));
    }
    return json ? 0 : 1;
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          reports: result.reports,
          count: result.reports.length,
          sites: result.sites,
          ...(result.notes ? { notes: result.notes } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (result.reports.length === 0) {
    console.log('No client reports. Clients file them from the app via Horus Lens.');
    return 0;
  }
  for (const r of result.reports) printRow(r);
  console.log(
    pc.dim(`\n${result.reports.length} report(s) · detail: horus lens show <id>`),
  );
  if (result.notes) for (const n of result.notes) console.log(pc.dim(n));
  return 0;
}

export async function runLensShow(
  reportId: string,
  opts: { site?: string; json?: boolean },
): Promise<number> {
  const json = opts.json === true;
  const root = repoRootOrCwd();

  let detail;
  try {
    detail = await getLensReportDetail(root, reportId, { siteId: opts.site });
  } catch (err) {
    const message = (err as Error).message;
    if (json) console.log(JSON.stringify({ error: message }, null, 2));
    console.error(pc.red(message));
    return 1;
  }

  if (isLensUnavailable(detail)) {
    if (json) console.log(JSON.stringify({ error: detail.remedy }, null, 2));
    else console.log(pc.yellow(`Lens work queue unavailable — ${detail.remedy}`));
    return json ? 0 : 1;
  }

  if (isLensNotFound(detail)) {
    const msg = `No Lens report ${reportId} in this workspace.`;
    if (json) console.log(JSON.stringify({ error: msg, notFound: true }, null, 2));
    else console.log(pc.yellow(msg));
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(detail, null, 2));
    return 0;
  }

  console.log(pc.bold(`Lens report ${detail.id}`) + `  ${pc.dim(`[${detail.status}]`)}`);
  if (detail.comment)
    console.log(`  ${pc.bold('comment')}   ${truncate(detail.comment, 200)}`);
  if (detail.route) console.log(`  ${pc.bold('route')}     ${pc.cyan(detail.route)}`);
  console.log(`  ${pc.bold('filed')}     ${formatDateTime(new Date(detail.createdAt))}`);
  if (detail.release) console.log(`  ${pc.bold('release')}   ${detail.release}`);
  if (detail.gitSha) console.log(`  ${pc.bold('gitSha')}    ${detail.gitSha}`);
  if (detail.topErrorMessage)
    console.log(
      `  ${pc.bold('error')}     ${pc.red(truncate(detail.topErrorMessage, 160))}`,
    );
  if (detail.seed) {
    const loc = `${detail.seed.file}${detail.seed.line !== undefined ? `:${detail.seed.line}` : ''}`;
    const sym = detail.seed.symbol ? pc.dim(` (${detail.seed.symbol})`) : '';
    console.log(
      `  ${pc.bold('seed')}      ${pc.green(loc)}${sym}  ${pc.dim('← raise site to fix')}`,
    );
  }
  if (detail.failingRequests.length > 0) {
    console.log(`  ${pc.bold('failing')}`);
    for (const req of detail.failingRequests) {
      console.log(`    ${req.method} ${req.url} ${pc.red(String(req.status ?? '?'))}`);
    }
  }
  return 0;
}
