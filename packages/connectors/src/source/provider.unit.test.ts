/**
 * HOR-208 — SourceCodeProvider.searchSymbols must resolve an exact symbol-name match
 * (e.g. `GaiaController`) ahead of fuzzy/semantic matches (e.g. `SchedulerController`).
 *
 * Ported to the typed read path (HOR-392): the exact-name phase now calls the host's
 * /api/symbols/exact endpoint (`exactSymbols`) instead of raw Cypher, and line ranges are
 * hydrated via /api/nodes/lines (`nodesLines`). The fake client below models those shapes.
 */
import { describe, it, expect } from 'vitest';
import { SourceCodeProvider } from './provider.js';
import type { SourceHttpClient } from './client.js';

function fakeClient(): SourceHttpClient {
  return {
    // Exact-name lookup (Phase 1) → return the real declaration, with line ranges.
    async exactSymbols(name: string) {
      if (name.toLowerCase() === 'gaiacontroller') {
        return [
          {
            nodeId: 'class:src/controllers/gaia.controller.ts:GaiaController',
            name: 'GaiaController',
            filePath: 'src/controllers/gaia.controller.ts',
            label: 'class',
            startLine: 15,
            endLine: 387,
          },
        ];
      }
      return [];
    },
    // Semantic search ranks the wrong, fuzzily-related controller first (the bug).
    async search() {
      return [
        {
          nodeId: 'class:src/controllers/scheduler.controller.ts:SchedulerController',
          score: 0.92,
          name: 'SchedulerController',
          filePath: 'src/controllers/scheduler.controller.ts',
          label: 'Class',
          snippet: '',
        },
      ];
    },
    // Line-range hydration (HOR-211): batch lookup by id.
    async nodesLines(ids: string[]) {
      const out: Record<string, { filePath: string; startLine: number; endLine: number }> = {};
      if (ids.includes('class:src/controllers/gaia.controller.ts:GaiaController')) {
        out['class:src/controllers/gaia.controller.ts:GaiaController'] = {
          filePath: 'src/controllers/gaia.controller.ts',
          startLine: 15,
          endLine: 387,
        };
      }
      return out;
    },
  } as unknown as SourceHttpClient;
}

describe('SourceCodeProvider.searchSymbols — exact-name wins (HOR-208)', () => {
  it('returns the exact declaration first, not the fuzzy match', async () => {
    const provider = new SourceCodeProvider(fakeClient());
    const results = await provider.searchSymbols('GaiaController', 5);
    expect(results[0]?.name).toBe('GaiaController');
    expect(results[0]?.filePath).toBe('src/controllers/gaia.controller.ts');
    // The fuzzy SchedulerController must NOT be first.
    expect(results[0]?.name).not.toBe('SchedulerController');
  });

  it('is case-insensitive on the exact match', async () => {
    const provider = new SourceCodeProvider(fakeClient());
    const results = await provider.searchSymbols('gaiacontroller', 5);
    expect(results[0]?.name).toBe('GaiaController');
  });

  it('hydrates start/end line ranges so seeds never render as :0 (HOR-211)', async () => {
    const provider = new SourceCodeProvider(fakeClient());
    const results = await provider.searchSymbols('GaiaController', 5);
    expect(results[0]?.startLine).toBe(15);
    expect(results[0]?.endLine).toBe(387);
  });
});

describe('SourceCodeProvider.searchSymbols — carries aliasOf for redirect (HOR-465)', () => {
  it('propagates aliasOf from an exact-name stub so the resolver can redirect to the impl', async () => {
    const client = {
      // A cross-module re-export stub: `export { BaseComponent as Component } from './component'`.
      async exactSymbols(name: string) {
        if (name.toLowerCase() === 'component') {
          return [
            {
              nodeId: 'function:src/index.js:Component',
              name: 'Component',
              filePath: 'src/index.js',
              label: 'function',
              startLine: 9,
              endLine: 9,
              aliasOf: 'BaseComponent',
            },
          ];
        }
        return [];
      },
      async search() {
        return [];
      },
      async nodesLines() {
        return {};
      },
    } as unknown as SourceHttpClient;
    const provider = new SourceCodeProvider(client);
    const results = await provider.searchSymbols('Component', 5);
    expect(results[0]?.name).toBe('Component');
    expect(results[0]?.aliasOf).toBe('BaseComponent');
  });
});

describe('SourceCodeProvider.searchSymbols — public API outranks private internals (dogfood N9)', () => {
  function n9Client(): SourceHttpClient {
    return {
      async exactSymbols() {
        return []; // concept query — no exact-name hit
      },
      // Backend hybrid scores are near-flat and rank the private internals first
      // (the fastapi "router" failure: APIRouter missed the top-8 entirely).
      async search() {
        return [
          { nodeId: 'class:fastapi/routing.py:_RouterIncludeContext', score: 0.016, name: '_RouterIncludeContext', filePath: 'fastapi/routing.py', label: 'class', snippet: '' },
          { nodeId: 'function:fastapi/routing.py:_contains_router', score: 0.016, name: '_contains_router', filePath: 'fastapi/routing.py', label: 'function', snippet: '' },
          { nodeId: 'method:fastapi/routing.py:__init__', score: 0.016, name: '__init__', filePath: 'fastapi/routing.py', label: 'method', snippet: '' },
          { nodeId: 'class:fastapi/routing.py:APIRouter', score: 0.015, name: 'APIRouter', filePath: 'fastapi/routing.py', label: 'class', snippet: '' },
          { nodeId: 'method:fastapi/routing.py:matches', score: 0.015, name: 'matches', filePath: 'fastapi/routing.py', label: 'method', snippet: '' },
        ];
      },
      async nodesLines() {
        return {};
      },
    } as unknown as SourceHttpClient;
  }

  it('APIRouter (public class) leads; _private and dunder internals sink', async () => {
    const provider = new SourceCodeProvider(n9Client());
    const results = await provider.searchSymbols('router', 5);
    expect(results[0]?.name).toBe('APIRouter');
    const names = results.map((r) => r.name);
    // Private internals are still FINDABLE, just not ahead of the public API.
    expect(names.indexOf('_RouterIncludeContext')).toBeGreaterThan(names.indexOf('APIRouter'));
    expect(names.indexOf('__init__')).toBeGreaterThan(names.indexOf('matches'));
  });
});
