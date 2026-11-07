/**
 * Tests for Query Router Module
 *
 * Tests classifyQuery (pure sync) across all 7 intents and edge cases,
 * plus autoRoute (async) and getRoutingStats.
 */

import { describe, it, expect } from 'bun:test';
import {
  classifyQuery,
  autoRoute,
  getRoutingStats,
  intentsForRetrievalDecision,
  type QueryIntent,
  type RetrievalStrategy,
} from './query-router.js';
import type { RetrievalDecision } from '../decision-model/types.js';

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

  it('classifies "what is the best practice for error handling?" as factual (factual wins over strategic due to "what is" match)', () => {
    // "what is" matches factual pattern; "best practice" matches strategic.
    // Factual scores higher (0.5 + 0.15 = 0.65) than strategic (0.5 + 0.12 = 0.62).
    const r = classifyQuery('what is the best practice for error handling?');
    expect(r.intent).toBe('factual');
  });

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
// autoRoute -- async, but classifyQuery-based so no DB needed for basic tests
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

  it('upgrades to entity_heavy when 2+ known entities match', async () => {
    const r = await autoRoute(
      'how does UserService connect to PaymentGateway?',
      { knownEntities: ['UserService', 'PaymentGateway'] }
    );
    expect(r.classification.intent).toBe('entity_heavy');
    expect(r.classification.strategy).toBe('entity_aware');
    expect(r.classification.detectedEntities).toContain('UserService');
    expect(r.classification.detectedEntities).toContain('PaymentGateway');
  });

  it('does NOT override to entity_heavy if only 1 known entity matches', async () => {
    const r = await autoRoute(
      'tell me about UserService',
      { knownEntities: ['UserService', 'PaymentGateway'] }
    );
    // Should remain factual, not entity_heavy
    expect(r.classification.intent).not.toBe('entity_heavy');
  });

  it('upgrades to graph_expanded when preferGraph is set and strategy is hybrid_search', async () => {
    const r = await autoRoute('random text', { preferGraph: true });
    // Default strategy is hybrid_search, with preferGraph it should become graph_expanded
    expect(r.recommendedStrategy).toBe('graph_expanded');
    expect(
      r.classification.reasons.some(reason => reason.includes('preferGraph'))
    ).toBe(true);
  });

  it('does NOT upgrade to graph_expanded when strategy is already non-hybrid', async () => {
    const r = await autoRoute('when did we deploy?', { preferGraph: true });
    // temporal intent -> temporal_validity, not hybrid_search, so no upgrade
    expect(r.recommendedStrategy).toBe('temporal_validity');
  });

  it('does NOT upgrade to graph_expanded for factual intent even with preferGraph', async () => {
    const r = await autoRoute('what is the config?', { preferGraph: true });
    // factual -> hybrid_search, but spec says skip for factual
    expect(r.recommendedStrategy).toBe('hybrid_search');
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

  it('handles empty knownEntities array', async () => {
    const r = await autoRoute('test query', { knownEntities: [] });
    expect(r.classification).toBeDefined();
  });

  it('handles options with no knownEntities', async () => {
    const r = await autoRoute('test query', {});
    expect(r.classification).toBeDefined();
  });
});

describe('multi-view decision routing', () => {
  it('retains every selected view and removes duplicate retrieval intents', () => {
    const decision: RetrievalDecision = {
      queryViews: ['entity', 'temporal', 'causal', 'entity'],
      anchorCount: 3,
      confidence: 0.9,
    };

    expect(intentsForRetrievalDecision(decision)).toEqual([
      'entity_heavy',
      'temporal',
      'relational',
    ]);
  });
});

// ---------------------------------------------------------------------------
// getRoutingStats
// ---------------------------------------------------------------------------

describe('getRoutingStats', () => {
  it('returns RoutingStats with all required fields', () => {
    const s = getRoutingStats();
    expect(typeof s.totalRoutes).toBe('number');
    expect(typeof s.avgConfidence).toBe('number');
    expect(typeof s.byIntent).toBe('object');
    expect(typeof s.byStrategy).toBe('object');
  });

  it('contains all 7 intent keys', () => {
    const s = getRoutingStats();
    const intents = [
      'temporal', 'relational', 'strategic', 'entity_heavy',
      'factual', 'exploratory', 'default',
    ];
    for (const intent of intents) {
      expect(intent in s.byIntent).toBe(true);
    }
  });

  it('contains all 7 strategy keys', () => {
    const s = getRoutingStats();
    const strategies = [
      'hybrid_search', 'graph_expanded', 'multi_hop',
      'temporal_validity', 'strategy_first', 'entity_aware', 'contextual',
    ];
    for (const strategy of strategies) {
      expect(strategy in s.byStrategy).toBe(true);
    }
  });

  it('returns a copy (not a reference to internal state)', () => {
    const s1 = getRoutingStats();
    const s2 = getRoutingStats();
    // They should be equal but different objects
    expect(s1).not.toBe(s2);
    expect(s1.byIntent).not.toBe(s2.byIntent);
    expect(s1.byStrategy).not.toBe(s2.byStrategy);
  });
});
