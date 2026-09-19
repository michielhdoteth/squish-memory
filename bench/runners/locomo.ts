/**
 * LoCoMo benchmark runner.
 *
 * Moved from tests/benchmarks/locomo-bench.ts.
 * Tests memory retrieval quality against the LoCoMo dataset.
 *
 * Run: bun bench/runners/locomo.ts [--limit N] [--quiet]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNVIDIAAnswerAdapter } from '../adapters/answer-models/nvidia.js';
import { createNVIDIAJudgeAdapter } from '../adapters/judges/nvidia.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number; // 1=single-hop, 2=multi-hop, 3=reasoning
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
  question: string;
  expected: string;
  predicted: string;
  correct: boolean;
  partial: boolean;
  category: number;
  evidence: string[];
  judgeReasoning?: string;
}

// ─── Answer Model ──────────────────────────────────────────────────────────

const MODEL = process.env.BENCH_ANSWER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b';

// ─── Answer Matching ────────────────────────────────────────────────────────

function normalizeAnswer(answer: any): string {
  const str = String(answer ?? '');
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkCorrect(predicted: string, expected: string): boolean {
  const normPred = normalizeAnswer(predicted);
  const normExp = normalizeAnswer(expected);
  if (normPred === normExp) return true;
  if (normPred.includes(normExp)) return true;
  const expectedTerms = normExp.split(' ').filter(t => t.length > 3);
  const predictedTerms = normPred.split(' ');
  const matchCount = expectedTerms.filter(t => predictedTerms.some(pt => pt.includes(t))).length;
  return matchCount >= Math.ceil(expectedTerms.length * 0.7);
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

  // Dynamically discover all session_N_date_time keys instead of hardcoding limit
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

// ─── Main Benchmark ─────────────────────────────────────────────────────────

export async function runLoCoMoBenchmark(options?: {
  limit?: number;
  quiet?: boolean;
  judgeProvider?: string;
  judgeModel?: string;
}) {
  const limit = options?.limit;
  const quiet = options?.quiet ?? false;
  const judgeProvider = options?.judgeProvider || 'nvidia';
  const judgeModel = options?.judgeModel || 'nvidia/nemotron-3-ultra-550b-a55b';

  const startedAt = Date.now();

  const datasetPath = join(__dirname, '..', 'datasets', 'locomo', 'locomo10.json');
  const dataset: LoCoMoPersona[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  // Create answer and judge adapters using shared NVIDIA adapter
  const answerAdapter = createNVIDIAAnswerAdapter(MODEL);
  const judgeAdapter = createNVIDIAJudgeAdapter(judgeModel);

  const results: BenchmarkResult[] = [];
  let totalQuestions = 0;
  let processedQuestions = 0;

  for (const persona of dataset) {
    totalQuestions += persona.qa.length;
  }

  const questionsToProcess = limit ? Math.min(limit, totalQuestions) : totalQuestions;

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark ===`);
    console.log(`Answer Model: ${MODEL}`);
    console.log(`Judge: ${judgeAdapter.name}`);
    console.log(`Dataset: ${dataset.length} personas, ${totalQuestions} questions`);
    console.log(`Processing: ${questionsToProcess} questions\n`);
  }

  for (const persona of dataset) {
    if (processedQuestions >= questionsToProcess) break;

    if (!quiet) {
      console.log(`Processing persona ${persona.sample_id}...`);
    }

    let conversationText = extractConversationText(persona.conversation as any);
    if (conversationText.length > 6000) {
      conversationText = conversationText.substring(0, 6000) + '\n\n[conversation truncated]';
    }

    const summary = persona.session_summary || '';
    const observations = persona.observation || '';
    const contextBlock = `CONVERSATION CONTEXT:\n${conversationText}\n\nSUMMARY:\n${summary}\n\nOBSERVATIONS:\n${observations}`;

    for (const qa of persona.qa) {
      if (processedQuestions >= questionsToProcess) break;

      try {
        const answerResult = await answerAdapter.answer({ query: qa.question, context: [contextBlock] });
        const predicted = answerResult.answer;

        // Fast pre-filter: exact/near-exact string match skips LLM judge
        const normPred = normalizeAnswer(predicted);
        const normExp = normalizeAnswer(qa.answer);
        const isExactMatch = normPred === normExp || normPred.includes(normExp);

        let correct: boolean;
        let partial: boolean;
        let judgeReasoning: string;

        if (isExactMatch) {
          // Fast path: exact match, skip LLM judge
          correct = true;
          partial = false;
          judgeReasoning = 'Exact string match (LLM judge skipped)';
        } else {
          // Slow path: use LLM judge for actual correctness evaluation
          const judgeResult = await judgeAdapter.judge({
            query: qa.question,
            answer: predicted,
            expected: qa.answer,
            context: [conversationText],
          });
          correct = judgeResult.correct;
          // Partial credit via string matching when judge says incorrect
          partial = !correct && checkPartial(predicted, qa.answer);
          judgeReasoning = judgeResult.reasoning || '';
        }

        results.push({
          question: qa.question,
          expected: qa.answer,
          predicted,
          correct,
          partial,
          category: qa.category,
          evidence: qa.evidence,
          judgeReasoning,
        });

        processedQuestions++;

        if (!quiet && processedQuestions % 10 === 0) {
          const correctSoFar = results.filter(r => r.correct).length;
          const partialSoFar = results.filter(r => r.partial).length;
          console.log(`  [${processedQuestions}/${questionsToProcess}] Correct: ${correctSoFar}, Partial: ${partialSoFar}`);
        }

        await new Promise(r => setTimeout(r, 5000));
      } catch (error) {
        console.error(`Error processing question: ${qa.question}`, error);
      }
    }
  }

  const correct = results.filter(r => r.correct).length;
  const partial = results.filter(r => r.partial).length;
  const incorrect = results.length - correct - partial;
  const score = Math.round(((correct + partial * 0.5) / results.length) * 100);

  const byCategory: Record<number, { correct: number; partial: number; total: number }> = {};
  for (const r of results) {
    byCategory[r.category] ??= { correct: 0, partial: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.correct) byCategory[r.category].correct++;
    else if (r.partial) byCategory[r.category].partial++;
  }

  const durationMs = Date.now() - startedAt;

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: MODEL,
      dataset: 'locomo10',
      personas: dataset.length,
      questionsTested: results.length,
      totalQuestions,
    },
    results: {
      correct,
      partial,
      incorrect,
      score,
      byCategory: Object.entries(byCategory).map(([cat, stats]) => ({
        category: Number(cat),
        categoryName: Number(cat) === 1 ? 'single-hop' : Number(cat) === 2 ? 'multi-hop' : 'reasoning',
        ...stats,
        score: Math.round(((stats.correct + stats.partial * 0.5) / stats.total) * 100),
      })),
    },
    durationMs,
    details: results,
  };

  const reportPath = join(__dirname, '..', 'reports', `locomo-${MODEL.split('/').pop()}-${Date.now()}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark Results ===`);
    console.log(`Model: ${MODEL}`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`\nOverall:`);
    console.log(`  Correct:   ${correct}/${results.length} (${(correct / results.length * 100).toFixed(1)}%)`);
    console.log(`  Partial:   ${partial}/${results.length} (${(partial / results.length * 100).toFixed(1)}%)`);
    console.log(`  Incorrect: ${incorrect}/${results.length} (${(incorrect / results.length * 100).toFixed(1)}%)`);
    console.log(`  Score:     ${score}%`);
    console.log(`\nReport saved to: ${reportPath}`);
  }

  return report;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const limitArg = argv.find(a => a.startsWith('--limit='));
const quietFlag = argv.includes('--quiet');

function getArg(name: string): string | undefined {
  const arg = argv.find(a => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: bun bench/runners/locomo.ts [options]
  --limit=N              Maximum questions to process
  --quiet                Suppress output
  --judge-provider=<p>   Judge model provider (default: nvidia)
  --judge-model=<m>      Judge model name`);
  process.exit(0);
}

runLoCoMoBenchmark({
  limit: limitArg ? parseInt(limitArg.split('=')[1]) : undefined,
  quiet: quietFlag,
  judgeProvider: getArg('judge-provider'),
  judgeModel: getArg('judge-model'),
})
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
