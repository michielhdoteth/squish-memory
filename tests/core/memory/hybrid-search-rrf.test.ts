import { describe, expect, test } from 'bun:test';

import { rrfFusion, rrfFusionMulti } from '../../../core/memory/keyword-search.js';

describe('RRF fusion', () => {
  test('combines vector and keyword rankings with stronger shared hits', () => {
    const vector = [
      { id: 'a', content: 'alpha', similarity: 0.9 },
      { id: 'b', content: 'beta', similarity: 0.8 },
      { id: 'c', content: 'gamma', similarity: 0.7 },
    ] as any;

    const keyword = [
      { id: 'c', content: 'gamma', similarity: 1 },
      { id: 'a', content: 'alpha', similarity: 0.8 },
    ] as any;

    const fused = rrfFusion(vector, keyword, 3);
    expect(fused.length).toBe(3);
    expect(fused[0].id).toBe('a');
    expect(fused.map((x: any) => x.id)).toContain('c');
  });

  test('breaks exact fused-score ties by binary content order regardless of leg order', () => {
    const alpha = { id: 'id-alpha', content: 'alpha', similarity: 1 } as any;
    const zeta = { id: 'id-zeta', content: 'zeta', similarity: 1 } as any;
    const first = rrfFusionMulti([[zeta, alpha], [alpha, zeta]], 2);
    const reversed = rrfFusionMulti([[alpha, zeta], [zeta, alpha]], 2);
    expect(first.map((row: any) => row.content)).toEqual(['alpha', 'zeta']);
    expect(reversed.map((row: any) => row.content)).toEqual(['alpha', 'zeta']);
  });

  test('diagnostic pre-fusion semantic score is preserved without changing serving order or scores', () => {
    const baselineVector = [
      { id: 'a', content: 'alpha', similarity: 0.9, semanticScore: 0.9, recallConfidence: 0.84 },
      { id: 'b', content: 'beta', similarity: 0.8, semanticScore: 0.8, recallConfidence: 0.61 },
    ] as any;
    const diagnosticVector = baselineVector.map((result: any) => ({
      ...result,
      preFusionSemanticScore: result.semanticScore,
    }));
    const keyword = [{ id: 'b', content: 'beta', similarity: 1 } as any];

    const baseline = rrfFusionMulti([baselineVector, keyword], 2);
    const diagnostic = rrfFusionMulti([diagnosticVector, keyword], 2);

    expect(diagnostic.map((row: any) => row.id)).toEqual(baseline.map((row: any) => row.id));
    expect(diagnostic.map((row: any) => [row.semanticScore, row.finalScore, row.recallConfidence]))
      .toEqual(baseline.map((row: any) => [row.semanticScore, row.finalScore, row.recallConfidence]));
    expect(diagnostic.find((row: any) => row.id === 'a')?.preFusionSemanticScore).toBe(0.9);
  });
});
