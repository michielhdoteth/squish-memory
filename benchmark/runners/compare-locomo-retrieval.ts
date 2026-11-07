/** Compare two complete, pinned LoCoMo lexical retrieval-v4 reports for exact repeatability. */
import { readFileSync } from 'node:fs';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface RetrievedEvidence {
  session: JsonValue;
  contentSha256: JsonValue;
  score: JsonValue;
  semanticScore: JsonValue;
  boostScore: JsonValue;
  finalScore: JsonValue;
  scoreBreakdown: JsonValue;
}

export interface Trace {
  sampleId: JsonValue;
  questionIndex?: JsonValue;
  question: JsonValue;
  category: JsonValue;
  expectedEvidence: JsonValue;
  expectedSessions: JsonValue;
  evidenceComplete: JsonValue;
  retrieved: RetrievedEvidence[];
  hitSessions: JsonValue;
  sessionRecall: JsonValue;
  hit: JsonValue;
  scored: JsonValue;
  retrievalMs?: number;
}

export interface Report {
  protocol: string;
  config: JsonValue;
  provenance: JsonValue;
  counts: JsonValue;
  metrics: { [key: string]: JsonValue };
  traces: Trace[];
  excludedQuestions: JsonValue;
  invalidEvidence: JsonValue;
}

export interface RepeatabilityResult {
  equal: boolean;
  traceCount: number;
  evidenceSlotsCompared: number;
  traceDifferences: number;
  scoreDifferences: number;
  differences: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/i.test(value);
}

function parseTrace(value: unknown, index: number): Trace {
  if (!isRecord(value)) throw new Error(`traces[${index}] must be an object`);
  const required = ['sampleId', 'question', 'category', 'expectedEvidence', 'expectedSessions', 'evidenceComplete', 'hitSessions', 'sessionRecall', 'hit', 'scored'];
  for (const key of required) {
    if (!(key in value) || !isJsonValue(value[key])) throw new Error(`traces[${index}].${key} is missing or invalid`);
  }
  if ('questionIndex' in value && (typeof value.questionIndex !== 'number' || !Number.isSafeInteger(value.questionIndex) || value.questionIndex < 0)) {
    throw new Error(`traces[${index}].questionIndex must be a non-negative safe integer`);
  }
  if ('retrievalMs' in value && (typeof value.retrievalMs !== 'number' || !Number.isFinite(value.retrievalMs) || value.retrievalMs < 0)) {
    throw new Error(`traces[${index}].retrievalMs must be a non-negative finite number`);
  }
  if (!Array.isArray(value.retrieved)) throw new Error(`traces[${index}].retrieved must be an array`);
  const retrieved = value.retrieved.map((item, resultIndex): RetrievedEvidence => {
    if (!isRecord(item)) throw new Error(`traces[${index}].retrieved[${resultIndex}] must be an object`);
    const fields = ['session', 'contentSha256', 'score', 'semanticScore', 'boostScore', 'finalScore', 'scoreBreakdown'];
    for (const key of fields) {
      if (!(key in item) || !isJsonValue(item[key])) throw new Error(`traces[${index}].retrieved[${resultIndex}].${key} is missing or invalid`);
    }
    return {
      session: item.session as JsonValue,
      contentSha256: item.contentSha256 as JsonValue,
      score: item.score as JsonValue,
      semanticScore: item.semanticScore as JsonValue,
      boostScore: item.boostScore as JsonValue,
      finalScore: item.finalScore as JsonValue,
      scoreBreakdown: item.scoreBreakdown as JsonValue,
    };
  });
  return {
    sampleId: value.sampleId as JsonValue,
    ...(value.questionIndex === undefined ? {} : { questionIndex: value.questionIndex as JsonValue }),
    question: value.question as JsonValue,
    category: value.category as JsonValue,
    expectedEvidence: value.expectedEvidence as JsonValue,
    expectedSessions: value.expectedSessions as JsonValue,
    evidenceComplete: value.evidenceComplete as JsonValue,
    retrieved,
    hitSessions: value.hitSessions as JsonValue,
    sessionRecall: value.sessionRecall as JsonValue,
    hit: value.hit as JsonValue,
    scored: value.scored as JsonValue,
    ...(typeof value.retrievalMs === 'number' && Number.isFinite(value.retrievalMs)
      ? { retrievalMs: value.retrievalMs }
      : {}),
  };
}

export function parseReport(value: unknown): Report {
  if (!isRecord(value)) throw new Error('Report must be a JSON object');
  if (value.protocol !== 'squish-locomo-session-evidence-retrieval-v5') {
    throw new Error('Expected protocol squish-locomo-session-evidence-retrieval-v5');
  }
  for (const key of ['config', 'provenance', 'counts', 'invalidEvidence']) {
    if (!(key in value) || !isJsonValue(value[key])) throw new Error(`Report field ${key} is missing or invalid`);
  }
  if (!isRecord(value.provenance)
    || value.provenance.dataset !== 'LoCoMo-10'
    || value.provenance.sourceFingerprint !== 'filesystem-snapshot-v1'
    || !isSha256(value.provenance.datasetSha256)
    || !isSha256(value.provenance.sourceSnapshotSha256)
    || !isSha256(value.provenance.sourceSnapshotSha256AtStart)
    || !isSha256(value.provenance.sourceSnapshotSha256AtEnd)
    || value.provenance.sourceSnapshotSha256 !== value.provenance.sourceSnapshotSha256AtStart
    || value.provenance.sourceSnapshotSha256AtStart !== value.provenance.sourceSnapshotSha256AtEnd) {
    throw new Error('Report provenance must include valid LoCoMo-10 dataset and matching source snapshot SHA-256 hashes');
  }
  if (!isRecord(value.config)) throw new Error('Report config must be an object');
  const executionEnvironment = value.config.executionEnvironment;
  if (!isRecord(executionEnvironment)
    || typeof executionEnvironment.bunVersion !== 'string' || !executionEnvironment.bunVersion
    || typeof executionEnvironment.nodeCompatibilityVersion !== 'string' || !executionEnvironment.nodeCompatibilityVersion
    || typeof executionEnvironment.platform !== 'string' || !executionEnvironment.platform
    || typeof executionEnvironment.architecture !== 'string' || !executionEnvironment.architecture) {
    throw new Error('Report config.executionEnvironment must identify the Bun, Node compatibility, platform, and architecture versions');
  }
  if (typeof value.config.topK !== 'number' || !Number.isSafeInteger(value.config.topK) || value.config.topK < 1) {
    throw new Error('Report config.topK must be a positive safe integer');
  }
  if (value.config.concurrency !== 1) {
    throw new Error('Repeatability comparison requires serial protocol-v5 reports (config.concurrency must be 1)');
  }
  if (value.config.retrievalMode !== 'lexical' && value.config.retrievalMode !== 'hybrid') {
    throw new Error('Report config.retrievalMode must be lexical or hybrid');
  }
  if (typeof value.config.graphExpansion !== 'boolean') {
    throw new Error('Report config.graphExpansion must be boolean');
  }
  if (value.config.retrievalMode === 'lexical' && value.config.graphExpansion) {
    throw new Error('Lexical report config cannot enable graph expansion');
  }
  if (!isRecord(value.metrics) || !isJsonValue(value.metrics)) throw new Error('Report metrics must be a JSON object');
  if (!Array.isArray(value.traces)) throw new Error('Report traces must be an array');
  const traces = value.traces.map(parseTrace);
  const identities = new Set<string>();
  for (const [index, trace] of traces.entries()) {
    if (typeof trace.sampleId !== 'string' || !trace.sampleId
      || typeof trace.questionIndex !== 'number' || !Number.isSafeInteger(trace.questionIndex) || trace.questionIndex < 0) {
      throw new Error(`traces[${index}] must include a string sampleId and numeric questionIndex`);
    }
    const identity = JSON.stringify([trace.sampleId, trace.questionIndex]);
    if (identities.has(identity)) throw new Error(`Duplicate trace identity at traces[${index}]: ${identity}`);
    identities.add(identity);

    if (typeof trace.evidenceComplete !== 'boolean' || typeof trace.scored !== 'boolean'
      || trace.scored !== trace.evidenceComplete || typeof trace.hit !== 'boolean'
      || !Array.isArray(trace.expectedSessions) || !Array.isArray(trace.hitSessions)) {
      throw new Error(`traces[${index}] has inconsistent scoring labels`);
    }
    if (trace.retrieved.length > value.config.topK) {
      throw new Error(`traces[${index}].retrieved exceeds configured topK`);
    }
    const expectedSessions = trace.expectedSessions;
    const hitSessions = trace.hitSessions;
    if (!expectedSessions.every(session => typeof session === 'number' && Number.isSafeInteger(session) && session > 0)
      || new Set(expectedSessions).size !== expectedSessions.length
      || !hitSessions.every(session => typeof session === 'number' && Number.isSafeInteger(session) && session > 0)
      || new Set(hitSessions).size !== hitSessions.length) {
      throw new Error(`traces[${index}] has invalid or duplicate session labels`);
    }
    const retrievedSessions: number[] = [];
    for (const [resultIndex, item] of trace.retrieved.entries()) {
      if (typeof item.session !== 'number' || !Number.isSafeInteger(item.session) || item.session < 1) {
        throw new Error(`traces[${index}].retrieved[${resultIndex}].session must be a positive safe integer`);
      }
      if (!retrievedSessions.includes(item.session)) retrievedSessions.push(item.session);
    }
    if (retrievedSessions.length !== trace.retrieved.length) {
      throw new Error(`traces[${index}].retrieved contains duplicate sessions`);
    }
    const expectedSessionSet = new Set(expectedSessions as number[]);
    const derivedHits = retrievedSessions.filter(session => expectedSessionSet.has(session));
    if (stableJson(hitSessions) !== stableJson(derivedHits) || trace.hit !== (derivedHits.length > 0)) {
      throw new Error(`traces[${index}] hit labels do not match retrieved and expected sessions`);
    }
    const expectedRecall = trace.scored
      ? (expectedSessions.length ? derivedHits.length / expectedSessions.length : null)
      : null;
    if (trace.sessionRecall !== expectedRecall) {
      throw new Error(`traces[${index}].sessionRecall does not match its session labels`);
    }
  }
  if (!isRecord(value.counts)) throw new Error('Report counts must be a JSON object');
  const countFields = ['questionsProcessed', 'questionsScored', 'questionsExcludedForIncompleteEvidence', 'questionsExcludedByProtocol'];
  for (const field of countFields) {
    if (typeof value.counts[field] !== 'number' || !Number.isSafeInteger(value.counts[field]) || value.counts[field] < 0) {
      throw new Error(`Report counts.${field} must be a non-negative safe integer`);
    }
  }
  const questionsScored = traces.filter(trace => trace.scored === true).length;
  const questionsExcludedForIncompleteEvidence = traces.length - questionsScored;
  if (value.counts.questionsProcessed !== traces.length
    || value.counts.questionsScored !== questionsScored
    || value.counts.questionsExcludedForIncompleteEvidence !== questionsExcludedForIncompleteEvidence) {
    throw new Error('Report question counts do not match trace rows');
  }
  if (!Array.isArray(value.excludedQuestions)
    || value.counts.questionsExcludedByProtocol !== value.excludedQuestions.length) {
    throw new Error('Report protocol-exclusion count does not match excludedQuestions');
  }
  const scoredTraces = traces.filter(trace => trace.scored);
  const expectedSessionCount = scoredTraces.reduce((sum, trace) => sum + (trace.expectedSessions as number[]).length, 0);
  const hitSessionCount = scoredTraces.reduce((sum, trace) => sum + (trace.hitSessions as number[]).length, 0);
  const expectedMetrics: Record<string, number | null> = {
    macroSessionRecallAtK: scoredTraces.length
      ? scoredTraces.reduce((sum, trace) => sum + (trace.sessionRecall as number), 0) / scoredTraces.length
      : null,
    sessionHitRateAtK: scoredTraces.length
      ? scoredTraces.filter(trace => trace.hit).length / scoredTraces.length
      : null,
    microSessionRecallAtK: expectedSessionCount ? hitSessionCount / expectedSessionCount : null,
    topK: value.config.topK,
  };
  for (const [field, expected] of Object.entries(expectedMetrics)) {
    const actual = value.metrics[field];
    const matches = expected === null
      ? actual === null
      : typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12;
    if (!matches) {
      throw new Error(`Report metrics.${field} does not match trace rows`);
    }
  }
  return {
    protocol: value.protocol,
    config: value.config as JsonValue,
    provenance: value.provenance as JsonValue,
    counts: value.counts as JsonValue,
    metrics: value.metrics as Report['metrics'],
    traces,
    excludedQuestions: value.excludedQuestions as JsonValue,
    invalidEvidence: value.invalidEvidence as JsonValue,
  };
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function traceOutcome(trace: Trace): JsonValue {
  return {
    sampleId: trace.sampleId,
    ...(trace.questionIndex === undefined ? {} : { questionIndex: trace.questionIndex }),
    question: trace.question,
    category: trace.category,
    expectedEvidence: trace.expectedEvidence,
    expectedSessions: trace.expectedSessions,
    evidenceComplete: trace.evidenceComplete,
    retrieved: trace.retrieved,
    hitSessions: trace.hitSessions,
    sessionRecall: trace.sessionRecall,
    hit: trace.hit,
    scored: trace.scored,
  };
}

const QUALITY_METRICS = ['macroSessionRecallAtK', 'sessionHitRateAtK', 'microSessionRecallAtK', 'topK'] as const;

export function compareReports(first: Report, second: Report): RepeatabilityResult {
  first = parseReport(first);
  second = parseReport(second);
  const differences: string[] = [];
  const addDifference = (label: string) => { if (!differences.includes(label)) differences.push(label); };
  if (stableJson(first.config) !== stableJson(second.config)) addDifference('config');
  if (stableJson(first.provenance) !== stableJson(second.provenance)) addDifference('provenance');
  if (stableJson(first.counts) !== stableJson(second.counts)) addDifference('counts');
  if (stableJson(first.excludedQuestions) !== stableJson(second.excludedQuestions)) addDifference('excludedQuestions');
  if (stableJson(first.invalidEvidence) !== stableJson(second.invalidEvidence)) addDifference('invalidEvidence');
  for (const key of QUALITY_METRICS) {
    if (stableJson(first.metrics[key] ?? null) !== stableJson(second.metrics[key] ?? null)) addDifference(`metrics.${key}`);
  }
  if (first.traces.length !== second.traces.length) addDifference('traces.length');

  let traceDifferences = 0;
  let scoreDifferences = 0;
  let evidenceSlotsCompared = 0;
  const count = Math.min(first.traces.length, second.traces.length);
  for (let index = 0; index < count; index++) {
    const left = first.traces[index]!;
    const right = second.traces[index]!;
    evidenceSlotsCompared += Math.min(left.retrieved.length, right.retrieved.length);
    if (left.retrieved.length !== right.retrieved.length) addDifference(`traces[${index}].retrieved.length`);
    if (stableJson(traceOutcome(left)) !== stableJson(traceOutcome(right))) {
      traceDifferences++;
      addDifference('trace outcomes or evidence order');
    }
    const scoresMatch = left.retrieved.length === right.retrieved.length && left.retrieved.every((item, resultIndex) => {
      const candidate = right.retrieved[resultIndex];
      return candidate !== undefined && stableJson(item) === stableJson(candidate);
    });
    if (!scoresMatch) {
      scoreDifferences++;
      addDifference('retrieved score vectors');
    }
  }

  return {
    equal: differences.length === 0,
    traceCount: first.traces.length,
    evidenceSlotsCompared,
    traceDifferences,
    scoreDifferences,
    differences,
  };
}

function readReport(path: string): Report {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseReport(parsed);
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || paths.includes('--help') || paths.includes('-h')) {
    console.error('Usage: bun benchmark/runners/compare-locomo-retrieval.ts <first-report.json> <second-report.json>');
    process.exitCode = 2;
  } else {
    try {
      const result = compareReports(readReport(paths[0]!), readReport(paths[1]!));
      console.log(JSON.stringify(result, null, 2));
      if (!result.equal) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
