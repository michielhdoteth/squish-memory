import { describe, expect, test } from 'bun:test';
import { compareGraphAblationReports } from '../../benchmark/runners/compare-locomo-graph-ablation.js';

const DATASET_HASH = 'd'.repeat(64);
const SOURCE_HASH = 'a'.repeat(64);

function graphReport(enabled: boolean, overrides: Record<string, unknown> = {}) {
  const stableEvidence = {
    session: enabled ? 1 : 2,
    memoryId: enabled ? 'run-on-id' : 'run-off-id',
    contentSha256: '1'.repeat(64),
    score: enabled ? 0.95 : 0.8,
    semanticScore: 0.8,
    boostScore: enabled ? 0.15 : 0,
    finalScore: enabled ? 0.95 : 0.8,
    scoreBreakdown: { lexical: 0.8, graph: enabled ? 0.15 : 0 },
  };
  const changedEvidence = {
    session: 3,
    memoryId: enabled ? 'run-on-other-id' : 'run-off-other-id',
    contentSha256: '2'.repeat(64),
    score: 0.4,
    semanticScore: 0.4,
    boostScore: 0,
    finalScore: 0.4,
    scoreBreakdown: { lexical: 0.4, graph: 0 },
  };
  const sharedExcludedEvidence = {
    session: 4,
    memoryId: 'run-shared-excluded-id',
    contentSha256: '4'.repeat(64),
    score: 0.2,
    semanticScore: 0.2,
    boostScore: 0,
    finalScore: 0.2,
    scoreBreakdown: { lexical: 0.2, graph: 0 },
  };
  return {
    protocol: 'squish-locomo-session-evidence-retrieval-v5',
    config: {
      pinnedEnv: { SQUISH_PROFILE: 'fast-local', SQUISH_GRAPH_EXPANSION: String(enabled) },
      effective: {
        retrievalProfile: { features: { graphExpansion: { value: enabled, source: 'explicit' }, reranker: { value: false } } },
        precision: { graphExpansion: enabled, reranker: false },
        scoringWeights: { graphBoost: 0.1 },
      },
      topK: 2,
      limit: null,
      concurrency: 1,
      graphExpansion: enabled,
      retrievalMode: 'hybrid',
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
      questionsProcessed: 2,
      questionsScored: 1,
      questionsExcludedForIncompleteEvidence: 1,
      questionsExcludedByProtocol: 0,
      evidenceLabelsWithUnmappedOrUnseededReferences: 1,
    },
    metrics: {
      macroSessionRecallAtK: enabled ? 1 : 0,
      sessionHitRateAtK: enabled ? 1 : 0,
      microSessionRecallAtK: enabled ? 1 : 0,
      topK: 2,
      retrievalLatencyMs: { p50: enabled ? 15 : 10, p95: enabled ? 30 : 20, totalWallMs: enabled ? 80 : 60, questionsPerSecond: enabled ? 25 : 33 },
    },
    traces: [
      {
        sampleId: 'persona-1',
        questionIndex: 4,
        question: 'Where did they meet?',
        category: 1,
        expectedEvidence: ['D1:1'],
        expectedSessions: [1],
        evidenceComplete: true,
        retrieved: [stableEvidence, ...(enabled ? [] : [changedEvidence])],
        hitSessions: enabled ? [1] : [],
        sessionRecall: enabled ? 1 : 0,
        hit: enabled,
        scored: true,
        retrievalMs: enabled ? 17 : 11,
      },
      {
        sampleId: 'persona-1',
        questionIndex: 5,
        question: 'What was the unlabeled detail?',
        category: 2,
        expectedEvidence: ['unmapped'],
        expectedSessions: [],
        evidenceComplete: false,
        retrieved: [sharedExcludedEvidence],
        hitSessions: [],
        sessionRecall: null,
        hit: false,
        scored: false,
        retrievalMs: enabled ? 19 : 13,
      },
    ],
    excludedQuestions: [],
    invalidEvidence: [{ sampleId: 'persona-1', questionIndex: 5, reason: 'unmapped_evidence_fragment' }],
    ...overrides,
  };
}

describe('LoCoMo graph ablation comparator', () => {
  test('allows only the graph toggle and reports paired descriptive quality, evidence, and latency', () => {
    const comparison = compareGraphAblationReports(graphReport(false), graphReport(true));
    expect(comparison.protocol).toBe('squish-locomo-graph-ablation-descriptive-v1');
    expect(comparison.deltasGraphOnMinusOff).toEqual({
      macroSessionRecallAtK: 1,
      microSessionRecallAtK: 1,
      sessionHitRateAtK: 1,
    });
    expect(comparison.evidence).toEqual({
      overlap: 1,
      graphOffCount: 3,
      graphOnCount: 2,
      graphOnAdded: 1,
      graphOnRemoved: 2,
      jaccard: 1 / 4,
    });
    expect(comparison.pairedQuestions[0]).toMatchObject({
      sessionRecallDeltaGraphOnMinusOff: 1,
      hitDeltaGraphOnMinusOff: 1,
      evidenceGraphOnAdded: [`1:${'1'.repeat(64)}`],
      evidenceGraphOnRemoved: [`2:${'1'.repeat(64)}`, `3:${'2'.repeat(64)}`],
      latencyDeltaMsGraphOnMinusOff: 6,
    });
    expect(comparison.questionLatency).toEqual({ graphOnFaster: 0, graphOffFaster: 2, tied: 0, pairedCount: 2 });
    expect(comparison.interpretation).toContain('No confidence intervals, hypothesis tests, or statistical significance');
  });

  test('rejects dataset or source hash drift', () => {
    const changed = graphReport(true);
    changed.provenance = { ...changed.provenance, datasetSha256: 'e'.repeat(64) };
    expect(() => compareGraphAblationReports(graphReport(false), changed)).toThrow('provenance hashes/source identity');
    const changedSource = graphReport(true);
    const changedHash = 'b'.repeat(64);
    changedSource.provenance = {
      ...changedSource.provenance,
      sourceSnapshotSha256: changedHash,
      sourceSnapshotSha256AtStart: changedHash,
      sourceSnapshotSha256AtEnd: changedHash,
    };
    expect(() => compareGraphAblationReports(graphReport(false), changedSource)).toThrow('provenance hashes/source identity');
  });

  test('rejects non-graph config changes, including mode, budget, and effective settings', () => {
    const changedProfile = graphReport(true);
    changedProfile.config.pinnedEnv = { ...changedProfile.config.pinnedEnv, SQUISH_PROFILE: 'high-recall' };
    expect(() => compareGraphAblationReports(graphReport(false), changedProfile)).toThrow('config other than graph expansion');
    const changedBudget = graphReport(true);
    changedBudget.config = { ...changedBudget.config, topK: 3 };
    changedBudget.metrics = { ...changedBudget.metrics, topK: 3 };
    expect(() => compareGraphAblationReports(graphReport(false), changedBudget)).toThrow('config other than graph expansion');
    const changedEffective = graphReport(true);
    changedEffective.config.effective = {
      ...changedEffective.config.effective,
      precision: { ...changedEffective.config.effective.precision, reranker: true },
    };
    expect(() => compareGraphAblationReports(graphReport(false), changedEffective)).toThrow('config other than graph expansion');
    const lexical = graphReport(false);
    lexical.config = { ...lexical.config, retrievalMode: 'lexical' };
    expect(() => compareGraphAblationReports(graphReport(false), lexical)).toThrow('retrievalMode=hybrid');
  });

  test('rejects changed counts, scored question identities, and exclusion reasons', () => {
    const changedCounts = graphReport(true);
    changedCounts.counts = { ...changedCounts.counts, questionsScored: 2 };
    expect(() => compareGraphAblationReports(graphReport(false), changedCounts)).toThrow('Report question counts do not match trace rows');

    const changedIds = graphReport(true);
    changedIds.traces[0]!.questionIndex = 8;
    expect(() => compareGraphAblationReports(graphReport(false), changedIds)).toThrow('question IDs');

    const changedReason = graphReport(true);
    changedReason.invalidEvidence = [{ sampleId: 'persona-1', questionIndex: 5, reason: 'empty_evidence_label' }];
    expect(() => compareGraphAblationReports(graphReport(false), changedReason)).toThrow('invalid evidence identities and reasons');

    const offExcluded = graphReport(false);
    offExcluded.counts = { ...offExcluded.counts, questionsExcludedByProtocol: 1 };
    offExcluded.excludedQuestions = [{ sampleId: 'persona-1', questionIndex: 9, reason: 'outside-scope' }];
    const onExcluded = graphReport(true);
    onExcluded.counts = { ...onExcluded.counts, questionsExcludedByProtocol: 1 };
    onExcluded.excludedQuestions = [{ sampleId: 'persona-1', questionIndex: 9, reason: 'invalid-category' }];
    expect(() => compareGraphAblationReports(offExcluded, onExcluded)).toThrow('excluded question identities and reasons');
  });

  test('requires one graph-off and one graph-on full report', () => {
    expect(() => compareGraphAblationReports(graphReport(false), graphReport(false)))
      .toThrow('one graph-off and one graph-on report');
    const partial = graphReport(true);
    partial.config = { ...partial.config, limit: 100 };
    expect(() => compareGraphAblationReports(graphReport(false), partial))
      .toThrow('full-corpus report');
  });
});
