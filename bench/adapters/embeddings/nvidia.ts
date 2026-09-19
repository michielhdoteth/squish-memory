/**
 * NVIDIA embedding adapter.
 *
 * Uses NV-Embed-QA via NVIDIA API.
 * Requires NVIDIA_API_KEY env var.
 */

import type { EmbeddingAdapter, EmbeddingResult } from './types.js';

export function createNVIDIAAdapter(model = 'nvidia/nv-embedqa-e5-v5'): EmbeddingAdapter {
  return {
    name: `nvidia:${model}`,

    dimension(): number {
      return 1024;
    },

    async embed(text: string): Promise<EmbeddingResult> {
      const start = performance.now();
      const maxRetries = 3;

      const apiKey = process.env.NVIDIA_API_KEY;
      if (!apiKey) throw new Error('NVIDIA_API_KEY required for NVIDIA adapter');

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: text, encoding_format: 'float' }),
          });

          if (res.status === 503 || res.status === 429) {
            const waitTime = Math.min(Math.pow(2, attempt) * 3000, 60000);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }

          if (!res.ok) throw new Error(`NVIDIA embedding failed: ${res.status}`);
          const data = await res.json() as any;
          const vector = data.data[0].embedding as number[];

          return {
            vector,
            latencyMs: performance.now() - start,
            provider: 'nvidia',
            model,
          };
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
        }
      }

      throw new Error('Max retries exceeded');
    },

    async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
      const start = performance.now();
      const maxRetries = 3;

      const apiKey = process.env.NVIDIA_API_KEY;
      if (!apiKey) throw new Error('NVIDIA_API_KEY required for NVIDIA adapter');

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
          });

          if (res.status === 503 || res.status === 429) {
            const waitTime = Math.min(Math.pow(2, attempt) * 3000, 60000);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }

          if (!res.ok) throw new Error(`NVIDIA embedding failed: ${res.status}`);
          const data = await res.json() as any;

          return data.data.map((item: any, i: number) => ({
            vector: item.embedding as number[],
            latencyMs: (performance.now() - start) / texts.length,
            provider: 'nvidia',
            model,
          }));
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
        }
      }

      throw new Error('Max retries exceeded');
    },
  };
}
