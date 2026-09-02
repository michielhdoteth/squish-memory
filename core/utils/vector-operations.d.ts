/**
 * Vector Operations Utilities
 *
 * Provides mathematical operations for vector computations, primarily focused on
 * cosine similarity calculations for embedding comparisons, covariance matrices,
 * and eigenvalue estimation for geometry-aware consolidation.
 *
 * All functions handle edge cases gracefully and are optimized for performance.
 */
/**
 * Typed error thrown when two vectors of incompatible dimensionality are
 * compared. Batch 4 policy: similarity helpers NEVER silently return 0 on a
 * dimension mismatch — a mismatched comparison is a corpus-consistency bug
 * (mixed embedding models), and faking a 0 similarity silently corrupts
 * rankings. Callers that expect mixed corpora (vector search over rows
 * written by an older embedding model) must catch this error, count the
 * skip, and continue.
 */
export declare class DimensionMismatchError extends Error {
    readonly dimA: number;
    readonly dimB: number;
    constructor(dimA: number, dimB: number);
}
/**
 * Calculates the cosine similarity between two vectors.
 *
 * Cosine similarity measures the cosine of the angle between two vectors,
 * providing a normalized measure of similarity that ranges from -1 (opposite)
 * to 1 (identical), with 0 indicating orthogonality (no similarity).
 *
 * The implementation uses the standard formula:
 *   cos(θ) = (A · B) / (||A|| * ||B||)
 *
 * Edge case handling:
 * - Returns 0 if either vector is null/undefined
 * - THROWS DimensionMismatchError if vectors have different lengths
 * - Returns 0 if either vector has zero magnitude (norm = 0)
 *
 * @param a - First vector as array of numbers
 * @param b - Second vector as array of numbers
 * @returns Cosine similarity value in range [-1, 1], or 0 for invalid inputs
 * @throws {DimensionMismatchError} when vector dimensions differ
 *
 * @example
 * ```typescript
 * const vec1 = [1, 2, 3];
 * const vec2 = [4, 5, 6];
 * const similarity = cosineSimilarity(vec1, vec2); // ~0.974
 * ```
 *
 * @performance
 * - Time complexity: O(n) where n is vector length
 * - Space complexity: O(1) - uses only accumulator variables
 * - Optimized with single-pass computation of dot product and norms
 */
export declare function cosineSimilarity(a: number[] | Float32Array | null | undefined, b: number[] | Float32Array | null | undefined): number;
/**
 * Calculates the Euclidean distance between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Euclidean distance, or Infinity if vectors have different lengths
 */
export declare function euclideanDistance(a: number[] | null | undefined, b: number[] | null | undefined): number;
/**
 * Normalizes a vector to unit length (magnitude = 1).
 *
 * @param vec - Input vector
 * @returns Normalized vector, or null if input is null or zero vector
 */
export declare function normalizeVector(vec: number[] | null | undefined): number[] | null;
/**
 * Computes the dot product of two vectors.
 *
 * For L2-normalized vectors (the Batch 4 storage invariant), the dot product
 * equals cosine similarity, which lets hot scan paths skip norm computation.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Dot product, or 0 if vectors are invalid
 * @throws {DimensionMismatchError} when vector dimensions differ
 */
export declare function dotProduct(a: number[] | Float32Array | null | undefined, b: number[] | Float32Array | null | undefined): number;
/**
 * Calculates the magnitude (L2 norm) of a vector.
 *
 * @param vec - Input vector
 * @returns Magnitude of the vector, or 0 if input is null
 */
export declare function magnitude(vec: number[] | null | undefined): number;
/**
 * Computes the mean of a set of vectors (column-wise average).
 *
 * @param vectors - Array of vectors (rows = observations, cols = dimensions)
 * @returns Mean vector, or empty array for empty input
 */
export declare function vectorMean(vectors: number[][]): number[];
/**
 * Centers a set of vectors by subtracting the mean.
 *
 * @param vectors - Array of vectors to center
 * @param mean - Pre-computed mean vector (if not provided, computed)
 * @returns Centered vectors
 */
export declare function centerVectors(vectors: number[][], mean?: number[]): number[][];
/**
 * Computes the covariance matrix from a set of vectors.
 * The result is a dim x dim matrix where element [i][j] = cov(dim_i, dim_j).
 *
 * @param vectors - Array of vectors (rows = observations, cols = dimensions)
 * @returns Covariance matrix as 2D array
 */
export declare function covarianceMatrix(vectors: number[][]): number[][];
/**
 * Computes eigenvalues of a symmetric matrix using the power iteration method
 * for the dominant eigenvalue, or a simple approach for small matrices.
 *
 * For geometry-aware consolidation, we only need the top eigenvalues
 * to estimate effective dimension.
 *
 * @param matrix - Symmetric matrix (e.g., covariance matrix)
 * @returns Array of eigenvalues sorted descending
 */
export declare function computeEigenvalues(matrix: number[][]): number[];
/**
 * Computes all eigenvalues of a symmetric matrix using the cyclic Jacobi
 * rotation method. Numerically robust (no deflation drift) and deterministic.
 * Suitable for the small-to-medium matrices used by geometry-aware
 * consolidation (Gram/covariance of clusters).
 */
export declare function jacobiEigenvalues(matrix: number[][], maxSweeps?: number): number[];
/**
 * Computes the trace of a matrix (sum of diagonal elements).
 *
 * @param matrix - Input matrix
 * @returns Trace value
 */
export declare function matrixTrace(matrix: number[][]): number;
/**
 * Power iteration to find the dominant eigenvalue (and eigenvector) of a
 * symmetric matrix. Uses a deterministic seeded start so results are
 * reproducible across runs.
 */
export declare function powerIteration(matrix: number[][], maxIter?: number, tol?: number): number;
/**
 * Computes the variance explained ratio from eigenvalues.
 * Each value is the fraction of total variance explained by that component.
 *
 * @param eigenvalues - Array of eigenvalues sorted descending
 * @returns Array of ratios that sum to ~1
 */
export declare function computeVarianceExplained(eigenvalues: number[]): number[];
/**
 * Computes the transpose of a matrix.
 *
 * @param matrix - Input matrix as 2D array
 * @returns Transposed matrix
 */
export declare function transposeMatrix(matrix: number[][]): number[][];
//# sourceMappingURL=vector-operations.d.ts.map