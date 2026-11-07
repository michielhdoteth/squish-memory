import { describe, expect, test } from 'bun:test';
import { compareBaselineReports } from '../../benchmark/runners/compare-locomo-baseline.js';

const DATASET_HASH = 'd'.repeat(64);
const SOURCE_HASH = 'a'.repeat(64);

function baselineReport(mode: 'lexical' | 'hybrid', overrides: Record<string, unknown> = {}) {
  const shared = {
    session: 2,
    memoryId: mode === 'lexical' ? 'lexical-run-id' : 'hybrid-run-id',
    contentSha256: 'c'.repeat(64),
    score: mode === 'hybrid' ? 0.9 : 0.7,
    semanticScore: 0.8,
    boostScore: mode === 'hybrid' ? 0.2 : 0,
    finalScore: mode === 'hybrid' ? 0.9 : 0.7,
    scoreBreakdown: { lexical: 0.7, graph: 0 },
  };
  const additional = {
    ...shared,
    session: 1,
    contentSha256: 'e'.repeat(64),
  };
  return {
    protocol: 'squish-locomo-session-evidence-retrieval-v5',
    config: {
      pinnedEnv: { SQUISH_PROFILE: 'fast-local', SQUISH_GRAPH_EXPANSION: 'false' },
      effective: {
        retrievalProfile: { features: { graphExpansion: { value: false, source: 'explicit' }, reranker: { value: false } } },
        precision: { graphExpansion: false, reranker: false },
      },
      topK: 2,
      limit: null,
      concurrency: 1,
      graphExpansion: false,
      retrievalMode: mode,
      evaluationClock: '2024-02-01T00:00:00.000Z',
      executionEnvironment: { bunVersion: '1.4.1', nodeCompatibilityVersion: 'v26.3.0', platform: 'linux', architecture: 'x64' },
    },
    provenance: {
      dataset: 'LoCoMo-10',
      datasetSha256: DATASET_HASH,
      sourceFingerprint: 'filesystem-snapshot-v1',
      sourceSnapshotSha256: SOURCE_HASH,
      sourceSnapshotSha256AtStart: SOURCE_HASH,
      sourceSnapshotSha256AtEnd: SOURCE_HASH,
    },
    counts: {
      personas: 1,
      personasSeeded: 1,
      questionsProcessed: 1,
      questionsScored: 1,
      questionsExcludedForIncompleteEvidence: 0,
      questionsExcludedByProtocol: 0,
    },
    metrics: {
      macroSessionRecallAtK: mode === 'hybrid' ? 1 : 0,
      sessionHitRateAtK: mode === 'hybrid' ? 1 : 0,
      microSessionRecallAtK: mode === 'hybrid' ? 1 : 0,
      topK: 2,
      retrievalLatencyMs: { p50: mode === 'hybrid' ? 20 : 10, p95: mode === 'hybrid' ? 30 : 15, totalWallMs: 40, questionsPerSecond: 25 },
    },
    traces: [{
      sampleId: 'persona-a',
      questionIndex: 7,
      question: 'What was the first event?',
      category: 1,
      expectedEvidence: ['D1:1'],
      expectedSessions: [1],
      evidenceComplete: true,
      retrieved: mode === 'hybrid' ? [shared, additional] : [shared],
      hitSessions: mode === 'hybrid' ? [1] : [],
      sessionRecall: mode === 'hybrid' ? 1 : 0,
      hit: mode === 'hybrid',
      scored: true,
      retrievalMs: mode === 'hybrid' ? 20 : 10,
    }],
    excludedQuestions: [],
    invalidEvidence: [],
    ...overrides,
  };
}

describe('LoCoMo lexical/hybrid baseline comparator', () => {
  test('pairs the modes and reports recall, evidence changes, and separate latency deltas', () => {
    const result = compareBaselineReports(baselineReport('lexical'), baselineReport('hybrid'));
    expect(result.deltasHybridMinusLexical).toEqual({ macroSessionRecallAtK: 1, microSessionRecallAtK: 1, sessionHitRateAtK: 1 });
    expect(result.evidence).toEqual({ overlap: 1, lexicalCount: 1, hybridCount: 2, hybridAdded: 1, hybridRemoved: 0, jaccard: 0.5 });
    expect(result.pairedQuestions[0]).toMatchObject({
      sessionRecallDeltaHybridMinusLexical: 1,
      hitDeltaHybridMinusLexical: 1,
      evidenceHybridAdded: [`1:${'e'.repeat(64)}`],
      latencyDeltaMsHybridMinusLexical: 10,
    });
    expect(result.lexical.metrics).not.toHaveProperty('retrievalLatencyMs');
    expect(result.lexical.latency).toHaveProperty('p50', 10);
    expect(result.interpretation).toContain('No confidence intervals, hypothesis tests, or statistical significance');
  });

  test('rejects source-hash and non-mode config drift', () => {
    const changedSource = baselineReport('hybrid');
    const changedHash = 'b'.repeat(64);
    changedSource.provenance = {
      ...changedSource.provenance,
      sourceSnapshotSha256: changedHash,
      sourceSnapshotSha256AtStart: changedHash,
      sourceSnapshotSha256AtEnd: changedHash,
    };
    expect(() => compareBaselineReports(baselineReport('lexical'), changedSource)).toThrow('provenance hashes/source identity');

    const changedConfig = baselineReport('hybrid');
    changedConfig.config = { ...changedConfig.config, topK: 3 };
    changedConfig.metrics = { ...changedConfig.metrics, topK: 3 };
    expect(() => compareBaselineReports(baselineReport('lexical'), changedConfig)).toThrow('config other than retrievalMode');
  });

  test('rejects count, question identity, and exclusion/reason drift', () => {
    const changedCount = baselineReport('hybrid');
    changedCount.counts = { ...changedCount.counts, personasSeeded: 2 };
    expect(() => compareBaselineReports(baselineReport('lexical'), changedCount)).toThrow('counts');

    const changedQuestion = baselineReport('hybrid');
    changedQuestion.traces[0]!.questionIndex = 8;
    expect(() => compareBaselineReports(baselineReport('lexical'), changedQuestion)).toThrow('question IDs');

    const lexical = baselineReport('lexical');
    lexical.counts = { ...lexical.counts, questionsExcludedByProtocol: 1 };
    lexical.excludedQuestions = [{ sampleId: 'persona-a', questionIndex: 9, reason: 'outside-limit' }];
    const hybrid = baselineReport('hybrid');
    hybrid.counts = { ...hybrid.counts, questionsExcludedByProtocol: 1 };
    hybrid.excludedQuestions = [{ sampleId: 'persona-a', questionIndex: 9, reason: 'invalid-category' }];
    expect(() => compareBaselineReports(lexical, hybrid)).toThrow('excluded question identities and reasons');
  });

  test('requires exactly one lexical and one hybrid full report with graph expansion off', () => {
    expect(() => compareBaselineReports(baselineReport('lexical'), baselineReport('lexical')))
      .toThrow('one lexical and one hybrid report');
    const graphOn = baselineReport('hybrid');
    graphOn.config = { ...graphOn.config, graphExpansion: true };
    expect(() => compareBaselineReports(baselineReport('lexical'), graphOn)).toThrow('graph expansion disabled');
    const partial = baselineReport('hybrid');
    partial.config = { ...partial.config, limit: 100 };
    expect(() => compareBaselineReports(baselineReport('lexical'), partial)).toThrow('full-corpus report');
  });
});
