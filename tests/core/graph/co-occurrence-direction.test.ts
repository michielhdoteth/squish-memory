import { describe, expect, it } from 'bun:test';
import { generateCoOccurrenceRelations } from '../../../core/graph/relationship-extractor.js';
import type { ExtractedEntity } from '../../../core/memory/entity-extractor.js';

const entities: ExtractedEntity[] = [
  { name: 'Alpha', type: 'concept', confidence: 1, startIndex: 0, endIndex: 5, context: 'Alpha' },
  { name: 'Beta', type: 'concept', confidence: 1, startIndex: 20, endIndex: 24, context: 'Beta' },
];

describe('fallback graph relation direction', () => {
  it('stores a cross-sentence mention order in one direction only', () => {
    const relations = generateCoOccurrenceRelations(entities, 'Alpha was discussed. Beta came later.');

    expect(relations).toEqual([{
      fromEntity: 'Alpha',
      toEntity: 'Beta',
      relationType: 'mentioned_before',
      confidence: 0.5,
      context: 'Co-occurrence in memory (mentioned_before)',
    }]);
  });

  it('reverses the directed edge when the source text reverses the mention order', () => {
    const relations = generateCoOccurrenceRelations(entities, 'Beta came first. Alpha came later.');

    expect(relations).toEqual([{
      fromEntity: 'Beta',
      toEntity: 'Alpha',
      relationType: 'mentioned_before',
      confidence: 0.5,
      context: 'Co-occurrence in memory (mentioned_before)',
    }]);
  });

  it('keeps same-sentence co-mention symmetric', () => {
    const relations = generateCoOccurrenceRelations(entities, 'Alpha and Beta worked together.');

    expect(relations).toHaveLength(2);
    expect(relations.map(({ fromEntity, toEntity }) => [fromEntity, toEntity])).toEqual([
      ['Alpha', 'Beta'],
      ['Beta', 'Alpha'],
    ]);
    expect(relations.every(({ relationType }) => relationType === 'mentioned_together')).toBe(true);
  });

  it('does not link nested entity names from one overlapping mention', () => {
    const relations = generateCoOccurrenceRelations([
      { name: 'Acme', type: 'organization', confidence: 1, startIndex: 0, endIndex: 4, context: 'Acme Holdings' },
      { name: 'Acme Holdings', type: 'organization', confidence: 1, startIndex: 0, endIndex: 13, context: 'Acme Holdings' },
    ], 'Acme Holdings signed the agreement.');

    expect(relations).toEqual([]);
  });
});
