/**
 * Lexical-only FTS5 LoCoMo session-evidence retrieval measurement.
 * Uses native SQLite FTS5 BM25 rank without vector/recency candidates or rank enhancements.
 * This is a retrieval diagnostic, not answer-quality or benchmark leaderboard evidence.
 * Run: bun benchmark/runners/locomo-retrieval.ts [--top-k=10] [--limit=N] [--concurrency=1]
 * Compare repeat runs: bun benchmark/runners/compare-locomo-retrieval.ts <first.json> <second.json>
 */
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SquishRuntime } from '../../core/runtime/squish-runtime.js';
import { withIsolatedBenchmarkDatabase } from './isolated-db.js';
import { LOCOMO_EVALUATION_TIME, resolveEvidenceSessions, retrievePersonaSessions, seedPersona, withLoCoMoEvaluationClock } from './locomo-memory.js';
import { config } from '../../config.js';
import { getGraphBoostFlags, getPrecisionStackFlags, getRetrievalConfig } from '../../core/retrieval/config.js';
import { getRetrievalDiagnostics } from '../../core/retrieval/profiles.js';
import { getScoringFlags, SCORING_SCHEMA_VERSION } from '../../core/scoring/three-field.js';
import { calculateSessionHitRate, getAdversarialQuestionExclusions } from './locomo-metrics.js';
import { assertSourceSnapshotUnchanged, sourceSnapshotSha256 } from './source-snapshot.js';

interface QA { question: string; answer: string; evidence: string[]; category: number; }
interface Persona {
  sample_id: string;
  qa: QA[];
  conversation: Record<string, unknown>;
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const datasetPath = join(root, 'benchmark', 'datasets', 'locomo', 'locomo10.json');
const PINNED_OFFLINE_ENV = {
  SQUISH_PROFILE: 'fast-local',
  SQUISH_EMBEDDINGS_PROVIDER: 'none',
  SQUISH_RERANKER_ENABLED: 'false',
  SQUISH_QUERY_EXPANSION: 'false',
  SQUISH_CONTEXTUAL_RETRIEVAL: 'false',
  SQUISH_GRAPH_EXPANSION: 'false',
  SQUISH_TEMPORAL_VALIDITY: 'false',
  SQUISH_MMR_ENABLED: 'false',
  SQUISH_DECISION_LAYER_ENABLED: 'false',
  SQUISH_DECISION_MODEL_ENABLED: 'false',
  SQUISH_ALLOW_MODEL_DOWNLOADS: 'false',
  SQUISH_LLM_ENABLED: 'false',
  SQUISH_CONSOLIDATION_ENABLED: 'false',
  SQUISH_GRAPH_AUTO_BUILD: 'false',
  SQUISH_SKIP_CONTRADICTION: 'true',
  SQUISH_LLM_REWRITE: 'false',
  SQUISH_ENTITY_RETRIEVAL: 'false',
  SQUISH_QUERY_PARSER: 'false',
  SQUISH_VECTOR_SCAN: 'full',
  SQUISH_SEARCH_BELIEFS: 'false',
  SQUISH_SCORING_V2: 'true',
  SQUISH_SCORING_SHADOW: 'false',
  SQUISH_GRAPH_BOOST_LEGACY: 'false',
  SQUISH_WEIGHT_RECENCY: '0.5',
  SQUISH_WEIGHT_RELEVANCE: '3',
  SQUISH_WEIGHT_IMPORTANCE: '0',
  SQUISH_WEIGHT_VECTOR_SIM: '3',
  SQUISH_WEIGHT_GRAPH_BOOST: '0.1',
  SQUISH_CONFIDENCE_THRESHOLD: '0.3',
  SQUISH_PLACE_BOOST: '0.15',
  SQUISH_TAG_OVERLAP_BOOST: '0.1',
  SQUISH_GRAPH_NEIGHBOR_BOOST: '0.05',
  SQUISH_RECENCY_BOOST: '0.03',
  SQUISH_USAGE_BOOST: '0.02',
  SQUISH_SUPERSEDED_PENALTY: '0.5',
  SQUISH_CONTRADICTION_RISK_PENALTY: '0.2',
  SQUISH_PLACE_MIN_WEIGHT: '0.35',
  SQUISH_MIN_RESULTS: '3',
  SQUISH_INCLUDE_SUPERSEDED: 'false',
  SQUISH_TAG_CAP: '12',
} as const;

function arg(name: string): string | undefined {
  return process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function sessionRows(conversation: Record<string, unknown>) {
  const speakerA = String(conversation.speaker_a ?? 'speaker_a');
  const speakerB = String(conversation.speaker_b ?? 'speaker_b');
  return Object.keys(conversation)
    .filter(key => /^session_\d+_date_time$/.test(key))
    .map(key => Number(key.match(/^session_(\d+)_date_time$/)?.[1]))
    .sort((a, b) => a - b)
    .flatMap(session => {
      const rows = conversation[`session_${session}`];
      if (!Array.isArray(rows)) return [];
      const text = rows.map(row => {
        if (!row || typeof row !== 'object') return '';
        const message = row as { speaker?: string; dia_id?: string; text?: string };
        const speaker = message.speaker || (message.dia_id?.startsWith('D') ? speakerA : speakerB);
        return `${speaker}: ${message.text ?? ''}`;
      }).filter(Boolean).join('\n');
      return text ? [{ session, date: String(conversation[`session_${session}_date_time`]), text }] : [];
    });
}

function getMetrics(values: number[]) {
  if (values.length === 0) return { mean: null, count: 0 };
  return { mean: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

/** Write reports without replacing an earlier run that shares the same timestamp. */
export function writeUniqueReport(reportDir: string, slug: string, report: unknown): string {
  mkdirSync(reportDir, { recursive: true });
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  for (let suffix = 0; ; suffix++) {
    const filename = `${slug}${suffix === 0 ? '' : `-${suffix}`}.json`;
    const reportPath = join(reportDir, filename);
    let descriptor: number;
    try {
      descriptor = openSync(reportPath, 'wx');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      writeFileSync(descriptor, contents, 'utf8');
      return reportPath;
    } finally {
      closeSync(descriptor);
    }
  }
}

export async function runLoCoMoRetrieval(options?: {
  topK?: number;
  limit?: number;
  concurrency?: number;
  graphExpansion?: boolean;
  retrievalMode?: 'lexical' | 'hybrid';
}) {
  const limit = options?.limit === undefined ? undefined : positiveInteger(options.limit, 'limit', 1);
  const topK = positiveInteger(options?.topK, 'topK', 10);
  const requestedConcurrency = positiveInteger(options?.concurrency, 'concurrency', 1);
  const graphExpansion = options?.graphExpansion ?? false;
  const retrievalMode = options?.retrievalMode ?? 'lexical';
  if (retrievalMode === 'lexical' && graphExpansion) {
    throw new Error('graph expansion cannot be enabled with lexical retrieval mode');
  }
  if (requestedConcurrency > 32) throw new Error('concurrency cannot exceed 32');
  const concurrency = requestedConcurrency;
  const previous = new Map<string, string | undefined>(
    [...new Set([...Object.keys(PINNED_OFFLINE_ENV), 'SQUISH_GRAPH_EXPANSION'])]
      .map(key => [key, process.env[key]])
  );
  try {
    for (const [key, value] of Object.entries(PINNED_OFFLINE_ENV)) process.env[key] = value;
    process.env.SQUISH_GRAPH_EXPANSION = String(graphExpansion);
    return await withIsolatedBenchmarkDatabase(async dataDir => {
      const sourceSnapshotAtStart = sourceSnapshotSha256(root);
      const bytes = readFileSync(datasetPath);
      const dataset = JSON.parse(bytes.toString('utf8')) as Persona[];
      const excludedQuestions = getAdversarialQuestionExclusions(dataset);
      const datasetSha256 = createHash('sha256').update(bytes).digest('hex');
      const runtime = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
      const startedAt = performance.now();
      const traces: Array<Record<string, unknown>> = [];
      const invalidEvidence: Array<{ sampleId: string; question: string; reason: string; fragments: string[]; missingSessions: number[] }> = [];
      let personasSeeded = 0;
      let considered = 0;

      for (const persona of dataset) {
        const project = join(dataDir, 'personas', persona.sample_id);
        mkdirSync(project, { recursive: true });
        const sessionByMemoryId = await seedPersona(runtime, sessionRows(persona.conversation), persona.sample_id, project, {
          useSessionDateAsCreatedAt: true,
        });
        personasSeeded++;
        const availableSessions = new Set(sessionByMemoryId.values());
        const eligibleQuestions = persona.qa.flatMap((item, questionIndex) =>
          item.category !== 5 ? [{ ...item, questionIndex }] : []
        );
        const remaining = limit === undefined ? eligibleQuestions.length : Math.max(0, limit - considered);
        const questions = eligibleQuestions.slice(0, remaining);
        considered += questions.length;
        for (let offset = 0; offset < questions.length; offset += concurrency) {
          const batch = questions.slice(offset, offset + concurrency);
          const batchResults = await withLoCoMoEvaluationClock(() => Promise.all(batch.map(async qa => {
            const expected = resolveEvidenceSessions(qa.evidence, availableSessions);
            const retrievalStartedAt = performance.now();
            const retrieved = await retrievePersonaSessions(runtime, qa.question, project, sessionByMemoryId, topK, retrievalMode);
            const retrievalMs = performance.now() - retrievalStartedAt;
            const retrievedSessions = [...new Set(retrieved.map(item => item.session))];
            const hits = retrievedSessions.filter(session => expected.sessions.includes(session));
            return {
              trace: {
                sampleId: persona.sample_id,
                questionIndex: qa.questionIndex,
                question: qa.question,
                category: qa.category,
                expectedEvidence: qa.evidence,
                expectedSessions: expected.sessions,
                evidenceComplete: expected.complete,
                retrieved,
                hitSessions: hits,
                sessionRecall: expected.complete ? hits.length / expected.sessions.length : null,
                hit: hits.length > 0,
                scored: expected.complete,
                retrievalMs,
              },
              invalid: expected.complete ? null : {
                sampleId: persona.sample_id,
                questionIndex: qa.questionIndex,
                question: qa.question,
                reason: expected.exclusionReason ?? 'unknown',
                fragments: expected.unmapped,
                missingSessions: expected.missingSessions,
              },
            };
          })));
          for (const result of batchResults) {
            traces.push(result.trace);
            if (result.invalid) invalidEvidence.push(result.invalid);
          }
        }
        if (limit !== undefined && considered >= limit) break;
      }

      const scored = traces.filter(trace => trace.scored === true);
      const recalls = scored.map(trace => Number(trace.sessionRecall));
      const retrievalTimes = traces.map(trace => Number(trace.retrievalMs));
      const totalExpected = scored.reduce((sum, trace) => sum + (trace.expectedSessions as number[]).length, 0);
      const totalHits = scored.reduce((sum, trace) => sum + (trace.hitSessions as number[]).length, 0);
      const wallMs = Math.round(performance.now() - startedAt);
      const report = {
        protocol: 'squish-locomo-session-evidence-retrieval-v5',
        interpretation: retrievalMode === 'lexical'
          ? 'Coarse session-level evidence recall for native SQLite FTS5 BM25 rank only; lexical mode bypasses vector/recency candidates, graph retrieval, and ranking enhancements. Session hit rate is scorable questions with at least one expected session retrieved divided by all scorable questions. Not answer quality, citation correctness, a full evidence oracle, or a competitor ranking. Serial mode is the default and concurrency above one is a separately labeled sensitivity run. For protocol-v5 serial runs, compare complete reports with compare-locomo-retrieval.ts; a matching pair establishes retrieval repeatability only.'
          : 'Coarse session-level evidence recall for the standard hybrid retrieval pipeline under the recorded offline settings. This mode may include recency-ordered candidates when no embedding vector is available. Session hit rate is scorable questions with at least one expected session retrieved divided by all scorable questions. Not answer quality, citation correctness, a full evidence oracle, or a competitor ranking. Serial mode is the default and concurrency above one is a separately labeled sensitivity run. For protocol-v5 serial runs, compare complete reports with compare-locomo-retrieval.ts; a matching pair establishes retrieval repeatability only.',
        config: {
          pinnedEnv: { ...PINNED_OFFLINE_ENV, SQUISH_GRAPH_EXPANSION: String(graphExpansion) },
          effective: {
            retrievalProfile: getRetrievalDiagnostics(),
            precision: getPrecisionStackFlags(),
            retrieval: getRetrievalConfig(),
            scoringWeights: config.scoringWeights,
            scoringFlags: getScoringFlags(),
            scoringSchemaVersion: SCORING_SCHEMA_VERSION,
            graphBoost: getGraphBoostFlags(),
            vectorScanMode: config.vectorScanMode,
            queryParser: process.env.SQUISH_QUERY_PARSER === 'true',
            queryRewrite: process.env.SQUISH_LLM_REWRITE === 'true',
            entityRetrieval: process.env.SQUISH_ENTITY_RETRIEVAL === 'true',
            beliefs: process.env.SQUISH_SEARCH_BELIEFS !== 'false',
            confidenceThreshold: process.env.SQUISH_CONFIDENCE_THRESHOLD,
          },
          topK,
          limit: limit ?? null,
          concurrency,
          graphExpansion,
          retrievalMode,
          createdAtPolicy: 'conversation_session_date_utc',
          evaluationClock: LOCOMO_EVALUATION_TIME,
          executionEnvironment: {
            bunVersion: process.versions.bun ?? null,
            nodeCompatibilityVersion: process.version,
            platform: process.platform,
            architecture: process.arch,
          },
        },
        provenance: {
          dataset: 'LoCoMo-10',
          datasetSha256,
          sourceFingerprint: 'filesystem-snapshot-v1',
          sourceSnapshotSha256: sourceSnapshotAtStart,
          sourceSnapshotSha256AtStart: sourceSnapshotAtStart,
          sourceSnapshotSha256AtEnd: null,
        },
        counts: {
          personas: dataset.length,
          personasSeeded,
          questionsProcessed: traces.length,
          questionsScored: scored.length,
          questionsExcludedForIncompleteEvidence: traces.length - scored.length,
          questionsExcludedByProtocol: excludedQuestions.length,
          evidenceLabelsWithUnmappedOrUnseededReferences: invalidEvidence.length,
        },
        metrics: {
          macroSessionRecallAtK: getMetrics(recalls).mean,
          sessionHitRateAtK: calculateSessionHitRate(scored.map(trace => trace.hit === true)),
          microSessionRecallAtK: totalExpected ? totalHits / totalExpected : null,
          retrievalLatencyMs: { p50: percentile(retrievalTimes, 0.50), p95: percentile(retrievalTimes, 0.95), totalWallMs: wallMs, questionsPerSecond: traces.length / (wallMs / 1000) },
          topK,
        },
        traces,
        excludedQuestions,
        invalidEvidence,
      };
      const reportDir = join(root, 'benchmark', 'reports');
      const slug = `locomo-session-evidence-k${topK}-${limit ? `n${limit}` : 'full'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const sourceSnapshotAtEnd = sourceSnapshotSha256(root);
      assertSourceSnapshotUnchanged(sourceSnapshotAtStart, sourceSnapshotAtEnd);
      (report.provenance as Record<string, unknown>).sourceSnapshotSha256AtEnd = sourceSnapshotAtEnd;
      const reportPath = writeUniqueReport(reportDir, slug, report);
      console.log(JSON.stringify({ reportPath, counts: report.counts, metrics: report.metrics, datasetSha256 }, null, 2));
      return report;
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

if (import.meta.main) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: bun benchmark/runners/locomo-retrieval.ts [--top-k=10] [--limit=N] [--concurrency=1] [--retrieval-mode=lexical|hybrid] [--graph-expansion=on|off]');
  } else {
    const graphExpansionArg = arg('graph-expansion');
    const retrievalModeArg = arg('retrieval-mode');
    if (graphExpansionArg !== undefined && graphExpansionArg !== 'on' && graphExpansionArg !== 'off') {
      throw new Error('--graph-expansion must be on or off');
    }
    if (retrievalModeArg !== undefined && retrievalModeArg !== 'lexical' && retrievalModeArg !== 'hybrid') {
      throw new Error('--retrieval-mode must be lexical or hybrid');
    }
    runLoCoMoRetrieval({ topK: arg('top-k') ? Number(arg('top-k')) : undefined, limit: arg('limit') ? Number(arg('limit')) : undefined, concurrency: arg('concurrency') ? Number(arg('concurrency')) : undefined, graphExpansion: graphExpansionArg === 'on', retrievalMode: retrievalModeArg as 'lexical' | 'hybrid' | undefined })
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
