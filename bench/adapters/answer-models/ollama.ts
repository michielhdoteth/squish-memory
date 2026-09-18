/**
 * Ollama answer adapter.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';

const OLLAMA_BASE_URL = 'http://localhost:11434';

export function createOllamaAnswerAdapter(
  model: string = 'llama3.2',
): AnswerAdapter {
  return {
    name: `ollama:${model}`,

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const started = Date.now();

      const contextBlock = input.context.length > 0
        ? `Relevant memories:\n${input.context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}`
        : 'No relevant memories found.';

      const systemPrompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories. If the memories don't contain enough information to answer, say "I don't have enough information to answer this." Be concise and accurate.`;

      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${contextBlock}\n\nQuestion: ${input.query}` },
          ],
          stream: false,
          options: { temperature: 0.1 },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Ollama API error ${response.status}: ${err}`);
      }

      const data = await response.json() as any;
      const answer = data.message?.content?.trim() ?? '';
      const latencyMs = Date.now() - started;

      return {
        answer,
        latencyMs,
        provider: 'ollama',
        model,
      };
    },
  };
}
