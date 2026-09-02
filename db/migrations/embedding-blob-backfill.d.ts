/**
 * Batch 4 embedding storage backfill.
 *
 * Converts legacy JSON-text embeddings (embedding_json) into compact
 * little-endian float32 blobs (embedding_blob), L2-normalizing on the way so
 * cosine similarity == dot product for every migrated row.
 *
 * Idempotence: a row is "pending" iff embedding_blob IS NULL AND
 * embedding_json IS NOT NULL - the NULL check IS the marker, and the partial
 * index below keeps the pending check O(pending) instead of O(table) on
 * every boot after migration completes. Re-running converts nothing.
 */
import type { Database } from 'better-sqlite3';
export interface BlobBackfillResult {
    converted: number;
    failed: number;
    pendingAfter: number;
}
export declare function runEmbeddingBlobBackfill(sqlite: Database): Promise<BlobBackfillResult>;
//# sourceMappingURL=embedding-blob-backfill.d.ts.map