import { createHash } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

export interface ActionArtifactIntegrity {
  version: 1;
  sourceSha256: string;
  datasetSha256: string;
  effectiveConfigSha256: string;
  rankedEvidenceSha256: string;
  taskOutputSha256: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableActionJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableActionJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Fingerprint the frozen source/config and the exact ranked evidence/output rows. */
export function createActionArtifactIntegrity(input: {
  sourceAtStart: JsonRecord;
  datasetSha256: string;
  effectiveConfig: JsonRecord;
  tasks: JsonRecord[];
}): ActionArtifactIntegrity {
  const rankedEvidence = input.tasks.map((task, taskIndex) => {
    if (!Array.isArray(task.retrievedEvidence)) {
      throw new Error(`Action report tasks[${taskIndex}] has no ranked evidence`);
    }
    return {
      taskId: task.id,
      rankedEvidence: task.retrievedEvidence.map((item, rank) => {
        if (!isRecord(item) || typeof item.content !== 'string') {
          throw new Error(`Action report tasks[${taskIndex}] evidence[${rank}] is incomplete`);
        }
        return {
          rank: item.rank ?? rank + 1,
          contentSha256: hash(item.content),
          score: typeof item.score === 'number' ? Number(item.score.toFixed(6)) : item.score,
          source: item.source,
        };
      }),
    };
  });

  return {
    version: 1,
    sourceSha256: hash(stableActionJson(input.sourceAtStart)),
    datasetSha256: input.datasetSha256,
    effectiveConfigSha256: hash(stableActionJson(input.effectiveConfig)),
    rankedEvidenceSha256: hash(stableActionJson(rankedEvidence)),
    taskOutputSha256: hash(stableActionJson(input.tasks)),
  };
}

/** Recompute every manifest field before a report can be compared. */
export function verifyActionArtifactIntegrity(
  meta: JsonRecord,
  tasks: JsonRecord[],
): void {
  if (!isRecord(meta.sourceAtStart) || !isRecord(meta.effectiveConfig)
    || typeof meta.datasetSha256 !== 'string' || !isRecord(meta.artifactIntegrity)) {
    throw new Error('Action report is missing its artifact integrity inputs or manifest');
  }
  const expected = createActionArtifactIntegrity({
    sourceAtStart: meta.sourceAtStart,
    datasetSha256: meta.datasetSha256,
    effectiveConfig: meta.effectiveConfig,
    tasks,
  });
  if (stableActionJson(meta.artifactIntegrity) !== stableActionJson(expected)) {
    throw new Error('Action report artifact integrity manifest does not match its source, config, ranked evidence, or task outputs');
  }
}
