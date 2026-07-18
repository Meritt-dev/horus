import { describe, it, expect } from 'vitest';
import type { SourceTraceResult } from '@horus/connectors';
import { renderTrace } from './trace.js';

describe('renderTrace', () => {
  it('renders a mixed-direction, multi-relation chain with confidence tags', () => {
    const result: SourceTraceResult = {
      found: true,
      hops: 2,
      path: [
        { id: 'function:src/a.ts:funcA', label: 'function', name: 'funcA', filePath: 'src/a.ts', startLine: 10 },
        { id: 'function:src/b.ts:funcB', label: 'function', name: 'funcB', filePath: 'src/b.ts', startLine: 5 },
        { id: 'class:src/c.ts:ClassC', label: 'class', name: 'ClassC', filePath: 'src/c.ts', startLine: 1 },
      ],
      segments: [
        { relType: 'calls', confidence: 0.6, direction: 'out' },
        { relType: 'uses_type', confidence: 1.0, direction: 'in' },
      ],
      notes: [],
    };
    const out = renderTrace(result);
    expect(out).toContain('Trace: funcA --calls (~)--> funcB <--uses_type-- ClassC (2 hops)');
    expect(out).toContain('1. funcA (Function) — src/a.ts:10');
    expect(out).toContain('3. ClassC (Class) — src/c.ts:1');
  });

  it('renders a single-hop path with the correct pluralization', () => {
    const result: SourceTraceResult = {
      found: true,
      hops: 1,
      path: [
        { id: 'a', label: 'function', name: 'a', filePath: 'src/a.ts', startLine: 1 },
        { id: 'b', label: 'function', name: 'b', filePath: 'src/b.ts', startLine: 2 },
      ],
      segments: [{ relType: 'calls', confidence: 1.0, direction: 'out' }],
      notes: [],
    };
    expect(renderTrace(result)).toContain('(1 hop)');
  });

  it('surfaces the error message when no path is found', () => {
    const out = renderTrace({ found: false, error: 'No relationship path found from a to b within 10 hops.' });
    expect(out).toContain('No relationship path found');
  });

  it('includes ambiguity notes', () => {
    const out = renderTrace({
      found: false,
      error: "Source symbol 'pay' not found.",
      notes: ["note: source 'pay' was ambiguous — matched payA; runner-up payB."],
    });
    expect(out).toContain('ambiguous');
  });
});
