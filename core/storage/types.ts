/**
 * Storage Facade Types
 *
 * Shared types for the triple-layer storage API.
 */

import type { MemoryRecord, MemoryType } from '../lib/types.js';
import type { GraphNode, GraphEdge, TraversalPath } from '../graph/graph-traversal.js';
import type { RetrievalStrategy } from '../retrieval/query-router.js';

export interface EntityRecord {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties: Record<string, unknown> | null;
}

export interface EntityRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  fromEntityName: string;
  toEntityName: string;
  relationType: string;
  weight: number;
  properties: Record<string, unknown> | null;
}

export interface GraphTraversalResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: TraversalPath[];
}

export interface RecallOptions {
  project?: string;
  limit?: number;
  type?: MemoryType;
  tags?: string[];
  user?: string;
  sessionId?: string;
  strategy?: RetrievalStrategy;
  trace?: boolean;
  referenceDate?: string | Date;
  timeZone?: string;
  latestOnly?: boolean;
  validTimeFrom?: string | Date;
  validTimeTo?: string | Date;
}

export interface FacadeOptions {
  project?: string;
  enableGraph?: boolean;
  enableAutoRoute?: boolean;
}

export interface MemoryFilter {
  type?: MemoryType;
  tags?: string[];
  place?: string;
  limit?: number;
  offset?: number;
  user?: string;
}

export interface SemanticSearchOptions {
  limit?: number;
  minScore?: number;
  includeGraph?: boolean;
  project?: string;
}

export interface SemanticResult {
  memory: MemoryRecord;
  score: number;
  source: 'vector' | 'graph' | 'hybrid';
}

export type EntityInfo = EntityRecord;

export interface RecallResult {
  memories: MemoryRecord[];
  graphEntities?: EntityInfo[];
  routing: {
    intent: string;
    strategy: string;
    confidence: number;
  };
  metadata: {
    totalResults: number;
    durationMs: number;
    sources: string[];
  };
}
