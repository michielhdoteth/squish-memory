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
}

// ─── NVIDIA API Client ──────────────────────────────────────────────────────

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const MODEL = process.env.BENCH_ANSWER_MODEL || 'poolside/laguna-xs-2.1';

async function callNvidia(prompt: string, maxTokens = 512, retries = 5): Promise<string> {
  if (!NVIDIA_API_KEY) throw new Error('NVIDIA_API_KEY required for LoCoMo bench');

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          top_p: 0.95,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (response.status === 503) {
        const waitTime = Math.min(Math.pow(2, attempt) * 3000, 30000);
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`NVIDIA API error: ${response.status} - ${error}`);
      }

      const data = await response.json() as any;
      return data.choices[0].message.content.trim();
    } catch (error) {
      if (attempt === retries - 1) throw error;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 2000));
    }
  }
  throw new Error('Max retries exceeded');
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

  for (let i = 1; i <= 35; i++) {
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

export async function runLoCoMoBenchmark(limit?: number, quiet = false) {
  const startedAt = Date.now();

  const datasetPath = join(__dirname, '..', 'datasets', 'locomo', 'locomo10.json');
  const dataset: LoCoMoPersona[] = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  const results: BenchmarkResult[] = [];
  let totalQuestions = 0;
  let processedQuestions = 0;

  for (const persona of dataset) {
    totalQuestions += persona.qa.length;
  }

  const questionsToProcess = limit ? Math.min(limit, totalQuestions) : totalQuestions;

  if (!quiet) {
    console.log(`\n=== LoCoMo Benchmark ===`);
    console.log(`Model: ${MODEL}`);
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
    const context = `CONVERSATION CONTEXT:\n${conversationText}\n\nSUMMARY:\n${summary}\n\nOBSERVATIONS:\n${observations}\n\nAnswer the following question based on the conversation above. Be concise and accurate. If the answer is not in the conversation, say "not mentioned".`;

    for (const qa of persona.qa) {
      if (processedQuestions >= questionsToProcess) break;

      const prompt = `${context}\n\nQuestion: ${qa.question}\n\nAnswer (be concise, just the answer):`;

      try {
        const predicted = await callNvidia(prompt);
        const correct = checkCorrect(predicted, qa.answer);
        const partial = !correct && checkPartial(predicted, qa.answer);

        results.push({
          question: qa.question,
          expected: qa.answer,
          predicted,
          correct,
          partial,
          category: qa.category,
          evidence: qa.evidence,
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

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: bun bench/runners/locomo.ts [--limit N] [--quiet]');
  process.exit(0);
}

runLoCoMoBenchmark(limitArg ? parseInt(limitArg.split('=')[1]) : undefined, quietFlag)
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
