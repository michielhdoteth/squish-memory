/**
 * Geometry Utilities for Memory Consolidation (GAC Layer 1)
 *
 * Implements the Geometry-Aware Consolidation (GAC) system based on:
 * - "The Geometry of Consolidation" (NeurIPS 2026)
 * - Embedding dimensionality estimation papers
 *
 * Core principle: Before consolidating a cluster, measure whether it's
 * geometrically safe. Compute mean pairwise cosine distance (d_bar) and
 * local effective dimension (d_eff) via participation ratio. Use dynamic
 * spread thresholds that adapt to the cluster's intrinsic dimensionality.
 *
 * Key formulas:
 *   d_bar = 1 - mean(cosine_similarity(v_i, v_j)) for all i < j
 *   d_eff = (sum lambda_i)^2 / sum lambda_i^2  (participation ratio)
 *   spread_safe = theta_prime * 2^(1/d_eff) * 0.75
 *   spread_unsafe = theta_prime * 2^(1/d_eff) * 1.25
 *   epsilon_id >= 1 - c1 * (theta_prime / d_bar)^(d_eff/2)
 */
/**
 * Computes the centroid (mean embedding vector) of a set of vectors.
 *
 * @param vectors - Array of embedding vectors
 * @returns Mean vector (centroid)
 * @throws If vectors have inconsistent dimensions
 */
export declare function computeCentroid(vectors: number[][]): number[];
/**
 * Computes the mean pairwise cosine distance between ALL pairs of vectors.
 *
 * This is the correct GAC formula (NeurIPS 2026):
 *   d_bar = 1 - mean(cosine_similarity(v_i, v_j)) for all i < j
 *
 * Unlike the centroid-based approach, this measures the true spread of the
 * cluster by considering every pair of vectors, not just distances to centroid.
 *
 * The centroid parameter is kept for backward compatibility but is ignored;
 * the pairwise computation is inherently centroid-free.
 *
 * @param vectors - Array of embedding vectors in the cluster
 * @param _centroid - Kept for backward compatibility (ignored)
 * @returns Mean pairwise cosine distance (d_bar), 0 for empty/single-vector clusters
 */
export declare function computeMeanCosineDistance(vectors: number[][], _centroid?: number[]): number;
/**
 * Computes the mean pairwise cosine distance between ALL pairs of vectors.
 *
 * Formula: d_bar = 1 - mean(cosine_similarity(v_i, v_j)) for all i < j
 *
 * For N vectors, this computes N*(N-1)/2 pairwise cosine similarities,
 * takes their mean, and returns 1 - mean.
 *
 * Edge cases:
 *   - 0 vectors: returns 0 (no pairs)
 *   - 1 vector: returns 0 (no pairs)
 *   - Identical vectors: returns 0 (all similarities = 1)
 *   - Orthogonal vectors: returns 1 (all similarities = 0)
 *
 * @param vectors - Array of embedding vectors
 * @returns Mean pairwise cosine distance in range [0, 2]
 */
export declare function computePairwiseMeanCosineDistance(vectors: number[][]): number;
/**
 * Computes the participation ratio of eigenvalues.
 *
 * Formula: d_eff = (sum lambda_i)^2 / sum lambda_i^2
 *
 * The participation ratio measures how many eigenvalues effectively
 * contribute to the total variance. It is a more principled measure
 * of effective dimensionality than the trace/max eigenvalue ratio.
 *
 * Properties:
 *   - d_eff = 1 when all variance is in one direction (1D data)
 *   - d_eff = N when all N eigenvalues are equal (isotropic N-D data)
 *   - Always >= 1 and <= N (number of eigenvalues)
 *
 * @param eigenvalues - Array of eigenvalues (non-negative)
 * @returns Effective dimension (participation ratio) >= 1
 */
export declare function participationRatio(eigenvalues: number[]): number;
/**
 * Computes the spectral concentration ratio (top eigenvalue fraction).
 *
 * Formula: rho_C = lambda_1 / sum(lambda_j)
 *
 * This measures how concentrated the variance is in the top principal
 * component. High concentration (> 0.5) indicates the cluster is
 * effectively low-dimensional; low concentration indicates isotropic spread.
 *
 * @param eigenvalues - Array of eigenvalues (non-negative, not necessarily sorted)
 * @returns Spectral concentration ratio in [0, 1]
 */
export declare function computeSpectralConcentration(eigenvalues: number[]): number;
/**
 * Computes dynamic spread thresholds that adapt to the cluster's
 * intrinsic dimensionality.
 *
 * Formulas:
 *   factor = 2^(1/d_eff)
 *   spread_safe   = theta_prime * factor * 0.75
 *   spread_unsafe = theta_prime * factor * 1.25
 *
 * The idea: in higher-dimensional spaces, the same angular distance
 * corresponds to a larger "volume" of the cap. The factor 2^(1/d_eff)
 * adjusts the threshold so that the safety region scales appropriately
 * with the cluster's effective dimension.
 *
 * @param thetaPrime - Base safety threshold (default 0.15)
 * @param dEff - Effective dimension of the cluster
 * @returns Object with spreadSafe and spreadUnsafe thresholds
 */
export declare function computeSpreadThresholds(thetaPrime: number, dEff: number): {
    spreadSafe: number;
    spreadUnsafe: number;
};
/**
 * Computes the spectral bound on consolidation-interference error.
 *
 * Formula: epsilon_id >= 1 - c1 * (theta_prime / d_bar)^(d_eff/2)
 *
 * When d_bar < theta_prime, the entire cluster fits inside the angular
 * cap and the interference error is 0 (safe consolidation).
 *
 * When d_bar >= theta_prime, the bound gives a lower bound on the
 * minimum possible interference error from consolidation.
 *
 * @param dBar - Mean pairwise cosine distance of the cluster
 * @param thetaPrime - Angular cap radius threshold
 * @param dEff - Effective dimension
 * @param c1 - Normalization constant (default 1.0)
 * @returns Spectral bound epsilon_id >= 0, or 0 if safe
 */
export declare function computeSpectralBound(dBar: number, thetaPrime: number, dEff: number, c1?: number): number;
/**
 * Estimates the local effective dimension of a cluster via the
 * participation ratio of eigenvalues.
 *
 * Uses the participation ratio: d_eff = (sum lambda_i)^2 / sum lambda_i^2
 * This is a more principled measure than the old trace/max eigenvalue ratio.
 *
 * Steps:
 * 1. Compute covariance matrix
 * 2. Extract eigenvalues (via power iteration with deflation)
 * 3. Compute participation ratio
 *
 * Falls back to 1 for tiny clusters (< 2 vectors).
 *
 * @param vectors - Array of embedding vectors in the cluster
 * @returns Estimated effective dimension (>= 1)
 */
export declare function estimateEffectiveDimension(vectors: number[][]): number;
/**
 * Performs a compression safety test on a cluster.
 *
 * Uses dynamic spread thresholds that adapt to the cluster's effective
 * dimensionality:
 *   spread_safe = theta_prime * 2^(1/d_eff) * 0.75
 *   spread_unsafe = theta_prime * 2^(1/d_eff) * 1.25
 *
 * If d_bar < spread_safe: consolidation is safe (cluster is tight).
 * If d_bar >= spread_unsafe: cluster is too diverse for safe consolidation.
 *
 * Recommended representatives = ceil(exp(d_eff * 0.5))
 * This scales the number of representatives with the effective dimension.
 *
 * @param dBar - Mean pairwise cosine distance
 * @param dEff - Estimated effective dimension
 * @param thetaPrime - Safety threshold (default 0.15)
 * @returns { safe, recommendedRepresentatives, reason }
 */
export declare function compressionSafetyTest(dBar: number, dEff: number, thetaPrime: number): {
    safe: boolean;
    recommendedRepresentatives: number;
    reason: string;
};
//# sourceMappingURL=geometry.d.ts.map