import { MultimodalInput } from './google-multimodal.js';
export type EmbeddingProvider = 'local' | 'openai' | 'ollama' | 'lmstudio' | 'transformers' | 'google' | 'none' | 'auto';
export declare const TFIDF_MODEL_ID = "tfidf-hashed-ngram-768";
/**
 * Identifier of the embedding model that getEmbedding() resolves to RIGHT NOW.
 * Stamped into memories.embedding_model on writes so the reembed worker can
 * target rows produced by an older model.
 */
export declare function getActiveEmbeddingModelId(): string;
/**
 * Dimension of the vector space getEmbedding() resolves to right now.
 * The TF-IDF boot provider hashes to 768 dims; bundled MiniLM-class models
 * produce 384-dim vectors.
 */
export declare function getActiveEmbeddingDim(): number;
/**
 * Await bundled model readiness (used by tools that SHOULD block, e.g. the
 * reembed worker and eval harness opt-in). Resolves false when disabled or
 * still unavailable after timeoutMs.
 */
export declare function ensureLocalModelReady(timeoutMs?: number): Promise<boolean>;
export declare function getEmbedding(input: string | MultimodalInput): Promise<number[] | null>;
/**
 * Get embeddings for multiple inputs in parallel batches
 * Processes inputs in batches to respect rate limits while parallelizing
 */
export declare function getBatchEmbeddings(inputs: string[], batchSize?: number): Promise<Array<number[] | null>>;
/**
 * Clear the embedding cache
 */
export declare function clearEmbeddingCache(): void;
/**
 * Get embedding cache statistics
 */
export declare function getEmbeddingCacheStats(): {
    size: number;
    maxSize: number;
};
/**
 * Check health of all configured embedding providers
 * Returns availability and latency for each provider
 */
export declare function checkEmbeddingProviderHealth(): Promise<Map<string, {
    available: boolean;
    latencyMs?: number;
    error?: string;
}>>;
//# sourceMappingURL=embeddings.d.ts.map