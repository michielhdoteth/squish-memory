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
import type { SearchResult } from '../memory/memories.js';
export interface MMRConfig {
    enabled: boolean;
    lambda: number;
    topK: number;
    candidatePool: number;
}
/**
 * Get MMR configuration from environment variables
 * Reads directly from process.env for testability
 */
export declare function getMMRConfig(): MMRConfig;
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
export declare function applyMMR(queryEmbedding: number[] | null, results: SearchResult[], options?: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
}, candidateEmbeddings?: (number[] | null)[]): SearchResult[];
/**
 * Apply MMR using content similarity (fallback when no embeddings)
 * Uses simple Jaccard similarity on word sets
 */
export declare function applyMMRByContent(results: SearchResult[], options?: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
}): SearchResult[];
/**
 * Smart MMR: tries embedding-based first, falls back to content-based.
 * When candidateEmbeddings is provided, cosine similarity is used for
 * the diversity penalty instead of Jaccard content overlap.
 */
export declare function smartMMR(queryEmbedding: number[] | null, results: SearchResult[], options?: {
    lambda?: number;
    topK?: number;
    candidatePool?: number;
}, candidateEmbeddings?: (number[] | null)[]): SearchResult[];
/**
 * Check health of MMR
 */
export declare function checkHealth(): {
    enabled: boolean;
    lambda: number;
};
declare const _default: {
    getMMRConfig: typeof getMMRConfig;
    applyMMR: typeof applyMMR;
    applyMMRByContent: typeof applyMMRByContent;
    smartMMR: typeof smartMMR;
    checkHealth: typeof checkHealth;
};
export default _default;
//# sourceMappingURL=mmr-diversity.d.ts.map