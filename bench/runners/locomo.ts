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
 * Run: bun bench/runners/locomo.ts [--memory=full|squish] [--model=<m>] [--judge-model=<m>]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createNVIDIAAnswerAdapter } from '../adapters/answer-models/nvidia.js';
import { createNVIDIAJudgeAdapter } from '../adapters/judges/nvidia.js';

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

const DEFAULT_MODEL = 'poolside/laguna-xs-2.1';
const REPORTS_DIR = join(__dirname, '..', 'reports');

function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
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

function questionKey(sampleId: string, question: string): string {
  let hash = 0;
  const str = `${sampleId}::${question}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return `${hash.toString(16).padStart(8, '0')}`;
}

async function loadJsonlResults(jsonlPath: string): Promise<Map<string, BenchmarkResult>> {
  const results = new Map<string, BenchmarkResult>();
  if (!existsSync(jsonlPath)) return results;

  const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as BenchmarkResult;
      const key = questionKey(entry.sample_id, entry.question);
      // Keep the last entry for each question (in case of retries)
      results.set(key, entry);
    } catch {}
  }

  return results;
}

function appendResult(jsonlPath: string, result: BenchmarkResult): void {
  appendFileSync(jsonlPath, JSON.stringify(result) + '\n');
}

// ─── Squish Retrieval ──────────────────────────────────────────────────────

async function seedAndRetrieve(
  sessions: Array<{ session: number; date: string; text: string }>,
  question: string,
  sampleId: string,
  topK: number = 10,
): Promise<string[]> {
  const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
  const client = new SquishRuntime();

  // Seed: each session becomes a memory
  for (const s of sessions) {
    await client.remember(s.text, {
      type: 'episodic',
      tags: [sampleId, `session-${s.session}`],
      metadata: { persona: sampleId, session: s.session, date: s.date },
    });
  }

  // Retrieve
  const results = await client.search(question, { limit: topK });
  return results.map(r => r.memory.content);
}

// ─── Main Benchmark ─────────────────────────────────────────────────────────

export async function runLoCoMoBenchmark(options?: {
  limit?: number;
  quiet?: boolean;
  memoryMode?: 'full' | 'squish';
  answerModel?: string;
  judgeModel?: string;
  maxRetries?: number;
}) {
  const limit = options?.limit;
  const quiet = options?.quiet ?? false;
  const memoryMode = options?.memoryMode || 'full';
  const answerModel = options?.answerModel || process.env.BENCH_ANSWER_MODEL || DEFAULT_MODEL;
  const judgeModel = options?.judgeModel || process.env.BENCH_JUDGE_MODEL || answerModel;
  const maxRetries = options?.maxRetries ?? 2; // retries for failed questions

  const startedAt = Date.now();

  const datasetPath = join(__dirname, '..', 'datasets', 'locomo', 'locomo10.json');
  const dataset: LoCoMoPersona[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  // Filter out category 5 (adversarial)
  let totalQuestions = 0;
  for (const persona of dataset) {
    totalQuestions += persona.qa.filter(q => q.category !== 5).length;
  }

  const questionsToProcess = limit ? Math.min(limit, totalQuestions) : totalQuestions;

  // JSONL checkpoint path includes model and memory mode
  const modelSlug = answerModel.split('/').pop()?.replace(/[^a-z0-9-]/g, '-') || 'unknown';
  const jsonlPath = join(REPORTS_DIR, `locomo-${memoryMode}-${modelSlug}-results.jsonl`);
  mkdirSync(REPORTS_DIR, { recursive: true });

  // Load existing results - completed questions are skipped, failed are retried
  const existingResults = await loadJsonlResults(jsonlPath);
  let processedQuestions = existingResults.size;

  // Count completed vs failed
  let alreadyDone = 0;
  let alreadyFailed = 0;
  for (const [, entry] of existingResults) {
    if (entry.status === 'done') alreadyDone++;
    else alreadyFailed++;
  }

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark ===`);
    console.log(`Model: ${answerModel}`);
    console.log(`Judge: ${judgeModel}`);
    console.log(`Memory: ${memoryMode}`);
    console.log(`Dataset: ${dataset.length} personas, ${totalQuestions} questions (excl. cat 5)`);
    console.log(`JSONL: ${jsonlPath}`);
    console.log(`Already completed: ${alreadyDone} done, ${alreadyFailed} failed (will retry)`);
    console.log(`Remaining: ${questionsToProcess - alreadyDone} questions\n`);
  }

  const answerAdapter = createNVIDIAAnswerAdapter(answerModel);
  const judgeAdapter = createNVIDIAJudgeAdapter(judgeModel);

  let totalApiFailures = 0;

  for (const persona of dataset) {
    if (processedQuestions >= questionsToProcess) break;

    if (!quiet) {
      console.log(`Processing persona ${persona.sample_id}...`);
    }

    // Prepare conversation data
    let conversationText = extractConversationText(persona.conversation as any);
    const sessionTexts = extractSessionTexts(persona.conversation as any);

    // For squish mode: seed once per persona
    let seededClient: any = null;
    if (memoryMode === 'squish') {
      // We'll seed and retrieve per-question inside the loop
    }

    for (const qa of persona.qa) {
      if (processedQuestions >= questionsToProcess) break;

      // Skip category 5 (adversarial)
      if (qa.category === 5) continue;

      const qKey = questionKey(persona.sample_id, qa.question);
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
        context = await seedAndRetrieve(sessionTexts, qa.question, persona.sample_id, 10);
        if (context.length === 0) {
          context = [conversationText]; // fallback if retrieval returns nothing
        }
      } else {
        // Full context mode - pass conversation, cap at 8K chars for API efficiency
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
          const isExactMatch = normPred === normExp || normPred.includes(normExp);

          let correct: boolean;
          let partial: boolean;
          let judgeReasoning: string;

          if (isExactMatch) {
            correct = true;
            partial = false;
            judgeReasoning = 'Exact string match (LLM judge skipped)';
          } else {
            const judgeResult = await judgeAdapter.judge({
              query: qa.question,
              answer: predicted,
              expected: String(qa.answer ?? ''),
              context: [conversationText], // judge always gets full context for fair comparison
            });
            correct = judgeResult.correct;
            partial = !correct && checkPartial(predicted, String(qa.answer ?? ''));
            judgeReasoning = judgeResult.reasoning || '';
          }

          const result: BenchmarkResult = {
            status: 'done',
            sample_id: persona.sample_id,
            question: qa.question,
            expected: String(qa.answer ?? ''),
            predicted,
            correct,
            partial,
            category: qa.category,
            category_name: categoryName(qa.category),
            evidence: qa.evidence,
            judgeReasoning,
            memory_mode: memoryMode,
            answer_model: answerModel,
            judge_model: judgeModel,
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

  const finalResults = await loadJsonlResults(jsonlPath);
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

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      answerModel,
      judgeModel,
      memoryMode,
      dataset: 'locomo10',
      personas: dataset.length,
      questionsTested: totalScored,
      questionsCorrect: correct,
      questionsPartial: partial,
      questionsFailed: failed.length,
      totalQuestions,
      jsonlPath,
    },
    results: {
      correct,
      partial,
      incorrect,
      failed: failed.length,
      score,
      byCategory: Object.entries(byCategory).map(([cat, stats]) => ({
        category: Number(cat),
        categoryName: stats.name,
        ...stats,
        score: stats.total > 0 ? Math.round(((stats.correct + stats.partial * 0.5) / stats.total) * 100) : 0,
      })),
    },
    durationMs,
  };

  const reportSlug = `locomo-${memoryMode}-${modelSlug}`;
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
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: bun bench/runners/locomo.ts [options]
  --memory=full|squish     Memory mode: full context or Squish retrieval (default: full)
  --model=<m>              Answer model (default: poolside/laguna-xs-2.1)
  --judge-model=<m>        Judge model (default: same as --model)
  --limit=N                Maximum questions to process
  --quiet                  Suppress output`);
  process.exit(0);
}

runLoCoMoBenchmark({
  limit: getArg('limit') ? parseInt(getArg('limit')!) : undefined,
  quiet: argv.includes('--quiet'),
  memoryMode: (getArg('memory') as 'full' | 'squish') || 'full',
  answerModel: getArg('model'),
  judgeModel: getArg('judge-model'),
})
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
