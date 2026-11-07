/**
 * WS1a-T1.3: Serving-weight tests for the final score composition.
 *
 * `config.scoringWeights` documented importance/recency/relevance but NOTHING
 * consumed them on the serving path: the final ranking was
 * `clamp01(semanticScore + boostScore)` with importance contributing zero,
 * despite README's "importance-weighted retrieval" claim. These tests pin the
 * corrected composition:
 *
 * - importance weight > 0 measurably reorders results versus weight 0
 * - neutral weights (importance 0, relevance NEUTRAL) reproduce the prior
 *   ranking exactly (identity fast path - no default recall shift)
 * - the three-field identity survives: weights fold into boostScore as
 *   itemized components and never overwrite the honest semanticScore
 * - importance scale handling: legacy 0-100 -> /100, 0..1 passthrough,
 *   missing/zero -> no boost
 *
 * applyRetrievalServingWeights only rewrites scores (same array order); the
 * pipeline sorts in finalizeScores, so order assertions sort by finalScore.
 */

import { describe, expect, test } from 'bun:test';

import {
  applyRetrievalServingWeights,
  NEUTRAL_RELEVANCE_WEIGHT,
  NEUTRAL_RECENCY_WEIGHT,
  addBoost,
  finalizeScores,
  initScoreFields,
} from '../../../core/scoring/three-field.js';
import config from '../../../config.js';

type Row = {
  id: string;
  content?: string;
  similarity: number;
  semanticScore?: number;
  boostScore?: number;
  finalScore?: number;
  scoreBreakdown?: Record<string, number>;
  importanceScore?: number;
};

/** A: better semantic match, LOW importance. B: weaker match, HIGH importance. */
function rows(): Row[] {
  return initScoreFields([
    { id: 'a', similarity: 0.70, importanceScore: 5 } as Row,
    { id: 'b', similarity: 0.62, importanceScore: 95 } as Row,
  ] as Row[]) as Row[];
}

function orderServed(results: Row[]): string[] {
  // Same sort the v2 serving path uses (finalizeScores sorts by finalScore).
  return finalizeScores(results as any, true).map((r) => r.id);
}

describe('applyRetrievalServingWeights', () => {
  test('neutral weights are identity: default ranking is preserved', () => {
    const after = applyRetrievalServingWeights(rows(), {
      importance: 0,
      relevance: NEUTRAL_RELEVANCE_WEIGHT,
    });

    // Byte-for-byte same served order AND same scores as the unweighted path.
    expect(orderServed(after)).toEqual(['a', 'b']);
    expect(after[0].finalScore).toBeCloseTo(0.70, 10);
    expect(after[1].finalScore).toBeCloseTo(0.62, 10);
    expect(after[0].scoreBreakdown ?? {}).toEqual({});
    expect(after[1].scoreBreakdown ?? {}).toEqual({});
  });

  test('importance weight > 0 reorders results versus weight 0', () => {
    const off = applyRetrievalServingWeights(rows(), { importance: 0, relevance: NEUTRAL_RELEVANCE_WEIGHT });
    expect(orderServed(off)).toEqual(['a', 'b']); // prior ranking

    const on = applyRetrievalServingWeights(rows(), { importance: 0.15, relevance: NEUTRAL_RELEVANCE_WEIGHT });

    // b (95/100) gets +0.1425 -> 0.7625; a (5/100) gets +0.0075 -> 0.7075. b wins.
    expect(orderServed(on)).toEqual(['b', 'a']);

    // Itemized + identity preserved: finalScore == clamp01(semantic + boost).
    const b = on.find((r) => r.id === 'b')!;
    expect(b.scoreBreakdown!.importanceWeight).toBeCloseTo(0.15 * 0.95, 10);
    expect(b.finalScore).toBeCloseTo(0.62 + 0.15 * 0.95, 10);
    expect(b.semanticScore).toBe(0.62); // honest field NEVER overwritten
  });

  test('relevance weight rescales the semantic term (itemized, keeps semanticScore honest)', () => {
    // Below neutral: compresses semantic toward the boosts.
    const compressed = applyRetrievalServingWeights(rows(), { importance: 0, relevance: 0 });
    const ca = compressed.find((r) => r.id === 'a')!;
    expect(ca.scoreBreakdown!.relevanceWeight).toBeCloseTo(0.70 * (0 / NEUTRAL_RELEVANCE_WEIGHT - 1), 10);
    expect(ca.finalScore).toBeCloseTo(Math.max(0, 0.70 + 0.70 * (0 / NEUTRAL_RELEVANCE_WEIGHT - 1)), 10);

    // Above neutral: lifts semantic. relevance=6 -> delta = (6/3 - 1) * semantic = +semantic.
    const lifted = applyRetrievalServingWeights(rows(), { importance: 0, relevance: 6 });
    const a = lifted.find((r) => r.id === 'a')!;
    expect(a.scoreBreakdown!.relevanceWeight).toBeCloseTo(0.70, 10);
    expect(a.semanticScore).toBe(0.70); // untouched
    expect(a.finalScore).toBeCloseTo(1, 10); // clamp01(0.70 + 0.70)
  });

  test('recency weight modulates the existing heuristicRecency boost (neutral = identity)', () => {
    // Two results sharing the same semantic score; only one carries a prior
    // recency boost (set via addBoost, itemized in scoreBreakdown).
    const withRecency = initScoreFields([
      { id: 'old', similarity: 0.5 } as Row,
      { id: 'new', similarity: 0.5 } as Row,
    ] as Row[]);
    withRecency[1] = addBoost(withRecency[1], 'heuristicRecency', 0.08);

    // Neutral default 0.5 -> identity: recency ranking unchanged, no item.
    const neutral = applyRetrievalServingWeights(
      withRecency.map((r) => ({ ...r })),
      { importance: 0, relevance: NEUTRAL_RELEVANCE_WEIGHT, recency: NEUTRAL_RECENCY_WEIGHT },
    );
    expect(neutral[1].scoreBreakdown!.recencyWeight).toBeUndefined();
    expect(neutral[1].finalScore).toBeCloseTo(0.58, 10);

    // Doubled weight (1.0) -> recency contribution scales 2x via the delta.
    const doubled = applyRetrievalServingWeights(
      withRecency.map((r) => ({ ...r })),
      { importance: 0, relevance: NEUTRAL_RELEVANCE_WEIGHT, recency: 1.0 },
    );
    expect(doubled[1].scoreBreakdown!.recencyWeight).toBeCloseTo(0.08, 10);
    expect(doubled[1].finalScore).toBeCloseTo(0.66, 10);
    expect(doubled[1].semanticScore).toBe(0.5); // honest field untouched

    // Zero weight -> the recency nudge is fully cancelled out.
    const muted = applyRetrievalServingWeights(
      withRecency.map((r) => ({ ...r })),
      { importance: 0, relevance: NEUTRAL_RELEVANCE_WEIGHT, recency: 0 },
    );
    expect(muted[1].finalScore).toBeCloseTo(0.5, 10);
  });

  test('importance scale handling: 0-100 legacy, 0..1 normalized, missing -> no boost', () => {
    const out = applyRetrievalServingWeights(
      [
        { id: 'legacy', similarity: 0.5, importanceScore: 80 } as Row,
        { id: 'norm', similarity: 0.5, importanceScore: 0.8 } as Row,
        { id: 'missing', similarity: 0.5 } as Row,
        { id: 'zero', similarity: 0.5, importanceScore: 0 } as Row,
      ],
      { importance: 0.1, relevance: NEUTRAL_RELEVANCE_WEIGHT },
    );
    expect(out.find((r) => r.id === 'legacy')!.scoreBreakdown!.importanceWeight).toBeCloseTo(0.08, 10);
    expect(out.find((r) => r.id === 'norm')!.scoreBreakdown!.importanceWeight).toBeCloseTo(0.08, 10);
    // missing / zero importance: no boost applied, no component itemized.
    expect(out.find((r) => r.id === 'missing')!.scoreBreakdown?.importanceWeight).toBeUndefined();
    expect(out.find((r) => r.id === 'missing')!.finalScore).toBeUndefined();
    expect(out.find((r) => r.id === 'zero')!.scoreBreakdown?.importanceWeight).toBeUndefined();
  });
});

describe('config.scoringWeights defaults are live on the serving path', () => {
  test('shipped defaults sit at the neutral element (no default recall shift)', () => {
    // WS1a-T1.3: importance now genuinely consumed on serving. Its config
    // default was 2 while the field was dead; wired into an additive term, a
    // default of 2 would reshape every ranking (surprise recall shift), so the
    // shipped default is normalized to the NEUTRAL element 0 (off). It IS
    // applied when an operator sets it > 0 (see reorder test above).
    expect(config.scoringWeights.importance).toBe(0);
    expect(config.scoringWeights.relevance).toBe(NEUTRAL_RELEVANCE_WEIGHT);
    expect(config.scoringWeights.recency).toBe(NEUTRAL_RECENCY_WEIGHT);
  });

  test('env overrides change the live values (weights are read, not decorative)', () => {
    const prev = process.env.SQUISH_WEIGHT_IMPORTANCE;
    process.env.SQUISH_WEIGHT_IMPORTANCE = '0.25';
    try {
      expect(config.scoringWeights.importance).toBe(0.25);
    } finally {
      if (prev === undefined) delete process.env.SQUISH_WEIGHT_IMPORTANCE;
      else process.env.SQUISH_WEIGHT_IMPORTANCE = prev;
    }
  });
});
