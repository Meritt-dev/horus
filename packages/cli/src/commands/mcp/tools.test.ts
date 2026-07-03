import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonKnowledgeStore, KnowledgeSnapshotSchema, KNOWLEDGE_SCHEMA_VERSION } from '@horus/knowledge';
import { route } from '@horus/engine';
import { KNOWLEDGE_TOOLS, type KnowledgeTool } from './tools.js';

const NOW = '2026-06-19T15:00:00.000Z';
const prov = { sourceType: 'imported' as const, filePath: 'src/x.ts' };

function tool(name: string): KnowledgeTool {
  const t = KNOWLEDGE_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function fixture() {
  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: NOW,
    project: 'maison',
    repositories: [{ id: 'repo:api', provenance: { sourceType: 'parsed' }, key: 'api', name: 'api', role: 'backend', frameworks: ['Fastify'] }],
    operations: [
      { id: 'operation:createSale', provenance: { ...prov, filePath: 'src/sale.ts' }, name: 'createSale', kind: 'mutation', args: [{ name: 'input', type: 'CreateSaleInput', nullable: false }], returnType: 'SaleResponse' },
    ],
    types: [{ id: 'type:CreateSaleInput', provenance: prov, name: 'CreateSaleInput', kind: 'input', fields: [{ name: 'title', type: 'string' }] }],
    enums: [{ id: 'enum:SaleStatus', provenance: prov, name: 'SaleStatus', values: ['DRAFT', 'ACTIVE'] }],
    domainConcepts: [{ id: 'concept:flash-sale', provenance: { sourceType: 'inferred' }, name: 'Flash Sale', slug: 'flash-sale', relatedOperations: ['createSale'], relatedTypes: ['CreateSaleInput'] }],
    frontendPatterns: [{ id: 'fe:hook:useSale', provenance: prov, kind: 'hook', name: 'useSale', filePath: 'src/useSale.ts' }],
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function emptyRoot() {
  const d = mkdtempSync(join(tmpdir(), 'horus-mcp-empty-'));
  dirs.push(d);
  return d;
}
function indexedRoot() {
  const d = mkdtempSync(join(tmpdir(), 'horus-mcp-'));
  dirs.push(d);
  createJsonKnowledgeStore(d).write(fixture(), { generator: { tool: 'horus-cli' }, git: { sha: 'a'.repeat(40), branch: 'work' } });
  return d;
}

describe('Horus MCP knowledge tools', () => {
  it('exposes all nine expected tools with descriptions that steer agents', () => {
    const names = KNOWLEDGE_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'get_knowledge_status',
        'get_project_landscape',
        'search_project_knowledge',
        'ask_project_question',
        'get_contract',
        'get_domain_concept',
        'search_frontend_pattern',
        'get_runtime_component_map',
        'trace_data_flow',
      ]),
    );
    // Steering language present.
    expect(tool('search_project_knowledge').description).toMatch(/FIRST/);
  });

  it('every knowledge tool returns a not-ok no-index result when there is no index', () => {
    const root = emptyRoot();
    // report_issue is index-INDEPENDENT (it builds a GitHub issue URL) — an agent must be able
    // to file a gap even when nothing is indexed, so it is exempt from the no-index contract.
    for (const t of KNOWLEDGE_TOOLS.filter((t) => t.name !== 'report_issue')) {
      const res = t.handler({ query: 'x', question: 'x', name: 'x' }, root);
      expect(res.ok).toBe(false);
      expect(res.summary).toMatch(/No local project-knowledge index/);
    }
  });

  it('report_issue builds a pre-filled GitHub issue URL without an index', () => {
    const res = tool('report_issue').handler(
      { title: 'Axiom connector ignores --service', labels: 'bug,connectors', hint: 'investigate foo' },
      emptyRoot(),
    );
    expect(res.ok).toBe(true);
    const d = res.data as { url: string; title: string; labels: string[]; environment: Record<string, unknown> };
    expect(d.url).toMatch(/github\.com\/meritt-dev\/horus\/issues\/new/);
    expect(d.url).toContain('title=');
    expect(d.title).toBe('Axiom connector ignores --service');
    expect(d.labels).toEqual(['bug', 'connectors']);
    expect(d.environment.horusVersion).toBeTruthy();
  });

  it('get_knowledge_status reports schema + staleness', () => {
    const res = tool('get_knowledge_status').handler({}, indexedRoot());
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.schemaVersion).toBe(1);
    expect((d.staleness as Record<string, unknown>).indexedSha).toBe('a'.repeat(40));
  });

  it('get_project_landscape returns repository profiles', () => {
    const res = tool('get_project_landscape').handler({}, indexedRoot());
    const d = res.data as { repositories: { name: string }[] };
    expect(d.repositories[0]?.name).toBe('api');
  });

  it('search_project_knowledge finds operations with provenance + staleness', () => {
    const res = tool('search_project_knowledge').handler({ query: 'createSale' }, indexedRoot());
    const d = res.data as { matches: { category: string; provenance: unknown }[]; staleness: unknown };
    expect(d.matches.some((m) => m.category === 'operations')).toBe(true);
    expect(d.matches[0]?.provenance).toBeTruthy();
    expect(d.staleness).toBeTruthy();
  });

  it('ask_project_question returns grounded matches', () => {
    const res = tool('ask_project_question').handler({ question: 'how do sales work?' }, indexedRoot());
    const d = res.data as { grounded: boolean; matches: unknown[] };
    expect(d.grounded).toBe(true);
    expect(d.matches.length).toBeGreaterThan(0);
  });

  it('get_contract returns enums/operations verbatim', () => {
    const res = tool('get_contract').handler({ name: 'SaleStatus' }, indexedRoot());
    const d = res.data as { enums: { values: string[] }[] };
    expect(d.enums[0]?.values).toEqual(['DRAFT', 'ACTIVE']);
  });

  it('get_domain_concept finds the concept and its links', () => {
    const res = tool('get_domain_concept').handler({ name: 'flash' }, indexedRoot());
    const d = res.data as { concepts: { name: string }[] };
    expect(d.concepts[0]?.name).toBe('Flash Sale');
  });

  it('search_frontend_pattern finds the hook', () => {
    const res = tool('search_frontend_pattern').handler({ query: 'sale' }, indexedRoot());
    const d = res.data as { patterns: { name: string }[] };
    expect(d.patterns.some((p) => p.name === 'useSale')).toBe(true);
  });

  it('trace_data_flow walks concept → operations/types', () => {
    const res = tool('trace_data_flow').handler({ query: 'flash' }, indexedRoot());
    const d = res.data as { kind: string; relatedOperations: string[] };
    expect(d.kind).toBe('concept');
    expect(d.relatedOperations).toContain('createSale');
  });

  // HOR-386 — MCP self-routing surface: suggestedNextTools from the shared router.
  it('no-index results carry a suggestedNextTools route to `horus init`', () => {
    const res = tool('search_project_knowledge').handler({ query: 'x' }, emptyRoot());
    expect(res.suggestedNextTools).toEqual([
      { nextTool: 'init', args: '', reason: expect.any(String) },
    ]);
  });

  it('a 0-match knowledge search suggests broadening via search_project_knowledge', () => {
    const res = tool('search_project_knowledge').handler({ query: 'zzz-no-such-thing' }, indexedRoot());
    expect((res.data as { matches: unknown[] }).matches).toHaveLength(0);
    expect(res.suggestedNextTools).toEqual([
      { nextTool: 'search_project_knowledge', args: 'zzz-no-such-thing', reason: expect.any(String) },
    ]);
  });

  it('a 0-hit contract lookup suggests broadening across knowledge', () => {
    const res = tool('get_contract').handler({ name: 'zzz-no-such-thing' }, indexedRoot());
    expect(res.suggestedNextTools).toEqual([
      { nextTool: 'search_project_knowledge', args: 'zzz-no-such-thing', reason: expect.any(String) },
    ]);
  });

  it('a successful match carries NO suggestedNextTools (stays clean)', () => {
    const res = tool('search_project_knowledge').handler({ query: 'createSale' }, indexedRoot());
    expect(res.suggestedNextTools).toBeUndefined();
  });

  it('suggestedNextTools is byte-identical to the shared router for the same conditions', () => {
    const res = tool('ask_project_question').handler({ question: 'zzz-no-such-thing-here' }, indexedRoot());
    expect(res.suggestedNextTools).toEqual(
      route({ command: 'mcp.ask', empty: true, query: 'zzz-no-such-thing-here' }),
    );
  });
});
