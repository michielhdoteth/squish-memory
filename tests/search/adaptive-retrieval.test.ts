/**
 * Tests for Adaptive Retrieval - Query Router Integration (WS1a-T1.2 repoint)
 *
 * Originally covered the pure-regex router core/search/query-router.ts and its
 * per-source SearchBudget. That module was removed (single source of routing
 * truth is now the decision-model-aware autoRoute in core/retrieval/query-router;
 * the budget was never consumed downstream and is retired with it).
 *
 * Tests that the surviving router is integrated into the hybrid search pipeline:
 * 1. Query classification produces correct intent (same rules, same contract)
 * 2. The routing stage updates the search context from the consumed route
 * 3. Different intents produce different search behaviors
 */

import { describe, it, expect } from 'bun:test';

import {
  classifyQuery,
  autoRoute,
  type RouteResult,
} from '../../core/retrieval/query-router.js';

import type { SearchResult, SearchInput } from '../../core/memory/memories.js';

// ---------------------------------------------------------------------------
// Helper: create a minimal SearchContext-like object for stage testing
// ---------------------------------------------------------------------------

interface TestContext {
  effectiveQuery: string;
  limit: number;
  options: Record<string, unknown>;
  route: RouteResult | null;
  isTemporal: boolean;
  temporalStageActive: boolean;
  isMultiHop: boolean;
  entityRetrievalEnabled: boolean;
  queryEntities: string[];
  vectorResults: SearchResult[];
  results: SearchResult[];
}

function makeTestContext(query: string, limit = 10): TestContext {
  return {
    effectiveQuery: query,
    limit,
    options: {},
    route: null,
    isTemporal: false,
    temporalStageActive: false,
    isMultiHop: false,
    entityRetrievalEnabled: false,
    queryEntities: [],
    vectorResults: [],
    results: [],
  };
}

// ---------------------------------------------------------------------------
// Test: classifyQuery integration
// ---------------------------------------------------------------------------

describe('Query Router Integration - classifyQuery', () => {
  it('classifies temporal queries correctly', () => {
    const result = classifyQuery('When did we migrate to PostgreSQL?');
    expect(result.intent).toBe('temporal');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.strategy).toBe('temporal_validity');
  });

  it('classifies strategic queries correctly', () => {
    const result = classifyQuery('How should we handle caching?');
    expect(result.intent).toBe('strategic');
    expect(result.strategy).toBe('strategy_first');
  });

  it('classifies factual queries correctly', () => {
    const result = classifyQuery('What is PostgreSQL?');
    expect(result.intent).toBe('factual');
    expect(result.strategy).toBe('hybrid_search');
  });

  it('classifies exploratory queries correctly', () => {
    const result = classifyQuery('Show me related memories about caching');
    expect(result.intent).toBe('exploratory');
    expect(result.strategy).toBe('graph_expanded');
  });

  it('classifies relational queries correctly', () => {
    const result = classifyQuery('How does authentication connect to sessions?');
    expect(result.intent).toBe('relational');
    expect(result.strategy).toBe('multi_hop');
  });

  it('classifies entity-heavy queries correctly', () => {
    const result = classifyQuery('Machine Learning and Neural Networks');
    expect(result.intent).toBe('entity_heavy');
    expect(result.strategy).toBe('entity_aware');
  });

  it('falls back to default for unrecognized queries', () => {
    const result = classifyQuery('the quick brown fox');
    expect(result.intent).toBe('default');
    expect(result.confidence).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Test: autoRoute integration
// ---------------------------------------------------------------------------

describe('Query Router Integration - autoRoute', () => {
  it('returns complete route result for temporal query', async () => {
    const route = await autoRoute('When did we last deploy?');
    expect(route.classification.intent).toBe('temporal');
    expect(route.recommendedStrategy).toBe('temporal_validity');
    expect(route.fallbackStrategy).toBe('hybrid_search');
    expect(route.routingMetadata.classifiedInMs).toBeGreaterThanOrEqual(0);
  });

  it('applies preferGraph option', async () => {
    const route = await autoRoute('caching strategy', { preferGraph: true });
    expect(route.recommendedStrategy).toBe('graph_expanded');
  });

  it('overrides to entity_heavy when knownEntities match', async () => {
    const route = await autoRoute('PostgreSQL and Redis', {
      knownEntities: ['PostgreSQL', 'Redis'],
    });
    expect(route.classification.intent).toBe('entity_heavy');
    expect(route.recommendedStrategy).toBe('entity_aware');
  });

  // Contract preserved from getSearchRoute: oversize input throws; the stage
  // catches and continues with default routing (non-fatal).
  it('throws on excessively long queries (stage catches: non-fatal)', async () => {
    const longQuery = 'a'.repeat(10001);
    await expect(autoRoute(longQuery)).rejects.toThrow(/maximum length/);
  });
});

// ---------------------------------------------------------------------------
// Test: queryRoutingStage (the pipeline stage)
// ---------------------------------------------------------------------------

describe('Query Router Integration - queryRoutingStage', () => {
  it('classifies query and stores route on context', async () => {
    const { queryRoutingStage } = await import('../../core/memory/hybrid-search.js');
    const ctx = makeTestContext('When did we migrate to PostgreSQL?');

    const result = await queryRoutingStage(ctx as any);

    expect(result.route).not.toBeNull();
    expect(result.route!.classification.intent).toBe('temporal');
    expect(result.route!.recommendedStrategy).toBe('temporal_validity');
  });

  it('consumes a caller-provided route from options', async () => {
    const { queryRoutingStage } = await import('../../core/memory/hybrid-search.js');
    const route = await autoRoute('How should we handle caching?');
    const ctx = makeTestContext('How should we handle caching?', 20);
    ctx.options = { route };

    const result = await queryRoutingStage(ctx as any);

    expect(result.route).toBe(route);
    expect(result.route!.classification.intent).toBe('strategic');
  });

  it('handles empty query gracefully', async () => {
    const { queryRoutingStage } = await import('../../core/memory/hybrid-search.js');
    const ctx = makeTestContext('');

    const result = await queryRoutingStage(ctx as any);

    expect(result.route).not.toBeNull();
    expect(result.route!.classification.intent).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Test: hybridSearch integration (with mocked dependencies)
// ---------------------------------------------------------------------------

describe('Query Router Integration - hybridSearch', () => {
  it('routes through the surviving router without crashing on a temporal query', async () => {
    const { hybridSearch } = await import('../../core/memory/hybrid-search.js');

    const input: SearchInput = {
      query: 'When did we migrate to PostgreSQL?',
      limit: 5,
    };

    // This will fail due to missing DB setup, but we can catch and verify
    // that the error is NOT a router integration error
    try {
      await hybridSearch(input);
    } catch (e: any) {
      // Expected to fail due to missing DB setup
      // But the error should NOT be about missing router functions
      expect(e.message).not.toContain('classifyQuery');
      expect(e.message).not.toContain('autoRoute');
    }
  });

  it('produces different strategies for different intents', async () => {
    const temporalRoute = await autoRoute('When did we deploy?');
    const factualRoute = await autoRoute('What is deployment?');

    // Different intents should produce different strategies
    expect(temporalRoute.recommendedStrategy).not.toBe(factualRoute.recommendedStrategy);
    expect(temporalRoute.classification.intent).toBe('temporal');
    expect(factualRoute.classification.intent).toBe('factual');
  });
});

// ---------------------------------------------------------------------------
// Test: Intent-aware strategy mapping
// ---------------------------------------------------------------------------

describe('Query Router Integration - Intent-Aware Parameters', () => {
  it('temporal intent maps to temporal_validity', async () => {
    const route = await autoRoute('When did we last deploy?');
    expect(route.recommendedStrategy).toBe('temporal_validity');
  });

  it('relational intent maps to multi_hop', async () => {
    const route = await autoRoute('How does auth connect to sessions?');
    expect(route.recommendedStrategy).toBe('multi_hop');
  });

  it('exploratory intent maps to graph_expanded', async () => {
    const route = await autoRoute('Show me related memories about caching');
    expect(route.recommendedStrategy).toBe('graph_expanded');
  });

  it('strategic intent maps to strategy_first', async () => {
    const route = await autoRoute('How should we handle caching?');
    expect(route.recommendedStrategy).toBe('strategy_first');
  });

  it('entity-heavy intent maps to entity_aware', async () => {
    const route = await autoRoute('Machine Learning and Neural Networks');
    expect(route.recommendedStrategy).toBe('entity_aware');
  });
});
