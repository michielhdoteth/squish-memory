/**
 * Embedding codec - Float32 little-endian BLOB storage for embeddings.
 *
 * Batch 4: embeddings move from JSON text (embedding_json) to a compact BLOB
 * (embedding_blob) as the primary storage format. JSON remains written for
 * compat during the migration window; readers prefer the blob and fall back
 * to JSON (then the legacy `embedding` column) for un-migrated rows.
 *
 * Storage invariant: vectors are L2-normalized at write time, so cosine
 * similarity == dot product. The full-corpus scan relies on this to skip
 * norm computation entirely.
 */
/** Little-endian float32 byte length of an N-dim vector. */
export declare function embeddingByteLength(dim: number): number;
/**
 * Encode a vector as a little-endian float32 BLOB.
 * L2-normalizes first so dot == cosine downstream.
 * Returns null for null/empty/zero input (nothing useful to store).
 */
export declare function encodeEmbeddingBlob(vector: number[] | Float32Array | null | undefined): Buffer | null;
/**
 * Decode a stored BLOB back into a Float32Array.
 *
 * Accepts Buffer / Uint8Array as returned by better-sqlite3 (and drizzle).
 * Returns null for anything that is not a well-formed float32 payload
 * (wrong byte length, empty, non-finite values). Never throws.
 */
export declare function decodeEmbeddingBlob(data: unknown): Float32Array | null;
/**
 * Normalize a plain array to unit length (returns a NEW array; never mutates
 * the input). Zero vectors are returned unchanged (all zeros) rather than
 * null so callers keep dimension information.
 */
export declare function normalizeForStorage(vector: number[]): number[];
//# sourceMappingURL=embedding-codec.d.ts.map