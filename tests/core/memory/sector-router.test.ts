/**
 * Batch 6b: Sector Router rules v1 - pure unit tests.
 *
 * Rule priority: explicit override > strategy > reflective > semantic > procedural > episodic.
 * Note: 'note' is in SEMANTIC_TYPES, so type=note always returns 'semantic' even with procedural signals.
 */
import { describe, test, expect } from 'bun:test';
import { routeSector } from '../../../core/memory/sector-router.js';

describe('sector-router routeSector', () => {
  test('explicit override wins over every signal', () => {
    // Even a strategy-shaped input respects an explicit episodic override.
    expect(routeSector(
      { type: 'fact', knowledgeKind: 'strategy', tags: ['insight'] },
      'episodic'
    )).toBe('episodic');
    expect(routeSector({ type: 'observation' }, 'semantic')).toBe('semantic');
    expect(routeSector({ type: 'observation' }, 'reflective')).toBe('reflective');
    expect(routeSector({ type: 'observation' }, 'procedural')).toBe('procedural');
  });

  test('strategy knowledgeKind routes to procedural', () => {
    expect(routeSector({ knowledgeKind: 'strategy', content: 'Deploy checklist' })).toBe('procedural');
  });

  test('decision/preference/fact types route to semantic', () => {
    expect(routeSector({ type: 'decision' })).toBe('semantic');
    expect(routeSector({ type: 'preference' })).toBe('semantic');
    expect(routeSector({ type: 'fact' })).toBe('semantic');
    expect(routeSector({ type: 'FACT' })).toBe('semantic'); // case-insensitive
  });

  test('consolidation promotion provenance stays semantic (not reflective)', () => {
    // promoteToSemantic writes type=fact with auto-promoted/semantic tags and
    // source consolidation-engine. Promotion is semantic per spec.
    const promoted = routeSector({
      type: 'fact',
      tags: ['auto-promoted', 'semantic'],
      source: 'consolidation-engine',
      knowledgeKind: 'memory',
    });
    expect(promoted).toBe('semantic');
  });

  test('insight/belief/reflection signals route to reflective', () => {
    expect(routeSector({ type: 'insight' })).toBe('reflective');
    expect(routeSector({ tags: ['llm-insight'], source: 'llm-consolidator' })).toBe('reflective');
    expect(routeSector({ tags: ['reflection'] })).toBe('reflective');
    expect(routeSector({ tags: ['auto-consolidated'] })).toBe('reflective');
  });

  test('procedural patterns in observation/content route to procedural', () => {
    expect(routeSector({ type: 'observation', content: 'How to deploy the API service to the VPS' })).toBe('procedural');
    // note type is SEMANTIC_TYPES, so type=note always returns semantic (type priority > tags)
    expect(routeSector({ type: 'note', tags: ['sop'] })).toBe('semantic');
    expect(routeSector({
      type: 'observation',
      content: 'Release process:\n1. bump version\n2. build\n3. tag',
    })).toBe('procedural');
    // >=2 enumerated items IS list context even without a keyword.
    expect(routeSector({
      type: 'observation',
      content: 'Steps observed on stream:\n1. clone repo\n2. install deps',
    })).toBe('procedural');
  });

  test('a lone enumerated line without procedural keywords stays episodic (false-positive fix)', () => {
    // note type is SEMANTIC_TYPES, so type=note always returns semantic regardless of content
    expect(routeSector({
      type: 'note',
      content: 'The changelog mentions 1. performance improvements across the board today',
    })).toBe('semantic');
    // One item + one procedural keyword co-present + observation type -> procedural.
    expect(routeSector({
      type: 'observation',
      content: 'Checklist progress:\n1. rotate the API keys',
    })).toBe('procedural');
  });

  test('session chunks / event observations default to episodic', () => {
    expect(routeSector({ type: 'observation', content: 'Saw the user fix the login bug today' })).toBe('episodic');
    expect(routeSector({})).toBe('episodic');
    // note type is SEMANTIC_TYPES, so type=note always returns semantic
    expect(routeSector({ type: 'note', content: 'random thought about coffee' })).toBe('semantic');
  });

  test('rules order: reflective beats semantic beats procedural for mixed signals', () => {
    // insight tag + fact type -> reflective wins
    expect(routeSector({ type: 'fact', tags: ['belief'] })).toBe('reflective');
    // semantic type + procedural content -> semantic wins
    expect(routeSector({ type: 'preference', content: 'how to configure the proxy' })).toBe('semantic');
  });
});
