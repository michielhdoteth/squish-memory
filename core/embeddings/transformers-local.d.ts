/**
 * Transformers.js Local Embedding Provider
 *
 * Uses ONNX-based transformer models for high-quality local embeddings.
 * Supports Hugging Face ONNX embedding models.
 *
 * Usage:
 *   Set SQUISH_EMBEDDINGS_PROVIDER=transformers
 *   Required: SQUISH_LOCAL_MODEL=<huggingface-onnx-model>
 *
 * Download models automatically on first use. Models cached in HuggingFace cache directory.
 */
export interface TransformersLocalConfig {
    model: string;
    device: 'cpu' | 'webgpu';
    dtype: 'q8' | 'q4' | 'f16' | 'f32';
}
/** Activate a model for pipelines created without SQUISH_LOCAL_MODEL set. */
export declare function setActiveModel(model: string): void;
/**
 * Check if pipeline is loaded
 */
export declare function isReady(): boolean;
/**
 * Get embedding dimension for current model.
 *
 * Resolution order:
 * 1. Dimension observed from the last successful inference (authoritative)
 * 2. Known static dim for the configured model
 * 3. 0 when the model is unknown and has not run yet
 */
export declare function getEmbeddingDimension(): number;
/** Identifier stamped into embedding_model on writes, e.g. "transformers:Xenova/all-MiniLM-L6-v2:q8". */
export declare function getModelId(): string;
/**
 * Generate embedding for a single text input
 * Uses mean pooling + L2 normalization
 */
export declare function getEmbedding(text: string): Promise<number[] | null>;
/**
 * Generate embeddings for multiple texts in batch
 * Processes efficiently with batching
 */
export declare function getBatchEmbeddings(texts: string[], batchSize?: number): Promise<Array<number[] | null>>;
/**
 * Check health of the transformers provider
 */
export declare function checkHealth(): Promise<{
    available: boolean;
    latencyMs?: number;
    error?: string;
    model?: string;
    dimension?: number;
}>;
/**
 * Unload the pipeline (for testing or memory management)
 */
export declare function unload(): Promise<void>;
/**
 * Warm up the model with a test input
 */
export declare function warmup(): Promise<boolean>;
declare const _default: {
    isReady: typeof isReady;
    getEmbeddingDimension: typeof getEmbeddingDimension;
    getModelId: typeof getModelId;
    getEmbedding: typeof getEmbedding;
    getBatchEmbeddings: typeof getBatchEmbeddings;
    checkHealth: typeof checkHealth;
    unload: typeof unload;
    warmup: typeof warmup;
};
export default _default;
//# sourceMappingURL=transformers-local.d.ts.map