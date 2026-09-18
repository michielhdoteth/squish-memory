/**
 * OpenAI answer adapter.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';

export function createOpenAIAnswerAdapter(
  model: string = 'gpt-4o-mini',
  apiKey?: string,
): AnswerAdapter {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY required for OpenAI answer adapter');

  return {
    name: `openai:${model}`,

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const started = Date.now();

      const contextBlock = input.context.length > 0
        ? `Relevant memories:\n${input.context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
        : 'No relevant memories found.';

      const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories. If the memories don't contain enough information to answer, say "I don't have enough information to answer this." Be concise and accurate.`;

      const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
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
          max_tokens: 512,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${err}`);
      }

      const data = await response.json() as any;
      const answer = data.choices[0].message.content.trim();
      const latencyMs = Date.now() - started;

      return {
        answer,
        latencyMs,
        provider: 'openai',
        model,
        tokens: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}
