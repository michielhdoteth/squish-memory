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
export class DimensionMismatchError extends Error {
  readonly dimA: number;
  readonly dimB: number;

  constructor(dimA: number, dimB: number) {
    super(`Embedding dimension mismatch: ${dimA} vs ${dimB} (mixed embedding models in corpus? run scripts/reembed.ts)`);
    this.name = 'DimensionMismatchError';
    this.dimA = dimA;
    this.dimB = dimB;
  }
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
export function cosineSimilarity(a: number[] | Float32Array | null | undefined, b: number[] | Float32Array | null | undefined): number {
  // Guard against null/undefined inputs
  if (!a || !b) return 0;

  // Vectors must have same dimensions - never fake a 0 similarity
  if (a.length !== b.length) {
    throw new DimensionMismatchError(a.length, b.length);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Single pass to compute dot product and norms
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // Handle zero vectors (avoid division by zero)
  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Calculates the Euclidean distance between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Euclidean distance, or Infinity if vectors have different lengths
 */
export function euclideanDistance(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b) return Infinity;
  if (a.length !== b.length) return Infinity;

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Normalizes a vector to unit length (magnitude = 1).
 *
 * @param vec - Input vector
 * @returns Normalized vector, or null if input is null or zero vector
 */
export function normalizeVector(vec: number[] | null | undefined): number[] | null {
  if (!vec) return null;

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }

  if (norm === 0) return null;

  const magnitude = Math.sqrt(norm);
  return vec.map(val => val / magnitude);
}

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
export function dotProduct(a: number[] | Float32Array | null | undefined, b: number[] | Float32Array | null | undefined): number {
  if (!a || !b) return 0;
  if (a.length !== b.length) {
    throw new DimensionMismatchError(a.length, b.length);
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result += a[i] * b[i];
  }
  return result;
}

/**
 * Calculates the magnitude (L2 norm) of a vector.
 *
 * @param vec - Input vector
 * @returns Magnitude of the vector, or 0 if input is null
 */
export function magnitude(vec: number[] | null | undefined): number {
  if (!vec) return 0;

  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/**
 * Computes the mean of a set of vectors (column-wise average).
 *
 * @param vectors - Array of vectors (rows = observations, cols = dimensions)
 * @returns Mean vector, or empty array for empty input
 */
export function vectorMean(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;

  for (let i = 1; i < vectors.length; i++) {
    if (vectors[i].length !== dim) {
      throw new Error('All vectors must have the same length');
    }
  }

  const mean = new Array(dim).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < dim; j++) {
      mean[j] += vectors[i][j];
    }
  }
  for (let j = 0; j < dim; j++) {
    mean[j] /= vectors.length;
  }
  return mean;
}

/**
 * Centers a set of vectors by subtracting the mean.
 *
 * @param vectors - Array of vectors to center
 * @param mean - Pre-computed mean vector (if not provided, computed)
 * @returns Centered vectors
 */
export function centerVectors(vectors: number[][], mean?: number[]): number[][] {
  if (vectors.length === 0) return [];
  const m = mean ?? vectorMean(vectors);
  if (m.length === 0) return vectors;
  return vectors.map(v => {
    if (v.length !== m.length) throw new Error('Vector dimension mismatch');
    return v.map((val, i) => val - m[i]);
  });
}

/**
 * Computes the covariance matrix from a set of vectors.
 * The result is a dim x dim matrix where element [i][j] = cov(dim_i, dim_j).
 *
 * @param vectors - Array of vectors (rows = observations, cols = dimensions)
 * @returns Covariance matrix as 2D array
 */
export function covarianceMatrix(vectors: number[][]): number[][] {
  if (vectors.length < 2) return [];
  const dim = vectors[0].length;

  for (let i = 1; i < vectors.length; i++) {
    if (vectors[i].length !== dim) {
      throw new Error('All vectors must have the same length');
    }
  }

  const centered = centerVectors(vectors);
  const n = vectors.length;
  const cov: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));

  for (let i = 0; i < dim; i++) {
    for (let j = i; j < dim; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += centered[k][i] * centered[k][j];
      }
      cov[i][j] = sum / (n - 1);
      if (i !== j) {
        cov[j][i] = cov[i][j]; // Symmetric
      }
    }
  }
  return cov;
}

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
export function computeEigenvalues(matrix: number[][]): number[] {
  if (matrix.length === 0) return [];
  const n = matrix.length;

  // Jacobi is robust and deterministic; use it whenever the matrix is small
  // enough for O(n^3) sweeps (cluster Gram/covariance matrices are tiny)
  if (n <= 64) {
    return jacobiEigenvalues(matrix);
  }

  // For larger matrices, extract top eigenvalues via power iteration
  return computeTopEigenvalues(matrix, Math.min(n, 5));
}

/**
 * Computes all eigenvalues of a symmetric matrix using the cyclic Jacobi
 * rotation method. Numerically robust (no deflation drift) and deterministic.
 * Suitable for the small-to-medium matrices used by geometry-aware
 * consolidation (Gram/covariance of clusters).
 */
export function jacobiEigenvalues(matrix: number[][], maxSweeps: number = 50): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const a = matrix.map(row => [...row]);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    // Off-diagonal Frobenius norm
    let off = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        off += a[i][j] * a[i][j];
      }
    }
    if (off < 1e-24) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }

  return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => y - x);
}



/**
 * Computes the trace of a matrix (sum of diagonal elements).
 *
 * @param matrix - Input matrix
 * @returns Trace value
 */
export function matrixTrace(matrix: number[][]): number {
  if (matrix.length === 0) return 0;
  let trace = 0;
  const n = Math.min(matrix.length, matrix[0]?.length ?? 0);
  for (let i = 0; i < n; i++) {
    trace += matrix[i][i];
  }
  return trace;
}

/**
 * Power iteration to find the dominant eigenvalue (and eigenvector) of a
 * symmetric matrix. Uses a deterministic seeded start so results are
 * reproducible across runs.
 */
export function powerIteration(matrix: number[][], maxIter: number = 100, tol: number = 1e-10): number {
  return powerIterationWithVector(matrix, maxIter, tol).lambda;
}

/**
 * Power iteration returning the converged dominant eigenpair.
 */
function powerIterationWithVector(
  matrix: number[][],
  maxIter: number,
  tol: number
): { lambda: number; vector: number[] } {
  const n = matrix.length;
  // Deterministic pseudo-random start (seeded LCG): Math.random() can converge
  // to a different eigenvector on near-degenerate matrices, making callers
  // (e.g. GAC strategy selection) nondeterministic.
  let seed = 0x2f6e2b1;
  const nextRandom = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  let b = new Array(n).fill(1).map(() => nextRandom());
  let lambda = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    // Multiply matrix * b
    const bNext = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        bNext[i] += matrix[i][j] * b[j];
      }
    }

    // Normalize bNext
    const norm = Math.sqrt(bNext.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-15) return { lambda: 0, vector: b };
    b = bNext.map(x => x / norm);

    // Rayleigh quotient with the normalized vector
    let num = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        num += b[i] * matrix[i][j] * b[j];
      }
    }
    const lambdaNew = num;

    if (Math.abs(lambdaNew - lambda) < tol) {
      lambda = lambdaNew;
      break;
    }
    lambda = lambdaNew;
  }
  return { lambda, vector: b };
}



/**
 * Compute the top k eigenvalues of a symmetric matrix using power iteration with deflation.
 */
function computeTopEigenvalues(matrix: number[][], k: number): number[] {
  const n = matrix.length;
  const eigenvalues: number[] = [];
  let workingMatrix = matrix.map(row => [...row]);
  let largestLambda = 0;

  for (let i = 0; i < k; i++) {
    const { lambda, vector: vUnit } = powerIterationWithVector(workingMatrix, 100, 1e-10);
    if (lambda === 0 || !Number.isFinite(lambda) || Math.abs(lambda) < 1e-12) break;
    // Stop once we hit numerical noise: after deflating a (near) rank-deficient
    // matrix, remaining "eigenvalues" are floating-point residue. Including them
    // corrupts downstream statistics (e.g. participation ratio / d_eff).
    if (i > 0 && lambda <= largestLambda * 1e-6) break;
    if (i === 0) largestLambda = lambda;
    eigenvalues.push(lambda);
    // Deflate with the converged eigenvector
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        workingMatrix[r][c] -= lambda * vUnit[r] * vUnit[c];
      }
    }
  }

  if (eigenvalues.length === 0) return [1];
  return eigenvalues;
}

/**
 * Computes the variance explained ratio from eigenvalues.
 * Each value is the fraction of total variance explained by that component.
 *
 * @param eigenvalues - Array of eigenvalues sorted descending
 * @returns Array of ratios that sum to ~1
 */
export function computeVarianceExplained(eigenvalues: number[]): number[] {
  if (eigenvalues.length === 0) return [];
  const total = eigenvalues.reduce((s, v) => s + Math.max(0, v), 0);
  if (total === 0) return eigenvalues.map(() => 0);
  return eigenvalues.map(v => Math.max(0, v) / total);
}

/**
 * Computes the transpose of a matrix.
 *
 * @param matrix - Input matrix as 2D array
 * @returns Transposed matrix
 */
export function transposeMatrix(matrix: number[][]): number[][] {
  if (matrix.length === 0) return [];
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const result: number[][] = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = matrix[i][j];
    }
  }
  return result;
}
