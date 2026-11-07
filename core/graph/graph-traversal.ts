/**
 * Graph Traversal Engine
 * 
 * BFS/DFS traversal of the entity relationship graph. This is the
 * core capability that enables multi-hop queries like:
 * 
 *   "Was Alice's project affected by Tuesday's outage?"
 * 
 * Which requires traversing: Alice → works_on → Project Atlas → uses → PostgreSQL → caused → outage
 * 
 * Vector search alone can't answer this because the bridge fact
 * ("Project Atlas uses PostgreSQL") mentions neither Alice nor Tuesday.
 */

import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { getEdgesFrom, getEdgesTo } from '../knowledge/knowledge-edges.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { filterStrictEntityEdges, type StrictGraphEdgeCache } from './strict-access.js';
import type { RelationType } from './llm-entity-extractor.js';

function graphCaller(): string | undefined {
  if (!isStrictTrustPolicy()) return undefined;
  const callerId = resolveTrustedCallerId();
  if (!callerId) throw new TrustBoundaryError('Strict graph access requires an authenticated caller identity');
  return callerId;
}

function graphNode(entity: { id: string; name: string; type: string; description: string | null; properties: unknown }): GraphNode {
  if (isStrictTrustPolicy()) {
    return { id: entity.id, name: entity.name, type: 'entity', description: null, properties: null };
  }
  return {
    id: entity.id,
    name: entity.name,
    type: entity.type,
    description: entity.description,
    properties: entity.properties as GraphNode['properties'],
  };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: Record<string, unknown> | null;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relationType: RelationType | string;
  weight: number;
  properties: Record<string, unknown> | null;
}

export interface TraversalPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalWeight: number;
  hopCount: number;
}

export interface NeighborhoodResult {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  radius: number;
}

// ─── Core Traversal ─────────────────────────────────────────────────────────

/**
 * BFS traversal from a starting entity, following relationship edges.
 * Returns all reachable entities within maxDepth hops.
 */
export async function traverse(
  startEntityId: string,
  options?: {
    maxDepth?: number;
    relationTypes?: RelationType[];
    minWeight?: number;
    direction?: 'outgoing' | 'incoming' | 'both';
    limit?: number;
  }
): Promise<GraphNode[]> {
  const callerId = graphCaller();
  const edgeCache: StrictGraphEdgeCache = new Map();
  const {
    maxDepth = 3,
    relationTypes,
    minWeight = 0,
    direction = 'both',
    limit = 50,
  } = options || {};

  const db = await getDb();
  const schema = await getSchema();
  const visited = new Set<string>([startEntityId]);
  const result: GraphNode[] = [];
  let currentLevel = [startEntityId];

  for (let depth = 0; depth < maxDepth; depth++) {
    if (currentLevel.length === 0) break;

    const nextLevel: string[] = [];

    for (const entityId of currentLevel) {
      // Get connected entities
      const connected = await getConnectedEntities(
        entityId,
        direction,
        relationTypes,
        minWeight,
        callerId,
        edgeCache,
      );

      for (const { id, edge } of connected) {
        if (!visited.has(id)) {
          visited.add(id);
          nextLevel.push(id);

          // Fetch the entity details
          const entity = await (db as any)
            .select()
            .from(schema.entities)
            .where(eq(schema.entities.id, id))
            .limit(1);

          if (entity.length > 0) {
            result.push(graphNode(entity[0]));
          }

          if (result.length >= limit) break;
        }
      }

      if (result.length >= limit) break;
    }

    currentLevel = nextLevel;
  }

  return result;
}

/**
 * Find all paths between two entities within a maximum number of hops.
 * Uses BFS with path tracking.
 */
export async function findPaths(
  fromEntityId: string,
  toEntityId: string,
  options?: {
    maxHops?: number;
    relationTypes?: RelationType[];
    minWeight?: number;
    maxPaths?: number;
  }
): Promise<TraversalPath[]> {
  const callerId = graphCaller();
  const edgeCache: StrictGraphEdgeCache = new Map();
  const {
    maxHops = 4,
    relationTypes,
    minWeight = 0,
    maxPaths = 5,
  } = options || {};

  const db = await getDb();
  const schema = await getSchema();
  const paths: TraversalPath[] = [];

  // BFS with path tracking
  const queue: Array<{ nodeId: string; path: { nodes: GraphNode[]; edges: GraphEdge[]; weight: number } }> = [{
    nodeId: fromEntityId,
    path: { nodes: [], edges: [], weight: 0 },
  }];

  // Start entity
  const startEntity = await (db as any)
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, fromEntityId))
    .limit(1);

  if (startEntity.length === 0) return [];

  const startNode = graphNode(startEntity[0]);

  queue[0].path.nodes.push(startNode);

  while (queue.length > 0 && paths.length < maxPaths) {
    const { nodeId, path } = queue.shift()!;

    if (path.nodes.length > maxHops + 1) continue;

    // Found target
    if (nodeId === toEntityId && path.nodes.length > 1) {
      paths.push({
        nodes: [...path.nodes],
        edges: [...path.edges],
        totalWeight: path.weight,
        hopCount: path.edges.length,
      });
      continue;
    }

    // Get connected entities
    const connected = await getConnectedEntities(
      nodeId,
      'outgoing',
      relationTypes,
      minWeight,
      callerId,
      edgeCache,
    );

    for (const { id, edge } of connected) {
      // Avoid cycles
      if (path.nodes.some(n => n.id === id)) continue;

      // Get entity details
      const entity = await (db as any)
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, id))
        .limit(1);

      if (entity.length === 0) continue;

      const node = graphNode(entity[0]);

      queue.push({
        nodeId: id,
        path: {
          nodes: [...path.nodes, node],
          edges: [...path.edges, edge],
          weight: path.weight + edge.weight,
        },
      });
    }
  }

  // Sort paths by weight (lower is better)
  paths.sort((a, b) => a.totalWeight - b.totalWeight);

  return paths;
}

/**
 * Get the neighborhood around an entity - all entities within N hops.
 * Returns both the entities and the edges connecting them.
 */
export async function getNeighborhood(
  centerEntityId: string,
  options?: {
    radius?: number;
    relationTypes?: RelationType[];
    minWeight?: number;
    limit?: number;
  }
): Promise<NeighborhoodResult | null> {
  const callerId = graphCaller();
  const edgeCache: StrictGraphEdgeCache = new Map();
  const {
    radius = 2,
    relationTypes,
    minWeight = 0,
    limit = 30,
  } = options || {};

  const db = await getDb();
  const schema = await getSchema();

  // Get center entity
  const centerEntity = await (db as any)
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.id, centerEntityId))
    .limit(1);

  if (centerEntity.length === 0) return null;
  if (callerId && (await getConnectedEntities(centerEntityId, 'both', relationTypes, minWeight, callerId, edgeCache)).length === 0) return null;

  const center = graphNode(centerEntity[0]);

  const nodes: GraphNode[] = [center];
  const nodeIds = new Set([centerEntityId]);
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  const visited = new Set<string>([centerEntityId]);
  let currentLevel = [centerEntityId];

  for (let hop = 0; hop < radius; hop++) {
    const nextLevel: string[] = [];

    for (const entityId of currentLevel) {
      const connected = await getConnectedEntities(
        entityId,
        'both',
        relationTypes,
        minWeight,
        callerId,
        edgeCache,
      );

      for (const { id, edge } of connected) {
        if (!visited.has(id)) {
          if (nodes.length >= limit) continue;
          visited.add(id);
          nextLevel.push(id);

          const entity = await (db as any)
            .select()
            .from(schema.entities)
            .where(eq(schema.entities.id, id))
            .limit(1);

          if (entity.length > 0) {
            nodes.push(graphNode(entity[0]));
            nodeIds.add(id);
          }
        }

        if (nodeIds.has(edge.fromId) && nodeIds.has(edge.toId) && !seenEdges.has(edge.id)) {
          seenEdges.add(edge.id);
          edges.push(edge);
        }
      }

      if (nodes.length >= limit) break;
    }

    currentLevel = nextLevel;
    if (nodes.length >= limit) break;
  }

  return { center, nodes, edges, radius };
}

/**
 * Find entities by name (fuzzy matching).
 */
export async function findEntitiesByName(
  name: string,
  projectId: string,
  options?: {
    limit?: number;
    fuzzy?: boolean;
  }
): Promise<GraphNode[]> {
  const callerId = graphCaller();
  const edgeCache: StrictGraphEdgeCache = new Map();
  const { limit = 10, fuzzy = true } = options || {};
  const db = await getDb();
  const schema = await getSchema();

  // Try exact match first
  const exactQuery = (db as any)
    .select()
    .from(schema.entities)
    .where(
      and(
        eq(schema.entities.projectId, projectId),
        eq(schema.entities.name, name)
      )
    );
  const exact = callerId ? await exactQuery : await exactQuery.limit(limit);

  if (exact.length > 0) {
    const visible: GraphNode[] = [];
    for (const entity of exact) {
      if (!callerId || (await getConnectedEntities(entity.id, 'both', undefined, 0, callerId, edgeCache)).length > 0) {
        visible.push(graphNode(entity));
        if (visible.length >= limit) break;
      }
    }
    if (visible.length > 0 || !fuzzy) return visible;
  }

  // Fuzzy match using LIKE
  if (fuzzy) {
    const fuzzyQuery = (db as any)
      .select()
      .from(schema.entities)
      .where(
        and(
          eq(schema.entities.projectId, projectId),
          sql`LOWER(${schema.entities.name}) LIKE LOWER(${'%' + name + '%'})`
        )
      );
    const fuzzyResults = callerId ? await fuzzyQuery : await fuzzyQuery.limit(limit);

    const visible: GraphNode[] = [];
    for (const entity of fuzzyResults) {
      if (!callerId || (await getConnectedEntities(entity.id, 'both', undefined, 0, callerId, edgeCache)).length > 0) {
        visible.push(graphNode(entity));
        if (visible.length >= limit) break;
      }
    }
    return visible;
  }

  return [];
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Get entities connected to a given entity via relations.
 */
async function getConnectedEntities(
  entityId: string,
  direction: 'outgoing' | 'incoming' | 'both',
  relationTypes?: RelationType[],
  minWeight: number = 0,
  callerId?: string,
  edgeCache?: StrictGraphEdgeCache,
): Promise<Array<{ id: string; edge: GraphEdge }>> {
  const results: Array<{ id: string; edge: GraphEdge }> = [];

  const [outgoing, incoming] = await Promise.all([
    direction === 'outgoing' || direction === 'both'
      ? getEdgesFrom(entityId, 'entity')
      : Promise.resolve([]),
    direction === 'incoming' || direction === 'both'
      ? getEdgesTo(entityId, 'entity')
      : Promise.resolve([]),
  ]);
  const trustedEdges = callerId ? await filterStrictEntityEdges([...outgoing, ...incoming], edgeCache, callerId) : [...outgoing, ...incoming];
  const trustedIds = new Set(trustedEdges.map((edge) => edge.id));
  const seen = new Set<string>();
  const append = (rel: Awaited<ReturnType<typeof getEdgesFrom>>[number], neighborId: string) => {
    if (rel.fromKind !== 'entity' || rel.toKind !== 'entity') return;
    if (callerId && !trustedIds.has(rel.id)) return;
    if (rel.weight < minWeight) return;
    if (relationTypes?.length && !relationTypes.includes(rel.edgeType as RelationType)) return;
    if (seen.has(rel.id)) return;
    seen.add(rel.id);
    results.push({
      id: neighborId,
      edge: {
        id: rel.id,
        fromId: rel.fromId,
        toId: rel.toId,
        relationType: rel.edgeType,
        weight: rel.weight,
        properties: rel.metadata,
      },
    });
  };

  for (const relation of outgoing) append(relation, relation.toId);
  for (const relation of incoming) append(relation, relation.fromId);

  return results;
}
