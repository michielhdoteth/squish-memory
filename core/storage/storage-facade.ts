/**
 * Storage Facade
 *
 * Unified API over the triple-layer architecture (relational + vector + graph).
 * Composes existing retrieval, graph, and storage primitives behind a single
 * interface. All individual functions also work directly -- this is optional.
 *
 * Three layers:
 *   1. Relational -- SQL-backed CRUD, filtering, temporal queries
 *   2. Vector -- cosine-similarity semantic search, embeddings
 *   3. Graph -- entity relationship traversal, multi-hop retrieval
 */

import { rememberMemory, getMemory, search } from '../memory/memories.js';
import { hybridSearch } from '../memory/hybrid-search.js';
import { multiHopSearch } from '../graph/multi-hop-retrieval.js';
import { autoRoute } from '../retrieval/query-router.js';
import { extractQueryEntities, entityBoost } from '../retrieval/entity-aware-retrieval.js';
import { enrichContent } from '../retrieval/contextual-enrichment.js';
import { searchKnowledge, listKnowledgeByKind, getConnectedEntities, getConnectedPlaces } from '../knowledge/store.js';
import { logger } from '../logger.js';

// Types
import type { RememberInput, SearchInput, SearchResult } from '../memory/memories.js';
import type { MemoryRecord } from '../lib/types.js';
import type {
  FacadeOptions,
  RecallOptions,
  RecallResult,
  SemanticSearchOptions,
  SemanticResult,
  MemoryFilter,
} from './types.js';

// Re-export all types
export type {
  EntityRecord,
  EntityRelation,
  GraphTraversalResult,
  RecallOptions,
  RecallResult,
  FacadeOptions,
  MemoryFilter,
  SemanticSearchOptions,
  SemanticResult,
  EntityInfo,
} from './types.js';

// Re-export sub-modules
export { getEntities, getEntity, getEntityRelationsByName, getProjectEntityList } from './entity-ops.js';
export { getEntityNeighborhood, traverseGraph, findEntityPaths } from './graph-ops.js';

// ─── Core Functions ────────────────────────────────────────────────────────

/** Store a memory. Wraps rememberMemory. */
export async function storeMemory(input: RememberInput): Promise<MemoryRecord> {
  return rememberMemory(input);
}

/** Get a single memory by ID (no access-count increment). */
export async function getMemoryById(id: string): Promise<MemoryRecord | null> {
  return getMemory(id, false);
}

/** Search memories using hybrid vector+keyword search. */
export async function queryMemories(input: SearchInput): Promise<SearchResult[]> {
  return search(input);
}

/** Route a query to the optimal retrieval strategy. */
export async function routeQuery(query: string, options?: { projectId?: string }) {
  return autoRoute(query, options);
}

/** Extract entity names from a query string. */
export function extractEntities(query: string): string[] {
  return extractQueryEntities(query);
}

/** Boost search results based on entity matches. */
export function boostByEntities(results: SearchResult[], queryEntities: string[]): SearchResult[] {
  return entityBoost(results, queryEntities);
}

/** Enrich content with contextual prefix for better embedding. */
export function enrichWith(content: string, options?: { type?: string; project?: string; tags?: string[] }) {
  return enrichContent(content, options);
}

// ─── High-Level Recall ──────────────────────────────────────────────────────

/**
 * High-level recall that routes queries to the optimal strategy.
 * This is the main entry point for retrieval.
 */
export async function recall(
  query: string,
  options: RecallOptions = {}
): Promise<RecallResult> {
  const startTime = Date.now();
  const {
    project,
    limit = 10,
    type,
    tags,
    user,
    sessionId,
    strategy: strategyOverride,
    referenceDate,
    timeZone,
    latestOnly,
    validTimeFrom,
    validTimeTo,
  } = options;

  const routeResult = await autoRoute(query, {
    projectId: project,
    preferGraph: true,
    maxResults: limit,
  });

  const strategy = strategyOverride ?? routeResult.recommendedStrategy;

  const baseInput: SearchInput = { query, type, tags, limit, project, user, sessionId, referenceDate, timeZone, latestOnly, validTimeFrom, validTimeTo };

  let results: SearchResult[] = [];

  switch (strategy) {
    case 'multi_hop': {
      // Graph traversal has no point-in-time or valid-time-window contract.
      // Honor explicit temporal constraints by using the hybrid pipeline,
      // which applies those constraints after candidate injection.
      if (referenceDate !== undefined || timeZone !== undefined || latestOnly === true || validTimeFrom !== undefined || validTimeTo !== undefined) {
        results = await hybridSearch(baseInput, { limit });
        break;
      }
      const multiHop = await multiHopSearch({
        query, project, limit, maxHops: 3,
        includeVectorResults: true, includeGraphResults: true, sessionId,
      });
      results = multiHop as unknown as SearchResult[];
      break;
    }
    case 'entity_aware': {
      const entities = extractQueryEntities(query);
      const raw = await hybridSearch(baseInput, { limit });
      results = entityBoost(raw, entities);
      break;
    }
    case 'contextual': {
      const enriched = enrichContent(query, { type, project, tags });
      results = await hybridSearch({ ...baseInput, query: enriched.enriched || query }, { limit });
      break;
    }
    case 'hybrid_search':
    case 'temporal_validity':
    case 'graph_expanded':
    case 'strategy_first':
    default: {
      results = await hybridSearch(baseInput, { limit });
      break;
    }
  }

  return {
    memories: results as unknown as MemoryRecord[],
    routing: {
      intent: routeResult.classification.intent,
      strategy,
      confidence: routeResult.classification.confidence,
    },
    metadata: {
      totalResults: results.length,
      durationMs: Date.now() - startTime,
      sources: [strategy],
    },
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a StorageFacade instance with bound options.
 * All functions are also exported individually for direct use.
 */
export function createStorageFacade(options: FacadeOptions = {}) {
  return {
    storeMemory,
    getMemoryById,
    queryMemories,

    async searchSemantic(query: string, opts?: SemanticSearchOptions): Promise<SemanticResult[]> {
      const results = await hybridSearch(
        { query, limit: opts?.limit ?? 10, project: opts?.project ?? options.project },
        { limit: opts?.limit ?? 10 }
      );
      return results.map(r => ({
        memory: r as unknown as MemoryRecord,
        score: r.similarity ?? 0,
        source: 'hybrid' as const,
      }));
    },

    getEntity: (name: string, projectId: string) => import('./entity-ops.js').then(m => m.getEntity(name, projectId)),
    traverseGraph: (name: string, projectId: string, opts?: any) => import('./graph-ops.js').then(m => m.traverseGraph(name, projectId, opts)),

    recall: (query: string, opts?: RecallOptions) => recall(query, { ...opts, project: opts?.project ?? options.project }),

    routeQuery,
    extractEntities,
    boostByEntities,
    enrichWith,
  };
}
