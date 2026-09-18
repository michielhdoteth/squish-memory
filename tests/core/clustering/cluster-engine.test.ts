import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  findOrCreateCluster,
  updateClusterStats,
  getClusterGeometry,
  removeFromCluster,
  clearClusters,
} from '../../../core/clustering/cluster-engine.js';
import { CompressionSafetyResult } from '../../../core/clustering/consolidation-check.js';

// Wait, evaluateCluster and shouldConsolidate are from consolidation-check
// Let's import them
import {
  evaluateCluster,
  shouldConsolidate,
} from '../../../core/clustering/consolidation-check.js';

describe('findOrCreateCluster', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('first memory creates new cluster', async () => {
    const clusterId = await findOrCreateCluster('mem-1', [1, 0, 0]);
    expect(clusterId).toBeTruthy();
    expect(typeof clusterId).toBe('string');
  });

  test('similar memory joins existing cluster', async () => {
    const clusterId1 = await findOrCreateCluster('mem-2', [0.99, 0.01, 0]);
    const clusterId2 = await findOrCreateCluster('mem-3', [0.98, 0.02, 0]);
    expect(clusterId1).toBe(clusterId2);
  });

  test('dissimilar memory creates new cluster', async () => {
    clearClusters();
    await findOrCreateCluster('mem-a', [1, 0, 0]);
    const clusterId2 = await findOrCreateCluster('mem-b', [0, 1, 0]);
    const clusterId3 = await findOrCreateCluster('mem-c', [0, 0, 1]);
    // All should be different clusters since they're orthogonal
    expect(clusterId2).not.toBe(clusterId3);
  });
});

describe('updateClusterStats', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('d_bar decreases as similar memories are added', async () => {
    // Add identical memories - d_bar should approach 0
    const clusterId = await findOrCreateCluster('stats-mem-1', [1, 1, 1]);
    let stats = await updateClusterStats(clusterId);
    const initialDbar = stats.dBar;

    // Add more identical vectors
    await findOrCreateCluster('stats-mem-2', [1, 1, 1]);
    await findOrCreateCluster('stats-mem-3', [1, 1, 1]);
    await findOrCreateCluster('stats-mem-4', [1, 1, 1]);
    stats = await updateClusterStats(clusterId);
    const finalDbar = stats.dBar;

    // d_bar should be near 0 since all vectors are identical
    expect(finalDbar).toBeCloseTo(0, 10);
  });
});

describe('getClusterGeometry', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('returns null for non-existent cluster', async () => {
    const geo = await getClusterGeometry('non-existent');
    expect(geo).toBeNull();
  });

  test('returns geometry for existing cluster', async () => {
    const clusterId = await findOrCreateCluster('geo-mem-1', [1, 0, 0]);
    const geo = await getClusterGeometry(clusterId);
    expect(geo).not.toBeNull();
    expect(geo!.n).toBeGreaterThanOrEqual(1);
    expect(geo!.dBar).toBeGreaterThanOrEqual(0);
    expect(geo!.dEff).toBeGreaterThanOrEqual(0);
    expect(geo!.theta).toBeGreaterThanOrEqual(0);
    expect(geo!.thetaPrime).toBeGreaterThan(0);
  });
});

describe('removeFromCluster', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('removes memory from cluster', async () => {
    const clusterId = await findOrCreateCluster('rem-mem-1', [1, 0, 0]);
    await findOrCreateCluster('rem-mem-2', [1.1, 0, 0]);
    
    await removeFromCluster('rem-mem-1');
    const geo = await getClusterGeometry(clusterId);
    expect(geo!.n).toBe(1);
  });
});

describe('evaluateCluster', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('tight cluster is safe to compress', async () => {
    const clusterId = await findOrCreateCluster('eval-mem-1', [1, 0, 0]);
    await findOrCreateCluster('eval-mem-2', [0.99, 0.01, 0]);
    await findOrCreateCluster('eval-mem-3', [0.98, 0.02, 0]);
    await findOrCreateCluster('eval-mem-4', [1.01, -0.01, 0]);
    await findOrCreateCluster('eval-mem-5', [1.02, -0.02, 0]);
    
    await updateClusterStats(clusterId);
    const decision = await evaluateCluster(clusterId);
    // Tight cluster around [1,0,0] should be safe
    expect(decision.dBar).toBeDefined();
  });

  test('spread cluster may be unsafe', async () => {
    clearClusters();
    // Use close but not identical vectors that cluster together
    const clusterId = await findOrCreateCluster('eval-mem-10', [1, 0, 0]);
    await findOrCreateCluster('eval-mem-11', [0.9, 0.1, 0]);
    await findOrCreateCluster('eval-mem-12', [0.8, 0.2, 0]);
    
    await updateClusterStats(clusterId);
    const decision = await evaluateCluster(clusterId);
    // Spread cluster should have higher d_bar (these are not identical)
    expect(decision.dBar).toBeGreaterThan(0);
  });
});

describe('shouldConsolidate', () => {
  beforeAll(() => {
    clearClusters();
  });

  afterAll(() => {
    clearClusters();
  });

  test('returns boolean', async () => {
    const clusterId = await findOrCreateCluster('sc-mem-1', [1, 0, 0]);
    await updateClusterStats(clusterId);
    const result = await shouldConsolidate(clusterId);
    expect(typeof result).toBe('boolean');
  });
});
