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

import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { eq, and, or, inArray } from 'drizzle-orm';
import { InMemoryGraphBackend, GraphBackend } from '../graph/backend.js';

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

  try {
    const backend = await getGraphBackend();

    // Batch BFS: run all memory ID traversals in parallel
    const bfsResults = await Promise.all(
      memoryIds.map(async (memoryId) => {
        try {
          const nodes = await backend.bfs(memoryId, maxDepth, minWeight);
          let totalBoost = 0;

          for (const node of nodes) {
            const recencyBonus = calculateRecencyBonus(node.lastAccessedAt);
            const nodeBoost = (node.weight * node.coactivationCount * recencyBonus) / (node.depth + 1);
            totalBoost += nodeBoost;
          }

          // Cap boost at 3.0x to prevent dominance
          const cappedBoost = Math.min(totalBoost, 3.0);
          return { memoryId, boost: Math.max(0, cappedBoost), totalNodes: nodes.length, rawBoost: totalBoost };
        } catch (e: any) {
          logger.warn(`Graph boost calculation failed for ${memoryId}:`, e);
          return { memoryId, boost: 0, totalNodes: 0, rawBoost: 0 };
        }
      })
    );

    for (const result of bfsResults) {
      boostMap.set(result.memoryId, result.boost);
      if (result.totalNodes > 0) {
        logger.debug('Graph boost calculated', {
          memoryId: result.memoryId,
          totalNodes: result.totalNodes,
          rawBoost: result.rawBoost,
          cappedBoost: result.boost,
        });
      }
    }
  } catch (e: any) {
    logger.warn('Graph backend initialization failed, falling back to DB query method:', e);
    // Fallback to original DB-based method
    return calculateGraphBoostFallback(memoryIds, projectId, options);
  }

  return boostMap;
}

/**
 * Fallback method using direct database queries
 * Used when graph backend is not available
 */
async function calculateGraphBoostFallback(
  memoryIds: string[],
  projectId?: string,
  options: { maxDepth?: number; minWeight?: number } = {}
): Promise<Map<string, number>> {
  const { maxDepth = 2, minWeight = 0.3 } = options;
  const boostMap = new Map<string, number>();

  // Batch BFS: run all memory ID traversals in parallel
  const fallbackResults = await Promise.all(
    memoryIds.map(async (memoryId) => {
      try {
        const nodes = await bfsTraverseFallback(memoryId, projectId, maxDepth, minWeight);
        let totalBoost = 0;

        for (const node of nodes) {
          const recencyBonus = calculateRecencyBonus(node.lastAccessedAt);
          const nodeBoost = (node.weight * node.coactivationCount * recencyBonus) / (node.depth + 1);
          totalBoost += nodeBoost;
        }

        const cappedBoost = Math.min(totalBoost, 3.0);
        return { memoryId, boost: Math.max(0, cappedBoost) };
      } catch (e: any) {
        logger.warn(`Graph boost fallback failed for ${memoryId}:`, e);
        return { memoryId, boost: 0 };
      }
    })
  );

  for (const result of fallbackResults) {
    boostMap.set(result.memoryId, result.boost);
  }

  return boostMap;
}

/**
 * BFS traversal of memory association graph (Fallback method)
 * Traverses from start node up to maxDepth, filtering by minimum weight
 * Used when graph backend is not available
 *
 * @param startId - Starting memory ID
 * @param projectId - Optional project ID to filter
 * @param maxDepth - Maximum traversal depth (default: 2)
 * @param minWeight - Minimum edge weight to include (default: 0.3)
 * @returns Array of GraphNode with depth information
 */
async function bfsTraverseFallback(
  startId: string,
  projectId?: string,
  maxDepth: number = 2,
  minWeight: number = 0.3
): Promise<GraphNode[]> {
  const { db, schema } = await getDbClient();
  const visited = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: startId, depth: 0 }];
  const results: GraphNode[] = [];

  while (queue.length > 0) {
    // Batch: collect all nodes at the current BFS level
    const currentBatch = [...queue];
    queue.length = 0;

    // Filter to unvisited nodes and mark them visited
    const levelNodes: { id: string; depth: number }[] = [];
    for (const item of currentBatch) {
      if (!visited.has(item.id) && item.depth <= maxDepth) {
        visited.add(item.id);
        levelNodes.push(item);
      }
    }

    if (levelNodes.length === 0) break;

    try {
      // Batch DB query: fetch ALL associations for ALL nodes in this level at once
      const nodeIds = levelNodes.map(n => n.id);
      const edges = await (db as any)
        .select()
        .from(schema.memoryAssociations)
        .where(
          or(
            inArray(schema.memoryAssociations.fromMemoryId, nodeIds),
            inArray(schema.memoryAssociations.toMemoryId, nodeIds)
          )
        );

      // Also fetch knowledge edges (from LLM consolidation) for these nodes
      let knowledgeEdges: any[] = [];
      try {
        const schemaMod = await import('../../db/drizzle/schema-sqlite.js') as any;
        const keSchema = schemaMod.knowledgeEdges;
        if (keSchema) {
          knowledgeEdges = await (db as any)
          .select()
          .from(keSchema)
          .where(
            or(
              inArray(keSchema.sourceId, nodeIds),
              inArray(keSchema.targetId, nodeIds)
            )
          );
        }
      } catch {
        // knowledge_edges table may not exist yet
      }

      // Knowledge edge type weights (supports=positive, contradicts=negative)
      const KNOWLEDGE_EDGE_WEIGHTS: Record<string, number> = {
        supports: 0.05,
        contradicts: -0.10,
        informed_by: 0.03,
        extends: 0.04,
        related_to: 0.02,
      };

      // Index edges by node ID for O(1) lookup using Set for fast membership tests
      const nodeIdSet = new Set(nodeIds);
      const edgesByNode = new Map<string, typeof edges>();
      for (const edge of edges) {
        // An edge is relevant to a node if the node is either from or to
        if (nodeIdSet.has(edge.fromMemoryId)) {
          const list = edgesByNode.get(edge.fromMemoryId) || [];
          list.push(edge);
          edgesByNode.set(edge.fromMemoryId, list);
        }
        if (nodeIdSet.has(edge.toMemoryId)) {
          const list = edgesByNode.get(edge.toMemoryId) || [];
          list.push(edge);
          edgesByNode.set(edge.toMemoryId, list);
        }
      }

      // Process each node's edges
      for (const current of levelNodes) {
        const nodeEdges = edgesByNode.get(current.id) || [];

        for (const edge of nodeEdges) {
          // Determine the connected memory ID
          const connectedId = edge.fromMemoryId === current.id ? edge.toMemoryId : edge.fromMemoryId;

          // Skip if minimum weight not met
          if (edge.weight < minWeight) {
            continue;
          }

          // Calculate new depth BEFORE adding to results
          const newNodeDepth = current.depth + 1;

          // Skip if new node would exceed maxDepth
          if (newNodeDepth > maxDepth) {
            continue;
          }

          results.push({
            id: connectedId,
            weight: edge.weight,
            depth: newNodeDepth,
            associationType: edge.associationType,
            coactivationCount: edge.coactivationCount || 1,
            lastAccessedAt: edge.lastCoactivatedAt || edge.createdAt || new Date(),
          });

          // Add to queue for further traversal only if not at max depth
          if (newNodeDepth < maxDepth && !visited.has(connectedId)) {
            queue.push({ id: connectedId, depth: newNodeDepth });
          }
        }

        // Also process knowledge edges for this node
        for (const ke of knowledgeEdges) {
          const keSourceId = ke.sourceId;
          const keTargetId = ke.targetId;
          const connectedId = nodeIdSet.has(keSourceId) ? keTargetId : keSourceId;
          const edgeType = ke.edgeType || 'related_to';

          if (nodeIdSet.has(connectedId)) continue; // skip self-loops
          if (visited.has(connectedId)) continue;

          const keWeight = KNOWLEDGE_EDGE_WEIGHTS[edgeType] ?? 0.02;
          if (Math.abs(keWeight) < minWeight) continue;

          const newNodeDepth = current.depth + 1;
          if (newNodeDepth > maxDepth) continue;

          // Knowledge edges use absolute weight for traversal, signed weight for boost
          results.push({
            id: connectedId,
            weight: Math.abs(keWeight),
            depth: newNodeDepth,
            associationType: `knowledge:${edgeType}`,
            coactivationCount: 1,
            lastAccessedAt: ke.createdAt || new Date(),
          });

          if (newNodeDepth < maxDepth && !visited.has(connectedId)) {
            queue.push({ id: connectedId, depth: newNodeDepth });
          }
        }
      }
    } catch (e: any) {
      logger.warn(`Error batch traversing associations:`, e);
    }
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
  projectId?: string,
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

  try {
    const backend = await getGraphBackend();
    await Promise.all(
      memoryIds.map(async (memoryId) => {
        try {
          raw.set(memoryId, sumNodes(await backend.bfs(memoryId, maxDepth, minWeight)));
        } catch (e: any) {
          logger.warn(`Normalized graph boost failed for ${memoryId}:`, e);
          raw.set(memoryId, 0);
        }
      })
    );
  } catch (e: any) {
    logger.warn('Graph backend initialization failed, falling back to DB query method:', e);
    await Promise.all(
      memoryIds.map(async (memoryId) => {
        try {
          const nodes = await bfsTraverseFallback(memoryId, projectId, maxDepth, minWeight);
          raw.set(memoryId, sumNodes(nodes));
        } catch (err: any) {
          logger.warn(`Normalized graph boost fallback failed for ${memoryId}:`, err);
          raw.set(memoryId, 0);
        }
      })
    );
  }

  return { normalized: normalizeGraphBoostMap(raw), raw };
}
