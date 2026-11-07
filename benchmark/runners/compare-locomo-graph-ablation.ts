/** Paired descriptive graph-off/graph-on comparison for complete hybrid retrieval-v4 reports. */
import { readFileSync } from 'node:fs';
import { parseReport, type Report, type Trace } from './compare-locomo-retrieval.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface GraphAblationComparison {
  protocol: 'squish-locomo-graph-ablation-descriptive-v1';
  interpretation: string;
  graphOff: { metrics: JsonValue; latency: JsonValue };
  graphOn: { metrics: JsonValue; latency: JsonValue };
  deltasGraphOnMinusOff: { macroSessionRecallAtK: number | null; microSessionRecallAtK: number | null; sessionHitRateAtK: number | null };
  evidence: { overlap: number; graphOffCount: number; graphOnCount: number; graphOnAdded: number; graphOnRemoved: number; jaccard: number | null };
  pairedQuestions: Array<{
    sampleId: string;
    questionIndex: number;
    scored: boolean;
    sessionRecallGraphOff: number | null;
    sessionRecallGraphOn: number | null;
    sessionRecallDeltaGraphOnMinusOff: number | null;
    hitGraphOff: boolean;
    hitGraphOn: boolean;
    hitDeltaGraphOnMinusOff: number;
    evidenceOverlap: number;
    evidenceGraphOffCount: number;
    evidenceGraphOnCount: number;
    evidenceGraphOnAdded: string[];
    evidenceGraphOnRemoved: string[];
    latencyMsGraphOff: number | null;
    latencyMsGraphOn: number | null;
    latencyDeltaMsGraphOnMinusOff: number | null;
  }>;
  questionLatency: { graphOnFaster: number; graphOffFaster: number; tied: number; pairedCount: number };
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

function graphEnabled(report: Report, label: string): boolean {
  const config = report.config;
  if (!isRecord(config) || typeof config.graphExpansion !== 'boolean') throw new Error(`${label}: config.graphExpansion must be boolean`);
  if (config.retrievalMode !== 'hybrid') throw new Error(`${label}: graph ablation requires retrievalMode=hybrid`);
  if (config.limit !== null) throw new Error(`${label}: graph ablation requires a full-corpus report (limit=null)`);
  if (!isRecord(config.pinnedEnv) || config.pinnedEnv.SQUISH_GRAPH_EXPANSION !== String(config.graphExpansion)) {
    throw new Error(`${label}: pinned graph expansion setting does not match config.graphExpansion`);
  }
  const effective = config.effective;
  if (!isRecord(effective) || !isRecord(effective.retrievalProfile)
    || !isRecord(effective.retrievalProfile.features) || !isRecord(effective.retrievalProfile.features.graphExpansion)
    || effective.retrievalProfile.features.graphExpansion.value !== config.graphExpansion
    || !isRecord(effective.precision) || effective.precision.graphExpansion !== config.graphExpansion) {
    throw new Error(`${label}: effective graph expansion settings do not match config.graphExpansion`);
  }
  return config.graphExpansion;
}

function normalizedConfig(report: Report): string {
  const clonedValue: unknown = JSON.parse(JSON.stringify(report.config));
  if (!isRecord(clonedValue) || !isRecord(clonedValue.pinnedEnv) || !isRecord(clonedValue.effective)
    || !isRecord(clonedValue.effective.retrievalProfile) || !isRecord(clonedValue.effective.retrievalProfile.features)
    || !isRecord(clonedValue.effective.retrievalProfile.features.graphExpansion)
    || !isRecord(clonedValue.effective.precision)) {
    throw new Error('Graph ablation reports require complete effective graph settings');
  }
  const cloned = clonedValue;
  cloned.graphExpansion = '<graph-expansion>';
  cloned.pinnedEnv.SQUISH_GRAPH_EXPANSION = '<graph-expansion>';
  cloned.effective.retrievalProfile.features.graphExpansion.value = '<graph-expansion>';
  cloned.effective.precision.graphExpansion = '<graph-expansion>';
  return stableJson(cloned);
}

function identity(trace: Trace): string {
  return JSON.stringify([trace.sampleId, trace.questionIndex]);
}

function stableEvidence(item: Trace['retrieved'][number]): string {
  return `${String(item.session)}:${String(item.contentSha256)}`;
}

function metric(report: Report, key: string): number | null {
  const value = report.metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function delta(on: number | null, off: number | null): number | null {
  return on === null || off === null ? null : on - off;
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
  if (stableJson(left) !== stableJson(right)) throw new Error(`Graph ablation reports mismatch: ${label}`);
}

export function compareGraphAblationReports(firstInput: unknown, secondInput: unknown): GraphAblationComparison {
  const first = parseReport(firstInput);
  const second = parseReport(secondInput);
  const firstGraph = graphEnabled(first, 'first report');
  const secondGraph = graphEnabled(second, 'second report');
  if (firstGraph === secondGraph) throw new Error('Graph ablation requires one graph-off and one graph-on report');
  const graphOff = firstGraph ? second : first;
  const graphOn = firstGraph ? first : second;

  if (normalizedConfig(graphOff) !== normalizedConfig(graphOn)) throw new Error('Graph ablation reports mismatch: config other than graph expansion');
  if (!isRecord(graphOff.provenance) || typeof graphOff.provenance.datasetSha256 !== 'string'
    || typeof graphOff.provenance.sourceSnapshotSha256 !== 'string') {
    throw new Error('Graph ablation reports require datasetSha256 and sourceSnapshotSha256 provenance hashes');
  }
  assertSame('provenance hashes/source identity', graphOff.provenance, graphOn.provenance);
  assertSame('counts', graphOff.counts, graphOn.counts);
  assertSame('excluded question identities and reasons', graphOff.excludedQuestions, graphOn.excludedQuestions);
  assertSame('invalid evidence identities and reasons', graphOff.invalidEvidence, graphOn.invalidEvidence);

  const offById = new Map(graphOff.traces.map(trace => [identity(trace), trace]));
  const onById = new Map(graphOn.traces.map(trace => [identity(trace), trace]));
  assertSame('question IDs', [...offById.keys()].sort(), [...onById.keys()].sort());
  const pairedQuestions: GraphAblationComparison['pairedQuestions'] = [];
  let totalOverlap = 0;
  let totalOffEvidence = 0;
  let totalOnEvidence = 0;
  let graphOnFaster = 0;
  let graphOffFaster = 0;
  let tied = 0;

  for (const [key, off] of offById) {
    const on = onById.get(key)!;
    for (const field of ['question', 'category', 'expectedEvidence', 'expectedSessions', 'evidenceComplete', 'scored'] as const) {
      assertSame(`question ${key} ${field}`, off[field], on[field]);
    }
    const offEvidence = off.retrieved.map(stableEvidence);
    const onEvidence = on.retrieved.map(stableEvidence);
    const offSet = new Set(offEvidence);
    const onSet = new Set(onEvidence);
    const overlapItems = [...offSet].filter(item => onSet.has(item));
    const added = [...onSet].filter(item => !offSet.has(item)).sort();
    const removed = [...offSet].filter(item => !onSet.has(item)).sort();
    totalOverlap += overlapItems.length;
    totalOffEvidence += offSet.size;
    totalOnEvidence += onSet.size;
    const offLatency = off.retrievalMs ?? null;
    const onLatency = on.retrievalMs ?? null;
    if (offLatency !== null && onLatency !== null) {
      if (onLatency < offLatency) graphOnFaster++;
      else if (offLatency < onLatency) graphOffFaster++;
      else tied++;
    }
    const offRecall = typeof off.sessionRecall === 'number' ? off.sessionRecall : null;
    const onRecall = typeof on.sessionRecall === 'number' ? on.sessionRecall : null;
    pairedQuestions.push({
      sampleId: String(off.sampleId),
      questionIndex: Number(off.questionIndex),
      scored: off.scored === true,
      sessionRecallGraphOff: offRecall,
      sessionRecallGraphOn: onRecall,
      sessionRecallDeltaGraphOnMinusOff: delta(onRecall, offRecall),
      hitGraphOff: off.hit === true,
      hitGraphOn: on.hit === true,
      hitDeltaGraphOnMinusOff: Number(on.hit === true) - Number(off.hit === true),
      evidenceOverlap: overlapItems.length,
      evidenceGraphOffCount: offEvidence.length,
      evidenceGraphOnCount: onEvidence.length,
      evidenceGraphOnAdded: added,
      evidenceGraphOnRemoved: removed,
      latencyMsGraphOff: offLatency,
      latencyMsGraphOn: onLatency,
      latencyDeltaMsGraphOnMinusOff: delta(onLatency, offLatency),
    });
  }

  const union = totalOffEvidence + totalOnEvidence - totalOverlap;
  const offMacro = metric(graphOff, 'macroSessionRecallAtK');
  const onMacro = metric(graphOn, 'macroSessionRecallAtK');
  const offMicro = metric(graphOff, 'microSessionRecallAtK');
  const onMicro = metric(graphOn, 'microSessionRecallAtK');
  const offHit = metric(graphOff, 'sessionHitRateAtK');
  const onHit = metric(graphOn, 'sessionHitRateAtK');
  return {
    protocol: 'squish-locomo-graph-ablation-descriptive-v1',
    interpretation: 'Paired descriptive comparison of one full hybrid graph-off report and one full hybrid graph-on report. Deltas are graph-on minus graph-off. Evidence identity uses session number plus content hash, not run-local memory IDs. Latency is reported separately. No confidence intervals, hypothesis tests, or statistical significance are estimated.',
    graphOff: { metrics: qualityMetrics(graphOff), latency: latency(graphOff) },
    graphOn: { metrics: qualityMetrics(graphOn), latency: latency(graphOn) },
    deltasGraphOnMinusOff: {
      macroSessionRecallAtK: delta(onMacro, offMacro),
      microSessionRecallAtK: delta(onMicro, offMicro),
      sessionHitRateAtK: delta(onHit, offHit),
    },
    evidence: {
      overlap: totalOverlap,
      graphOffCount: totalOffEvidence,
      graphOnCount: totalOnEvidence,
      graphOnAdded: totalOnEvidence - totalOverlap,
      graphOnRemoved: totalOffEvidence - totalOverlap,
      jaccard: union === 0 ? null : totalOverlap / union,
    },
    pairedQuestions,
    questionLatency: { graphOnFaster, graphOffFaster, tied, pairedCount: graphOnFaster + graphOffFaster + tied },
  };
}

function readReport(path: string): Report {
  return parseReport(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || paths.includes('--help') || paths.includes('-h')) {
    console.error('Usage: bun benchmark/runners/compare-locomo-graph-ablation.ts <graph-off-report.json> <graph-on-report.json>');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(compareGraphAblationReports(readReport(paths[0]!), readReport(paths[1]!)), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
