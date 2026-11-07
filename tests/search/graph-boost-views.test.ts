import { describe, it, expect } from 'bun:test';
import {
  calculateBoostFromViewResult,
  calculateViewAwareBoost,
  type ViewAwareBoostParams,
} from '../../core/search/graph-boost.js';
import type { GraphViewResult } from '../../core/knowledge/graph-views.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeViewResult(
  nodes: Array<{ id: string; weight: number; depth: number }>,
  viewType: GraphViewResult['viewType'] = 'semantic'
): GraphViewResult {
  return {
    nodes: nodes.map((n) => ({
      ...n,
      kind: 'knowledge' as const,
      edgeType: 'related_to',
    })),
    edges: [],
    viewType,
    totalNodes: nodes.length,
    totalEdges: 0,
  };
}

// ─── calculateBoostFromViewResult ───────────────────────────────────────────

describe('calculateBoostFromViewResult', () => {
  it('returns 0 for an empty result', () => {
    const result = makeViewResult([]);
    expect(calculateBoostFromViewResult(result)).toBe(0);
  });

  it('calculates boost from a single node', () => {
    // weight=0.8, depth=0 -> 0.8 / (0+1) = 0.8
    // recencyBonus for today = 1.5
    // 0.8 * 1.5 = 1.2
    const result = makeViewResult([{ id: 'a', weight: 0.8, depth: 0 }]);
    const boost = calculateBoostFromViewResult(result);
    expect(boost).toBeGreaterThan(0);
    expect(boost).toBeLessThanOrEqual(3.0);
  });

  it('depth penalizes deeper nodes', () => {
    const shallow = makeViewResult([{ id: 'a', weight: 0.8, depth: 0 }]);
    const deep = makeViewResult([{ id: 'a', weight: 0.8, depth: 2 }]);
    expect(calculateBoostFromViewResult(shallow)).toBeGreaterThan(
      calculateBoostFromViewResult(deep)
    );
  });

  it('sums contributions from multiple nodes', () => {
    const single = makeViewResult([{ id: 'a', weight: 0.5, depth: 0 }]);
    const multi = makeViewResult([
      { id: 'a', weight: 0.5, depth: 0 },
      { id: 'b', weight: 0.5, depth: 1 },
    ]);
    expect(calculateBoostFromViewResult(multi)).toBeGreaterThan(
      calculateBoostFromViewResult(single)
    );
  });

  it('caps boost at 3.0', () => {
    const result = makeViewResult([
      { id: 'a', weight: 1.0, depth: 0 },
      { id: 'b', weight: 1.0, depth: 0 },
      { id: 'c', weight: 1.0, depth: 0 },
      { id: 'd', weight: 1.0, depth: 0 },
      { id: 'e', weight: 1.0, depth: 0 },
      { id: 'f', weight: 1.0, depth: 0 },
      { id: 'g', weight: 1.0, depth: 0 },
      { id: 'h', weight: 1.0, depth: 0 },
      { id: 'i', weight: 1.0, depth: 0 },
      { id: 'j', weight: 1.0, depth: 0 },
    ]);
    expect(calculateBoostFromViewResult(result)).toBeLessThanOrEqual(3.0);
  });
});

// ─── calculateViewAwareBoost ────────────────────────────────────────────────

describe('calculateViewAwareBoost', () => {
  it('returns an empty map when no memory IDs are provided', async () => {
    const params: ViewAwareBoostParams = {
      memoryIds: [],
      viewType: 'semantic',
    };
    const result = await calculateViewAwareBoost(params);
    expect(result.size).toBe(0);
  });

  it('calculates boost for each memory using the view query', async () => {
    const mockQuery = async (
      _nodeId: string,
      _nodeKind: string,
      config: { viewType: string; maxDepth: number; minWeight: number }
    ): Promise<GraphViewResult> => {
      // Return different results based on view type
      if (config.viewType === 'semantic') {
        return makeViewResult([{ id: 'neighbor', weight: 0.9, depth: 1 }], 'semantic');
      }
      return makeViewResult([{ id: 'neighbor', weight: 0.5, depth: 1 }], 'temporal');
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['mem1'],
      viewType: 'semantic',
    };

    const result = await calculateViewAwareBoost(params, mockQuery as any);
    expect(result.size).toBe(1);
    expect(result.get('mem1')).toBeGreaterThan(0);
  });

  it('passes the correct view config to the query function', async () => {
    let capturedConfig: any = null;
    const mockQuery = async (
      _nodeId: string,
      _nodeKind: string,
      config: any
    ): Promise<GraphViewResult> => {
      capturedConfig = config;
      return makeViewResult([]);
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['mem1'],
      viewType: 'causal',
    };

    await calculateViewAwareBoost(params, mockQuery as any);
    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig.viewType).toBe('causal');
    expect(capturedConfig.edgeTypes).toContain('causes');
  });

  it('handles multiple memory IDs', async () => {
    const mockQuery = async (): Promise<GraphViewResult> => {
      return makeViewResult([{ id: 'x', weight: 0.6, depth: 1 }], 'semantic');
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['a', 'b', 'c'],
      viewType: 'semantic',
    };

    const result = await calculateViewAwareBoost(params, mockQuery as any);
    expect(result.size).toBe(3);
    expect(result.get('a')).toBeGreaterThan(0);
    expect(result.get('b')).toBeGreaterThan(0);
    expect(result.get('c')).toBeGreaterThan(0);
  });

  it('returns 0 boost when query throws', async () => {
    const mockQuery = async (): Promise<GraphViewResult> => {
      throw new Error('DB error');
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['mem1'],
      viewType: 'semantic',
    };

    const result = await calculateViewAwareBoost(params, mockQuery as any);
    expect(result.get('mem1')).toBe(0);
  });

  it('uses knowledge as the default node kind', async () => {
    let capturedKind: string | null = null;
    const mockQuery = async (
      _nodeId: string,
      nodeKind: string,
      _config: any
    ): Promise<GraphViewResult> => {
      capturedKind = nodeKind;
      return makeViewResult([]);
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['mem1'],
      viewType: 'semantic',
    };

    await calculateViewAwareBoost(params, mockQuery as any);
    expect(capturedKind).toBe('knowledge');
  });

  it('respects custom node kind', async () => {
    let capturedKind: string | null = null;
    const mockQuery = async (
      _nodeId: string,
      nodeKind: string,
      _config: any
    ): Promise<GraphViewResult> => {
      capturedKind = nodeKind;
      return makeViewResult([]);
    };

    const params: ViewAwareBoostParams = {
      memoryIds: ['mem1'],
      viewType: 'entity',
      nodeKind: 'entity',
    };

    await calculateViewAwareBoost(params, mockQuery as any);
    expect(capturedKind).toBe('entity');
  });
});
