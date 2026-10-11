import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildKnowledgeFromSourceGraph,
  deriveExternalIntegrations,
  type SourceGraphExtract,
} from './source-graph.js';
import { buildProjectKnowledge, deriveRepositoryProfile } from './project-landscape.js';
import { createJsonKnowledgeStore } from '../store.js';

const NOW = '2026-06-28T12:00:00.000Z';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-source-graph-'));
  dirs.push(d);
  return d;
}

/**
 * A trimmed fixture shaped exactly like what the CLI pulls back over Cypher from
 * a real analysed repo (labels/properties verified against `horus-source analyze`
 * on a Python repo: Function/Method/Class/Interface/TypeAlias/Enum nodes,
 * Community clusters, Process flows with ordered steps).
 */
const FIXTURE: SourceGraphExtract = {
  repo: 'billing-svc',
  symbols: [
    {
      label: 'Function',
      name: 'create_invoice',
      filePath: 'app/api.py',
      startLine: 10,
      endLine: 30,
      isEntryPoint: true,
    },
    {
      label: 'Function',
      name: 'list_invoices',
      filePath: 'app/api.py',
      startLine: 32,
      endLine: 40,
    },
    {
      label: 'Method',
      name: 'save',
      className: 'InvoiceRepo',
      filePath: 'app/repo.py',
      startLine: 5,
      endLine: 12,
    },
    {
      label: 'Class',
      name: 'InvoiceRepo',
      filePath: 'app/repo.py',
      startLine: 1,
      endLine: 50,
    },
    {
      label: 'Interface',
      name: 'Payable',
      filePath: 'app/types.py',
      startLine: 1,
      endLine: 8,
    },
    {
      label: 'TypeAlias',
      name: 'Money',
      filePath: 'app/types.py',
      startLine: 10,
      endLine: 10,
    },
    {
      label: 'Enum',
      name: 'InvoiceStatus',
      filePath: 'app/types.py',
      startLine: 12,
      endLine: 16,
      enumValues: ['DRAFT', 'PAID'],
    },
    // duplicate id (same kind:file:name) must be de-duped, not double-counted.
    {
      label: 'Function',
      name: 'create_invoice',
      filePath: 'app/api.py',
      startLine: 10,
      endLine: 30,
    },
    // blank name is dropped.
    { label: 'Function', name: '   ', filePath: 'app/api.py' },
  ],
  communities: [
    { id: 'community:c0', name: 'Billing' },
    { id: 'community:c1', name: 'Payments' },
  ],
  processes: [
    {
      id: 'process:p0',
      name: 'create_invoice → save',
      steps: [
        { component: 'create_invoice', detail: 'app/api.py' },
        { component: 'save', detail: 'app/repo.py' },
      ],
    },
  ],
};

describe('buildKnowledgeFromSourceGraph', () => {
  it('round-trips exact code relationships and recorded confidence in the optional snapshot metadata', () => {
    const root = tmp();
    const snapshot = buildProjectKnowledge([{ name: 'svc', path: root }], {
      now: NOW,
      sourceGraph: {
        symbols: [
          {
            id: 'method:a:run',
            label: 'Method',
            className: 'Controller',
            name: 'run',
            filePath: 'a.ts',
          },
          { id: 'function:b:run', label: 'Function', name: 'run', filePath: 'b.ts' },
        ],
        relationships: {
          edges: [
            {
              source: 'method:a:run',
              target: 'function:b:run',
              rel: 'calls',
              confidence: null,
            },
          ],
          truncated: false,
        },
      },
    });
    const store = createJsonKnowledgeStore(root);
    store.write(snapshot);
    expect(store.readSnapshot()?.sourceRelationships).toEqual({
      edges: [
        {
          id: expect.stringMatching(/^source:[a-f0-9]{64}$/),
          from: 'operation:a.ts:Controller.run',
          to: 'operation:b.ts:run',
          rel: 'calls',
          confidence: null,
        },
      ],
      truncated: false,
    });
  });

  it('omits ambiguous and missing symbols instead of matching by names or inventing paths', () => {
    const result = buildKnowledgeFromSourceGraph({
      symbols: [
        { id: 'overload-1', label: 'Function', name: 'run', filePath: 'a.ts' },
        { id: 'overload-2', label: 'Function', name: 'run', filePath: 'a.ts' },
        { id: 'unique', label: 'Function', name: 'run', filePath: 'b.ts' },
      ],
      relationships: {
        edges: [
          { source: 'overload-1', target: 'unique', rel: 'calls', confidence: 0.5 },
          { source: 'missing', target: 'unique', rel: 'calls', confidence: 1 },
        ],
        truncated: false,
      },
    });
    expect(result.sourceRelationships).toEqual({ edges: [], truncated: true });
    expect(buildKnowledgeFromSourceGraph(FIXTURE).sourceRelationships).toBeUndefined();
  });

  it('maps an analyse-output extract into populated KB categories', () => {
    const k = buildKnowledgeFromSourceGraph(FIXTURE, {
      project: 'billing',
      gitSha: 'abc',
      now: NOW,
    });

    // operations: 2 functions + 1 method (the duplicate create_invoice de-duped).
    expect(k.operations.map((o) => o.name).sort()).toEqual([
      'InvoiceRepo.save',
      'create_invoice',
      'list_invoices',
    ]);
    for (const op of k.operations) {
      expect(op.protocol).toBe('function');
      expect(op.provenance.sourceType).toBe('parsed');
      expect(op.provenance.repo).toBe('billing-svc');
      expect(op.scope).toEqual({ project: 'billing', repository: 'billing-svc' });
    }

    // types: class + interface + type alias, with honest kinds.
    expect(k.types.map((t) => `${t.name}:${t.kind}`).sort()).toEqual([
      'InvoiceRepo:object',
      'Money:alias',
      'Payable:interface',
    ]);
    const klass = k.types.find((t) => t.name === 'InvoiceRepo');
    expect(klass?.provenance.lineRange).toEqual([1, 50]);
    expect(klass?.sourceFile).toBe('app/repo.py');

    // enums carry their parsed values.
    expect(k.enums).toHaveLength(1);
    expect(k.enums[0]?.values).toEqual(['DRAFT', 'PAID']);

    // communities → domain concepts (inferred), processes → data flows.
    expect(k.domainConcepts.map((d) => d.name).sort()).toEqual(['Billing', 'Payments']);
    expect(k.domainConcepts[0]?.provenance.sourceType).toBe('inferred');
    expect(k.dataFlows).toHaveLength(1);
    expect(k.dataFlows[0]?.steps.map((s) => s.component)).toEqual([
      'create_invoice',
      'save',
    ]);

    // runtime components: only the entry-point function.
    expect(k.runtimeComponents.map((r) => r.name)).toEqual(['create_invoice']);
    expect(k.runtimeComponents[0]?.entrypoints).toEqual(['app/api.py']);

    // EVERY symbol-derived category is non-empty — the bug was all-zero.
    expect(k.operations.length).toBeGreaterThan(0);
    expect(k.types.length).toBeGreaterThan(0);
    expect(k.enums.length).toBeGreaterThan(0);
    expect(k.domainConcepts.length).toBeGreaterThan(0);
    expect(k.dataFlows.length).toBeGreaterThan(0);
    expect(k.runtimeComponents.length).toBeGreaterThan(0);
  });

  it('honours the per-category cap', () => {
    const many: SourceGraphExtract = {
      repo: 'r',
      symbols: Array.from({ length: 10 }, (_, i) => ({
        label: 'Function',
        name: `fn_${i}`,
        filePath: 'a.py',
      })),
    };
    const k = buildKnowledgeFromSourceGraph(many, { maxPerCategory: 3 });
    expect(k.operations).toHaveLength(3);
  });

  it('returns all-empty categories for an empty extract', () => {
    const k = buildKnowledgeFromSourceGraph({});
    expect(k.operations).toEqual([]);
    expect(k.types).toEqual([]);
    expect(k.enums).toEqual([]);
    expect(k.domainConcepts).toEqual([]);
    expect(k.dataFlows).toEqual([]);
    expect(k.runtimeComponents).toEqual([]);
  });
});

describe('deriveExternalIntegrations', () => {
  it('lifts data sources + integrations from repo profiles into external integrations', () => {
    const path = tmp();
    writeFileSync(
      join(path, 'pyproject.toml'),
      '[project]\nname = "svc"\ndependencies = ["fastapi", "asyncpg", "stripe"]\n',
    );
    const profile = deriveRepositoryProfile(
      { name: 'svc', path },
      { project: 'p', now: NOW },
    );
    const integrations = deriveExternalIntegrations([profile]);
    const names = integrations.map((i) => i.name).sort();
    expect(names).toContain('PostgreSQL');
    expect(names).toContain('Stripe');
    for (const i of integrations) {
      expect(i.usedBy).toContain('svc');
      expect(i.provenance.sourceType).toBe('parsed');
    }
  });
});

describe('buildProjectKnowledge with a source graph → non-empty KB + manifest', () => {
  it('produces a non-empty manifest the store persists (the HOR-408 regression)', () => {
    const repoPath = tmp();
    writeFileSync(
      join(repoPath, 'pyproject.toml'),
      '[project]\nname = "billing-svc"\ndependencies = ["fastapi", "asyncpg"]\n',
    );
    const root = tmp();

    const snapshot = buildProjectKnowledge([{ name: 'billing-svc', path: repoPath }], {
      project: 'billing',
      gitSha: 'abc',
      now: NOW,
      sourceGraph: FIXTURE,
    });

    const manifest = createJsonKnowledgeStore(root).write(snapshot, {
      generator: { tool: 'horus-cli' },
      repositories: [{ name: 'billing-svc', path: repoPath, headSha: 'abc' }],
    });

    // The exact regression: manifest category counts must NOT all be zero.
    expect(manifest.counts.operations).toBeGreaterThan(0);
    expect(manifest.counts.types).toBeGreaterThan(0);
    expect(manifest.counts.domainConcepts).toBeGreaterThan(0);
    expect(manifest.counts.dataFlows).toBeGreaterThan(0);
    expect(manifest.counts.enums).toBeGreaterThan(0);
    expect(manifest.counts.externalIntegrations).toBeGreaterThan(0);
    expect(manifest.counts.repositories).toBe(1);

    // Round-trips through the store.
    const read = createJsonKnowledgeStore(root).readSnapshot();
    expect(read?.operations.length).toBe(snapshot.operations.length);
    expect(read?.types.length).toBe(snapshot.types.length);
  });

  it('without a source graph, only manifest-derived categories populate (no crash)', () => {
    const repoPath = tmp();
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ name: 'web', dependencies: { stripe: '14' } }),
    );
    const snapshot = buildProjectKnowledge([{ name: 'web', path: repoPath }], {
      now: NOW,
    });
    expect(snapshot.operations).toEqual([]);
    expect(snapshot.types).toEqual([]);
    // External integrations still derive from the manifest.
    expect(snapshot.externalIntegrations.map((i) => i.name)).toContain('Stripe');
  });
});
