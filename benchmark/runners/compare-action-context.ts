import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stableActionJson, verifyActionArtifactIntegrity } from './action-context-manifest.js';

type JsonRecord = Record<string, unknown>;

interface ActionReport {
  meta: JsonRecord;
  metrics: JsonRecord;
  tasks: JsonRecord[];
}

export interface ActionRepeatabilityResult {
  equal: boolean;
  taskCount: number;
  differences: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const stableJson = stableActionJson;

function validateTraceHashes(metrics: JsonRecord, tasks: JsonRecord[]): void {
  const actionTrace: JsonRecord[] = [];
  const retrievalTrace: JsonRecord[] = [];
  for (const [index, task] of tasks.entries()) {
    const contextOn = task.contextOn;
    if (!isRecord(contextOn) || !('finalState' in contextOn)
      || !Array.isArray(task.retrievedEvidence)
      || !task.retrievedEvidence.every(item => isRecord(item) && typeof item.content === 'string')) {
      throw new Error(`Action report tasks[${index}] cannot reproduce its trace hashes`);
    }
    const retrievedContent = task.retrievedEvidence.map(item => (item as JsonRecord).content);
    const action = {
      id: task.id,
      chosenAction: task.chosenAction,
      abstained: task.abstained,
      finalState: contextOn.finalState,
      correct: contextOn.correct,
      evidenceSupported: task.evidenceSupported,
    };
    actionTrace.push(action);
    retrievalTrace.push({
      id: task.id,
      retrievedContent,
      chosenAction: task.chosenAction,
      chosenEvidenceRank: task.chosenEvidenceRank,
      abstained: task.abstained,
      finalState: contextOn.finalState,
      correct: contextOn.correct,
      evidenceSupported: task.evidenceSupported,
    });
  }
  const actionHash = createHash('sha256').update(JSON.stringify(actionTrace)).digest('hex');
  const retrievalHash = createHash('sha256').update(JSON.stringify(retrievalTrace)).digest('hex');
  if (metrics.actionOutcomeSha256 !== actionHash) {
    throw new Error('Action report metrics.actionOutcomeSha256 does not match task outcome rows');
  }
  if (metrics.retrievalTraceSha256 !== retrievalHash) {
    throw new Error('Action report metrics.retrievalTraceSha256 does not match task evidence rows');
  }
}

function parseReport(value: unknown): ActionReport {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.metrics) || !Array.isArray(value.tasks)) {
    throw new Error('Action report must contain meta, metrics, and tasks');
  }
  const metaFields = [
    'gitSha', 'gitDirty', 'trackedDiffSha256', 'datasetSha256', 'taskCount',
    'sourceAtStart', 'sourceAtEnd', 'sourceStable', 'deterministic', 'profile',
    'embeddingsProvider', 'modelDownloadsAllowed', 'protocol',
  ];
  for (const field of metaFields) {
    if (!(field in value.meta)) throw new Error(`Action report meta is missing ${field}`);
  }
  if (typeof value.meta.gitDirty !== 'boolean') {
    throw new Error('Action report meta.gitDirty must be a boolean');
  }
  const start = value.meta.sourceAtStart;
  const end = value.meta.sourceAtEnd;
  if (!isRecord(start) || !isRecord(end)) {
    throw new Error('Action report must include sourceAtStart and sourceAtEnd snapshots');
  }
  for (const [label, snapshot] of [['sourceAtStart', start], ['sourceAtEnd', end]] as const) {
    if (typeof snapshot.gitSha !== 'string' || !snapshot.gitSha
      || typeof snapshot.gitDirty !== 'boolean'
      || typeof snapshot.trackedDiffSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(snapshot.trackedDiffSha256)
      || typeof snapshot.sourceSnapshotSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(snapshot.sourceSnapshotSha256)) {
      throw new Error(`Action report meta.${label} is incomplete`);
    }
  }
  if (value.meta.sourceStable !== true) {
    throw new Error('Action report sourceStable must be true to compare reports');
  }
  if (stableJson(start) !== stableJson(end)) {
    throw new Error('Action report sourceStable is inconsistent with its source snapshots');
  }
  if (stableJson(start) !== stableJson({
    gitSha: value.meta.gitSha,
    gitDirty: value.meta.gitDirty,
    trackedDiffSha256: value.meta.trackedDiffSha256,
    sourceSnapshotSha256: value.meta.sourceSnapshotSha256,
  })) {
    throw new Error('Action report sourceAtStart does not match top-level provenance');
  }
  const metricFields = [
    'contextOnAccuracy', 'contextOffAccuracy', 'pairedAccuracyDelta',
    'contextOnCorrect', 'contextOffCorrect', 'total', 'evidenceSupportedActions',
    'expectedActionCount', 'evidenceSupportedActionRate', 'abstentionAccuracy',
    'negativeTransferRate', 'actionOutcomeSha256', 'retrievalTraceSha256',
    'returnedTokens', 'ingestedTokens', 'modelTokens', 'estimatedQueryCostUsd',
    'estimatedIngestionCostUsd', 'networkEgressBytes',
  ];
  for (const field of metricFields) {
    if (!(field in value.metrics)) throw new Error(`Action report metrics are missing ${field}`);
  }
  const tasks: JsonRecord[] = value.tasks.map((task, index) => {
    if (!isRecord(task) || typeof task.id !== 'string' || !task.id) {
      throw new Error(`Action report tasks[${index}] must have an id`);
    }
    return task;
  });
  const ids = tasks.map(task => task.id as string);
  if (new Set(ids).size !== ids.length) throw new Error('Action report contains duplicate task IDs');
  if (value.meta.taskCount !== tasks.length || value.metrics.total !== tasks.length) {
    throw new Error('Action report task counts do not match the task rows');
  }
  const outcomes = tasks.map((task, index) => {
    const contextOn = task.contextOn;
    const contextOff = task.contextOff;
    if (!isRecord(contextOn) || typeof contextOn.correct !== 'boolean'
      || !isRecord(contextOff) || typeof contextOff.correct !== 'boolean'
      || typeof task.evidenceSupported !== 'boolean' || typeof task.abstained !== 'boolean'
      || !('expectedAction' in task) || task.expectedAction !== null && !isRecord(task.expectedAction)) {
      throw new Error(`Action report tasks[${index}] has incomplete outcome labels`);
    }
    const finalStateMatches = stableJson(contextOn.finalState) === stableJson(task.expectedState);
    if (finalStateMatches !== contextOn.correct) {
      throw new Error(`Action report tasks[${index}] contextOn.correct does not match finalState and expectedState`);
    }
    return {
      contextOnCorrect: contextOn.correct,
      contextOffCorrect: contextOff.correct,
      evidenceSupported: task.evidenceSupported,
      expectedAction: task.expectedAction,
      abstained: task.abstained,
    };
  });
  const count = (predicate: (outcome: typeof outcomes[number]) => boolean) => outcomes.filter(predicate).length;
  const expectedActionCount = count(outcome => outcome.expectedAction !== null);
  const evidenceSupportedActions = count(outcome => outcome.evidenceSupported);
  const contextOnCorrect = count(outcome => outcome.contextOnCorrect);
  const contextOffCorrect = count(outcome => outcome.contextOffCorrect);
  const expectedMetrics: Record<string, number> = {
    contextOnCorrect,
    contextOffCorrect,
    expectedActionCount,
    evidenceSupportedActions,
    contextOnAccuracy: contextOnCorrect / tasks.length,
    contextOffAccuracy: contextOffCorrect / tasks.length,
    pairedAccuracyDelta: (contextOnCorrect - contextOffCorrect) / tasks.length,
    evidenceSupportedActionRate: expectedActionCount ? evidenceSupportedActions / expectedActionCount : 1,
    abstentionAccuracy: count(outcome => outcome.abstained === (outcome.expectedAction === null)) / tasks.length,
    negativeTransferRate: count(outcome => !outcome.contextOnCorrect && outcome.contextOffCorrect) / tasks.length,
  };
  for (const [field, expected] of Object.entries(expectedMetrics)) {
    const actual = value.metrics[field];
    if (typeof actual !== 'number' || !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-12) {
      throw new Error(`Action report metrics.${field} does not match task outcome rows`);
    }
  }
  validateTraceHashes(value.metrics, tasks);
  verifyActionArtifactIntegrity(value.meta, tasks);
  return { meta: value.meta, metrics: value.metrics, tasks };
}

function taskOutcome(task: JsonRecord): JsonRecord {
  const evidence = Array.isArray(task.retrievedEvidence)
    ? task.retrievedEvidence.map(item => {
      if (!isRecord(item)) return item;
      const { id: _runSpecificId, ...stableEvidence } = item;
      if (typeof stableEvidence.score === 'number') stableEvidence.score = Number(stableEvidence.score.toFixed(6));
      return stableEvidence;
    })
    : task.retrievedEvidence;
  return {
    id: task.id,
    query: task.query,
    projectScope: task.projectScope,
    initialState: task.initialState,
    retrievedEvidence: evidence,
    returnedTokens: task.returnedTokens,
    chosenAction: task.chosenAction,
    chosenEvidenceRank: task.chosenEvidenceRank,
    abstained: task.abstained,
    expectedAction: task.expectedAction,
    evidenceSupported: task.evidenceSupported,
    contextOn: task.contextOn,
    contextOff: task.contextOff,
    expectedState: task.expectedState,
  };
}

const META_FIELDS = [
  'gitSha', 'gitDirty', 'trackedDiffSha256', 'sourceSnapshotSha256', 'datasetSha256', 'taskCount',
  'sourceAtStart', 'sourceAtEnd', 'sourceStable', 'deterministic', 'model',
  'modelTokens', 'profile', 'embeddingsProvider', 'effectiveConfig',
  'modelDownloadsAllowed', 'protocol',
];
const METRIC_FIELDS = [
  'contextOnAccuracy', 'contextOffAccuracy', 'pairedAccuracyDelta',
  'contextOnCorrect', 'contextOffCorrect', 'total', 'evidenceSupportedActions',
  'expectedActionCount', 'evidenceSupportedActionRate', 'abstentionAccuracy',
  'negativeTransferRate', 'actionOutcomeSha256', 'retrievalTraceSha256',
  'returnedTokens', 'ingestedTokens', 'modelTokens', 'estimatedQueryCostUsd',
  'estimatedIngestionCostUsd', 'networkEgressBytes',
];

export function compareActionReports(firstValue: unknown, secondValue: unknown): ActionRepeatabilityResult {
  const first = parseReport(firstValue);
  const second = parseReport(secondValue);
  const differences: string[] = [];
  const compareFields = (fields: string[], left: JsonRecord, right: JsonRecord, label: string) => {
    for (const field of fields) {
      if (stableJson(left[field]) !== stableJson(right[field])) differences.push(`${label}.${field}`);
    }
  };
  compareFields(META_FIELDS, first.meta, second.meta, 'meta');
  compareFields(METRIC_FIELDS, first.metrics, second.metrics, 'metrics');
  if (first.meta.gitDirty !== false) differences.push('first.meta.gitDirty');
  if (second.meta.gitDirty !== false) differences.push('second.meta.gitDirty');

  const firstTasks = new Map(first.tasks.map(task => [task.id as string, task]));
  const secondTasks = new Map(second.tasks.map(task => [task.id as string, task]));
  const ids = [...new Set([...firstTasks.keys(), ...secondTasks.keys()])].sort();
  for (const id of ids) {
    const left = firstTasks.get(id);
    const right = secondTasks.get(id);
    if (!left || !right || stableJson(taskOutcome(left)) !== stableJson(taskOutcome(right))) {
      differences.push(`tasks.${id}`);
    }
  }

  return { equal: differences.length === 0, taskCount: ids.length, differences };
}

function readReport(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || paths.includes('--help') || paths.includes('-h')) {
    console.error('Usage: bun benchmark/runners/compare-action-context.ts <first-report.json> <second-report.json>');
    process.exitCode = 2;
  } else {
    try {
      const result = compareActionReports(readReport(paths[0]!), readReport(paths[1]!));
      console.log(JSON.stringify(result, null, 2));
      if (!result.equal) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
