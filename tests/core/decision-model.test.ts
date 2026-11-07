import { describe, expect, it } from 'bun:test';
import { DecisionModel } from '../../core/decision-model/model.js';
import { classifyMemoryType } from '../../core/decision-model/decisions.js';
import { MEMORY_TYPES } from '../../core/decision-model/types.js';
import type { MemoryObservation } from '../../core/decision-model/types.js';

describe('DecisionModel', () => {
  describe('classifyMemoryType', () => {
    it('classifies preference observations', () => {
      const obs: MemoryObservation = {
        text: 'I prefer using bun over npm for package management',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('preference');
      expect(decision.confidence).toBeGreaterThan(0);
      expect(decision.reasoning).toBeDefined();
    });

    it('classifies procedural observations', () => {
      const obs: MemoryObservation = {
        text: 'The process for deploying is: build, test, then ship',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('procedural');
      expect(decision.confidence).toBeGreaterThan(0);
    });

    it('classifies episodic observations', () => {
      const obs: MemoryObservation = {
        text: 'Yesterday we decided to refactor the auth module',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('episodic');
      expect(decision.confidence).toBeGreaterThan(0);
    });

    it('classifies noise as discard', () => {
      const obs: MemoryObservation = {
        text: 'ok',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('discard');
      expect(decision.confidence).toBeGreaterThan(0);
    });

    it('classifies short text as discard', () => {
      const obs: MemoryObservation = {
        text: 'ab',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('discard');
    });

    it('classifies empty string as discard', () => {
      const obs: MemoryObservation = {
        text: '',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('discard');
    });

    it('classifies whitespace-only text as discard', () => {
      const obs: MemoryObservation = {
        text: '   \t  ',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('discard');
    });

    it('classifies very long text without error', () => {
      const obs: MemoryObservation = {
        text: 'The system architecture relies on '.repeat(500) + 'semantic memory.',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(MEMORY_TYPES).toContain(decision.memoryType);
    });

    it('classifies special-character-only text without error', () => {
      const obs: MemoryObservation = {
        text: '!@#$%^&*()_+-=[]{}|;:",.<>?/~`',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(MEMORY_TYPES).toContain(decision.memoryType);
    });

    it('classifies semantic observations', () => {
      const obs: MemoryObservation = {
        text: 'TypeScript is a typed superset of JavaScript',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = classifyMemoryType(obs);
      expect(decision.memoryType).toBe('semantic');
      expect(decision.confidence).toBeGreaterThan(0);
    });
  });

  describe('controller instance', () => {
    it('can be instantiated', () => {
      const controller = new DecisionModel();
      expect(controller).toBeDefined();
    });

    it('has classifyMemoryType method', () => {
      const controller = new DecisionModel();
      expect(typeof controller.classifyMemoryType).toBe('function');
    });

    it('has judgeRelation method', () => {
      const controller = new DecisionModel();
      expect(typeof controller.judgeRelation).toBe('function');
    });

    it('has routeQuery method', () => {
      const controller = new DecisionModel();
      expect(typeof controller.routeQuery).toBe('function');
    });

    it('classifyMemoryType returns a valid decision', () => {
      const controller = new DecisionModel();
      const obs: MemoryObservation = {
        text: 'I always use strict mode in tsconfig',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const decision = controller.classifyMemoryType(obs);
      expect(decision).toHaveProperty('memoryType');
      expect(decision).toHaveProperty('confidence');
      expect(decision).toHaveProperty('reasoning');
      expect(MEMORY_TYPES).toContain(decision.memoryType);
    });

    it('judgeRelation returns a valid decision with ids and a typed relation', () => {
      const controller = new DecisionModel();
      const source: MemoryObservation = {
        text: 'source memory',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const target: MemoryObservation = {
        text: 'target memory',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const result = controller.judgeRelation(source, target);
      expect(result).toHaveProperty('sourceId');
      expect(result).toHaveProperty('targetId');
      expect(result).toHaveProperty('relationType');
      expect(result).toHaveProperty('confidence');
    });

    it('judgeRelation classifies an update pair as temporal', () => {
      const controller = new DecisionModel();
      const source: MemoryObservation = {
        text: 'Sarah now lives and works in Houston.',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const target: MemoryObservation = {
        text: 'Sarah lives and works in Austin.',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const result = controller.judgeRelation(source, target);
      expect(result.relationType).toBe('temporal');
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it('judgeRelation classifies causal language as causal', () => {
      const controller = new DecisionModel();
      const source: MemoryObservation = {
        text: 'The outage was caused by the expired certificate',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const target: MemoryObservation = {
        text: 'The service went down at midnight',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const result = controller.judgeRelation(source, target);
      expect(result.relationType).toBe('causal');
    });

    it('judgeRelation classifies shared-entity pairs as entity relation', () => {
      const controller = new DecisionModel();
      const source: MemoryObservation = {
        text: 'UserService has flaky integration tests',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const target: MemoryObservation = {
        text: 'UserService migrations run before deployment',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const result = controller.judgeRelation(source, target);
      expect(result.relationType).toBe('entity');
      expect(result.sourceId).toBe(source.text);
      expect(result.targetId).toBe(target.text);
    });

    it('judgeRelation defaults to semantic with confidence from overlap', () => {
      const controller = new DecisionModel();
      const source: MemoryObservation = {
        text: 'The team uses Postgres for the main database',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const target: MemoryObservation = {
        text: 'Redis is used for caching sessions',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };
      const result = controller.judgeRelation(source, target);
      expect(result.relationType).toBe('semantic');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('returns a low-confidence fallback when an observation is missing at runtime', () => {
      const controller = new DecisionModel();
      const target: MemoryObservation = {
        id: 'known-target',
        text: 'The account uses local storage',
        timestamp: Date.now(),
        source: 'test',
        metadata: {},
      };

      const result = controller.judgeRelation(null as unknown as MemoryObservation, target);

      expect(result).toEqual({
        sourceId: '',
        targetId: 'known-target',
        relationType: 'semantic',
        confidence: 0,
      });
    });

    it('routeQuery selects the temporal view for time-bound queries', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('when did we deploy the fix?');
      expect(result.queryViews).toContain('temporal');
      expect(result.confidence).toBeGreaterThan(0.6);
    });

    it('routeQuery selects the causal view for dependency queries', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('what depends on the auth module?');
      expect(result.queryViews).toContain('causal');
    });

    it('routeQuery selects the entity view for entity-heavy queries', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('Compare UserService and PaymentGateway design');
      expect(result.queryViews).toContain('entity');
    });

    it('routeQuery keeps clear questions at high confidence (no escalation candidate)', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('what is the database schema?');
      expect(result.queryViews).toEqual(['semantic']);
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it('routeQuery leaves ambiguous queries at low confidence (escalation candidates)', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('hmm the thing with the failing build');
      expect(result.queryViews).toEqual(['semantic']);
      expect(result.confidence).toBeLessThan(0.6);
    });

    it('routeQuery handles empty and invalid input without throwing', () => {
      const controller = new DecisionModel();
      expect(controller.routeQuery('').confidence).toBeDefined();
      expect(controller.routeQuery('   ').confidence).toBeDefined();
    });

    it('routeQuery returns a well-formed decision', () => {
      const controller = new DecisionModel();
      const result = controller.routeQuery('how to deploy');
      expect(result).toHaveProperty('queryViews');
      expect(result).toHaveProperty('anchorCount');
      expect(result).not.toHaveProperty('budget');
      expect(result).not.toHaveProperty('stopCriteria');
    });
  });
});
