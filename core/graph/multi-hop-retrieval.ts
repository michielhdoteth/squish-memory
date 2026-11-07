/**
 * Multi-Hop Retrieval
 * 
 * Combines vector search with graph traversal to answer queries that
 * require following relationships across entities.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { hybridSearch, type SearchResult } from '../memory/hybrid-search.js';
import { extractEntitiesAndRelations } from './llm-entity-extractor.js';
import { extractEntityNames } from '../memory/entity-extractor.js';
import { findEntitiesByName, getNeighborhood, type GraphNode, type GraphEdge, type NeighborhoodResult, type TraversalPath } from './graph-traversal.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';
import { addBoost } from '../scoring/three-field.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MultiHopResult extends SearchResult {
  /** How this result was found: 'vector' (direct search) or 'graph' (via traversal) */
  retrievalPath: 'vector' | 'graph' | 'both';
  /** The graph path that led to this result (if found via graph) */
  graphPath?: TraversalPath;
  /** Entities that connected this result to the query */
  connectingEntities?: string[];
  /** Hybrid score for backward compatibility */
  hybridScore?: number;
}

export interface MultiHopSearchOptions {
  /** Search query */
  query: string;
  /** Project path for scoping */
  project?: string;
  /** Maximum number of results */
  limit?: number;
  /** Maximum distinct query entities used as graph anchors; defaults to all extracted entities. */
  anchorCount?: number;
  /** Maximum graph traversal depth */
  maxHops?: number;
  /** Whether to include vector-only results */
  includeVectorResults?: boolean;
  /** Whether to include graph-expanded results */
  includeGraphResults?: boolean;
  /** Minimum graph path weight to include */
  minPathWeight?: number;
  /** Session ID for context */
  sessionId?: string;
}

// ─── Main Multi-Hop Search ──────────────────────────────────────────────────

/**
 * Perform multi-hop search combining vector search with graph traversal.
 */
export async function multiHopSearch(
  options: MultiHopSearchOptions
): Promise<MultiHopResult[]> {
  if (isStrictTrustPolicy()) {
    await denyUnscopedGraphOperation('multi_hop_retrieval', options.project ?? 'unscoped');
  }

  const {
    query,
    project,
    limit = 10,
    anchorCount,
    maxHops = 3,
    includeVectorResults = true,
    includeGraphResults = true,
    minPathWeight = 1,
    sessionId,
  } = options;

  const results: MultiHopResult[] = [];
  const seenMemoryIds = new Set<string>();

  // Step 1: Extract query entities (respect global LLM config)
  let queryEntityNames: string[];
  try {
    const extraction = await extractEntitiesAndRelations(query, { preferLLM: config.llmEnabled });
    queryEntityNames = extraction.entities.map(e => e.name);
    logger.debug('Multi-hop search: entity extraction succeeded', {
      query: query.substring(0, 100),
      entities: queryEntityNames,
      source: extraction.source,
    });
  } catch (error) {
    // LLM failed or disabled - fall back to simple keyword extraction
    logger.debug('Multi-hop search: entity extraction failed, falling back to keywords', { error });
    const simpleEntities = extractEntityNames(query);
    queryEntityNames = simpleEntities;
    logger.debug('Multi-hop search: keyword extraction', {
      entities: queryEntityNames,
    });
  }
  if (anchorCount !== undefined) {
    const boundedAnchorCount = Math.max(1, Math.min(10, Math.floor(anchorCount)));
    queryEntityNames = queryEntityNames.slice(0, boundedAnchorCount);
  }

  // Step 2: Vector search (baseline results)
  if (includeVectorResults) {
    const vectorResults = await hybridSearch({
      query,
      project,
      limit: limit * 2, // Get more candidates for reranking
    });

    for (const result of vectorResults) {
      if (!seenMemoryIds.has(result.id)) {
        seenMemoryIds.add(result.id);
        results.push({
          ...result,
          retrievalPath: 'vector',
        });
      }
    }
  }

  // Step 3: Graph expansion (if we have entities)
  if (includeGraphResults && queryEntityNames.length > 0 && project) {
    const graphResults = await expandViaGraph(
      queryEntityNames,
      project,
      maxHops,
      minPathWeight,
      limit
    );

    // Find memories connected to graph-expanded entities. Queries are
    // independent, so run a small bounded batch while preserving candidate
    // order for deterministic deduplication and ranking.
    const expandedMemoriesByEntity = await mapInBatches(
      graphResults,
      GRAPH_MEMORY_SEARCH_BATCH_SIZE,
      (graphResult) => hybridSearch({
        query: graphResult.entityName,
        project,
        limit: 5,
      }),
    );

    for (let index = 0; index < graphResults.length; index++) {
      const graphResult = graphResults[index]!;
      const expandedMemories = expandedMemoriesByEntity[index]!;
      for (const memory of expandedMemories) {
        if (!seenMemoryIds.has(memory.id)) {
          seenMemoryIds.add(memory.id);
          results.push({
            ...memory,
            retrievalPath: 'graph',
            graphPath: graphResult.path,
            connectingEntities: [graphResult.entityName],
          });
        }
      }
    }
  }

  // Step 4: Rank combined results
  // Vector results keep their hybrid score, graph results get a boost
  // for being connected to query entities via the knowledge graph
  const ranked = rankMultiHopResults(results, queryEntityNames);

  return ranked.slice(0, limit);
}

// ─── Graph Expansion ─────────────────────────────────────────────────────────

interface GraphExpansionResult {
  entityName: string;
  entityId: string;
  path: TraversalPath;
  relevanceScore: number;
}

interface ExpansionOptions {
  maxHops: number;
  minPathWeight: number;
  limit: number;
}

type NeighborhoodReader = (
  entityId: string,
  options: { radius: number; minWeight: number; limit: number },
) => Promise<NeighborhoodResult | null>;

const GRAPH_MEMORY_SEARCH_BATCH_SIZE = 3;

/** Run independent graph entity searches in stable, bounded batches. */
export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapItem: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(batchSize));
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const batch = items.slice(offset, offset + size);
    const mapped = await Promise.all(batch.map((item, index) => mapItem(item, offset + index)));
    results.push(...mapped);
  }
  return results;
}

/**
 * Index shortest outgoing paths from one graph neighborhood in a single BFS.
 *
 * `getNeighborhood` already performs the bounded graph walk. Re-running
 * `findPaths` for every returned node repeated that walk once per candidate.
 */
function indexOutgoingPaths(
  neighborhood: NeighborhoodResult,
  maxHops: number,
): Map<string, TraversalPath> {
  const nodes = new Map<string, GraphNode>([
    [neighborhood.center.id, neighborhood.center],
    ...neighborhood.nodes.map(node => [node.id, node] as const),
  ]);
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of neighborhood.edges) {
    const edges = outgoing.get(edge.fromId) ?? [];
    edges.push(edge);
    outgoing.set(edge.fromId, edges);
  }

  const paths = new Map<string, TraversalPath>();
  const visited = new Set<string>([neighborhood.center.id]);
  const queue: Array<{ node: GraphNode; path: TraversalPath }> = [{
    node: neighborhood.center,
    path: { nodes: [neighborhood.center], edges: [], totalWeight: 0, hopCount: 0 },
  }];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (current.path.hopCount >= maxHops) continue;

    for (const edge of outgoing.get(current.node.id) ?? []) {
      if (visited.has(edge.toId)) continue;
      const node = nodes.get(edge.toId);
      if (!node) continue;

      const path: TraversalPath = {
        nodes: [...current.path.nodes, node],
        edges: [...current.path.edges, edge],
        totalWeight: current.path.totalWeight + edge.weight,
        hopCount: current.path.hopCount + 1,
      };
      visited.add(node.id);
      paths.set(node.id, path);
      queue.push({ node, path });
    }
  }

  return paths;
}

/**
 * Collect graph candidates while traversing each unseen anchor once. Exported
 * for focused tests; production passes the guarded graph neighborhood reader.
 */
export async function collectGraphExpansionResults(
  anchors: GraphNode[],
  options: ExpansionOptions,
  readNeighborhood: NeighborhoodReader,
): Promise<GraphExpansionResult[]> {
  const results: GraphExpansionResult[] = [];
  const seenEntities = new Set<string>();
  const neighborhoodLimit = 21; // Same 20 non-anchor candidate bound as traverse().

  for (const anchor of anchors) {
    if (seenEntities.has(anchor.id)) continue;
    seenEntities.add(anchor.id);

    const neighborhood = await readNeighborhood(anchor.id, {
      radius: options.maxHops,
      minWeight: options.minPathWeight,
      limit: neighborhoodLimit,
    });
    if (!neighborhood) continue;

    const paths = indexOutgoingPaths(neighborhood, options.maxHops);
    const neighbors = neighborhood.nodes
      .filter(node => node.id !== neighborhood.center.id)
      .slice(0, 20);
    for (const neighbor of neighbors) {
      if (seenEntities.has(neighbor.id)) continue;
      seenEntities.add(neighbor.id);

      // The neighborhood walks both directions, like traverse(). Preserve the
      // prior behavior of emitting only candidates with an outgoing path from
      // this anchor, as findPaths() did.
      const path = paths.get(neighbor.id);
      if (!path || path.hopCount === 0) continue;

      const relevanceScore = 1 / (1 + path.hopCount) * (1 / (1 + path.totalWeight * 0.1));
      results.push({
        entityName: neighbor.name,
        entityId: neighbor.id,
        path,
        relevanceScore,
      });
    }
  }

  return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, options.limit);
}

/**
 * Expand query entities via the knowledge graph to find related entities.
 */
async function expandViaGraph(
  queryEntityNames: string[],
  project: string,
  maxHops: number,
  minPathWeight: number,
  limit: number
): Promise<GraphExpansionResult[]> {
  const db = await getDb();
  const schema = await getSchema();
  // Get project ID
  const projectRows = await (db as any)
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.path, project))
    .limit(1);

  if (projectRows.length === 0) return [];

  const projectId = projectRows[0].id;

  // Resolve query anchors, then traverse each anchor's bounded neighborhood
  // once. The path index replaces a separate `findPaths` graph walk per node.
  const anchors: GraphNode[] = [];
  for (const entityName of queryEntityNames) {
    const entities = await findEntitiesByName(entityName, projectId, { limit: 3 });
    anchors.push(...entities);
  }

  return collectGraphExpansionResults(anchors, { maxHops, minPathWeight, limit }, (entityId, options) =>
    getNeighborhood(entityId, options));
}

// ─── Result Ranking ──────────────────────────────────────────────────────────

/**
 * Rank multi-hop results combining vector score with graph connectivity.
 */
export function rankMultiHopResults(
  results: MultiHopResult[],
  queryEntityNames: string[]
): MultiHopResult[] {
  return results
    .map(result => {
      const baseScore = result.similarity || 0;
      let score = baseScore;

      // Boost for graph-connected results
      if (result.retrievalPath === 'graph' || result.retrievalPath === 'both') {
        score *= 1.2; // 20% boost for graph connectivity
      }

      // Boost for matching query entities in content
      const contentLower = (result.content || '').toLowerCase();
      for (const entity of queryEntityNames) {
        if (contentLower.includes(entity.toLowerCase())) {
          score *= 1.1; // 10% boost per entity match
        }
      }

      // Boost for shorter graph paths (more direct connections)
      if (result.graphPath) {
        const pathBonus = 1 / (1 + result.graphPath.hopCount * 0.2);
        score *= (1 + pathBonus * 0.15); // Up to 15% bonus for short paths
      }

      // Keep the graph adjustment in the canonical additive score fields.
      // Returning only an inflated `similarity` is lost when hybridSearch
      // initializes/finalizes three-field scores for the combined result set.
      const ranked = addBoost(result, 'multiHopWeight', score - baseScore);
      const roundedScore = Math.round(score * 1000) / 1000;
      return {
        ...ranked,
        similarity: roundedScore,
        hybridScore: Math.round(score * 100) / 100, // Backward compat
      };
    })
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
}

// ─── Utility ────────────────────────────────────────────────────────────────

/** Check if query needs multi-hop graph traversal. */
export function needsMultiHop(query: string): boolean {
  // Queries with relationship indicators benefit from multi-hop
  const relationshipPatterns = [
    /\b(affected by|caused by|related to|connected to|depends? on|works? on|uses?|manages?)\b/i,
    /\b(who|what|which|how)\b.*\b(project|team|system|service|database)\b/i,
    /\b(impact|affect|influence|caus\w+|result|lead to)\b/i,
  ];

  return relationshipPatterns.some(pattern => pattern.test(query));
}

/**
 * Get a human-readable explanation of how a multi-hop result was found.
 */
export function explainRetrievalPath(result: MultiHopResult): string {
  if (result.retrievalPath === 'vector') {
    return `Found via semantic search (score: ${result.similarity?.toFixed(2)})`;
  }

  if (result.retrievalPath === 'graph' && result.graphPath) {
    const pathSteps = result.graphPath.nodes
      .map(n => n.name)
      .join(' → ');
    return `Found via knowledge graph: ${pathSteps} (hops: ${result.graphPath.hopCount})`;
  }

  if (result.retrievalPath === 'both' && result.graphPath) {
    const pathSteps = result.graphPath.nodes
      .map(n => n.name)
      .join(' → ');
    return `Found via both search and graph: ${pathSteps} (score: ${result.similarity?.toFixed(2)})`;
  }

  return `Found via ${result.retrievalPath} search`;
}

// Backward compatibility alias
export const wouldBenefitFromMultiHop = needsMultiHop;
