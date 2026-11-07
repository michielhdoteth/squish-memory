/**
 * Batch 3: three-field score semantics.
 *
 * Covers:
 * - semanticScore invariant under boost changes (boosted vs unboosted config)
 * - finalScore identity + clamping, v2 vs legacy serving
 * - honest dedup threshold predicate (semanticScore, never composite)
 * - threshold-decision shadow ring (recalibration data)
 * - SCORING_SCHEMA_VERSION flag matrix (SQUISH_SCORING_V2 / SQUISH_SCORING_SHADOW)
 * - shadow-mode ordering delta ring buffer
 */
import { describe, it, expect } from 'bun:test';
import {
  SCORING_SCHEMA_VERSION,
  getScoringFlags,
  initScoreFields,
  addBoost,
  applyReplacement,
  finalizeScores,
  servedSimilarity,
  clamp01,
  meetsSemanticThreshold,
  getThresholdDecisions,
  clearThresholdDecisions,
  deriveShadowDelta,
  recordShadowDelta,
  getShadowDeltas,
  clearShadowDeltas,
} from '../../../core/scoring/three-field.js';
import {
  applyTagOverlapBoost,
  applySessionBoost,
  applyTemporalBoost,
  applyGraphBoostWithWeight,
  scoreWithHeuristics,
} from '../../../core/memory/search-scoring.js';
import type { SearchResult } from '../../../core/memory/memories.js';
import type { RetrievalScoringConfig } from '../../../core/retrieval/config.js';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'm1',
    content: 'deploy the API to production on tuesday',
    type: 'note',
    similarity: 0.9,
    metadata: {},
    tags: [],
    ...overrides,
  } as SearchResult;
}

const DEFAULT_SCORING: RetrievalScoringConfig = {
  placeBoost: 0.15,
  tagOverlapBoost: 0.10,
  graphNeighborBoost: 0.05,
  recencyBoost: 0.03,
  usageBoost: 0.02,
  supersededPenalty: 0.50,
  contradictionRiskPenalty: 0.20,
};

describe('SCORING_SCHEMA_VERSION', () => {
  it('is 2 for this batch', () => {
    expect(SCORING_SCHEMA_VERSION).toBe('2');
  });
});

describe('getScoringFlags flag matrix', () => {
  const baseEnv = { ...process.env };

  it('defaults to v2 serving with shadow off when both flags are unset', () => {
    const flags = getScoringFlags({
      SQUISH_SCORING_V2: undefined as any,
      SQUISH_SCORING_SHADOW: undefined as any,
    } as NodeJS.ProcessEnv);
    expect(flags.serveV2).toBe(true);
    expect(flags.shadow).toBe(false);
  });

  it("SQUISH_SCORING_V2='true' serves v2", () => {
    const flags = getScoringFlags({ SQUISH_SCORING_V2: 'true' } as NodeJS.ProcessEnv);
    expect(flags.serveV2).toBe(true);
  });

  it("SQUISH_SCORING_V2='false' serves legacy (+ optional shadow)", () => {
    const legacyNoShadow = getScoringFlags({ SQUISH_SCORING_V2: 'false' } as NodeJS.ProcessEnv);
    expect(legacyNoShadow.serveV2).toBe(false);
    expect(legacyNoShadow.shadow).toBe(false);

    const legacyWithShadow = getScoringFlags({
      SQUISH_SCORING_V2: 'false',
      SQUISH_SCORING_SHADOW: 'true',
    } as NodeJS.ProcessEnv);
    expect(legacyWithShadow.serveV2).toBe(false);
    expect(legacyWithShadow.shadow).toBe(true);
  });

  it('shadow is independent of serving mode', () => {
    const flags = getScoringFlags({
      SQUISH_SCORING_V2: 'true',
      SQUISH_SCORING_SHADOW: 'true',
    } as NodeJS.ProcessEnv);
    expect(flags.serveV2).toBe(true);
    expect(flags.shadow).toBe(true);
  });

  it('treats junk values as defaults', () => {
    const flags = getScoringFlags({
      SQUISH_SCORING_V2: 'banana',
      SQUISH_SCORING_SHADOW: 'banana',
    } as unknown as NodeJS.ProcessEnv);
    expect(flags.serveV2).toBe(true);   // default ON (batch-3 flip)
    expect(flags.shadow).toBe(false);   // default OFF
  });
});

describe('semanticScore invariant under boost changes', () => {
  it('identical semanticScore for boosted vs unboosted configs (same query)', () => {
    const r1 = initScoreFields([makeResult()])[0];
    const r2 = initScoreFields([makeResult()])[0];

    // Unboosted: leave alone.
    // Boosted: pile on every additive boost the pipeline uses.
    let boosted = addBoost(r2, 'tagOverlap', 0.30);
    boosted = addBoost(boosted, 'session', 0.10);
    boosted = addBoost(boosted, 'temporal', 0.25);
    boosted = addBoost(boosted, 'graph', 0.08);

    expect(r1.semanticScore).toBe(0.9);
    expect(boosted.semanticScore).toBe(0.9);
    expect(r1.semanticScore).toBe(boosted.semanticScore);
    // Composite moved, honest relevance did not.
    expect(boosted.similarity!).toBeCloseTo(0.9 + 0.73, 6);
  });

  it('itemizes each boost component in scoreBreakdown', () => {
    let r = initScoreFields([makeResult()])[0];
    r = addBoost(r, 'place', 0.15);
    r = addBoost(r, 'tagOverlap', 0.10);
    r = addBoost(r, 'entity', 0.05);
    expect(r.scoreBreakdown?.place).toBe(0.15);
    expect(r.scoreBreakdown?.tagOverlap).toBe(0.10);
    expect(r.scoreBreakdown?.entity).toBe(0.05);
    expect(r.boostScore).toBeCloseTo(0.30, 6);
  });

  it('heuristic scoring leaves semanticScore intact and matches its components', () => {
    const now = Date.now();
    const r = initScoreFields([
      makeResult({ createdAt: new Date(now).toISOString(), id: 'h1' }),
    ])[0];
    const before = r.semanticScore;
    const composite = scoreWithHeuristics(r, 'deploy api production', now);
    expect(composite).toBeGreaterThanOrEqual(before!);
    expect(r.semanticScore).toBe(before);
  });
});

describe('pipeline boost helpers preserve three fields', () => {
  it('applyTagOverlapBoost adds itemized tagOverlap', async () => {
    const results = initScoreFields([
      makeResult({ id: 'a' }),
      makeResult({ id: 'b' }),
    ]);
    const out = await applyTagOverlapBoost(results, ['deploy'], { ...DEFAULT_SCORING }, { dbClient: null as any, db: null as any } as any);
    for (const r of out) {
      expect(typeof r.semanticScore).toBe('number');
      if (r.boostScore && r.boostScore > 0) {
        expect(r.scoreBreakdown?.tagOverlap).toBe(r.boostScore);
      }
    }
  });

  it('applySessionBoost / applyTemporalBoost / graph boost keep semanticScore frozen', () => {
    let rs = initScoreFields([makeResult({ metadata: {} })]);
    const semanticBefore = rs[0].semanticScore;

    rs = applySessionBoost(rs, 'nope');
    expect(rs[0].semanticScore).toBe(semanticBefore);

    rs = applyTemporalBoost(rs);
    expect(rs[0].semanticScore).toBe(semanticBefore);

    rs = applyGraphBoostWithWeight(rs, { [rs[0].id]: 1 }, 10, 0.2);
    expect(rs[0].semanticScore).toBe(semanticBefore);
    expect(rs[0].scoreBreakdown?.graph).toBeGreaterThan(0);
  });
});

describe('finalScore identity and serving modes', () => {
  it('finalScore == clamp01(semanticScore + boostScore) always', () => {
    let r = initScoreFields([makeResult({ similarity: 0.95 })])[0];
    r = addBoost(r, 'temporal', 0.25);
    r = addBoost(r, 'place', 0.15);
    expect(r.finalScore).toBe(clamp01(0.95 + 0.40));
    expect(r.finalScore).toBe(1); // clamped
  });

  it('v2 serving clamps and re-sorts by finalScore; legacy preserves raw composite scores', () => {
    const a = initScoreFields([{ ...makeResult({ id: 'a' }), similarity: 0.99 }])[0]; // semantic .99, no boosts
    const bRaw = initScoreFields([{ ...makeResult({ id: 'b' }), similarity: 0.80 }])[0];
    const b = addBoost(addBoost(bRaw, 'temporal', 0.25), 'place', 0.15); // composite 1.20

    // Legacy: preserves pipeline (composite) order, serves unclamped score.
    // The pipeline pre-sorts by the running composite before finalizing.
    const legacy = finalizeScores([b, a], false);
    expect(legacy[0].id).toBe('b');
    expect(servedSimilarity(legacy[0], false)).toBeCloseTo(1.20, 6);
    expect(legacy[0].similarity).toBeCloseTo(1.20, 6);
    expect(legacy[1].similarity).toBeCloseTo(0.99, 6);

    // v2: b clamps to 1.0; a (0.99 semantic, no boosts) stays below it.
    // Re-sort by finalScore puts b first; served score is finalScore.
    const v2 = finalizeScores([a, b], true);
    expect(v2[0].id).toBe('b');
    expect(v2[0].similarity).toBe(1);
    expect(v2[0].finalScore).toBe(1);
    expect(v2[1].id).toBe('a');
    expect(v2[1].similarity).toBeCloseTo(0.99, 6);
  });

  it('preserves unclamped composite order when distinct scores both clamp to one', () => {
    const lexicallyFirst = initScoreFields([{
      ...makeResult({ id: 'a', content: 'alpha' }), similarity: 0.80,
    }])[0];
    const lexicallyLast = initScoreFields([{
      ...makeResult({ id: 'z', content: 'zeta' }), similarity: 0.90,
    }])[0];
    const lowerComposite = addBoost(lexicallyFirst, 'temporal', 0.30);
    const higherComposite = addBoost(lexicallyLast, 'temporal', 0.30);

    const served = finalizeScores([lowerComposite, higherComposite], true);
    expect(served.map((row) => row.content)).toEqual(['zeta', 'alpha']);
    expect(served.map((row) => row.finalScore)).toEqual([1, 1]);
  });

  it('replacement (reranker) keeps the three-field identity via rerankResidual', () => {
    const r = initScoreFields([makeResult({ similarity: 0.90 })])[0];
    const replaced = applyReplacement(r, 0.42);
    expect(replaced.semanticScore).toBe(0.90);
    expect(replaced.similarity).toBe(0.42);
    expect(replaced.boostScore).toBeCloseTo(-0.48, 6);
    expect(replaced.scoreBreakdown?.rerankResidual).toBeCloseTo(-0.48, 6);
    expect(replaced.finalScore).toBe(0.42);
  });
});

describe('honest dedup threshold gates read semanticScore', () => {
  it('meetsSemanticThreshold ignores inflated composites', () => {
    // Boost-inflated result: composite 0.98 would pass a 0.85 gate, honest
    // cosine 0.60 must not.
    let r = initScoreFields([makeResult({ similarity: 0.60 })])[0];
    r = addBoost(r, 'tagOverlap', 0.30);
    r = addBoost(r, 'session', 0.08);
    expect(r.similarity).toBeGreaterThanOrEqual(0.85); // composite passes
    expect(meetsSemanticThreshold(r, 0.85)).toBe(false); // honest gate rejects
  });

  it('accepts genuinely similar results', () => {
    const r = initScoreFields([makeResult({ similarity: 0.92 })])[0];
    expect(meetsSemanticThreshold(r, 0.85)).toBe(true);
  });

  it('falls back to similarity when semanticScore is absent (legacy fixtures)', () => {
    expect(meetsSemanticThreshold({ similarity: 0.87 }, 0.85)).toBe(true);
    expect(meetsSemanticThreshold({ similarity: 0.50 }, 0.85)).toBe(false);
  });
});

describe('shadow-mode ordering delta ring', () => {
  it('derives top-5 lists with overlap count', () => {
    const results = Array.from({ length: 7 }, (_, i) => {
      const base = initScoreFields([
        makeResult({ id: `id-${i}`, similarity: 0.5 - i * 0.05 }),
      ])[0];
      // Give id-0..1 huge boosts so legacy order diverges from v2 order.
      return i < 2 ? addBoost(base, 'place', 0.45) : base;
    });

    const delta = deriveShadowDelta('test query', results);
    expect(delta.query).toBe('test query');
    expect(delta.schemaVersion).toBe(SCORING_SCHEMA_VERSION);
    expect(delta.legacyTop5.length).toBe(5);
    expect(delta.v2Top5.length).toBe(5);
    // Legacy top: boosted items first; v2: clamped ties reorder toward originals.
    expect(delta.legacyTop5.slice(0, 2)).toEqual(['id-0', 'id-1']);
    expect(delta.overlap).toBeGreaterThanOrEqual(3);
    expect(delta.overlap).toBeLessThanOrEqual(5);
  });

  it('ring is bounded at 100 entries (newest kept)', () => {
    clearShadowDeltas();
    for (let i = 0; i < 130; i++) {
      recordShadowDelta({
        query: `q${i}`,
        schemaVersion: SCORING_SCHEMA_VERSION,
        legacyTop5: [],
        v2Top5: [],
        overlap: 0,
        recordedAt: new Date().toISOString(),
      });
    }
    const ring = getShadowDeltas();
    expect(ring.length).toBe(100);
    expect((ring[ring.length - 1] as any).query).toBe('q129');
    expect((ring[0] as any).query).toBe('q30');
    clearShadowDeltas();
    expect(getShadowDeltas().length).toBe(0);
  });
});

describe('threshold-decision shadow ring (recalibration data, no behavior change)', () => {
  it('records near-threshold decisions (0.8-0.95 band) with outcome', () => {
    clearThresholdDecisions();
    // Inside the band on both sides of a 0.85 gate.
    meetsSemanticThreshold({ similarity: 0.84 }, 0.85); // near-miss
    meetsSemanticThreshold({ similarity: 0.91 }, 0.85); // near-hit
    const ring = getThresholdDecisions();
    expect(ring.length).toBe(2);
    expect(ring[0]).toMatchObject({ honestScore: 0.84, threshold: 0.85, passed: false });
    expect(ring[1]).toMatchObject({ honestScore: 0.91, threshold: 0.85, passed: true });
    expect(typeof ring[0].recordedAt).toBe('string');
    clearThresholdDecisions();
  });

  it('does not record clear-cut decisions outside the observation band', () => {
    clearThresholdDecisions();
    meetsSemanticThreshold({ similarity: 0.99 }, 0.85); // clear hit
    meetsSemanticThreshold({ similarity: 0.30 }, 0.85); // clear miss
    expect(getThresholdDecisions().length).toBe(0);
  });

  it('logging never changes the boolean outcome', () => {
    clearThresholdDecisions();
    for (const score of [0.80, 0.8499, 0.85, 0.901, 0.95]) {
      expect(meetsSemanticThreshold({ similarity: score }, 0.85)).toBe(score >= 0.85);
      expect(meetsSemanticThreshold({ similarity: score }, 0.92)).toBe(score >= 0.92);
    }
    clearThresholdDecisions();
  });

  it('non-finite honest scores are never recorded', () => {
    clearThresholdDecisions();
    expect(meetsSemanticThreshold({ similarity: NaN }, 0.85)).toBe(false);
    expect(getThresholdDecisions().length).toBe(0);
  });

  it('ring is bounded at 100 entries (newest kept)', () => {
    clearThresholdDecisions();
    for (let i = 0; i < 130; i++) {
      meetsSemanticThreshold({ similarity: 0.82 + (i % 10) * 0.01 }, 0.85);
    }
    const ring = getThresholdDecisions();
    expect(ring.length).toBe(100);
    expect(ring[ring.length - 1].honestScore).toBeCloseTo(0.82 + (129 % 10) * 0.01, 10);
    clearThresholdDecisions();
    expect(getThresholdDecisions().length).toBe(0);
  });
});
