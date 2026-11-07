import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDataset, extractSessions, turnToMemory, buildSessionTag } from './locomo-ingest.js';
import { computeF1, computeRetrievalRecall, scoreAdversarial, scoreAdversarialRetrieval, buildBenchmarkResult } from './locomo-score.js';
import type { QuestionResult } from './locomo-types.js';
import { CATEGORY_LABELS } from './locomo-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NVIDIA_API_KEY = process.env.BENCH_NVIDIA_API_KEY || process.env.NVIDIA_API_KEY;
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

const CONFIG = {
  datasetPath: resolve(__dirname, 'locomo10.json'),
  tracesDir: resolve(__dirname, 'traces'),
  resultsPath: resolve(__dirname, 'RESULTS.json'),
  mode: (process.env.BENCH_MODE as 'retrieval-only' | 'with-llm') || 'retrieval-only',
  llmModel: process.env.BENCH_LLM_MODEL || 'poolside/laguna-xs-2.1',
  topK: parseInt(process.env.BENCH_TOP_K || '50'),
  maxQuestionsPerConv: parseInt(process.env.BENCH_MAX_Q || '0'),
  maxConversations: parseInt(process.env.BENCH_MAX_CONVS || '0'),
  projectPrefix: 'locomo-bench',
};

async function nvidiaCallLLM(prompt: string): Promise<string | null> {
  if (!NVIDIA_API_KEY) return null;
  try {
    const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: CONFIG.llmModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        temperature: 0.1,
      }),
    });
    if (!response.ok) {
      console.error(`NVIDIA API error: ${response.status}`);
      return null;
    }
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error(`NVIDIA API call failed: ${err}`);
    return null;
  }
}

async function loadSquish() {
  const memories = await import('../core/memory/memories.js');
  const projects = await import('../core/projects.js');
  return { memories, projects };
}

async function ingestConversation(
  convIndex: number,
  conv: any,
  squish: Awaited<ReturnType<typeof loadSquish>>,
): Promise<{ projectId: string; memoryCount: number }> {
  const sessions = extractSessions(conv);
  const projectPath = `${CONFIG.projectPrefix}/conv${convIndex}`;

  const project = await squish.projects.getOrCreateProject(projectPath);
  const projectId = project?.id || projectPath;

  let memoryCount = 0;

  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const session = sessions[sIdx];
    const sessionTag = buildSessionTag(convIndex, sIdx);

    for (const turn of session.turns) {
      const content = turnToMemory(turn, conv.conversation.speaker_a, conv.conversation.speaker_b, session.date);

      await squish.memories.rememberMemory({
        content,
        type: 'observation',
        tags: [sessionTag, `locomo_conv${convIndex}`],
        project: projectPath,
        user: turn.speaker === conv.conversation.speaker_a ? 'user-a' : 'user-b',
      });

      memoryCount++;
    }
  }

  return { projectId, memoryCount };
}

async function queryAndScore(
  question: string,
  groundTruth: string,
  category: number,
  adversarialAnswer: string | undefined,
  convIndex: number,
  squish: Awaited<ReturnType<typeof loadSquish>>,
): Promise<QuestionResult> {
  const projectPath = `${CONFIG.projectPrefix}/conv${convIndex}`;

  const searchResults = await squish.memories.search({
    query: question,
    limit: CONFIG.topK,
    project: projectPath,
  });

  const topKContent = searchResults.map((r: any) => r.content || '');

  let predicted: string;
  let f1Score: number;
  let precision: number;
  let recall: number;
  let correct: boolean;

  if (CONFIG.mode === 'retrieval-only') {
    // Retrieval-only: measure whether ground truth tokens appear in retrieved content
    if (category === 5) {
      // Adversarial: score 1 if retrieval found nothing relevant (correctly unanswerable)
      const adv = scoreAdversarialRetrieval(topKContent, adversarialAnswer);
      f1Score = adv.score;
      precision = adv.score;
      recall = adv.score;
      correct = adv.score === 1;
      predicted = adv.foundRelevant ? '[retrieval found content]' : '[retrieval found nothing]';
    } else {
      const gt = String(groundTruth || '');
      const result = computeRetrievalRecall(topKContent, gt);
      f1Score = result.recall;
      precision = result.recall;  // not meaningful for retrieval-only, set equal
      recall = result.recall;
      correct = result.found;
      predicted = `recall=${result.recall.toFixed(2)} (${result.found ? 'FOUND' : 'NOT FOUND'})`;
    }
  } else {
    // With-LLM: use NVIDIA API to synthesize a concise answer, then F1 against ground truth
    const context = topKContent.slice(0, 10).join('\n---\n');
    const prompt = `Based on the following context, answer the question concisely in a few words. If the information is not available, say "not available".\n\nContext:\n${context}\n\nQuestion: ${question}\n\nConcise answer:`;
    const llmAnswer = await nvidiaCallLLM(prompt);
    predicted = llmAnswer || '';

    if (category === 5) {
      // Adversarial with LLM: check if LLM says information is not available
      f1Score = scoreAdversarial(predicted);
      precision = f1Score;
      recall = f1Score;
      correct = f1Score === 1;
    } else {
      const gt = String(groundTruth || '');
      if (predicted) {
        const scores = computeF1(predicted, gt);
        f1Score = scores.f1;
        precision = scores.precision;
        recall = scores.recall;
        correct = f1Score > 0.7;
      } else {
        // LLM failed or returned nothing -- fall back to retrieval recall
        const result = computeRetrievalRecall(topKContent, gt);
        f1Score = result.recall;
        precision = result.recall;
        recall = result.recall;
        correct = result.found;
        predicted = `[LLM unavailable, recall=${result.recall.toFixed(2)}]`;
      }
    }
  }

  return {
    question,
    groundTruth: groundTruth || adversarialAnswer || '',
    predicted: predicted.substring(0, 500),
    category,
    categoryLabel: CATEGORY_LABELS[category] || `cat-${category}`,
    f1Score,
    precision,
    recall,
    correct,
    retrievalHits: searchResults.length,
    topKContent: topKContent.map((c: string) => c.substring(0, 200)),
  };
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  LoCoMo Benchmark - Squish Memory System`);
  console.log(`  Mode: ${CONFIG.mode} | Top-K: ${CONFIG.topK} | Model: ${CONFIG.llmModel}`);
  if (CONFIG.mode === 'with-llm') {
    console.log(`  NVIDIA API: ${NVIDIA_API_KEY ? 'configured' : 'NOT SET (will fallback to retrieval-only)'}`);
  }
  console.log(`${'='.repeat(60)}\n`);

  const startTime = Date.now();

  // Set data dir BEFORE importing squish modules so they pick it up.
  // This ensures all DB operations use a dedicated benchmark DB instead
  // of the user's personal squish data.
  const benchDataDir = resolve(__dirname, '.bench-data');
  process.env.SQUISH_DATA_DIR = benchDataDir;
  if (!existsSync(benchDataDir)) mkdirSync(benchDataDir, { recursive: true });
  console.log(`Benchmark data dir: ${benchDataDir}`);

  // Disable expensive features that slow ingestion to a crawl in benchmarks:
  // - contradiction resolution: O(n^2) memory comparisons, not needed for benchmark
  // Keep graph auto-build ON so multi-hop graph traversal works during queries
  process.env.SQUISH_SKIP_CONTRADICTION = 'true';

  // Enable search features that improve retrieval recall:
  process.env.SQUISH_QUERY_EXPANSION = 'true';       // synonym expansion before search
  process.env.SQUISH_ENTITY_RETRIEVAL = 'true';       // boost entity-matching results
  process.env.SQUISH_TEMPORAL_VALIDITY = 'true';      // downrank stale memories for temporal queries
  process.env.SQUISH_CONFIDENCE_THRESHOLD = '0.3';    // return empty when nothing relevant (fixes adversarial)
  process.env.SQUISH_LLM_REWRITE = 'true';            // LLM query rewriting for better retrieval

  console.log(`Loading dataset from ${CONFIG.datasetPath}...`);
  const dataset = loadDataset(CONFIG.datasetPath);
  console.log(`Loaded ${dataset.length} conversations`);

  console.log('Loading squish modules...');
  const squish = await loadSquish();
  console.log('Squish loaded.');

  // Bootstrap DB - getDb() will create squish.db inside .bench-data/
  // because SQUISH_DATA_DIR is already set above. The adapter internally
  // runs ensureSqliteSchema() which creates all tables and runs migrations.
  // The entities table includes mention_count, last_mentioned_at, aliases columns
  // needed by graph auto-build (relationship-extractor.ts, entity-deduplicator.ts).
  console.log('Bootstrapping database...');
  const { getDb } = await import('../db/index.js');
  await getDb();
  console.log('Database ready.\n');

  // Phase 1: Ingest (with auto-detect)
  const convCount = CONFIG.maxConversations > 0
    ? Math.min(dataset.length, CONFIG.maxConversations)
    : dataset.length;

  // Check if we should skip ingestion.
  // Accept --skip, --fresh, or env vars (cmd.exe propagation is unreliable).
  const args = process.argv.slice(2);
  const cliSkip = args.includes('--skip') || args.includes('--skip-ingest');
  const cliFresh = args.includes('--fresh');
  const benchFresh = cliFresh || process.env.BENCH_FRESH === 'true';
  const benchSkipIngest = cliSkip || process.env.BENCH_SKIP_INGEST === 'true';
  let shouldIngest = !benchSkipIngest;

  if (benchFresh) {
    console.log('Fresh mode: forcing re-ingestion');
    shouldIngest = true;
  } else if (benchSkipIngest) {
    console.log('Skip ingestion: using existing DB');
    shouldIngest = false;
  } else {
    // Auto-detect using bun:sqlite (better-sqlite3 is unsupported in bun)
    try {
      const { Database: BunDatabase } = await import('bun:sqlite');
      const dbPath = resolve(benchDataDir, 'squish.db');
      const db = new BunDatabase(dbPath, { readonly: true } as any);
      const row = db.query('SELECT COUNT(*) as count FROM memories').get() as { count: number };
      db.close();
      if (row.count >= 5000) {
        console.log(`DB has ${row.count} memories -- skipping ingestion`);
        shouldIngest = false;
      } else {
        console.log(`DB has ${row.count} memories -- will ingest`);
      }
    } catch (err: any) {
      // If DB doesn't exist or can't count, ingest
      console.log(`Auto-detect failed (${err?.message || err}) -- will ingest`);
    }
  }

  if (shouldIngest) {
    console.log(`--- Phase 1: Ingestion (${convCount} conversations) ---`);
    let totalMemories = 0;
    for (let i = 0; i < convCount; i++) {
      const conv = dataset[i];
      const { memoryCount } = await ingestConversation(i, conv, squish);
      totalMemories += memoryCount;
      console.log(`  Conv ${i}: ${memoryCount} memories (total: ${totalMemories})`);
    }
    console.log(`\nIngested ${totalMemories} memories across ${convCount} conversations\n`);
  } else {
    console.log('Using existing memories in DB.\n');
  }

  // Phase 2: Query and score
  console.log('--- Phase 2: Query & Score ---');
  const allResults: QuestionResult[] = [];

  for (let i = 0; i < convCount; i++) {
    const conv = dataset[i];
    const qaPairs = conv.qa;

    const maxQ = CONFIG.maxQuestionsPerConv > 0
      ? Math.min(qaPairs.length, CONFIG.maxQuestionsPerConv)
      : qaPairs.length;

    console.log(`  Conv ${i}: ${maxQ} questions`);

    for (let q = 0; q < maxQ; q++) {
      const qa = qaPairs[q];
      const result = await queryAndScore(
        qa.question,
        qa.answer || '',
        qa.category,
        qa.adversarial_answer,
        i,
        squish,
      );

      allResults.push(result);

      const traceDir = resolve(CONFIG.tracesDir, `conv${i}`);
      if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true });
      writeFileSync(resolve(traceDir, `q${q}.json`), JSON.stringify(result, null, 2));
    }
  }

  // Phase 3: Report
  const duration = Date.now() - startTime;
  const benchResult = buildBenchmarkResult(CONFIG.mode, allResults, duration, CONFIG.llmModel);

  writeFileSync(CONFIG.resultsPath, JSON.stringify(benchResult, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Mode: ${benchResult.mode}`);
  if (benchResult.model) console.log(`  Model: ${benchResult.model}`);
  console.log(`  Total Questions: ${benchResult.totalQuestions}`);
  console.log(`  Overall F1: ${benchResult.overallF1}%`);
  console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log('');
  console.log('  Per-Category Breakdown:');
  for (const cat of benchResult.categories) {
    console.log(`    ${cat.label.padEnd(15)} ${cat.averageF1.toString().padStart(6)}%  (${cat.totalQuestions} questions)`);
  }
  console.log(`${'='.repeat(60)}\n`);

  return benchResult;
}

main().catch(console.error);
