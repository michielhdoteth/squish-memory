/**
 * OpenAI embedding adapter.
 *
 * Uses text-embedding-3-small via the Squish OpenAI embedding provider.
 * Requires OPENAI_API_KEY env var.
 */

import type { EmbeddingAdapter, EmbeddingResult } from './types.js';

export function createOpenAIAdapter(model = 'text-embedding-3-small'): EmbeddingAdapter {
  return {
    name: `openai:${model}`,

    dimension(): number {
      return 1536;
    },

    async embed(text: string): Promise<EmbeddingResult> {
      const start = performance.now();

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY required for OpenAI adapter');

      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`OpenAI embedding failed: ${res.status}`);
      const data = await res.json() as any;
      const vector = data.data[0].embedding as number[];

      return {
        vector,
        latencyMs: performance.now() - start,
        provider: 'openai',
        model,
      };
    },

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      const start = performance.now();
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OPENAI_API_KEY required for OpenAI adapter');

      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`OpenAI embedding failed: ${res.status}`);
      const data = await res.json() as any;

      return data.data.map((item: any, i: number) => ({
        vector: item.embedding as number[],
        latencyMs: (performance.now() - start) / texts.length,
        provider: 'openai',
        model,
      }));
    },
  };
}
