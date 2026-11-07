#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { estimateTokens } from '../../core/context/context-window.js';
import { getRetrievalProfile } from '../../core/retrieval/profiles.js';
import { applySandboxAction, parseMemoryAction, statesEqual } from '../scoring/action-task.js';
import { hasTrackedSourceChanges } from '../source-provenance.js';

interface ActionTask {
  id: string;
  query: string;
  memory: string;
  initialState: Record<string, string>;
  expectedState: Record<string, string>;
  expectedAbstain: boolean;
}

interface ActionDataset {
  meta: Record<string, unknown>;
  tasks: ActionTask[];
}

function gitSha(): string {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function sourceProvenance(): { gitDirty: boolean; trackedDiffSha256: string } {
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD']);
  return {
    gitDirty: hasTrackedSourceChanges() ?? false,
    trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : 'benchmark/reports/action-eval.json';
  if (!outPath) throw new Error('--out requires a path');

  const datasetPath = resolve('benchmark/datasets/actions/action-tasks.json');
  const datasetText = readFileSync(datasetPath, 'utf8');
  const dataset = JSON.parse(datasetText) as ActionDataset;
  if (dataset.tasks.length === 0) throw new Error('Action evaluation dataset is empty');

  const dataDir = mkdtempSync(join(tmpdir(), 'squish-action-eval-'));
  const previous = {
    dataDir: process.env.SQUISH_DATA_DIR,
    databaseUrl: process.env.DATABASE_URL,
    databaseUrlSquish: process.env.SQUISH_DATABASE_URL,
    profile: process.env.SQUISH_PROFILE,
    embeddings: process.env.SQUISH_EMBEDDINGS_PROVIDER,
    bundledModel: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
    reranker: process.env.SQUISH_RERANKER_ENABLED,
    queryExpansion: process.env.SQUISH_QUERY_EXPANSION,
    graphExpansion: process.env.SQUISH_GRAPH_EXPANSION,
    contextual: process.env.SQUISH_CONTEXTUAL_RETRIEVAL,
  };
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_PROFILE = 'fast-local';
  process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
  process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
  process.env.SQUISH_RERANKER_ENABLED = 'false';
  process.env.SQUISH_QUERY_EXPANSION = 'false';
  process.env.SQUISH_GRAPH_EXPANSION = 'false';
  process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'false';

  try {
    const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime();
    for (const task of dataset.tasks) {
      await client.remember(task.memory, {
        type: 'context',
        metadata: { sourceId: `action-fixture:${task.id}`, observedAt: '2026-10-14T00:00:00.000Z' },
      });
    }

    const latencies: number[] = [];
    const rows: Array<Record<string, unknown>> = [];
    let correct = 0;
    let abstentions = 0;
    let correctAbstentions = 0;
    let returnedTokens = 0;
    const ingestionTokens = dataset.tasks.reduce((sum, task) => sum + estimateTokens(task.memory), 0);
    let baselineCorrect = 0;

    for (const task of dataset.tasks) {
      const started = performance.now();
      const results = await client.search(task.query, { limit: 3 });
      const latencyMs = performance.now() - started;
      latencies.push(latencyMs);
      const memories = results.map((result) => String(result.memory?.content ?? result.content ?? ''));
      returnedTokens += memories.reduce((sum, content) => sum + estimateTokens(content), 0);
      const applicable = memories
        .map((content) => parseMemoryAction(content))
        .find((action) => action && task.initialState[action.conditionField] === action.conditionValue);
      const finalState = applicable ? applySandboxAction(task.initialState, applicable) : { ...task.initialState };
      const abstained = applicable === undefined;
      const isCorrect = finalState !== null && statesEqual(finalState, task.expectedState);
      if (isCorrect) correct++;
      if (abstained) abstentions++;
      if (abstained === task.expectedAbstain) correctAbstentions++;

      const baselineState = { ...task.initialState };
      const baselineAbstained = true;
      if (statesEqual(baselineState, task.expectedState)) baselineCorrect++;
      rows.push({
        id: task.id,
        query: task.query,
        initialState: task.initialState,
        retrievalLatencyMs: Number(latencyMs.toFixed(3)),
        retrievedCount: results.length,
        returnedTokens: memories.reduce((sum, content) => sum + estimateTokens(content), 0),
        retrievedEvidence: results.map((result, index) => ({
          rank: index + 1,
          memoryId: result.memory.id,
          content: result.memory.content,
          source: result.source,
          score: result.score,
          recallConfidence: result.recallConfidence ?? null,
        })),
        chosenAction: applicable ?? null,
        abstained,
        expectedAbstain: task.expectedAbstain,
        finalState,
        expectedState: task.expectedState,
        correct: isCorrect,
        noMemoryBaseline: { abstained: baselineAbstained, correct: statesEqual(baselineState, task.expectedState) },
      });
    }

    const sha = createHash('sha256').update(datasetText).digest('hex');
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        gitSha: gitSha(),
        ...sourceProvenance(),
        dataset: dataset.meta.name,
        datasetSha256: sha,
        taskCount: dataset.tasks.length,
        deterministic: true,
        sideEffects: 'in-memory state only',
        profile: getRetrievalProfile().name,
        model: null,
        embeddingsProvider: 'local',
        modelDownloadsAllowed: false,
      },
      metrics: {
        accuracy: correct / dataset.tasks.length,
        correct,
        total: dataset.tasks.length,
        abstentionRate: abstentions / dataset.tasks.length,
        correctAbstentionRate: correctAbstentions / dataset.tasks.length,
        noMemoryBaselineAccuracy: baselineCorrect / dataset.tasks.length,
        retrievalLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
        returnedTokens,
        ingestionTokens,
        modelTokens: 0,
        estimatedIngestionCostUsd: 0,
        estimatedQueryCostUsd: 0,
        networkEgressBytes: 0,
      },
      tasks: rows,
    };

    const destination = resolve(outPath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ report: destination, metrics: report.metrics }, null, 2));
    if (correct !== dataset.tasks.length) process.exitCode = 1;
  } finally {
    const { closeAllDbs } = await import('../../db/index.js');
    await closeAllDbs();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold SQLite handles briefly. */ }
    for (const [key, value] of Object.entries({
      SQUISH_DATA_DIR: previous.dataDir,
      DATABASE_URL: previous.databaseUrl,
      SQUISH_DATABASE_URL: previous.databaseUrlSquish,
      SQUISH_PROFILE: previous.profile,
      SQUISH_EMBEDDINGS_PROVIDER: previous.embeddings,
      SQUISH_LOCAL_BUNDLED_MODEL: previous.bundledModel,
      SQUISH_RERANKER_ENABLED: previous.reranker,
      SQUISH_QUERY_EXPANSION: previous.queryExpansion,
      SQUISH_GRAPH_EXPANSION: previous.graphExpansion,
      SQUISH_CONTEXTUAL_RETRIEVAL: previous.contextual,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (import.meta.main) await main();
