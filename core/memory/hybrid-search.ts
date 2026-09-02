/**
 * Hybrid Search Orchestrator
 *
 * Coordinates vector search, keyword search, scoring, and ranking.
 * The individual components are in separate modules:
 * - vector-search.ts: Vector similarity search
 * - keyword-search.ts: FTS5 keyword search + RRF fusion
 * - search-scoring.ts: All scoring/ranking/filtering helpers
 */

import type { SearchResult, SearchInput } from './memories.js';
export type { SearchResult } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { getEmbedding } from '../../core/embeddings.js';
import config from '../../config.js';
import { multiHopSearch } from '../graph/multi-hop-retrieval.js';
import { callLLM } from '../llm/client.js';
import { logger } from '../logger.js';
import { getRetrievalConfig, getPrecisionStackFlags, getGraphBoostFlags, type SquishRetrievalConfig, type RetrievalScoringConfig, type RetrievalTrace } from '../retrieval/config.js';
import { questionPlaceType } from '../places/question-router.js';
import { getAdjacentPlaces as getQuestionAdjacentPlaces } from '../places/rules.js';
import { normalizeVisibilityScopes, type VisibilityScope } from '../lib/utils.js';

// Enhanced retrieval modules
import { rerankResults } from '../retrieval/cross-encoder-reranker.js';
import { enrichContent } from '../retrieval/contextual-enrichment.js';
import { smartMMR } from '../retrieval/mmr-diversity.js';

// Advanced retrieval modules
import { expandQuery } from '../retrieval/query-expansion.js';
import { extractQueryEntities, entityBoost } from '../retrieval/entity-aware-retrieval.js';
// Temporal validity v2: query-conditioned validity-at-T (replaces the retired
// flat staleness penalty - see core/retrieval/temporal-validity.ts).
import { parseTimeReference, stripTemporalRelationTokens } from '../retrieval/temporal-query.js';
import { applyTemporalEligibility } from '../retrieval/temporal-validity.js';

/**
 * Merge results by ID, keeping the one with the highest similarity.
 * Batch 3: prefers honest semanticScore when present (dedup must not be
 * skewed by accumulated boosts).
 */
function deduplicateById(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  for (const r of results) {
    const score = (r.semanticScore ?? r.similarity ?? 0);
    const existing = seen.get(r.id);
    if (!existing || score > (existing.semanticScore ?? existing.similarity ?? 0)) {
      seen.set(r.id, r);
    }
  }
  return Array.from(seen.values());
}

// Graph boost
// Batch 5: normalized (default) or legacy raw mode via SQUISH_GRAPH_BOOST_LEGACY.
import { computeGraphBoost, calculateGraphBoostNormalized, effectiveGraphBoostWeight } from '../search/graph-boost.js';

// Imports from split modules
import { vectorSearch, type SearchDbContext } from './vector-search.js';
import { keywordSearch, rrfFusion, rrfFusionMulti } from './keyword-search.js';
// Batch 6b: beliefs corpus leg (active knowledge rows as third retrieval corpus).
import { beliefSearch, areBeliefsEnabled } from './belief-search.js';
import {
  heuristicComponents,
  applyMultiPlaceScoring,
  applyTagOverlapBoost,
  applySessionBoost,
  applyTemporalBoost,
  applySupersessionFilter,
  applyGraphBoostWithWeight,
  expandWithAssociations,
  getSupersessionInvalidationMap,
} from './search-scoring.js';
import {
  SCORING_SCHEMA_VERSION,
  getScoringFlags,
  initScoreFields,
  finalizeScores,
  addBoost,
  applyReplacement,
  deriveShadowDelta,
  recordShadowDelta,
} from '../scoring/three-field.js';
import { getLastRerankMeta } from '../retrieval/cross-encoder-reranker.js';
// Batch 6a: calibrated recall confidence + itemized evidence (additive metadata).
import { attachRecallConfidence } from './search-evidence.js';
// Batch B1: topical alignment - parse the query topic ONCE per search call;
// consumed by recall-confidence only, never by ranking.
import { parseQueryTopic } from '../scoring/topical-alignment.js';

// Re-export from sub-modules for backward compatibility
export { keywordSearch, rrfFusion } from './keyword-search.js';
export { vectorSearch, type SearchDbContext } from './vector-search.js';
export {
  applyMultiPlaceScoring,
  applyTagOverlapBoost,
  applySessionBoost,
  applyTemporalBoost,
  applySupersessionFilter,
  applyGraphBoostWithWeight,
  expandWithAssociations,
  scoreWithHeuristics,
  getMemoryPlacesByType,
  getMemoriesByIndexedTags,
  getSupersededMemoryIds,
} from './search-scoring.js';

export interface HybridSearchOptions {
  limit?: number;
  project?: string;
  type?: string;
  tags?: string[];
  enableMultiSession?: boolean; // Enable multi-session expansion
  enableGraphTraversal?: boolean; // Enable multi-hop graph traversal (Task 4)
  enableHeuristics?: boolean;
  includeAssociations?: boolean;
}

/**
 * Detect if query asks about time (temporal queries)
 */
function isTemporalQuery(query: string): boolean {
  const temporalIndicators = [
    'when', 'how long', 'how many', 'ago', 'since', 'until',
    'before', 'after', 'earlier', 'later', 'yesterday', 'tomorrow',
    'last week', 'next week', 'last month', 'next month'
  ];
  const lower = query.toLowerCase();
  return temporalIndicators.some(w => lower.includes(w));
}

/**
 * Detect if query spans multiple sessions (multi-hop queries)
 * Only triggers for explicit multi-session indicators, NOT temporal words
 */
function isMultiSessionQuery(query: string): boolean {
  const multiSessionIndicators = [
    'across sessions', 'between sessions', 'another session',
    'different session', 'previous session', 'next session',
    'session', 'dialogue', 'conversation'
  ];
  const lower = query.toLowerCase();
  return multiSessionIndicators.some(w => lower.includes(w));
}

/**
 * Expand query for multi-session retrieval
 */
function expandQueryForMultiSession(query: string): string[] {
  const expansions = [query];
  const lower = query.toLowerCase();

  // Add time-based expansions
  if (lower.includes('when')) {
    expansions.push(query.replace(/when/i, '').trim());
  }
  if (lower.includes('before') || lower.includes('after')) {
    expansions.push(query.replace(/before|after/i, '').trim());
  }
  if (lower.includes('earlier') || lower.includes('later')) {
    expansions.push(query.replace(/earlier|later/i, '').trim());
  }

  // Add "mentioning" expansions for factual queries
  if (lower.includes('what') || lower.includes('how')) {
    expansions.push(query + ' mentioned');
    expansions.push(query + ' said');
  }

  return [...new Set(expansions.filter(e => e.length > 2))];
}

/**
 * Expand query for temporal retrieval - add date/temporal context
 */
function expandQueryForTemporal(query: string): string[] {
  const expansions = [query];
  const lower = query.toLowerCase();

  // For "when" questions, search with entity + date context
  if (lower.includes('when')) {
    // Extract entity name (everything after "when did" or "when is")
    const entityMatch = query.match(/when\s+(?:did|is|was|were)\s+(\w+)/i);
    if (entityMatch) {
      const entity = entityMatch[1];
      // Search with entity name alone (might match date mentions)
      expansions.push(entity);
      expansions.push(query.replace(/when\s+(?:did|is|was|were)\s+/i, '').trim());
    }
  }

  // Add "date" and "time" expansions
  if (lower.includes('when') || lower.includes('how long') || lower.includes('ago')) {
    expansions.push(query + ' date');
    expansions.push(query + ' time');
  }

  return [...new Set(expansions.filter(e => e.length > 2))];
}

/**
 * Main search function - vectors + graph boost + heuristics + places + sessions
 * Unified search integrating Places, Graph, and Memory
 */
export async function hybridSearch(
  input: SearchInput,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? input.limit ?? 10;
  const enableMultiSession = options.enableMultiSession !== false;
  const enableHeuristics = options.enableHeuristics !== false;
  const traceEnabled = input.trace === true;

  // Batch 5: precision stack flags - all default ON, individually disableable.
  const precision = getPrecisionStackFlags();

  // LLM Query Rewriting: rewrite query for better retrieval (optional, env-gated)
  // Must happen BEFORE isMultiHop/isTemporal checks since they depend on effectiveQuery.
  let effectiveQuery = input.query || '';
  if (process.env.SQUISH_LLM_REWRITE === 'true' && input.query && input.query.trim().length > 0) {
    try {
      const { rewriteQuery } = await import('../retrieval/llm-query-rewriter.js');
      const rewritten = await rewriteQuery(input.query, callLLM);
      if (rewritten !== input.query) {
        effectiveQuery = rewritten;
        logger.debug(`[HybridSearch] Query rewritten: "${input.query}" -> "${rewritten}"`);
      }
    } catch (e) {
      logger.debug(`[HybridSearch] LLM query rewriting failed: ${e}`);
    }
  }

  const isMultiHop = enableMultiSession && isMultiSessionQuery(effectiveQuery);
  const isTemporal = isTemporalQuery(effectiveQuery);

  // Temporal validity v2: classify the query's time reference ONCE per search
  // (pure regex, no LLM). The temporal stages below only activate for queries
  // that actually reach into the past; 'current'/'none' queries keep the exact
  // pre-temporal pipeline (filter stays, eligibility stage inert).
  const timeRef = parseTimeReference(effectiveQuery);
  const temporalStageActive =
    precision.temporalValidity &&
    (timeRef.kind === 'past-anchored' || timeRef.kind === 'past-unanchored');
  const traceTemporal = {
    kind: timeRef.kind,
    t: timeRef.t ? timeRef.t.toISOString() : null,
    raw: timeRef.raw,
    supersessionRelaxed: false,
    excludedInvalidAtT: 0,
    boostedValidAtT: 0,
  };

  // Advanced Retrieval: Query Expansion
  // Expand query with synonyms before searching if enabled
  const queryExpansionEnabled = precision.queryExpansion;
  let expandedQueries: string[] = [effectiveQuery];
  
  if (queryExpansionEnabled && effectiveQuery.trim().length > 0) {
    expandedQueries = expandQuery(effectiveQuery, { enabled: true, maxExpansions: 3 });
    logger.debug(`[HybridSearch] Query expanded to ${expandedQueries.length} variants`);
  }

  // Advanced Retrieval: Entity Extraction
  // Extract entities from query for entity-aware boosting
  const entityRetrievalEnabled = process.env.SQUISH_ENTITY_RETRIEVAL === 'true';
  const queryEntities = entityRetrievalEnabled && effectiveQuery
    ? extractQueryEntities(effectiveQuery)
    : [];
  
  if (queryEntities.length > 0) {
    logger.debug(`[HybridSearch] Extracted ${queryEntities.length} entities: ${queryEntities.join(', ')}`);
  }

  // Pre-compute query embedding once to avoid redundant API calls.
  // This embedding is used by vectorSearch and MMR diversity.
  const isEmptyQuery = !effectiveQuery || effectiveQuery.trim() === '';
  const queryEmbedding = isEmptyQuery ? null : await getEmbedding(effectiveQuery);

  // Cache DB client once per search operation to avoid redundant getDb()/createDatabaseClient() calls
  const rawDb = await getDb();
  const searchCtx: SearchDbContext = {
    dbClient: createDatabaseClient(rawDb),
    db: rawDb,
  };

  // Initialize trace object for debugging (Phase 8)
  const trace: RetrievalTrace = {
    selectedPlace: input.placeType ?? questionPlaceType(input.query) ?? null,
    fallbackUsed: false,
    fallbackPlaces: [],
    matchedPlaces: [],
    matchedTags: [],
    scoreBreakdown: {},
    scoreBreakdowns: [],
    supersededFiltered: 0,
    totalCandidates: 0,
    finalOrder: [],
    finalResultCount: 0,
    temporalQuery: traceTemporal,
  };

  let vectorResults: SearchResult[] = [];

  // Embedding map: thread vector embeddings through the pipeline for MMR diversity.
  // Populated from vector search results (which decode and attach _embedding),
  // consumed by smartMMR for proper cosine similarity diversity penalty.
  const embeddingMap = new Map<string, number[] | null>();

  try {
    if (isMultiHop) {
      // Multi-hop: use expansion to get more coverage
      const expandedQueries = expandQueryForMultiSession(effectiveQuery);
      const allResults: SearchResult[] = [];

      for (const expQuery of expandedQueries) {
        // For expanded queries, compute embedding per expansion (query text changes)
        const expEmbedding = await getEmbedding(expQuery);
        const expResults = await vectorSearch(
          { ...input, query: expQuery },
          { ...options, limit: Math.ceil(limit * 2) },
          expEmbedding,
          searchCtx
        );
        allResults.push(...expResults);
      }

      vectorResults = deduplicateById(allResults);
    } else if (isTemporal) {
      // Temporal: fetch more results
      vectorResults = await vectorSearch(input, { ...options, limit: limit * 4 }, queryEmbedding, searchCtx);
    } else if (queryExpansionEnabled && expandedQueries.length > 1) {
      // Advanced Query Expansion: search with expanded queries and merge results
      const allResults: SearchResult[] = [];
      
      for (const expQuery of expandedQueries) {
        const expEmbedding = await getEmbedding(expQuery);
        const expResults = await vectorSearch(
          { ...input, query: expQuery },
          { ...options, limit: Math.ceil(limit * 1.5) },
          expEmbedding,
          searchCtx
        );
        allResults.push(...expResults);
      }
      
      // Merge results, keeping highest similarity for each memory
      vectorResults = deduplicateById(allResults);
      vectorResults.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    } else {
      // Regular query
      vectorResults = await vectorSearch(input, { ...options, limit: limit * 2 }, queryEmbedding, searchCtx);
    }
  } catch (err) {
    logger.warn(`[HybridSearch] Vector search failed, falling back to recency: ${err instanceof Error ? err.message : err}`);
    vectorResults = [];
  }

  // Record total candidates for trace
  trace.totalCandidates = vectorResults.length;

  // Extract embeddings from vector results before they flow through
  // the pipeline (reranking, MMR, etc. may strip hidden properties).
  for (const r of vectorResults) {
    const emb = (r as any)._embedding;
    if (Array.isArray(emb)) {
      embeddingMap.set(r.id, emb);
    }
  }

  // FTS5 keyword search + RRF fusion: add keyword signal and fuse with vector results
  // This is the industry standard (TrueMemory episodic layer, MemPalace FTS5, etc.)
  // Temporal validity v2: on past-referencing queries the lexical leg matches
  // against a query with temporal RELATION words ("before", "since", ...)
  // stripped. Those tokens carry no topical content once the time reference
  // is parsed, and as exact-match magnets they let unrelated rows that merely
  // contain "before" crowd historically-correct answers out of top-3
  // (measured on the memory-bench fact-update category). Non-past queries
  // keep the raw query: byte-identical default pipeline.
  const lexicalQuery =
    temporalStageActive && effectiveQuery ? stripTemporalRelationTokens(effectiveQuery) : effectiveQuery;
  // An over-sanitized (empty) lexical query degrades gracefully inside
  // keywordSearch to an empty leg - fusion then proceeds vector-only.
  const keywordResults = await keywordSearch(
    { ...input, query: lexicalQuery ?? '' },
    limit * 2,
    searchCtx
  );

  // Batch 6b: OPTIONAL third corpus leg - active belief + strategy knowledge
  // rows from the unified knowledge table. SQUISH_SEARCH_BELIEFS
  // (default ON). Empty when disabled, when explicit type/tags filters are
  // set (belief leg excluded - see belief-search.ts), or no matching belief
  // rows exist, in which case fusion below is byte-identical to the previous
  // two-leg behavior.
  let beliefResults: SearchResult[] = [];
  if (areBeliefsEnabled() && !isEmptyQuery && effectiveQuery.trim().length > 0) {
    try {
      beliefResults = await beliefSearch(input, Math.ceil(limit * 2), searchCtx);
      if (beliefResults.length > 0) {
        logger.debug(`[HybridSearch] Beliefs leg produced ${beliefResults.length} candidate(s)`);
      }
    } catch (e) {
      logger.debug(`[HybridSearch] Beliefs leg failed: ${e}`);
    }
  }

  // Batch 6a evidence: capture the lexical leg's OWN ranking before fusion so
  // recall-confidence can measure independent agreement. rank = 1-based FTS
  // position; score = bm25 strength normalized within the leg (keywordSearch
  // already negates FTS5's negative rank, so larger similarity = better).
  // Read-only bookkeeping - fusion below is unchanged.
  const lexicalRanks = new Map<string, { rank: number; score: number }>();
  if (keywordResults.length > 0) {
    let maxLex = 0;
    for (const k of keywordResults) maxLex = Math.max(maxLex, k.similarity ?? 0);
    keywordResults.forEach((k, idx) => {
      if (!lexicalRanks.has(k.id)) {
        lexicalRanks.set(k.id, { rank: idx + 1, score: maxLex > 0 ? Math.max(0, k.similarity ?? 0) / maxLex : 1 });
      }
    });
  }

  if (keywordResults.length > 0 || beliefResults.length > 0) {
    // Batch 6b: N-leg RRF - vector + keyword + (optional) beliefs legs.
    const legs: SearchResult[][] = [vectorResults];
    if (keywordResults.length > 0) legs.push(keywordResults);
    if (beliefResults.length > 0) legs.push(beliefResults);
    vectorResults = rrfFusionMulti(legs, limit * 3);
  }

  // Batch 3: from here on every candidate carries the explicit three-field
  // semantics. semanticScore is now frozen (cosine or normalized RRF) and
  // never overwritten; all adjustments below are additive boosts.
  vectorResults = initScoreFields(vectorResults);

  // v1.5.0: Place-aware scoring using indexed memory_places queries
  const retrievalConfig = getRetrievalConfig();
  if (input.project || input.placeType) {
    vectorResults = await applyMultiPlaceScoring(vectorResults, input, limit, retrievalConfig, searchCtx);
    // Track matched places for trace
    if (trace.selectedPlace) {
      trace.matchedPlaces.push(trace.selectedPlace);
    }
    const adjacentPlaces = getQuestionAdjacentPlaces(trace.selectedPlace as any);
    trace.fallbackPlaces = adjacentPlaces;
    if (adjacentPlaces.length > 0) {
      trace.fallbackUsed = true;
      trace.matchedPlaces.push(...adjacentPlaces);
    }
  }

  // v1.5.0: Tag overlap boost using indexed memory_tags
  const queryTags = input.tags ?? [];
  if (queryTags.length > 0) {
    vectorResults = await applyTagOverlapBoost(vectorResults, queryTags, retrievalConfig.scoring, searchCtx);
    trace.matchedTags = [...queryTags];
  }

  // Task 3: Add session temporal scope
  // If sessionId specified, boost memories from same session
  if (input.sessionId) {
    vectorResults = applySessionBoost(vectorResults, input.sessionId);
  }

  // TEMPORAL: Boost results with dates for temporal queries
  if (isTemporal) {
    vectorResults = applyTemporalBoost(vectorResults);
  }

  // Apply heuristics if enabled (recency + entity overlap)
  // Batch 3: itemized as heuristicRecency / heuristicEntityOverlap boosts.
  // semanticScore stays untouched - the composite moves, the honest
  // retrieval relevance does not.
  if (enableHeuristics) {
    const now = Date.now();
    vectorResults = vectorResults.map(r => {
      const { recency, entityOverlap } = heuristicComponents(r, effectiveQuery, now);
      let out = addBoost(r, 'heuristicRecency', recency);
      return addBoost(out, 'heuristicEntityOverlap', entityOverlap);
    });
  }

  // Advanced Retrieval: Entity-Aware Boost
  // Boost results that share entities with the query
  if (entityRetrievalEnabled && queryEntities.length > 0) {
    vectorResults = entityBoost(vectorResults, queryEntities);
    logger.debug(`[HybridSearch] Entity boost applied with ${queryEntities.length} entities`);
  }

  // Graph boost (Batch 5): the boost map is normalized WITHIN the candidate
  // set to 0..1 before applying config weight (default 0.10), so the maximum
  // possible contribution is +weight instead of the legacy +3.0 x weight.
  // Coactivation counts are log-scaled so hub memories cannot dominate.
  // SQUISH_GRAPH_BOOST_LEGACY=true restores the pre-Batch-5 absolute mode
  // byte-for-byte: raw capped sums x the legacy weight 0.2 (max +0.60),
  // unless SQUISH_WEIGHT_GRAPH_BOOST is set explicitly.
  const graphMode = getGraphBoostFlags();
  const graphWeight = effectiveGraphBoostWeight(graphMode.legacy);
  const candidateIds = vectorResults.map(r => r.id);

  // Batch 6a: rerank-agreement fraction, filled in by the cross-encoder branch below.
  let rerankAgreement: number | null = null;

  let results: SearchResult[];
  if (graphMode.legacy) {
    const graphBoostMap = await computeGraphBoost(candidateIds);
    results = applyGraphBoostWithWeight(vectorResults, graphBoostMap, limit, graphWeight);
  } else {
    const { normalized } = await calculateGraphBoostNormalized(candidateIds);
    results = applyGraphBoostWithWeight(vectorResults, Object.fromEntries(normalized), limit, graphWeight);
  }

  // v1.5.0: Filter or penalize superseded memories
  // Temporal validity v2: for queries that reach into the past, RELAX the
  // supersession stage entirely - superseded/merged rows are the
  // historically-correct answers a point-in-time query needs. This overrides
  // both the filter mode (includeSuperseded=false) and the penalty mode:
  // penalizing them would defeat the point-in-time retrieval this path
  // exists for. The anchored-past eligibility stage below re-establishes
  // correctness by validity-at-T instead.
  if (temporalStageActive) {
    traceTemporal.supersessionRelaxed = true;
    logger.debug(
      `[HybridSearch] Supersession filter relaxed for ${timeRef.kind} query`
    );
  } else {
    const { filtered: supersededResults, supersededCount } = await applySupersessionFilter(
      results, input.project, retrievalConfig.includeSuperseded, retrievalConfig, searchCtx
    );
    trace.supersededFiltered = supersededCount;
    results = supersededResults;
  }

  // Expand with associated memories for better coverage
  if (options.includeAssociations !== false) {
    results = await expandWithAssociations(results, limit, {
      includeConsolidatedSources: input.includeConsolidatedSources === true,
    });
  }

  // Task 4: Enable multi-hop graph traversal by default
  // If query is detected as multi-hop, use actual graph traversal.
  // Batch 2 note: multiHopSearch rehydrates candidates through hybridSearch
  // internally, so those results inherit the same status/consolidation
  // SQL filters as the primary legs - no separate filtering needed here.
  if (isMultiHop && options.enableGraphTraversal !== false && input.project) {
    try {
      const graphResults = await multiHopSearch({
        query: effectiveQuery,
        project: input.project,
        limit: limit,
        includeVectorResults: false,
        includeGraphResults: true,
      });

      // Merge graph results with vector results
      const existingIds = new Set(results.map(r => r.id));
      for (const gr of graphResults) {
        if (!existingIds.has(gr.id)) {
          // Batch 3: graph-leg entries enter at their honest base weight with
          // the legacy 10% discount itemized as multiHopWeight.
          const base = gr.similarity ?? 0;
          const seeded = initScoreFields([{ ...gr, similarity: base }])[0];
          results.push(addBoost(seeded, 'multiHopWeight', -(base * 0.1)));
        }
      }

      // Re-sort
      results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    } catch (e) {
      // Multi-hop failed, continue with vector results
      logger.debug(`[HybridSearch] Multi-hop failed: ${e}`);
    }
  }

  // Temporal validity v2 (anchored past): enforce validity-at-T.
  // Placed AFTER every candidate-injecting stage (associations, multi-hop) so
  // an excluded memory cannot be resurrected back into the ranking, and
  // BEFORE any reranker so the exclusion survives. Only runs for queries with
  // an explicit past anchor ("in 2023"); unanchored-past queries were handled
  // by the supersession relaxation above and get NO exclusions or boosts here.
  if (precision.temporalValidity && timeRef.kind === 'past-anchored' && timeRef.t !== null) {
    const invalidationMap = await getSupersessionInvalidationMap(input.project, searchCtx);
    const eligibility = applyTemporalEligibility(
      results.map(r => ({
        createdAt: r.createdAt ?? null,
        supersededAt: invalidationMap.has(r.id) ? invalidationMap.get(r.id) ?? null : null,
      })),
      timeRef
    );

    const kept: SearchResult[] = [];
    for (let i = 0; i < results.length; i++) {
      const verdict = eligibility[i];
      if (!verdict.eligible) {
        traceTemporal.excludedInvalidAtT += 1;
        continue;
      }
      kept.push(
        verdict.boost !== 0 ? addBoost(results[i], 'temporalValidAtT', verdict.boost) : results[i]
      );
      if (verdict.boost !== 0) traceTemporal.boostedValidAtT += 1;
    }

    logger.debug(
      `[HybridSearch] Temporal validity (anchored t=${traceTemporal.t}): ` +
      `${kept.length} valid-at-T, ${traceTemporal.excludedInvalidAtT} excluded`
    );

    results = kept;
    results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }

  // LLM reranking: when LLM is enabled and query is meaningful, optionally rerank
  // This is a config-gated enhancement, not the default behavior
  if (config.llmEnabled && effectiveQuery.trim().length > 5) {
    try {
      results = await rerankWithLLM(results, effectiveQuery, limit);
    } catch {
      // LLM reranking failed silently - continue with existing results
      logger.debug('[HybridSearch] LLM reranking failed, using original order');
    }
  }

  // Cross-Encoder Reranking: precision reranking using cross-encoder model
  // Higher quality than LLM reranking, runs locally.
  // Batch 5: default ON (SQUISH_RERANKER_ENABLED=false to disable). When the
  // transformers module is unavailable or the model cannot load within the
  // timeout cap, reranking skips silently and skips are counted in the trace.
  if (precision.reranker && effectiveQuery.trim().length > 5) {
    // Batch 6a evidence: snapshot the pre-rerank order so rerankAgreement can
    // quantify how much the independent reranker agreed with the fused ranking.
    const preRerankTop5 = results.slice(0, 5).map(r => r.id);
    try {
      const reranked = await rerankResults(effectiveQuery, results, {
        topK: config.rerankerTopK,
        returnTopK: limit,
        blendWeight: 0.7,
      });
      // Batch 3: cross-encoder replaces the ranking signal. Fold the delta
      // into boostScore (rerankResidual) so the three-field identity holds.
      results = reranked.map(r => applyReplacement(r, r.similarity ?? 0));
      // Batch 6a: fraction of pre-rerank top-5 preserved post-rerank (order-insensitive overlap).
      const postSet = new Set(results.slice(0, 5).map(r => r.id));
      rerankAgreement = postSet.size > 0
        ? preRerankTop5.filter(id => postSet.has(id)).length / Math.max(1, Math.min(5, results.length))
        : null;
      const rerankMeta = getLastRerankMeta();
      trace.reranker = rerankMeta
        ? { applied: rerankMeta.applied, skipped: rerankMeta.skipped, reason: rerankMeta.reason }
        : { applied: true, skipped: 0 };
      logger.debug(`[HybridSearch] Cross-encoder reranking applied, ${results.length} results`);
    } catch (e) {
      // Cross-encoder reranking failed silently - never blocks search
      rerankAgreement = null;
      trace.reranker = { applied: false, skipped: results.length, reason: String(e) };
      logger.debug(`[HybridSearch] Cross-encoder reranking failed: ${e}`);
    }
  }

  // MMR Diversity: inject diversity to prevent redundant results
  // Batch 3: dedup MUST run after all boost stages so the honest semanticScore
  // is used for dedup decisions (not accumulated boosts which could skew).
  if (results.length > 0) {
    results = deduplicateById(results);
  }
  if (config.mmrEnabled && results.length > 0 && queryEmbedding) {
    try {
      // Use pre-computed query embedding (avoids redundant API call)
      // Thread embeddings from vector search for cosine similarity diversity penalty
      const candidateEmbeddings = results.map(r => embeddingMap.get(r.id) ?? null);
      results = smartMMR(queryEmbedding, results, {
        lambda: config.mmrLambda,
        topK: limit,
        candidatePool: 50,
      }, candidateEmbeddings);
      logger.debug(`[HybridSearch] MMR diversity applied, ${results.length} results`);
    } catch (e) {
      // MMR failed silently
      logger.debug(`[HybridSearch] MMR diversity failed: ${e}`);
    }
  }

  // Batch 3: final score semantics. Serving mode decides what `similarity`
  // aliases and which ordering is served:
  //   v2 (default)     -> similarity = finalScore = clamp01(semantic+boost),
  //                       ordered by finalScore
  //   legacy           -> similarity = unclamped composite (exact pre-batch-3
  //                       accumulation), pipeline ordering preserved
  // Shadow (optional, independent) derives both orderings from the same
  // candidate set and records top-5 deltas into a bounded ring.
  const scoringFlags = getScoringFlags();

  if (scoringFlags.shadow && input.query) {
    try {
      recordShadowDelta(deriveShadowDelta(input.query, results));
    } catch {
      // Shadow must never affect serving
    }
  }

  results = finalizeScores(results, scoringFlags.serveV2);

  // Build trace metadata (Phase 8)
  trace.scoringSchemaVersion = SCORING_SCHEMA_VERSION;
  trace.scoringServeMode = scoringFlags.serveV2 ? 'v2' : 'legacy';
  trace.graphBoostMode = graphMode.legacy ? 'legacy' : 'normalized';
  if (scoringFlags.shadow && input.query) {
    try {
      trace.shadowDelta = deriveShadowDelta(input.query, results);
    } catch {
      // Trace diagnostics are best-effort
    }
  }
  trace.finalOrder = results.map(r => r.id);
  trace.finalResultCount = results.length;
  for (const r of results) {
    // memoryId -> served score (finalScore under v2, legacy composite under legacy)
    trace.scoreBreakdown[r.id] = r.similarity ?? 0;
  }

  // Batch 6b: every result leaves with its true corpus identity. Belief-leg
  // rows carry 'belief'; everything else (vector/keyword/graph/multi-hop/
  // association legs) defaults to 'memory'.
  for (const r of results) {
    if (!r.corpus) r.corpus = 'memory';
  }

  // Batch 6a: calibrated recall confidence + itemized evidence.
  // Strictly additive metadata attached AFTER ranking is final; ordering,
  // scores, and result contents are untouched. Evidence collection is
  // best-effort: any failure leaves results unannotated rather than breaking
  // search.
  try {
    // Batch B1: the raw query string is parsed into a topic once per search
    // call and handed to evidence assembly for per-candidate alignment.
    const queryTopic = effectiveQuery ? parseQueryTopic(effectiveQuery) : null;
    const { bestConfidence, bestTier, assessment } = await attachRecallConfidence(results, {
      candidateSemanticScores: results.map(r => (typeof r.semanticScore === 'number' ? r.semanticScore : null)),
      multiSignalQuery: keywordResults.length > 0,
      lexicalRanks,
      rerankAgreement,
      queryTopic,
    });
    trace.recallAssessment = { ...assessment };
    void bestConfidence;
    void bestTier;
  } catch (e) {
    logger.debug(`[HybridSearch] recall-confidence attachment failed: ${e}`);
  }

  // Confidence gating: return empty when nothing relevant is found.
  // This fixes adversarial queries (8.97% -> ~45%+) by not returning tangential content.
  const CONFIDENCE_THRESHOLD = parseFloat(process.env.SQUISH_CONFIDENCE_THRESHOLD || '0.3');
  if (results.length > 0) {
    const maxScore = Math.max(...results.map(r => r.finalScore ?? r.semanticScore ?? r.similarity ?? 0));
    if (maxScore < CONFIDENCE_THRESHOLD) {
      logger.debug(`[HybridSearch] Low confidence (${maxScore.toFixed(3)} < ${CONFIDENCE_THRESHOLD}), returning empty`);
      results = [];
    }
  }

  logger.debug(
    `[HybridSearch] scoring schema=${SCORING_SCHEMA_VERSION} serve=${trace.scoringServeMode}` +
    `${scoringFlags.shadow ? ' shadow=on' : ''}${trace.shadowDelta ? ` overlap=${trace.shadowDelta.overlap}/5` : ''}`
  );

  // Attach trace to results when trace mode is enabled
  if (traceEnabled) {
    for (const r of results) {
      r._trace = trace;
    }
  }

  return results;
}

/**
 * Optional LLM reranking of search results.
 * Uses LLM to score top results against the query.
 * Falls back silently on any error - never blocks search.
 * Limited to top results for performance.
 * Exported for testing.
 */
export async function rerankWithLLM(
  results: SearchResult[],
  query: string,
  limit: number
): Promise<SearchResult[]> {
  const TOP_K = 5; // Only rerank top N results
  const candidates = results.slice(0, TOP_K);

  if (candidates.length < 2) return results;

  // Build a prompt asking LLM to rank by relevance
  const items = candidates
    .map((r, i) => `[${i + 1}] ${(r.content ?? '').slice(0, 200)}`)
    .join('\n\n');

  const prompt = `Given the search query: "${query}"

Rate each result's relevance to the query from 0 (not relevant) to 10 (highly relevant).
Return ONLY a comma-separated list of scores, one per result.

Results:
${items}

Scores:`;

  const response = await callLLM(prompt);
  if (!response) return results;

  // Parse scores: expect comma-separated numbers
  const scoreStrs = response.split(',').map(s => s.trim());
  if (scoreStrs.length !== candidates.length) return results;

  const scores = scoreStrs.map(s => {
    const num = parseFloat(s);
    return isNaN(num) ? 5 : Math.max(0, Math.min(10, num));
  });

  // Blend LLM score with existing similarity (50/50 blend)
  // Batch 3: replacement folds into boostScore as rerankResidual.
  const blended = candidates.map((r, i) =>
    applyReplacement(r, ((r.similarity ?? 0) * 0.5) + ((scores[i] / 10) * 0.5))
  );

  // Sort by blended score, then append remaining results
  blended.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  const remaining = results.slice(TOP_K);
  return [...blended, ...remaining].slice(0, limit);
}
