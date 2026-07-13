/**
 * Horus MCP server (HOR-295) — stdio transport exposing Horus to coding agents
 * (Claude Code, Codex, Cursor, …).
 *
 * Two tool families:
 *   - KNOWLEDGE_TOOLS (tools.ts): the active repo's `.horus/index/` snapshot, read
 *     through the same query layer as `horus knowledge`. Offline / local-only — these
 *     never contact Horus Cloud, and their handlers are synchronous.
 *   - CLOUD_TOOLS (cloud-tools.ts): the client-reported Lens work queue. Cloud-backed and
 *     async; they light up only when the CLI is logged in + the repo is cloud-linked, and
 *     degrade to `ok:false` with a remedy otherwise.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { findRepoRoot } from '@horus/core';
import { KNOWLEDGE_TOOLS } from './tools.js';
import { CLOUD_TOOLS } from './cloud-tools.js';

const SERVER_INSTRUCTIONS =
  'Horus exposes THIS project to coding agents. Before grepping or reading the whole repo to ' +
  'answer project-level questions (what owns a feature, which operation/type/enum/auth rule ' +
  'applies, which frontend pattern exists, which worker/queue handles a job), call the Horus ' +
  'knowledge tools first — they read a local index; every result carries provenance and a ' +
  'staleness flag, so if the index is stale, suggest re-running `horus init`. To act on real ' +
  'client-reported problems, call list_lens_reports for the backlog of issues users filed from ' +
  'the app, then get_lens_report for the code seed (file:line) to fix — these are cloud-backed ' +
  'and need `horus login` + `horus cloud link`.';

/** Build (but do not connect) the Horus MCP server for a repo root. Testable. */
export function buildMcpServer(root: string): McpServer {
  const server = new McpServer(
    { name: 'horus', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of KNOWLEDGE_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => {
        const res = tool.handler(args ?? {}, root);
        // HOR-386 — surface the router's deterministic next-tool suggestions to the agent.
        // Both as readable text (so a non-structured client still sees them) and as
        // `structuredContent` (so a structured client can consume the RouteStep[] shape).
        const steps = res.suggestedNextTools ?? [];
        const suggestionText =
          steps.length > 0
            ? `\n\nSuggested next tools:\n${steps
                .map((s) => `- ${s.nextTool}${s.args ? ` ${s.args}` : ''} — ${s.reason}`)
                .join('\n')}`
            : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${res.summary}\n\n${JSON.stringify(res.data ?? null, null, 2)}${suggestionText}`,
            },
          ],
          ...(steps.length > 0 ? { structuredContent: { suggestedNextTools: steps } } : {}),
          isError: !res.ok,
        };
      },
    );
  }
  // Cloud-backed Lens tools — async handlers (the SDK awaits the callback). Kept in a
  // separate loop so the local-only knowledge tools above stay synchronous.
  for (const tool of CLOUD_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        const res = await tool.handler(args ?? {}, root);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${res.summary}\n\n${JSON.stringify(res.data ?? null, null, 2)}`,
            },
          ],
          isError: !res.ok,
        };
      },
    );
  }
  return server;
}

/** Run the Horus MCP server over stdio. Resolves once connected; stdio keeps it alive. */
export async function runMcpServer(opts: { root?: string } = {}): Promise<number> {
  const root = opts.root ?? findRepoRoot(process.cwd()) ?? process.cwd();
  const server = buildMcpServer(root);
  await server.connect(new StdioServerTransport());
  return 0;
}
