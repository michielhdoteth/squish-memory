import { describe, expect, test } from 'bun:test';
import { buildRetrievalAuditArtifact } from '../../benchmark/runners/retrieval-audit.js';

describe('retrieval signal audit artifact', () => {
  const input = {
    gitSha: 'abc1234',
    datasetSha256: 'd'.repeat(64),
    sourceHashes: { 'benchmark/runners/retrieval.ts': 's'.repeat(64) },
    config: { topK: 5, provider: 'local', downloadsAllowed: false },
    queries: [{
      id: 'q_fixture_01',
      category: 'paraphrase',
      query: 'private query text that must not be serialized',
      mustHit: ['memory_01'],
      mayHit: ['memory_02'],
      results: [{
        id: 'memory_01',
        memoryText: 'private memory content that must not be serialized',
        preFusionSemanticScore: 0.73,
        postFusionSemanticScore: 1,
        servedScore: 0.91,
        finalScore: 0.91,
        lexicalRank: 2,
        lexicalScore: 0.82,
        recallConfidence: 0.88,
      }, {
        id: 'memory_03',
        preFusionSemanticScore: null,
        postFusionSemanticScore: 0.5,
        servedScore: 0.41,
        finalScore: 0.41,
        lexicalRank: null,
        lexicalScore: null,
        recallConfidence: 0.22,
      }],
    }],
  };

  test('emits stable schema and numeric provenance without query or memory text', () => {
    const first = buildRetrievalAuditArtifact(input);
    const second = buildRetrievalAuditArtifact(input);
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.meta.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.meta.datasetSha256).toBe(input.datasetSha256);
    expect(first.meta.sourceHashes).toEqual(input.sourceHashes);
    expect(first.queries[0]?.querySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.queries[0]?.mustHit).toEqual(['memory_01']);
    expect(first.queries[0]?.results[0]).toMatchObject({
      relevance: 'must-hit',
      preFusionSemanticScore: 0.73,
      postFusionSemanticScore: 1,
      lexicalRank: 2,
      lexicalScore: 0.82,
      recallConfidence: 0.88,
    });
    expect(first.queries[0]?.results[1]?.relevance).toBe('other');
    expect(serialized).not.toContain('private query text');
    expect(serialized).not.toContain('private memory content');
  });
});
