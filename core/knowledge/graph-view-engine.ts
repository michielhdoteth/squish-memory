/**
 * Graph View Query Engine
 *
 * BFS traversal of the knowledge_edges table, filtered by view-specific
 * edge types, depth, and weight. Projects the unified edge table into
 * relational subgraphs optimized for specific query patterns.
 */

import { getDbClient } from '../lib/db-client.js';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { ensureKnowledgeTables } from './knowledge-crud.js';
import { toKnowledgeEdge } from './helpers.js';
import { isStrictTrustPolicy, resolveTrustedCallerId } from '../acl/trust-policy.js';
import { denyStrictSurface, writeTrustAudit } from '../acl/trust-audit.js';
import type { KnowledgeEdge, EdgeNodeKind, KnowledgeEdgeAsOf } from './types.js';
import { isSourceBackedKnowledgeEdgeType } from './types.js';
import {
  GRAPH_VIEW_MAX_DEPTH,
  GRAPH_VIEW_MAX_EDGE_SCANS,
  GRAPH_VIEW_MAX_NODES,
  type GraphViewConfig,
  type GraphViewResult,
} from './graph-views.js';

function edgeSupportMemoryIds(edge: KnowledgeEdge): string[] {
  const sources = edge.metadata?.sourceMemoryIds;
  if (Array.isArray(sources)) {
    return [...new Set(sources.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
  }
  const sourceId = edge.metadata?.sourceMemoryId;
  return typeof sourceId === 'string' && sourceId.trim() ? [sourceId] : [];
}

/**
 * Query a graph view starting from a given node.
 *
 * Performs BFS traversal in both directions (incoming and outgoing edges),
 * filtering by the view's edge types, max depth, and minimum weight.
 * Returns a ranked subgraph with nodes and edges.
 */
export async function queryGraphView(
  nodeId: string,
  nodeKind: EdgeNodeKind,
  config: GraphViewConfig,
  asOf: KnowledgeEdgeAsOf = {},
): Promise<GraphViewResult> {
  if (!Number.isInteger(config.maxDepth) || config.maxDepth < 0 || config.maxDepth > GRAPH_VIEW_MAX_DEPTH) {
    throw new Error(`Graph view maxDepth must be an integer between 0 and ${GRAPH_VIEW_MAX_DEPTH}`);
  }

  const strict = isStrictTrustPolicy();
  let callerId: string | null = null;
  if (strict) {
    try {
      callerId = resolveTrustedCallerId();
    } catch {
      await denyStrictSurface(`graph_view:${nodeKind}:${nodeId}`, 'graph_view', 'Strict graph views require a bound caller identity');
    }
    if (!callerId) {
      await denyStrictSurface(`graph_view:${nodeKind}:${nodeId}`, 'graph_view', 'Strict graph views require a bound caller identity');
    }
    if (nodeKind !== 'entity' && nodeKind !== 'knowledge') {
      await denyStrictSurface(`graph_view:${nodeKind}:${nodeId}`, 'graph_view', 'Strict graph views support only source-authorized entity and knowledge traversal');
    }
  }

  const validAt = (asOf.validAt ?? new Date()).getTime();
  const recordedAt = (asOf.recordedAt ?? new Date()).getTime();
  if (!Number.isFinite(validAt) || !Number.isFinite(recordedAt)) {
    throw new Error('Knowledge graph timestamps must be valid dates');
  }
  const snapshot: KnowledgeEdgeAsOf = {
    validAt: new Date(validAt),
    recordedAt: new Date(recordedAt),
  };

  await ensureKnowledgeTables();
  const { db, raw, schema } = await getDbClient();
  const sqlite = (raw as { $client?: { prepare?: (query: string) => { all: (...values: unknown[]) => unknown[] } } }).$client;

  const edgeTypeSet = new Set(config.edgeTypes);
  const authorizationCache = new Map<string, boolean>();
  const visited = new Set<string>();
  visited.add(`${nodeKind}:${nodeId}`);

  interface QueueItem {
    id: string;
    kind: EdgeNodeKind;
    depth: number;
    weight: number;
    edgeType: string;
  }

  const queue: QueueItem[] = [{ id: nodeId, kind: nodeKind, depth: 0, weight: 1.0, edgeType: '' }];
  const resultNodes: Array<{
    id: string;
    kind: EdgeNodeKind;
    weight: number;
    depth: number;
    edgeType: string;
  }> = [];
  const resultEdges: KnowledgeEdge[] = [];
  let scannedEdges = 0;
  let truncated = false;

  while (queue.length > 0 && resultNodes.length < GRAPH_VIEW_MAX_NODES && scannedEdges < GRAPH_VIEW_MAX_EDGE_SCANS) {
    const current = queue.shift()!;

    if (current.depth >= config.maxDepth) continue;

    // Query every hop against one immutable valid/recorded-time snapshot.
    const remainingScans = GRAPH_VIEW_MAX_EDGE_SCANS - scannedEdges;
    const rows: unknown[] = sqlite?.prepare
      ? sqlite.prepare(`
          SELECT * FROM knowledge_edges
          WHERE ((from_id = ? AND from_kind = ?) OR (to_id = ? AND to_kind = ?))
            AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
            AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)
          ORDER BY created_at DESC, id ASC
          LIMIT ?
        `).all(current.id, current.kind, current.id, current.kind, validAt, validAt, recordedAt, recordedAt, remainingScans + 1)
      : await db.select().from(schema.knowledgeEdges).where(and(
        or(
          and(eq(schema.knowledgeEdges.fromId, current.id), eq(schema.knowledgeEdges.fromKind, current.kind)),
          and(eq(schema.knowledgeEdges.toId, current.id), eq(schema.knowledgeEdges.toKind, current.kind)),
        ),
        lte(schema.knowledgeEdges.validFrom, snapshot.validAt),
        or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, snapshot.validAt)),
        lte(schema.knowledgeEdges.recordedAt, snapshot.recordedAt),
        or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, snapshot.recordedAt)),
      )).orderBy(desc(schema.knowledgeEdges.createdAt), asc(schema.knowledgeEdges.id)).limit(remainingScans + 1);
    if (rows.length > remainingScans) truncated = true;
    const boundedRows = rows.slice(0, remainingScans);
    scannedEdges += boundedRows.length;

    let candidateEdges = boundedRows.map((row) => {
      if (sqlite?.prepare) return toKnowledgeEdge(row);
      const edge = row as Record<string, unknown>;
      return toKnowledgeEdge({
        id: edge.id,
        from_id: edge.fromId,
        from_kind: edge.fromKind,
        to_id: edge.toId,
        to_kind: edge.toKind,
        edge_type: edge.edgeType,
        weight: edge.weight,
        metadata: edge.metadata,
        created_at: edge.createdAt,
        valid_from: edge.validFrom,
        valid_to: edge.validTo,
        recorded_at: edge.recordedAt,
        recorded_to: edge.recordedTo,
      });
    });
    candidateEdges = candidateEdges.filter((edge) => edgeTypeSet.has(edge.edgeType) && edge.weight >= config.minWeight);
    // Current reads must stop showing sourced edges outside their support
    // memories' active validity window; explicit snapshots remain historical.
    if (asOf.validAt === undefined && asOf.recordedAt === undefined) {
      const supportIds = [...new Set(candidateEdges.flatMap(edgeSupportMemoryIds))];
      if (supportIds.length > 0) {
        const currentTime = new Date(validAt);
        const activeSources: Array<{ id: string }> = sqlite?.prepare
          ? sqlite.prepare(`
              SELECT id FROM memories
              WHERE id IN (${supportIds.map(() => '?').join(', ')}) AND status = 'active' AND is_active = 1
                AND ${sqlLifecycleBound('valid_from', '<=')}
                AND ${sqlLifecycleBound('valid_to', '>')}
                AND ${sqlLifecycleBound('expires_at', '>')}
            `).all(...supportIds, Math.floor(validAt / 1000), Math.floor(validAt / 1000), Math.floor(validAt / 1000)) as Array<{ id: string }>
          : await db.select({ id: schema.memories.id }).from(schema.memories).where(and(
            inArray(schema.memories.id, supportIds),
            eq(schema.memories.status, 'active'),
            eq(schema.memories.isActive, true),
            or(isNull(schema.memories.validFrom), lte(schema.memories.validFrom, currentTime)),
            or(isNull(schema.memories.validTo), gt(schema.memories.validTo, currentTime)),
            or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, currentTime)),
          ));
        const activeSourceIds = new Set(activeSources.map((source) => source.id));
        candidateEdges = candidateEdges.filter((edge) => {
          const sources = edgeSupportMemoryIds(edge);
          return sources.length === 0 || sources.some((id) => activeSourceIds.has(id));
        });
      }
    }
    if (strict) {
      const entityEdges = candidateEdges.filter((edge) => edge.fromKind === 'entity' && edge.toKind === 'entity');
      const knowledgeRelations = candidateEdges.filter((edge) => edge.fromKind === 'knowledge'
        && edge.toKind === 'knowledge' && isSourceBackedKnowledgeEdgeType(edge.edgeType));
      const unsupportedEdges = candidateEdges.filter((edge) => !entityEdges.includes(edge) && !knowledgeRelations.includes(edge));
      for (const edge of unsupportedEdges) {
        await writeTrustAudit({
          actorId: callerId!,
          resourceId: edge.id,
          assetType: 'knowledge_edge',
          decision: 'deny',
          reason: 'private_default',
        });
      }
      const { filterStrictEntityEdges, filterStrictKnowledgeEdges } = await import('../graph/strict-access.js');
      const authorizedEntityEdges = current.kind === 'entity'
        ? await filterStrictEntityEdges(entityEdges, authorizationCache, callerId!, true, snapshot)
        : [];
      const authorizedKnowledgeEdges = current.kind === 'knowledge'
        ? await filterStrictKnowledgeEdges(knowledgeRelations, authorizationCache, callerId!, snapshot)
        : [];
      candidateEdges = [...authorizedEntityEdges, ...authorizedKnowledgeEdges];
    }

    for (const edge of candidateEdges) {

      if (resultNodes.length >= GRAPH_VIEW_MAX_NODES) {
        truncated = true;
        break;
      }

      // Filter by edge type
      if (!edgeTypeSet.has(edge.edgeType)) continue;

      // Filter by min weight
      if (edge.weight < config.minWeight) continue;

      // Determine the neighbor node (the side that isn't current)
      const isOutgoing = edge.fromId === current.id && edge.fromKind === current.kind;
      const neighborId = isOutgoing ? edge.toId : edge.fromId;
      const neighborKind = isOutgoing ? edge.toKind : edge.fromKind;
      const neighborKey = `${neighborKind}:${neighborId}`;

      // Cycle prevention: skip if already visited
      if (visited.has(neighborKey)) continue;

      visited.add(neighborKey);

      const neighborNode = {
        id: neighborId,
        kind: neighborKind,
        weight: edge.weight,
        depth: current.depth + 1,
        edgeType: edge.edgeType,
      };

      resultNodes.push(neighborNode);
      resultEdges.push(edge);

      queue.push({
        id: neighborId,
        kind: neighborKind,
        depth: current.depth + 1,
        weight: edge.weight,
        edgeType: edge.edgeType,
      });
    }
    if (rows.length > remainingScans) break;
  }
  if (queue.length > 0 && (resultNodes.length >= GRAPH_VIEW_MAX_NODES || scannedEdges >= GRAPH_VIEW_MAX_EDGE_SCANS)) {
    truncated = true;
  }

  // Sort nodes based on config
  if (config.orderBy === 'weight') {
    resultNodes.sort((a, b) => b.weight - a.weight);
  } else {
    // Sort by created_at of the edge
    const edgeMap = new Map<string, KnowledgeEdge>();
    for (const edge of resultEdges) {
      const key = `${edge.fromId}:${edge.fromKind}:${edge.toId}:${edge.toKind}:${edge.edgeType}`;
      edgeMap.set(key, edge);
    }
    resultNodes.sort((a, b) => {
      const edgeA = resultEdges.find(e =>
        (e.fromId === a.id && e.fromKind === a.kind) || (e.toId === a.id && e.toKind === a.kind)
      );
      const edgeB = resultEdges.find(e =>
        (e.fromId === b.id && e.fromKind === b.kind) || (e.toId === b.id && e.toKind === b.kind)
      );
      const timeA = edgeA?.createdAt.getTime() ?? 0;
      const timeB = edgeB?.createdAt.getTime() ?? 0;
      return timeB - timeA; // newest first
    });
  }

  return {
    nodes: resultNodes,
    edges: resultEdges,
    viewType: config.viewType,
    totalNodes: resultNodes.length,
    totalEdges: resultEdges.length,
    ...(truncated ? { truncated: true } : {}),
  };
}
