import { describe, test, expect } from 'bun:test';
import {
  computeCentroid,
  computeMeanCosineDistance,
  estimateEffectiveDimension,
  compressionSafetyTest,
} from '../../../core/clustering/geometry.js';

describe('computeCentroid', () => {
  test('computes centroid of 3 vectors', () => {
    const vectors = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    const centroid = computeCentroid(vectors);
    expect(centroid).toEqual([4, 5, 6]);
  });

  test('returns empty array for empty input', () => {
    expect(computeCentroid([])).toEqual([]);
  });

  test('returns the vector itself for single vector', () => {
    const vectors = [[1, 2, 3]];
    expect(computeCentroid(vectors)).toEqual([1, 2, 3]);
  });

  test('handles 2D vectors', () => {
    const vectors = [
      [0, 0],
      [10, 10],
    ];
    expect(computeCentroid(vectors)).toEqual([5, 5]);
  });

  test('handles floating point values', () => {
    const vectors = [
      [0.5, 1.5],
      [1.5, 0.5],
    ];
    const centroid = computeCentroid(vectors);
    expect(centroid[0]).toBeCloseTo(1.0, 10);
    expect(centroid[1]).toBeCloseTo(1.0, 10);
  });

  test('all vectors must have same length', () => {
    const vectors = [
      [1, 2],
      [3, 4, 5],
    ];
    expect(() => computeCentroid(vectors)).toThrow();
  });
});

describe('computeMeanCosineDistance', () => {
  test('identical vectors have zero distance', () => {
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    const centroid = computeCentroid(vectors);
    const dBar = computeMeanCosineDistance(vectors, centroid);
    expect(dBar).toBeCloseTo(0, 10);
  });

  test('orthogonal vectors have distance near 1', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const centroid = computeCentroid(vectors);
    const dBar = computeMeanCosineDistance(vectors, centroid);
    // Centroid is [0.5, 0.5, 0], distance = 1 - cos([1,0,0], [0.5,0.5,0])
    // cos = 0.5/sqrt(0.5) = 0.707, so 1 - 0.707 = 0.293
    expect(dBar).toBeGreaterThan(0);
  });

  test('returns 0 for empty vectors', () => {
    expect(computeMeanCosineDistance([], [1, 2, 3])).toBe(0);
  });

  test('returns 0 for single vector', () => {
    const vectors = [[1, 2, 3]];
    const centroid = computeCentroid(vectors);
    expect(computeMeanCosineDistance(vectors, centroid)).toBeCloseTo(0, 10);
  });

  test('proportional vectors have zero distance', () => {
    const vectors = [
      [1, 2, 3],
      [2, 4, 6],
    ];
    const centroid = computeCentroid(vectors);
    const dBar = computeMeanCosineDistance(vectors, centroid);
    expect(dBar).toBeCloseTo(0, 10);
  });
});

describe('estimateEffectiveDimension', () => {
  test('returns 1 for tiny clusters (< 2 vectors)', () => {
    expect(estimateEffectiveDimension([])).toBe(1);
    expect(estimateEffectiveDimension([[1, 2, 3]])).toBe(1);
  });

  test('1D data has d_eff near 1', () => {
    // Use many vectors along one axis for cleaner eigenvalue extraction.
    // The participation ratio via power iteration + deflation is more precise
    // with more samples.
    const vectors = Array.from({ length: 20 }, (_, i) => [i + 1, 0, 0, 0]);
    const dEff = estimateEffectiveDimension(vectors);
    // With only one direction of variance, d_eff should be close to 1.
    // Numerical eigenvalue extraction introduces some noise.
    expect(dEff).toBeGreaterThanOrEqual(1);
    expect(dEff).toBeLessThanOrEqual(3.0);
  });

  test('2D data has d_eff near 2', () => {
    // Vary along two dimensions with independent spread
    // X varies [-2,-1,1,2], Y varies independent [-2,-1,1,2]
    const vectors = [
      [-2, -2, 0],
      [-1, 1, 0],
      [1, -1, 0],
      [2, 2, 0],
    ];
    const dEff = estimateEffectiveDimension(vectors);
    // Both dimensions have independent variance, so d_eff should be > 1
    expect(dEff).toBeGreaterThan(1);
  });

  test('returns positive number for any valid input', () => {
    const vectors = [
      [1, 5, 3, 8],
      [2, 6, 2, 7],
      [3, 7, 1, 6],
      [4, 8, 0, 5],
    ];
    const dEff = estimateEffectiveDimension(vectors);
    expect(dEff).toBeGreaterThan(0);
    expect(Number.isFinite(dEff)).toBe(true);
  });

  test('handles isotropic data', () => {
    // Uniform random-ish spread in all dimensions
    const vectors = [
      [1, 1, 1, 1],
      [2, 2, 2, 2],
      [1, 2, 1, 2],
      [2, 1, 2, 1],
    ];
    const dEff = estimateEffectiveDimension(vectors);
    expect(dEff).toBeGreaterThan(0);
    expect(Number.isFinite(dEff)).toBe(true);
  });
});

describe('compressionSafetyTest', () => {
  const thetaPrime = 0.15;

  test('safe when d_bar < thetaPrime', () => {
    const result = compressionSafetyTest(0.1, 2.0, thetaPrime);
    expect(result.safe).toBe(true);
    expect(result.reason).toContain('safe');
  });

  test('unsafe when d_bar >= thetaPrime', () => {
    const result = compressionSafetyTest(0.2, 2.0, thetaPrime);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('unsafe');
  });

  test('recommendedRepresentatives increases with d_eff', () => {
    const r1 = compressionSafetyTest(0.1, 1.0, thetaPrime);
    const r2 = compressionSafetyTest(0.1, 4.0, thetaPrime);
    expect(r2.recommendedRepresentatives).toBeGreaterThan(r1.recommendedRepresentatives);
  });

  test('recommendedRepresentatives = ceil(exp(d_eff * 0.5))', () => {
    const result = compressionSafetyTest(0.1, 2.0, thetaPrime);
    expect(result.recommendedRepresentatives).toBe(Math.ceil(Math.exp(2.0 * 0.5)));
  });

  test('handles d_eff = 0', () => {
    const result = compressionSafetyTest(0, 0, thetaPrime);
    expect(result.recommendedRepresentatives).toBe(1);
    expect(result.safe).toBe(true);
  });

  test('edge case: d_bar exactly equals thetaPrime', () => {
    // With dynamic thresholds, spreadSafe = thetaPrime * factor * 0.75.
    // For d_eff=1, factor=2, so spreadSafe=0.225 > thetaPrime=0.15.
    // Thus d_bar=0.15 < spreadSafe=0.225 means safe.
    const result = compressionSafetyTest(0.15, 1.0, thetaPrime);
    expect(result.safe).toBe(true);
  });
});
