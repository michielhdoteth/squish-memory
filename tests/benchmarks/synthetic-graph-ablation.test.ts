import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertOfflineEnvironment,
  assertMinimumFreeMemory,
  compareSyntheticGraphReports,
  DEFAULT_MULTI_HOP_QUERY_IDS,
  graphAblationEnvironment,
  MINIMUM_FREE_MEMORY_BYTES,
  selectSyntheticMultiHopQueries,
  SYNTHETIC_GRAPH_BASE_ENV,
  type SyntheticGraphQuery,
  type SyntheticGraphRunReport,
} from '../../benchmark/runners/synthetic-graph-ablation.js';
import { assertSourceSnapshotUnchanged } from '../../benchmark/runners/source-snapshot.js';

const QUERY_IDS = ['q_multihop_01', 'q_multihop_02', 'q_multihop_03', 'q_multihop_04'];
const multiDocumentFixture = JSON.parse(readFileSync(resolve(
  process.cwd(),
  'benchmark/datasets/synthetic/graph-disambiguation-2026-10-25-v5.json',
), 'utf8')) as {
  memories: Array<{ id: string; content: string }>;
  queries: SyntheticGraphQuery[];
};

function fixtureQueries(): SyntheticGraphQuery[] {
  return QUERY_IDS.map((id, index) => ({
    id,
    category: 'multi-hop',
    query: `Synthetic question ${index + 1}`,
    mustHit: [`memory-${index + 1}`],
    mayHit: [],
  }));
}

function runReport(graphExpansion: boolean, overrides: Partial<SyntheticGraphRunReport> = {}): SyntheticGraphRunReport {
  const queries = fixtureQueries().map((query, index) => {
    const evidenceIds = graphExpansion && index === 0 ? ['memory-1', 'extra-on'] : [`memory-${index + 1}`];
    return {
      ...query,
      topK: 10,
      retrieved: evidenceIds.map((goldenId, evidenceIndex) => ({
        goldenId,
        contentSha256: String(evidenceIndex + 1).repeat(64),
        score: 0.9 - evidenceIndex * 0.1,
        estimatedTokens: 11 + evidenceIndex,
      })),
      recallAt5: graphExpansion ? 1 : 0.75,
      reciprocalRank: graphExpansion ? 1 : 0.5,
      hitAt1: graphExpansion || index !== 1,
      retrievalLatencyMs: graphExpansion ? 22 + index : 18 + index,
      estimatedReturnedContentTokens: graphExpansion ? 25 : 11,
    };
  });
  const precision = {
    reranker: false,
    temporalValidity: true,
    queryExpansion: false,
    graphExpansion,
  };
  const retrievalProfile = {
    profile: { name: 'fast-local', source: 'environment' },
    features: {
      reranker: { value: false, source: 'explicit' },
      queryExpansion: { value: false, source: 'explicit' },
      contextualEnrichment: { value: false, source: 'explicit' },
      graphExpansion: { value: graphExpansion, source: 'explicit' },
    },
    egress: { controlledBy: 'provider configuration', enabledByProfile: false },
  };
  return {
    protocol: 'squish-synthetic-multihop-graph-ablation-v1',
    generatedAt: '2026-10-23T00:00:00.000Z',
    graphExpansion,
    corpusMemoryCount: 60,
    datasetSha256: 'd'.repeat(64),
    pairInputSha256: 'e'.repeat(64),
    sourceSnapshotSha256AtStart: 'a'.repeat(64),
    sourceSnapshotSha256AtEnd: 'a'.repeat(64),
    runtime: { bunVersion: '1.4.1', nodeCompatibilityVersion: 'v26.3.0', platform: 'win32', architecture: 'x64' },
    config: {
      pinnedEnv: graphAblationEnvironment(graphExpansion),
      effective: {
        retrievalProfile,
        precision,
        graphBoost: { legacy: false },
        embeddingsProvider: 'local',
        bundledModel: 'off',
        modelDownloadsAllowed: false,
        hostedModelsEnabled: false,
        networkEgress: 'disabled-by-pinned-local-providers-and-model-gates',
      },
      topK: 10,
      retrievalMode: 'hybrid',
      concurrency: 1,
    },
    queries,
    metrics: {
      questionCount: 4,
      macroRecallAt5: graphExpansion ? 1 : 0.75,
      macroReciprocalRank: graphExpansion ? 1 : 0.5,
      hitRateAt1: graphExpansion ? 1 : 0.75,
      retrievalLatencyMs: { p50: graphExpansion ? 23 : 19, p95: graphExpansion ? 25 : 21, total: graphExpansion ? 94 : 78 },
      estimatedReturnedContentTokens: { total: graphExpansion ? 100 : 44, meanPerQuestion: graphExpansion ? 25 : 11 },
      modelTokens: 0,
      networkEgressBytes: 0,
    },
    ...overrides,
  };
}

describe('synthetic graph ablation scope and report safety', () => {
  test('refuses to start below the 1 GiB free-memory gate', () => {
    expect(() => assertMinimumFreeMemory(MINIMUM_FREE_MEMORY_BYTES - 1)).toThrow('at least 1 GiB');
    expect(() => assertMinimumFreeMemory(MINIMUM_FREE_MEMORY_BYTES)).not.toThrow();
    expect(() => assertMinimumFreeMemory(Number.NaN)).toThrow('at least 1 GiB');
  });

  test('pins offline CPU settings and makes graph expansion the only environment difference', () => {
    const off = graphAblationEnvironment(false);
    const on = graphAblationEnvironment(true);
    assertOfflineEnvironment(off);
    assertOfflineEnvironment(on);
    expect(off.SQUISH_GRAPH_EXPANSION).toBe('false');
    expect(on.SQUISH_GRAPH_EXPANSION).toBe('true');
    expect(Object.fromEntries(Object.entries(off).filter(([key]) => key !== 'SQUISH_GRAPH_EXPANSION')))
      .toEqual(Object.fromEntries(Object.entries(on).filter(([key]) => key !== 'SQUISH_GRAPH_EXPANSION')));
    expect(off).toMatchObject({
      SQUISH_EMBEDDINGS_PROVIDER: 'local',
      SQUISH_LOCAL_BUNDLED_MODEL: 'off',
      SQUISH_ALLOW_MODEL_DOWNLOADS: 'false',
      SQUISH_LLM_ENABLED: 'false',
      SQUISH_DECISION_MODEL_ENABLED: 'false',
      SQUISH_DECISION_HOSTED_EGRESS_ENABLED: 'false',
      SQUISH_MANAGED_AI_ENABLED: 'false',
      DATABASE_URL: '',
      SQUISH_DATABASE_URL: '',
    });
    expect(Object.keys(off)).toEqual(expect.arrayContaining(Object.keys(SYNTHETIC_GRAPH_BASE_ENV)));
  });

  test('rejects remote embedding, hosted model, and model download settings', () => {
    const remoteEmbedding = { ...graphAblationEnvironment(false), SQUISH_EMBEDDINGS_PROVIDER: 'remote' };
    const hostedModel = { ...graphAblationEnvironment(false), SQUISH_LLM_ENABLED: 'true' };
    const downloads = { ...graphAblationEnvironment(false), SQUISH_ALLOW_MODEL_DOWNLOADS: 'true' };
    expect(() => assertOfflineEnvironment(remoteEmbedding)).toThrow('pinned SQUISH_EMBEDDINGS_PROVIDER');
    expect(() => assertOfflineEnvironment(hostedModel)).toThrow('pinned SQUISH_LLM_ENABLED');
    expect(() => assertOfflineEnvironment(downloads)).toThrow('pinned SQUISH_ALLOW_MODEL_DOWNLOADS');
  });

  test('selects exactly the pinned four multi-hop questions independent of source ordering', () => {
    const selected = selectSyntheticMultiHopQueries([...fixtureQueries()].reverse());
    expect(selected.map(query => query.id)).toEqual(QUERY_IDS);
    expect(() => selectSyntheticMultiHopQueries(fixtureQueries().slice(1))).toThrow('missing a pinned multi-hop question');
    expect(() => selectSyntheticMultiHopQueries([...fixtureQueries(), {
      id: 'extra-multihop', category: 'multi-hop', query: 'unexpected', mustHit: ['memory-1'], mayHit: [],
    }])).toThrow('question scope changed');
  });

  test('supports a dataset-pinned multi-hop query set without changing the default fixture contract', () => {
    const customIds = ['q_custom_01', 'q_custom_02'];
    const customQueries = customIds.map((id, index) => ({
      id,
      category: 'multi-hop',
      query: `Custom synthetic question ${index + 1}`,
      mustHit: [`memory-${index + 1}`],
      mayHit: [],
    }));
    expect(selectSyntheticMultiHopQueries(customQueries, customIds).map(query => query.id)).toEqual(customIds);
    expect(DEFAULT_MULTI_HOP_QUERY_IDS).toEqual(QUERY_IDS);
  });

  test('keeps each synthetic multi-document question anchored to its project memory', () => {
    for (const query of multiDocumentFixture.queries) {
      const sequence = query.id.match(/^q_multidoc_(\d{3})$/)?.[1];
      expect(sequence).toBeDefined();
      const target = multiDocumentFixture.memories.find(memory => memory.id === `target_${sequence}`);
      expect(target).toBeDefined();
      const projectAnchor = target!.content.match(/^(.+?) stores deployment records in /)?.[1];
      expect(projectAnchor).toBeDefined();
      expect(query.query).toContain(projectAnchor!);
      expect(query.mustHit).toContain(`bridge_${sequence}`);
    }
  });

  test('rejects blank pinned multi-hop query text', () => {
    const queries = fixtureQueries();
    queries[0]!.query = '  ';
    expect(() => selectSyntheticMultiHopQueries(queries)).toThrow('blank multi-hop query');
  });

  test('pairs the same corpus, source, runtime, query order, and non-graph config; emits deltas', () => {
    const pair = compareSyntheticGraphReports(runReport(false), runReport(true));
    expect(pair.deltasGraphOnMinusOff).toEqual({
      macroRecallAt5: 0.25,
      macroReciprocalRank: 0.5,
      hitRateAt1: 0.25,
      p50LatencyMs: 4,
      p95LatencyMs: 4,
      estimatedReturnedContentTokens: 56,
    });
    expect(pair.pairedQuestions[0]).toEqual({
      id: 'q_multihop_01',
      recallAt5Delta: 0.25,
      reciprocalRankDelta: 0.5,
      hitAt1Delta: 0,
      evidenceOverlap: 1,
      graphOnAddedEvidenceIds: ['extra-on'],
      graphOnRemovedEvidenceIds: [],
      latencyDeltaMs: 4,
      estimatedTokenDelta: 14,
    });
    expect(pair.interpretation).toContain('not a real-world benchmark');
  });

  test('rejects dataset, source, runtime, configuration, budget, and label drift', () => {
    const changedDataset = runReport(true, { datasetSha256: 'f'.repeat(64) });
    expect(() => compareSyntheticGraphReports(runReport(false), changedDataset)).toThrow('dataset hash');
    const changedSource = runReport(true, { sourceSnapshotSha256AtStart: 'b'.repeat(64), sourceSnapshotSha256AtEnd: 'b'.repeat(64) });
    expect(() => compareSyntheticGraphReports(runReport(false), changedSource)).toThrow('source snapshot');
    const changedRuntime = runReport(true, { runtime: { ...runReport(true).runtime, platform: 'linux' } });
    expect(() => compareSyntheticGraphReports(runReport(false), changedRuntime)).toThrow('runtime identity');
    const changedProfile = runReport(true);
    changedProfile.config.pinnedEnv.SQUISH_QUERY_EXPANSION = 'true';
    expect(() => compareSyntheticGraphReports(runReport(false), changedProfile)).toThrow('pinned SQUISH_QUERY_EXPANSION');
    const changedBudget = runReport(true);
    changedBudget.config.topK = 9;
    expect(() => compareSyntheticGraphReports(runReport(false), changedBudget)).toThrow('budget scope mismatch');
    const changedLabels = runReport(true);
    changedLabels.queries[0]!.mustHit = ['different-memory'];
    expect(() => compareSyntheticGraphReports(runReport(false), changedLabels)).toThrow('must-hit labels');
    const dirtySource = runReport(true, { sourceSnapshotSha256AtEnd: 'c'.repeat(64) });
    expect(() => compareSyntheticGraphReports(runReport(false), dirtySource)).toThrow('source changed during run');
  });

  test('source snapshot publication guard rejects mid-run changes', () => {
    expect(() => assertSourceSnapshotUnchanged('a'.repeat(64), 'b'.repeat(64))).toThrow('source changed during evaluation');
    expect(() => assertSourceSnapshotUnchanged('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
  });
});
