/**
 * LLM Query Rewriter - Uses LLM to rewrite queries for better memory retrieval
 *
 * Expands abbreviations, adds synonyms, clarifies intent.
 * Falls back to original query on LLM failure.
 *
 * Enabled via SQUISH_LLM_REWRITE=true
 */

import { config } from '../../config.js';

const LLM_REWRITE_ENABLED = process.env.SQUISH_LLM_REWRITE === 'true';

interface LLMClient {
  (prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string | null>;
}

/**
 * Rewrite a query using LLM for better memory retrieval.
 * Falls back to original query on any failure.
 */
export async function rewriteQuery(
  query: string,
  callLLM?: LLMClient
): Promise<string> {
  if (!LLM_REWRITE_ENABLED || !callLLM) {
    return query;
  }

  try {
    const prompt = `Rewrite this query to improve memory retrieval.
Expand abbreviations, add synonyms, clarify intent.
Return ONLY the rewritten query, nothing else.
Do not add quotes or explanations.

Original: ${query}
Rewritten:`;

    const rewritten = await callLLM(prompt, { maxTokens: 100, temperature: 0.1 });
    const result = rewritten?.trim();
    
    // Validate: must be non-empty and reasonably similar length
    if (result && result.length > 5 && result.length < query.length * 3) {
      return result;
    }
    
    return query;
  } catch (err) {
    console.error(`[llm-query-rewriter] Failed: ${err}`);
    return query;
  }
}

/**
 * Check if LLM rewriting is enabled
 */
export function isLLMRewriteEnabled(): boolean {
  return LLM_REWRITE_ENABLED;
}
