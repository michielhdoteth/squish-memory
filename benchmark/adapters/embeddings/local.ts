/**
 * Local TF-IDF embedding adapter.
 *
 * Uses the built-in Squish local embedding provider (TF-IDF fallback).
 * Deterministic, offline, zero-latency baseline.
 */

import type { EmbeddingAdapter, EmbeddingResult } from './types.js';

export function createLocalAdapter(): EmbeddingAdapter {
  return {
    name: 'local:tfidf',

    dimension(): number {
      return 256;
    },

    async embed(text: string): Promise<EmbeddingResult> {
      const start = performance.now();

      // Use the built-in TF-IDF hasher for deterministic offline embeddings
      const { hashToEmbedding } = await import('../../../core/embeddings/hash-embeddings.js');
      const vector = hashToEmbedding(text, 256);

      return {
        vector,
        latencyMs: performance.now() - start,
        provider: 'local',
        model: 'tfidf',
      };
    },

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      const results: EmbeddingResult[] = [];
      for (const text of texts) {
        results.push(await this.embed(text));
      }
      return results;
    },
  };
}
