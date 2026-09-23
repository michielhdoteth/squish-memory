/**
 * End-to-end RAG benchmark runner.
 *
 * Pipeline: query → SquishClient.search() → answer model → judge model → metrics
 *
 * Runs ablation variants (no_memory, vector_only, ..., full_squish) and
 * produces a canonical benchmark artifact.
 *
 * Run: bun bench/runners/rag.ts [--variant full_squish] [--quiet] [--out path]
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  PINNED_ANSWER_PROVIDER,
  PINNED_ANSWER_MODEL,
  PINNED_JUDGE_PROVIDER,
  PINNED_JUDGE_MODEL,
  RETRIEVAL_VARIANTS,
  VARIANT_FLAGS,
  PINNED_EVAL_ENV,
  RAG_THRESHOLDS,
  type RetrievalVariant,
} from '../config.js';

import type { AnswerAdapter } from '../adapters/answer-models/types.js';
import type { JudgeAdapter } from '../adapters/judges/types.js';
import { createOpenAIAnswerAdapter } from '../adapters/answer-models/openai.js';
import { createNVIDIAAnswerAdapter } from '../adapters/answer-models/nvidia.js';
import { createOllamaAnswerAdapter } from '../adapters/answer-models/ollama.js';
import { createLocalAnswerAdapter } from '../adapters/answer-models/local.js';
import { createOpenAIJudgeAdapter } from '../adapters/judges/openai.js';
import { createNVIDIAJudgeAdapter } from '../adapters/judges/nvidia.js';
import { aggregateRAG, type RAGQueryResult } from '../scoring/rag.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface RAGDatasetQuery {
  id: string;
  category: string;
  query: string;
  expected: string;
  answerable: boolean;
  memoryIds: string[];
}

interface RAGDataset {
  meta: Record<string, unknown>;
  queries: RAGDatasetQuery[];
}

interface RAGReport {
  meta: {
    generatedAt: string;
    gitSha: string | null;
    gitDirty: boolean;
    answerProvider: string;
    answerModel: string;
    judgeProvider: string;
    judgeModel: string;
    dataset: string;
    queryCount: number;
    variants: string[];
  };
  overall: Record<string, unknown>;
  byCategory: Record<string, unknown>;
  byVariant: Record<string, unknown>;
  perQuery: RAGQueryResult[];
  traces: Array<{
    queryId: string;
    variant: string;
    retrievedIds: string[];
    retrievedScores: number[];
    answer: string;
    expected: string;
    judge: {
      correct: boolean;
      grounded: boolean;
      stale: boolean;
      shouldAbstain: boolean;
    };
    latencyMs: number;
  }>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createAnswerAdapter(provider: string, model: string): AnswerAdapter {
  switch (provider) {
    case 'openai': return createOpenAIAnswerAdapter(model);
    case 'nvidia': return createNVIDIAAnswerAdapter(model);
    case 'ollama': return createOllamaAnswerAdapter(model);
    case 'local': return createLocalAnswerAdapter();
    default: throw new Error(`Unknown answer provider: ${provider}`);
  }
}

function createJudgeAdapter(provider: string, model: string): JudgeAdapter {
  switch (provider) {
    case 'openai': return createOpenAIJudgeAdapter(model);
    case 'nvidia': return createNVIDIAJudgeAdapter(model);
    default: throw new Error(`Unknown judge provider: ${provider}`);
  }
}

function shortGitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function isGitDirty(): boolean {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

// ─── Seed + Retrieval ───────────────────────────────────────────────────────

async function seedCorpusAndRetrieve(
  queries: RAGDatasetQuery[],
  variant: RetrievalVariant,
  topK: number,
  dataDir: string,
): Promise<Array<{ query: RAGDatasetQuery; retrievedIds: string[]; retrievedScores: number[]; context: string[] }>> {
  // Apply variant flags
  const flags = VARIANT_FLAGS[variant];
  const savedEnv: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(flags)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
    const client = new SquishRuntime();

    // Seed corpus
    const goldenPath = join(__dirname, '..', 'datasets', 'golden', 'golden-set.json');
    const goldenSet = JSON.parse(readFileSync(goldenPath, 'utf-8'));
    const uuidToGolden = new Map<string, string>();

    for (const mem of goldenSet.memories) {
      const stored = await client.remember(mem.content, {
        type: mem.type,
        tags: mem.tags,
        metadata: { goldenId: mem.id },
      });
      uuidToGolden.set(stored.id, mem.id);
    }

    // Run queries
    const results: Array<{ query: RAGDatasetQuery; retrievedIds: string[]; retrievedScores: number[]; context: string[] }> = [];

    for (const q of queries) {
      if (variant === 'no_memory') {
        results.push({ query: q, retrievedIds: [], retrievedScores: [], context: [] });
        continue;
      }

      const searchResults = await client.search(q.query, { limit: topK });
      const retrievedIds = searchResults.map(r => uuidToGolden.get(r.memory.id) ?? r.memory.id);
      const retrievedScores = searchResults.map(r => r.score);
      const context = searchResults.map(r => r.memory.content);

      results.push({ query: q, retrievedIds, retrievedScores, context });
    }

    return results;
  } finally {
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runRAGBenchmark(options?: {
  variant?: RetrievalVariant;
  answerProvider?: string;
  answerModel?: string;
  judgeProvider?: string;
  judgeModel?: string;
  topK?: number;
  quiet?: boolean;
  out?: string;
}) {
  const answerProvider = options?.answerProvider || process.env.BENCH_ANSWER_PROVIDER || PINNED_ANSWER_PROVIDER;
  const answerModel = options?.answerModel || process.env.BENCH_ANSWER_MODEL || PINNED_ANSWER_MODEL;
  const judgeProvider = options?.judgeProvider || process.env.BENCH_JUDGE_PROVIDER || PINNED_JUDGE_PROVIDER;
  const judgeModel = options?.judgeModel || process.env.BENCH_JUDGE_MODEL || PINNED_JUDGE_MODEL;
  const topK = options?.topK ?? 5;
  const quiet = options?.quiet ?? false;

  const answerAdapter = createAnswerAdapter(answerProvider, answerModel);
  const judgeAdapter = createJudgeAdapter(judgeProvider, judgeModel);

  // Load dataset
  const datasetPath = join(__dirname, '..', 'datasets', 'rag', 'rag-eval.json');
  const dataset: RAGDataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  // Determine variants to run
  const variants = options?.variant
    ? [options.variant]
    : RETRIEVAL_VARIANTS;

  if (!quiet) {
    console.log(`\n=== Squish RAG Benchmark ===`);
    console.log(`Answer: ${answerAdapter.name}`);
    console.log(`Judge:  ${judgeAdapter.name}`);
    console.log(`Dataset: ${dataset.queries.length} queries`);
    console.log(`Variants: ${variants.join(', ')}`);
    console.log();
  }

  const allResults: RAGQueryResult[] = [];
  const allTraces: RAGReport['traces'] = [];

  for (const variant of variants) {
    if (!quiet) console.log(`--- Variant: ${variant} ---`);

    const dataDir = mkdtempSync(join(tmpdir(), `squish-bench-${variant}-`));
    process.env.SQUISH_DATA_DIR = dataDir;

    try {
      const retrieved = await seedCorpusAndRetrieve(dataset.queries, variant, topK, dataDir);

      for (const { query, retrievedIds, retrievedScores, context } of retrieved) {
        // Get answer
        const answerResult = await answerAdapter.answer({ query: query.query, context });

        // Get judge assessment
        const judgeResult = await judgeAdapter.judge({
          query: query.query,
          answer: answerResult.answer,
          expected: query.expected,
          context,
        });

        const ragResult: RAGQueryResult = {
          queryId: query.id,
          category: query.category,
          variant,
          retrievedIds,
          retrievedScores,
          answer: answerResult.answer,
          expected: query.expected,
          judge: judgeResult,
          latencyMs: answerResult.latencyMs + judgeResult.latencyMs,
        };

        allResults.push(ragResult);

        allTraces.push({
          queryId: query.id,
          variant,
          retrievedIds,
          retrievedScores,
          answer: answerResult.answer,
          expected: query.expected,
          judge: {
            correct: judgeResult.correct,
            grounded: judgeResult.grounded,
            stale: judgeResult.stale,
            shouldAbstain: judgeResult.shouldAbstain,
          },
          latencyMs: ragResult.latencyMs,
        });

        if (!quiet && allResults.length % 5 === 0) {
          const correct = allResults.filter(r => r.judge.correct).length;
          console.log(`  [${allResults.length}/${dataset.queries.length * variants.length}] Correct: ${correct}`);
        }

        // Adapters handle rate limiting internally
      }
    } finally {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Aggregate
  const { overall, byCategory, byVariant } = aggregateRAG(allResults);

  // Build report
  const report: RAGReport = {
    meta: {
      generatedAt: new Date().toISOString(),
      gitSha: shortGitSha(),
      gitDirty: isGitDirty(),
      answerProvider: answerAdapter.name,
      answerModel,
      judgeProvider: judgeAdapter.name,
      judgeModel,
      dataset: 'rag-eval-v1',
      queryCount: dataset.queries.length,
      variants,
    },
    overall: overall as any,
    byCategory: byCategory as any,
    byVariant: byVariant as any,
    perQuery: allResults,
    traces: allTraces,
  };

  // Save report
  const outPath = options?.out || join(__dirname, '..', 'reports', 'rag-benchmark.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // Print summary
  if (!quiet) {
    console.log(`\n=== RAG Benchmark Results ===`);
    console.log(`Overall useful answer rate: ${(overall.usefulAnswerRate * 100).toFixed(1)}%`);
    console.log(`Correct:   ${(overall.correctRate * 100).toFixed(1)}%`);
    console.log(`Grounded:  ${(overall.groundedRate * 100).toFixed(1)}%`);
    console.log(`Stale:     ${(overall.staleRate * 100).toFixed(1)}%`);
    console.log(`Abstain:   ${(overall.abstentionAccuracy * 100).toFixed(1)}%`);
    console.log(`\nBy variant:`);
    for (const [v, m] of Object.entries(byVariant)) {
      console.log(`  ${v}: useful=${((m as any).usefulAnswerRate * 100).toFixed(1)}% correct=${((m as any).correctRate * 100).toFixed(1)}%`);
    }
    console.log(`\nReport: ${outPath}`);

    // Gate check
    const failed =
      overall.usefulAnswerRate < RAG_THRESHOLDS.usefulAnswerRate ||
      overall.correctRate < RAG_THRESHOLDS.correctRate ||
      overall.staleRate > RAG_THRESHOLDS.staleRate;

    if (failed) {
      console.log(`\nGATE FAILED — thresholds breached`);
      process.exitCode = 1;
    } else {
      console.log(`\nGATE PASSED`);
    }
  }

  return report;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: bun bench/runners/rag.ts [options]
  --variant=<variant>    Run a single variant (no_memory|vector_only|...)
  --answer-provider=<p>  Answer model provider
  --answer-model=<m>     Answer model name
  --judge-provider=<p>   Judge model provider
  --judge-model=<m>      Judge model name
  --top-k=<n>            Top-K results (default: 5)
  --out=<path>           Output report path
  --quiet                Suppress output`);
  process.exit(0);
}

function getArg(name: string): string | undefined {
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

runRAGBenchmark({
  variant: getArg('variant') as RetrievalVariant | undefined,
  answerProvider: getArg('answer-provider'),
  answerModel: getArg('answer-model'),
  judgeProvider: getArg('judge-provider'),
  judgeModel: getArg('judge-model'),
  topK: getArg('top-k') ? parseInt(getArg('top-k')!) : undefined,
  quiet: argv.includes('--quiet'),
  out: getArg('out'),
}).then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
