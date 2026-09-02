/**
 * FTS5 Keyword Search - SQLite FTS5-based keyword retrieval
 * + Reciprocal Rank Fusion (RRF) for combining vector and keyword signals
 */
import type { SearchResult, SearchInput } from './memories.js';
import type { SearchDbContext } from './vector-search.js';
/**
 * FTS5 keyword search using SQLite's built-in FTS5.
 * Squish already has memories_fts table - this connects it to hybrid search.
 * Provides keyword-based retrieval as a second signal alongside vector similarity.
 */
export declare function keywordSearch(input: SearchInput, limit: number, ctx?: SearchDbContext): Promise<SearchResult[]>;
/**
 * Reciprocal Rank Fusion (RRF) for combining multiple search signals.
 * Fuses vector similarity results with FTS5 keyword results.
 * This is the industry standard approach (Mem0, TrueMemory, etc.).
 */
export declare function rrfFusion(vectorResults: SearchResult[], keywordResults: SearchResult[], limit: number, k?: number): SearchResult[];
/**
 * Batch 6b: N-leg RRF. Fuses any number of ranked legs (vector, keyword,
 * beliefs...) with identical math to rrfFusion - per-leg rank contributions
 * sum by id and are max-normalized afterwards. Single-leg input returns that
 * leg unchanged except for score normalization, matching legacy behavior of
 * not fusing at all when only one leg produced results (callers guard).
 */
export declare function rrfFusionMulti(legs: SearchResult[][], limit: number, k?: number): SearchResult[];
//# sourceMappingURL=keyword-search.d.ts.map