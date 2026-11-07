/** Paired descriptive lexical-vs-hybrid comparison for complete LoCoMo retrieval-v4 reports. */
import { readFileSync } from 'node:fs';
import { parseReport, type Report, type Trace } from './compare-locomo-retrieval.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface BaselineComparison {
  protocol: 'squish-locomo-retrieval-baseline-descriptive-v1';
  interpretation: string;
  lexical: { metrics: JsonValue; latency: JsonValue };
  hybrid: { metrics: JsonValue; latency: JsonValue };
  deltasHybridMinusLexical: { macroSessionRecallAtK: number | null; microSessionRecallAtK: number | null; sessionHitRateAtK: number | null };
  evidence: { overlap: number; lexicalCount: number; hybridCount: number; hybridAdded: number; hybridRemoved: number; jaccard: number | null };
  pairedQuestions: Array<{
    sampleId: string;
    questionIndex: number;
    scored: boolean;
    sessionRecallLexical: number | null;
    sessionRecallHybrid: number | null;
    sessionRecallDeltaHybridMinusLexical: number | null;
    hitLexical: boolean;
    hitHybrid: boolean;
    hitDeltaHybridMinusLexical: number;
    evidenceOverlap: number;
    evidenceLexicalCount: number;
    evidenceHybridCount: number;
    evidenceHybridAdded: string[];
    evidenceHybridRemoved: string[];
    latencyMsLexical: number | null;
    latencyMsHybrid: number | null;
    latencyDeltaMsHybridMinusLexical: number | null;
  }>;
  questionLatency: { hybridFaster: number; lexicalFaster: number; tied: number; pairedCount: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function retrievalMode(report: Report, label: string): 'lexical' | 'hybrid' {
  const config = report.config;
  if (!isRecord(config) || (config.retrievalMode !== 'lexical' && config.retrievalMode !== 'hybrid')) {
    throw new Error(`${label}: retrievalMode must be lexical or hybrid`);
  }
  if (config.limit !== null) throw new Error(`${label}: baseline comparison requires a full-corpus report (limit=null)`);
  if (config.graphExpansion !== false || !isRecord(config.pinnedEnv)
    || config.pinnedEnv.SQUISH_GRAPH_EXPANSION !== 'false') {
    throw new Error(`${label}: baseline comparison requires graph expansion disabled`);
  }
  const effective = config.effective;
  if (!isRecord(effective) || !isRecord(effective.retrievalProfile)
    || !isRecord(effective.retrievalProfile.features) || !isRecord(effective.retrievalProfile.features.graphExpansion)
    || effective.retrievalProfile.features.graphExpansion.value !== false
    || !isRecord(effective.precision) || effective.precision.graphExpansion !== false) {
    throw new Error(`${label}: effective graph expansion must be disabled`);
  }
  return config.retrievalMode;
}

function normalizedConfig(report: Report): string {
  const clonedValue: unknown = JSON.parse(JSON.stringify(report.config));
  if (!isRecord(clonedValue)) throw new Error('Baseline reports require an object config');
  delete clonedValue.retrievalMode;
  return stableJson(clonedValue);
}

function identity(trace: Trace): string {
  return JSON.stringify([trace.sampleId, trace.questionIndex]);
}

function evidenceIdentity(item: Trace['retrieved'][number]): string {
  return `${String(item.session)}:${String(item.contentSha256)}`;
}

function metric(report: Report, key: string): number | null {
  const value = report.metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function delta(hybrid: number | null, lexical: number | null): number | null {
  return hybrid === null || lexical === null ? null : hybrid - lexical;
}

function latency(report: Report): JsonValue {
  return isRecord(report.metrics.retrievalLatencyMs) ? report.metrics.retrievalLatencyMs as JsonValue : null;
}

function qualityMetrics(report: Report): JsonValue {
  const metrics = { ...report.metrics };
  delete metrics.retrievalLatencyMs;
  return metrics;
}

function assertSame(label: string, left: unknown, right: unknown): void {
  if (stableJson(left) !== stableJson(right)) throw new Error(`Baseline reports mismatch: ${label}`);
}

export function compareBaselineReports(firstInput: unknown, secondInput: unknown): BaselineComparison {
  const first = parseReport(firstInput);
  const second = parseReport(secondInput);
  const firstMode = retrievalMode(first, 'first report');
  const secondMode = retrievalMode(second, 'second report');
  if (firstMode === secondMode) throw new Error('Baseline comparison requires one lexical and one hybrid report');
  const lexical = firstMode === 'lexical' ? first : second;
  const hybrid = firstMode === 'hybrid' ? first : second;

  if (normalizedConfig(lexical) !== normalizedConfig(hybrid)) throw new Error('Baseline reports mismatch: config other than retrievalMode');
  if (!isRecord(lexical.provenance) || typeof lexical.provenance.datasetSha256 !== 'string'
    || typeof lexical.provenance.sourceSnapshotSha256 !== 'string') {
    throw new Error('Baseline reports require datasetSha256 and sourceSnapshotSha256 provenance hashes');
  }
  assertSame('provenance hashes/source identity', lexical.provenance, hybrid.provenance);
  assertSame('counts', lexical.counts, hybrid.counts);
  assertSame('excluded question identities and reasons', lexical.excludedQuestions, hybrid.excludedQuestions);
  assertSame('invalid evidence identities and reasons', lexical.invalidEvidence, hybrid.invalidEvidence);

  const lexicalById = new Map(lexical.traces.map(trace => [identity(trace), trace]));
  const hybridById = new Map(hybrid.traces.map(trace => [identity(trace), trace]));
  assertSame('question IDs', [...lexicalById.keys()].sort(), [...hybridById.keys()].sort());
  const pairedQuestions: BaselineComparison['pairedQuestions'] = [];
  let overlapCount = 0;
  let lexicalEvidenceCount = 0;
  let hybridEvidenceCount = 0;
  let hybridFaster = 0;
  let lexicalFaster = 0;
  let tied = 0;

  for (const [key, lexicalTrace] of lexicalById) {
    const hybridTrace = hybridById.get(key)!;
    for (const field of ['question', 'category', 'expectedEvidence', 'expectedSessions', 'evidenceComplete', 'scored'] as const) {
      assertSame(`question ${key} ${field}`, lexicalTrace[field], hybridTrace[field]);
    }
    const lexicalEvidence = lexicalTrace.retrieved.map(evidenceIdentity);
    const hybridEvidence = hybridTrace.retrieved.map(evidenceIdentity);
    const lexicalSet = new Set(lexicalEvidence);
    const hybridSet = new Set(hybridEvidence);
    const overlap = [...lexicalSet].filter(item => hybridSet.has(item));
    const added = [...hybridSet].filter(item => !lexicalSet.has(item)).sort();
    const removed = [...lexicalSet].filter(item => !hybridSet.has(item)).sort();
    overlapCount += overlap.length;
    lexicalEvidenceCount += lexicalSet.size;
    hybridEvidenceCount += hybridSet.size;
    const lexicalLatency = lexicalTrace.retrievalMs ?? null;
    const hybridLatency = hybridTrace.retrievalMs ?? null;
    if (lexicalLatency !== null && hybridLatency !== null) {
      if (hybridLatency < lexicalLatency) hybridFaster++;
      else if (lexicalLatency < hybridLatency) lexicalFaster++;
      else tied++;
    }
    const lexicalRecall = typeof lexicalTrace.sessionRecall === 'number' ? lexicalTrace.sessionRecall : null;
    const hybridRecall = typeof hybridTrace.sessionRecall === 'number' ? hybridTrace.sessionRecall : null;
    pairedQuestions.push({
      sampleId: String(lexicalTrace.sampleId),
      questionIndex: Number(lexicalTrace.questionIndex),
      scored: lexicalTrace.scored === true,
      sessionRecallLexical: lexicalRecall,
      sessionRecallHybrid: hybridRecall,
      sessionRecallDeltaHybridMinusLexical: delta(hybridRecall, lexicalRecall),
      hitLexical: lexicalTrace.hit === true,
      hitHybrid: hybridTrace.hit === true,
      hitDeltaHybridMinusLexical: Number(hybridTrace.hit === true) - Number(lexicalTrace.hit === true),
      evidenceOverlap: overlap.length,
      evidenceLexicalCount: lexicalEvidence.length,
      evidenceHybridCount: hybridEvidence.length,
      evidenceHybridAdded: added,
      evidenceHybridRemoved: removed,
      latencyMsLexical: lexicalLatency,
      latencyMsHybrid: hybridLatency,
      latencyDeltaMsHybridMinusLexical: delta(hybridLatency, lexicalLatency),
    });
  }

  const unionCount = lexicalEvidenceCount + hybridEvidenceCount - overlapCount;
  const lexicalMacro = metric(lexical, 'macroSessionRecallAtK');
  const hybridMacro = metric(hybrid, 'macroSessionRecallAtK');
  const lexicalMicro = metric(lexical, 'microSessionRecallAtK');
  const hybridMicro = metric(hybrid, 'microSessionRecallAtK');
  const lexicalHit = metric(lexical, 'sessionHitRateAtK');
  const hybridHit = metric(hybrid, 'sessionHitRateAtK');
  return {
    protocol: 'squish-locomo-retrieval-baseline-descriptive-v1',
    interpretation: 'Paired descriptive comparison of full lexical and hybrid retrieval-v4 reports with graph expansion disabled in both. Deltas are hybrid minus lexical. Evidence identity uses session number plus content hash, not run-local memory IDs. Latency is reported separately. No confidence intervals, hypothesis tests, or statistical significance are estimated.',
    lexical: { metrics: qualityMetrics(lexical), latency: latency(lexical) },
    hybrid: { metrics: qualityMetrics(hybrid), latency: latency(hybrid) },
    deltasHybridMinusLexical: {
      macroSessionRecallAtK: delta(hybridMacro, lexicalMacro),
      microSessionRecallAtK: delta(hybridMicro, lexicalMicro),
      sessionHitRateAtK: delta(hybridHit, lexicalHit),
    },
    evidence: {
      overlap: overlapCount,
      lexicalCount: lexicalEvidenceCount,
      hybridCount: hybridEvidenceCount,
      hybridAdded: hybridEvidenceCount - overlapCount,
      hybridRemoved: lexicalEvidenceCount - overlapCount,
      jaccard: unionCount === 0 ? null : overlapCount / unionCount,
    },
    pairedQuestions,
    questionLatency: { hybridFaster, lexicalFaster, tied, pairedCount: hybridFaster + lexicalFaster + tied },
  };
}

function readReport(path: string): Report {
  return parseReport(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || paths.includes('--help') || paths.includes('-h')) {
    console.error('Usage: bun benchmark/runners/compare-locomo-baseline.ts <lexical-report.json> <hybrid-report.json>');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(compareBaselineReports(readReport(paths[0]!), readReport(paths[1]!)), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
