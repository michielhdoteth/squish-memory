/**
 * Hybrid Search Orchestrator
 *
 * Coordinates vector search, keyword search, scoring, and ranking.
 * The individual components are in separate modules:
 * - vector-search.ts: Vector similarity search
 * - keyword-search.ts: FTS5 keyword search + RRF fusion
 * - search-scoring.ts: All scoring/ranking/filtering helpers
 *
 * Pipeline architecture (Fix #15):
 * The monolithic hybridSearch function is decomposed into an ordered array
 * of stage functions. Each stage takes a SearchContext and returns the
 * (possibly mutated) context. The orchestrator runs stages sequentially,
 * making the data flow explicit and each stage independently testable.
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

// ---------------------------------------------------------------------------
// SearchContext - mutable pipeline context threaded through all stages
// ---------------------------------------------------------------------------

interface SearchContext {
  // Input / config
  input: SearchInput;
  options: HybridSearchOptions;
  limit: number;
  enableMultiSession: boolean;
  enableHeuristics: boolean;
  traceEnabled: boolean;

  // Precision flags
  precision: ReturnType<typeof getPrecisionStackFlags>;

  // Query processing
  effectiveQuery: string;
  isMultiHop: boolean;
  isTemporal: boolean;

  // Temporal validity v2
  timeRef: ReturnType<typeof parseTimeReference>;
  temporalStageActive: boolean;
  traceTemporal: {
    kind: string;
    t: string | null;
    raw: string | null;
    supersessionRelaxed: boolean;
    excludedInvalidAtT: number;
    boostedValidAtT: number;
  };

  // Query expansion / entity extraction
  queryExpansionEnabled: boolean;
  expandedQueries: string[];
  entityRetrievalEnabled: boolean;
  queryEntities: string[];

  // Embeddings
  isEmptyQuery: boolean;
  queryEmbedding: number[] | null;

  // Database
  searchCtx: SearchDbContext;

  // Trace
  trace: RetrievalTrace;

  // Results flowing through the pipeline
  vectorResults: SearchResult[];
  results: SearchResult[];

  // Embedding map for MMR diversity
  embeddingMap: Map<string, number[] | null>;

  // Lexical ranks for recall confidence (read-only bookkeeping)
  lexicalRanks: Map<string, { rank: number; score: number }>;

  // Rerank agreement fraction (filled by cross-encoder stage)
  rerankAgreement: number | null;
}

// ---------------------------------------------------------------------------
// Helper: query classification (moved from top-level functions)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Context initialization (DB client caching + default flags)
// ---------------------------------------------------------------------------

async function initSearchContext(
  input: SearchInput,
  options: HybridSearchOptions
): Promise<SearchContext> {
  const limit = options.limit ?? input.limit ?? 10;
  const enableMultiSession = options.enableMultiSession !== false;
  const enableHeuristics = options.enableHeuristics !== false;
  const traceEnabled = input.trace === true;

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
  const queryExpansionEnabled = precision.queryExpansion;
  let expandedQueries: string[] = [effectiveQuery];
  if (queryExpansionEnabled && effectiveQuery.trim().length > 0) {
    expandedQueries = expandQuery(effectiveQuery, { enabled: true, maxExpansions: 3 });
    logger.debug(`[HybridSearch] Query expanded to ${expandedQueries.length} variants`);
  }

  // Advanced Retrieval: Entity Extraction
  const entityRetrievalEnabled = process.env.SQUISH_ENTITY_RETRIEVAL === 'true';
  const queryEntities = entityRetrievalEnabled && effectiveQuery
    ? extractQueryEntities(effectiveQuery)
    : [];
  if (queryEntities.length > 0) {
    logger.debug(`[HybridSearch] Extracted ${queryEntities.length} entities: ${queryEntities.join(', ')}`);
  }

  // Pre-compute query embedding once to avoid redundant API calls
  const isEmptyQuery = !effectiveQuery || effectiveQuery.trim() === '';
  const queryEmbedding = isEmptyQuery ? null : await getEmbedding(effectiveQuery);

  // Cache DB client once per search operation (Fix #15: extracted from main function)
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

  return {
    input,
    options,
    limit,
    enableMultiSession,
    enableHeuristics,
    traceEnabled,
    precision,
    effectiveQuery,
    isMultiHop,
    isTemporal,
    timeRef,
    temporalStageActive,
    traceTemporal,
    queryExpansionEnabled,
    expandedQueries,
    entityRetrievalEnabled,
    queryEntities,
    isEmptyQuery,
    queryEmbedding,
    searchCtx,
    trace,
    vectorResults: [],
    results: [],
    embeddingMap: new Map(),
    lexicalRanks: new Map(),
    rerankAgreement: null,
  };
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

/**
 * Vector retrieval stage: run vector search with appropriate strategy
 * (multi-hop expansion, temporal, query expansion, or standard).
 */
async function vectorRetrievalStage(ctx: SearchContext): Promise<SearchContext> {
  try {
    if (ctx.isMultiHop) {
      // Multi-hop: expand for multi-session coverage
      const multiExpansions = buildMultiSessionExpansions(ctx.effectiveQuery);
      const allResults: SearchResult[] = [];

      for (const expQuery of multiExpansions) {
        const expEmbedding = await getEmbedding(expQuery);
        const expResults = await vectorSearch(
          { ...ctx.input, query: expQuery },
          { ...ctx.options, limit: Math.ceil(ctx.limit * 2) },
          expEmbedding,
          ctx.searchCtx
        );
        allResults.push(...expResults);
      }

      ctx.vectorResults = deduplicateById(allResults);
    } else if (ctx.isTemporal) {
      // Temporal: fetch more results
      ctx.vectorResults = await vectorSearch(ctx.input, { ...ctx.options, limit: ctx.limit * 4 }, ctx.queryEmbedding, ctx.searchCtx);
    } else if (ctx.queryExpansionEnabled && ctx.expandedQueries.length > 1) {
      // Advanced Query Expansion: search with expanded queries and merge results
      const allResults: SearchResult[] = [];

      for (const expQuery of ctx.expandedQueries) {
        const expEmbedding = await getEmbedding(expQuery);
        const expResults = await vectorSearch(
          { ...ctx.input, query: expQuery },
          { ...ctx.options, limit: Math.ceil(ctx.limit * 1.5) },
          expEmbedding,
          ctx.searchCtx
        );
        allResults.push(...expResults);
      }

      // Merge results, keeping highest similarity for each memory
      ctx.vectorResults = deduplicateById(allResults);
      ctx.vectorResults.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    } else {
      // Regular query
      ctx.vectorResults = await vectorSearch(ctx.input, { ...ctx.options, limit: ctx.limit * 2 }, ctx.queryEmbedding, ctx.searchCtx);
    }
  } catch (err) {
    logger.warn(`[HybridSearch] Vector search failed, falling back to recency: ${err instanceof Error ? err.message : err}`);
    ctx.vectorResults = [];
  }

  // Record total candidates for trace
  ctx.trace.totalCandidates = ctx.vectorResults.length;

  // Extract embeddings from vector results before they flow through
  // the pipeline (reranking, MMR, etc. may strip hidden properties).
  for (const r of ctx.vectorResults) {
    const emb = (r as any)._embedding;
    if (Array.isArray(emb)) {
      ctx.embeddingMap.set(r.id, emb);
    }
  }

  return ctx;
}

/**
 * Keyword retrieval stage: FTS5 keyword search + optionally belief search.
 * Temporal validity v2: strips temporal relation tokens for past-referencing queries.
 */
async function keywordRetrievalStage(ctx: SearchContext): Promise<SearchContext> {
  // Temporal validity v2: strip relation words for past-referencing queries
  const lexicalQuery =
    ctx.temporalStageActive && ctx.effectiveQuery
      ? stripTemporalRelationTokens(ctx.effectiveQuery)
      : ctx.effectiveQuery;

  const keywordResults = await keywordSearch(
    { ...ctx.input, query: lexicalQuery ?? '' },
    ctx.limit * 2,
    ctx.searchCtx
  );

  // Batch 6b: OPTIONAL third corpus leg - active belief + strategy knowledge
  let beliefResults: SearchResult[] = [];
  if (areBeliefsEnabled() && !ctx.isEmptyQuery && ctx.effectiveQuery.trim().length > 0) {
    try {
      beliefResults = await beliefSearch(ctx.input, Math.ceil(ctx.limit * 2), ctx.searchCtx);
      if (beliefResults.length > 0) {
        logger.debug(`[HybridSearch] Beliefs leg produced ${beliefResults.length} candidate(s)`);
      }
    } catch (e) {
      logger.debug(`[HybridSearch] Beliefs leg failed: ${e}`);
    }
  }

  // Batch 6a evidence: capture the lexical leg's OWN ranking before fusion
  if (keywordResults.length > 0) {
    let maxLex = 0;
    for (const k of keywordResults) maxLex = Math.max(maxLex, k.similarity ?? 0);
    keywordResults.forEach((k, idx) => {
      if (!ctx.lexicalRanks.has(k.id)) {
        ctx.lexicalRanks.set(k.id, { rank: idx + 1, score: maxLex > 0 ? Math.max(0, k.similarity ?? 0) / maxLex : 1 });
      }
    });
  }

  // N-leg RRF fusion: vector + keyword + (optional) beliefs
  if (keywordResults.length > 0 || beliefResults.length > 0) {
    const legs: SearchResult[][] = [ctx.vectorResults];
    if (keywordResults.length > 0) legs.push(keywordResults);
    if (beliefResults.length > 0) legs.push(beliefResults);
    ctx.vectorResults = rrfFusionMulti(legs, ctx.limit * 3);
  }

  // Store keyword results length on context for recall-confidence stage
  (ctx as any)._keywordResultsLength = keywordResults.length;

  return ctx;
}

/**
 * Score initialization stage: freeze semanticScore, init three-field scoring.
 */
async function scoreInitStage(ctx: SearchContext): Promise<SearchContext> {
  ctx.vectorResults = initScoreFields(ctx.vectorResults);
  return ctx;
}

/**
 * Place-aware scoring stage: boost memories matching query's place type.
 */
async function placeScoringStage(ctx: SearchContext): Promise<SearchContext> {
  const retrievalConfig = getRetrievalConfig();
  if (ctx.input.project || ctx.input.placeType) {
    ctx.vectorResults = await applyMultiPlaceScoring(ctx.vectorResults, ctx.input, ctx.limit, retrievalConfig, ctx.searchCtx);
    // Track matched places for trace
    if (ctx.trace.selectedPlace) {
      ctx.trace.matchedPlaces.push(ctx.trace.selectedPlace);
    }
    const adjacentPlaces = getQuestionAdjacentPlaces(ctx.trace.selectedPlace as any);
    ctx.trace.fallbackPlaces = adjacentPlaces;
    if (adjacentPlaces.length > 0) {
      ctx.trace.fallbackUsed = true;
      ctx.trace.matchedPlaces.push(...adjacentPlaces);
    }
  }
  return ctx;
}

/**
 * Tag overlap boost stage: boost memories sharing tags with the query.
 */
async function tagOverlapStage(ctx: SearchContext): Promise<SearchContext> {
  const retrievalConfig = getRetrievalConfig();
  const queryTags = ctx.input.tags ?? [];
  if (queryTags.length > 0) {
    ctx.vectorResults = await applyTagOverlapBoost(ctx.vectorResults, queryTags, retrievalConfig.scoring, ctx.searchCtx);
    ctx.trace.matchedTags = [...queryTags];
  }
  return ctx;
}

/**
 * Session boost stage: boost memories from the same session.
 */
async function sessionBoostStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.input.sessionId) {
    ctx.vectorResults = applySessionBoost(ctx.vectorResults, ctx.input.sessionId);
  }
  return ctx;
}

/**
 * Temporal boost stage: boost results with dates for temporal queries.
 */
async function temporalBoostStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.isTemporal) {
    ctx.vectorResults = applyTemporalBoost(ctx.vectorResults);
  }
  return ctx;
}

/**
 * Heuristic scoring stage: recency decay + entity overlap.
 */
async function heuristicStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.enableHeuristics) {
    const now = Date.now();
    ctx.vectorResults = ctx.vectorResults.map(r => {
      const { recency, entityOverlap } = heuristicComponents(r, ctx.effectiveQuery, now);
      let out = addBoost(r, 'heuristicRecency', recency);
      return addBoost(out, 'heuristicEntityOverlap', entityOverlap);
    });
  }
  return ctx;
}

/**
 * Entity-aware boost stage: boost results sharing entities with the query.
 */
async function entityBoostStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.entityRetrievalEnabled && ctx.queryEntities.length > 0) {
    ctx.vectorResults = entityBoost(ctx.vectorResults, ctx.queryEntities);
    logger.debug(`[HybridSearch] Entity boost applied with ${ctx.queryEntities.length} entities`);
  }
  return ctx;
}

/**
 * Graph boost stage: normalized or legacy mode graph coactivation boost.
 */
async function graphBoostStage(ctx: SearchContext): Promise<SearchContext> {
  const graphMode = getGraphBoostFlags();
  const graphWeight = effectiveGraphBoostWeight(graphMode.legacy);
  const candidateIds = ctx.vectorResults.map(r => r.id);

  if (graphMode.legacy) {
    const graphBoostMap = await computeGraphBoost(candidateIds);
    ctx.results = applyGraphBoostWithWeight(ctx.vectorResults, graphBoostMap, ctx.limit, graphWeight);
  } else {
    const { normalized } = await calculateGraphBoostNormalized(candidateIds);
    ctx.results = applyGraphBoostWithWeight(ctx.vectorResults, Object.fromEntries(normalized), ctx.limit, graphWeight);
  }

  // Store graph mode on context for trace
  (ctx as any)._graphMode = graphMode;

  return ctx;
}

/**
 * Supersession filter stage: filter or penalize superseded memories.
 * Temporal validity v2: relaxes supersession for past-referencing queries.
 */
async function supersessionStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.temporalStageActive) {
    ctx.traceTemporal.supersessionRelaxed = true;
    logger.debug(
      `[HybridSearch] Supersession filter relaxed for ${ctx.timeRef.kind} query`
    );
  } else {
    const retrievalConfig = getRetrievalConfig();
    const { filtered: supersededResults, supersededCount } = await applySupersessionFilter(
      ctx.results, ctx.input.project, retrievalConfig.includeSuperseded, retrievalConfig, ctx.searchCtx
    );
    ctx.trace.supersededFiltered = supersededCount;
    ctx.results = supersededResults;
  }
  return ctx;
}

/**
 * Association expansion stage: expand results with associated memories.
 */
async function associationStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.options.includeAssociations !== false) {
    ctx.results = await expandWithAssociations(ctx.results, ctx.limit, {
      includeConsolidatedSources: ctx.input.includeConsolidatedSources === true,
    });
  }
  return ctx;
}

/**
 * Multi-hop graph traversal stage: actual graph traversal for multi-hop queries.
 */
async function multiHopStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.isMultiHop && ctx.options.enableGraphTraversal !== false && ctx.input.project) {
    try {
      const graphResults = await multiHopSearch({
        query: ctx.effectiveQuery,
        project: ctx.input.project,
        limit: ctx.limit,
        includeVectorResults: false,
        includeGraphResults: true,
      });

      // Merge graph results with vector results
      const existingIds = new Set(ctx.results.map(r => r.id));
      for (const gr of graphResults) {
        if (!existingIds.has(gr.id)) {
          const base = gr.similarity ?? 0;
          const seeded = initScoreFields([{ ...gr, similarity: base }])[0];
          ctx.results.push(addBoost(seeded, 'multiHopWeight', -(base * 0.1)));
        }
      }

      ctx.results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
    } catch (e) {
      logger.debug(`[HybridSearch] Multi-hop failed: ${e}`);
    }
  }
  return ctx;
}

/**
 * Temporal validity v2 stage: enforce validity-at-T for anchored past queries.
 * Placed AFTER every candidate-injecting stage so excluded memories cannot be
 * resurrected, and BEFORE any reranker so the exclusion survives.
 */
async function temporalValidityStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.precision.temporalValidity && ctx.timeRef.kind === 'past-anchored' && ctx.timeRef.t !== null) {
    const invalidationMap = await getSupersessionInvalidationMap(ctx.input.project, ctx.searchCtx);
    const eligibility = applyTemporalEligibility(
      ctx.results.map(r => ({
        createdAt: r.createdAt ?? null,
        supersededAt: invalidationMap.has(r.id) ? invalidationMap.get(r.id) ?? null : null,
      })),
      ctx.timeRef
    );

    const kept: SearchResult[] = [];
    for (let i = 0; i < ctx.results.length; i++) {
      const verdict = eligibility[i];
      if (!verdict.eligible) {
        ctx.traceTemporal.excludedInvalidAtT += 1;
        continue;
      }
      kept.push(
        verdict.boost !== 0 ? addBoost(ctx.results[i], 'temporalValidAtT', verdict.boost) : ctx.results[i]
      );
      if (verdict.boost !== 0) ctx.traceTemporal.boostedValidAtT += 1;
    }

    logger.debug(
      `[HybridSearch] Temporal validity (anchored t=${ctx.traceTemporal.t}): ` +
      `${kept.length} valid-at-T, ${ctx.traceTemporal.excludedInvalidAtT} excluded`
    );

    ctx.results = kept;
    ctx.results.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }
  return ctx;
}

/**
 * LLM reranking stage: optional LLM-based reranking of top results.
 */
async function llmRerankStage(ctx: SearchContext): Promise<SearchContext> {
  if (config.llmEnabled && ctx.effectiveQuery.trim().length > 5) {
    try {
      ctx.results = await rerankWithLLM(ctx.results, ctx.effectiveQuery, ctx.limit);
    } catch {
      logger.debug('[HybridSearch] LLM reranking failed, using original order');
    }
  }
  return ctx;
}

/**
 * Cross-encoder reranking stage: precision reranking using cross-encoder model.
 * Records rerank agreement fraction for recall confidence.
 */
async function crossEncoderRerankStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.precision.reranker && ctx.effectiveQuery.trim().length > 5) {
    const preRerankTop5 = ctx.results.slice(0, 5).map(r => r.id);
    try {
      const reranked = await rerankResults(ctx.effectiveQuery, ctx.results, {
        topK: config.rerankerTopK,
        returnTopK: ctx.limit,
        blendWeight: 0.7,
      });
      ctx.results = reranked.map(r => applyReplacement(r, r.similarity ?? 0));

      // Batch 6a: fraction of pre-rerank top-5 preserved post-rerank
      const postSet = new Set(ctx.results.slice(0, 5).map(r => r.id));
      ctx.rerankAgreement = postSet.size > 0
        ? preRerankTop5.filter(id => postSet.has(id)).length / Math.max(1, Math.min(5, ctx.results.length))
        : null;

      const rerankMeta = getLastRerankMeta();
      ctx.trace.reranker = rerankMeta
        ? { applied: rerankMeta.applied, skipped: rerankMeta.skipped, reason: rerankMeta.reason }
        : { applied: true, skipped: 0 };
      logger.debug(`[HybridSearch] Cross-encoder reranking applied, ${ctx.results.length} results`);
    } catch (e) {
      ctx.rerankAgreement = null;
      ctx.trace.reranker = { applied: false, skipped: ctx.results.length, reason: String(e) };
      logger.debug(`[HybridSearch] Cross-encoder reranking failed: ${e}`);
    }
  }
  return ctx;
}

/**
 * Deduplication stage: remove duplicate results after all boost stages.
 */
async function deduplicationStage(ctx: SearchContext): Promise<SearchContext> {
  if (ctx.results.length > 0) {
    ctx.results = deduplicateById(ctx.results);
  }
  return ctx;
}

/**
 * MMR diversity stage: inject diversity to prevent redundant results.
 */
async function mmrStage(ctx: SearchContext): Promise<SearchContext> {
  if (config.mmrEnabled && ctx.results.length > 0 && ctx.queryEmbedding) {
    try {
      const candidateEmbeddings = ctx.results.map(r => ctx.embeddingMap.get(r.id) ?? null);
      ctx.results = smartMMR(ctx.queryEmbedding, ctx.results, {
        lambda: config.mmrLambda,
        topK: ctx.limit,
        candidatePool: 50,
      }, candidateEmbeddings);
      logger.debug(`[HybridSearch] MMR diversity applied, ${ctx.results.length} results`);
    } catch (e) {
      logger.debug(`[HybridSearch] MMR diversity failed: ${e}`);
    }
  }
  return ctx;
}

/**
 * Final scoring stage: clamp scores, shadow delta recording.
 */
async function finalScoringStage(ctx: SearchContext): Promise<SearchContext> {
  const scoringFlags = getScoringFlags();

  if (scoringFlags.shadow && ctx.input.query) {
    try {
      recordShadowDelta(deriveShadowDelta(ctx.input.query, ctx.results));
    } catch {
      // Shadow must never affect serving
    }
  }

  ctx.results = finalizeScores(ctx.results, scoringFlags.serveV2);

  // Store scoring flags for trace
  (ctx as any)._scoringFlags = scoringFlags;

  return ctx;
}

/**
 * Corpus tagging stage: assign corpus identity to results.
 */
async function corpusTaggingStage(ctx: SearchContext): Promise<SearchContext> {
  for (const r of ctx.results) {
    if (!r.corpus) r.corpus = 'memory';
  }
  return ctx;
}

/**
 * Recall confidence stage: attach calibrated recall confidence + evidence metadata.
 */
async function recallConfidenceStage(ctx: SearchContext): Promise<SearchContext> {
  try {
    const queryTopic = ctx.effectiveQuery ? parseQueryTopic(ctx.effectiveQuery) : null;
    const keywordResultsLength = (ctx as any)._keywordResultsLength ?? 0;
    const { bestConfidence, bestTier, assessment } = await attachRecallConfidence(ctx.results, {
      candidateSemanticScores: ctx.results.map(r => (typeof r.semanticScore === 'number' ? r.semanticScore : null)),
      multiSignalQuery: keywordResultsLength > 0,
      lexicalRanks: ctx.lexicalRanks,
      rerankAgreement: ctx.rerankAgreement,
      queryTopic,
    });
    ctx.trace.recallAssessment = { ...assessment };
    void bestConfidence;
    void bestTier;
  } catch (e) {
    logger.debug(`[HybridSearch] recall-confidence attachment failed: ${e}`);
  }
  return ctx;
}

/**
 * Confidence gating stage: return empty when nothing relevant is found.
 */
async function confidenceGateStage(ctx: SearchContext): Promise<SearchContext> {
  const CONFIDENCE_THRESHOLD = parseFloat(process.env.SQUISH_CONFIDENCE_THRESHOLD || '0.3');
  if (ctx.results.length > 0) {
    const maxScore = Math.max(...ctx.results.map(r => r.finalScore ?? r.semanticScore ?? r.similarity ?? 0));
    if (maxScore < CONFIDENCE_THRESHOLD) {
      logger.debug(`[HybridSearch] Low confidence (${maxScore.toFixed(3)} < ${CONFIDENCE_THRESHOLD}), returning empty`);
      ctx.results = [];
    }
  }
  return ctx;
}

/**
 * Trace finalization stage: build trace metadata and attach to results.
 */
async function traceFinalizationStage(ctx: SearchContext): Promise<SearchContext> {
  const scoringFlags = (ctx as any)._scoringFlags;
  const graphMode = (ctx as any)._graphMode;

  ctx.trace.scoringSchemaVersion = SCORING_SCHEMA_VERSION;
  ctx.trace.scoringServeMode = scoringFlags?.serveV2 ? 'v2' : 'legacy';
  ctx.trace.graphBoostMode = graphMode?.legacy ? 'legacy' : 'normalized';

  if (scoringFlags?.shadow && ctx.input.query) {
    try {
      ctx.trace.shadowDelta = deriveShadowDelta(ctx.input.query, ctx.results);
    } catch {
      // Trace diagnostics are best-effort
    }
  }

  ctx.trace.finalOrder = ctx.results.map(r => r.id);
  ctx.trace.finalResultCount = ctx.results.length;
  for (const r of ctx.results) {
    ctx.trace.scoreBreakdown[r.id] = r.similarity ?? 0;
  }

  logger.debug(
    `[HybridSearch] scoring schema=${SCORING_SCHEMA_VERSION} serve=${ctx.trace.scoringServeMode}` +
    `${scoringFlags?.shadow ? ' shadow=on' : ''}${ctx.trace.shadowDelta ? ` overlap=${ctx.trace.shadowDelta.overlap}/5` : ''}`
  );

  // Attach trace to results when trace mode is enabled
  if (ctx.traceEnabled) {
    for (const r of ctx.results) {
      r._trace = ctx.trace;
    }
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Pipeline definition
// ---------------------------------------------------------------------------

const stages: Array<(ctx: SearchContext) => Promise<SearchContext>> = [
  // Retrieval
  vectorRetrievalStage,
  keywordRetrievalStage,

  // Score initialization
  scoreInitStage,

  // Signal boosts (order matches original)
  placeScoringStage,
  tagOverlapStage,
  sessionBoostStage,
  temporalBoostStage,
  heuristicStage,
  entityBoostStage,
  graphBoostStage,

  // Filtering
  supersessionStage,

  // Candidate injection
  associationStage,
  multiHopStage,

  // Temporal validity (must be after candidate injection, before reranking)
  temporalValidityStage,

  // Reranking
  llmRerankStage,
  crossEncoderRerankStage,

  // Dedup + diversity
  deduplicationStage,
  mmrStage,

  // Final scoring
  finalScoringStage,
  corpusTaggingStage,
  recallConfidenceStage,
  confidenceGateStage,

  // Trace
  traceFinalizationStage,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build multi-session query expansions inline (replaces the removed
 * expandQueryForMultiSession function which overlapped with the
 * general expandQuery from the retrieval module).
 */
function buildMultiSessionExpansions(query: string): string[] {
  const expansions = [query];
  const lower = query.toLowerCase();

  if (lower.includes('when')) {
    expansions.push(query.replace(/when/i, '').trim());
  }
  if (lower.includes('before') || lower.includes('after')) {
    expansions.push(query.replace(/before|after/i, '').trim());
  }
  if (lower.includes('earlier') || lower.includes('later')) {
    expansions.push(query.replace(/earlier|later/i, '').trim());
  }

  if (lower.includes('what') || lower.includes('how')) {
    expansions.push(query + ' mentioned');
    expansions.push(query + ' said');
  }

  return [...new Set(expansions.filter(e => e.length > 2))];
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Main search function - vectors + graph boost + heuristics + places + sessions
 * Unified search integrating Places, Graph, and Memory.
 *
 * Decomposed into a pipeline of named stages (Fix #15). Each stage is a pure
 * function operating on SearchContext. The orchestrator runs them sequentially,
 * making data flow explicit and each stage independently testable.
 */
export async function hybridSearch(
  input: SearchInput,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const ctx = await initSearchContext(input, options);

  for (const stage of stages) {
    await stage(ctx);
  }

  return ctx.results;
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
