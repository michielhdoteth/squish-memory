/**
 * Squish Bench — Unified entry point.
 *
 * One command to run the full evaluation suite or individual benchmarks.
 *
 * Usage:
 *   bun run bench                          # full suite (pinned defaults)
 *   bun run bench --retrieval-only         # just retrieval metrics
 *   bun run bench --rag-only               # just end-to-end RAG
 *   bun run bench --locomo                  # just LoCoMo
 *   bun run bench --resurrection            # just resurrection tests
 *   bun run bench --embeddings local,openai # embedding comparison
 */

import { RETRIEVAL_VARIANTS, type RetrievalVariant } from './config.js';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// ─── CLI Parsing ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function getArg(name: string): string | undefined {
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

// ─── Runners ────────────────────────────────────────────────────────────────

async function main() {
  const quiet = hasFlag('quiet');

  if (hasFlag('help') || hasFlag('h')) {
    console.log(`Squish Bench — Unified Evaluation Framework

Usage: bun run bench [options]

Modes:
  --retrieval-only     Run retrieval metrics only (golden set)
  --rag-only           Run end-to-end RAG benchmark only
  --locomo             Run LoCoMo benchmark only
  --resurrection       Run resurrection behavior tests only
  --embeddings=<list>  Run embedding comparison (comma-separated providers)

Options:
  --variant=<v>        Run single RAG variant (no_memory|vector_only|...)
  --answer-provider=<p> Answer model provider (default: openai)
  --judge-provider=<p>  Judge model provider (default: openai)
  --top-k=<n>          Top-K results (default: 5)
  --out=<path>         Output report path
  --quiet              Suppress output

Without mode flags, runs the full suite.`);
    process.exit(0);
  }

  console.log('=== Squish Bench ===\n');

  const startTime = Date.now();

  // --- Retrieval (runs as subprocess — it has its own CLI) ---
  if (!hasFlag('rag-only') && !hasFlag('locomo') && !hasFlag('resurrection') && !hasFlag('embeddings')) {
    console.log('[1/3] Retrieval benchmark...');
    execSync(`bun run bench/runners/retrieval.ts${quiet ? ' --quiet' : ''}`, {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  // --- RAG ---
  if (!hasFlag('retrieval-only') && !hasFlag('locomo') && !hasFlag('resurrection') && !hasFlag('embeddings')) {
    console.log('[2/3] RAG benchmark...');
    const { runRAGBenchmark } = await import('./runners/rag.js');
    await runRAGBenchmark({
      quiet,
      variant: getArg('variant') as RetrievalVariant | undefined,
      answerProvider: getArg('answer-provider'),
      judgeProvider: getArg('judge-provider'),
      topK: getArg('top-k') ? parseInt(getArg('top-k')!) : undefined,
      out: getArg('out'),
    });
  }

  // --- Resurrection ---
  if (!hasFlag('retrieval-only') && !hasFlag('rag-only') && !hasFlag('locomo') && !hasFlag('embeddings')) {
    console.log('[3/3] Resurrection benchmark...');
    const { runResurrectionBenchmark } = await import('./runners/resurrection.js');
    await runResurrectionBenchmark(quiet);
  }

  // --- LoCoMo (separate, needs NVIDIA key) ---
  if (hasFlag('locomo')) {
    const { runLoCoMoBenchmark } = await import('./runners/locomo.js');
    await runLoCoMoBenchmark(undefined, quiet);
  }

  // --- Embedding comparison ---
  if (hasFlag('embeddings')) {
    const providers = getArg('embeddings')?.split(',') || ['local'];
    console.log(`[4/4] Embedding comparison: ${providers.join(', ')}...`);
    const { runEmbeddingBakeoff } = await import('./runners/embeddings.js');
    await runEmbeddingBakeoff(quiet);
  }

  const durationMs = Date.now() - startTime;
  console.log(`\nTotal time: ${(durationMs / 1000).toFixed(1)}s`);
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
