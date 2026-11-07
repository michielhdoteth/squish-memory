import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareActionReports } from '../../benchmark/runners/compare-action-context.js';
import { createActionArtifactIntegrity } from '../../benchmark/runners/action-context-manifest.js';

function report() {
  const source = { gitSha: 'abc123', gitDirty: false, trackedDiffSha256: 'e'.repeat(64), sourceSnapshotSha256: 'f'.repeat(64) };
  const effectiveConfig = {
    profile: 'fast-local', embeddingsProvider: 'local', bundledModel: 'off',
    reranker: false, queryExpansion: false, graphExpansion: false,
    contextualRetrieval: false, taskProjectScope: 'unique-per-task',
    queryLimit: 'all-seeded-task-memories', modelCalls: false, networkEgress: false,
  };
  const value = {
    meta: {
      gitSha: 'abc123', gitDirty: false, trackedDiffSha256: 'e'.repeat(64), sourceSnapshotSha256: 'f'.repeat(64), datasetSha256: 'd'.repeat(64),
      sourceAtStart: { ...source }, sourceAtEnd: { ...source }, sourceStable: true,
      taskCount: 1, deterministic: true, model: null, modelTokens: 0,
      profile: 'fast-local', embeddingsProvider: 'local', modelDownloadsAllowed: false,
      effectiveConfig, artifactIntegrity: {} as Record<string, unknown>,
      protocol: 'paired-context-v1', generatedAt: 'first',
    },
    metrics: {
      contextOnAccuracy: 1, contextOffAccuracy: 0, pairedAccuracyDelta: 1,
      contextOnCorrect: 1, contextOffCorrect: 0, total: 1, evidenceSupportedActions: 1,
      expectedActionCount: 1, evidenceSupportedActionRate: 1, abstentionAccuracy: 1,
      negativeTransferRate: 0, actionOutcomeSha256: 'action-hash', retrievalTraceSha256: 'trace-hash',
      retrievalLatencyMs: { p50: 10, p95: 20 }, returnedTokens: 8, ingestedTokens: 8,
      modelTokens: 0, estimatedQueryCostUsd: 0, estimatedIngestionCostUsd: 0, networkEgressBytes: 0,
    },
    tasks: [{
      id: 'task-1', query: 'Which action?', projectScope: 'task-1', initialState: { state: 'old' },
      retrievedEvidence: [{ rank: 1, id: 'runtime-id-a', content: 'Set state to new.', score: 1, source: 'hybrid' }],
      retrievalLatencyMs: 10, returnedTokens: 8,
      chosenAction: { conditionField: 'state', conditionValue: 'old', targetField: 'state', targetValue: 'new' },
      chosenEvidenceRank: 1, abstained: false, expectedAction: { targetValue: 'new' }, evidenceSupported: true,
      contextOn: { finalState: { state: 'new' }, correct: true },
      contextOff: { finalState: { state: 'old' }, correct: false }, expectedState: { state: 'new' },
    }],
  };
  refreshTraceHashes(value);
  value.meta.artifactIntegrity = createActionArtifactIntegrity({
    sourceAtStart: value.meta.sourceAtStart,
    datasetSha256: value.meta.datasetSha256,
    effectiveConfig: value.meta.effectiveConfig,
    tasks: value.tasks,
  });
  return value;
}

function refreshTraceHashes(value: ReturnType<typeof report>): void {
  const actionTrace = value.tasks.map(task => ({
    id: task.id,
    chosenAction: task.chosenAction,
    abstained: task.abstained,
    finalState: task.contextOn.finalState,
    correct: task.contextOn.correct,
    evidenceSupported: task.evidenceSupported,
  }));
  const retrievalTrace = value.tasks.map(task => ({
    id: task.id,
    retrievedContent: task.retrievedEvidence.map(evidence => evidence.content),
    chosenAction: task.chosenAction,
    chosenEvidenceRank: task.chosenEvidenceRank,
    abstained: task.abstained,
    finalState: task.contextOn.finalState,
    correct: task.contextOn.correct,
    evidenceSupported: task.evidenceSupported,
  }));
  value.metrics.actionOutcomeSha256 = createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex');
  value.metrics.retrievalTraceSha256 = createHash('sha256').update(JSON.stringify(retrievalTrace)).digest('hex');
}

function refreshArtifactIntegrity(value: ReturnType<typeof report>): void {
  value.meta.artifactIntegrity = createActionArtifactIntegrity({
    sourceAtStart: value.meta.sourceAtStart,
    datasetSha256: value.meta.datasetSha256,
    effectiveConfig: value.meta.effectiveConfig,
    tasks: value.tasks,
  });
}

describe('action report repeatability comparison', () => {
  test('ignores runtime IDs, timestamps, and host timing but compares task outcomes and evidence', () => {
    const first = report();
    const second = report();
    second.meta.generatedAt = 'second';
    second.metrics.retrievalLatencyMs.p50 = 500;
    second.metrics.retrievalLatencyMs.p95 = 900;
    second.tasks[0]!.retrievalLatencyMs = 700;
    second.tasks[0]!.retrievedEvidence[0]!.id = 'runtime-id-b';
    second.tasks[0]!.retrievedEvidence[0]!.score = 1.00000003;
    refreshArtifactIntegrity(second);
    expect(compareActionReports(first, second)).toEqual({ equal: true, taskCount: 1, differences: [] });

    second.tasks[0]!.retrievedEvidence[0]!.content = 'Set state to wrong.';
    refreshTraceHashes(second);
    refreshArtifactIntegrity(second);
    const changed = compareActionReports(first, second);
    expect(changed.equal).toBe(false);
    expect(changed.differences).toContain('tasks.task-1');

    second.tasks[0]!.retrievedEvidence[0]!.content = 'Set state to new.';
    refreshTraceHashes(second);
    second.tasks[0]!.retrievedEvidence[0]!.score = 1.01;
    refreshArtifactIntegrity(second);
    expect(compareActionReports(first, second).differences).toContain('tasks.task-1');
  });

  test('requires matching source, dataset, and task outcome hashes', () => {
    const first = report();
    const second = report();
    second.meta.datasetSha256 = 'a'.repeat(64);
    second.tasks[0]!.chosenAction = { targetValue: 'different' };
    refreshTraceHashes(second);
    refreshArtifactIntegrity(second);
    const result = compareActionReports(first, second);
    expect(result.differences).toContain('meta.datasetSha256');
    expect(result.differences).toContain('metrics.actionOutcomeSha256');
  });

  test('does not certify matching reports produced from a tracked-dirty checkout', () => {
    const first = report();
    const second = report();
    first.meta.gitDirty = true;
    second.meta.gitDirty = true;
    first.meta.trackedDiffSha256 = 'a'.repeat(64);
    second.meta.trackedDiffSha256 = 'a'.repeat(64);
    first.meta.sourceAtStart.gitDirty = true;
    first.meta.sourceAtStart.trackedDiffSha256 = 'a'.repeat(64);
    first.meta.sourceAtEnd.gitDirty = true;
    first.meta.sourceAtEnd.trackedDiffSha256 = 'a'.repeat(64);
    second.meta.sourceAtStart.gitDirty = true;
    second.meta.sourceAtStart.trackedDiffSha256 = 'a'.repeat(64);
    second.meta.sourceAtEnd.gitDirty = true;
    second.meta.sourceAtEnd.trackedDiffSha256 = 'a'.repeat(64);

    refreshArtifactIntegrity(first);
    refreshArtifactIntegrity(second);

    const result = compareActionReports(first, second);
    expect(result.equal).toBe(false);
    expect(result.differences).toContain('first.meta.gitDirty');
    expect(result.differences).toContain('second.meta.gitDirty');
  });

  test('rejects a report whose source changed during evaluation', () => {
    const unstable = report();
    unstable.meta.sourceAtEnd = { ...unstable.meta.sourceAtEnd, trackedDiffSha256: 'a'.repeat(64) };
    unstable.meta.sourceStable = false;

    expect(() => compareActionReports(unstable, report())).toThrow('sourceStable must be true');
  });

  test('does not trust a stable flag that disagrees with the source snapshots', () => {
    const forged = report();
    forged.meta.sourceAtEnd.sourceSnapshotSha256 = 'a'.repeat(64);

    expect(() => compareActionReports(forged, report())).toThrow('inconsistent with its source snapshots');
  });

  test('rejects malformed filesystem source fingerprints', () => {
    const malformed = report();
    malformed.meta.sourceAtStart.sourceSnapshotSha256 = 'not-a-sha256';
    expect(() => compareActionReports(malformed, report())).toThrow('sourceAtStart is incomplete');
  });

  test('rejects reports without a boolean dirty-source marker', () => {
    const incomplete = report();
    delete incomplete.meta.gitDirty;
    expect(() => compareActionReports(incomplete, report())).toThrow('meta is missing gitDirty');

    const malformed = report();
    malformed.meta.gitDirty = 'false';
    expect(() => compareActionReports(malformed, report())).toThrow('meta.gitDirty must be a boolean');
  });

  test('rejects duplicate or incomplete task records', () => {
    const duplicate = report();
    duplicate.tasks.push({ ...duplicate.tasks[0]! });
    expect(() => compareActionReports(duplicate, duplicate)).toThrow('duplicate task IDs');

    const incomplete = report();
    delete incomplete.metrics.actionOutcomeSha256;
    expect(() => compareActionReports(incomplete, incomplete)).toThrow('metrics are missing actionOutcomeSha256');
  });

  test('rejects matching reports whose aggregate outcomes disagree with their task rows', () => {
    const first = report();
    const second = report();
    first.metrics.contextOnCorrect = 0;
    second.metrics.contextOnCorrect = 0;
    expect(() => compareActionReports(first, second)).toThrow('metrics.contextOnCorrect does not match task outcome rows');

    const malformed = report();
    malformed.tasks[0]!.contextOn.correct = 'true' as unknown as boolean;
    expect(() => compareActionReports(malformed, malformed)).toThrow('incomplete outcome labels');
  });

  test('rejects an action marked correct when its final state differs from the expected state', () => {
    const inconsistent = report();
    inconsistent.tasks[0]!.contextOn.finalState = { state: 'wrong' };
    refreshTraceHashes(inconsistent);
    refreshArtifactIntegrity(inconsistent);

    expect(() => compareActionReports(inconsistent, inconsistent)).toThrow(
      'contextOn.correct does not match finalState and expectedState',
    );
  });

  test('rejects matching reports whose trace hashes do not cover the task evidence rows', () => {
    const first = report();
    const second = report();
    first.tasks[0]!.retrievedEvidence[0]!.content = 'altered evidence';
    second.tasks[0]!.retrievedEvidence[0]!.content = 'altered evidence';

    expect(() => compareActionReports(first, second)).toThrow('retrievalTraceSha256 does not match task evidence rows');
  });

  test('verifies per-report source, dataset, config, ranked evidence, and task output fingerprints', () => {
    const first = report();
    expect(compareActionReports(first, report()).equal).toBe(true);
    const serialized = JSON.parse(JSON.stringify(first)) as unknown;
    expect(compareActionReports(serialized, report()).equal).toBe(true);

    const changedConfig = report();
    changedConfig.meta.effectiveConfig.reranker = true;
    expect(() => compareActionReports(changedConfig, report())).toThrow('artifact integrity manifest');

    const changedDataset = report();
    changedDataset.meta.datasetSha256 = 'different-dataset';
    expect(() => compareActionReports(changedDataset, report())).toThrow('artifact integrity manifest');

    const changedEvidence = report();
    changedEvidence.tasks[0]!.retrievedEvidence[0]!.content = 'different ranked evidence';
    refreshTraceHashes(changedEvidence);
    expect(() => compareActionReports(changedEvidence, report())).toThrow('artifact integrity manifest');

    const changedOutput = report();
    changedOutput.tasks[0]!.expectedState.state = 'tampered output';
    changedOutput.tasks[0]!.contextOn.finalState.state = 'tampered output';
    refreshTraceHashes(changedOutput);
    expect(() => compareActionReports(changedOutput, report())).toThrow('artifact integrity manifest');
  });

  test('does not certify archived runs without per-run source stability snapshots', () => {
    const first = JSON.parse(readFileSync(resolve('benchmark/reports/action-context-challenge-v1-2026-10-18-current-a.json'), 'utf8')) as unknown;
    const second = JSON.parse(readFileSync(resolve('benchmark/reports/action-context-challenge-v1-2026-10-18-current-b.json'), 'utf8')) as unknown;
    expect(() => compareActionReports(first, second)).toThrow('meta is missing sourceAtStart');
  });
});
