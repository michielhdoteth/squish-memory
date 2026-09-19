import { describe, test, expect } from 'bun:test';
import {
  computeMeanCosineDistance,
  computePairwiseMeanCosineDistance,
  participationRatio,
  computeSpectralConcentration,
  computeSpreadThresholds,
  computeSpectralBound,
  estimateEffectiveDimension,
  compressionSafetyTest,
  computeCentroid,
} from '../core/clustering/geometry.js';

// ─── computePairwiseMeanCosineDistance ────────────────────────────────────────

describe('computePairwiseMeanCosineDistance', () => {
  test('identical vectors have zero pairwise distance', () => {
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    const dBar = computePairwiseMeanCosineDistance(vectors);
    expect(dBar).toBeCloseTo(0, 10);
  });

  test('orthogonal vectors have pairwise distance 1', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const dBar = computePairwiseMeanCosineDistance(vectors);
    // cosine similarity = 0, distance = 1 - 0 = 1
    expect(dBar).toBeCloseTo(1, 10);
  });

  test('returns 0 for empty vectors', () => {
    expect(computePairwiseMeanCosineDistance([])).toBe(0);
  });

  test('returns 0 for single vector (no pairs)', () => {
    expect(computePairwiseMeanCosineDistance([[1, 2, 3]])).toBe(0);
  });

  test('proportional vectors have zero distance', () => {
    const vectors = [
      [1, 2, 3],
      [2, 4, 6],
    ];
    const dBar = computePairwiseMeanCosineDistance(vectors);
    expect(dBar).toBeCloseTo(0, 10);
  });

  test('two opposite vectors have distance 2', () => {
    const vectors = [
      [1, 0, 0],
      [-1, 0, 0],
    ];
    const dBar = computePairwiseMeanCosineDistance(vectors);
    // cosine similarity = -1, distance = 1 - (-1) = 2
    expect(dBar).toBeCloseTo(2, 10);
  });

  test('three mutually orthogonal vectors: mean distance', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const dBar = computePairwiseMeanCosineDistance(vectors);
    // All pairs have cosine similarity 0, distance 1. Mean = 1.
    expect(dBar).toBeCloseTo(1, 10);
  });

  test('handles unit vectors at 60 degrees', () => {
    // cos(60) = 0.5, distance = 0.5
    const v1 = [1, 0, 0];
    const v2 = [0.5, Math.sqrt(3) / 2, 0];
    const dBar = computePairwiseMeanCosineDistance([v1, v2]);
    expect(dBar).toBeCloseTo(0.5, 5);
  });
});

// ─── participationRatio ───────────────────────────────────────────────────────

describe('participationRatio', () => {
  test('uniform eigenvalues: d_eff = N', () => {
    // If all eigenvalues are equal, participation ratio = N
    const eigenvalues = [1, 1, 1, 1];
    expect(participationRatio(eigenvalues)).toBeCloseTo(4, 10);
  });

  test('single dominant eigenvalue: d_eff near 1', () => {
    const eigenvalues = [10, 0.01, 0.01, 0.01];
    const dEff = participationRatio(eigenvalues);
    expect(dEff).toBeCloseTo(1, 1);
  });

  test('returns 1 for empty array', () => {
    expect(participationRatio([])).toBe(1);
  });

  test('returns 1 for single eigenvalue', () => {
    expect(participationRatio([5])).toBeCloseTo(1, 10);
  });

  test('handles zero eigenvalues', () => {
    const eigenvalues = [3, 0, 0, 0];
    expect(participationRatio(eigenvalues)).toBeCloseTo(1, 10);
  });

  test('handles negative eigenvalues (clamped to 0)', () => {
    const eigenvalues = [2, -1, 3];
    // Clamped: [2, 0, 3], sum=5, sumSq=13, ratio = 25/13 = 1.923
    const dEff = participationRatio(eigenvalues);
    expect(dEff).toBeCloseTo(25 / 13, 10);
  });

  test('two equal eigenvalues: d_eff = 2', () => {
    const eigenvalues = [5, 5];
    expect(participationRatio(eigenvalues)).toBeCloseTo(2, 10);
  });
});

// ─── computeSpectralConcentration ─────────────────────────────────────────────

describe('computeSpectralConcentration', () => {
  test('all variance in top eigenvalue: rho = 1', () => {
    const eigenvalues = [10, 0, 0, 0];
    expect(computeSpectralConcentration(eigenvalues)).toBeCloseTo(1, 10);
  });

  test('uniform eigenvalues: rho = 1/N', () => {
    const eigenvalues = [5, 5, 5, 5];
    expect(computeSpectralConcentration(eigenvalues)).toBeCloseTo(0.25, 10);
  });

  test('returns 0 for empty array', () => {
    expect(computeSpectralConcentration([])).toBe(0);
  });

  test('returns 0 when all eigenvalues are zero', () => {
    expect(computeSpectralConcentration([0, 0, 0])).toBe(0);
  });

  test('single eigenvalue: rho = 1', () => {
    expect(computeSpectralConcentration([7])).toBeCloseTo(1, 10);
  });
});

// ─── computeSpreadThresholds ──────────────────────────────────────────────────

describe('computeSpreadThresholds', () => {
  test('thresholds scale inversely with d_eff', () => {
    const lowDEff = computeSpreadThresholds(0.15, 1);
    const highDEff = computeSpreadThresholds(0.15, 10);
    // factor = 2^(1/d_eff): lower d_eff → higher factor → higher thresholds
    // Higher d_eff means factor is closer to 1, so thresholds are closer to theta_prime
    expect(lowDEff.spreadSafe).toBeGreaterThan(highDEff.spreadSafe);
    expect(lowDEff.spreadUnsafe).toBeGreaterThan(highDEff.spreadUnsafe);
  });

  test('spreadSafe < spreadUnsafe', () => {
    const result = computeSpreadThresholds(0.15, 2);
    expect(result.spreadSafe).toBeLessThan(result.spreadUnsafe);
  });

  test('for d_eff = 1: factor = 2^(1/1) = 2', () => {
    const result = computeSpreadThresholds(0.15, 1);
    // factor = 2^(1/1) = 2
    // spreadSafe = 0.15 * 2 * 0.75 = 0.225
    // spreadUnsafe = 0.15 * 2 * 1.25 = 0.375
    expect(result.spreadSafe).toBeCloseTo(0.225, 10);
    expect(result.spreadUnsafe).toBeCloseTo(0.375, 10);
  });

  test('for d_eff = 2: factor = 2^(1/2) = sqrt(2)', () => {
    const result = computeSpreadThresholds(0.15, 2);
    const factor = Math.sqrt(2);
    expect(result.spreadSafe).toBeCloseTo(0.15 * factor * 0.75, 10);
    expect(result.spreadUnsafe).toBeCloseTo(0.15 * factor * 1.25, 10);
  });

  test('clamps d_eff to minimum of 1', () => {
    const result = computeSpreadThresholds(0.15, 0.5);
    // d_eff clamped to 1, same as d_eff=1
    const baseline = computeSpreadThresholds(0.15, 1);
    expect(result.spreadSafe).toBeCloseTo(baseline.spreadSafe, 10);
    expect(result.spreadUnsafe).toBeCloseTo(baseline.spreadUnsafe, 10);
  });
});

// ─── computeSpectralBound ─────────────────────────────────────────────────────

describe('computeSpectralBound', () => {
  test('returns 0 when d_bar < theta_prime (safe)', () => {
    // When the cluster fits inside the cap, no interference error
    const epsilon = computeSpectralBound(0.1, 0.15, 2);
    expect(epsilon).toBe(0);
  });

  test('returns 0 when d_bar === theta_prime', () => {
    const epsilon = computeSpectralBound(0.15, 0.15, 2);
    expect(epsilon).toBe(0);
  });

  test('returns positive when d_bar > theta_prime', () => {
    const epsilon = computeSpectralBound(0.3, 0.15, 2);
    expect(epsilon).toBeGreaterThan(0);
    expect(epsilon).toBeLessThanOrEqual(1);
  });

  test('returns 0 when d_bar is 0', () => {
    expect(computeSpectralBound(0, 0.15, 2)).toBe(0);
  });

  test('error increases with larger d_bar relative to theta_prime', () => {
    const e1 = computeSpectralBound(0.25, 0.15, 2);
    const e2 = computeSpectralBound(0.40, 0.15, 2);
    expect(e2).toBeGreaterThan(e1);
  });

  test('error increases with higher d_eff when theta < d_bar', () => {
    // When theta/d_bar < 1, (theta/d_bar)^(d_eff/2) shrinks as d_eff grows,
    // so 1 - c1 * (shrinking term) increases. Higher d_eff means the angular
    // cap covers proportionally less of the sphere, so interference error grows.
    const eLow = computeSpectralBound(0.3, 0.15, 2);
    const eHigh = computeSpectralBound(0.3, 0.15, 10);
    expect(eHigh).toBeGreaterThan(eLow);
  });

  test('error shrinks toward 0 as d_bar approaches theta', () => {
    // When d_bar is close to theta, the bound should be small
    const eClose = computeSpectralBound(0.16, 0.15, 10);
    const eFar = computeSpectralBound(0.3, 0.15, 10);
    expect(eClose).toBeLessThan(eFar);
  });

  test('c1 parameter scales the bound', () => {
    const e1 = computeSpectralBound(0.3, 0.15, 2, 1.0);
    const e2 = computeSpectralBound(0.3, 0.15, 2, 0.5);
    // Lower c1 means larger error (less correction)
    expect(e2).toBeGreaterThan(e1);
  });
});

// ─── Updated computeMeanCosineDistance (now pairwise) ─────────────────────────

describe('computeMeanCosineDistance (pairwise)', () => {
  test('identical vectors have zero distance', () => {
    const vectors = [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    const dBar = computeMeanCosineDistance(vectors, computeCentroid(vectors));
    expect(dBar).toBeCloseTo(0, 10);
  });

  test('orthogonal vectors: distance = 1', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const centroid = computeCentroid(vectors);
    const dBar = computeMeanCosineDistance(vectors, centroid);
    expect(dBar).toBeCloseTo(1, 10);
  });

  test('returns 0 for empty vectors', () => {
    expect(computeMeanCosineDistance([], [1, 2, 3])).toBe(0);
  });

  test('returns 0 for single vector', () => {
    expect(computeMeanCosineDistance([[1, 2, 3]], [1, 2, 3])).toBe(0);
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

  test('matches computePairwiseMeanCosineDistance', () => {
    const vectors = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    const centroid = computeCentroid(vectors);
    const dBarOld = computeMeanCosineDistance(vectors, centroid);
    const dBarNew = computePairwiseMeanCosineDistance(vectors);
    expect(dBarOld).toBeCloseTo(dBarNew, 10);
  });
});

// ─── estimateEffectiveDimension (updated to participation ratio) ──────────────

describe('estimateEffectiveDimension (participation ratio)', () => {
  test('returns 1 for tiny clusters (< 2 vectors)', () => {
    expect(estimateEffectiveDimension([])).toBe(1);
    expect(estimateEffectiveDimension([[1, 2, 3]])).toBe(1);
  });

  test('1D data has d_eff near 1', () => {
    // Use many vectors along one axis for cleaner eigenvalue extraction
    const vectors = Array.from({ length: 20 }, (_, i) => [i + 1, 0, 0, 0]);
    const dEff = estimateEffectiveDimension(vectors);
    // Participation ratio should be close to 1 for essentially 1D data.
    // Numerical eigenvalue extraction via power iteration + deflation introduces
    // some noise, so we use a generous tolerance.
    expect(dEff).toBeGreaterThanOrEqual(1);
    expect(dEff).toBeLessThanOrEqual(2.5);
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

  test('d_eff >= 1 always', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    expect(estimateEffectiveDimension(vectors)).toBeGreaterThanOrEqual(1);
  });
});

// ─── compressionSafetyTest (updated with dynamic thresholds) ──────────────────

describe('compressionSafetyTest (dynamic thresholds)', () => {
  const thetaPrime = 0.15;

  test('safe when d_bar < spreadSafe', () => {
    // With d_eff=2, spreadSafe = 0.15 * sqrt(2) * 0.75 ~ 0.159
    // d_bar=0.1 < 0.159 => safe
    const result = compressionSafetyTest(0.1, 2.0, thetaPrime);
    expect(result.safe).toBe(true);
  });

  test('unsafe when d_bar > spreadUnsafe', () => {
    const result = compressionSafetyTest(0.5, 2.0, thetaPrime);
    expect(result.safe).toBe(false);
  });

  test('recommendedRepresentatives increases with d_eff', () => {
    const r1 = compressionSafetyTest(0.1, 1.0, thetaPrime);
    const r2 = compressionSafetyTest(0.1, 4.0, thetaPrime);
    expect(r2.recommendedRepresentatives).toBeGreaterThan(r1.recommendedRepresentatives);
  });

  test('handles d_eff = 0', () => {
    const result = compressionSafetyTest(0, 0, thetaPrime);
    expect(result.recommendedRepresentatives).toBe(1);
    expect(result.safe).toBe(true);
  });

  test('returns safe/unsafe and reason', () => {
    const safeResult = compressionSafetyTest(0.05, 2.0, thetaPrime);
    expect(safeResult.safe).toBe(true);
    expect(safeResult.reason).toContain('safe');

    const unsafeResult = compressionSafetyTest(0.5, 2.0, thetaPrime);
    expect(unsafeResult.safe).toBe(false);
    expect(unsafeResult.reason).toContain('unsafe');
  });
});
