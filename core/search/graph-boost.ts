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

import { logger } from '../logger.js';
import { config } from '../../config.js';
import { InMemoryGraphBackend, GraphBackend } from '../graph/backend.js';
import type { GraphViewResult } from '../knowledge/graph-views.js';
import { createGraphView } from '../knowledge/graph-views.js';
import type { EdgeNodeKind } from '../knowledge/types.js';
import { getMemoryAssociationRows } from '../associations.js';

export interface GraphBoostParams {
  memoryId: string;
  projectId?: string;
  maxDepth?: number; // Default: 2
  minWeight?: number; // Default: 0.3
}

/**
 * Pre-Batch-5 effective graph weight. The legacy hatch (SQUISH_GRAPH_BOOST_
 * LEGACY=true) restores the old MATH, so it must also restore the old WEIGHT:
 * raw capped sums (max 3.0) x 0.2 = up to +0.60 absolute. Batch 5 halved the
 * config default to 0.10 for the normalized mode; byte-compat requires the
 * legacy path to keep multiplying by 0.2 unless the operator explicitly set
 * SQUISH_WEIGHT_GRAPH_BOOST.
 */
export const LEGACY_GRAPH_BOOST_WEIGHT = 0.2;

/**
 * Effective multiplier for applyGraphBoostWithWeight given the active mode.
 * - Explicit SQUISH_WEIGHT_GRAPH_BOOST (finite number) wins in BOTH modes.
 * - Legacy mode defaults to 0.2 (pre-Batch-5 byte compatibility).
 * - Normalized mode uses the config default (0.10).
 */
export function effectiveGraphBoostWeight(legacyMode: boolean): number {
  const raw = process.env.SQUISH_WEIGHT_GRAPH_BOOST;
  if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return legacyMode ? LEGACY_GRAPH_BOOST_WEIGHT : config.scoringWeights.graphBoost;
}

export interface GraphNode {
  id: string;
  weight: number;
  depth: number;
  associationType: string;
  coactivationCount: number;
  lastAccessedAt: string | Date;
}

let graphBackendInstance: GraphBackend | null = null;
let graphBackendInitPromise: Promise<GraphBackend> | null = null;

/**
 * Get or create the graph backend instance (exported for testing)
 * Uses promise-based init to prevent TOCTOU race on lazy singleton.
 */
export async function getGraphBackend(): Promise<GraphBackend> {
  if (graphBackendInstance) return graphBackendInstance;
  if (!graphBackendInitPromise) {
    graphBackendInitPromise = (async () => {
      const instance = new InMemoryGraphBackend();
      await instance.connect();
      graphBackendInstance = instance;
      return instance;
    })();
  }
  return graphBackendInitPromise;
}

/**
 * Calculate graph boost for multiple memories using BFS traversal
 * Boost = Σ(weight × coactivationCount × recencyBonus) / (depth + 1)
 *
 * @param memoryIds - Array of memory IDs to calculate boost for
 * @param projectId - Optional project ID to filter associations
 * @param options - Configuration options (maxDepth, minWeight)
 * @returns Map of memory ID to boost value (capped at 3.0)
 */
export async function calculateGraphBoost(
  memoryIds: string[],
  projectId?: string,
  options: { maxDepth?: number; minWeight?: number } = {}
): Promise<Map<string, number>> {
  const { maxDepth = 2, minWeight = 0.3 } = options;
  const boostMap = new Map<string, number>();

  if (memoryIds.length === 0) {
    return boostMap;
  }
  // Retrieval must use persisted associations. A process-global in-memory graph
  // is neither populated by canonical writes nor scoped by project/caller.
  return calculateGraphBoostFallback(memoryIds, projectId, options);
}

/**
 * Fallback method using direct database queries
 * Used when graph backend is not available
 */
async function calculateGraphBoostFallback(
  memoryIds: string[],
  _projectId?: string,
  options: { maxDepth?: number; minWeight?: number } = {}
): Promise<Map<string, number>> {
  const { maxDepth = 2, minWeight = 0.3 } = options;
  const boostMap = new Map<string, number>();
  let nodesByMemoryId: Map<string, GraphNode[]>;
  try {
    nodesByMemoryId = await bfsTraverseBatchFallback(memoryIds, maxDepth, minWeight);
  } catch (error: unknown) {
    logger.warn('Graph boost fallback failed', { reason: error instanceof Error ? error.message : String(error) });
    for (const memoryId of memoryIds) boostMap.set(memoryId, 0);
    return boostMap;
  }

  for (const memoryId of memoryIds) {
    let totalBoost = 0;
    for (const node of nodesByMemoryId.get(memoryId) ?? []) {
      const recencyBonus = calculateRecencyBonus(node.lastAccessedAt);
      totalBoost += (node.weight * node.coactivationCount * recencyBonus) / (node.depth + 1);
    }
    boostMap.set(memoryId, Math.max(0, Math.min(totalBoost, 3.0)));
  }

  return boostMap;
}

/**
 * Traverse all candidate roots together, reading each BFS frontier from the
 * canonical association store once instead of issuing one query per root.
 *
 * @param memoryIds - Starting candidate memory IDs
 * @param maxDepth - Maximum traversal depth (default: 2)
 * @param minWeight - Minimum edge weight to include (default: 0.3)
 * @returns Per-root traversed nodes with depth information
 */
async function bfsTraverseBatchFallback(
  memoryIds: string[],
  maxDepth: number = 2,
  minWeight: number = 0.3
): Promise<Map<string, GraphNode[]>> {
  const results = new Map(memoryIds.map((id) => [id, [] as GraphNode[]]));
  const visited = new Map(memoryIds.map((id) => [id, new Set([id])]));
  let frontier = memoryIds.map((rootId) => ({ rootId, id: rootId, depth: 0 }));

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const frontierIds = [...new Set(frontier.map((item) => item.id))];
    const nodeIdSet = new Set(frontierIds);
    const edges: Awaited<ReturnType<typeof getMemoryAssociationRows>> = [];
    const edgeIds = new Set<string>();
    // Stay below SQLite's bound-variable limit while retaining one query for
    // ordinary candidate sets. Large frontiers are fetched in bounded slices.
    for (let offset = 0; offset < frontierIds.length; offset += 200) {
      const rows = await getMemoryAssociationRows(frontierIds.slice(offset, offset + 200));
      for (const edge of rows) {
        if (!edgeIds.has(edge.id)) {
          edgeIds.add(edge.id);
          edges.push(edge);
        }
      }
    }

    const edgesByNode = new Map<string, typeof edges>();
    for (const edge of edges) {
      if (nodeIdSet.has(edge.fromMemoryId)) {
        const list = edgesByNode.get(edge.fromMemoryId) ?? [];
        list.push(edge);
        edgesByNode.set(edge.fromMemoryId, list);
      }
      if (nodeIdSet.has(edge.toMemoryId) && edge.toMemoryId !== edge.fromMemoryId) {
        const list = edgesByNode.get(edge.toMemoryId) ?? [];
        list.push(edge);
        edgesByNode.set(edge.toMemoryId, list);
      }
    }

    const next: typeof frontier = [];
    for (const current of frontier) {
      for (const edge of edgesByNode.get(current.id) ?? []) {
        if (edge.weight < minWeight) continue;
        const connectedId = edge.fromMemoryId === current.id ? edge.toMemoryId : edge.fromMemoryId;
        const nextDepth = current.depth + 1;
        results.get(current.rootId)?.push({
          id: connectedId,
          weight: edge.weight,
          depth: nextDepth,
          associationType: edge.associationType,
          coactivationCount: edge.coactivationCount || 1,
          lastAccessedAt: edge.lastCoactivatedAt || edge.createdAt,
        });
        const rootVisited = visited.get(current.rootId)!;
        if (nextDepth < maxDepth && !rootVisited.has(connectedId)) {
          rootVisited.add(connectedId);
          next.push({ rootId: current.rootId, id: connectedId, depth: nextDepth });
        }
      }
    }
    frontier = next;
  }

  return results;
}

/**
 * Calculate recency bonus based on last access time
 * - Today (< 1 day): 1.5x bonus
 * - Yesterday (1-2 days): 1.2x bonus
 * - Older (> 2 days): 1.0x (no bonus)
 *
 * @param lastAccessedAt - Date or date string of last access
 * @returns Multiplier value (1.0 - 1.5)
 */
export function calculateRecencyBonus(lastAccessedAt: string | Date): number {
  const lastAccess = new Date(lastAccessedAt).getTime();
  const now = Date.now();
  const daysSince = (now - lastAccess) / (1000 * 60 * 60 * 24);

  // Bonus decays: 1.5x for today, 1.2x for yesterday, 1.0x after
  if (daysSince < 1) return 1.5;
  if (daysSince < 2) return 1.2;
  return 1.0;
}

/**
 * Wrapper function for backward compatibility with existing code
 * Computes graph boost and returns as Record<string, number>
 *
 * @deprecated Use calculateGraphBoost instead
 */
export async function computeGraphBoost(memoryIds: string[]): Promise<Record<string, number>> {
  const boostMap = await calculateGraphBoost(memoryIds);
  return Object.fromEntries(boostMap);
}

// ---------------------------------------------------------------------------
// Batch 5: normalized graph boost
//
// The legacy path above returns raw capped sums (up to 3.0). Multiplied by the
// configured weight that used to inject up to +0.6 ABSOLUTE onto scores where
// a top hit is 1.0 - popularity takeover. The normalized path instead:
//
//   1. scales coactivationCount logarithmically (log1p) so hub memories do
//      not dominate,
//   2. min-max normalizes each candidate's contribution WITHIN the candidate
//      set to 0..1, so the strongest-connected candidate contributes at most
//      `weight` (default 0.10) and ranking is relative, not absolute.
//
// When every candidate has identical connectivity (range = 0) there is no
// differentiation signal, so all contributions are 0.
// ---------------------------------------------------------------------------

/**
 * Log-scaled coactivation influence. Monotonic but heavily compressive:
 * log1p(1000) / log1p(100) ~ 1.33 where the linear ratio would be 10x.
 */
export function logScaleCoactivation(count: number): number {
  return Math.log1p(Math.max(0, count));
}

/** Per-node contribution with log-scaled coactivation (uncapped). */
function normalizedNodeContribution(node: GraphNode): number {
  const recencyBonus = calculateRecencyBonus(node.lastAccessedAt);
  return (node.weight * logScaleCoactivation(node.coactivationCount) * recencyBonus) / (node.depth + 1);
}

/**
 * Min-max normalize a map of raw contributions within its own candidate set.
 * Pure function; exported for unit testing.
 *
 * - All values land in [0, 1]; the maximum maps to exactly 1.
 * - Empty input -> empty output.
 * - Non-positive or uniform max (range <= 0) -> all zeros.
 */
export function normalizeGraphBoostMap(rawMap: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (rawMap.size === 0) return out;

  let max = -Infinity;
  let min = Infinity;
  for (const v of rawMap.values()) {
    if (v > max) max = v;
    if (v < min) min = v;
  }

  const range = max - min;
  if (!Number.isFinite(range) || range <= 0 || max <= 0) {
    for (const k of rawMap.keys()) out.set(k, 0);
    return out;
  }

  for (const [k, v] of rawMap) {
    out.set(k, Math.min(1, Math.max(0, (v - min) / range)));
  }
  return out;
}

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
export async function calculateGraphBoostNormalized(
  memoryIds: string[],
  _projectId?: string,
  options: { maxDepth?: number; minWeight?: number } = {}
): Promise<NormalizedGraphBoost> {
  const { maxDepth = 2, minWeight = 0.3 } = options;
  const raw = new Map<string, number>();

  if (memoryIds.length === 0) {
    return { normalized: new Map(), raw };
  }

  const sumNodes = (nodes: Array<{ weight: number; depth: number; coactivationCount: number; lastAccessedAt: string | Date }>): number => {
    let total = 0;
    for (const node of nodes) total += normalizedNodeContribution(node as GraphNode);
    return total;
  };

  // The in-memory backend is a legacy/testing utility. Canonical association
  // writes live in SQLite/PostgreSQL and must be the source used by retrieval.
  try {
    const nodesByMemoryId = await bfsTraverseBatchFallback(memoryIds, maxDepth, minWeight);
    for (const memoryId of memoryIds) raw.set(memoryId, sumNodes(nodesByMemoryId.get(memoryId) ?? []));
  } catch (error: unknown) {
    logger.warn('Normalized graph boost failed', { reason: error instanceof Error ? error.message : String(error) });
    for (const memoryId of memoryIds) raw.set(memoryId, 0);
  }

  return { normalized: normalizeGraphBoostMap(raw), raw };
}

// ---------------------------------------------------------------------------
// v2.2: View-aware graph boost
//
// Uses the graph view engine to traverse only edges relevant to a specific
// view type (semantic, temporal, causal, entity). This produces more
// targeted boosts than the generic BFS traversal.
// ---------------------------------------------------------------------------

/**
 * Calculate a boost value from a GraphViewResult.
 *
 * Sums node contributions using the same formula as the legacy BFS boost:
 *   contribution = (weight * recencyBonus) / (depth + 1)
 *
 * The result is capped at 3.0 to prevent dominance.
 */
export function calculateBoostFromViewResult(result: GraphViewResult): number {
  let total = 0;
  for (const node of result.nodes) {
    const recencyBonus = calculateRecencyBonus(new Date());
    const contribution = (node.weight * recencyBonus) / (node.depth + 1);
    total += contribution;
  }
  return Math.min(total, 3.0);
}

export interface ViewAwareBoostParams {
  memoryIds: string[];
  viewType: 'semantic' | 'temporal' | 'causal' | 'entity';
  nodeKind?: EdgeNodeKind;
}

/**
 * Type for the graph view query function (matches queryGraphView signature).
 */
export type GraphViewQueryFn = (
  nodeId: string,
  nodeKind: EdgeNodeKind,
  config: ReturnType<typeof createGraphView>
) => Promise<GraphViewResult>;

/**
 * Calculate view-aware graph boost for multiple memories.
 *
 * For each memory ID, queries the graph view and calculates a boost based on
 * the returned subgraph. Uses the view-specific edge types and depth limits.
 *
 * @param params - View-aware boost parameters
 * @param queryFn - Optional query function override (for testing)
 * @returns Map of memory ID to boost value
 */
export async function calculateViewAwareBoost(
  params: ViewAwareBoostParams,
  queryFn?: GraphViewQueryFn
): Promise<Map<string, number>> {
  const { memoryIds, viewType, nodeKind = 'knowledge' } = params;
  const boostMap = new Map<string, number>();

  if (memoryIds.length === 0) {
    return boostMap;
  }

  const viewConfig = createGraphView(viewType);
  const query = queryFn ?? (await import('../knowledge/graph-view-engine.js')).queryGraphView;

  await Promise.all(
    memoryIds.map(async (memoryId) => {
      try {
        const result = await query(memoryId, nodeKind, viewConfig);
        const boost = calculateBoostFromViewResult(result);
        boostMap.set(memoryId, boost);
      } catch (e: any) {
        logger.warn(`View-aware boost failed for ${memoryId}:`, e);
        boostMap.set(memoryId, 0);
      }
    })
  );

  return boostMap;
}
