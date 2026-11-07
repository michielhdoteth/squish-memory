/**
 * LoCoMo benchmark runner with isolation matrix support.
 *
 * Supports two memory modes:
 *   --memory=full   Pass entire conversation as context (reader-only baseline)
 *   --memory=squish Seed Squish with conversations, retrieve memories per question
 *
 * Each question result is appended to a JSONL file immediately after processing.
 * On resume, completed questions are skipped. Failed questions are RETRIED (not
 * counted as incorrect) until they succeed or max retries are exhausted.
 *
 * Run: bun benchmark/runners/locomo.ts [--memory=full|squish] [--model=<m>] [--judge-model=<m>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { withIsolatedBenchmarkDatabase } from './isolated-db.js';
import { retrievePersonaContext, seedPersona } from './locomo-memory.js';
import { createNVIDIAAnswerAdapter, NVIDIA_ANSWER_GENERATION } from '../adapters/answer-models/nvidia.js';
import { createNVIDIAJudgeAdapter, NVIDIA_JUDGE_GENERATION } from '../adapters/judges/nvidia.js';
import { getNVIDIARequestSettings } from '../adapters/nvidia-polling.js';
import { getAdversarialQuestionExclusions } from './locomo-metrics.js';
import { config } from '../../config.js';
import { PINNED_ANSWER_MODEL, PINNED_JUDGE_MODEL } from '../config.js';
import { getGraphBoostFlags, getPrecisionStackFlags, getRetrievalConfig } from '../../core/retrieval/config.js';
import { getRetrievalDiagnostics } from '../../core/retrieval/profiles.js';
import { assertSourceSnapshotUnchanged, sourceSnapshotSha256 } from './source-snapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number; // 1=single-hop, 2=temporal, 3=reasoning, 4=open-domain, 5=adversarial
}

interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: any;
}

interface LoCoMoPersona {
  qa: LoCoMoQA[];
  conversation: LoCoMoConversation[];
  event_summary: string;
  observation: string;
  session_summary: string;
  sample_id: string;
}

interface BenchmarkResult {
  status: 'done' | 'failed';
  sample_id: string;
  question_index: number;
  question: string;
  expected: string;
  predicted?: string;
  correct: boolean;
  partial: boolean;
  category: number;
  category_name: string;
  evidence: string[];
  judgeReasoning?: string;
  memory_mode: string;
  answer_model: string;
  judge_model: string;
  run_id: string;
  answer_latency_ms?: number;
  judge_latency_ms?: number;
  answer_tokens?: { prompt: number; completion: number };
  judge_tokens?: { prompt: number; completion: number };
  context_chars?: number;
  context?: string[];
  exact_match?: boolean;
  judge_grounded?: boolean;
  judge_stale?: boolean;
  judge_should_abstain?: boolean;
  judge_confidence?: number;
  error?: string;
}

// ─── Category Mapping ───────────────────────────────────────────────────────

function categoryName(cat: number): string {
  switch (cat) {
    case 1: return 'single-hop';
    case 2: return 'temporal';
    case 3: return 'reasoning';
    case 4: return 'open-domain';
    case 5: return 'adversarial';
    default: return `cat-${cat}`;
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = PINNED_ANSWER_MODEL;
const REPORTS_DIR = join(__dirname, '..', 'reports');

export function resolveLoCoMoModels(options?: { answerModel?: string; judgeModel?: string }, env: NodeJS.ProcessEnv = process.env) {
  return {
    answerModel: options?.answerModel || env.BENCH_ANSWER_MODEL || DEFAULT_MODEL,
    judgeModel: options?.judgeModel || env.BENCH_JUDGE_MODEL || PINNED_JUDGE_MODEL,
  };
}

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

export function parseQuestionLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error('--limit must be a positive safe integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be a positive safe integer');
  return limit;
}

// ─── Answer Matching ────────────────────────────────────────────────────────

function normalizeAnswer(answer: any): string {
  const str = String(answer ?? '');
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkPartial(predicted: string, expected: string): boolean {
  const normPred = normalizeAnswer(predicted);
  const normExp = normalizeAnswer(expected);
  const expectedTerms = normExp.split(' ').filter(t => t.length > 2);
  const predictedTerms = normPred.split(' ');
  const matchCount = expectedTerms.filter(t => predictedTerms.some(pt => pt.includes(t) || t.includes(pt))).length;
  return matchCount >= Math.ceil(expectedTerms.length * 0.4);
}

// ─── Conversation Extraction ────────────────────────────────────────────────

function extractConversationText(conversations: LoCoMoConversation): string {
  const parts: string[] = [];
  const speakerA = conversations.speaker_a;
  const speakerB = conversations.speaker_b;

  const sessionNums = Object.keys(conversations)
    .filter(k => k.startsWith('session_') && k.endsWith('_date_time'))
    .map(k => parseInt(k.replace('session_', '').replace('_date_time', ''), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  for (const i of sessionNums) {
    const dateTimeKey = `session_${i}_date_time`;
    const sessionKey = `session_${i}`;

    if (conversations[dateTimeKey] && conversations[sessionKey]) {
      parts.push(`\n--- Session ${i} (${conversations[dateTimeKey]}) ---`);
      const sessionData = conversations[sessionKey];

      if (Array.isArray(sessionData)) {
        for (const msg of sessionData) {
          const speaker = msg.speaker || (msg.dia_id?.startsWith('D') ? speakerA : speakerB);
          parts.push(`${speaker}: ${msg.text}`);
        }
      }
    }
  }

  return parts.join('\n');
}

function extractSessionTexts(conversations: LoCoMoConversation): Array<{ session: number; date: string; text: string }> {
  const sessions: Array<{ session: number; date: string; text: string }> = [];
  const speakerA = conversations.speaker_a;
  const speakerB = conversations.speaker_b;

  const sessionNums = Object.keys(conversations)
    .filter(k => k.startsWith('session_') && k.endsWith('_date_time'))
    .map(k => parseInt(k.replace('session_', '').replace('_date_time', ''), 10))
    .filter(n => !isNaN(n))
    .sort((a, b) => a - b);

  for (const i of sessionNums) {
    const dateTimeKey = `session_${i}_date_time`;
    const sessionKey = `session_${i}`;

    if (conversations[dateTimeKey] && conversations[sessionKey]) {
      const sessionData = conversations[sessionKey];
      if (Array.isArray(sessionData)) {
        const lines: string[] = [];
        for (const msg of sessionData) {
          const speaker = msg.speaker || (msg.dia_id?.startsWith('D') ? speakerA : speakerB);
          lines.push(`${speaker}: ${msg.text}`);
        }
        sessions.push({
          session: i,
          date: conversations[dateTimeKey],
          text: lines.join('\n'),
        });
      }
    }
  }

  return sessions;
}

// ─── JSONL Checkpoint ──────────────────────────────────────────────────────

export function getLoCoMoQuestionKey(sampleId: string, questionIndex: number): string {
  if (!Number.isSafeInteger(questionIndex) || questionIndex < 0) {
    throw new Error('LoCoMo question index must be a non-negative safe integer');
  }
  return createHash('sha256').update(`${sampleId}::${questionIndex}`).digest('hex');
}

export function getLoCoMoBenchmarkExitCode(report: { results: { failed: number } }): number {
  return report.results.failed > 0 ? 1 : 0;
}

function getSourceRevision(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function getTrackedDiffSha256(): string {
  try {
    const diff = execFileSync('git', ['diff', 'HEAD', '--'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
    return createHash('sha256').update(diff).digest('hex');
  } catch {
    return 'unavailable';
  }
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function getLoCoMoRuntimeSettings() {
  const precision = getPrecisionStackFlags();
  const diagnostics = getRetrievalDiagnostics();
  const embeddingProvider = config.embeddingsProvider;
  const embeddingModel = embeddingProvider === 'openai' ? config.openAiEmbeddingModel
    : embeddingProvider === 'ollama' ? config.ollamaEmbeddingModel
      : embeddingProvider === 'lmstudio' ? config.lmStudioEmbeddingModel
        : embeddingProvider === 'google' ? config.googleEmbeddingModel
          : embeddingProvider === 'transformers' ? config.transformersLocalModel
            : embeddingProvider === 'local' ? config.localBundledModel || 'tfidf-hashed-ngram-768'
              : embeddingProvider;
  return {
    profile: diagnostics.profile,
    precisionStages: precision,
    contextualRetrieval: diagnostics.features.contextualEnrichment,
    entityRetrieval: process.env.SQUISH_ENTITY_RETRIEVAL === 'true',
    mmr: { enabled: config.mmrEnabled, lambda: config.mmrLambda },
    embeddings: { provider: embeddingProvider, model: embeddingModel, vectorScanMode: config.vectorScanMode },
    reranker: { enabled: precision.reranker, model: config.rerankerModel, candidateTopK: config.rerankerTopK, returnTopK: config.rerankerReturnTopK },
    queryRewriting: { enabled: config.queryRewritingEnabled, contextMessages: config.queryRewritingContextMessages },
    scoring: getRetrievalConfig(),
    graph: {
      autoBuild: config.graphAutoBuild,
      extractionMethod: config.graphExtractionMethod,
      legacyBoost: getGraphBoostFlags().legacy,
      writeDedupMode: config.writeDedupMode,
    },
    mutations: {
      llmEnabled: config.llmEnabled,
      contradictionResolutionSkipped: process.env.SQUISH_SKIP_CONTRADICTION === 'true',
      consolidationEnabled: config.consolidationEnabled,
      llmConsolidationEnabled: config.llmConsolidationEnabled,
    },
  };
}

export async function loadJsonlResults(
  jsonlPath: string,
  expectedRunId: string,
): Promise<Map<string, BenchmarkResult>> {
  const results = new Map<string, BenchmarkResult>();
  if (!existsSync(jsonlPath)) return results;

  const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Malformed LoCoMo checkpoint JSON at line ${lineNumber}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid LoCoMo checkpoint row at line ${lineNumber}`);
    }
    const entry = value as Partial<BenchmarkResult>;
    if (typeof entry.sample_id !== 'string' || !entry.sample_id
      || !Number.isSafeInteger(entry.question_index) || (entry.question_index as number) < 0
      || (entry.status !== 'done' && entry.status !== 'failed')) {
      throw new Error(`Invalid LoCoMo checkpoint identity or status at line ${lineNumber}`);
    }
    if (entry.run_id !== expectedRunId) {
      throw new Error(`LoCoMo checkpoint run ID mismatch at line ${lineNumber}; expected ${expectedRunId}`);
    }
    const key = getLoCoMoQuestionKey(entry.sample_id, entry.question_index as number);
    // Keep the last entry for each question (in case of retries).
    results.set(key, entry as BenchmarkResult);
  }

  return results;
}

function appendResult(jsonlPath: string, result: BenchmarkResult): void {
  appendFileSync(jsonlPath, JSON.stringify(result) + '\n');
}

// ─── Squish Retrieval ──────────────────────────────────────────────────────

// ─── Main Benchmark ─────────────────────────────────────────────────────────

export async function runLoCoMoBenchmark(options?: {
  limit?: number;
  quiet?: boolean;
  memoryMode?: 'full' | 'squish';
  answerModel?: string;
  judgeModel?: string;
  maxRetries?: number;
}) {
  return withIsolatedBenchmarkDatabase(async (dataDir) => {
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive safe integer');
  }
  const quiet = options?.quiet ?? false;
  const memoryMode = options?.memoryMode || 'full';
  const { answerModel, judgeModel } = resolveLoCoMoModels(options);
  const maxRetries = options?.maxRetries ?? 2; // retries for failed questions

  const startedAt = Date.now();

  const datasetPath = join(__dirname, '..', 'datasets', 'locomo', 'locomo10.json');
  const datasetBytes = readFileSync(datasetPath);
  const dataset: LoCoMoPersona[] = JSON.parse(datasetBytes.toString('utf-8'));
  const excludedQuestions = getAdversarialQuestionExclusions(dataset);
  const datasetSha256 = createHash('sha256').update(datasetBytes).digest('hex');
  const sourceRevision = getSourceRevision();
  const sourceDiffSha256 = getTrackedDiffSha256();
  const sourceSnapshotAtStart = sourceSnapshotSha256(join(__dirname, '..', '..'));
  const runtimeSettings = getLoCoMoRuntimeSettings();

  // Filter out category 5 (adversarial)
  let totalQuestions = 0;
  for (const persona of dataset) {
    totalQuestions += persona.qa.filter(q => q.category !== 5).length;
  }

  const questionsToProcess = limit ? Math.min(limit, totalQuestions) : totalQuestions;

  // JSONL checkpoint path includes model and memory mode
  const modelSlug = answerModel.split('/').pop()?.replace(/[^a-z0-9-]/gi, '-') || 'unknown';
  const runConfig = {
    protocol: 'squish-locomo-v4',
    answerModel,
    judgeModel,
    memoryMode,
    limit: limit ?? null,
    maxRetries,
    datasetSha256,
    sourceRevision,
    sourceDiffSha256,
    sourceSnapshotSha256: sourceSnapshotAtStart,
    contextLimitChars: memoryMode === 'full' ? 8000 : null,
    topK: memoryMode === 'squish' ? 10 : null,
    adversarialCategoryIncluded: false,
    databaseIsolation: 'temporary-sqlite-per-run',
    runtimeSettings,
    inference: {
      answerProvider: 'nvidia',
      judgeProvider: 'nvidia',
      answerJudgeModelsIndependent: answerModel !== judgeModel,
      answerGeneration: NVIDIA_ANSWER_GENERATION,
      judgeGeneration: NVIDIA_JUDGE_GENERATION,
      requestSettings: getNVIDIARequestSettings(),
    },
  };
  const runId = createHash('sha256').update(JSON.stringify(runConfig)).digest('hex').slice(0, 16);
  const jsonlPath = join(REPORTS_DIR, `locomo-${memoryMode}-${modelSlug}-${runId}-results.jsonl`);
  mkdirSync(REPORTS_DIR, { recursive: true });

  // Load existing results - completed questions are skipped, failed are retried
  const existingResults = await loadJsonlResults(jsonlPath, runId);
  let processedQuestions = 0;

  // Count completed vs failed
  let alreadyDone = 0;
  let alreadyFailed = 0;
  for (const [, entry] of existingResults) {
    if (entry.status === 'done') alreadyDone++;
    else alreadyFailed++;
  }
  processedQuestions = alreadyDone;

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark ===`);
    console.log(`Model: ${answerModel}`);
    console.log(`Judge: ${judgeModel}`);
    console.log(`Memory: ${memoryMode}`);
    console.log(`Run ID: ${runId}`);
    console.log(`Source: ${sourceRevision}`);
    console.log(`Dataset SHA-256: ${datasetSha256}`);
    console.log(`Dataset: ${dataset.length} personas, ${totalQuestions} questions (excl. cat 5)`);
    console.log(`JSONL: ${jsonlPath}`);
    console.log(`Already completed: ${alreadyDone} done, ${alreadyFailed} failed (will retry)`);
    console.log(`Remaining: ${questionsToProcess - alreadyDone} questions\n`);
  }

  const answerAdapter = createNVIDIAAnswerAdapter(answerModel);
  const judgeAdapter = createNVIDIAJudgeAdapter(judgeModel);
  const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
  const memoryClient = memoryMode === 'squish' ? new SquishRuntime() : undefined;

  let totalApiFailures = 0;

  for (const persona of dataset) {
    if (processedQuestions >= questionsToProcess) break;

    if (!quiet) {
      console.log(`Processing persona ${persona.sample_id}...`);
    }

    // Prepare conversation data
    let conversationText = extractConversationText(persona.conversation as any);
    const sessionTexts = extractSessionTexts(persona.conversation as any);

    const personaProject = join(dataDir, 'personas', persona.sample_id);
    const personaHasPendingQuestions = persona.qa.some((qa, questionIndex) =>
      qa.category !== 5 && existingResults.get(getLoCoMoQuestionKey(persona.sample_id, questionIndex))?.status !== 'done'
    );
    if (memoryClient && personaHasPendingQuestions) {
      mkdirSync(personaProject, { recursive: true });
      await seedPersona(memoryClient, sessionTexts, persona.sample_id, personaProject);
    }

    for (const [questionIndex, qa] of persona.qa.entries()) {
      if (processedQuestions >= questionsToProcess) break;

      // Skip category 5 (adversarial)
      if (qa.category === 5) continue;

      const qKey = getLoCoMoQuestionKey(persona.sample_id, questionIndex);
      const existing = existingResults.get(qKey);

      // Skip if already done successfully
      if (existing?.status === 'done') continue;

      // For failed entries, retry (don't skip)
      if (existing?.status === 'failed') {
        if (!quiet) {
          console.log(`  Retrying: ${qa.question.substring(0, 60)}...`);
        }
      }

      // Build context based on memory mode
      let context: string[];
      if (memoryMode === 'squish') {
        context = await retrievePersonaContext(memoryClient!, qa.question, personaProject, 10);
        if (context.length === 0) {
          context = [conversationText]; // fallback if retrieval returns nothing
        }
      } else {
        // Pass the full conversation, capped at 8K characters for API efficiency.
        let fullCtx = conversationText;
        if (fullCtx.length > 8000) {
          fullCtx = fullCtx.substring(0, 8000) + '\n\n[conversation truncated to 8K chars]';
        }
        context = [`CONVERSATION CONTEXT:\n${fullCtx}`];
      }

      // Process with retries
      let lastError: any = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const answerResult = await answerAdapter.answer({ query: qa.question, context });
          const predicted = answerResult.answer;

          const normPred = normalizeAnswer(predicted);
          const normExp = normalizeAnswer(String(qa.answer ?? ''));
          const isExactMatch = normExp.length > 0 && (normPred === normExp || normPred.includes(normExp));

          const judgeResult = await judgeAdapter.judge({
            query: qa.question,
            answer: predicted,
            expected: String(qa.answer ?? ''),
            context,
          });
          const correct = judgeResult.correct;
          const partial = !correct && checkPartial(predicted, String(qa.answer ?? ''));

          const result: BenchmarkResult = {
            status: 'done',
            sample_id: persona.sample_id,
            question_index: questionIndex,
            question: qa.question,
            expected: String(qa.answer ?? ''),
            predicted,
            correct,
            partial,
            category: qa.category,
            category_name: categoryName(qa.category),
            evidence: qa.evidence,
            judgeReasoning: judgeResult.reasoning || '',
            memory_mode: memoryMode,
            answer_model: answerModel,
            judge_model: judgeModel,
            run_id: runId,
            answer_latency_ms: answerResult.latencyMs,
            judge_latency_ms: judgeResult.latencyMs,
            answer_tokens: answerResult.tokens,
            judge_tokens: judgeResult.tokens,
            context_chars: context.reduce((sum, item) => sum + item.length, 0),
            context,
            exact_match: isExactMatch,
            judge_grounded: judgeResult.grounded,
            judge_stale: judgeResult.stale,
            judge_should_abstain: judgeResult.shouldAbstain,
            judge_confidence: judgeResult.confidence,
          };

          appendResult(jsonlPath, result);
          processedQuestions++;
          lastError = null;
          break; // Success, stop retrying
        } catch (error: any) {
          lastError = error;
          if (attempt < maxRetries - 1) {
            if (!quiet) {
              console.log(`  Attempt ${attempt + 1} failed for "${qa.question.substring(0, 40)}...", retrying...`);
            }
            // Brief backoff before retry
            await new Promise(r => setTimeout(r, 1500));
          }
        }
      }

      // If all retries exhausted, record as failed
      if (lastError) {
        totalApiFailures++;
        const failResult: BenchmarkResult = {
          status: 'failed',
          sample_id: persona.sample_id,
          question_index: questionIndex,
          question: qa.question,
          expected: String(qa.answer ?? ''),
          correct: false,
          partial: false,
          category: qa.category,
          category_name: categoryName(qa.category),
          evidence: qa.evidence,
          memory_mode: memoryMode,
          answer_model: answerModel,
          judge_model: judgeModel,
          run_id: runId,
          error: lastError?.message || String(lastError),
        };
        appendResult(jsonlPath, failResult);
        processedQuestions++;

        if (!quiet) {
          console.error(`  FAILED (all retries): ${qa.question.substring(0, 60)}... (${lastError?.message?.substring(0, 80)})`);
        }
      }

      if (!quiet && processedQuestions % 10 === 0) {
        console.log(`  [${processedQuestions}/${questionsToProcess}]`);
      }
    }

    if (!quiet) console.log(`  Completed persona ${persona.sample_id}`);
  }

  // ─── Compute Report from JSONL ──────────────────────────────────────────

  const finalResults = await loadJsonlResults(jsonlPath, runId);
  const scoredResults = Array.from(finalResults.values());

  const done = scoredResults.filter(r => r.status === 'done');
  const failed = scoredResults.filter(r => r.status === 'failed');
  const correct = done.filter(r => r.correct).length;
  const partial = done.filter(r => r.partial).length;
  const incorrect = done.length - correct - partial;
  const totalScored = scoredResults.length;
  const score = totalScored > 0 ? Math.round(((correct + partial * 0.5) / totalScored) * 100) : 0;

  const byCategory: Record<number, { correct: number; partial: number; failed: number; total: number; name: string }> = {};
  for (const r of scoredResults) {
    byCategory[r.category] ??= { correct: 0, partial: 0, failed: 0, total: 0, name: r.category_name || categoryName(r.category) };
    byCategory[r.category].total++;
    if (r.status === 'failed') byCategory[r.category].failed++;
    else if (r.correct) byCategory[r.category].correct++;
    else if (r.partial) byCategory[r.category].partial++;
  }

  const durationMs = Date.now() - startedAt;
  const judged = done.filter(r => typeof r.judge_grounded === 'boolean');
  const answerLatencies = done.flatMap(r => typeof r.answer_latency_ms === 'number' ? [r.answer_latency_ms] : []);
  const judgeLatencies = done.flatMap(r => typeof r.judge_latency_ms === 'number' ? [r.judge_latency_ms] : []);
  const answerPromptTokens = done.reduce((sum, r) => sum + (r.answer_tokens?.prompt ?? 0), 0);
  const answerCompletionTokens = done.reduce((sum, r) => sum + (r.answer_tokens?.completion ?? 0), 0);
  const judgePromptTokens = done.reduce((sum, r) => sum + (r.judge_tokens?.prompt ?? 0), 0);
  const judgeCompletionTokens = done.reduce((sum, r) => sum + (r.judge_tokens?.completion ?? 0), 0);

  const sourceSnapshotAtEnd = sourceSnapshotSha256(join(__dirname, '..', '..'));
  assertSourceSnapshotUnchanged(sourceSnapshotAtStart, sourceSnapshotAtEnd);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      runId,
      protocol: runConfig.protocol,
      sourceRevision,
      sourceDiffSha256,
      sourceSnapshotSha256: sourceSnapshotAtStart,
      sourceSnapshotSha256AtStart: sourceSnapshotAtStart,
      sourceSnapshotSha256AtEnd: sourceSnapshotAtEnd,
      datasetSha256,
      config: runConfig,
      credentialAvailability: { nvidiaApiKey: Boolean(process.env.NVIDIA_API_KEY) },
      command: 'bun benchmark/runners/locomo.ts',
      answerModel,
      judgeModel,
      memoryMode,
      dataset: 'locomo10',
      personas: dataset.length,
      questionsTested: totalScored,
      questionsCorrect: correct,
      questionsPartial: partial,
      questionsFailed: failed.length,
      questionsExcludedByProtocol: excludedQuestions.length,
      excludedQuestions,
      totalQuestions,
      jsonlPath,
    },
    results: {
      correct,
      partial,
      incorrect,
      failed: failed.length,
      score,
      judged: judged.length,
      grounded: judged.filter(r => r.judge_grounded).length,
      stale: judged.filter(r => r.judge_stale).length,
      shouldAbstain: judged.filter(r => r.judge_should_abstain).length,
      exactMatches: done.filter(r => r.exact_match).length,
      answerLatencyMs: { p50: percentile(answerLatencies, 0.5), p95: percentile(answerLatencies, 0.95) },
      judgeLatencyMs: { p50: percentile(judgeLatencies, 0.5), p95: percentile(judgeLatencies, 0.95) },
      tokens: {
        answerPrompt: answerPromptTokens,
        answerCompletion: answerCompletionTokens,
        judgePrompt: judgePromptTokens,
        judgeCompletion: judgeCompletionTokens,
      },
      byCategory: Object.entries(byCategory).map(([cat, stats]) => ({
        category: Number(cat),
        categoryName: stats.name,
        ...stats,
        score: stats.total > 0 ? Math.round(((stats.correct + stats.partial * 0.5) / stats.total) * 100) : 0,
      })),
    },
    durationMs,
  };

  const reportSlug = `locomo-${memoryMode}-${modelSlug}-${runId}`;
  const reportPath = join(REPORTS_DIR, `${reportSlug}-report.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark Results ===`);
    console.log(`Model: ${answerModel}`);
    console.log(`Judge: ${judgeModel}`);
    console.log(`Memory: ${memoryMode}`);
    console.log(`Duration: ${(durationMs / 1000 / 60).toFixed(1)} minutes`);
    console.log(`\nOverall (${totalScored} questions scored):`);
    console.log(`  Correct:   ${correct} (${(correct / totalScored * 100).toFixed(1)}%)`);
    console.log(`  Partial:   ${partial} (${(partial / totalScored * 100).toFixed(1)}%)`);
    console.log(`  Incorrect: ${incorrect} (${(incorrect / totalScored * 100).toFixed(1)}%)`);
    console.log(`  Failed:    ${failed.length} (${(failed.length / totalScored * 100).toFixed(1)}%)`);
    console.log(`  Score:     ${score}%`);
    console.log(`\nBy Category:`);
    for (const [cat, stats] of Object.entries(byCategory)) {
      const catScore = stats.total > 0 ? Math.round(((stats.correct + stats.partial * 0.5) / stats.total) * 100) : 0;
      console.log(`  ${stats.name}: ${catScore}% (${stats.correct}/${stats.total} correct, ${stats.partial} partial, ${stats.failed} failed)`);
    }
    console.log(`\nJSONL: ${jsonlPath}`);
    console.log(`Report: ${reportPath}`);
  }

  return report;
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: bun benchmark/runners/locomo.ts [options]
  --memory=full|squish     Memory mode: full context or Squish retrieval (default: full)
  --model=<m>              Answer model (default: poolside/laguna-xs-2.1)
  --judge-model=<m>        Judge model (default: pinned independent judge)
  --limit=N                Maximum questions to process
  --quiet                  Suppress output`);
    process.exit(0);
  }

  runLoCoMoBenchmark({
    limit: parseQuestionLimit(getArg('limit')),
    quiet: argv.includes('--quiet'),
    memoryMode: (getArg('memory') as 'full' | 'squish') || 'full',
    answerModel: getArg('model'),
    judgeModel: getArg('judge-model'),
  })
    .then(report => { process.exitCode = getLoCoMoBenchmarkExitCode(report); })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
