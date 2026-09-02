/**
 * Vector Search - Pure semantic search with cosine similarity on embeddings
 *
 * Batch 4: candidate selection is flag-controlled via SQUISH_VECTOR_SCAN:
 * - 'recency': legacy behavior - most recent N rows are candidates
 * - 'full':    chunked keyset-paginated scan over the whole filtered corpus,
 *              scoring float32 blobs directly (dot product == cosine because
 *              vectors are L2-normalized at write time)
 *
 * Read path prefers embedding_blob (zero JSON.parse); falls back to the
 * legacy `embedding` blob column, then embedding_json for un-migrated rows.
 * Dimension mismatches (mixed embedding models) throw DimensionMismatchError
 * from the helpers; here we catch, count, log, and continue.
 */
import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
export type VectorScanMode = 'recency' | 'full';
export declare function getVectorScanMode(): VectorScanMode;
/**
 * Cached DB context for a single search operation.
 * Avoids redundant getDb()/createDatabaseClient() calls across
 * vectorSearch, keywordSearch, and helper functions.
 */
export interface SearchDbContext {
    dbClient: ReturnType<typeof createDatabaseClient>;
    /** Raw drizzle DB instance for direct query builder usage */
    db: Awaited<ReturnType<typeof getDb>>;
}
type HybridSearchOptions = {
    limit?: number;
    project?: string;
    type?: string;
    tags?: string[];
};
export declare function vectorSearch(input: SearchInput, options: HybridSearchOptions, precomputedEmbedding?: number[] | null, ctx?: SearchDbContext): Promise<SearchResult[]>;
export {};
//# sourceMappingURL=vector-search.d.ts.map