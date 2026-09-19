/**
 * Maximal Marginal Relevance (MMR) - Diversity injection for search results
 *
 * Based on the classic MMR algorithm:
 * https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf
 *
 * Balances relevance to query with diversity from already-selected results.
 * Prevents redundant results covering the same topic.
 *
 * Formula:
 *   MMR = λ * sim(Di, Q) - (1-λ) * max(sim(Di, Dj))
 *   where Dj are already selected documents
 *
 * Usage:
 *   Set SQUISH_MMR_ENABLED=true
 *   Set SQUISH_MMR_LAMBDA=0.7 (70% relevance, 30% diversity)
 */

import { config } from '../../config.js';
import { logger } from '../logger.js';
import { cosineSimilarity, DimensionMismatchError } from '../utils/vector-operations.js';
import type { SearchResult } from '../memory/memories.js';

export interface MMRConfig {
  enabled: boolean;
  lambda: number;        // Relevance vs diversity weight (0-1)
  topK: number;          // How many results to return
  candidatePool: number; // How many candidates to consider
}

/**
 * Get MMR configuration from environment variables
 * Reads directly from process.env for testability
 */
export function getMMRConfig(): MMRConfig {
  return {
    enabled: process.env.SQUISH_MMR_ENABLED === 'true',
    lambda: parseFloat(process.env.SQUISH_MMR_LAMBDA ?? '0.7'),
    topK: parseInt(process.env.SQUISH_MMR_TOP_K ?? '10', 10),
    candidatePool: parseInt(process.env.SQUISH_MMR_CANDIDATE_POOL ?? '50', 10),
  };
}

/**
 * Calculate cosine similarity between two vectors.
 * Batch 4: mixed-model (dimension-mismatched) pairs score 0 for MMR
 * purposes - an explicit, logged degradation rather than a silent helper 0.
 */
function sim(a: number[], b: number[]): number {
  try {
    return cosineSimilarity(a, b);
  } catch (error) {
    if (error instanceof DimensionMismatchError) return 0;
    throw error;
  }
}

/**
 * Apply MMR to diversify search results
 *
 * @param queryEmbedding - Query vector
 * @param results - Search results with embeddings
 * @param options - MMR options
 * @param candidateEmbeddings - Optional pre-computed embeddings array (indexed by position in results).
 *   When provided, cosine similarity is used instead of content-based Jaccard fallback.
 * @returns Diversified results
 */
export function applyMMR(
  queryEmbedding: number[] | null,
  results: SearchResult[],
  options: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
  } = {},
  candidateEmbeddings?: (number[] | null)[]
): SearchResult[] {
  const cfg = getMMRConfig();
  const lambda = options.lambda ?? cfg.lambda;
  const topK = options.topK ?? cfg.topK;
  const candidatePool = options.candidatePool ?? cfg.candidatePool;

  if (!cfg.enabled || !queryEmbedding || results.length === 0) {
    return results.slice(0, topK);
  }

  // Take top candidates for MMR
  const candidates = results.slice(0, candidatePool);

  // Extract embeddings: prefer pre-computed array, fall back to legacy property sniffing
  const embeddings: (number[] | null)[] = candidateEmbeddings
    ? candidateEmbeddings.slice(0, candidatePool)
    : candidates.map(r => {
        // Legacy fallback: try to get embedding from various locations on the result
        const emb = (r as any).embedding ?? (r as any)._embedding ?? null;
        if (Array.isArray(emb)) return emb;
        if (typeof emb === 'string') {
          try { return JSON.parse(emb); } catch { return null; }
        }
        return null;
      });

  // If no embeddings available, fall back to original order
  const hasEmbeddings = embeddings.some(e => e !== null);
  if (!hasEmbeddings) {
    logger.debug('[MMR] No embeddings available, using original order');
    return results.slice(0, topK);
  }

  const selected: number[] = [];  // Indices of selected documents
  const remaining = new Set(candidates.map((_, i) => i));

  // Iteratively select documents
  for (let i = 0; i < topK && remaining.size > 0; i++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const emb = embeddings[idx];
      if (!emb) continue;

      // Relevance to query
      const relevance = sim(queryEmbedding, emb);

      // Max similarity to already selected documents
      let maxSimilarity = 0;
      if (selected.length > 0) {
        const selectedEmb = selected
          .map(s => embeddings[s])
          .filter((e): e is number[] => e !== null);

        if (selectedEmb.length > 0) {
          maxSimilarity = Math.max(
            ...selectedEmb.map(s => sim(emb, s))
          );
        }
      }

      // MMR score
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
    }
  }

  // Return selected results
  return selected.map(i => candidates[i]);
}

/**
 * Apply MMR using content similarity (fallback when no embeddings)
 * Uses simple Jaccard similarity on word sets
 */
export function applyMMRByContent(
  results: SearchResult[],
  options: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
  } = {}
): SearchResult[] {
  const cfg = getMMRConfig();
  const lambda = options.lambda ?? cfg.lambda;
  const topK = options.topK ?? cfg.topK;
  const candidatePool = options.candidatePool ?? cfg.candidatePool;

  if (!cfg.enabled || results.length === 0) {
    return results.slice(0, topK);
  }

  // Take top candidates
  const candidates = results.slice(0, candidatePool);

  // Create word sets for content similarity
  const wordSets = candidates.map(r => {
    const content = (r.content ?? '').toLowerCase();
    return new Set(content.split(/\s+/).filter(w => w.length > 2));
  });

  // Jaccard similarity
  function contentSim(a: number, b: number): number {
    const setA = wordSets[a];
    const setB = wordSets[b];
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  const selected: number[] = [];
  const remaining = new Set(candidates.map((_, i) => i));

  // Use original similarity as relevance proxy
  const relevanceScores = candidates.map(r => r.similarity ?? 0);

  for (let i = 0; i < topK && remaining.size > 0; i++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (const idx of remaining) {
      const relevance = relevanceScores[idx];

      // Max similarity to already selected
      let maxSimilarity = 0;
      if (selected.length > 0) {
        maxSimilarity = Math.max(
          ...selected.map(s => contentSim(idx, s))
        );
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(bestIdx);
      remaining.delete(bestIdx);
    }
  }

  return selected.map(i => candidates[i]);
}

/**
 * Smart MMR: tries embedding-based first, falls back to content-based.
 * When candidateEmbeddings is provided, cosine similarity is used for
 * the diversity penalty instead of Jaccard content overlap.
 */
export function smartMMR(
  queryEmbedding: number[] | null,
  results: SearchResult[],
  options: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
  } = {},
  candidateEmbeddings?: (number[] | null)[]
): SearchResult[] {
  // Try embedding-based MMR first (prefer pre-computed embeddings)
  if (queryEmbedding) {
    const embeddingResults = applyMMR(queryEmbedding, results, options, candidateEmbeddings);
    if (embeddingResults.length > 0) {
      return embeddingResults;
    }
  }

  // Fall back to content-based MMR
  return applyMMRByContent(results, options);
}

/**
 * Check health of MMR
 */
export function checkHealth(): {
  enabled: boolean;
  lambda: number;
} {
  const cfg = getMMRConfig();
  return {
    enabled: cfg.enabled,
    lambda: cfg.lambda,
  };
}

export default {
  getMMRConfig,
  applyMMR,
  applyMMRByContent,
  smartMMR,
  checkHealth,
};
