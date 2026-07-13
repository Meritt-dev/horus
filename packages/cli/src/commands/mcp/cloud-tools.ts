/**
 * Horus MCP cloud tools (HOR-CLI) — the Lens work queue over MCP.
 *
 * Unlike the knowledge tools (`tools.ts`), which are offline/local-only and synchronous,
 * these are CLOUD-BACKED and async: they surface client-reported Lens issues so an agent
 * can pull the backlog and act on it (`list_lens_reports`) and jump to the raise site of
 * any one report (`get_lens_report`). All fetch+shape is delegated to the shared
 * `lib/lens/reports.ts` (same core behind the `horus lens` CLI) — no parallel path.
 *
 * NATIVE-CONNECTOR CONTRACT: these light up only when the CLI is logged into Horus Cloud
 * AND the repo is cloud-linked; otherwise they return `ok:false` with a one-line remedy
 * (never throw, never fabricate). Read-only; comments/errors are redacted upstream.
 */
import { z, type ZodRawShape } from 'zod';
import type { ToolResult } from './tools.js';
import {
  listLensReports,
  getLensReportDetail,
  isLensUnavailable,
  isLensNotFound,
} from '../../lib/lens/reports.js';

export interface CloudTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>, root: string) => Promise<ToolResult>;
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** The Lens work-queue MCP tools (cloud-backed; bound to a repo root at call time). */
export const CLOUD_TOOLS: CloudTool[] = [
  {
    name: 'list_lens_reports',
    description:
      'List client-reported Lens issues (bug reports users filed from the running app) as a work queue — newest first, across the workspace. Use this to find real user-reported problems to fix, independent of any investigation. Needs the CLI logged in (`horus login`) and the repo cloud-linked (`horus cloud link`); returns a remedy otherwise. Each row: id, status, route, comment, errorCount. Call get_lens_report for the code seed (file:line) to fix.',
    inputSchema: {
      status: z
        .string()
        .optional()
        .describe('Filter by report status (default: submitted).'),
      all: z
        .boolean()
        .optional()
        .describe('Include every status (drop the default submitted filter).'),
      limit: z.number().int().optional().describe('Max reports, 1–200 (default 50).'),
      since: z
        .string()
        .optional()
        .describe('Only reports created on/after this ISO date.'),
    },
    handler: async (args, root) => {
      const result = await listLensReports(root, {
        status: asString(args.status),
        all: args.all === true,
        limit: asNumber(args.limit),
        since: asString(args.since),
      });
      if (isLensUnavailable(result)) {
        return { ok: false, summary: `Lens work queue unavailable — ${result.remedy}` };
      }
      const n = result.reports.length;
      return {
        ok: true,
        summary:
          n === 0
            ? 'No client-reported Lens issues.'
            : `${n} client-reported issue(s) across ${result.sites} site(s). Use get_lens_report <id> for the code seed.`,
        data: result,
      };
    },
  },
  {
    name: 'get_lens_report',
    description:
      'Fetch one Lens report in full: comment, route, release/gitSha, failing requests, top error message, and the code seed (file:line:symbol — the raise site to fix). Needs login + cloud link.',
    inputSchema: {
      reportId: z.string().describe('The Lens report id (e.g. rep_abc123).'),
      site: z
        .string()
        .optional()
        .describe("The report's Lens site id (skips the cross-site scan)."),
    },
    handler: async (args, root) => {
      const reportId = asString(args.reportId);
      if (reportId === undefined) return { ok: false, summary: 'reportId is required.' };
      const detail = await getLensReportDetail(root, reportId, {
        siteId: asString(args.site),
      });
      if (isLensUnavailable(detail)) {
        return { ok: false, summary: `Lens work queue unavailable — ${detail.remedy}` };
      }
      if (isLensNotFound(detail)) {
        return { ok: false, summary: `No Lens report ${reportId} in this workspace.` };
      }
      const seed = detail.seed
        ? ` Seed: ${detail.seed.file}${detail.seed.line !== undefined ? `:${detail.seed.line}` : ''}`
        : ' No code seed (no parseable stack frame).';
      return {
        ok: true,
        summary: `Lens report ${detail.id} [${detail.status}].${seed}`,
        data: detail,
      };
    },
  },
];
