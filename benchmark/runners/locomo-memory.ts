import type { SquishRuntime } from '../../core/runtime/squish-runtime.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../core/lib/db-client.js';
import { runInTransaction } from '../../core/storage/database.js';

export const LOCOMO_EVALUATION_TIME = '2024-02-01T00:00:00.000Z';

export async function persistSessionCreatedAtBatch(
  dbClient: Awaited<ReturnType<typeof getDbClient>>,
  updates: Array<{ memoryId: string; createdAt: Date }>,
): Promise<void> {
  if (updates.length === 0) return;
  await runInTransaction(dbClient.db, async tx => {
    for (const update of updates) {
      await tx.update(dbClient.schema.memories)
        .set({ createdAt: update.createdAt })
        .where(eq(dbClient.schema.memories.id, update.memoryId));
    }
  });
}

export async function seedPersona(
  client: SquishRuntime,
  sessions: Array<{ session: number; date: string; text: string }>,
  sampleId: string,
  project: string,
  options: { useSessionDateAsCreatedAt?: boolean } = {},
): Promise<Map<string, number>> {
  const sessionByMemoryId = new Map<string, number>();
  const dbClient = options.useSessionDateAsCreatedAt ? await getDbClient() : null;
  const createdAtUpdates: Array<{ memoryId: string; createdAt: Date }> = [];
  for (const session of sessions) {
    const stored = await client.remember(session.text, {
      type: 'episodic',
      tags: [sampleId, `session-${session.session}`],
      metadata: { persona: sampleId, session: session.session, date: session.date },
      project,
    });
    if (dbClient) {
      const createdAt = parseLoCoMoSessionDate(session.date);
      if (!createdAt) throw new Error(`Unsupported LoCoMo session date: ${session.date}`);
      createdAtUpdates.push({ memoryId: stored.id, createdAt });
    }
    sessionByMemoryId.set(stored.id, session.session);
  }
  if (dbClient && createdAtUpdates.length > 0) {
    await persistSessionCreatedAtBatch(dbClient, createdAtUpdates);
  }
  return sessionByMemoryId;
}

/** Parse the public LoCoMo session date format without local-timezone dependence. */
export function parseLoCoMoSessionDate(value: string): Date | null {
  const match = value.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})\s*$/i);
  if (!match) return null;
  const [, rawHour, rawMinute, rawMeridiem, rawDay, rawMonth, rawYear] = match;
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const month = months[rawMonth.toLowerCase()];
  if (month === undefined) return null;
  const hour12 = Number(rawHour);
  const minute = Number(rawMinute);
  const day = Number(rawDay);
  const year = Number(rawYear);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = hour12 % 12 + (rawMeridiem.toLowerCase() === 'pm' ? 12 : 0);
  const timestamp = Date.UTC(year, month, day, hour, minute);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day) return null;
  return parsed;
}

/** Run a diagnostic retrieval at the protocol's fixed as-of time. */
export async function withLoCoMoEvaluationClock<T>(operation: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  const evaluationTime = Date.parse(LOCOMO_EVALUATION_TIME);
  Date.now = () => evaluationTime;
  try {
    return await operation();
  } finally {
    Date.now = originalNow;
  }
}

export async function retrievePersonaContext(
  client: SquishRuntime,
  question: string,
  project: string,
  topK = 10,
): Promise<string[]> {
  const results = await client.search(question, { limit: topK, project });
  return results.map(result => result.memory.content);
}

export async function retrievePersonaSessions(
  client: SquishRuntime,
  question: string,
  project: string,
  sessionByMemoryId: ReadonlyMap<string, number>,
  topK = 10,
  retrievalMode: 'hybrid' | 'lexical' = 'hybrid',
): Promise<Array<{
  session: number;
  memoryId: string;
  contentSha256: string;
  score: number;
  semanticScore: number | null;
  boostScore: number | null;
  finalScore: number | null;
  scoreBreakdown: Record<string, number>;
}>> {
  const results = await client.search(question, { limit: topK, project, retrievalMode });
  return results.flatMap(result => {
    const session = sessionByMemoryId.get(result.memory.id);
    if (session === undefined) return [];
    return [{
      session,
      memoryId: result.memory.id,
      contentSha256: createHash('sha256').update(result.memory.content, 'utf8').digest('hex'),
      score: result.score,
      semanticScore: result.semanticScore ?? null,
      boostScore: result.boostScore ?? null,
      finalScore: result.finalScore ?? null,
      scoreBreakdown: result.scoreBreakdown ?? {},
    }];
  });
}

export function parseEvidenceSessions(evidence: readonly string[]): { sessions: number[]; unmapped: string[] } {
  const sessions = new Set<number>();
  const unmapped: string[] = [];
  for (const fragment of evidence) {
    const matches = [...fragment.matchAll(/D(\d+):\d+/g)];
    if (matches.length === 0) {
      unmapped.push(fragment);
      continue;
    }
    for (const match of matches) sessions.add(Number(match[1]));
  }
  return { sessions: [...sessions].sort((a, b) => a - b), unmapped };
}

export function resolveEvidenceSessions(evidence: readonly string[], availableSessions: ReadonlySet<number>) {
  const parsed = parseEvidenceSessions(evidence);
  const missingSessions = parsed.sessions.filter(session => !availableSessions.has(session));
  const complete = parsed.unmapped.length === 0 && missingSessions.length === 0 && parsed.sessions.length > 0;
  const exclusionReason = complete ? null
    : evidence.length === 0 ? 'empty_evidence_label'
      : parsed.unmapped.length > 0 ? 'unmapped_evidence_fragment'
        : missingSessions.length > 0 ? 'referenced_session_not_seeded'
          : 'no_session_reference';
  return {
    sessions: parsed.sessions.filter(session => availableSessions.has(session)),
    unmapped: parsed.unmapped,
    missingSessions,
    complete,
    exclusionReason,
  };
}
