#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { estimateTokens } from '../../core/context/context-window.js';
import { getRetrievalProfile } from '../../core/retrieval/profiles.js';
import { withIsolatedBenchmarkDatabase } from './isolated-db.js';
import { createActionArtifactIntegrity } from './action-context-manifest.js';
import { sourceSnapshotSha256 } from './source-snapshot.js';
import { applySandboxAction, parseMemoryAction, statesEqual, type SandboxAction } from '../scoring/action-task.js';
import { hasTrackedSourceChanges } from '../source-provenance.js';

interface Task {
  id: string;
  query: string;
  memories: string[];
  initialState: Record<string, string>;
  expectedState: Record<string, string>;
  expectedAction: SandboxAction | null;
  evidenceIndex: number | null;
}
interface Dataset { meta: Record<string, unknown>; tasks: Task[] }

interface SourceSnapshot {
  gitSha: string;
  gitDirty: boolean;
  trackedDiffSha256: string;
  sourceSnapshotSha256: string;
}

function sourceProvenance(): SourceSnapshot {
  const gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD']);
  const gitDirty = hasTrackedSourceChanges();
  if (gitDirty === null) throw new Error('Unable to determine tracked-source state; benchmark aborted');
  return {
    gitSha,
    gitDirty,
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
    sourceSnapshotSha256: sourceSnapshotSha256(process.cwd()),
  };
}

function sameSourceSnapshot(first: SourceSnapshot, second: SourceSnapshot): boolean {
  return first.gitSha === second.gitSha
    && first.gitDirty === second.gitDirty
    && first.trackedDiffSha256 === second.trackedDiffSha256
    && first.sourceSnapshotSha256 === second.sourceSnapshotSha256;
}
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0;
}
function actionEqual(a: SandboxAction | null, b: SandboxAction | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] ?? '' : 'benchmark/reports/action-context-heldout-v1.json');
  if (!outPath) throw new Error('--out requires a path');
  const datasetPath = resolve('benchmark/datasets/actions/action-context-challenge-v1.json');
  const datasetText = readFileSync(datasetPath, 'utf8');
  const dataset = JSON.parse(datasetText) as Dataset;
  if (dataset.tasks.length < 10 || dataset.meta.split !== 'frozen_challenge') throw new Error('Expected a frozen challenge dataset with at least 10 tasks');
  const ids = new Set<string>();
  for (const task of dataset.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    ids.add(task.id);
    if (!task.memories.length || task.evidenceIndex !== null && (task.evidenceIndex < 0 || task.evidenceIndex >= task.memories.length)) throw new Error(`Invalid evidence fixture: ${task.id}`);
    if ((task.expectedAction === null) !== (task.evidenceIndex === null)) throw new Error(`Action/evidence labels disagree: ${task.id}`);
  }

  const originalEnv = { profile: process.env.SQUISH_PROFILE, embeddings: process.env.SQUISH_EMBEDDINGS_PROVIDER, bundled: process.env.SQUISH_LOCAL_BUNDLED_MODEL, reranker: process.env.SQUISH_RERANKER_ENABLED, expansion: process.env.SQUISH_QUERY_EXPANSION, graph: process.env.SQUISH_GRAPH_EXPANSION, contextual: process.env.SQUISH_CONTEXTUAL_RETRIEVAL };
  process.env.SQUISH_PROFILE = 'fast-local';
  process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
  process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
  process.env.SQUISH_RERANKER_ENABLED = 'false';
  process.env.SQUISH_QUERY_EXPANSION = 'false';
  process.env.SQUISH_GRAPH_EXPANSION = 'false';
  process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'false';
  const effectiveConfig = {
    profile: getRetrievalProfile().name,
    embeddingsProvider: 'local',
    bundledModel: 'off',
    reranker: false,
    queryExpansion: false,
    graphExpansion: false,
    contextualRetrieval: false,
    taskProjectScope: 'unique-per-task',
    queryLimit: 'all-seeded-task-memories',
    modelCalls: false,
    networkEgress: false,
  };

  try {
    const sourceAtStart = sourceProvenance();
    const report = await withIsolatedBenchmarkDatabase(async () => {
      const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
      const client = new SquishRuntime();
      const latencies: number[] = [];
      const rows: Array<Record<string, unknown>> = [];
      const retrievalTrace: Array<Record<string, unknown>> = [];
      const actionTrace: Array<Record<string, unknown>> = [];
      let contextCorrect = 0;
      let baselineCorrect = 0;
      let supported = 0;
      let expectedActionCount = 0;
      let abstentionCorrect = 0;
      let negativeTransfers = 0;
      let returnedTokens = 0;
      let ingestedTokens = 0;

      for (const task of dataset.tasks) {
        const project = `action-heldout:${task.id}`;
        for (let index = 0; index < task.memories.length; index++) {
          const memory = task.memories[index]!;
          ingestedTokens += estimateTokens(memory);
          await client.remember(memory, { type: 'context', project, metadata: { sourceId: `action-heldout:${task.id}:${index}`, observedAt: '2026-10-16T00:00:00.000Z' } });
        }
        const start = performance.now();
        const results = await client.search(task.query, { limit: task.memories.length, project });
        const latencyMs = performance.now() - start;
        latencies.push(latencyMs);
        const retrieved = results.map((result) => ({ id: result.memory.id, content: result.memory.content, score: result.score, source: result.source }));
        const contents = retrieved.map((item) => item.content);
        const rowTokens = contents.reduce((sum, content) => sum + estimateTokens(content), 0);
        returnedTokens += rowTokens;

        let chosen: SandboxAction | null = null;
        let chosenIndex: number | null = null;
        for (let index = 0; index < contents.length; index++) {
          const candidate = parseMemoryAction(contents[index]!);
          if (candidate && task.initialState[candidate.conditionField] === candidate.conditionValue) {
            chosen = candidate;
            chosenIndex = index;
            break;
          }
        }
        const finalState = chosen ? applySandboxAction(task.initialState, chosen) : { ...task.initialState };
        const correct = finalState !== null && statesEqual(finalState, task.expectedState);
        const evidenceSupported = chosen !== null && actionEqual(chosen, task.expectedAction) && retrieved[chosenIndex!]?.content === task.memories[task.evidenceIndex!];
        if (task.expectedAction !== null) expectedActionCount++;
        const abstained = chosen === null;
        const baselineState = { ...task.initialState };
        const baselineIsCorrect = statesEqual(baselineState, task.expectedState);
        if (correct) contextCorrect++;
        if (baselineIsCorrect) baselineCorrect++;
        if (evidenceSupported) supported++;
        if (abstained === (task.expectedAction === null)) abstentionCorrect++;
        if (!correct && baselineIsCorrect) negativeTransfers++;
        rows.push({ id: task.id, query: task.query, projectScope: project, initialState: task.initialState, retrievedEvidence: retrieved.map((item, rank) => ({ rank: rank + 1, ...item })), retrievalLatencyMs: Number(latencyMs.toFixed(3)), returnedTokens: rowTokens, chosenAction: chosen, chosenEvidenceRank: chosenIndex === null ? null : chosenIndex + 1, abstained, expectedAction: task.expectedAction, evidenceSupported, contextOn: { finalState, correct }, contextOff: { action: null, abstained: true, finalState: baselineState, correct: baselineIsCorrect }, expectedState: task.expectedState });
        retrievalTrace.push({ id: task.id, retrievedContent: contents, chosenAction: chosen, chosenEvidenceRank: chosenIndex === null ? null : chosenIndex + 1, abstained, finalState, correct, evidenceSupported });
        actionTrace.push({ id: task.id, chosenAction: chosen, abstained, finalState, correct, evidenceSupported });
      }
      const total = dataset.tasks.length;
      const contextOnAccuracy = contextCorrect / total;
      const contextOffAccuracy = baselineCorrect / total;
      const datasetSha256 = createHash('sha256').update(datasetText).digest('hex');
      return {
        meta: { generatedAt: new Date().toISOString(), ...sourceAtStart, sourceAtStart, sourceAtEnd: null, sourceStable: false, dataset: dataset.meta.name, datasetSha256, effectiveConfig, artifactIntegrity: createActionArtifactIntegrity({ sourceAtStart, datasetSha256, effectiveConfig, tasks: rows }), taskCount: total, deterministic: true, model: null, modelTokens: 0, profile: getRetrievalProfile().name, embeddingsProvider: 'local', modelDownloadsAllowed: false, sideEffects: 'in-memory state only; isolated SQLite database; unique project per task', protocol: 'same seeded memories and task state in paired context-on retrieval/action and context-off abstain arms' },
        metrics: { contextOnAccuracy, contextOffAccuracy, pairedAccuracyDelta: contextOnAccuracy - contextOffAccuracy, contextOnCorrect: contextCorrect, contextOffCorrect: baselineCorrect, total, evidenceSupportedActions: supported, expectedActionCount, evidenceSupportedActionRate: expectedActionCount ? supported / expectedActionCount : 1, abstentionAccuracy: abstentionCorrect / total, negativeTransferRate: negativeTransfers / total, actionOutcomeSha256: createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex'), retrievalTraceSha256: createHash('sha256').update(JSON.stringify(retrievalTrace)).digest('hex'), retrievalLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }, returnedTokens, ingestedTokens, modelTokens: 0, estimatedQueryCostUsd: 0, estimatedIngestionCostUsd: 0, networkEgressBytes: 0 },
        tasks: rows,
      };
    });
    const sourceAtEnd = sourceProvenance();
    report.meta.sourceAtEnd = sourceAtEnd;
    report.meta.sourceStable = sameSourceSnapshot(sourceAtStart, sourceAtEnd);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: outPath, metrics: report.metrics }, null, 2));
    if (!report.meta.sourceStable || report.metrics.contextOnCorrect !== report.metrics.total || report.metrics.evidenceSupportedActionRate < 1) process.exitCode = 1;
  } finally {
    const restore: Record<string, string | undefined> = { SQUISH_PROFILE: originalEnv.profile, SQUISH_EMBEDDINGS_PROVIDER: originalEnv.embeddings, SQUISH_LOCAL_BUNDLED_MODEL: originalEnv.bundled, SQUISH_RERANKER_ENABLED: originalEnv.reranker, SQUISH_QUERY_EXPANSION: originalEnv.expansion, SQUISH_GRAPH_EXPANSION: originalEnv.graph, SQUISH_CONTEXTUAL_RETRIEVAL: originalEnv.contextual };
    for (const [key, value] of Object.entries(restore)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

if (import.meta.main) await main();
