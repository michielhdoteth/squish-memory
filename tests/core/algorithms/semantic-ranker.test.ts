import { describe, expect, it } from 'bun:test';
import type { Memory } from '../../../db/drizzle/schema.js';
import { analyzePair, EmbeddingSpaceMismatchError, rankCandidates } from '../../../core/algorithms/detection/semantic-ranker.js';

function memory(id: string, embeddingModel: string): Memory {
  return {
    id,
    type: 'fact',
    content: 'The runtime stores durable user preferences.',
    tags: ['runtime', 'preference'],
    embeddingModel,
  } as Memory;
}

describe('semantic duplicate ranking vector-space identity', () => {
  it('does not rank equal-dimensional vectors from different known models', async () => {
    const first = memory('first', 'openai:model-a:route-a');
    const second = memory('second', 'openai:model-b:route-b');
    const vectors = new Map([
      [first.id, [1, 0]],
      [second.id, [1, 0]],
    ]);

    await expect(rankCandidates(
      [{ memoryId1: first.id, memoryId2: second.id }],
      new Map([[first.id, first], [second.id, second]]),
      vectors,
      { semanticThreshold: 0.8 },
    )).resolves.toEqual([]);
    expect(() => analyzePair(first, second, [1, 0], [1, 0]))
      .toThrow(EmbeddingSpaceMismatchError);
  });

  it('still ranks vectors with the same known model identity', async () => {
    const first = memory('same-a', 'local:tfidf-v1');
    const second = memory('same-b', 'local:tfidf-v1');
    const result = await rankCandidates(
      [{ memoryId1: first.id, memoryId2: second.id }],
      new Map([[first.id, first], [second.id, second]]),
      new Map([[first.id, [1, 0]], [second.id, [1, 0]]]),
      { semanticThreshold: 0.8 },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.cosineSimilarity).toBe(1);
  });
});
