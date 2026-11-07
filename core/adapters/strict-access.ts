import { createHash } from 'node:crypto';
import type { SessionContextInput, SessionContextOutput, TimelineDepth, ToolObservationInput, ToolObservationOutput } from './types.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';

export async function getStrictAdapterSessionContext(
  input: SessionContextInput,
): Promise<SessionContextOutput | null> {
  if (!isStrictTrustPolicy()) return null;
  const user = resolveTrustedCallerId(input.user);
  if (!user) throw new TrustBoundaryError('Strict adapter context requires an authenticated caller');
  const { composeStrictSessionBootstrap } = await import('../session/bootstrap.js');
  const bootstrap = await composeStrictSessionBootstrap({
    projectPath: input.project,
    sessionId: input.sessionId,
    user,
    teamIds: input.teamIds,
    memoryLimit: input.mode === 'compact' ? 3 : 10,
  });
  return {
    mode: input.mode,
    project: input.project,
    memories: bootstrap.block,
    count: bootstrap.sections.reduce((sum, section) => sum + (section.included ? section.itemCount : 0), 0),
  };
}

export async function getStrictAdapterTimeline(
  query: string,
  depth: TimelineDepth,
  limit: number,
): Promise<unknown[] | null> {
  if (!isStrictTrustPolicy()) return null;
  const user = resolveTrustedCallerId();
  if (!user) throw new TrustBoundaryError('Strict adapter timeline requires an authenticated caller');
  const { SquishRuntime } = await import('../runtime/squish-runtime.js');
  const client = new SquishRuntime();
  const results = await client.search(query, { limit, user });
  return results.map(({ memory }) => {
    if (depth === 'index') {
      return { id: memory.id, title: `${memory.type}: ${memory.content.substring(0, 60)}${memory.content.length > 60 ? '…' : ''}` };
    }
    if (depth === 'timeline') {
      return {
        id: memory.id,
        type: memory.type,
        content: memory.content.substring(0, 100),
        tags: memory.tags,
        createdAt: memory.createdAt,
      };
    }
    return {
      id: memory.id,
      type: memory.type,
      content: memory.content,
      tags: memory.tags,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    };
  });
}

export async function getStrictAdapterMemoryTimeline(
  memoryId: string,
  depth: TimelineDepth,
): Promise<unknown | null> {
  if (!isStrictTrustPolicy()) return null;
  const user = resolveTrustedCallerId();
  if (!user) throw new TrustBoundaryError('Strict adapter timeline requires an authenticated caller');
  const { SquishRuntime } = await import('../runtime/squish-runtime.js');
  const memory = await new SquishRuntime().getById(memoryId, { userId: user });
  if (!memory) return { error: 'Memory not found', id: memoryId };
  if (depth === 'index') {
    return { id: memory.id, title: `${memory.type}: ${memory.content.substring(0, 60)}${memory.content.length > 60 ? '…' : ''}` };
  }
  if (depth === 'timeline') {
    return { id: memory.id, type: memory.type, content: memory.content.substring(0, 100), tags: memory.tags, createdAt: memory.createdAt };
  }
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    tags: memory.tags,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function serializeObservationValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    throw new TrustBoundaryError('Strict adapter observation must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
    throw new TrustBoundaryError('Strict adapter observation exceeds the 1 MB evidence limit');
  }
  return serialized;
}

function summarizeToolOutcome(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const fields = ['success', 'ok', 'isError', 'exitCode', 'status', 'errorCode', 'testPassed'];
  const summary = fields.flatMap((key) => {
    const field = record[key];
    return typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean'
      ? [`${key}=${String(field).slice(0, 40)}`]
      : [];
  }).join(', ');
  return summary ? ` (outcome: ${summary})` : '';
}

export async function captureStrictAdapterObservation(
  input: ToolObservationInput,
  adapterId: string,
): Promise<ToolObservationOutput | null> {
  if (!isStrictTrustPolicy()) return null;
  const user = resolveTrustedCallerId();
  if (!user) throw new TrustBoundaryError('Strict adapter observation requires an authenticated caller');

  const toolName = input.toolName.slice(0, 128);
  const inputJson = serializeObservationValue(input.toolInput);
  const resultJson = serializeObservationValue(input.toolResult);
  const digestField = (value: string) => `${Buffer.byteLength(value, 'utf8')}:${value}`;
  const sourceDigest = createHash('sha256')
    .update([adapterId, toolName, inputJson, resultJson].map(digestField).join(''), 'utf8')
    .digest('hex');
  const resultDigest = createHash('sha256').update(resultJson, 'utf8').digest('hex');
  const sessionId = input.sessionId?.slice(0, 256);
  const sessionRef = sessionId
    ? createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 24)
    : 'none';
  const content = `[${toolName}] ${inputJson.slice(0, 200)}${summarizeToolOutcome(input.toolResult)}`;
  const { SquishRuntime } = await import('../runtime/squish-runtime.js');
  const memory = await new SquishRuntime().remember(content, {
    type: 'context',
    tags: ['agent-observation', adapterId],
    project: input.project,
    user,
    sessionId,
    metadata: {
      source: 'signed_agent_observation',
      sourceId: `sha256:${sourceDigest}`,
      observedAt: new Date().toISOString(),
      reasoning: `Authenticated ${adapterId} tool observation`,
      memoryContext: `adapter=${adapterId};tool=${toolName};result_sha256=${resultDigest};session_ref=${sessionRef}`,
    },
  });
  const { categorizeTool } = await import('./types.js');
  return {
    memoryId: memory.id,
    category: categorizeTool(input.toolName),
    content: `Recorded: ${toolName}`,
  };
}
