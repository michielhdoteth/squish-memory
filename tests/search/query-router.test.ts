/**
 * Tests for Query Router (single source of routing truth: core/retrieval/query-router)
 *
 * WS1a-T1.2 repoint note: this file previously covered the pure-regex router
 * `core/search/query-router.ts` (classifySearchQuery / getSearchRoute /
 * allocateSearchBudget). That module was removed: its classification was a
 * byte-for-byte duplicate of `classifyQuery` here, and its per-source
 * SearchBudget was never consumed by any pipeline stage (only by a dead
 * `_searchBudget` context write). Coverage below now targets the surviving
 * decision-model-aware router: `classifyQuery` (same rules, same expectations)
 * and `autoRoute` (async; graceful fallback instead of throwing; budget
 * assertions dropped with the retired feature).
 */

import { describe, it, expect } from 'bun:test';
import {
  classifyQuery,
  autoRoute,
  type QueryIntent,
  type RetrievalStrategy,
} from '../../core/retrieval/query-router.js';

// ---------------------------------------------------------------------------
// classifyQuery -- pure, synchronous, no DB
// ---------------------------------------------------------------------------

describe('classifyQuery', () => {
  // --- temporal -----------------------------------------------------------

  it('classifies "when did we deploy the fix?" as temporal', () => {
    const r = classifyQuery('when did we deploy the fix?');
    expect(r.intent).toBe('temporal');
    expect(r.strategy).toBe('temporal_validity');
    expect(r.confidence).toBeGreaterThan(0.4);
    expect(r.detectedTemporalRefs.length).toBeGreaterThan(0);
  });

  it('classifies "yesterday we pushed a hotfix" as temporal', () => {
    const r = classifyQuery('yesterday we pushed a hotfix');
    expect(r.intent).toBe('temporal');
    expect(r.detectedTemporalRefs.length).toBeGreaterThan(0);
  });

  it('classifies "after the migration what changed" as temporal', () => {
    const r = classifyQuery('after the migration what changed');
    expect(r.intent).toBe('temporal');
  });

  it('classifies "last week we discussed pricing" as temporal', () => {
    const r = classifyQuery('last week we discussed pricing');
    expect(r.intent).toBe('temporal');
  });

  it('classifies "2024-01-15 server incident" as temporal', () => {
    const r = classifyQuery('2024-01-15 server incident');
    expect(r.intent).toBe('temporal');
    expect(r.detectedTemporalRefs.length).toBeGreaterThan(0);
  });

  it('classifies "previously we used MySQL" as temporal', () => {
    const r = classifyQuery('previously we used MySQL');
    expect(r.intent).toBe('temporal');
  });

  // --- relational --------------------------------------------------------

  it('classifies "what depends on the auth module?" as relational', () => {
    const r = classifyQuery('what depends on the auth module?');
    expect(r.intent).toBe('relational');
    expect(r.strategy).toBe('multi_hop');
    expect(r.confidence).toBeGreaterThan(0.4);
  });

  it('classifies "who manages the backend team?" as relational', () => {
    const r = classifyQuery('who manages the backend team?');
    expect(r.intent).toBe('relational');
  });

  it('classifies "relationship between User and Order" as relational', () => {
    const r = classifyQuery('relationship between User and Order');
    expect(r.intent).toBe('relational');
  });

  it('classifies "what calls the payment API?" as relational', () => {
    const r = classifyQuery('what calls the payment API?');
    expect(r.intent).toBe('relational');
  });

  it('classifies "who is responsible for testing?" as relational', () => {
    const r = classifyQuery('who is responsible for testing?');
    expect(r.intent).toBe('relational');
  });

  // --- strategic ---------------------------------------------------------

  it('classifies "always prefer to use bcrypt for passwords" as strategic', () => {
    const r = classifyQuery('always prefer to use bcrypt for passwords');
    expect(r.intent).toBe('strategic');
    expect(r.strategy).toBe('strategy_first');
    expect(r.detectedStrategyKeywords.length).toBeGreaterThan(0);
  });

  it('classifies "always use bcrypt for passwords" as strategic', () => {
    const r = classifyQuery('always use bcrypt for passwords');
    expect(r.intent).toBe('strategic');
  });

  it('classifies "how should we handle migrations?" as strategic', () => {
    const r = classifyQuery('how should we handle migrations?');
    expect(r.intent).toBe('strategic');
  });

  it('classifies "the workflow for code review" as strategic', () => {
    const r = classifyQuery('the workflow for code review');
    expect(r.intent).toBe('strategic');
  });

  it('classifies "how do we implement authentication?" as strategic', () => {
    const r = classifyQuery('how do we implement authentication?');
    expect(r.intent).toBe('strategic');
  });

  // --- factual -----------------------------------------------------------

  it('classifies "what is the database schema?" as factual', () => {
    const r = classifyQuery('what is the database schema?');
    expect(r.intent).toBe('factual');
    expect(r.strategy).toBe('hybrid_search');
    expect(r.confidence).toBeGreaterThan(0.4);
  });

  it('classifies "explain the caching strategy" as factual', () => {
    const r = classifyQuery('explain the caching strategy');
    expect(r.intent).toBe('factual');
  });

  it('classifies "tell me about the auth system" as factual', () => {
    const r = classifyQuery('tell me about the auth system');
    expect(r.intent).toBe('factual');
  });

  it('classifies "what does the config file mean?" as factual', () => {
    const r = classifyQuery('what does the config file mean?');
    expect(r.intent).toBe('factual');
  });

  it('classifies "can you describe the architecture?" as factual', () => {
    const r = classifyQuery('can you describe the architecture?');
    expect(r.intent).toBe('factual');
  });

  // --- exploratory -------------------------------------------------------

  it('classifies "show related memories" as exploratory', () => {
    const r = classifyQuery('show related memories');
    expect(r.intent).toBe('exploratory');
    expect(r.strategy).toBe('graph_expanded');
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it('classifies "what else is connected to the API?" as exploratory', () => {
    const r = classifyQuery('what else is connected to the API?');
    expect(r.intent).toBe('exploratory');
  });

  it('classifies "find me similar functions" as exploratory', () => {
    const r = classifyQuery('find me similar functions');
    expect(r.intent).toBe('exploratory');
  });

  it('classifies "what\'s related to this module?" as exploratory', () => {
    const r = classifyQuery("what's related to this module?");
    expect(r.intent).toBe('exploratory');
  });

  // --- entity_heavy ------------------------------------------------------

  it('classifies "PostgreSQL Migration Strategy for User Service" as entity_heavy', () => {
    const r = classifyQuery('PostgreSQL Migration Strategy for User Service');
    expect(r.intent).toBe('entity_heavy');
    expect(r.strategy).toBe('entity_aware');
    expect(r.detectedEntities.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies "React Component Design for Payment Gateway Integration" as entity_heavy', () => {
    const r = classifyQuery('React Component Design for Payment Gateway Integration');
    expect(r.intent).toBe('entity_heavy');
    expect(r.detectedEntities.length).toBeGreaterThanOrEqual(2);
  });

  // --- default -----------------------------------------------------------

  it('classifies "hello" as default with low confidence', () => {
    const r = classifyQuery('hello');
    expect(r.intent).toBe('default');
    expect(r.strategy).toBe('hybrid_search');
    expect(r.confidence).toBe(0.3);
  });

  it('classifies "random unrelated text" as default', () => {
    const r = classifyQuery('random unrelated text');
    expect(r.intent).toBe('default');
    expect(r.confidence).toBe(0.3);
  });

  it('classifies empty string as default', () => {
    const r = classifyQuery('');
    expect(r.intent).toBe('default');
    expect(r.strategy).toBe('hybrid_search');
  });

  it('classifies whitespace-only string as default', () => {
    const r = classifyQuery('   ');
    expect(r.intent).toBe('default');
  });

  // --- structure / contract tests ----------------------------------------

  it('returns all required fields in QueryClassification', () => {
    const r = classifyQuery('test');
    expect(typeof r.intent).toBe('string');
    expect(typeof r.confidence).toBe('number');
    expect(typeof r.strategy).toBe('string');
    expect(Array.isArray(r.reasons)).toBe(true);
    expect(Array.isArray(r.detectedEntities)).toBe(true);
    expect(Array.isArray(r.detectedTemporalRefs)).toBe(true);
    expect(Array.isArray(r.detectedStrategyKeywords)).toBe(true);
  });

  it('confidence is always between 0 and 1', () => {
    const queries = [
      'when did we deploy?',
      'what depends on auth?',
      'best practice for logging',
      'what is the API?',
      'show related',
      'React Express TypeScript',
      'hello',
    ];
    for (const q of queries) {
      const r = classifyQuery(q);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('maps each intent to a valid strategy', () => {
    const validStrategies = new Set<RetrievalStrategy>([
      'hybrid_search', 'graph_expanded', 'multi_hop',
      'temporal_validity', 'strategy_first', 'entity_aware', 'contextual',
    ]);
    const queries: Array<[string, QueryIntent]> = [
      ['when was the deploy?', 'temporal'],
      ['what connects X and Y?', 'relational'],
      ['always use lints', 'strategic'],
      ['what is the config?', 'factual'],
      ['show related stuff', 'exploratory'],
      ['Payment Gateway Service for User Management', 'entity_heavy'],
      ['hello', 'default'],
    ];
    for (const [q, expectedIntent] of queries) {
      const r = classifyQuery(q);
      expect(r.intent).toBe(expectedIntent);
      expect(validStrategies.has(r.strategy)).toBe(true);
    }
  });

  it('is case-insensitive for pattern matching', () => {
    const upper = classifyQuery('WHEN DID WE DEPLOY?');
    const lower = classifyQuery('when did we deploy?');
    expect(upper.intent).toBe('temporal');
    expect(lower.intent).toBe('temporal');
  });

  it('handles special characters without errors', () => {
    const r = classifyQuery('what about @user#123 and $variable?');
    expect(r.intent).toBeDefined();
    expect(typeof r.confidence).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// autoRoute -- decision-model-aware entry point (rules default; async)
// ---------------------------------------------------------------------------

describe('autoRoute', () => {
  it('returns a RouteResult with all required fields', async () => {
    const r = await autoRoute('when did we deploy?');
    expect(r.classification).toBeDefined();
    expect(typeof r.recommendedStrategy).toBe('string');
    expect(typeof r.fallbackStrategy).toBe('string');
    expect(r.routingMetadata).toBeDefined();
    expect(typeof r.routingMetadata.classifiedInMs).toBe('number');
    expect(typeof r.routingMetadata.intent).toBe('string');
    expect(typeof r.routingMetadata.confidence).toBe('number');
  });

  it('classifies a temporal query and recommends temporal_validity', async () => {
    const r = await autoRoute('when did we deploy?');
    expect(r.classification.intent).toBe('temporal');
    expect(r.recommendedStrategy).toBe('temporal_validity');
  });

  it('classifies a relational query and recommends multi_hop', async () => {
    const r = await autoRoute('what depends on the auth module?');
    expect(r.classification.intent).toBe('relational');
    expect(r.recommendedStrategy).toBe('multi_hop');
  });

  it('classifies a strategic query and recommends strategy_first', async () => {
    const r = await autoRoute('always use bcrypt for passwords');
    expect(r.classification.intent).toBe('strategic');
    expect(r.recommendedStrategy).toBe('strategy_first');
  });

  it('classifies a factual query and recommends hybrid_search', async () => {
    const r = await autoRoute('what is the database schema?');
    expect(r.classification.intent).toBe('factual');
    expect(r.recommendedStrategy).toBe('hybrid_search');
  });

  it('classifies an exploratory query and recommends graph_expanded', async () => {
    const r = await autoRoute('show related memories');
    expect(r.classification.intent).toBe('exploratory');
    expect(r.recommendedStrategy).toBe('graph_expanded');
  });

  it('classifies an entity_heavy query and recommends entity_aware', async () => {
    const r = await autoRoute('PostgreSQL Migration Strategy for User Service');
    expect(r.classification.intent).toBe('entity_heavy');
    expect(r.recommendedStrategy).toBe('entity_aware');
  });

  it('classifies a default query and recommends hybrid_search', async () => {
    const r = await autoRoute('hello');
    expect(r.classification.intent).toBe('default');
    expect(r.recommendedStrategy).toBe('hybrid_search');
  });

  it('respects preferGraph option', async () => {
    const r = await autoRoute('random text', { preferGraph: true });
    expect(r.recommendedStrategy).toBe('graph_expanded');
  });

  it('respects knownEntities option for entity_heavy override', async () => {
    const r = await autoRoute('how does UserService connect to PaymentGateway?', {
      knownEntities: ['UserService', 'PaymentGateway'],
    });
    expect(r.classification.intent).toBe('entity_heavy');
    expect(r.recommendedStrategy).toBe('entity_aware');
  });

  it('fallback strategy is contextual when main is hybrid_search', async () => {
    const r = await autoRoute('hello');
    expect(r.classification.strategy).toBe('hybrid_search');
    expect(r.fallbackStrategy).toBe('contextual');
  });

  it('fallback strategy is hybrid_search when main is not hybrid_search', async () => {
    const r = await autoRoute('when did we deploy?');
    expect(r.fallbackStrategy).toBe('hybrid_search');
  });

  it('classifiedInMs is a non-negative number', async () => {
    const r = await autoRoute('test query');
    expect(r.routingMetadata.classifiedInMs).toBeGreaterThanOrEqual(0);
  });

  it('handles empty query', async () => {
    const r = await autoRoute('');
    expect(r.classification.intent).toBe('default');
  });

  it('handles whitespace-only query', async () => {
    const r = await autoRoute('   ');
    expect(r.classification.intent).toBe('default');
  });

  // Contract preserved from the retired getSearchRoute (throw on hostile
  // input); the pipeline stage wraps routing in try/catch so a throw here is
  // contained and non-fatal for serving.
  it('throws on excessively long queries', async () => {
    const longQuery = 'a'.repeat(10001);
    await expect(autoRoute(longQuery)).rejects.toThrow(/maximum length/);
  });
});
