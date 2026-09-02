/**
 * Memory search and similarity operations.
 *
 * Provides the main search entry-point, fallback recency search, and
 * duplicate-detection helper (findSimilarMemories).
 */
import type { SearchInput, SearchResult } from './memory-types.js';
export declare function search(input: SearchInput): Promise<SearchResult[]>;
/**
 * Find similar memories to prevent duplicates
 * Returns memories with semantic similarity >= threshold.
 * Batch 3: gates on the honest semanticScore (cosine / normalized RRF),
 * NOT the boost-inflated composite that `similarity` used to carry.
 * Inherits candidate filters (expired/archived excluded, consolidated
 * sources opt-in) through search().
 */
export declare function findSimilarMemories(content: string, threshold?: number, limit?: number): Promise<SearchResult[]>;
//# sourceMappingURL=memory-search.d.ts.map