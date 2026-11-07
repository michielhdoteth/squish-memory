import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runLoCoMoRetrieval } from '../../benchmark/runners/locomo-retrieval.js';

const runner = readFileSync(new URL('../../benchmark/runners/locomo-retrieval.ts', import.meta.url), 'utf8');
const memoryHelper = readFileSync(new URL('../../benchmark/runners/locomo-memory.ts', import.meta.url), 'utf8');

describe('LoCoMo retrieval diagnostic protocol', () => {
  test('defaults to serial queries and labels parallel runs sensitivity-only', () => {
    expect(runner).toContain("positiveInteger(options?.concurrency, 'concurrency', 1)");
    expect(runner).toContain('concurrency above one is a separately labeled sensitivity run');
    expect(runner).toContain("SQUISH_PROFILE: 'fast-local'");
    expect(runner).toContain("retrievalMode?: 'lexical' | 'hybrid'");
    expect(runner).toContain("process.env.SQUISH_GRAPH_EXPANSION = String(graphExpansion)");
    expect(runner).toContain("pinnedEnv: { ...PINNED_OFFLINE_ENV, SQUISH_GRAPH_EXPANSION: String(graphExpansion) }");
    expect(runner).toContain("--graph-expansion must be on or off");
    expect(runner).toContain("SQUISH_RERANKER_ENABLED: 'false'");
    expect(runner).toContain("SQUISH_DECISION_LAYER_ENABLED: 'false'");
    expect(runner).toContain("SQUISH_LLM_REWRITE: 'false'");
    expect(runner).toContain("SQUISH_QUERY_PARSER: 'false'");
    expect(runner).toContain("SQUISH_VECTOR_SCAN: 'full'");
    expect(runner).toContain("sourceFingerprint: 'filesystem-snapshot-v1'");
    expect(runner).toContain('const sourceSnapshotAtStart = sourceSnapshotSha256(root)');
    expect(runner).toContain('const sourceSnapshotAtEnd = sourceSnapshotSha256(root)');
    expect(runner).toContain('sourceSnapshotSha256: sourceSnapshotAtStart');
    expect(runner).toContain('sourceSnapshotSha256AtEnd: null');
    expect(runner).toContain('assertSourceSnapshotUnchanged(sourceSnapshotAtStart, sourceSnapshotAtEnd)');
    expect(runner.indexOf('assertSourceSnapshotUnchanged(sourceSnapshotAtStart, sourceSnapshotAtEnd)'))
      .toBeLessThan(runner.indexOf('writeUniqueReport(reportDir, slug, report)'));
    expect(runner).not.toContain("from 'node:child_process'");
    expect(runner).not.toContain("['rev-parse', 'HEAD']");
    expect(runner).not.toContain("['diff', 'HEAD', '--']");
    expect(runner).toContain('effective: {');
    expect(runner).toContain('scoringSchemaVersion: SCORING_SCHEMA_VERSION');
    expect(runner).toContain("protocol: 'squish-locomo-session-evidence-retrieval-v5'");
    expect(runner).toContain('bunVersion: process.versions.bun ?? null');
    expect(runner).toContain('nodeCompatibilityVersion: process.version');
    expect(runner).toContain('retrievePersonaSessions(runtime, qa.question, project, sessionByMemoryId, topK, retrievalMode)');
    expect(runner).toContain('retrievalMode,');
    expect(runner).toContain("retrievalMode?: 'lexical' | 'hybrid'");
    expect(runner).toContain('--retrieval-mode=lexical|hybrid');
    expect(runner).toContain('graph expansion cannot be enabled with lexical retrieval mode');
    expect(runner).toContain("createdAtPolicy: 'conversation_session_date_utc'");
    expect(runner).toContain('evaluationClock: LOCOMO_EVALUATION_TIME');
    expect(runner).toContain('withLoCoMoEvaluationClock(() => Promise.all');
    expect(runner).toContain('useSessionDateAsCreatedAt: true');
    expect(runner).toContain('for (const [key, value] of previous)');
    expect(memoryHelper).toContain('contentSha256');
    expect(memoryHelper).toContain('semanticScore: result.semanticScore ?? null');
    expect(memoryHelper).toContain('scoreBreakdown: result.scoreBreakdown ?? {}');
    expect(memoryHelper).toContain('parseLoCoMoSessionDate(session.date)');
  });

  test('rejects graph expansion for lexical mode before opening an evaluation database', async () => {
    await expect(runLoCoMoRetrieval({ retrievalMode: 'lexical', graphExpansion: true }))
      .rejects.toThrow('graph expansion cannot be enabled with lexical retrieval mode');
  });
});
