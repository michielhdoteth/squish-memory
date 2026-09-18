/**
 * GAC Strategy Selector
 *
 * Implements the 3-way consolidation decision from "The Geometry of Consolidation"
 * (NeurIPS 2026). Given a cluster of memory embeddings, this module selects the
 * optimal consolidation strategy based on cluster geometry:
 *
 * - **Centroid**: for tight, dense clusters (rho_C > 0.55 AND d_bar < spread_safe)
 * - **Medoid + Residuals**: for borderline clusters (spread_safe <= d_bar <= spread_unsafe)
 * - **Prune**: for diverse clusters (d_bar > spread_unsafe)
 *
 * The strategy selector computes geometric properties of the cluster (mean pairwise
 * cosine distance d_bar, effective dimension d_eff, spectral concentration rho_C)
 * and uses spread thresholds that scale with d_eff to make the decision.
 */

import {
  cosineSimilarity,
  covarianceMatrix,
  powerIteration,
  matrixTrace,
} from '../utils/vector-operations.js';
import {
  computeCentroid,
  computePairwiseMeanCosineDistance,
  participationRatio,
  computeSpectralConcentration,
  computeSpreadThresholds,
  estimateEffectiveDimension,
} from './geometry.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { logger } from '../logger.js';

/**
 * The three GAC consolidation strategies.
 */
export type GACStrategy = 'centroid' | 'medoid-residual' | 'prune';

/**
 * Result of the GAC strategy selection decision.
 */
export interface GACDecision {
  /** Selected consolidation strategy */
  strategy: GACStrategy;
  /** Mean pairwise cosine distance (cluster spread) */
  dBar: number;
  /** Effective dimension of the cluster */
  dEff: number;
  /** Spectral concentration (fraction of variance in top dimensions) */
  rhoC: number;
  /** Spread threshold for tight clusters */
  spreadSafe: number;
  /** Spread threshold for diverse clusters */
  spreadUnsafe: number;
  /** Number of representatives to keep after consolidation */
  representatives: number;
  /** Human-readable explanation of the decision */
  reason: string;
}

/**
 * Budget for the medoid+residual strategy.
 * Contains the medoid (real memory closest to centroid) and the principal
 * directions that capture the cluster's residual variance.
 */
export interface ResidualBudget {
  /** ID of the medoid memory */
  medoidId: string;
  /** Embedding of the medoid memory */
  medoidEmbedding: number[];
  /** Top-r principal directions (eigenvectors) of the cluster */
  principalDirections: number[][];
  /** Median magnitude of cluster embeddings (scaling factor) */
  scalingFactor: number;
}

/**
 * Configuration for GAC strategy selection.
 */
export interface GACConfig {
  /** Similarity threshold override (default from task-adaptive logic) */
  thetaPrime?: number;
  /** Minimum cluster size to apply GAC (default 3) */
  minClusterSize?: number;
  /** Maximum rank for residual directions (default 6) */
  maxResidualRank?: number;
  /** Fraction of members to keep when pruning (default 0.5) */
  keepRatio?: number;
  /** Task type for adaptive threshold selection */
  taskType?: 'classification' | 'clustering' | 'retrieval' | 'sts';
}

/**
 * Extracts the embedding vector from a memory object.
 * Tries `embedding` first, then `embedding_json`.
 *
 * @param mem - Memory object with embedding data
 * @returns Parsed embedding vector, or null if not available
 */
function extractEmbedding(mem: any): number[] | null {
  return parseEmbedding(mem.embedding) ?? parseEmbedding(mem.embedding_json);
}

/**
 * Main entry point for GAC strategy selection.
 *
 * Given a set of memories in a cluster, computes the geometric properties
 * and selects the optimal consolidation strategy:
 *
 * 1. Extract embeddings from all memories
 * 2. Compute d_bar (mean pairwise cosine distance), d_eff (effective dimension),
 *    rho_C (spectral concentration)
 * 3. Compute spread thresholds from d_eff
 * 4. Select strategy based on the three-way decision rule
 *
 * @param memories - Array of memory objects in the cluster
 * @param thetaPrime - Similarity threshold (or use task-adaptive default)
 * @param config - Optional configuration overrides
 * @returns GACDecision with strategy and all computed metadata
 */
export function selectGACStrategy(
  memories: any[],
  thetaPrime: number,
  config?: GACConfig
): GACDecision {
  const minClusterSize = config?.minClusterSize ?? 3;
  const maxResidualRank = config?.maxResidualRank ?? 6;
  const keepRatio = config?.keepRatio ?? 0.5;

  // Extract valid embeddings
  const vectors = memories
    .map(m => extractEmbedding(m))
    .filter((v): v is number[] => v !== null && v.length > 0);

  // Edge case: not enough data for geometric analysis
  if (vectors.length < minClusterSize) {
    logger.debug('GAC: cluster too small for geometric analysis', {
      clusterSize: vectors.length,
      minClusterSize,
    });
    return {
      strategy: 'centroid',
      dBar: 0,
      dEff: 1,
      rhoC: 1,
      spreadSafe: 0,
      spreadUnsafe: 0,
      representatives: vectors.length,
      reason: `cluster too small (${vectors.length} < ${minClusterSize}), using centroid`,
    };
  }

  // Compute geometric properties
  const centroid = computeCentroid(vectors);
  const dBar = computePairwiseMeanCosineDistance(vectors);
  const dEff = estimateEffectiveDimension(vectors);

  // Compute rho_C (spectral concentration) using robust power iteration approach:
  // rho_C = dominant_eigenvalue / total_variance (trace of covariance matrix)
  // This avoids numerical instability from full eigenvalue decomposition on small matrices.
  const cov = covarianceMatrix(vectors);
  const totalVariance = matrixTrace(cov);
  const dominantEigenvalue = powerIteration(cov);
  const rhoC = totalVariance > 0 && Number.isFinite(dominantEigenvalue)
    ? Math.min(1, Math.max(0, dominantEigenvalue / totalVariance))
    : 0;

  const { spreadSafe, spreadUnsafe } = computeSpreadThresholds(thetaPrime, dEff);

  // Compute recommended number of representatives
  const representatives = Math.max(1, Math.ceil(Math.exp(dEff * 0.5)));

  logger.debug('GAC: geometric analysis', {
    dBar: dBar.toFixed(4),
    dEff: dEff.toFixed(2),
    rhoC: rhoC.toFixed(4),
    spreadSafe: spreadSafe.toFixed(4),
    spreadUnsafe: spreadUnsafe.toFixed(4),
  });

  // Three-way decision rule
  if (dBar < spreadSafe && (rhoC > 0.55 || dBar === 0)) {
    // Tight, dense cluster: centroid strategy
    logger.debug('GAC: selecting centroid strategy', {
      dBar: dBar.toFixed(4),
      rhoC: rhoC.toFixed(4),
    });
    return {
      strategy: 'centroid',
      dBar,
      dEff,
      rhoC,
      spreadSafe,
      spreadUnsafe,
      representatives: 1,
      reason:
        `tight cluster: d_bar=${dBar.toFixed(4)} < spread_safe=${spreadSafe.toFixed(4)} ` +
        `AND rho_C=${rhoC.toFixed(4)} > 0.55, centroid is safe`,
    };
  }

  if (dBar > spreadUnsafe) {
    // Diverse cluster: pruning strategy
    const keepCount = Math.max(2, Math.ceil(vectors.length * keepRatio));
    logger.debug('GAC: selecting prune strategy', {
      dBar: dBar.toFixed(4),
      keepCount,
    });
    return {
      strategy: 'prune',
      dBar,
      dEff,
      rhoC,
      spreadSafe,
      spreadUnsafe,
      representatives: keepCount,
      reason:
        `diverse cluster: d_bar=${dBar.toFixed(4)} > spread_unsafe=${spreadUnsafe.toFixed(4)}, ` +
        `pruning to top ${keepCount} most distinct members`,
    };
  }

  // Borderline cluster: medoid + residuals strategy
  const residualRank = Math.min(maxResidualRank, Math.max(1, Math.floor(dEff)));
  logger.debug('GAC: selecting medoid-residual strategy', {
    dBar: dBar.toFixed(4),
    residualRank,
  });
  return {
    strategy: 'medoid-residual',
    dBar,
    dEff,
    rhoC,
    spreadSafe,
    spreadUnsafe,
    representatives: 1 + residualRank,
    reason:
      `borderline cluster: spread_safe=${spreadSafe.toFixed(4)} <= d_bar=${dBar.toFixed(4)} ` +
      `<= spread_unsafe=${spreadUnsafe.toFixed(4)}, using medoid + ${residualRank} residual directions`,
  };
}

/**
 * Finds the medoid of a cluster: the real memory whose embedding is closest
 * to the centroid. The medoid is always a real member of the cluster, unlike
 * the centroid which is a synthetic vector.
 *
 * @param memories - Array of memory objects in the cluster
 * @param centroid - The centroid embedding vector
 * @returns The memory object closest to the centroid
 * @throws If no memory has a valid embedding
 */
export function findMedoid(memories: any[], centroid: number[]): any {
  let bestMemory = memories[0];
  let bestSim = -1;

  for (const mem of memories) {
    const emb = extractEmbedding(mem);
    if (emb) {
      // Batch 4 mismatch policy: skip mixed-model vectors.
      if (emb.length !== centroid.length) continue;
      const sim = cosineSimilarity(emb, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestMemory = mem;
      }
    }
  }

  return bestMemory;
}

/**
 * Computes the medoid and residual budget for borderline clusters.
 *
 * The medoid+residual strategy works by:
 * 1. Finding the medoid (real memory closest to centroid)
 * 2. Computing the top-r principal directions of the cluster
 * 3. Storing these directions as "residuals" that can reconstruct
 *    the cluster's variance beyond what the centroid captures
 *
 * @param memories - Array of memory objects in the cluster
 * @param centroid - The centroid embedding vector
 * @param rank - Number of principal directions to extract (default 3)
 * @returns ResidualBudget with medoid and principal directions
 */
export function computeMedoidWithResiduals(
  memories: any[],
  centroid: number[],
  rank: number = 3
): ResidualBudget {
  // Find medoid
  const medoid = findMedoid(memories, centroid);
  const medoidEmb = extractEmbedding(medoid);

  if (!medoidEmb) {
    throw new Error('Medoid has no valid embedding');
  }

  // Extract embeddings for principal direction computation
  const vectors = memories
    .map(m => extractEmbedding(m))
    .filter((v): v is number[] => v !== null && v.length > 0);

  // Compute principal directions
  const principalDirections = extractPrincipalDirections(vectors, rank);

  // Compute median magnitude as scaling factor
  const magnitudes = vectors.map(v => {
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i] * v[i];
    }
    return Math.sqrt(sum);
  });
  magnitudes.sort((a, b) => a - b);
  const mid = Math.floor(magnitudes.length / 2);
  const scalingFactor =
    magnitudes.length % 2 === 0
      ? (magnitudes[mid - 1] + magnitudes[mid]) / 2
      : magnitudes[mid];

  return {
    medoidId: medoid.id,
    medoidEmbedding: medoidEmb,
    principalDirections,
    scalingFactor,
  };
}

/**
 * Extracts the top-r principal directions (eigenvectors) of a cluster.
 * These directions capture the main axes of variation in the cluster and
 * can be used to reconstruct cluster geometry from the medoid.
 *
 * Uses power iteration with deflation to extract eigenvectors of the
 * covariance matrix in descending eigenvalue order.
 *
 * @param vectors - Array of embedding vectors in the cluster
 * @param rank - Number of principal directions to extract
 * @returns Array of eigenvector arrays, or empty array if extraction fails
 */
function extractPrincipalDirections(vectors: number[][], rank: number): number[][] {
  if (vectors.length < 2 || rank <= 0) return [];

  const dim = vectors[0].length;
  const n = vectors.length;

  // Center the vectors
  const centroid = computeCentroid(vectors);
  const centered = vectors.map(v => v.map((val, i) => val - centroid[i]));

  // Compute covariance matrix
  const cov: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (let i = 0; i < dim; i++) {
    for (let j = i; j < dim; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += centered[k][i] * centered[k][j];
      }
      cov[i][j] = sum / (n - 1);
      if (i !== j) cov[j][i] = cov[i][j];
    }
  }

  // Extract top-r eigenvectors via power iteration with deflation
  const directions: number[][] = [];
  let workingMatrix = cov.map(row => [...row]);

  for (let iter = 0; iter < rank; iter++) {
    // Power iteration to get dominant eigenvalue
    const { eigenvalue, eigenvector } = powerIterationWithVector(workingMatrix);

    if (eigenvalue === 0 || !Number.isFinite(eigenvalue) || eigenvalue < 1e-10) break;

    // Normalize eigenvector
    const norm = Math.sqrt(eigenvector.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-10) break;
    const unitVec = eigenvector.map(x => x / norm);

    directions.push(unitVec);

    // Deflate: subtract eigenvalue * v * v^T
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        workingMatrix[r][c] -= eigenvalue * unitVec[r] * unitVec[c];
      }
    }
  }

  return directions;
}

/**
 * Power iteration that returns both eigenvalue and eigenvector.
 *
 * @param matrix - Symmetric matrix
 * @param maxIter - Maximum iterations (default 100)
 * @param tol - Convergence tolerance (default 1e-10)
 * @returns { eigenvalue, eigenvector }
 */
function powerIterationWithVector(
  matrix: number[][],
  maxIter: number = 100,
  tol: number = 1e-10
): { eigenvalue: number; eigenvector: number[] } {
  const n = matrix.length;
  // Deterministic pseudo-random start (seeded LCG): power iteration must be
  // reproducible, and Math.random() can converge to a different eigenvector
  // on near-degenerate covariance matrices, flipping strategy decisions.
  let seed = 0x2f6e2b1;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  let b = new Array(n).fill(0).map(() => nextRandom());
  let lambda = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // Multiply matrix * b
    const bNext = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        bNext[i] += matrix[i][j] * b[j];
      }
    }

    // Compute Rayleigh quotient
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += bNext[i] * b[i];
      den += b[i] * b[i];
    }
    const lambdaNew = den > 0 ? num / den : 0;

    // Normalize bNext
    const norm = Math.sqrt(bNext.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-15) return { eigenvalue: 0, eigenvector: new Array(n).fill(0) };
    b = bNext.map(x => x / norm);

    if (Math.abs(lambdaNew - lambda) < tol) {
      return { eigenvalue: lambdaNew, eigenvector: b };
    }
    lambda = lambdaNew;
  }

  return { eigenvalue: lambda, eigenvector: b };
}

/**
 * Prunes a diverse cluster by keeping only the most distinct members.
 * Distinctness is measured as inverse mean peer similarity: a memory that
 * is dissimilar to its peers is considered more distinct and more valuable
 * to preserve.
 *
 * Algorithm:
 * 1. For each memory, compute its mean cosine similarity to all other memories
 * 2. Compute distinctness score as 1 - mean_similarity (lower sim = higher distinctness)
 * 3. Keep the top keepRatio (default 0.5) most distinct memories
 * 4. Always keep at least 2 memories to avoid degenerate clusters
 *
 * @param memories - Array of memory objects in the cluster
 * @param keepRatio - Fraction of members to keep (default 0.5)
 * @returns Pruned array of memory objects
 */
export function pruneDiverseCluster(
  memories: any[],
  keepRatio: number = 0.5
): any[] {
  if (memories.length <= 2) return [...memories];

  // Compute distinctness score for each memory
  const scored = memories.map(mem => ({
    memory: mem,
    score: computeDistinctnessScore(mem, memories),
  }));

  // Sort by distinctness score (highest first = most distinct first)
  scored.sort((a, b) => b.score - a.score);

  // Keep top keepRatio (at least 2)
  const keepCount = Math.max(2, Math.ceil(memories.length * keepRatio));
  const kept = scored.slice(0, keepCount);

  logger.debug('GAC: pruning diverse cluster', {
    originalSize: memories.length,
    keptSize: kept.length,
    keepRatio,
    minDistinctness: kept.length > 0 ? kept[kept.length - 1].score.toFixed(4) : 'N/A',
  });

  return kept.map(s => s.memory);
}

/**
 * Computes the distinctness score of a memory within a cluster.
 * Distinctness is defined as 1 - mean_cosine_similarity_to_peers.
 * A memory that is very similar to all peers has low distinctness (close to 0).
 * A memory that is dissimilar to peers has high distinctness (close to 1).
 *
 * @param memory - The memory to evaluate
 * @param allMemories - All memories in the cluster (including the target)
 * @returns Distinctness score in [0, 1], where 1 = maximally distinct
 */
function computeDistinctnessScore(memory: any, allMemories: any[]): number {
  const emb = extractEmbedding(memory);
  if (!emb) return 0;

  let totalSimilarity = 0;
  let count = 0;

  for (const other of allMemories) {
    if (other.id === memory.id) continue;
    const otherEmb = extractEmbedding(other);
    if (otherEmb) {
      // Batch 4 mismatch policy: skip mixed-model pairs.
      if (otherEmb.length !== emb.length) continue;
      totalSimilarity += cosineSimilarity(emb, otherEmb);
      count++;
    }
  }

  // Lower average similarity = more distinct
  return count > 0 ? 1 - (totalSimilarity / count) : 0;
}
