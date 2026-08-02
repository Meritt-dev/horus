import { describe, it, expect } from 'vitest';
import type { SourceInsightsResult } from '@horus/connectors';
import { renderInsights } from './insights.js';

describe('renderInsights', () => {
  const full: SourceInsightsResult = {
    hubs: [
      { id: 'function:src/b.py:funcB', name: 'funcB', label: 'function', filePath: 'src/b.py', startLine: 1, degree: 2 },
    ],
    bridges: [
      {
        source: 'funcB',
        target: 'funcC',
        relType: 'calls',
        sourceCommunity: 'Comm1',
        targetCommunity: 'Comm2',
        sourceId: 'function:src/b.py:funcB',
        targetId: 'function:src/c.py:funcC',
      },
    ],
    questions: ['What is the blast radius of funcB?'],
  };

  it('renders hubs, bridges and questions', () => {
    const out = renderInsights(full);
    expect(out).toContain('Hubs');
    expect(out).toContain('funcB');
    expect(out).toContain('(Function) — src/b.py:1');
    expect(out).toContain('Surprising connections');
    expect(out).toContain('funcB --calls--> funcC');
    expect(out).toContain('[Comm1 → Comm2]');
    expect(out).toContain('Suggested questions');
    expect(out).toContain('blast radius of funcB');
  });

  it('shows empty-state lines when the graph has no hubs or bridges', () => {
    const out = renderInsights({ hubs: [], bridges: [], questions: [] });
    expect(out).toContain('none (empty or unindexed graph)');
    expect(out).toContain('none detected');
  });
});
