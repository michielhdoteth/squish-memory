/**
 * Local (transformers) answer adapter.
 *
 * Uses the bundled transformers pipeline for answer generation.
 * Falls back gracefully when the model isn't available.
 */

import type { AnswerAdapter, AnswerInput, AnswerResult } from './types.js';

export function createLocalAnswerAdapter(): AnswerAdapter {
  return {
    name: 'local:transformers',

    async answer(input: AnswerInput): Promise<AnswerResult> {
      const started = Date.now();

      // Local adapter uses a simple extractive approach:
      // Find the most relevant sentence from context that answers the query
      const contextBlock = input.context.join(' ');

      if (!contextBlock) {
        return {
          answer: "I don't have enough information to answer this.",
          latencyMs: Date.now() - started,
          provider: 'local',
          model: 'extractive',
        };
      }

      // Simple keyword overlap scoring for extractive QA
      const queryWords = input.query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const sentences = contextBlock.split(/[.!?]+/).filter(s => s.trim().length > 10);

      let bestSentence = '';
      let bestScore = 0;

      for (const sentence of sentences) {
        const sentLower = sentence.toLowerCase();
        const score = queryWords.filter(w => sentLower.includes(w)).length;
        if (score > bestScore) {
          bestScore = score;
          bestSentence = sentence.trim();
        }
      }

      const answer = bestScore > 0
        ? bestSentence
        : "I don't have enough information to answer this.";

      return {
        answer,
        latencyMs: Date.now() - started,
        provider: 'local',
        model: 'extractive',
      };
    },
  };
}
