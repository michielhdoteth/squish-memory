/**
 * NVIDIA API answer adapter.
 *
 * Extracted from tests/benchmarks/locomo-bench.ts for reuse.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export function createNVIDIAAnswerAdapter(
  model: string = 'poolside/laguna-xs-2.1',
  apiKey?: string,
): AnswerAdapter {
  const key = apiKey || process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY required for NVIDIA answer adapter');

  return {
    name: `nvidia:${model}`,

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const started = Date.now();
      const maxRetries = 3;

      const contextBlock = input.context.length > 0
        ? `Relevant memories:\n${input.context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
        : 'No relevant memories found.';

      const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories. If the memories don't contain enough information to answer, say "I don't have enough information to answer this." Be concise and accurate.`;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
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

          if (response.status === 503) {
            const waitTime = Math.min(Math.pow(2, attempt) * 3000, 30000);
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
        } catch (error) {
          if (attempt === maxRetries - 1) throw error;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
        }
      }

      throw new Error('Max retries exceeded');
    },
  };
}
