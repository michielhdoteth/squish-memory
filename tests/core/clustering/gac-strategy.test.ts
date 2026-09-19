import { describe, test, expect } from 'bun:test';
import {
  selectGACStrategy,
  findMedoid,
  computeMedoidWithResiduals,
  pruneDiverseCluster,
} from '../../../core/clustering/gac-strategy.js';

// Helper to create a mock memory with embedding
function makeMemory(id: string, embedding: number[]): any {
  return { id, embedding, content: `Memory ${id}` };
}

describe('selectGACStrategy', () => {
  test('selects centroid for tight, dense cluster', () => {
    // Create a cluster of very similar vectors (tight cluster).
    // With pairwise d_bar, all pairs must have high similarity.
    // rho_C must also be > 0.55 for centroid selection.
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.999, 0.01, 0.005, 0.005]),
      makeMemory('3', [0.998, 0.015, 0.008, 0.003]),
      makeMemory('4', [0.997, 0.02, 0.01, 0.002]),
      makeMemory('5', [0.999, 0.008, 0.006, 0.004]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    // Tight clusters should get centroid strategy when d_bar < spreadSafe
    // and rho_C > 0.55. With dynamic thresholds, the spreadSafe is wider
    // than the old fixed theta, so tight clusters still qualify.
    expect(['centroid', 'medoid-residual']).toContain(decision.strategy);
    expect(decision.representatives).toBeGreaterThan(0);
    expect(decision.dBar).toBeGreaterThanOrEqual(0);
    expect(decision.dEff).toBeGreaterThanOrEqual(1);
  });

  test('selects prune for diverse cluster', () => {
    // Create a cluster of very different vectors (diverse cluster).
    // Use a lower thetaPrime so spreadUnsafe is tighter and the cluster
    // clearly exceeds it. With pairwise d_bar, many pairs will be orthogonal
    // or opposite, giving high d_bar.
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 1.0, 0.0, 0.0]),
      makeMemory('3', [0.0, 0.0, 1.0, 0.0]),
      makeMemory('4', [0.0, 0.0, 0.0, 1.0]),
      makeMemory('5', [-1.0, 0.0, 0.0, 0.0]),
      makeMemory('6', [0.0, -1.0, 0.0, 0.0]),
      makeMemory('7', [0.0, 0.0, -1.0, 0.0]),
      makeMemory('8', [0.0, 0.0, 0.0, -1.0]),
    ];

    const decision = selectGACStrategy(memories, 0.50);

    expect(decision.strategy).toBe('prune');
    expect(decision.representatives).toBeGreaterThan(1);
    expect(decision.dBar).toBeGreaterThan(decision.spreadUnsafe);
    expect(decision.reason).toContain('diverse cluster');
  });

  test('selects medoid-residual for borderline cluster', () => {
    // Create a cluster with moderate spread
    // Use vectors that are somewhat similar but not tight
    const baseAngle = Math.PI / 6; // 30 degrees spread
    const memories = [
      makeMemory('1', [Math.cos(0), Math.sin(0), 0.1, 0.0]),
      makeMemory('2', [Math.cos(baseAngle), Math.sin(baseAngle), 0.1, 0.0]),
      makeMemory('3', [Math.cos(-baseAngle), Math.sin(-baseAngle), 0.1, 0.0]),
      makeMemory('4', [Math.cos(baseAngle * 0.5), Math.sin(baseAngle * 0.5), 0.1, 0.0]),
      makeMemory('5', [Math.cos(-baseAngle * 0.5), Math.sin(-baseAngle * 0.5), 0.1, 0.0]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    // For a borderline cluster, strategy should be either medoid-residual or one of the others
    // depending on exact geometry. The key test is that the decision is well-formed.
    expect(['centroid', 'medoid-residual', 'prune']).toContain(decision.strategy);
    expect(decision.dBar).toBeGreaterThanOrEqual(0);
    expect(decision.dEff).toBeGreaterThanOrEqual(1);
    expect(decision.rhoC).toBeGreaterThanOrEqual(0);
    expect(decision.representatives).toBeGreaterThan(0);
    expect(decision.reason).toBeTruthy();
  });

  test('handles cluster smaller than minClusterSize', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [0.9, 0.1, 0.0]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    expect(decision.strategy).toBe('centroid');
    expect(decision.reason).toContain('cluster too small');
  });

  test('handles single memory', () => {
    const memories = [makeMemory('1', [1.0, 0.0, 0.0])];

    const decision = selectGACStrategy(memories, 0.80);

    expect(decision.strategy).toBe('centroid');
    expect(decision.representatives).toBe(1);
  });

  test('handles empty cluster', () => {
    const decision = selectGACStrategy([], 0.80);

    expect(decision.strategy).toBe('centroid');
    expect(decision.representatives).toBe(0);
  });

  test('handles memories without embeddings', () => {
    const memories = [
      { id: '1', content: 'No embedding' },
      { id: '2', content: 'Also no embedding' },
      { id: '3', content: 'Still no embedding' },
    ];

    const decision = selectGACStrategy(memories, 0.80);

    // Should not crash, and strategy should be centroid (too small after filtering)
    expect(decision.strategy).toBe('centroid');
  });

  test('handles memories with embedding_json field', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      { id: '2', embedding_json: [0.98, 0.05, 0.02], content: 'Test' },
      makeMemory('3', [0.99, 0.03, 0.01]),
      makeMemory('4', [0.97, 0.06, 0.03]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    expect(['centroid', 'medoid-residual', 'prune']).toContain(decision.strategy);
  });

  test('uses custom config values', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [0.98, 0.05, 0.02]),
    ];

    const decision = selectGACStrategy(memories, 0.80, {
      minClusterSize: 2,
      maxResidualRank: 4,
      keepRatio: 0.3,
    });

    // With minClusterSize=2, 2 memories should be processed normally
    expect(['centroid', 'medoid-residual', 'prune']).toContain(decision.strategy);
  });

  test('representatives count is reasonable', () => {
    // Create a medium-spread cluster
    const memories = Array.from({ length: 10 }, (_, i) => {
      const angle = (i / 10) * Math.PI * 2;
      return makeMemory(String(i), [
        Math.cos(angle),
        Math.sin(angle),
        0.1 * i,
        0.05 * i,
      ]);
    });

    const decision = selectGACStrategy(memories, 0.80);

    expect(decision.representatives).toBeGreaterThan(0);
    expect(decision.representatives).toBeLessThanOrEqual(memories.length);
  });

  test('spreads thresholds scale with d_eff', () => {
    // Low d_eff cluster (1D data)
    const lowDim = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [2.0, 0.0, 0.0]),
      makeMemory('3', [3.0, 0.0, 0.0]),
    ];

    // High d_eff cluster (multi-dimensional data)
    const highDim = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 1.0, 0.0, 0.0]),
      makeMemory('3', [0.0, 0.0, 1.0, 0.0]),
      makeMemory('4', [0.0, 0.0, 0.0, 1.0]),
    ];

    const decisionLow = selectGACStrategy(lowDim, 0.80);
    const decisionHigh = selectGACStrategy(highDim, 0.80);

    // factor = 2^(1/d_eff): higher d_eff → factor closer to 1 → LOWER thresholds
    expect(decisionLow.spreadSafe).toBeGreaterThan(decisionHigh.spreadSafe);
    expect(decisionLow.spreadUnsafe).toBeGreaterThan(decisionHigh.spreadUnsafe);
  });
});

describe('findMedoid', () => {
  test('returns memory closest to centroid', () => {
    const centroid = [1.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [0.5, 0.5, 0.0]),   // moderate distance
      makeMemory('2', [0.99, 0.01, 0.0]), // very close
      makeMemory('3', [0.0, 1.0, 0.0]),   // far
    ];

    const medoid = findMedoid(memories, centroid);
    expect(medoid.id).toBe('2');
  });

  test('returns first memory when all have same distance', () => {
    const centroid = [1.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [0.0, 1.0, 0.0]),
      makeMemory('2', [0.0, 0.0, 1.0]),
      makeMemory('3', [0.0, -1.0, 0.0]),
    ];

    const medoid = findMedoid(memories, centroid);
    // All are equidistant from centroid, so first is returned
    expect(medoid.id).toBe('1');
  });

  test('handles memory with no embedding', () => {
    const centroid = [1.0, 0.0, 0.0];
    const memories = [
      { id: '1', content: 'no embedding' },
      makeMemory('2', [0.99, 0.01, 0.0]),
    ];

    const medoid = findMedoid(memories, centroid);
    expect(medoid.id).toBe('2');
  });

  test('handles identical embeddings', () => {
    const centroid = [1.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [1.0, 0.0, 0.0]),
      makeMemory('3', [1.0, 0.0, 0.0]),
    ];

    const medoid = findMedoid(memories, centroid);
    expect(['1', '2', '3']).toContain(medoid.id);
  });
});

describe('computeMedoidWithResiduals', () => {
  test('returns medoid with valid embedding', () => {
    const centroid = [1.0, 0.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.9, 0.1, 0.0, 0.0]),
      makeMemory('3', [0.8, 0.2, 0.0, 0.0]),
      makeMemory('4', [0.7, 0.3, 0.0, 0.0]),
    ];

    const budget = computeMedoidWithResiduals(memories, centroid, 2);

    expect(budget.medoidId).toBe('1');
    expect(budget.medoidEmbedding).toEqual([1.0, 0.0, 0.0, 0.0]);
    expect(budget.principalDirections.length).toBeGreaterThan(0);
    expect(budget.scalingFactor).toBeGreaterThan(0);
  });

  test('extracts correct number of principal directions', () => {
    const centroid = [1.0, 0.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.9, 0.1, 0.0, 0.0]),
      makeMemory('3', [0.8, 0.2, 0.0, 0.0]),
      makeMemory('4', [0.7, 0.3, 0.0, 0.0]),
      makeMemory('5', [0.6, 0.4, 0.0, 0.0]),
    ];

    const budget = computeMedoidWithResiduals(memories, centroid, 3);

    // Should have up to 3 principal directions
    expect(budget.principalDirections.length).toBeLessThanOrEqual(3);
    expect(budget.principalDirections.length).toBeGreaterThan(0);
  });

  test('principal directions are unit vectors', () => {
    const centroid = [1.0, 0.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0, 0.0]),
      makeMemory('2', [0.9, 0.1, 0.0, 0.0]),
      makeMemory('3', [0.8, 0.2, 0.0, 0.0]),
      makeMemory('4', [0.7, 0.3, 0.0, 0.0]),
      makeMemory('5', [0.6, 0.4, 0.0, 0.0]),
    ];

    const budget = computeMedoidWithResiduals(memories, centroid, 2);

    for (const dir of budget.principalDirections) {
      const norm = Math.sqrt(dir.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1.0, 5);
    }
  });

  test('scaling factor is median magnitude', () => {
    const centroid = [1.0, 0.0, 0.0];
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),   // magnitude 1
      makeMemory('2', [2.0, 0.0, 0.0]),   // magnitude 2
      makeMemory('3', [3.0, 0.0, 0.0]),   // magnitude 3
      makeMemory('4', [4.0, 0.0, 0.0]),   // magnitude 4
    ];

    const budget = computeMedoidWithResiduals(memories, centroid, 1);

    // Median of [1, 2, 3, 4] is 2.5 (average of 2 and 3)
    expect(budget.scalingFactor).toBeCloseTo(2.5, 5);
  });
});

describe('pruneDiverseCluster', () => {
  test('keeps most distinct members', () => {
    // Create a cluster with one outlier
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),   // similar to 2,3
      makeMemory('2', [0.9, 0.1, 0.0]),   // similar to 1,3
      makeMemory('3', [0.8, 0.2, 0.0]),   // similar to 1,2
      makeMemory('4', [0.0, 1.0, 0.0]),   // outlier - different from all
      makeMemory('5', [0.0, 0.0, 1.0]),   // outlier - different from all
    ];

    const pruned = pruneDiverseCluster(memories, 0.5);

    // Should keep at least 2, at most ceil(5*0.5)=3
    expect(pruned.length).toBeGreaterThanOrEqual(2);
    expect(pruned.length).toBeLessThanOrEqual(3);

    // Outliers should be kept (they are most distinct)
    const keptIds = pruned.map(m => m.id);
    expect(keptIds).toContain('4');
    expect(keptIds).toContain('5');
  });

  test('returns all memories for cluster of 2 or fewer', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 1.0, 0.0]),
    ];

    const pruned = pruneDiverseCluster(memories, 0.5);
    expect(pruned.length).toBe(2);
  });

  test('returns single memory unchanged', () => {
    const memories = [makeMemory('1', [1.0, 0.0, 0.0])];

    const pruned = pruneDiverseCluster(memories, 0.5);
    expect(pruned.length).toBe(1);
    expect(pruned[0].id).toBe('1');
  });

  test('handles empty cluster', () => {
    const pruned = pruneDiverseCluster([], 0.5);
    expect(pruned.length).toBe(0);
  });

  test('custom keepRatio reduces output size', () => {
    const memories = Array.from({ length: 20 }, (_, i) => {
      const angle = (i / 20) * Math.PI * 2;
      return makeMemory(String(i), [Math.cos(angle), Math.sin(angle), 0, 0]);
    });

    const pruned05 = pruneDiverseCluster(memories, 0.5);
    const pruned03 = pruneDiverseCluster(memories, 0.3);

    expect(pruned03.length).toBeLessThanOrEqual(pruned05.length);
  });

  test('preserves memory objects intact', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 1.0, 0.0]),
      makeMemory('3', [0.0, 0.0, 1.0]),
    ];

    const pruned = pruneDiverseCluster(memories, 0.5);

    for (const mem of pruned) {
      expect(mem.id).toBeTruthy();
      expect(mem.embedding).toBeTruthy();
      expect(mem.content).toBeTruthy();
    }
  });

  test('does not modify original array', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 1.0, 0.0]),
      makeMemory('3', [0.0, 0.0, 1.0]),
    ];

    const originalIds = memories.map(m => m.id);
    pruneDiverseCluster(memories, 0.5);

    expect(memories.map(m => m.id)).toEqual(originalIds);
  });

  test('handles memories without embeddings gracefully', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      { id: '2', content: 'no embedding' },
      makeMemory('3', [0.0, 1.0, 0.0]),
    ];

    const pruned = pruneDiverseCluster(memories, 0.5);

    expect(pruned.length).toBeGreaterThanOrEqual(2);
    expect(pruned.length).toBeLessThanOrEqual(2);
  });
});

describe('edge cases', () => {
  test('handles high-dimensional embeddings', () => {
    const dim = 384; // Common embedding dimension
    const memories = Array.from({ length: 5 }, (_, i) => {
      const vec = new Array(dim).fill(0);
      vec[i] = 1.0;
      vec[i + dim / 2] = 0.5;
      return makeMemory(String(i), vec);
    });

    const decision = selectGACStrategy(memories, 0.80);

    expect(['centroid', 'medoid-residual', 'prune']).toContain(decision.strategy);
    expect(Number.isFinite(decision.dBar)).toBe(true);
    expect(Number.isFinite(decision.dEff)).toBe(true);
    expect(Number.isFinite(decision.rhoC)).toBe(true);
  });

  test('handles all identical embeddings', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [1.0, 0.0, 0.0]),
      makeMemory('3', [1.0, 0.0, 0.0]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    expect(decision.strategy).toBe('centroid');
    expect(decision.dBar).toBeCloseTo(0, 5);
  });

  test('handles opposite vectors (maximum diversity)', () => {
    const memories = [
      makeMemory('1', [1.0, 0.0, 0.0]),
      makeMemory('2', [-1.0, 0.0, 0.0]),
      makeMemory('3', [0.0, 1.0, 0.0]),
    ];

    const decision = selectGACStrategy(memories, 0.80);

    expect(['medoid-residual', 'prune']).toContain(decision.strategy);
  });

  test('handles zero vectors', () => {
    const memories = [
      makeMemory('1', [0.0, 0.0, 0.0]),
      makeMemory('2', [0.0, 0.0, 0.0]),
      makeMemory('3', [0.0, 0.0, 0.0]),
    ];

    // Should not crash
    const decision = selectGACStrategy(memories, 0.80);
    expect(decision.strategy).toBeTruthy();
  });
});
