/**
 * NVIDIA API answer adapter.
 *
 * Uses shared rate limiter for provider throughput limits.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';
import { requestNVIDIAChatCompletion } from '../nvidia-polling.js';

export const NVIDIA_ANSWER_GENERATION = {
  temperature: 0.1,
  top_p: 0.95,
  max_tokens: 1024,
  reasoning_budget: 256,
} as const;

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

      const contextBlock = input.context.length > 0
        ? `Relevant memories:\n${input.context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
        : 'No relevant memories found.';

      const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories. If the memories don't contain enough information to answer, say "I don't have enough information to answer this." Be concise and accurate.`;

      const data = await requestNVIDIAChatCompletion({
        apiKey: key,
        label: 'answer',
        body: {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${contextBlock}\n\nQuestion: ${input.query}` },
          ],
          ...NVIDIA_ANSWER_GENERATION,
          stream: false,
        },
      });
      return {
        answer: data.choices[0].message.content.trim(),
        latencyMs: Date.now() - started,
        provider: 'nvidia',
        model,
        tokens: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
