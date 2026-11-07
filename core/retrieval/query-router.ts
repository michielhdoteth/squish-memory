/**
 * Query Router Module
 *
 * Classifies query intent and selects optimal retrieval strategy
 * using regex/keyword-based classification (no LLM, < 5ms).
 */

import { logger } from '../logger.js';
import { decisionModelClient } from '../decision-model/provider.js';
import { getDecisionRunner } from '../decision-model/backend-factory.js';
import type { QueryView, RetrievalDecision } from '../decision-model/types.js';
import { throwIfDecisionAborted } from '../decision-model/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueryIntent =
  | 'temporal'
  | 'relational'
  | 'strategic'
  | 'entity_heavy'
  | 'factual'
  | 'exploratory'
  | 'default';

export type RetrievalStrategy =
  | 'hybrid_search'
  | 'graph_expanded'
  | 'multi_hop'
  | 'temporal_validity'
  | 'strategy_first'
  | 'entity_aware'
  | 'contextual';

export interface QueryClassification {
  intent: QueryIntent;
  confidence: number;
  strategy: RetrievalStrategy;
  reasons: string[];
  detectedEntities: string[];
  detectedTemporalRefs: string[];
  detectedStrategyKeywords: string[];
}

export interface AutoRouteOptions {
  projectId?: string;
  knownEntities?: string[];
  preferGraph?: boolean;
  maxResults?: number;
  /** Cancels optional model escalation while retaining the rule route. */
  signal?: AbortSignal;
}

export interface RouteResult {
  classification: QueryClassification;
  recommendedStrategy: RetrievalStrategy;
  fallbackStrategy: RetrievalStrategy;
  /** Full accepted decision, including every selected view; rules-only routing leaves this absent. */
  decision?: RetrievalDecision;
  routingMetadata: {
    classifiedInMs: number;
    intent: QueryIntent;
    confidence: number;
  };
}

export interface RoutingStats {
  totalRoutes: number;
  byIntent: Record<QueryIntent, number>;
  byStrategy: Record<RetrievalStrategy, number>;
  avgConfidence: number;
}

// ---------------------------------------------------------------------------
// Regex patterns per intent
// ---------------------------------------------------------------------------

const TEMPORAL_PATTERNS: RegExp[] = [
  /\bwhen\s+(?:did|was|is|are)\b/i,
  /\b(?:after|before|since|until|during)\s+/i,
  /\b(?:last|this|next)\s+(?:week|month|year|day|time)\b/i,
  /\b(?:yesterday|tomorrow|today)\b/i,
  /\bon\s+\d{4}-\d{2}/,
  /\b(?:ago|earlier|recently|formerly|previously)\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/i,
];

const RELATIONAL_PATTERNS: RegExp[] = [
  /\b(?:what|how)\s+(?:depends|connects|relates|links)\b/i,
  /\b(?:who|whom)\s+(?:manages|owns|leads|runs)\b/i,
  /\bhow\s+(?:does|do)\s+.+?\s+(?:connect|relate|interact)\b/i,
  /\b(?:relationship|connection|link|dependency)\s+between\b/i,
  /\bdepends?\s+on\b/i,
  /\bwho\s+(?:is|are)\s+responsible\b/i,
  /\bwhat\s+(?:calls|uses|references|imports)\b/i,
];

const STRATEGIC_PATTERNS: RegExp[] = [
  /\b(?:how\s+should|what'?s\s+the\s+best|best\s+practice|procedure|approach)\b/i,
  /\b(?:always|never|should|must|prefer|recommend)\b/i,
  /\b(?:workflow|process|guide|tutorial|pattern)\b/i,
  /\bwhat\s+is\s+the\s+(?:correct|proper|right)\s+(?:way|approach|method)\b/i,
  /\bhow\s+(?:do|should)\s+we\s+(?:handle|implement|manage|configure)\b/i,
];

const FACTUAL_PATTERNS: RegExp[] = [
  /\b(?:what\s+is|what\s+are|define|explain|tell\s+me\s+about)\b/i,
  /\bwhat\s+does\s+.+?\s+mean\b/i,
  /\bcan\s+you\s+(?:explain|describe|define)\b/i,
  /\bwhat\s+(?:are|is)\s+the\s+(?:features|benefits|options)\b/i,
];

const EXPLORATORY_PATTERNS: RegExp[] = [
  /\b(?:show|explore|related|connected|similar)\b/i,
  /\bwhat'?s\s+related\s+to\b/i,
  /\bwhat\s+else\b/i,
  /\bfind\s+(?:me\s+)?(?:similar|related|connected)\b/i,
];

// ---------------------------------------------------------------------------
// Intent-to-strategy mapping
// ---------------------------------------------------------------------------

const INTENT_STRATEGY_MAP: Record<QueryIntent, RetrievalStrategy> = {
  temporal: 'temporal_validity',
  relational: 'multi_hop',
  strategic: 'strategy_first',
  entity_heavy: 'entity_aware',
  factual: 'hybrid_search',
  exploratory: 'graph_expanded',
  default: 'hybrid_search',
};

// ---------------------------------------------------------------------------
// Model escalation (decision layer)
// ---------------------------------------------------------------------------

/** Map a decision-layer retrieval view to the router's intent/strategy. */
function viewToIntentStrategy(view: QueryView): { intent: QueryIntent; strategy: RetrievalStrategy } {
  switch (view) {
    case 'temporal':
      return { intent: 'temporal', strategy: 'temporal_validity' };
    case 'causal':
      return { intent: 'relational', strategy: 'multi_hop' };
    case 'entity':
      return { intent: 'entity_heavy', strategy: 'entity_aware' };
    case 'semantic':
    default:
      return { intent: 'factual', strategy: 'hybrid_search' };
  }
}

/**
 * Escalate low-confidence rule routing to the selected decision backend
 * (llm or systemone; backend=off returns null = rules only). Rules always
 * execute first; the model is consulted ONLY when the rule classification
 * is below the escalation threshold, and its result wins only when the model
 * itself is confident (>= route band). Any failure/timeout/malformed output
 * leaves the rule result untouched.
 */
async function escalateLowConfidenceRouting(classification: QueryClassification, query: string, signal?: AbortSignal): Promise<RetrievalDecision | null> {
  const escalateBelow = decisionModelClient.thresholds.routeEscalateBelow;
  if (classification.confidence >= escalateBelow) return null;

  const modelDecision = await getDecisionRunner().routeQueryModelOnly(query, { signal });
  if (!modelDecision) return null;

  // First view is the primary route; remaining views are kept in the reason.
  const primary = viewToIntentStrategy(modelDecision.queryViews[0]);
  classification.intent = primary.intent;
  classification.strategy = primary.strategy;
  classification.confidence = modelDecision.confidence ?? decisionModelClient.thresholds.route;
  classification.reasons.push(
    `Decision model routed to ${modelDecision.queryViews.join('+')} view` +
    ` (confidence ${classification.confidence.toFixed(2)})`,
  );
  return modelDecision;
}

/** Map every selected decision view so multi-view decisions are not collapsed to the primary view. */
export function intentsForRetrievalDecision(decision: RetrievalDecision): QueryIntent[] {
  const intents = decision.queryViews.map((view) => viewToIntentStrategy(view).intent);
  return Array.from(new Set(intents));
}

// ---------------------------------------------------------------------------
// In-memory routing stats
// ---------------------------------------------------------------------------

const stats = {
  totalRoutes: 0,
  intentCounts: {} as Record<QueryIntent, number>,
  strategyCounts: {} as Record<RetrievalStrategy, number>,
  confidenceSum: 0,
};

function initStats(): void {
  const intents: QueryIntent[] = [
    'temporal', 'relational', 'strategic', 'entity_heavy',
    'factual', 'exploratory', 'default',
  ];
  const strategies: RetrievalStrategy[] = [
    'hybrid_search', 'graph_expanded', 'multi_hop', 'temporal_validity',
    'strategy_first', 'entity_aware', 'contextual',
  ];
  for (const i of intents) stats.intentCounts[i] = 0;
  for (const s of strategies) stats.strategyCounts[s] = 0;
}

initStats();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count how many regexes in the list match the input. */
function countMatches(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(text)) count++;
  }
  return count;
}

/** Collect all matched strings from a set of patterns. */
function collectMatches(text: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) found.push(m[0]);
  }
  return found;
}

/**
 * Extract capitalized multi-word phrases as heuristic entities.
 * E.g. "PostgreSQL Migration" -> ["PostgreSQL Migration"]
 */
function extractCapitalizedPhrases(text: string): string[] {
  const phrases: string[] = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    phrases.push(m[1]);
  }
  return phrases;
}

// ---------------------------------------------------------------------------
// classifyQuery (pure, synchronous)
// ---------------------------------------------------------------------------

export function classifyQuery(query: string): QueryClassification {
  const trimmed = query.trim();
  const reasons: string[] = [];
  const detectedEntities: string[] = [];
  const detectedTemporalRefs: string[] = [];
  const detectedStrategyKeywords: string[] = [];

  // --- Score each intent ---------------------------------------------------
  const scores: Partial<Record<QueryIntent, { score: number; reasons: string[] }>> = {};

  // Temporal
  const temporalMatches = countMatches(trimmed, TEMPORAL_PATTERNS);
  if (temporalMatches > 0) {
    const refs = collectMatches(trimmed, TEMPORAL_PATTERNS);
    detectedTemporalRefs.push(...refs);
    scores.temporal = {
      score: Math.min(0.5 + temporalMatches * 0.15, 0.95),
      reasons: [`Matched ${temporalMatches} temporal pattern(s)`],
    };
  }

  // Relational
  const relationalMatches = countMatches(trimmed, RELATIONAL_PATTERNS);
  if (relationalMatches > 0) {
    scores.relational = {
      score: Math.min(0.5 + relationalMatches * 0.15, 0.95),
      reasons: [`Matched ${relationalMatches} relational pattern(s)`],
    };
  }

  // Strategic
  const strategicMatches = countMatches(trimmed, STRATEGIC_PATTERNS);
  if (strategicMatches > 0) {
    const kws = collectMatches(trimmed, STRATEGIC_PATTERNS);
    detectedStrategyKeywords.push(...kws);
    scores.strategic = {
      score: Math.min(0.5 + strategicMatches * 0.12, 0.95),
      reasons: [`Matched ${strategicMatches} strategic pattern(s)`],
    };
  }

  // Factual
  const factualMatches = countMatches(trimmed, FACTUAL_PATTERNS);
  if (factualMatches > 0) {
    scores.factual = {
      score: Math.min(0.5 + factualMatches * 0.15, 0.90),
      reasons: [`Matched ${factualMatches} factual pattern(s)`],
    };
  }

  // Exploratory
  const exploratoryMatches = countMatches(trimmed, EXPLORATORY_PATTERNS);
  if (exploratoryMatches > 0) {
    scores.exploratory = {
      score: Math.min(0.45 + exploratoryMatches * 0.12, 0.85),
      reasons: [`Matched ${exploratoryMatches} exploratory pattern(s)`],
    };
  }

  // Entity-heavy (heuristic: 2+ capitalized phrases)
  const capitalized = extractCapitalizedPhrases(trimmed);
  if (capitalized.length >= 2) {
    detectedEntities.push(...capitalized);
    scores.entity_heavy = {
      score: Math.min(0.45 + capitalized.length * 0.1, 0.90),
      reasons: [`Detected ${capitalized.length} capitalized multi-word phrases`],
    };
  }

  // Pick highest-scoring intent
  let bestIntent: QueryIntent = 'default';
  let bestScore = 0;
  let bestReasons: string[] = [];

  for (const [intent, data] of Object.entries(scores) as [QueryIntent, { score: number; reasons: string[] }][]) {
    if (data.score > bestScore) {
      bestScore = data.score;
      bestIntent = intent;
      bestReasons = data.reasons;
    }
  }

  if (bestIntent === 'default') {
    bestReasons = ['No specific intent patterns matched; using default route'];
  }

  reasons.push(...bestReasons);

  return {
    intent: bestIntent,
    confidence: bestIntent === 'default' ? 0.3 : bestScore,
    strategy: INTENT_STRATEGY_MAP[bestIntent],
    reasons,
    detectedEntities,
    detectedTemporalRefs,
    detectedStrategyKeywords,
  };
}

// ---------------------------------------------------------------------------
// autoRoute (async — may look up project entities)
// ---------------------------------------------------------------------------

export async function autoRoute(
  query: string,
  options?: AutoRouteOptions,
): Promise<RouteResult> {
  throwIfDecisionAborted(options?.signal);
  const start = performance.now();

  const MAX_QUERY_LENGTH = 10000;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  try {
    const classification = classifyQuery(query);

    // If knownEntities supplied and intent is not already entity_heavy,
    // check whether query references 2+ known entities.
    if (
      options?.knownEntities &&
      options.knownEntities.length > 0 &&
      classification.intent !== 'entity_heavy'
    ) {
      const lowerQuery = query.toLowerCase();
      const matchedKnown = options.knownEntities.filter((e) =>
        lowerQuery.includes(e.toLowerCase()),
      );
      if (matchedKnown.length >= 2) {
        // Override to entity_heavy
        classification.intent = 'entity_heavy';
        classification.strategy = 'entity_aware';
        classification.confidence = Math.min(0.5 + matchedKnown.length * 0.1, 0.90);
        classification.reasons = [
          `Matched ${matchedKnown.length} known project entities: ${matchedKnown.join(', ')}`,
        ];
        classification.detectedEntities = matchedKnown;
      }
    }

    // If preferGraph is set and strategy is hybrid_search, bump to graph_expanded
    if (
      options?.preferGraph &&
      classification.strategy === 'hybrid_search' &&
      classification.intent !== 'factual'
    ) {
      classification.strategy = 'graph_expanded';
      classification.reasons.push('preferGraph option applied; upgraded to graph_expanded');
    }

    // Decision layer: low-confidence rules may be upgraded by the model.
    // Disabled layer / confident rules / model failure all leave the rule
    // result untouched.
    const decision = await escalateLowConfidenceRouting(classification, query, options?.signal);

    // Determine fallback strategy
    const fallbackStrategy: RetrievalStrategy =
      classification.strategy === 'hybrid_search' ? 'contextual' : 'hybrid_search';

    const classifiedInMs = performance.now() - start;

    // Track stats
    stats.totalRoutes += 1;
    stats.intentCounts[classification.intent] += 1;
    stats.strategyCounts[classification.strategy] += 1;
    stats.confidenceSum += classification.confidence;

    logger.debug('Query classified', {
      intent: classification.intent,
      strategy: classification.strategy,
      confidence: classification.confidence,
      classifiedInMs: classifiedInMs.toFixed(2),
    });

    return {
      classification,
      recommendedStrategy: classification.strategy,
      fallbackStrategy,
      ...(decision ? { decision } : {}),
      routingMetadata: {
        classifiedInMs,
        intent: classification.intent,
        confidence: classification.confidence,
      },
    };
  } catch (error) {
    throwIfDecisionAborted(options?.signal);
    logger.error('Query routing failed, falling back to hybrid_search', { error });
    const classifiedInMs = performance.now() - start;
    return {
      classification: {
        intent: 'default',
        confidence: 0,
        strategy: 'hybrid_search',
        reasons: ['Routing failed; falling back to hybrid_search'],
        detectedEntities: [],
        detectedTemporalRefs: [],
        detectedStrategyKeywords: [],
      },
      recommendedStrategy: 'hybrid_search',
      fallbackStrategy: 'contextual',
      routingMetadata: {
        classifiedInMs,
        intent: 'default',
        confidence: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// getRoutingStats
// ---------------------------------------------------------------------------

export function getRoutingStats(): RoutingStats {
  const total = stats.totalRoutes || 1;
  return {
    totalRoutes: stats.totalRoutes,
    byIntent: { ...stats.intentCounts },
    byStrategy: { ...stats.strategyCounts },
    avgConfidence: stats.confidenceSum / total,
  };
}
