/** Query Rewriter - Rewrite user queries for better retrieval using LLM */

import { logger } from '../logger.js';
import { config } from '../../config.js';
import { formatContextForLLM, type ContextMessage } from './context-collector.js';
import { expandQueryWithEntities } from './query-processor.js';

export interface RewriteResult {
  original: string;
  rewritten: string;
  expansions: string[];
  intent: 'search' | 'recall' | 'question' | 'context';
  confidence: number;
  method: 'llm' | 'synonym' | 'none';
}

const REWRITE_SYSTEM_PROMPT = `You are a search query optimizer. Given a conversation context and a user's latest message, rewrite the message into the single most effective search query to retrieve relevant memories.

Rules:
1. Output ONLY the optimized search query - no explanations or extra text
2. Remove filler words (please, can you, etc.)
3. Focus on the core information need
4. Preserve important entities (names, dates, technical terms)
5. Add synonyms for key terms if helpful
6. Consider what memories would be most relevant
7. If the message is about recalling something specific, include those details`;

export async function rewriteQuery(
  query: string,
  context: ContextMessage[]
): Promise<RewriteResult> {
  if (!config.queryRewritingEnabled) {
    return {
      original: query,
      rewritten: query,
      expansions: [],
      intent: detectIntent(query),
      confidence: 1.0,
      method: 'none',
    };
  }

  if (config.queryRewritingFallbackEnabled) {
    try {
      const llmResult = await rewriteWithLLM(query, context);
      if (llmResult) return llmResult;
    } catch (error) {
      logger.warn(`[QueryRewriter] LLM rewrite failed, falling back to synonym: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (config.queryRewritingFallbackEnabled) {
    const expanded = expandQueryWithEntities(query);
    return {
      original: query,
      rewritten: expanded.expanded[0] || query,
      expansions: expanded.expanded.slice(1),
      intent: detectIntent(query),
      confidence: 0.7,
      method: 'synonym',
    };
  }

  return {
    original: query,
    rewritten: query,
    expansions: [],
    intent: detectIntent(query),
    confidence: 1.0,
    method: 'none',
  };
}

async function rewriteWithLLM(
  query: string,
  context: ContextMessage[]
): Promise<RewriteResult | null> {
  if (context.length < 2) return null;

  const lastUserMsg = context.filter(m => m.role === 'user').pop()?.content || '';

  const pronounPattern = /\b(it|that|this|they|them|those|these|he|she|his|her)\b/i;
  const hasPronouns = pronounPattern.test(query);

  const vaguePattern = /\b(the thing|the stuff|what (we|I) (talked|discussed|mentioned))\b/i;
  const hasVagueRef = vaguePattern.test(query);

  if (!hasPronouns && !hasVagueRef) return null;

  let rewritten = query;

  const entityPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const contextEntities = lastUserMsg.match(entityPattern) || [];

  const techPattern = /\b([a-z]+\.(?:ts|js|py|json|md)|@[a-z]+\/[a-z]+|\b[A-Z]{2,}\b)\b/gi;
  const techTerms = lastUserMsg.match(techPattern) || [];

  if (contextEntities.length > 0 && hasPronouns) {
    const mostLikelyEntity = contextEntities[contextEntities.length - 1];
    if (!query.toLowerCase().includes(mostLikelyEntity.toLowerCase())) {
      rewritten = `${query} ${mostLikelyEntity}`;
    }
  }

  const firstTechTerm = techTerms[0];
  if (firstTechTerm && !query.includes(firstTechTerm)) {
    rewritten = `${rewritten} ${firstTechTerm}`;
  }

  if (rewritten !== query) {
    logger.info(`[QueryRewriter] Rewrote "${query}" -> "${rewritten}"`);
    return {
      original: query,
      rewritten,
      expansions: [],
      intent: detectIntent(query),
      confidence: 0.8,
      method: 'llm',
    };
  }

  return null;
}

function detectIntent(query: string): 'search' | 'recall' | 'question' | 'context' {
  const lower = query.toLowerCase();

  if (/\b(remember|recall|what did (we|I)|what was|retrieve)\b/.test(lower)) {
    return 'recall';
  }

  if (/^(what|who|when|where|why|how|which|is|are|can|do|does)/.test(lower)) {
    return 'question';
  }

  if (/\b(context|background|about|regarding|concerning)\b/.test(lower)) {
    return 'context';
  }

  return 'search';
}

export function wouldBenefitFromRewrite(query: string): boolean {
  if (query.split(/\s+/).length < 3) return true;

  const pronounPattern = /\b(it|that|this|they|them|those|these|he|she|his|her)\b/i;
  if (pronounPattern.test(query)) return true;

  const vaguePattern = /\b(the thing|the stuff|what (we|I) (talked|discussed|mentioned))\b/i;
  if (vaguePattern.test(query)) return true;

  return false;
}
