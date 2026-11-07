/**
 * In-Memory Cluster Engine
 *
 * Manages memory clusters for geometry-aware consolidation.
 * Clusters are stored in-memory (not persisted) and are rebuilt
 * during consolidation runs.
 *
 * Each cluster tracks its member memory IDs and geometry stats.
 */

import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import type { ClusterGeometry, MemoryRecord } from '../lib/types.js';
import { cosineSimilarity } from '../utils/vector-operations.js';
import { computeCentroid, computeMeanCosineDistance, estimateEffectiveDimension } from './geometry.js';

/**
 * In-memory cluster representation.
 * Maps clusterId -> MemoryCluster
 */
interface MemoryCluster {
  id: string;
  embeddingModel: string | null;
  memoryIds: string[];
  memoryVectors: Map<string, number[]>;
  centroid: number[] | null;
  stats: ClusterGeometry | null;
}

// In-memory cluster store
const clusters = new Map<string, MemoryCluster>();

// Memory-to-cluster reverse lookup
const memoryToCluster = new Map<string, string>();

/**
 * Clears all clusters (used for testing and re-initialization).
 */
export function clearClusters(): void {
  clusters.clear();
  memoryToCluster.clear();
}

/**
 * Finds the nearest cluster for a memory based on cosine similarity,
 * or creates a new cluster if none is close enough.
 *
 * The similarity threshold defaults to the consolidation similarity threshold
 * from config.
 *
 * @param memoryId - Memory ID to add to a cluster
 * @param embedding - Embedding vector for the memory
 * @param threshold - Similarity threshold (default from config)
 * @returns Cluster ID
 */
export async function findOrCreateCluster(
  memoryId: string,
  embedding: number[],
  threshold?: number,
  embeddingModel?: string | null,
): Promise<string> {
  const simThreshold = threshold ?? config.consolidationSimilarityThreshold ?? 0.8;

  // Check if already in a cluster
  const existingClusterId = memoryToCluster.get(memoryId);
  if (existingClusterId && clusters.has(existingClusterId)) {
    const cluster = clusters.get(existingClusterId)!;
    const existingModel = cluster.embeddingModel;
    if (existingModel && embeddingModel && existingModel !== embeddingModel) {
      await removeFromCluster(memoryId);
    } else {
      if (!cluster.memoryIds.includes(memoryId)) {
        cluster.memoryIds.push(memoryId);
      }
      cluster.memoryVectors.set(memoryId, embedding);
      cluster.embeddingModel ??= embeddingModel ?? null;
      cluster.centroid = null;
      cluster.stats = null;
      return existingClusterId;
    }
  }

  // Find the nearest cluster by centroid similarity
  let bestClusterId: string | null = null;
  let bestSimilarity = -1;

  for (const [clusterId, cluster] of clusters.entries()) {
    // Compute centroid on-the-fly if it was invalidated
    let centroid = cluster.centroid;
    if (!centroid && cluster.memoryVectors.size > 0) {
      const vecs = Array.from(cluster.memoryVectors.values());
      centroid = computeCentroid(vecs);
    }
    if (centroid) {
      // Batch 4 mismatch policy: mixed-model centroids can't be compared;
      // skip that cluster rather than faking a similarity.
      if (centroid.length !== embedding.length) continue;
      if (cluster.embeddingModel && embeddingModel && cluster.embeddingModel !== embeddingModel) continue;
      const sim = cosineSimilarity(embedding, centroid);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterId = clusterId;
      }
    }
  }

  // If we found a close enough cluster, add to it
  if (bestClusterId && bestSimilarity >= simThreshold) {
    const cluster = clusters.get(bestClusterId)!;
    cluster.memoryIds.push(memoryId);
    cluster.memoryVectors.set(memoryId, embedding);
    cluster.embeddingModel ??= embeddingModel ?? null;
    cluster.centroid = null; // Invalidate cached centroid
    cluster.stats = null;
    memoryToCluster.set(memoryId, bestClusterId);
    return bestClusterId;
  }

  // Create a new cluster
  const newClusterId = randomUUID();
  const newCluster: MemoryCluster = {
    id: newClusterId,
    embeddingModel: embeddingModel ?? null,
    memoryIds: [memoryId],
    memoryVectors: new Map([[memoryId, embedding]]),
    centroid: embedding,
    stats: null,
  };
  clusters.set(newClusterId, newCluster);
  memoryToCluster.set(memoryId, newClusterId);

  logger.debug(`Created new cluster ${newClusterId} for memory ${memoryId}`);
  return newClusterId;
}

/**
 * Updates the geometry statistics for a cluster.
 * Computes centroid, d_bar, d_eff, and other stats from the current
 * cluster members.
 *
 * @param clusterId - ID of the cluster to update
 * @returns Updated ClusterGeometry
 */
export async function updateClusterStats(clusterId: string): Promise<ClusterGeometry> {
  const cluster = clusters.get(clusterId);
  if (!cluster) {
    throw new Error(`Cluster not found: ${clusterId}`);
  }

  const vectors = Array.from(cluster.memoryVectors.values());
  const n = vectors.length;

  if (n === 0) {
    const empty: ClusterGeometry = {
      n: 0,
      centroid: [],
      dBar: 0,
      dEff: 1,
      theta: 0,
      thetaPrime: config.consolidationGeometryThetaPrime,
    };
    cluster.stats = empty;
    return empty;
  }

  // Compute centroid
  const centroid = computeCentroid(vectors);

  // Compute d_bar (mean within-cluster cosine distance)
  const dBar = computeMeanCosineDistance(vectors, centroid);

  // Estimate effective dimension
  const dEff = estimateEffectiveDimension(vectors);

  const geometry: ClusterGeometry = {
    n,
    centroid,
    dBar,
    dEff,
    theta: dBar, // theta is the actual spread measure (same as d_bar)
    thetaPrime: config.consolidationGeometryThetaPrime,
  };

  cluster.centroid = centroid;
  cluster.stats = geometry;

  return geometry;
}

/**
 * Gets the current geometry for a cluster.
 *
 * @param clusterId - ID of the cluster
 * @returns ClusterGeometry if cluster exists, null otherwise
 */
export async function getClusterGeometry(clusterId: string): Promise<ClusterGeometry | null> {
  const cluster = clusters.get(clusterId);
  if (!cluster) return null;

  // Auto-compute if stale
  if (!cluster.stats) {
    return await updateClusterStats(clusterId);
  }

  return cluster.stats;
}

/**
 * Removes a memory from its cluster.
 * If the cluster becomes empty, it's removed.
 *
 * @param memoryId - ID of the memory to remove
 */
export async function removeFromCluster(memoryId: string): Promise<void> {
  const clusterId = memoryToCluster.get(memoryId);
  if (!clusterId) return;

  const cluster = clusters.get(clusterId);
  if (!cluster) {
    memoryToCluster.delete(memoryId);
    return;
  }

  // Remove memory from cluster
  cluster.memoryIds = cluster.memoryIds.filter(id => id !== memoryId);
  cluster.memoryVectors.delete(memoryId);
  memoryToCluster.delete(memoryId);

  // Invalidate cached stats
  cluster.centroid = null;
  cluster.stats = null;

  // Remove empty clusters
  if (cluster.memoryIds.length === 0) {
    clusters.delete(clusterId);
    logger.debug(`Removed empty cluster ${clusterId}`);
  }
}

/**
 * Gets all memories in a cluster.
 *
 * @param clusterId - ID of the cluster
 * @returns Array of memory IDs in the cluster
 */
export async function getClusterMemories(clusterId: string): Promise<string[]> {
  const cluster = clusters.get(clusterId);
  if (!cluster) return [];
  return [...cluster.memoryIds];
}

/**
 * Returns the current number of clusters.
 */
export function clusterCount(): number {
  return clusters.size;
}

/**
 * Returns the cluster ID for a given memory, or null if not assigned.
 */
export function getClusterForMemory(memoryId: string): string | null {
  return memoryToCluster.get(memoryId) ?? null;
}

/**
 * Returns all cluster IDs.
 */
export function getAllClusterIds(): string[] {
  return Array.from(clusters.keys());
}
