/**
 * NVIDIA API answer adapter.
 *
 * Uses shared rate limiter for provider throughput limits.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';
import { rateLimit } from '../../rate-limit.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export function createNVIDIAAnswerAdapter(
  model: string = 'nvidia/nemotron-3-ultra-550b-a55b',
  apiKey?: string,
): AnswerAdapter {
  const key = apiKey || process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY required for NVIDIA answer adapter');

  return {
    name: `nvidia:${model}`,

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const started = Date.now();
      const maxRetries = 8;

      const contextBlock = input.context.length > 0
        ? `Relevant memories:\n${input.context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
        : 'No relevant memories found.';

      const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories. If the memories don't contain enough information to answer, say "I don't have enough information to answer this." Be concise and accurate.`;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await rateLimit();

          const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${contextBlock}\n\nQuestion: ${input.query}` },
              ],
              temperature: 0.1,
              top_p: 0.95,
              max_tokens: 512,
              stream: false,
            }),
          });

          if (response.status === 429 || response.status === 503) {
            const retryAfter = response.headers.get('retry-after');
            const waitTime = retryAfter
              ? Math.min(parseInt(retryAfter, 10) * 1000 + 2000, 30000)
              : Math.min(Math.pow(2, attempt) * 2000, 30000);
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }

          if (!response.ok) {
            const err = await response.text();
            throw new Error(`NVIDIA API error ${response.status}: ${err}`);
          }

          const data = await response.json() as any;
          const answer = data.choices[0].message.content.trim();
          const latencyMs = Date.now() - started;

          return {
            answer,
            latencyMs,
            provider: 'nvidia',
            model,
            tokens: {
              prompt: data.usage?.prompt_tokens ?? 0,
              completion: data.usage?.completion_tokens ?? 0,
            },
          };
        } catch (error: any) {
          if (attempt === maxRetries - 1) throw error;
          // Transient errors: brief backoff then retry
          const isNetwork = error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED' || error?.code === 'ETIMEDOUT';
          const waitTime = isNetwork
            ? Math.min(Math.pow(2, attempt) * 1000, 10000)
            : Math.min(Math.pow(2, attempt) * 2000, 30000);
          await new Promise(r => setTimeout(r, waitTime));
        }
      }

      throw new Error('Max retries exceeded');
    },
  };
}
