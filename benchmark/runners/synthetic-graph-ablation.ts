/**
 * Small deterministic graph on/off diagnostic over the four fixed synthetic
 * multi-hop questions. This is directional fixture evidence, not a public
 * benchmark or a claim about general graph quality.
 *
 * Run: bun benchmark/runners/synthetic-graph-ablation.ts [--out benchmark/reports/<name>.json]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceSnapshotUnchanged, sourceSnapshotSha256 } from './source-snapshot.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DATASET_PATH = join(ROOT, 'benchmark', 'datasets', 'golden', 'golden-set.json');
const REPORTS_DIR = join(ROOT, 'benchmark', 'reports');
const TOP_K = 10;
export const MINIMUM_FREE_MEMORY_BYTES = 1024 ** 3;
export const DEFAULT_MULTI_HOP_QUERY_IDS = [
  'q_multihop_01',
  'q_multihop_02',
  'q_multihop_03',
  'q_multihop_04',
] as const;

/** All run settings are fixed; the graph flag is the sole intended difference. */
export const SYNTHETIC_GRAPH_BASE_ENV = Object.freeze({
  DATABASE_URL: '',
  SQUISH_DATABASE_URL: '',
  SQUISH_PROFILE: 'fast-local',
  SQUISH_EMBEDDINGS_PROVIDER: 'local',
  SQUISH_LOCAL_BUNDLED_MODEL: 'off',
  SQUISH_ALLOW_MODEL_DOWNLOADS: 'false',
  SQUISH_LLM_ENABLED: 'false',
  SQUISH_DECISION_LAYER_ENABLED: 'false',
  SQUISH_DECISION_MODEL_ENABLED: 'false',
  SQUISH_DECISION_HOSTED_EGRESS_ENABLED: 'false',
  SQUISH_MANAGED_AI_ENABLED: 'false',
  SQUISH_RERANKER_ENABLED: 'false',
  SQUISH_QUERY_EXPANSION: 'false',
  SQUISH_CONTEXTUAL_RETRIEVAL: 'false',
  SQUISH_GRAPH_AUTO_BUILD: 'true',
  SQUISH_TEMPORAL_VALIDITY: 'true',
  SQUISH_MMR_ENABLED: 'false',
  SQUISH_QUERY_PARSER: 'false',
  SQUISH_ENTITY_RETRIEVAL: 'false',
  SQUISH_LLM_REWRITE: 'false',
  SQUISH_CONSOLIDATION_ENABLED: 'false',
  SQUISH_SEARCH_BELIEFS: 'false',
  SQUISH_SCORING_V2: 'true',
  SQUISH_SCORING_SHADOW: 'false',
  SQUISH_GRAPH_BOOST_LEGACY: 'false',
  SQUISH_VECTOR_SCAN: 'full',
} satisfies Record<string, string>);

export interface SyntheticGraphQuery {
  id: string;
  category: string;
  query: string;
  mustHit: string[];
  mayHit: string[];
}

export interface SyntheticGraphEvidence {
  goldenId: string;
  contentSha256: string;
  score: number | null;
  estimatedTokens: number;
}

export interface SyntheticGraphQueryTrace extends SyntheticGraphQuery {
  topK: number;
  retrieved: SyntheticGraphEvidence[];
  recallAt5: number;
  reciprocalRank: number;
  hitAt1: boolean;
  retrievalLatencyMs: number;
  estimatedReturnedContentTokens: number;
}

export interface SyntheticGraphRunReport {
  protocol: 'squish-synthetic-multihop-graph-ablation-v1';
  generatedAt: string;
  graphExpansion: boolean;
  corpusMemoryCount: number;
  datasetSha256: string;
  pairInputSha256: string;
  sourceSnapshotSha256AtStart: string;
  sourceSnapshotSha256AtEnd: string;
  runtime: { bunVersion: string | null; nodeCompatibilityVersion: string; platform: string; architecture: string };
  config: {
    pinnedEnv: Record<string, string>;
    effective: Record<string, unknown>;
    topK: number;
    retrievalMode: 'hybrid';
    concurrency: 1;
  };
  queries: SyntheticGraphQueryTrace[];
  metrics: {
    questionCount: number;
    macroRecallAt5: number;
    macroReciprocalRank: number;
    hitRateAt1: number;
    retrievalLatencyMs: { p50: number; p95: number; total: number };
    estimatedReturnedContentTokens: { total: number; meanPerQuestion: number };
    modelTokens: 0;
    networkEgressBytes: 0;
  };
}

export interface SyntheticGraphPairReport {
  protocol: 'squish-synthetic-multihop-graph-paired-v1';
  interpretation: string;
  graphOff: SyntheticGraphRunReport;
  graphOn: SyntheticGraphRunReport;
  deltasGraphOnMinusOff: {
    macroRecallAt5: number;
    macroReciprocalRank: number;
    hitRateAt1: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    estimatedReturnedContentTokens: number;
  };
  pairedQuestions: Array<{
    id: string;
    recallAt5Delta: number;
    reciprocalRankDelta: number;
    hitAt1Delta: number;
    evidenceOverlap: number;
    graphOnAddedEvidenceIds: string[];
    graphOnRemovedEvidenceIds: string[];
    latencyDeltaMs: number;
    estimatedTokenDelta: number;
  }>;
}

type JsonRecord = Record<string, unknown>;

export function graphAblationEnvironment(graphExpansion: boolean): Record<string, string> {
  return { ...SYNTHETIC_GRAPH_BASE_ENV, SQUISH_GRAPH_EXPANSION: String(graphExpansion) };
}

export function assertMinimumFreeMemory(freeBytes: number): void {
  if (!Number.isFinite(freeBytes) || freeBytes < MINIMUM_FREE_MEMORY_BYTES) {
    throw new Error('Synthetic graph ablation requires at least 1 GiB of currently free memory');
  }
}

/** Refuse ambient provider/model settings before touching a database. */
export function assertOfflineEnvironment(env: Record<string, string>): void {
  for (const [key, expected] of Object.entries(SYNTHETIC_GRAPH_BASE_ENV)) {
    if (env[key] !== expected) throw new Error(`Synthetic graph run requires pinned ${key}=${expected}`);
  }
  if (!['true', 'false'].includes(env.SQUISH_GRAPH_EXPANSION ?? '')) {
    throw new Error('Synthetic graph run requires an explicit graph-expansion toggle');
  }
  if (env.SQUISH_EMBEDDINGS_PROVIDER !== 'local' || env.SQUISH_LOCAL_BUNDLED_MODEL !== 'off'
    || env.SQUISH_ALLOW_MODEL_DOWNLOADS !== 'false' || env.SQUISH_LLM_ENABLED !== 'false'
    || env.SQUISH_DECISION_MODEL_ENABLED !== 'false' || env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED !== 'false'
    || env.SQUISH_MANAGED_AI_ENABLED !== 'false' || env.DATABASE_URL !== '' || env.SQUISH_DATABASE_URL !== '') {
    throw new Error('Synthetic graph run must use offline local CPU retrieval and an isolated SQLite database');
  }
}

export function selectSyntheticMultiHopQueries<T extends SyntheticGraphQuery>(
  queries: T[],
  queryIds: readonly string[] = DEFAULT_MULTI_HOP_QUERY_IDS,
): T[] {
  const byId = new Map(queries.map(query => [query.id, query]));
  if (byId.size !== queries.length) throw new Error('Synthetic graph fixture contains duplicate question IDs');
  if (queryIds.length === 0 || new Set(queryIds).size !== queryIds.length) {
    throw new Error('Synthetic graph fixture must pin unique multi-hop question IDs');
  }
  const selected = queryIds.map(id => byId.get(id));
  if (selected.some(query => !query)) throw new Error('Synthetic graph fixture is missing a pinned multi-hop question');
  const resolved = selected as T[];
  if (queries.filter(query => query.category === 'multi-hop').length !== queryIds.length
    || resolved.some(query => query.category !== 'multi-hop')) {
    throw new Error('Synthetic graph fixture multi-hop question scope changed');
  }
  if (resolved.some(query => typeof query.query !== 'string' || query.query.trim().length === 0)) {
    throw new Error('Synthetic graph fixture contains a blank multi-hop query');
  }
  return resolved;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function comparableConfig(report: SyntheticGraphRunReport): string {
  const config = structuredClone(report.config) as unknown as JsonRecord;
  const pinnedEnv = config.pinnedEnv as JsonRecord;
  const effective = config.effective as JsonRecord;
  const precision = effective.precision as JsonRecord;
  const retrieval = effective.retrievalProfile as JsonRecord;
  const features = retrieval.features as JsonRecord;
  delete config.graphExpansion;
  delete pinnedEnv.SQUISH_GRAPH_EXPANSION;
  delete precision.graphExpansion;
  delete features.graphExpansion;
  return stableJson(config);
}

function validateRunReport(report: SyntheticGraphRunReport, label: string, expectedGraph: boolean): void {
  if (report.protocol !== 'squish-synthetic-multihop-graph-ablation-v1') throw new Error(`${label}: unsupported protocol`);
  assertOfflineEnvironment(report.config.pinnedEnv);
  const precision = report.config.effective.precision;
  if (!isRecord(precision) || report.graphExpansion !== expectedGraph
    || report.config.pinnedEnv.SQUISH_GRAPH_EXPANSION !== String(expectedGraph)
    || precision.graphExpansion !== expectedGraph) {
    throw new Error(`${label}: graph expansion setting mismatch`);
  }
  const retrieval = report.config.effective.retrievalProfile;
  if (!isRecord(retrieval) || !isRecord(retrieval.features) || !isRecord(retrieval.features.graphExpansion)
    || retrieval.features.graphExpansion.value !== expectedGraph || retrieval.features.graphExpansion.source !== 'explicit') {
    throw new Error(`${label}: effective retrieval profile does not attest the graph toggle`);
  }
  if (report.corpusMemoryCount < 50 || report.config.topK !== TOP_K || report.config.retrievalMode !== 'hybrid'
    || report.config.concurrency !== 1 || report.queries.length === 0) {
    throw new Error(`${label}: corpus, query, or retrieval budget scope mismatch`);
  }
  if (!/^[a-f0-9]{64}$/.test(report.datasetSha256) || !/^[a-f0-9]{64}$/.test(report.pairInputSha256)
    || !/^[a-f0-9]{64}$/.test(report.sourceSnapshotSha256AtStart)
    || !/^[a-f0-9]{64}$/.test(report.sourceSnapshotSha256AtEnd)) {
    throw new Error(`${label}: dataset, paired-input, or source fingerprint is invalid`);
  }
  if (report.config.effective.embeddingsProvider !== 'local'
    || report.config.effective.bundledModel !== 'off'
    || report.config.effective.modelDownloadsAllowed !== false
    || report.config.effective.hostedModelsEnabled !== false
    || report.config.effective.networkEgress !== 'disabled-by-pinned-local-providers-and-model-gates') {
    throw new Error(`${label}: effective model or network settings are not offline`);
  }
  if (report.sourceSnapshotSha256AtStart !== report.sourceSnapshotSha256AtEnd) {
    throw new Error(`${label}: source changed during run`);
  }
  if (report.metrics.modelTokens !== 0 || report.metrics.networkEgressBytes !== 0) {
    throw new Error(`${label}: model use or network egress is forbidden`);
  }
}

export function compareSyntheticGraphReports(
  graphOff: SyntheticGraphRunReport,
  graphOn: SyntheticGraphRunReport,
): SyntheticGraphPairReport {
  validateRunReport(graphOff, 'graph-off', false);
  validateRunReport(graphOn, 'graph-on', true);
  for (const [label, left, right] of [
    ['dataset hash', graphOff.datasetSha256, graphOn.datasetSha256],
    ['paired input fingerprint', graphOff.pairInputSha256, graphOn.pairInputSha256],
    ['source snapshot', graphOff.sourceSnapshotSha256AtStart, graphOn.sourceSnapshotSha256AtStart],
    ['runtime identity', graphOff.runtime, graphOn.runtime],
    ['non-graph configuration', comparableConfig(graphOff), comparableConfig(graphOn)],
  ] as const) {
    if (stableJson(left) !== stableJson(right)) throw new Error(`Synthetic graph reports mismatch: ${label}`);
  }

  const onById = new Map(graphOn.queries.map(query => [query.id, query]));
  if (new Set(graphOff.queries.map(query => query.id)).size !== graphOff.queries.length
    || new Set(graphOn.queries.map(query => query.id)).size !== graphOn.queries.length) {
    throw new Error('Synthetic graph report contains duplicate query IDs');
  }
  const pairedQuestions = graphOff.queries.map(off => {
    const on = onById.get(off.id);
    if (!on) throw new Error(`Synthetic graph reports mismatch: question IDs (${off.id})`);
    for (const [field, left, right] of [
      ['query', off.query, on.query],
      ['category', off.category, on.category],
      ['must-hit labels', off.mustHit, on.mustHit],
      ['may-hit labels', off.mayHit, on.mayHit],
      ['top-k budget', off.topK, on.topK],
    ] as const) {
      if (stableJson(left) !== stableJson(right)) throw new Error(`Synthetic graph reports mismatch: ${off.id} ${field}`);
    }
    const offIds = off.retrieved.map(item => item.goldenId);
    const onIds = on.retrieved.map(item => item.goldenId);
    const offSet = new Set(offIds);
    const onSet = new Set(onIds);
    return {
      id: off.id,
      recallAt5Delta: on.recallAt5 - off.recallAt5,
      reciprocalRankDelta: on.reciprocalRank - off.reciprocalRank,
      hitAt1Delta: Number(on.hitAt1) - Number(off.hitAt1),
      evidenceOverlap: [...offSet].filter(id => onSet.has(id)).length,
      graphOnAddedEvidenceIds: [...onSet].filter(id => !offSet.has(id)).sort(),
      graphOnRemovedEvidenceIds: [...offSet].filter(id => !onSet.has(id)).sort(),
      latencyDeltaMs: on.retrievalLatencyMs - off.retrievalLatencyMs,
      estimatedTokenDelta: on.estimatedReturnedContentTokens - off.estimatedReturnedContentTokens,
    };
  });
  if (pairedQuestions.length !== graphOn.queries.length
    || pairedQuestions.some((query, index) => query.id !== graphOn.queries[index]?.id)) {
    throw new Error('Synthetic graph report query set or order changed');
  }

  return {
    protocol: 'squish-synthetic-multihop-graph-paired-v1',
    interpretation: `Paired descriptive result on ${pairedQuestions.length} author-created synthetic multi-hop questions over one fixed ${graphOff.corpusMemoryCount}-memory corpus. Only graph expansion is toggled; latency and estimated returned-content tokens are reported separately. This is directional synthetic evidence, not a real-world benchmark, significance test, or answer-quality evaluation.`,
    graphOff,
    graphOn,
    deltasGraphOnMinusOff: {
      macroRecallAt5: graphOn.metrics.macroRecallAt5 - graphOff.metrics.macroRecallAt5,
      macroReciprocalRank: graphOn.metrics.macroReciprocalRank - graphOff.metrics.macroReciprocalRank,
      hitRateAt1: graphOn.metrics.hitRateAt1 - graphOff.metrics.hitRateAt1,
      p50LatencyMs: graphOn.metrics.retrievalLatencyMs.p50 - graphOff.metrics.retrievalLatencyMs.p50,
      p95LatencyMs: graphOn.metrics.retrievalLatencyMs.p95 - graphOff.metrics.retrievalLatencyMs.p95,
      estimatedReturnedContentTokens: graphOn.metrics.estimatedReturnedContentTokens.total - graphOff.metrics.estimatedReturnedContentTokens.total,
    },
    pairedQuestions,
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function runOneCondition(graphExpansion: boolean): Promise<SyntheticGraphRunReport> {
  process.env.SQUISH_GRAPH_EXPANSION = String(graphExpansion);
  const env = graphAblationEnvironment(graphExpansion);
  assertOfflineEnvironment(env);

  const [{ withIsolatedBenchmarkDatabase }, { loadGoldenSet, seedCorpus, scoreRanking }, { estimateTokens },
    { getPrecisionStackFlags, getGraphBoostFlags }, { getRetrievalDiagnostics }, { getScoringFlags },
    { getContextualConfig }, { config }] = await Promise.all([
    import('./isolated-db.js'),
    import('./retrieval.js'),
    import('../../core/context/context-window.js'),
    import('../../core/retrieval/config.js'),
    import('../../core/retrieval/profiles.js'),
    import('../../core/scoring/three-field.js'),
    import('../../core/retrieval/contextual-enrichment.js'),
    import('../../config.js'),
  ]);

  return withIsolatedBenchmarkDatabase(async dataDir => {
    const sourceSnapshotSha256AtStart = sourceSnapshotSha256(ROOT);
    const datasetPath = process.env.SQUISH_GRAPH_ABLATION_DATASET
      ? resolve(ROOT, process.env.SQUISH_GRAPH_ABLATION_DATASET)
      : DEFAULT_DATASET_PATH;
    const datasetBytes = readFileSync(datasetPath);
    const datasetSha256 = sha256(datasetBytes);
    const goldenSet = loadGoldenSet(datasetPath);
    const requestedQueryIds = Array.isArray(goldenSet.meta.graphAblationQueryIds)
      ? goldenSet.meta.graphAblationQueryIds.filter((id): id is string => typeof id === 'string')
      : DEFAULT_MULTI_HOP_QUERY_IDS;
    const queries = selectSyntheticMultiHopQueries(goldenSet.queries, requestedQueryIds);
    // Use a canonical absolute path. On Windows, ensureProject normalizes a
    // POSIX-looking `/__...` path to `C:\__...`, while graph lookup compares
    // the caller's path literally. Keeping this absolute from the start makes
    // the seeded project and graph traversal scope identical on every OS.
    const projectPath = resolve(ROOT, '__squish_synthetic_graph_ablation__');
    const { client, uuidToGolden } = await seedCorpus(goldenSet, dataDir, projectPath);
    // Auto-build is deliberately asynchronous on normal writes. The isolated
    // synthetic corpus needs a complete deterministic graph before timing the
    // paired graph-off/on searches.
    await client.buildGraph(projectPath);
    const runtime = {
      bunVersion: process.versions.bun ?? null,
      nodeCompatibilityVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    };
    const effective = {
      retrievalProfile: getRetrievalDiagnostics(),
      precision: getPrecisionStackFlags(),
      graphBoost: getGraphBoostFlags(),
      scoring: getScoringFlags(),
      scoringWeights: config.scoringWeights,
      vectorScanMode: config.vectorScanMode,
      contextual: getContextualConfig(),
      embeddingsProvider: process.env.SQUISH_EMBEDDINGS_PROVIDER,
      bundledModel: process.env.SQUISH_LOCAL_BUNDLED_MODEL,
      modelDownloadsAllowed: process.env.SQUISH_ALLOW_MODEL_DOWNLOADS === 'true',
      hostedModelsEnabled: process.env.SQUISH_LLM_ENABLED === 'true'
        || process.env.SQUISH_DECISION_MODEL_ENABLED === 'true'
        || process.env.SQUISH_MANAGED_AI_ENABLED === 'true',
      networkEgress: 'disabled-by-pinned-local-providers-and-model-gates',
    };
    const queryScope = queries.map(({ id, category, query, mustHit, mayHit }) => ({ id, category, query, mustHit, mayHit }));
    const pairInputSha256 = sha256(stableJson({
      datasetSha256,
      queryScope,
      corpusMemoryCount: goldenSet.memories.length,
      projectPath,
      topK: TOP_K,
      runtime,
      pinnedEnv: { ...env, SQUISH_GRAPH_EXPANSION: '<graph-toggle>' },
      effective: {
        ...effective,
        precision: { ...effective.precision, graphExpansion: '<graph-toggle>' },
        retrievalProfile: {
          ...effective.retrievalProfile,
          features: {
            ...effective.retrievalProfile.features,
            graphExpansion: { ...effective.retrievalProfile.features.graphExpansion, value: '<graph-toggle>' },
          },
        },
      },
    }));
    const traces: SyntheticGraphQueryTrace[] = [];

    for (const query of queries) {
      const startedAt = performance.now();
      const results = await client.search(query.query, { limit: TOP_K, retrievalMode: 'hybrid', project: projectPath });
      const retrievalLatencyMs = Number((performance.now() - startedAt).toFixed(3));
      const retrieved = results.flatMap(result => {
        const goldenId = uuidToGolden.get(result.memory.id);
        if (!goldenId) return [];
        const content = result.memory.content;
        const tokenCount = estimateTokens(content);
        return [{
          goldenId,
          contentSha256: sha256(content),
          score: typeof result.score === 'number' && Number.isFinite(result.score) ? Number(result.score.toFixed(6)) : null,
          estimatedTokens: tokenCount,
        }];
      });
      const scored = scoreRanking(retrieved.map(item => item.goldenId), query.mustHit, 5);
      traces.push({
        id: query.id,
        category: query.category,
        query: query.query,
        mustHit: query.mustHit,
        mayHit: query.mayHit,
        topK: TOP_K,
        retrieved,
        recallAt5: scored.recallAtK,
        reciprocalRank: scored.rr,
        hitAt1: scored.hitAt1,
        retrievalLatencyMs,
        estimatedReturnedContentTokens: retrieved.reduce((total, item) => total + item.estimatedTokens, 0),
      });
    }

    const sourceSnapshotSha256AtEnd = sourceSnapshotSha256(ROOT);
    assertSourceSnapshotUnchanged(sourceSnapshotSha256AtStart, sourceSnapshotSha256AtEnd);
    if (sha256(readFileSync(datasetPath)) !== datasetSha256) throw new Error('Synthetic graph dataset changed during evaluation');
    const latency = traces.map(trace => trace.retrievalLatencyMs);
    const tokenTotal = traces.reduce((total, trace) => total + trace.estimatedReturnedContentTokens, 0);
    const report: SyntheticGraphRunReport = {
      protocol: 'squish-synthetic-multihop-graph-ablation-v1',
      generatedAt: new Date().toISOString(),
      graphExpansion,
      corpusMemoryCount: goldenSet.memories.length,
      datasetSha256,
      pairInputSha256,
      sourceSnapshotSha256AtStart,
      sourceSnapshotSha256AtEnd,
      runtime,
      config: {
        pinnedEnv: env,
        effective,
        topK: TOP_K,
        retrievalMode: 'hybrid',
        concurrency: 1,
      },
      queries: traces,
      metrics: {
        questionCount: traces.length,
        macroRecallAt5: traces.reduce((total, trace) => total + trace.recallAt5, 0) / traces.length,
        macroReciprocalRank: traces.reduce((total, trace) => total + trace.reciprocalRank, 0) / traces.length,
        hitRateAt1: traces.filter(trace => trace.hitAt1).length / traces.length,
        retrievalLatencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), total: latency.reduce((a, b) => a + b, 0) },
        estimatedReturnedContentTokens: { total: tokenTotal, meanPerQuestion: tokenTotal / traces.length },
        modelTokens: 0,
        networkEgressBytes: 0,
      },
    };
    validateRunReport(report, graphExpansion ? 'graph-on' : 'graph-off', graphExpansion);
    return report;
  });
}

export async function runSyntheticGraphAblation(): Promise<SyntheticGraphPairReport> {
  assertMinimumFreeMemory(freemem());
  const initialEnv = graphAblationEnvironment(false);
  const previous = new Map<string, string | undefined>([...Object.keys(initialEnv), 'SQUISH_DATA_DIR']
    .map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, initialEnv);
    assertOfflineEnvironment(process.env as Record<string, string>);
    const graphOff = await runOneCondition(false);
    const graphOn = await runOneCondition(true);
    return compareSyntheticGraphReports(graphOff, graphOn);
  } finally {
    restoreEnvironment(previous);
  }
}

function parseOutputPath(): string {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bun benchmark/runners/synthetic-graph-ablation.ts [--out benchmark/reports/<name>.json]');
    process.exit(0);
  }
  const outIndex = args.indexOf('--out');
  if (outIndex >= 0 && (!args[outIndex + 1] || args[outIndex + 1]!.startsWith('--'))) {
    throw new Error('--out requires a report path');
  }
  if (args.some(arg => arg !== '--out' && (outIndex < 0 || args.indexOf(arg) !== outIndex + 1))) {
    throw new Error('Only --out <path> is supported');
  }
  const requested = outIndex >= 0 ? args[outIndex + 1]! : `benchmark/reports/synthetic-graph-ablation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const output = resolve(ROOT, requested);
  const relativeOutput = relative(REPORTS_DIR, output);
  if (relativeOutput === '' || relativeOutput.startsWith(`..${sep}`) || relativeOutput === '..' || isAbsolute(relativeOutput)) {
    throw new Error('Synthetic graph report path must be inside the ignored benchmark/reports directory');
  }
  if (!output.toLowerCase().endsWith('.json')) throw new Error('Synthetic graph report path must end in .json');
  return output;
}

if (import.meta.main) {
  try {
    const output = parseOutputPath();
    const report = await runSyntheticGraphAblation();
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ output, protocol: report.protocol, deltasGraphOnMinusOff: report.deltasGraphOnMinusOff }, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
