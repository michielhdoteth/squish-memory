/**
 * Embedding Provider Interface
 * 
 * Defines the contract for pluggable embedding backends.
 * The default implementation wraps the existing embeddings module.
 */

export interface EmbeddingProvider {
  readonly name: string;
  
  /**
   * Check if this embedding provider is available and configured
   */
  isAvailable(): Promise<boolean>;
  
  /**
   * Get the dimension of the embedding vectors
   */
  getDimension(): Promise<number>;
  
  /**
   * Generate an embedding for a single text
   * Returns null on failure (never throws)
   */
  embed(text: string): Promise<Float32Array | null>;
  
  /**
   * Generate embeddings for multiple texts in batch
   * Returns null for any text that fails to embed
   */
  embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;
  
  /**
   * Optional multimodal embedding support
   */
  embedMultimodal?(input: MultimodalInput): Promise<Float32Array | null>;
}

export interface MultimodalInput {
  text?: string;
  image?: { data: string; mediaType: string };
  audio?: { data: string; mediaType: string };
}

/**
 * Embedding configuration for providers
 */
export interface EmbeddingConfig {
  provider: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}
