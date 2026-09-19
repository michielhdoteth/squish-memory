/**
 * Embedding adapter interface.
 *
 * Wraps the existing Squish embedding providers for benchmark comparison.
 * Each adapter produces a consistent embedding for the same text input.
 */

export interface EmbeddingResult {
  /** The embedding vector */
  vector: number[];
  /** Latency in milliseconds */
  latencyMs: number;
  /** Provider name */
  provider: string;
  /** Model name */
  model: string;
}

export interface EmbeddingAdapter {
  /** Human-readable name (e.g., "local:tfidf", "openai:text-embedding-3-small") */
  name: string;
  /** Embed a single text */
  embed(text: string): Promise<EmbeddingResult>;
  /** Embed a batch of texts (default: sequential) */
  embedBatch?(texts: string[]): Promise<EmbeddingResult[]>;
  /** Dimension of the embedding vector */
  dimension(): number;
}
