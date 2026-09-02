/**
 * Cross-Encoder Reranker - Precision reranking for search results
 *
 * Uses cross-encoder models to jointly attend over query-document pairs
 * for more accurate relevance scoring than bi-encoder cosine similarity.
 *
 * Models:
 *   - cross-encoder/ms-marco-MiniLM-L-6-v2 (fast, English, ~80MB)
 *   - BAAI/bge-reranker-v2-m3 (multilingual, ~1.1GB)
 *   - cross-encoder/ms-marco-MiniLM-L-12-v2 (better accuracy, ~170MB)
 *
 * Usage:
 *   Enabled by default since Batch 5 (set SQUISH_RERANKER_ENABLED=false to opt out).
 *   When @huggingface/transformers does not resolve or the model cannot load
 *   within SQUISH_RERANKER_LOAD_TIMEOUT_MS (default 10s), reranking is skipped
 *   silently and skips are counted in the rerank meta (see getLastRerankMeta).
 */
import type { SearchResult } from '../memory/memories.js';
export interface RerankerConfig {
    enabled: boolean;
    model: string;
    topK: number;
    returnTopK: number;
    /** Max wall-clock time to wait for the model to load before skipping. */
    loadTimeoutMs: number;
    device: 'cpu' | 'webgpu';
    dtype: 'q8' | 'q4' | 'f16' | 'f32';
}
/** Outcome of the most recent rerankResults call (for trace reporting). */
export interface RerankMeta {
    applied: boolean;
    skipped: number;
    reason?: string;
    latencyMs?: number;
}
/**
 * Get reranker configuration from environment variables
 * Reads directly from process.env for testability
 */
export declare function getRerankerConfig(): RerankerConfig;
/**
 * Check if reranker is ready
 */
export declare function isReady(): boolean;
/**
 * Score a single query-document pair
 * Returns relevance score (higher = more relevant), or null when unavailable
 */
export declare function scorePair(query: string, document: string): Promise<number | null>;
/**
 * Score multiple query-document pairs in batch
 * More efficient than calling scorePair multiple times
 */
export declare function scoreBatch(query: string, documents: string[]): Promise<(number | null)[]>;
/**
 * Rerank search results using cross-encoder
 *
 * Behavior matrix (Batch 5):
 * - Flag explicitly off          -> legacy passthrough (truncate to returnTopK,
 *                                   attach _originalScore), no skip counting.
 * - Enabled but unavailable      -> graceful skip: results returned untouched,
 *                                   skips counted in getLastRerankMeta().
 * - Enabled and loaded           -> blend rerank scores, rerank top-K only.
 *
 * @param query - The search query
 * @param results - Initial search results to rerank
 * @param options - Reranking options
 * @returns Reranked results with blended scores
 */
export declare function rerankResults(query: string, results: SearchResult[], options?: {
    topK?: number;
    returnTopK?: number;
    blendWeight?: number;
}): Promise<SearchResult[]>;
/**
 * Meta from the most recent rerankResults call on this process.
 * Read by hybrid-search to populate trace.reranker.
 */
export declare function getLastRerankMeta(): RerankMeta | null;
/**
 * Check health of the reranker
 */
export declare function checkHealth(): Promise<{
    available: boolean;
    latencyMs?: number;
    error?: string;
    model?: string;
}>;
/**
 * Unload the pipeline (for testing or memory management)
 */
export declare function unload(): Promise<void>;
/**
 * Test/operational hook: clear the pipeline AND the unavailability latch so a
 * subsequent call re-attempts loading with current env.
 */
export declare function resetRerankerForTests(): void;
/**
 * Warm up the model with a test input
 */
export declare function warmup(): Promise<boolean>;
declare const _default: {
    getRerankerConfig: typeof getRerankerConfig;
    isReady: typeof isReady;
    scorePair: typeof scorePair;
    scoreBatch: typeof scoreBatch;
    rerankResults: typeof rerankResults;
    getLastRerankMeta: typeof getLastRerankMeta;
    checkHealth: typeof checkHealth;
    unload: typeof unload;
    resetRerankerForTests: typeof resetRerankerForTests;
    warmup: typeof warmup;
};
export default _default;
//# sourceMappingURL=cross-encoder-reranker.d.ts.map