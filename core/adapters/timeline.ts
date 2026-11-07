/**
 * Timeline Implementation - 3-Layer Progressive Disclosure
 * 
 * Provides timeline functionality for MCP tool with depth parameter.
 * Layer 1 (index): ~50 tokens - memory titles only
 * Layer 2 (timeline): ~200 tokens - titles + timestamps + tags
 * Layer 3 (detail): ~2000 tokens - full content
 */

import { search as searchMemories, getMemory } from '../memory/memories.js';
import { TimelineDepth } from './types.js';

/** Token estimates per layer */
const LAYER_TOKENS = {
  index: 50,
  timeline: 200,
  detail: 2000,
};

/**
 * Get timeline with progressive disclosure
 */
export async function getTimeline(
  query: string,
  depth: TimelineDepth = 'index',
  limit: number = 10,
  project?: string
): Promise<{
  results: unknown[];
  layer: TimelineDepth;
  tokenEstimate: number;
  query: string;
}> {
  const { getStrictAdapterTimeline } = await import('./strict-access.js');
  const strictResults = await getStrictAdapterTimeline(query, depth, limit);
  if (strictResults) {
    return { results: strictResults, layer: depth, tokenEstimate: strictResults.length * (LAYER_TOKENS[depth] / Math.max(strictResults.length, 1)), query };
  }

  // First get search results
  const memories = await searchMemories({
    query,
    project,
    limit,
  });
  
  // Format based on depth
  let results: unknown[];
  let tokenEstimate = 0;
  
  switch (depth) {
    case 'index':
      results = memories.map(m => ({
        id: m.id,
        title: `${m.type}: ${m.content?.substring(0, 60)}...`,
      }));
      tokenEstimate = results.length * (LAYER_TOKENS.index / Math.max(results.length, 1));
      break;
      
    case 'timeline':
      results = memories.map(m => ({
        id: m.id,
        type: m.type,
        content: m.content?.substring(0, 100),
        tags: m.tags,
        createdAt: m.createdAt,
      }));
      tokenEstimate = results.length * (LAYER_TOKENS.timeline / Math.max(results.length, 1));
      break;
      
    case 'detail':
      results = await Promise.all(
        memories.map(async (m) => {
          const full = await getMemory(m.id);
          return full || { id: m.id, error: 'Not found' };
        })
      );
      tokenEstimate = LAYER_TOKENS.detail;
      break;
  }
  
  return {
    results,
    layer: depth,
    tokenEstimate,
    query,
  };
}

/**
 * Get memory by ID with optional depth
 */
export async function getMemoryTimeline(
  memoryId: string,
  depth: TimelineDepth = 'detail'
): Promise<unknown> {
  const { getStrictAdapterMemoryTimeline } = await import('./strict-access.js');
  const strictResult = await getStrictAdapterMemoryTimeline(memoryId, depth);
  if (strictResult) return strictResult;

  const memory = await getMemory(memoryId);
  
  if (!memory) {
    return { error: 'Memory not found', id: memoryId };
  }
  
  if (depth === 'index') {
    return {
      id: memory.id,
      title: `${memory.type}: ${memory.content?.substring(0, 60)}...`,
    };
  }
  
  if (depth === 'timeline') {
    return {
      id: memory.id,
      type: memory.type,
      content: memory.content?.substring(0, 100),
      tags: memory.tags,
      createdAt: memory.createdAt,
    };
  }
  
  // detail
  return memory;
}
