/**
 * Walking Interface - Sequential memory retrieval through places
 * 
 * Implements place walking through memory places:
 * - Walk single place to get memories in order
 * - Walk all places for full tour
 * - Token budget handling with TOON compression
 * - Adjacency-aware walking for spatial navigation
 */

import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { getProjectPlaces, type Place, type PlaceType } from './places.js';
import { getPlaceMemories } from './memory-places.js';
import { getMemory, getMemoriesByIds } from '../memory/memories.js';
import { ADJACENT_PLACES, getAdjacentPlaces } from './rules.js';
import { compressForContext, isCompressed } from '../compression.js';
import { logger } from '../logger.js';

export interface WalkOptions {
  tokenBudget?: number;  // Max tokens (default: 170)
  maxMemoriesPerPlace?: number;
  includePurpose?: boolean;
  compressWithCompression?: boolean;
}

export interface WalkResult {
  place: Place;
  memories: MemorySummary[];
  totalTokens: number;
  truncated: boolean;
}

export interface MemorySummary {
  id: string;
  content: string;
  type: string;
  tags: string[];
  createdAt: string;
}

/**
 * Walk through a single place
 */
export async function walkPlace(
  projectId: string,
  placeType: string,
  options: WalkOptions = {}
): Promise<WalkResult | null> {
  const { tokenBudget = 170, maxMemoriesPerPlace = 10, includePurpose = true, compressWithCompression = false } = options;

  // Get the place
  const places = await getProjectPlaces(projectId);
  const place = places.find(p => p.placeType === placeType);
  
  if (!place) {
    logger.warn(`[Walking] Place not found: ${placeType}`);
    return null;
  }

  // Get memory IDs for this place (knowledge_edges stores placeType, not UUID)
  const memoryIds = await getPlaceMemories(place.placeType, maxMemoriesPerPlace);

  // Batch-fetch all memories at once (fixes N+1 query)
  const allMemories = await getMemoriesByIds(memoryIds, false);
  const memoryMap = new Map(allMemories.map(m => [m.id, m]));

  // Get full memories
  const memories: MemorySummary[] = [];
  let totalTokens = 0;

  for (const memoryId of memoryIds) {
    const memory = memoryMap.get(memoryId);
    if (!memory) continue;

    let content = memory.content || '';
    
    // Compress with TOON if requested
    if (compressWithCompression && content) {
      content = compressForContext(content);
    }

    const tokenEstimate = Math.ceil(content.length / 4); // rough token estimate
    
    if (totalTokens + tokenEstimate > tokenBudget) {
      // Would exceed budget - stop adding
      break;
    }

    memories.push({
      id: memory.id,
      content,
      type: memory.type,
      tags: memory.tags || [],
      createdAt: memory.createdAt || '',
    });

    totalTokens += tokenEstimate;
  }

  return {
    place,
    memories,
    totalTokens,
    truncated: memories.length < memoryIds.length,
  };
}

/**
  * Walk through all places in sort order
 */
export async function walkAllPlaces(
  projectId: string,
  options: WalkOptions = {}
): Promise<WalkResult[]> {
  const places = await getProjectPlaces(projectId);
  const results: WalkResult[] = [];

  for (const place of places) {
    const walkResult = await walkPlace(projectId, place.placeType, options);
    if (walkResult && walkResult.memories.length > 0) {
      results.push(walkResult);
    }
  }

  logger.info(`[Walking] Walked ${results.length} places for project ${projectId}`);
  return results;
}

/**
 * Quick tour - just place names and purposes (minimal tokens)
 */
export async function quickTour(projectId: string): Promise<{
  places: { name: string; purpose: string; memoryCount: number }[];
  totalMemories: number;
}> {
  const places = await getProjectPlaces(projectId);
  
  return {
    places: places.map(p => ({
      name: p.name,
      purpose: p.purpose || '',
      memoryCount: p.memoryCount,
    })),
    totalMemories: places.reduce((sum, p) => sum + p.memoryCount, 0),
  };
}

/**
 * Get context summary for a place (for injection)
 */
export async function getPlaceContext(
  projectId: string,
  placeType: string,
  maxTokens: number = 50
): Promise<string> {
  const walkResult = await walkPlace(projectId, placeType, {
    tokenBudget: maxTokens,
    compressWithCompression: true,
  });

  if (!walkResult || walkResult.memories.length === 0) {
    return '';
  }

  const lines = walkResult.memories.map((m, i) => 
    `${i + 1}. [${m.type}] ${m.content.substring(0, 100)}`
  );

  return `## ${walkResult.place.name}\n${lines.join('\n')}`;
}

/**
 * Full context for session start (all places)
 * Skips empty places and redistributes budget to non-empty ones
 */
export async function getFullWalkingContext(
  projectId: string,
  maxTokens: number = 170
): Promise<string> {
  const places = await getProjectPlaces(projectId);
  const nonEmptyPlaces = places.filter(p => p.memoryCount > 0);
  
  if (nonEmptyPlaces.length === 0) {
    return 'No memories yet. Start building your spatial memory!';
  }

  // Distribute budget only among non-empty places
  const budgetPerPlace = Math.floor(maxTokens / nonEmptyPlaces.length);
  
  const results: WalkResult[] = [];
  for (const place of nonEmptyPlaces) {
    const walkResult = await walkPlace(projectId, place.placeType, {
      tokenBudget: budgetPerPlace,
      compressWithCompression: true,
    });
    if (walkResult && walkResult.memories.length > 0) {
      results.push(walkResult);
    }
  }

  if (results.length === 0) {
    return 'No memories yet. Start building your spatial memory!';
  }

  const sections = results.map(r => {
    const lines = r.memories.slice(0, 3).map((m, i) => 
      `  ${i + 1}. ${m.content.substring(0, 60)}...`
    ).join('\n');
    
    return `## ${r.place.name}\n${lines}`;
  });

  return sections.join('\n\n');
}

/**
 * Walk from a starting place, exploring adjacent places if current is empty
 * Implements adjacency-aware walking for spatial navigation
 */
export async function walkFrom(
  projectId: string,
  startPlace: string,
  options: WalkOptions & { maxDepth?: number } = {}
): Promise<WalkResult[]> {
  const { maxDepth = 2, ...walkOptions } = options;
  const results: WalkResult[] = [];
  const visited = new Set<string>();
  
  // BFS-like traversal of adjacency graph
  const queue: Array<{ placeType: string; depth: number }> = [
    { placeType: startPlace, depth: 0 }
  ];
  
  while (queue.length > 0) {
    const { placeType, depth } = queue.shift()!;
    
    // Skip if already visited or beyond max depth
    if (visited.has(placeType) || depth > maxDepth) continue;
    visited.add(placeType);
    
    // Try walking this place
    const walkResult = await walkPlace(projectId, placeType, walkOptions);
    if (walkResult && walkResult.memories.length > 0) {
      results.push(walkResult);
    }
    
    // If place was empty or truncated, explore adjacent places
    if (!walkResult || walkResult.memories.length === 0 || walkResult.truncated) {
      const adjacent = getAdjacentPlaces(placeType as PlaceType);
      for (const adj of adjacent) {
        if (!visited.has(adj) && depth + 1 <= maxDepth) {
          queue.push({ placeType: adj, depth: depth + 1 });
        }
      }
    }
  }
  
  logger.info(`[Walking] walkFrom ${startPlace}: visited ${visited.size} places, found ${results.length} with memories`);
  return results;
}

/**
 * Get a spatial summary of the places system (adjacency graph with memory counts)
 */
export async function getPlacesMap(projectId: string): Promise<{
  places: Array<{
    name: string;
    placeType: string;
    memoryCount: number;
    adjacent: string[];
  }>;
  totalMemories: number;
}> {
  const places = await getProjectPlaces(projectId);
  
  return {
    places: places.map(p => ({
      name: p.name,
      placeType: p.placeType,
      memoryCount: p.memoryCount,
      adjacent: ADJACENT_PLACES[p.placeType] || ['inbox'],
    })),
    totalMemories: places.reduce((sum, p) => sum + p.memoryCount, 0),
  };
}
