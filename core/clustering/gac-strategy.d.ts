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
export declare function selectGACStrategy(memories: any[], thetaPrime: number, config?: GACConfig): GACDecision;
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
export declare function findMedoid(memories: any[], centroid: number[]): any;
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
export declare function computeMedoidWithResiduals(memories: any[], centroid: number[], rank?: number): ResidualBudget;
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
export declare function pruneDiverseCluster(memories: any[], keepRatio?: number): any[];
//# sourceMappingURL=gac-strategy.d.ts.map