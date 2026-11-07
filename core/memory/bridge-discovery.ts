/**
 * Bridge Discovery
 * Discovers indirect connections between memories through shared associations
 * Uses bidirectional BFS with Dijkstra-style weight prioritization
 * Finds "waypoint" memories that connect otherwise distant memory clusters
 */

import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { getMemoryAssociationRows } from '../associations.js';

export interface BridgePath {
  route: string[]; // Memory IDs in path
  distance: number; // Number of hops
  weight: number; // Sum of association weights
  associationTypes: string[];
}

export interface BridgeMemory {
  memoryId: string;
  memory: any;
  bridgeScore: number; // Betweenness centrality (0-100)
  pathsThrough: number; // Number of shortest paths through this memory
  examplePaths: BridgePath[];
  connectionDensity: number; // How many pairs it connects
  importance: 'critical' | 'major' | 'minor';
}

export interface BridgeOptions {
  maxPathLength?: number; // Maximum hops to search (default 4)
  topBridges?: number; // Number of bridge memories to return (default 10)
  minPathWeight?: number; // Minimum weight to consider (default 1)
  includeExamplePaths?: boolean; // Include detailed paths (default true)
}

/**
 * Discover bridge memories connecting seed memory clusters
 */
export async function discoverBridges(
  seedMemoryIds: string[],
  projectId: string,
  options: BridgeOptions = {}
): Promise<BridgeMemory[]> {
  if (seedMemoryIds.length < 2) {
    return [];
  }

  const maxPathLength = options.maxPathLength ?? 4;
  const topBridges = options.topBridges ?? 10;
  const minPathWeight = options.minPathWeight ?? 1;

  try {
    const db = await getDb();
    const schema = await getSchema();

    // Fetch all associations for this project
    const allMemories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.projectId, projectId));

    const memoriesById = new Map(allMemories.map((m: any) => [m.id, m]));

    const projectMemoryIds = new Set(memoriesById.keys());
    const associations = (await getMemoryAssociationRows()).filter((association) =>
      projectMemoryIds.has(association.fromMemoryId) && projectMemoryIds.has(association.toMemoryId)
    );

    // Build adjacency list graph
    const graph = new Map<string, Array<{ toId: string; weight: number; type: string }>>();

    for (const assoc of associations) {
      if (!graph.has(assoc.fromMemoryId)) {
        graph.set(assoc.fromMemoryId, []);
      }
      const edges = graph.get(assoc.fromMemoryId);
      if (edges) {
        edges.push({
          toId: assoc.toMemoryId,
          weight: assoc.weight || 1,
          type: assoc.associationType,
        });
      }
    }

    // Find all paths between seed memories
    const pathMetrics = new Map<string, { pathsThrough: number; weight: number }>();
    const allPaths: BridgePath[] = [];

    for (let i = 0; i < seedMemoryIds.length; i++) {
      for (let j = i + 1; j < seedMemoryIds.length; j++) {
        const start = seedMemoryIds[i];
        const end = seedMemoryIds[j];

        const paths = findPaths(graph, start, end, maxPathLength, minPathWeight);

        for (const path of paths) {
          // Record intermediate nodes (not start or end)
          for (let k = 1; k < path.route.length - 1; k++) {
            const nodeId = path.route[k];
            if (!pathMetrics.has(nodeId)) {
              pathMetrics.set(nodeId, { pathsThrough: 0, weight: 0 });
            }
            const metrics = pathMetrics.get(nodeId)!;
            metrics.pathsThrough++;
            metrics.weight += path.weight;
          }

          if (options.includeExamplePaths !== false) {
            allPaths.push(path);
          }
        }
      }
    }

    // Calculate bridge scores and convert to BridgeMemory objects
    const bridges: BridgeMemory[] = [];

    for (const [memoryId, metrics] of pathMetrics.entries()) {
      const memory = memoriesById.get(memoryId);
      if (!memory) continue;

      // Calculate betweenness centrality normalized to 0-100
      const bridgeScore = Math.min(
        100,
        (metrics.pathsThrough / (seedMemoryIds.length * (seedMemoryIds.length - 1))) * 1000
      );

      // Calculate connection density: how many unique memories it connects
      const connectedMemories = new Set<string>();
      const neighbors = graph.get(memoryId) || [];
      for (const neighbor of neighbors) {
        connectedMemories.add(neighbor.toId);
      }
      // Include reverse connections
      for (const [fromId, edges] of graph.entries()) {
        for (const edge of edges) {
          if (edge.toId === memoryId && fromId !== memoryId) {
            connectedMemories.add(fromId);
          }
        }
      }

      const connectionDensity = connectedMemories.size / Math.max(1, allMemories.length);

      // Determine importance level
      let importance: 'critical' | 'major' | 'minor';
      if (bridgeScore >= 50) {
        importance = 'critical';
      } else if (bridgeScore >= 20) {
        importance = 'major';
      } else {
        importance = 'minor';
      }

      // Get example paths through this bridge
      const examplePaths = allPaths
        .filter(
          (p) =>
            p.route.includes(memoryId) &&
            p.route.length > 1
        )
        .slice(0, 3);

      bridges.push({
        memoryId,
        memory,
        bridgeScore,
        pathsThrough: metrics.pathsThrough,
        examplePaths,
        connectionDensity: Math.round(connectionDensity * 1000) / 1000,
        importance,
      });
    }

    // Sort by bridge score descending
    bridges.sort((a, b) => b.bridgeScore - a.bridgeScore);

    logger.debug('Bridges discovered', {
      seedMemoryCount: seedMemoryIds.length,
      bridgeCount: bridges.length,
      topBridges: bridges.slice(0, topBridges).map((b) => ({
        id: b.memoryId,
        score: b.bridgeScore,
        importance: b.importance,
      })),
    });

    return bridges.slice(0, topBridges);
  } catch (error) {
    logger.error('Error discovering bridges', error);
    return [];
  }
}

/**
 * Find all shortest paths between two memories up to maxLength
 * Uses BFS with weight-based distance metric
 */
function findPaths(
  graph: Map<string, Array<{ toId: string; weight: number; type: string }>>,
  start: string,
  end: string,
  maxLength: number,
  minWeight: number
): BridgePath[] {
  const paths: BridgePath[] = [];
  const queue: {
    current: string;
    route: string[];
    weight: number;
    types: string[];
  }[] = [{ current: start, route: [start], weight: 0, types: [] }];

  const visited = new Set<string>();

  while (queue.length > 0) {
    const { current, route, weight, types } = queue.shift()!;

    // Stop if we've exceeded max path length
    if (route.length > maxLength) continue;

    // Skip if already visited in shorter path
    const routeKey = route.join('->');
    if (visited.has(routeKey)) continue;
    visited.add(routeKey);

    // Check if we reached the destination
    if (current === end && route.length > 1) {
      paths.push({
        route,
        distance: route.length - 1,
        weight,
        associationTypes: types,
      });
      continue;
    }

    // Explore neighbors
    const neighbors = graph.get(current) || [];

    for (const neighbor of neighbors) {
      // Skip if creating a cycle (except for final destination)
      if (neighbor.toId !== end && route.includes(neighbor.toId)) continue;

      // Skip if weight below threshold
      if (neighbor.weight < minWeight) continue;

      queue.push({
        current: neighbor.toId,
        route: [...route, neighbor.toId],
        weight: weight + neighbor.weight,
        types: [...types, neighbor.type],
      });
    }
  }

  // Sort by weight (distance metric) and keep top paths
  paths.sort((a, b) => b.weight - a.weight);
  return paths.slice(0, 5); // Return top 5 paths
}

/**
 * Get bridge memories for a single memory (find what it connects to)
 */
export async function getMemoryBridges(
  memoryId: string,
  projectId: string,
  topK: number = 5
): Promise<BridgeMemory[]> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    // Find memories connected to this one
    const projectMemories = await (db as any)
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(eq(schema.memories.projectId, projectId));
    const projectMemoryIds = new Set(projectMemories.map((memory: { id: string }) => memory.id));
    if (!projectMemoryIds.has(memoryId)) return [];

    const associations = (await getMemoryAssociationRows([memoryId]))
      .filter((association) => projectMemoryIds.has(association.fromMemoryId) && projectMemoryIds.has(association.toMemoryId));

    if (associations.length === 0) {
      return [];
    }

    // Get connected memory IDs
    const connectedIds = new Set<string>();
    for (const assoc of associations) {
      connectedIds.add(assoc.toMemoryId);
    }

    if (connectedIds.size < 2) {
      return [];
    }

    // Discover bridges between connected memories
    const seedIds = Array.from(connectedIds);
    const bridges = await discoverBridges(seedIds, projectId, { topBridges: topK });

    return bridges;
  } catch (error) {
    logger.error('Error getting memory bridges', error);
    return [];
  }
}

/**
 * Analyze overall network connectivity using bridge metrics
 */
export async function analyzeNetworkConnectivity(
  projectId: string,
  topBridges: number = 20
): Promise<{
  totalMemories: number;
  totalConnections: number;
  averageDegree: number;
  bridgeMemories: BridgeMemory[];
  networkDensity: number;
  clustering: {
    tightClusters: number;
    looseClusters: number;
  };
}> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    // Get all memories
    const allMemories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.projectId, projectId));

    if (allMemories.length < 2) {
      return {
        totalMemories: allMemories.length,
        totalConnections: 0,
        averageDegree: 0,
        bridgeMemories: [],
        networkDensity: 0,
        clustering: { tightClusters: 0, looseClusters: 0 },
      };
    }

    // Get all associations
    const projectMemoryIds = new Set(allMemories.map((memory: { id: string }) => memory.id));
    const associations = (await getMemoryAssociationRows()).filter((association) =>
      projectMemoryIds.has(association.fromMemoryId) && projectMemoryIds.has(association.toMemoryId)
    );

    // Calculate graph metrics
    const degree = new Map<string, number>();
    for (const memory of allMemories) {
      degree.set(memory.id, 0);
    }

    for (const assoc of associations) {
      degree.set(assoc.fromMemoryId, (degree.get(assoc.fromMemoryId) || 0) + 1);
    }

    const avgDegree = Array.from(degree.values()).reduce((a, b) => a + b, 0) / allMemories.length;
    const networkDensity = (associations.length * 2) / (allMemories.length * (allMemories.length - 1));

    // Discover bridges for all memories
    const seedIds = allMemories.slice(0, Math.min(10, allMemories.length)).map((m: any) => m.id);
    const bridges = await discoverBridges(seedIds, projectId, { topBridges });

    // Cluster analysis based on connectivity
    let tightClusters = 0;
    let looseClusters = 0;

    for (const memory of allMemories) {
      const connectionCount = degree.get(memory.id) || 0;
      if (connectionCount > avgDegree * 1.5) {
        tightClusters++;
      } else if (connectionCount < avgDegree * 0.5) {
        looseClusters++;
      }
    }

    return {
      totalMemories: allMemories.length,
      totalConnections: associations.length,
      averageDegree: Math.round(avgDegree * 100) / 100,
      bridgeMemories: bridges,
      networkDensity: Math.round(networkDensity * 10000) / 10000,
      clustering: { tightClusters, looseClusters },
    };
  } catch (error) {
    logger.error('Error analyzing network connectivity', error);
    return {
      totalMemories: 0,
      totalConnections: 0,
      averageDegree: 0,
      bridgeMemories: [],
      networkDensity: 0,
      clustering: { tightClusters: 0, looseClusters: 0 },
    };
  }
}
