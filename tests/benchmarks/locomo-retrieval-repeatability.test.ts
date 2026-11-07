import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareReports, parseReport } from '../../benchmark/runners/compare-locomo-retrieval.js';
import { writeUniqueReport } from '../../benchmark/runners/locomo-retrieval.js';

function report(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'squish-locomo-session-evidence-retrieval-v5',
    config: {
      topK: 2,
      concurrency: 1,
      evaluationClock: '2024-02-01T00:00:00.000Z',
      retrievalMode: 'lexical',
      graphExpansion: false,
      executionEnvironment: { bunVersion: '1.4.1', nodeCompatibilityVersion: 'v26.3.0', platform: 'linux', architecture: 'x64' },
    },
    provenance: {
      dataset: 'LoCoMo-10',
      datasetSha256: 'a'.repeat(64),
      sourceFingerprint: 'filesystem-snapshot-v1',
      sourceSnapshotSha256: 'b'.repeat(64),
      sourceSnapshotSha256AtStart: 'b'.repeat(64),
      sourceSnapshotSha256AtEnd: 'b'.repeat(64),
    },
    counts: {
      questionsProcessed: 1,
      questionsScored: 1,
      questionsExcludedForIncompleteEvidence: 0,
      questionsExcludedByProtocol: 0,
    },
    metrics: {
      macroSessionRecallAtK: 1,
      sessionHitRateAtK: 1,
      microSessionRecallAtK: 1,
      topK: 2,
      retrievalLatencyMs: { p50: 10, p95: 20, totalWallMs: 30, questionsPerSecond: 33 },
    },
    traces: [{
      sampleId: 'persona-1',
      questionIndex: 4,
      question: 'Where did they meet?',
      category: 1,
      expectedEvidence: ['D1:1'],
      expectedSessions: [1],
      evidenceComplete: true,
      retrieved: [{
        session: 1,
        memoryId: 'run-specific-id',
        contentSha256: 'content-hash',
        score: 0.9,
        semanticScore: 0.8,
        boostScore: 0.1,
        finalScore: 0.9,
        scoreBreakdown: { lexical: 0.8, recency: 0.1 },
      }],
      hitSessions: [1],
      sessionRecall: 1,
      hit: true,
      scored: true,
      retrievalMs: 10,
    }],
    invalidEvidence: [],
    excludedQuestions: [],
    ...overrides,
  };
}

describe('LoCoMo retrieval report repeatability comparison', () => {
  test('preserves an existing report when two runs choose the same timestamped name', () => {
    const testDir = mkdtempSync(join(import.meta.dir, '.tmp-report-write-'));
    try {
      const original = join(testDir, 'run.json');
      writeFileSync(original, 'first report\n', 'utf8');

      const path = writeUniqueReport(testDir, 'run', { run: 2 });

      expect(path).toBe(join(testDir, 'run-1.json'));
      expect(readFileSync(original, 'utf8')).toBe('first report\n');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ run: 2 });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('ignores generated memory IDs and host timing while checking pinned retrieval evidence', () => {
    const first = report();
    const second = report();
    second.metrics.retrievalLatencyMs.p50 = 300;
    second.metrics.retrievalLatencyMs.p95 = 500;
    second.metrics.retrievalLatencyMs.totalWallMs = 900;
    second.metrics.retrievalLatencyMs.questionsPerSecond = 1;
    second.traces[0]!.retrieved[0]!.memoryId = 'different-run-id';
    second.traces[0]!.retrievalMs = 300;

    const result = compareReports(parseReport(first), parseReport(second));
    expect(result.equal).toBe(true);
    expect(result.traceCount).toBe(1);
    expect(result.evidenceSlotsCompared).toBe(1);
  });

  test('fails when ranking order, score components, outcomes, or provenance changes', () => {
    const first = report();
    const changed = report();
    changed.provenance = { ...changed.provenance, datasetSha256: 'c'.repeat(64) };
    changed.traces[0]!.hit = false;
    changed.traces[0]!.hitSessions = [];
    changed.traces[0]!.sessionRecall = 0;
    changed.traces[0]!.retrieved[0]!.session = 2;
    changed.traces[0]!.retrieved[0]!.score = 0.7;
    changed.traces[0]!.retrieved[0]!.scoreBreakdown = { lexical: 0.6, recency: 0.1 };
    changed.metrics.macroSessionRecallAtK = 0;
    changed.metrics.sessionHitRateAtK = 0;
    changed.metrics.microSessionRecallAtK = 0;

    const result = compareReports(parseReport(first), parseReport(changed));
    expect(result.equal).toBe(false);
    expect(result.traceDifferences).toBe(1);
    expect(result.scoreDifferences).toBe(1);
    expect(result.differences).toContain('provenance');
    expect(result.differences).toContain('trace outcomes or evidence order');
    expect(result.differences).toContain('retrieved score vectors');
  });

  test('fails when protocol-excluded question identities or reasons change', () => {
    const first = report({
      counts: {
        questionsProcessed: 1,
        questionsScored: 1,
        questionsExcludedForIncompleteEvidence: 0,
        questionsExcludedByProtocol: 1,
      },
      excludedQuestions: [{ sampleId: 'persona-2', questionIndex: 8, reason: 'outside-limit' }],
    });
    const changed = report({
      counts: {
        questionsProcessed: 1,
        questionsScored: 1,
        questionsExcludedForIncompleteEvidence: 0,
        questionsExcludedByProtocol: 1,
      },
      excludedQuestions: [{ sampleId: 'persona-3', questionIndex: 8, reason: 'outside-limit' }],
    });

    const result = compareReports(parseReport(first), parseReport(changed));
    expect(result.equal).toBe(false);
    expect(result.differences).toContain('excludedQuestions');

    const changedReason = report({
      counts: {
        questionsProcessed: 1,
        questionsScored: 1,
        questionsExcludedForIncompleteEvidence: 0,
        questionsExcludedByProtocol: 1,
      },
      excludedQuestions: [{ sampleId: 'persona-2', questionIndex: 8, reason: 'missing-evidence' }],
    });
    const reasonResult = compareReports(parseReport(first), parseReport(changedReason));
    expect(reasonResult.equal).toBe(false);
    expect(reasonResult.differences).toContain('excludedQuestions');
  });

  test('rejects lexical graph expansion and treats retrieval mode as comparator identity', () => {
    const invalidLexicalConfig = report({
      config: { ...report().config, graphExpansion: true },
    });
    expect(() => parseReport(invalidLexicalConfig)).toThrow('Lexical report config cannot enable graph expansion');

    const lexical = report();
    const hybrid = report({
      config: { ...report().config, retrievalMode: 'hybrid' },
    });
    const comparison = compareReports(parseReport(lexical), parseReport(hybrid));
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toContain('config');
  });

  test('refuses parallel sensitivity reports as serial repeatability evidence', () => {
    const parallel = report({ config: { ...report().config, concurrency: 4 } });
    expect(() => parseReport(parallel)).toThrow('Repeatability comparison requires serial protocol-v5 reports');
  });

  test('treats a source question identity change as a repeatability failure', () => {
    const first = report();
    const changed = report();
    changed.traces[0]!.questionIndex = 5;
    const result = compareReports(parseReport(first), parseReport(changed));
    expect(result.equal).toBe(false);
    expect(result.differences).toContain('trace outcomes or evidence order');
  });

  test('treats a change in retrieved content order as a repeatability failure', () => {
    const first = report();
    const changed = report();
    const original = changed.traces[0]!.retrieved[0]!;
    const additional = { ...original, contentSha256: 'other-content-hash', session: 2, memoryId: 'another-id' };
    changed.traces[0]!.retrieved.push(additional);
    first.traces[0]!.retrieved.push({ ...additional, contentSha256: 'third-content-hash', session: 3 });
    changed.traces[0]!.retrieved.reverse();

    const result = compareReports(parseReport(first), parseReport(changed));
    expect(result.equal).toBe(false);
    expect(result.differences).toContain('trace outcomes or evidence order');
    expect(result.differences).toContain('retrieved score vectors');
  });

  test('refuses incomplete or non-v5 reports', () => {
    expect(() => parseReport({ ...report(), protocol: 'squish-locomo-session-evidence-retrieval-v4' })).toThrow('Expected protocol squish-locomo-session-evidence-retrieval-v5');
    expect(() => parseReport({ ...report(), traces: [{ question: 'missing fields' }] })).toThrow('traces[0].sampleId');
  });

  test('requires and compares exact execution-runtime identity', () => {
    const incomplete = report();
    delete (incomplete.config as Record<string, unknown>).executionEnvironment;
    expect(() => parseReport(incomplete)).toThrow('config.executionEnvironment');

    const changedRuntime = report({
      config: {
        ...report().config,
        executionEnvironment: { bunVersion: '1.4.2', nodeCompatibilityVersion: 'v26.3.0', platform: 'linux', architecture: 'x64' },
      },
    });
    const comparison = compareReports(parseReport(report()), parseReport(changedRuntime));
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toContain('config');
  });

  test('rejects reports without verifiable dataset and unchanged-source provenance', () => {
    const missingHashes = report({ provenance: null });
    expect(() => parseReport(missingHashes)).toThrow('Report provenance must include valid LoCoMo-10 dataset');

    const changedDuringRun = report({
      provenance: {
        ...report().provenance,
        sourceSnapshotSha256AtEnd: 'c'.repeat(64),
      },
    });
    expect(() => parseReport(changedDuringRun)).toThrow('Report provenance must include valid LoCoMo-10 dataset');

    const malformedDatasetHash = report({
      provenance: { ...report().provenance, datasetSha256: 'not-a-sha256' },
    });
    expect(() => parseReport(malformedDatasetHash)).toThrow('Report provenance must include valid LoCoMo-10 dataset');
  });

  test('refuses duplicated question identities and trace/count mismatches', () => {
    const duplicated = report();
    duplicated.traces.push({ ...duplicated.traces[0]! });
    duplicated.counts = { ...duplicated.counts, questionsProcessed: 2, questionsScored: 2 };
    expect(() => parseReport(duplicated)).toThrow('Duplicate trace identity');

    const missingRow = report();
    missingRow.counts = { ...missingRow.counts, questionsProcessed: 2 };
    expect(() => parseReport(missingRow)).toThrow('Report question counts do not match trace rows');
  });

  test('rejects aggregate scores that do not follow the trace evidence', () => {
    const forgedMetric = report();
    forgedMetric.metrics = { ...forgedMetric.metrics, macroSessionRecallAtK: 0 };
    expect(() => parseReport(forgedMetric)).toThrow('metrics.macroSessionRecallAtK does not match trace rows');

    const forgedTrace = report();
    forgedTrace.traces[0]!.hitSessions = [];
    expect(() => parseReport(forgedTrace)).toThrow('hit labels do not match retrieved and expected sessions');
  });

  test('rejects traces that exceed topK or repeat a session in the ranked list', () => {
    const oversized = report();
    const result = { ...oversized.traces[0]!.retrieved[0]!, session: 2 };
    oversized.traces[0]!.retrieved.push(result, { ...result, session: 3 });
    expect(() => parseReport(oversized)).toThrow('retrieved exceeds configured topK');

    const duplicateSession = report();
    duplicateSession.traces[0]!.retrieved.push({
      ...duplicateSession.traces[0]!.retrieved[0]!,
      contentSha256: 'different-content',
    });
    expect(() => parseReport(duplicateSession)).toThrow('retrieved contains duplicate sessions');
  });

  test('validates direct comparator inputs instead of trusting the Report type', () => {
    const malformed = parseReport(report());
    malformed.traces.push({ ...malformed.traces[0]! });

    expect(() => compareReports(malformed, parseReport(report()))).toThrow('Duplicate trace identity');
  });
});
