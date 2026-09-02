/**
 * Graph Boost v2 - BFS-based graph traversal for search result boosting
 *
 * Enhances search recall by 15-30% through graph traversal.
 * Uses BFS to traverse memory associations and calculates boost based on:
 * Boost = Σ(weight × coactivationCount × recencyBonus) / (depth +1)
 *
 * Features:
 * - Configurable max depth (default:2)
 * - Configurable minimum weight filter (default:0.3)
 * - Recency bonus (1.5x today, 1.2x yesterday, 1.0x after)
 * - Boost capping at 3.0x to prevent dominance
 * - Proper error handling and logging
 * - Supports in-memory graph backend
 */
import { GraphBackend } from '../graph/backend.js';
export interface GraphBoostParams {
    memoryId: string;
    projectId?: string;
    maxDepth?: number;
    minWeight?: number;
}
/**
 * Pre-Batch-5 effective graph weight. The legacy hatch (SQUISH_GRAPH_BOOST_
 * LEGACY=true) restores the old MATH, so it must also restore the old WEIGHT:
 * raw capped sums (max 3.0) x 0.2 = up to +0.60 absolute. Batch 5 halved the
 * config default to 0.10 for the normalized mode; byte-compat requires the
 * legacy path to keep multiplying by 0.2 unless the operator explicitly set
 * SQUISH_WEIGHT_GRAPH_BOOST.
 */
export declare const LEGACY_GRAPH_BOOST_WEIGHT = 0.2;
/**
 * Effective multiplier for applyGraphBoostWithWeight given the active mode.
 * - Explicit SQUISH_WEIGHT_GRAPH_BOOST (finite number) wins in BOTH modes.
 * - Legacy mode defaults to 0.2 (pre-Batch-5 byte compatibility).
 * - Normalized mode uses the config default (0.10).
 */
export declare function effectiveGraphBoostWeight(legacyMode: boolean): number;
export interface GraphNode {
    id: string;
    weight: number;
    depth: number;
    associationType: string;
    coactivationCount: number;
    lastAccessedAt: string | Date;
}
/**
 * Get or create the graph backend instance (exported for testing)
 */
export declare function getGraphBackend(): Promise<GraphBackend>;
/**
 * Calculate graph boost for multiple memories using BFS traversal
 * Boost = Σ(weight × coactivationCount × recencyBonus) / (depth + 1)
 *
 * @param memoryIds - Array of memory IDs to calculate boost for
 * @param projectId - Optional project ID to filter associations
 * @param options - Configuration options (maxDepth, minWeight)
 * @returns Map of memory ID to boost value (capped at 3.0)
 */
export declare function calculateGraphBoost(memoryIds: string[], projectId?: string, options?: {
    maxDepth?: number;
    minWeight?: number;
}): Promise<Map<string, number>>;
/**
 * Calculate recency bonus based on last access time
 * - Today (< 1 day): 1.5x bonus
 * - Yesterday (1-2 days): 1.2x bonus
 * - Older (> 2 days): 1.0x (no bonus)
 *
 * @param lastAccessedAt - Date or date string of last access
 * @returns Multiplier value (1.0 - 1.5)
 */
export declare function calculateRecencyBonus(lastAccessedAt: string | Date): number;
/**
 * Wrapper function for backward compatibility with existing code
 * Computes graph boost and returns as Record<string, number>
 *
 * @deprecated Use calculateGraphBoost instead
 */
export declare function computeGraphBoost(memoryIds: string[]): Promise<Record<string, number>>;
/**
 * Log-scaled coactivation influence. Monotonic but heavily compressive:
 * log1p(1000) / log1p(100) ~ 1.33 where the linear ratio would be 10x.
 */
export declare function logScaleCoactivation(count: number): number;
/**
 * Min-max normalize a map of raw contributions within its own candidate set.
 * Pure function; exported for unit testing.
 *
 * - All values land in [0, 1]; the maximum maps to exactly 1.
 * - Empty input -> empty output.
 * - Non-positive or uniform max (range <= 0) -> all zeros.
 */
export declare function normalizeGraphBoostMap(rawMap: Map<string, number>): Map<string, number>;
export interface NormalizedGraphBoost {
    /** Min-max-normalized contributions within the candidate set, all in [0, 1]. */
    normalized: Map<string, number>;
    /** Raw log-scaled contributions before normalization. */
    raw: Map<string, number>;
}
/**
 * Calculate graph boost for a candidate set as an in-set normalized
 * contribution (Batch 5). Same BFS traversal as calculateGraphBoost, but the
 * summed contributions use log-scaled coactivation counts and are never
 * treated as absolute score deltas.
 */
export declare function calculateGraphBoostNormalized(memoryIds: string[], projectId?: string, options?: {
    maxDepth?: number;
    minWeight?: number;
}): Promise<NormalizedGraphBoost>;
//# sourceMappingURL=graph-boost.d.ts.map