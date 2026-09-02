export declare function normalizeTimestamp(value: any): string | null;
export declare function now(): string;
export declare function isDatabaseUnavailableError(error: any): boolean;
export declare function withDatabaseErrorHandling<T>(operation: () => Promise<T>, errorMessage: string): Promise<T>;
export declare function clampLimit(value: number | undefined, defaultValue: number, min?: number, max?: number): number;
/**
 * Embedding model stamp metadata attached to every write (Batch 4).
 * Identifies which provider/model produced the vector so the reembed
 * worker can find stale rows and search can reason about mixed corpora.
 */
export interface EmbeddingStampMeta {
    /** e.g. "tfidf-hashed-ngram-768" or "transformers:Xenova/all-MiniLM-L6-v2:q8" */
    model?: string;
    /** Vector dimensionality (defaults to vector.length when available) */
    dim?: number;
}
export interface PreparedEmbeddingValues {
    /** JSON text of the (normalized) vector - compat column during migration */
    embeddingJson?: string | null;
    /** Little-endian float32 BLOB of the L2-normalized vector - primary format */
    embeddingBlob?: Buffer | null;
    /** Model stamp for provenance + reembed targeting */
    embeddingModel?: string | null;
    embeddingDim?: number | null;
}
/**
 * Prepare an embedding vector for storage: L2-normalize, then emit BOTH the
 * compact float32 blob (primary read path) and the legacy JSON text (compat)
 * plus model/dim stamps. Normalizing at write time makes cosine == dot.
 */
export declare function prepareEmbedding(embedding: number[] | null, meta?: EmbeddingStampMeta): PreparedEmbeddingValues;
export declare function determineOverallStatus(dbStatus: string, redisOk: boolean): string;
export declare function parseDate(input: string): Date | null;
export declare function filterByDateRange<T extends {
    createdAt?: string | null;
}>(items: T[], since?: string, until?: string): T[];
export type VisibilityScope = 'private' | 'project';
export declare function normalizeVisibilityScopes(visibilityScope?: VisibilityScope | VisibilityScope[] | null): string[] | null;
//# sourceMappingURL=utils.d.ts.map