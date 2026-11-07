/**
 * Graph View Type Definitions and Configurations
 *
 * Projects the unified knowledge_edges table into four relational views:
 * semantic, temporal, causal, and entity. Each view is a filtered, ranked
 * subgraph optimized for a specific query pattern.
 */

import type { KnowledgeEdge, EdgeNodeKind } from './types.js';

// ─── Graph View Types ────────────────────────────────────────────────────────

export type GraphViewType = 'semantic' | 'temporal' | 'causal' | 'entity';

export interface GraphViewConfig {
  viewType: GraphViewType;
  edgeTypes: string[];
  orderBy: 'weight' | 'created_at';
  maxDepth: number;
  minWeight: number;
}

/** Hard runtime ceilings for caller-supplied graph traversal configuration. */
export const GRAPH_VIEW_MAX_DEPTH = 8;
export const GRAPH_VIEW_MAX_NODES = 500;
export const GRAPH_VIEW_MAX_EDGE_SCANS = 2000;

export interface GraphViewResult {
  nodes: Array<{
    id: string;
    kind: EdgeNodeKind;
    weight: number;
    depth: number;
    edgeType: string;
  }>;
  edges: KnowledgeEdge[];
  viewType: GraphViewType;
  totalNodes: number;
  totalEdges: number;
  /** Present when traversal stopped at a configured runtime ceiling. */
  truncated?: boolean;
}

// ─── View Configurations ─────────────────────────────────────────────────────

const VIEW_CONFIGS: Record<GraphViewType, Omit<GraphViewConfig, 'viewType'>> = {
  semantic: {
    edgeTypes: ['related_to', 'supports', 'extends', 'informed_by', 'contradicts', 'rejects'],
    orderBy: 'weight',
    maxDepth: 3,
    minWeight: 0.2,
  },
  temporal: {
    edgeTypes: ['updates', 'supersedes', 'informed_by', 'sourced_from'],
    orderBy: 'created_at',
    maxDepth: 5,
    minWeight: 0.0,
  },
  causal: {
    edgeTypes: ['causes', 'informed_by', 'sourced_from'],
    orderBy: 'weight',
    maxDepth: 4,
    minWeight: 0.1,
  },
  entity: {
    edgeTypes: ['references', 'about', 'describes', 'created_by', 'affects'],
    orderBy: 'weight',
    maxDepth: 2,
    minWeight: 0.2,
  },
};

// ─── Factory Functions ──────────────────────────────────────────────────────

export function createGraphView(type: GraphViewType): GraphViewConfig {
  return { viewType: type, ...VIEW_CONFIGS[type] };
}

export function getSemanticView(): GraphViewConfig {
  return createGraphView('semantic');
}

export function getTemporalView(): GraphViewConfig {
  return createGraphView('temporal');
}

export function getCausalView(): GraphViewConfig {
  return createGraphView('causal');
}

export function getEntityView(): GraphViewConfig {
  return createGraphView('entity');
}
