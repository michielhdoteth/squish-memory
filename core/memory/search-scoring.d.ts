/**
 * Search Scoring Helpers - All scoring/ranking/filtering for hybrid search
 *
 * Includes: RRF fusion, place-aware scoring, tag overlap boost,
 * supersession filtering, session/temporal boosting, graph boost,
 * association expansion, and heuristic scoring.
 */
import type { SearchResult, SearchInput } from './memories.js';
import { type SquishRetrievalConfig, type RetrievalScoringConfig } from '../retrieval/config.js';
import type { SearchDbContext } from './vector-search.js';
/**
 * Itemized heuristic components (Batch 3): recency decay + query-word overlap.
 */
export declare function heuristicComponents(result: SearchResult, query: string, now: number): {
    recency: number;
    entityOverlap: number;
};
/**
 * Score with recency + similarity + entity boost (NO LLM required)
 */
export declare function scoreWithHeuristics(result: SearchResult, query: string, now: number): number;
/**
 * Query memory_places indexed table by placeType with weight threshold
 */
export declare function getMemoryPlacesByType(placeType: string, minWeight: number, limit: number, ctx?: SearchDbContext): Promise<Array<{
    memoryId: string;
    weight: number;
    isPrimary: boolean;
}>>;
/**
 * Query memory_tags indexed table for tag overlap
 */
export declare function getMemoriesByIndexedTags(tags: string[], limit: number, ctx?: SearchDbContext): Promise<Array<{
    memoryId: string;
    tag: string;
}>>;
/**
 * Get IDs of superseded memories to filter from results
 */
export declare function getSupersededMemoryIds(projectId?: string, ctx?: SearchDbContext): Promise<Set<string>>;
export declare function getSupersessionInvalidationMap(projectId?: string, ctx?: SearchDbContext): Promise<Map<string, string | number | null>>;
/**
 * Apply place-aware scoring using indexed memory_places queries.
 * Replaces the old applyPlaceFilterAndBoost for v1.5.0.
 */
export declare function applyMultiPlaceScoring(results: SearchResult[], input: SearchInput, limit: number, retrievalConfig: SquishRetrievalConfig, ctx?: SearchDbContext): Promise<SearchResult[]>;
/**
 * Apply tag overlap boost using indexed memory_tags queries
 */
export declare function applyTagOverlapBoost(results: SearchResult[], queryTags: string[], scoring: RetrievalScoringConfig, ctx?: SearchDbContext): Promise<SearchResult[]>;
/**
 * Filter or penalize superseded memories from results
 * When includeSuperseded=false: filter them out entirely
 * When includeSuperseded=true: include them but apply supersededPenalty
 */
export declare function applySupersessionFilter(results: SearchResult[], projectId: string | undefined, includeSuperseded: boolean, retrievalConfig: SquishRetrievalConfig, ctx?: SearchDbContext): Promise<{
    filtered: SearchResult[];
    supersededCount: number;
}>;
/**
 * Task 3: Boost memories from the same session (temporal)
 */
export declare function applySessionBoost(results: SearchResult[], sessionId: string): SearchResult[];
/**
 * TEMPORAL FIX: Boost memories that contain date references for "when" questions
 * Also boost by date RECENCY - closer to today = higher for temporal queries
 */
export declare function applyTemporalBoost(results: SearchResult[]): SearchResult[];
/**
 * Expand results with directly associated memories.
 * Related memories that are expired/archived (or consolidated sources,
 * unless opts.includeConsolidatedSources) are not pulled in - association
 * expansion must not resurrect rows the SQL legs already exclude.
 */
export declare function expandWithAssociations(results: SearchResult[], limit: number, opts?: {
    includeConsolidatedSources?: boolean;
}): Promise<SearchResult[]>;
/**
 * Apply small graph boost to results
 * Graph boost is ADDITIVE (not dominating)
 */
export declare function applyGraphBoostWithWeight(results: SearchResult[], graphBoostMap: Record<string, number>, limit: number, graphWeight: number): SearchResult[];
//# sourceMappingURL=search-scoring.d.ts.map