import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { ensureProject, getProjectByPath } from '../projects.js';
import { deserializeMetadata, serializeMetadata } from '../memory/serialization.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { writeTrustAudit } from '../acl/trust-audit.js';
import { getOrCreateUser } from '../memory/memory-crud.js';

export interface WorkingSetCommand {
  command: string;
  outcome?: string;
  at: string;
}

export interface SessionWorkingSet {
  activeFiles: string[];
  activePlaces: string[];
  graphEntities: string[];
  recentCommands: WorkingSetCommand[];
  currentHypotheses: string[];
  recentFailures: string[];
  recentAttempts: string[];
  projectPath?: string;
  sessionId: string;
  /**
   * Batch 7 review (M-2): marks synthetic sessions that are not real
   * harness conversations. 'memory-write' rows aggregate remember-write
   * activity under the `memory-write:<project>` pseudo-session key; real
   * harness-parsed sessions carry no kind and win wake-up selection.
   */
  kind?: string;
  signalStats: {
    captured: number;
    suppressed: number;
    sessionOnly: number;
    durable: number;
    durableWithRaw: number;
    tokensSaved: number;
    placeRouted: number;
    graphEnriched: number;
  };
  recentEvents: Array<{
    classification: string;
    content: string;
    target?: string;
    hash?: string;
    at: string;
  }>;
}

const EMPTY_WORKING_SET = (sessionId: string, projectPath?: string): SessionWorkingSet => ({
  activeFiles: [],
  activePlaces: [],
  graphEntities: [],
  recentCommands: [],
  currentHypotheses: [],
  recentFailures: [],
  recentAttempts: [],
  projectPath,
  sessionId,
  signalStats: {
    captured: 0,
    suppressed: 0,
    sessionOnly: 0,
    durable: 0,
    durableWithRaw: 0,
    tokensSaved: 0,
    placeRouted: 0,
    graphEnriched: 0,
  },
  recentEvents: [],
});

function dedupe(items: string[], limit: number): string[] {
  return [...new Set(items.filter(Boolean))].slice(0, limit);
}

function normalizeSessionMetadata(metadata: unknown, sessionId: string, projectPath?: string): SessionWorkingSet {
  const parsed = (metadata ?? {}) as Partial<SessionWorkingSet>;
  return {
    ...EMPTY_WORKING_SET(sessionId, projectPath),
    ...parsed,
    activeFiles: parsed.activeFiles ?? [],
    activePlaces: parsed.activePlaces ?? [],
    graphEntities: parsed.graphEntities ?? [],
    recentCommands: parsed.recentCommands ?? [],
    currentHypotheses: parsed.currentHypotheses ?? [],
    recentFailures: parsed.recentFailures ?? [],
    recentAttempts: parsed.recentAttempts ?? [],
    recentEvents: parsed.recentEvents ?? [],
    signalStats: {
      ...EMPTY_WORKING_SET(sessionId, projectPath).signalStats,
      ...(parsed.signalStats ?? {}),
    },
  };
}

async function getOrCreateContextSession(sessionId: string, projectPath: string, ownerId?: string | null) {
  const { db, schema, raw } = await getDbClient();
  const project = await ensureProject(projectPath);

  const existing = await db
    .select()
    .from(schema.contextSessions)
    .where(eq(schema.contextSessions.sessionId, sessionId))
    .limit(1);

  if (existing[0]) {
    if (ownerId && !existing[0].userId) {
      const claimed = await db.update(schema.contextSessions).set({ userId: ownerId })
        .where(eq(schema.contextSessions.sessionId, sessionId)).returning();
      if (claimed[0]) return { row: claimed[0], projectId: project?.id ?? null, db, schema };
    }
    return { row: existing[0], projectId: project?.id ?? null, db, schema };
  }

  const sqlite = (raw as any).$client;
  const id = randomUUID();
  const metadata = serializeMetadata(EMPTY_WORKING_SET(sessionId, projectPath) as unknown as Record<string, unknown>);
  sqlite.prepare(`
    INSERT INTO context_sessions (
      id, session_id, project_id, user_id, metadata, token_budget, tokens_used, core_memory_tokens, loaded_memories_tokens, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 8000, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, sessionId, project?.id ?? null, ownerId ?? null, metadata);

  const inserted = await db
    .select()
    .from(schema.contextSessions)
    .where(eq(schema.contextSessions.sessionId, sessionId))
    .limit(1);

  return { row: inserted[0], projectId: project?.id ?? null, db, schema };
}

async function requireSessionPrincipal(sessionId: string): Promise<string | null> {
  if (!isStrictTrustPolicy()) return null;
  let callerId: string | null;
  try {
    callerId = resolveTrustedCallerId();
  } catch {
    callerId = null;
  }
  if (!callerId) {
    await writeTrustAudit({
      actorId: 'unbound', resourceId: sessionId, assetType: 'session_working_set',
      decision: 'deny', reason: 'caller_unbound',
    });
    throw new TrustBoundaryError('Strict trust requires a caller-bound session working set');
  }
  return callerId;
}

export async function getSessionWorkingSet(sessionId: string, projectPath?: string): Promise<SessionWorkingSet> {
  const callerId = await requireSessionPrincipal(sessionId);
  const { db, schema } = await getDbClient();
  const project = callerId && projectPath?.trim() ? await getProjectByPath(projectPath) : null;
  if (callerId && !project) {
    await writeTrustAudit({ actorId: callerId, resourceId: sessionId, assetType: 'session_working_set', decision: 'deny', reason: 'session_scope' });
    throw new TrustBoundaryError('Strict trust requires a valid project scope for session working-set reads');
  }
  const rows = await db
    .select()
    .from(schema.contextSessions)
    .where(eq(schema.contextSessions.sessionId, sessionId))
    .limit(1);

  if (!rows[0]) return EMPTY_WORKING_SET(sessionId, projectPath);
  if (callerId) {
    const owner = await getOrCreateUser(callerId, db, schema);
    if (!owner || rows[0].userId !== owner.id || rows[0].projectId !== project?.id) {
      await writeTrustAudit({ actorId: callerId, resourceId: sessionId, assetType: 'session_working_set', decision: 'deny', reason: 'session_scope' });
      throw new TrustBoundaryError('Strict trust denied access to a session outside its persisted owner or project scope');
    }
  }
  return normalizeSessionMetadata(deserializeMetadata(rows[0].metadata ?? null), sessionId, projectPath);
}

export async function recordSessionSignal(input: {
  sessionId: string;
  projectPath: string;
  classification: 'discard' | 'session-only' | 'durable-distilled' | 'durable-raw+distilled';
  distilledContent: string;
  toolName: string;
  target?: string;
  metadata?: Record<string, unknown>;
}): Promise<SessionWorkingSet> {
  const callerId = await requireSessionPrincipal(input.sessionId);
  if (callerId && !input.projectPath) {
    throw new TrustBoundaryError('Strict trust requires project scope for session working-set writes');
  }
  const { db, schema } = await getDbClient();
  const persistedOwner = callerId ? await getOrCreateUser(callerId, db, schema) : null;
  if (callerId && !persistedOwner) throw new TrustBoundaryError('Strict trust could not resolve persisted session owner');
  const { row, db: sessionDb, schema: sessionSchema } = await getOrCreateContextSession(input.sessionId, input.projectPath, persistedOwner?.id);
  if (callerId) {
    if (row.userId && row.userId !== persistedOwner?.id) {
      await writeTrustAudit({ actorId: callerId, resourceId: input.sessionId, assetType: 'session_working_set', decision: 'deny', reason: 'session_scope' });
      throw new TrustBoundaryError('Strict trust denied writes to a session owned by another principal');
    }
  }
  const current = normalizeSessionMetadata(deserializeMetadata(row.metadata ?? null), input.sessionId, input.projectPath);
  const meta = input.metadata ?? {};
  const now = new Date().toISOString();

  const next = normalizeSessionMetadata(current, input.sessionId, input.projectPath);
  next.activeFiles = dedupe([
    ...next.activeFiles,
    ...(((meta.activeFiles as string[]) ?? [])),
  ], 8);
  next.activePlaces = dedupe([
    ...next.activePlaces,
    ...(((meta.activePlaces as string[]) ?? [])),
  ], 6);
  next.graphEntities = dedupe([
    ...next.graphEntities,
    ...(((meta.graphEntities as string[]) ?? [])),
  ], 8);

  const command = typeof meta.command === 'string' ? meta.command : undefined;
  if (command) {
    next.recentCommands = [{ command, outcome: typeof meta.outcome === 'string' ? meta.outcome : undefined, at: now }, ...next.recentCommands].slice(0, 8);
  }

  if (/hypothesis/i.test(input.distilledContent)) {
    next.currentHypotheses = dedupe([input.distilledContent, ...next.currentHypotheses], 5);
  }

  if ((typeof meta.outcome === 'string' && meta.outcome === 'failure') || /fail|error|exception/i.test(input.distilledContent)) {
    next.recentFailures = dedupe([input.target ?? input.distilledContent, ...next.recentFailures], 5);
  }

  next.recentAttempts = dedupe([input.distilledContent, ...next.recentAttempts], 8);
  if (typeof meta.kind === 'string') {
    // Batch 7 review (M-2): remember-write activity is tagged so wake-up
    // selection can prefer real harness sessions over this pseudo-session.
    next.kind = meta.kind;
  }
  next.recentEvents = [
    {
      classification: input.classification,
      content: input.distilledContent,
      target: input.target,
      hash: typeof meta.contentHash === 'string' ? meta.contentHash : undefined,
      at: now,
    },
    ...next.recentEvents,
  ].slice(0, 20);

  if (input.classification === 'discard') next.signalStats.suppressed += 1;
  else next.signalStats.captured += 1;
  if (input.classification === 'session-only') next.signalStats.sessionOnly += 1;
  if (input.classification === 'durable-distilled') next.signalStats.durable += 1;
  if (input.classification === 'durable-raw+distilled') next.signalStats.durableWithRaw += 1;
  next.signalStats.tokensSaved += Number(meta.tokensSaved ?? 0);
  next.signalStats.placeRouted += meta.placeRouted ? 1 : 0;
  next.signalStats.graphEnriched += meta.graphEnriched ? 1 : 0;

  await sessionDb
    .update(schema.contextSessions)
    .set({
      metadata: serializeMetadata(next as unknown as Record<string, unknown>),
      updatedAt: new Date(),
    })
    .where(eq(schema.contextSessions.sessionId, input.sessionId));

  return next;
}

export async function compactSessionWorkingSet(sessionId: string, projectPath?: string): Promise<{ summary: string; workingSet: SessionWorkingSet }> {
  const workingSet = await getSessionWorkingSet(sessionId, projectPath);
  const lines: string[] = [];

  if (workingSet.currentHypotheses.length > 0) {
    lines.push(`Hypotheses: ${dedupe(workingSet.currentHypotheses, 3).join(' | ')}`);
  }
  if (workingSet.recentFailures.length > 0) {
    lines.push(`Failures: ${dedupe(workingSet.recentFailures, 3).join(' | ')}`);
  }
  if (workingSet.activeFiles.length > 0) {
    lines.push(`Active files: ${dedupe(workingSet.activeFiles, 5).join(', ')}`);
  }
  if (workingSet.activePlaces.length > 0) {
    lines.push(`Active places: ${dedupe(workingSet.activePlaces, 4).join(', ')}`);
  }
  if (workingSet.graphEntities.length > 0) {
    lines.push(`Graph entities: ${dedupe(workingSet.graphEntities, 4).join(', ')}`);
  }
  if (workingSet.recentCommands.length > 0) {
    lines.push(`Recent commands: ${dedupe(workingSet.recentCommands.map((entry) => entry.command), 3).join(' | ')}`);
  }
  // Batch 7 fallback: remember-writes and session parses land here as
  // recentAttempts. Without this line the wake-up summary stays empty
  // ("No working set yet") even when real activity exists.
  if (lines.length === 0 && workingSet.recentAttempts.length > 0) {
    const attempts = dedupe(workingSet.recentAttempts, 3)
      .map((a) => a.slice(0, 120))
      .join(' | ');
    lines.push(`Recent activity: ${attempts}`);
  }

  return {
    summary: lines.join('\n'),
    workingSet,
  };
}

export async function getProjectSignalStats(projectPath: string) {
  const callerId = await requireSessionPrincipal(`project-stats:${projectPath}`);
  const { db, schema } = await getDbClient();
  const project = await getProjectByPath(projectPath);
  if (!project) {
    return EMPTY_WORKING_SET('project-stats', projectPath).signalStats;
  }

  const rows = await db
    .select()
    .from(schema.contextSessions)
    .where(eq(schema.contextSessions.projectId, project.id));

  const owner = callerId ? await getOrCreateUser(callerId, db, schema) : null;
  const scopedRows = callerId ? rows.filter((row: any) => owner && row.userId === owner.id) : rows;

  return scopedRows.reduce((acc: any, row: any) => {
    const workingSet = normalizeSessionMetadata(deserializeMetadata(row.metadata ?? null), row.sessionId, projectPath);
    acc.captured += workingSet.signalStats.captured;
    acc.suppressed += workingSet.signalStats.suppressed;
    acc.sessionOnly += workingSet.signalStats.sessionOnly;
    acc.durable += workingSet.signalStats.durable;
    acc.durableWithRaw += workingSet.signalStats.durableWithRaw;
    acc.tokensSaved += workingSet.signalStats.tokensSaved;
    return acc;
  }, { ...EMPTY_WORKING_SET('project-stats', projectPath).signalStats });
}

export async function getLatestProjectWorkingSetSummary(projectPath: string): Promise<string> {
  const callerId = await requireSessionPrincipal(`project-summary:${projectPath}`);
  const { db, schema } = await getDbClient();
  const project = await getProjectByPath(projectPath);
  if (!project) return '';

  const rows = await db
    .select()
    .from(schema.contextSessions)
    .where(eq(schema.contextSessions.projectId, project.id));

  const owner = callerId ? await getOrCreateUser(callerId, db, schema) : null;
  const scopedRows = callerId ? rows.filter((row: any) => owner && row.userId === owner.id) : rows;

  // Batch 7 review (M-2): harness-parsed sessions win wake-up. A burst of
  // remember-writes keeps bumping the `memory-write:<project>` pseudo-
  // session, which would otherwise dominate the "latest session" pick and
  // drown out what the agent actually did in its last real conversation.
  // Pseudo-sessions are only used when no real session exists.
  const isPseudo = (row: any) => {
    const sessionId: string = row.sessionId ?? '';
    if (sessionId.startsWith('memory-write:')) return true;
    const kind = normalizeSessionMetadata(deserializeMetadata(row.metadata ?? null), sessionId, projectPath).kind;
    return kind === 'memory-write';
  };

  const byRecency = (a: any, b: any) => {
    const left = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
    const right = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
    return right - left;
  };

  const realRows = scopedRows.filter((row: any) => !isPseudo(row)).sort(byRecency);
  const latest =
    realRows[0] ??
    [...scopedRows].sort(byRecency)[0];

  if (!latest) return '';
  return compactSessionWorkingSet(latest.sessionId, projectPath).then((result) => result.summary);
}

/* ------------------------------------------------------------------ */
/* Batch 7: signals from parsed harness sessions                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal chunk shape the signal extractor needs. Structurally compatible
 * with core/sessions Chunk so adapters can pass parsed chunks directly.
 */
export interface ParsedSessionChunkSignal {
  type?: string;
  content?: string;
  files?: string[];
}

/**
 * Extract path-like tokens (must contain a slash) from free text so plain
 * user/assistant message text still yields "files touched" signals.
 */
function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[A-Za-z0-9_.\-@\\/\[\](){}]+[/\\][A-Za-z0-9_.\-@\\/\[\](){}]+/g);
  if (!matches) return [];
  return matches
    .filter((p) => /\.[A-Za-z0-9]{1,8}$/.test(p) || /[\\/]/.test(p))
    .slice(0, 4);
}

export function deriveSignalsFromChunks(chunks: ParsedSessionChunkSignal[]): {
  activeFiles: string[];
  commands: string[];
  hypotheses: string[];
} {
  const activeFiles = new Set<string>();
  const commands: string[] = [];
  const hypotheses: string[] = [];

  for (const chunk of chunks.slice(0, 40)) {
    const content = typeof chunk?.content === 'string' ? chunk.content : '';
    if (!content) continue;

    for (const f of chunk.files ?? []) {
      if (f) activeFiles.add(f);
    }
    for (const f of extractFilePaths(content)) {
      activeFiles.add(f);
    }

    if (chunk.type === 'command' || /^\s*(\$|>|bun |npm |pnpm |git |cargo |python |pytest|uv )/.test(content)) {
      commands.push(content.replace(/\s+/g, ' ').trim().slice(0, 160));
    }
    if (/hypothes/i.test(content)) {
      hypotheses.push(content.replace(/\s+/g, ' ').trim().slice(0, 200));
    }
  }

  return {
    activeFiles: [...activeFiles].slice(0, 8),
    commands: commands.slice(0, 5),
    hypotheses: hypotheses.slice(0, 3),
  };
}

/**
 * Record working-set signals from a freshly parsed harness session
 * (Batch 7 ingestion path). Files touched, commands run, and hypotheses
 * mentioned become wake-up-summary activity. Best-effort: never throws.
 */
export async function recordParsedSessionSignals(input: {
  sessionId: string;
  projectPath?: string;
  chunks: ParsedSessionChunkSignal[];
}): Promise<boolean> {
  if (!input.projectPath || !input.chunks?.length) return false;
  try {
    const signals = deriveSignalsFromChunks(input.chunks);
    if (
      signals.activeFiles.length === 0 &&
      signals.commands.length === 0 &&
      signals.hypotheses.length === 0
    ) {
      return false;
    }
    await recordSessionSignal({
      sessionId: input.sessionId,
      projectPath: input.projectPath,
      classification: 'durable-distilled',
      distilledContent:
        signals.hypotheses[0] ??
        signals.commands[0] ??
        `Parsed session activity (${input.chunks.length} chunks)`,
      toolName: 'session-ingest',
      target: input.sessionId,
      metadata: {
        activeFiles: signals.activeFiles,
        command: signals.commands[0],
        outcome: undefined,
      },
    });
    // Additional command entries keep recentCommands rich without spamming events.
    for (const command of signals.commands.slice(1, 4)) {
      await recordSessionSignal({
        sessionId: input.sessionId,
        projectPath: input.projectPath,
        classification: 'session-only',
        distilledContent: command,
        toolName: 'session-ingest',
        target: undefined,
        metadata: { command },
      });
    }
    return true;
  } catch {
    return false;
  }
}
