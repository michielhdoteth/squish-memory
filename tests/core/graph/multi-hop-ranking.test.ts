import { describe, expect, test } from 'bun:test';
import { rankMultiHopResults, type MultiHopResult } from '../../../core/graph/multi-hop-retrieval.js';

describe('multi-hop result ranking', () => {
  test('retains graph relevance in canonical score fields for hybrid merging', () => {
    const graphResult: MultiHopResult = {
      id: 'bridge-memory',
      content: 'The deployment uses Aurelia System and the Marigold environment.',
      similarity: 0.7,
      semanticScore: 0.7,
      boostScore: 0,
      finalScore: 0.7,
      scoreBreakdown: {},
      retrievalPath: 'graph',
      graphPath: {
        nodes: [{ id: 'aurelia', name: 'Aurelia System' }, { id: 'marigold', name: 'Marigold environment' }],
        edges: [],
        hopCount: 1,
        totalWeight: 1,
      } as MultiHopResult['graphPath'],
    };

    const [ranked] = rankMultiHopResults([graphResult], ['Aurelia System']);

    expect(ranked.similarity).toBeGreaterThan(graphResult.similarity!);
    expect(ranked.semanticScore).toBe(graphResult.semanticScore);
    expect(ranked.boostScore).toBeGreaterThan(0);
    expect(ranked.scoreBreakdown?.multiHopWeight).toBe(ranked.boostScore);
    expect(ranked.finalScore).toBe(Math.min(1, ranked.semanticScore! + ranked.boostScore!));
  });
});
