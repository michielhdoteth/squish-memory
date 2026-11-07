/**
 * Session chunk store (v1.5.5 - agent-stores adapter model).
 *
 * In v1.5.5 the sessions surface is exclusively for past agent
 * sessions - read via the `agent-stores` adapter layer. Long-term
 * memory (the captured-memories path) is no longer in scope of
 * `searchChunks` / `listSessions` / `getSessionChunks` /
 * `findRelatedSessions`; use `squish_recall` / `squish_remember`
 * (or the `squish` CLI's `remember` / `search` / `recall`) for
 * that.
 *
 * The capture path (`captureChunk` / `captureChunks`) remains
 * because the user can still run `squish sessions capture` to
 * persist a session summary. Those writes go to the same Squish
 * memory table that `squish_recall` searches.
 *
 * Tag scheme used by the capture path (memory-side):
 *   squish_chunk:<type>     -> marks this memory as a chunk
 *   squish_session:<id>     -> groups chunks into sessions
 *   agent:<agent>           -> agent identifier
 *   file:<path>             -> one tag per file referenced
 *
 * Type mapping (chunk -> Squish MemoryType):
 *   summary  -> note
 *   decision -> decision
 *   command  -> observation
 *   file     -> observation
 *   error    -> observation
 *   todo     -> task
 *
 * The plugin uses OpenCode's SDK for session discovery and shells
 * out to `squish remember` / `squish recall` for chunk persistence
 * and search. The CLI uses the public surface here to list, show,
 * search, capture, and find related.
 */

import { createHash } from 'node:crypto';
import {
  sqlEpochSeconds,
  sqlLifecycleBound
} from '../lib/timestamps.js';
import { estimateJsonTokens } from '../lib/tokens.js';
import {
  rememberMemory,
  search as squishSearch,
} from '../memory/memories.js';
import { rememberHostTranscriptMessage } from '../memory/memory-write.js';
import type { SearchResult } from '../memory/memory-types.js';
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';

import {
  availableAgentStores,
  getAgentStore,
  type AgentName,
} from './agent-stores/index.js';
import { createSessionSearchBudget, markSessionSearchTruncated, type SessionSearchDiagnostics } from './agent-stores/types.js';
import { scheduleSessionCachePrune } from './agent-stores/cache.js';
import {
  getOpenCodeSession,
  opencodeDbStatus,
  searchOpenCodeSessionsFts,
} from './opencode-store.js';
import { logger } from '../logger.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { createPrivateIndexContext } from '../security/encrypt.js';
import { readCodexTranscript } from './agent-stores/codex.js';
import { readClaudeTranscript } from './agent-stores/claude-code.js';
import { readOpenCodeTranscript } from './agent-stores/opencode.js';
import { readGeminiTranscript } from './agent-stores/gemini.js';
import { verifyMemoryProvenance } from '../acl/provenance.js';
import { deserializeMetadata } from '../memory/serialization.js';

function requireRawSessionHistoryAllowed(): void {
  if (!isStrictTrustPolicy()) return;
  resolveTrustedCallerId();
  throw new TrustBoundaryError('Raw external session history is disabled under strict trust until source ACL and provenance are enforced');
}

import type {
  AgentId,
  Chunk,
  ChunkResult,
  ChunkType,
  SessionGroup,
} from './types.js';
import { AGENT_IDS, CHUNK_TYPES } from './types.js';

const CHUNK_PREFIX = 'squish_chunk:';
const SESSION_PREFIX = 'squish_session:';
const AGENT_PREFIX = 'agent:';
const FILE_PREFIX = 'file:';

export type { AgentName, AgentSessionStore, SessionSource } from './agent-stores/types.js';

const CHUNK_TYPE_TO_MEMORY: Record<ChunkType, string> = {
  summary: 'note',
  decision: 'decision',
  command: 'observation',
  file: 'observation',
  error: 'observation',
  todo: 'task',
};

export interface SessionCaptureOptions {
  project?: string;
  user?: string;
}

function chunkTypeTag(t: ChunkType): string {
  return `${CHUNK_PREFIX}${t}`;
}

function sessionIdTag(id: string): string {
  return `${SESSION_PREFIX}${id}`;
}

function agentTag(a: AgentId): string {
  return `${AGENT_PREFIX}${a}`;
}

function fileTag(p: string): string {
  return `${FILE_PREFIX}${p}`;
}

function buildTags(chunk: Chunk): string[] {
  const out: string[] = [chunkTypeTag(chunk.type), sessionIdTag(chunk.session_id), agentTag(chunk.agent)];
  if (chunk.files && chunk.files.length > 0) {
    for (const f of chunk.files) {
      if (f && f.length > 0) out.push(fileTag(f));
    }
  }
  return out;
}

function buildMetadata(chunk: Chunk): Record<string, unknown> {
  return {
    session_id: chunk.session_id,
    session_title: chunk.session_title,
    chunk_type: chunk.type,
    agent: chunk.agent,
    agent_session_id: chunk.agent_session_id,
    repo_path: chunk.repo_path,
    branch: chunk.branch,
    files: chunk.files ?? [],
    timestamp: chunk.timestamp,
  };
}

function projectFor(chunk: Chunk, opts: SessionCaptureOptions): string | undefined {
  return opts.project ?? chunk.project ?? undefined;
}

function memoryIdFromRecord(rec: { id: string }): string {
  return rec.id;
}

function whyLine(query: string, chunk: Chunk): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) {
    return `matched in ${chunk.type} text`;
  }
  const lower = chunk.content.toLowerCase();
  for (const t of tokens) {
    if (lower.includes(t)) {
      return `matched '${t}' in ${chunk.type} text`;
    }
  }
  const meta = `${chunk.session_title} ${chunk.repo_path} ${chunk.branch} ${(chunk.files ?? []).join(' ')}`.toLowerCase();
  for (const t of tokens) {
    if (meta.includes(t)) {
      return `matched '${t}' in ${chunk.type} metadata`;
    }
  }
  return `matched in ${chunk.type} text`;
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

export async function captureChunk(chunk: Chunk, opts: SessionCaptureOptions = {}): Promise<string> {
  assertCaptureChunk(chunk);
  const captureKey = captureKeyForChunk(chunk);
  const rec = await rememberMemory({
    content: chunk.content,
    type: CHUNK_TYPE_TO_MEMORY[chunk.type] as any,
    tags: buildTags(chunk),
    project: projectFor(chunk, opts),
    metadata: buildMetadata(chunk),
    source: `session_chunk:${chunk.session_id}`,
    sessionId: chunk.session_id,
    captureKey,
    user: opts.user,
  });
  return memoryIdFromRecord(rec);
}

function assertCaptureChunk(chunk: Chunk): void {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
    throw new Error('Session capture requires a chunk object');
  }
  if (!CHUNK_TYPES.includes(chunk.type) || !AGENT_IDS.includes(chunk.agent)) {
    throw new Error('Session capture has an unsupported chunk type or agent');
  }
  const requiredText: Array<[string, unknown]> = [
    ['content', chunk.content],
    ['session_id', chunk.session_id],
    ['agent_session_id', chunk.agent_session_id],
    ['timestamp', chunk.timestamp],
  ];
  for (const [field, value] of requiredText) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Session capture requires a non-empty ${field}`);
    }
  }
  for (const [field, value] of Object.entries({
    session_title: chunk.session_title,
    project: chunk.project,
    repo_path: chunk.repo_path,
    branch: chunk.branch,
  })) {
    if (typeof value !== 'string') throw new Error(`Session capture ${field} must be a string`);
  }
  if (Number.isNaN(Date.parse(chunk.timestamp))) {
    throw new Error('Session capture timestamp must be a valid date');
  }
  if (chunk.files !== undefined && (!Array.isArray(chunk.files)
    || chunk.files.some((file) => typeof file !== 'string'))) {
    throw new Error('Session capture files must be an array of strings');
  }
  if (chunk.sourceEventId !== undefined
    && (typeof chunk.sourceEventId !== 'string' || !chunk.sourceEventId.trim() || chunk.sourceEventId.length > 1024)) {
    throw new Error('sourceEventId must contain 1 to 1024 non-whitespace characters');
  }
}

function captureKeyForChunk(chunk: Chunk): string {
  const eventId = chunk.sourceEventId?.trim();
  if (chunk.sourceEventId !== undefined && (!eventId || eventId.length > 1024)) {
    throw new Error('sourceEventId must contain 1 to 1024 non-whitespace characters');
  }
  const identity = eventId
    ? ['session-chunk-event-v1', chunk.agent, chunk.agent_session_id, chunk.session_id, chunk.type, eventId]
    : ['session-chunk-content-v1', chunk.agent, chunk.agent_session_id, chunk.session_id,
      chunk.type, chunk.timestamp, chunk.content, ...(chunk.files ?? [])];
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `session-chunk-v1:${digest}`;
}

export async function captureChunks(chunks: Chunk[], opts: SessionCaptureOptions = {}): Promise<string[]> {
  if (!Array.isArray(chunks)) throw new Error('Session capture batch must be an array');
  for (const chunk of chunks) assertCaptureChunk(chunk);
  const ids: string[] = [];
  const occurrences = new Map<string, number>();
  for (const c of chunks) {
    if (c.sourceEventId !== undefined) {
      ids.push(await captureChunk(c, opts));
      continue;
    }
    const batchIdentity = JSON.stringify([
      c.agent, c.agent_session_id, c.session_id, c.type, c.content, c.repo_path, c.branch, c.files ?? [],
    ]);
    const occurrence = occurrences.get(batchIdentity) ?? 0;
    occurrences.set(batchIdentity, occurrence + 1);
    const sourceEventId = `batch-v1:${createHash('sha256').update(batchIdentity).digest('hex')}:${occurrence}`;
    const id = await captureChunk({ ...c, sourceEventId }, opts);
    ids.push(id);
  }
  return ids;
}

export type HostTranscriptAgent = 'codex' | 'claude-code' | 'opencode' | 'gemini';

function readHostSession(agent: HostTranscriptAgent, sessionId: string) {
  switch (agent) {
    case 'codex': return readCodexTranscript(sessionId);
    case 'claude-code': return readClaudeTranscript(sessionId);
    case 'opencode': return readOpenCodeTranscript(sessionId);
    case 'gemini': return readGeminiTranscript(sessionId);
  }
}

/** Capture a transcript by host session ID; roles and text come from its local source. */
export async function captureHostSession(
  agent: HostTranscriptAgent,
  sessionId: string,
  options: { user?: string } = {},
): Promise<string[]> {
  if (!sessionId.trim() || sessionId.length > 256) throw new Error('sessionId must contain 1 to 256 characters');
  const strict = isStrictTrustPolicy();
  const callerId = strict ? resolveTrustedCallerId(options.user) : options.user;
  if (strict && !callerId) throw new TrustBoundaryError('Transcript capture requires an authenticated caller');
  const snapshot = readHostSession(agent, sessionId);
  if (!snapshot || snapshot.sessionId !== sessionId || !snapshot.projectPath.trim()) {
    throw new TrustBoundaryError('Transcript could not be read from its authenticated host source');
  }
  if (config.clientEncryptionEnabled) {
    throw new TrustBoundaryError('Authenticated transcript distillation is unavailable with client-side encryption');
  }

  const { raw } = await (await import('../lib/db-client.js')).getDbClient();
  const sqlite = raw.$client as { prepare?: (query: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] } } | undefined;
  if (!sqlite?.prepare) throw new TrustBoundaryError('Authenticated transcript capture requires SQLite');
  const project = sqlite.prepare('SELECT id FROM projects WHERE path=?').get(snapshot.projectPath) as { id: string } | undefined;
  if (project) {
    const ownerId = callerId
      ? await (await import('../../db/team-adapter.js')).resolvePersistedUserId(callerId, true)
      : null;
    const existing = sqlite.prepare(`SELECT id, content, project_id, user_id, type, metadata FROM memories
      WHERE source=? AND project_id=? AND user_id IS ? AND is_active=1
        AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.hostTranscript.agent')=?
      ORDER BY created_at LIMIT 201`).all(`session_chunk:${sessionId}`, project.id, ownerId, agent) as Array<{
        id: string; content: string; project_id: string; user_id: string | null; type: string; metadata: string | null;
      }>;
    if (existing.length > 200) throw new TrustBoundaryError('Existing host capture exceeds the bounded message count');
    for (const source of existing) {
      const metadata = deserializeMetadata(source.metadata);
      const marker = metadata?.hostTranscript as {
        version?: number; agent?: string; sessionId?: string; role?: string; messageIndex?: number; sourceFingerprint?: string;
      } | undefined;
      const current = typeof marker?.messageIndex === 'number'
        ? snapshot.messages.find((message) => message.messageIndex === marker.messageIndex)
        : undefined;
      const matches = marker?.version === 1 && marker.agent === agent && marker.sessionId === sessionId
        && Boolean(current && current.role === marker.role && current.content === source.content
          && current.sourceFingerprint === marker.sourceFingerprint)
        && verifyMemoryProvenance({
          content: source.content, projectId: source.project_id, type: source.type,
          ownerId: source.user_id, teamId: null, sourceMemoryId: source.id, metadata,
        });
      if (!matches) {
        throw new TrustBoundaryError('Transcript changed since its prior capture; forget the captured session before recapturing');
      }
    }
  }

  const ids: string[] = [];
  for (const message of snapshot.messages) {
    const record = await rememberHostTranscriptMessage(
      agent, sessionId, message.messageIndex, message.sourceFingerprint, callerId ?? undefined,
    );
    ids.push(record.id);
  }
  return ids;
}

export const captureCodexSession = (sessionId: string, options: { user?: string } = {}) =>
  captureHostSession('codex', sessionId, options);

export interface ForgetCapturedSessionInput {
  sessionId: string;
  project?: string;
  user?: string;
  teamIds?: string[];
  readTaggedMemories?: (ids: string[]) => Promise<Array<{ id: string }>>;
}

/** Permanently forget caller-authorized episodic chunks captured for one session. */
export async function forgetCapturedSession(input: ForgetCapturedSessionInput): Promise<{ deleted: number }> {
  const sessionId = input.sessionId.trim();
  if (!sessionId || sessionId.length > 256) throw new Error('sessionId must contain 1 to 256 characters');

  const strict = isStrictTrustPolicy();
  const callerId = strict ? resolveTrustedCallerId(input.user) : input.user;
  if (strict && !callerId) throw new TrustBoundaryError('Forgetting captured session memories requires an authenticated caller');

  let requestedProjectId: string | undefined;
  if (input.project) {
    const { requireProject } = await import('../projects.js');
    requestedProjectId = (await requireProject(input.project)).id;
  }

  let authorized: Array<{ id: string }>;
  if (config.clientEncryptionEnabled) {
    if (!input.readTaggedMemories) {
      throw new TrustBoundaryError('Encrypted session forgetting requires caller-gated source reads');
    }
    const ids: string[] = [];
    const pageSize = 10_000;
    let cursor: { createdAt: number; memoryId: string } | undefined;
    while (true) {
      const page = await readPrivateSessionMemoryIds({
        sessionId, project: input.project, user: callerId ?? undefined, teamIds: input.teamIds,
        limit: pageSize, ...(cursor ? { cursor } : {}), includeInactive: true,
      });
      ids.push(...page.memoryIds);
      if (page.scannedCount < pageSize || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    authorized = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const requestedIds = ids.slice(offset, offset + 100);
      const requestedIdSet = new Set(requestedIds);
      const memories = await input.readTaggedMemories(requestedIds);
      // The callback is caller-gated, but it must not expand the private index
      // selection into unrelated memory IDs that would be permanently deleted.
      authorized.push(...memories.filter((memory) => requestedIdSet.has(memory.id)));
    }
  } else {
    const { db, schema } = await (await import('../lib/db-client.js')).getDbClient();
    const conditions = [
      eq(schema.memories.source, `session_chunk:${sessionId}`),
      (db as { $clientType?: string }).$clientType === 'postgres'
        ? sql`${schema.memories.metadata}->>'session_id' = ${sessionId}`
        : sql`json_extract(CASE WHEN json_valid(${schema.memories.metadata}) THEN ${schema.memories.metadata} ELSE '{}' END, '$.session_id') = ${sessionId}`,
    ];
    if (requestedProjectId !== undefined) conditions.push(eq(schema.memories.projectId, requestedProjectId));
    const candidates = await db.select().from(schema.memories).where(and(...conditions));
    authorized = candidates;
    if (strict) {
      const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
      const { normalizeMemoryRecord } = await import('../memory/memories.js');
      const acl = await buildAutoAclContext(callerId, input.teamIds);
      authorized = await applyAclReadGate(candidates.map(normalizeMemoryRecord), acl);
    }
  }

  const { deleteMemoriesPermanently } = await import('../memory/stale-cleaner.js');
  const deleted = await deleteMemoriesPermanently(
    authorized.map((memory: { id: string }) => memory.id),
    {
      userId: callerId ?? undefined,
      teamIds: input.teamIds,
      ...(config.clientEncryptionEnabled && requestedProjectId !== undefined
        ? { expectedProjectId: requestedProjectId }
        : {}),
    },
  );
  return { deleted };
}

export interface CapturedSessionRecovery {
  sessionId: string;
  query: string;
  budgetTokens: number;
  tokenEstimate: number;
  omittedCount: number;
  evidence: Array<{ id: string; type: string; content: string; createdAt: string | null }>;
  projectContext?: Array<{ id: string; type: string; content: string; createdAt: string | null; contentTruncated?: boolean }>;
  tree?: import('./progressive-tree.js').ProgressiveTreeView;
}

const MIN_PROGRESSIVE_RECOVERY_BUDGET = 256;

interface PrivateSessionIndexRow {
  memory_id: string;
  project_id: string | null;
  user_id: string | null;
  team_id: string | null;
  record_mac: string;
  created_at: number;
}

async function readPrivateSessionMemoryIds(input: {
  sessionId: string;
  project?: string;
  user?: string;
  teamId?: string;
  teamIds?: string[];
  limit: number;
  cursor?: { createdAt: number; memoryId: string };
  /** Forget must still find expired rows; recovery must return only live sources. */
  includeInactive?: boolean;
}): Promise<{
  memoryIds: string[];
  scannedCount: number;
  nextCursor?: { createdAt: number; memoryId: string };
}> {
  const strict = isStrictTrustPolicy();
  const callerId = strict ? resolveTrustedCallerId(input.user) : input.user;
  if (strict && !callerId) throw new TrustBoundaryError('Encrypted session recovery requires an authenticated caller');
  const { db, schema } = await (await import('../lib/db-client.js')).getDbClient();
  const raw = (db as { $client?: { prepare?: (query: string) => { all: (...params: unknown[]) => PrivateSessionIndexRow[] } } }).$client;
  if (!raw?.prepare) throw new TrustBoundaryError('Encrypted session recovery requires the SQLite private index');

  const acl = strict
    ? await (await import('../acl/read-gate.js')).buildAutoAclContext(callerId)
    : null;
  const ownerId = acl?.canonicalUserId ?? null;
  let projectId: string | null | undefined;
  if (input.project) {
    const { requireProject } = await import('../projects.js');
    projectId = (await requireProject(input.project)).id;
  }

  const index = createPrivateIndexContext();
  try {
    const sessionToken = index.token('session-id', input.sessionId);
    const scopes = [`(i.user_id IS ? AND NOT EXISTS (
      SELECT 1 FROM visibility_rules vr_owner WHERE vr_owner.asset_type = 'memory' AND vr_owner.asset_id = i.memory_id
    ))`];
    const params: unknown[] = [sessionToken, ownerId];
    const teamIds = (acl?.memberTeamIds ?? []).filter((teamId) =>
      (input.teamId === undefined || teamId === input.teamId)
      && (input.teamIds === undefined || input.teamIds.includes(teamId)));
    if (strict && teamIds.length > 0) {
      const placeholders = teamIds.map(() => '?').join(', ');
      scopes.push(`i.team_id IN (${placeholders})`);
      params.push(...teamIds);
      scopes.push(`EXISTS (
        SELECT 1 FROM team_shares ts WHERE ts.memory_id = i.memory_id
          AND ts.team_id IN (${placeholders}) AND ts.permission IN ('read', 'write')
      )`);
      params.push(...teamIds);
    }
    if (strict) {
      const visibilityGrants = ["vr.grantee_type = 'everyone'", "(vr.grantee_type = 'user' AND vr.grantee_id = ?)"];
      params.push(callerId!);
      if (teamIds.length > 0) {
        visibilityGrants.push(`(vr.grantee_type = 'team' AND vr.grantee_id IN (${teamIds.map(() => '?').join(', ')}))`);
        params.push(...teamIds);
      }
      scopes.push(`EXISTS (
        SELECT 1 FROM visibility_rules vr WHERE vr.asset_type = 'memory' AND vr.asset_id = i.memory_id
          AND vr.permission IN ('read', 'write')
          AND (${visibilityGrants.join(' OR ')})
      )`);
    }
    const where = [`i.session_token = ?`, `(${scopes.join(' OR ')})`];
    if (projectId !== undefined) {
      where.push('i.project_id IS ?');
      params.push(projectId);
    }
    if (!input.includeInactive) {
      where.push(`m.status = 'active' AND m.is_active = 1
        AND ${sqlLifecycleBound('m.valid_from', '<=')}
        AND ${sqlLifecycleBound('m.valid_to', '>')}
        AND ${sqlLifecycleBound('m.expires_at', '>')}`);
      const nowSeconds = Math.floor(Date.now() / 1000);
      params.push(nowSeconds, nowSeconds, nowSeconds);
    }
    if (input.cursor) {
      where.push('(i.created_at < ? OR (i.created_at = ? AND i.memory_id < ?))');
      params.push(input.cursor.createdAt, input.cursor.createdAt, input.cursor.memoryId);
    }
    params.push(input.limit);
    const rows = raw.prepare(`SELECT i.memory_id, i.project_id, i.user_id, i.team_id, i.record_mac, i.created_at
      FROM memory_private_session_index i JOIN memories m ON m.id = i.memory_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.created_at DESC, i.memory_id DESC LIMIT ?`).all(...params);
    const memoryIds: string[] = [];
    const rejectedMemoryIds: string[] = [];
    for (const row of rows) {
      const expectedMac = index.token('session-row', JSON.stringify([
        input.sessionId, row.memory_id, row.project_id ?? null, row.user_id ?? null, row.team_id ?? null,
      ]));
      if (expectedMac === row.record_mac) memoryIds.push(row.memory_id);
      else rejectedMemoryIds.push(row.memory_id);
    }
    if (strict && rejectedMemoryIds.length > 0) {
      const { writeTrustAudit } = await import('../acl/trust-audit.js');
      try {
        for (const memoryId of rejectedMemoryIds) {
          await writeTrustAudit({
            actorId: callerId!, resourceId: memoryId, assetType: 'encrypted_session_index',
            decision: 'deny', reason: 'invalid_signature',
          });
        }
      } catch {
        throw new TrustBoundaryError('Encrypted session recovery could not persist its index-integrity denial audit');
      }
    }
    const lastRow = rows.at(-1);
    return {
      memoryIds,
      scannedCount: rows.length,
      ...(lastRow ? { nextCursor: { createdAt: lastRow.created_at, memoryId: lastRow.memory_id } } : {}),
    };
  } finally {
    index.clear();
  }
}

async function readEncryptedSessionSources(input: {
  sessionId: string;
  project?: string;
  user?: string;
  teamId?: string;
  query?: string;
  limit: number;
  readTaggedMemories: NonNullable<Parameters<typeof recoverCapturedSession>[0]['readTaggedMemories']>;
}): Promise<SearchResult[]> {
  const { memoryIds: ids } = await readPrivateSessionMemoryIds(input);
  const chunks: SearchResult[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const requestedIds = ids.slice(offset, offset + 100);
    const requestedIdSet = new Set(requestedIds);
    const memories = await input.readTaggedMemories(requestedIds);
    // Treat the callback as an exact-ID read contract. A broader callback
    // result must never expand the authenticated private-index selection.
    chunks.push(...memories
      .filter((memory) => requestedIdSet.has(memory.id))
      .map((memory) => ({ ...memory, similarity: 0 }) as SearchResult));
  }
  // The index preflight happens before the caller-gated read yields. Recheck
  // lifecycle afterward so a source archived, expired, or closed during that
  // read cannot be returned as current recovery context.
  const { memoryIds: currentIds } = await readPrivateSessionMemoryIds({
    sessionId: input.sessionId,
    project: input.project,
    user: input.user,
    teamId: input.teamId,
    limit: input.limit,
  });
  const currentIdSet = new Set(currentIds);
  const currentChunks = chunks.filter((memory) => currentIdSet.has(memory.id));
  const terms: string[] = input.query?.toLowerCase().split(/[^a-z0-9]+/).filter((term: string) => term.length >= 2) ?? [];
  const score = (content: string): number => terms.length === 0
    ? 0
    : terms.reduce((count, term) => count + (content.toLowerCase().includes(term) ? 1 : 0), 0) / terms.length;
  return currentChunks.map((memory) => ({ ...memory, similarity: score(memory.content) }))
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)
      || (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0));
}

/** Recheck lifecycle after async caller-authorized session source reads. */
async function readActiveMemoryIds(
  memoryIds: string[],
  scope: { projectId?: string; user?: string } = {},
): Promise<Set<string>> {
  if (memoryIds.length === 0) return new Set();
  const { db, schema } = await (await import('../lib/db-client.js')).getDbClient();
  const now = new Date();
  const conditions = [
    inArray(schema.memories.id, memoryIds),
    eq(schema.memories.status, 'active'),
    eq(schema.memories.isActive, true),
  ];
  if (scope.projectId !== undefined) conditions.push(eq(schema.memories.projectId, scope.projectId));
  if ((db as { $clientType?: string }).$clientType === 'postgres') {
    conditions.push(
      or(isNull(schema.memories.validFrom), lte(schema.memories.validFrom, now))!,
      or(isNull(schema.memories.validTo), gt(schema.memories.validTo, now))!,
      or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, now))!,
    );
  } else {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const epochSeconds = (column: 'valid_from' | 'valid_to' | 'expires_at') =>
      sql.raw(sqlEpochSeconds(`memories.${column}`));
    conditions.push(
      sql`(${schema.memories.validFrom} IS NULL OR ${epochSeconds('valid_from')} <= ${nowSeconds})`,
      sql`(${schema.memories.validTo} IS NULL OR ${epochSeconds('valid_to')} > ${nowSeconds})`,
      sql`(${schema.memories.expiresAt} IS NULL OR ${epochSeconds('expires_at')} > ${nowSeconds})`,
    );
  }
  const rows: Array<{ id: string }> = await db.select({ id: schema.memories.id })
    .from(schema.memories)
    .where(and(...conditions));
  if (!isStrictTrustPolicy()) return new Set(rows.map((row) => row.id));

  // The caller-gated read above can yield while ownership or visibility changes.
  // Recheck the current principal ACL after that await so stale authorization
  // cannot return content that has since become private to another caller.
  const callerId = resolveTrustedCallerId(scope.user);
  if (!callerId) throw new TrustBoundaryError('Strict session recovery requires an authenticated caller');
  const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
  const visibility = await Promise.all(rows.map(async ({ id }) => ({
    id,
    allowed: await preauthorizeStrictMemoryReadBeforeDecrypt(id, callerId),
  })));
  return new Set(visibility.filter((row) => row.allowed).map((row) => row.id));
}

/** Retrieve captured session memories for compact, ID-addressable recovery after context loss. */
export async function recoverCapturedSession(input: {
  sessionId: string;
  query?: string;
  project?: string;
  user?: string;
  teamId?: string;
  budgetTokens?: number;
  limit?: number;
  /** Build an opt-in, derived binary summary view over the currently authorized session sources. */
  progressiveTree?: boolean;
  /** Include a small project-scoped durable-memory section alongside session recovery. */
  includeProjectContext?: boolean;
  /** Expand a prior summary node ID; the source set is re-read and re-authorized first. */
  expandNodeId?: string;
  /** Caller-gated exact-tag read supplied by the SDK runtime. */
  readTaggedMemories?: (ids: string[]) => Promise<Array<{
    id: string;
    type: string;
    content: string;
    tags: string[];
    metadata?: Record<string, unknown> | null;
    createdAt?: string | Date | null;
  }>>;
}): Promise<CapturedSessionRecovery> {
  if (!input.sessionId.trim() || input.sessionId.length > 256) {
    throw new Error('sessionId must contain 1 to 256 characters');
  }
  if (isStrictTrustPolicy() && !input.readTaggedMemories) {
    throw new TrustBoundaryError('Strict session recovery requires caller-gated source reads');
  }
  const query = input.query?.trim() || 'decision error unresolved task next step';
  const budgetTokens = Math.max(128, Math.min(20_000, Math.floor(input.budgetTokens ?? 2_000)));
  const payloadBudget = budgetTokens - 32;
  const limit = clampLimit(input.limit ?? 50, 100);
  const encryptedIndexMode = config.clientEncryptionEnabled;
  let recoveryProjectId: string | undefined;
  if (input.project) {
    const { requireProject } = await import('../projects.js');
    recoveryProjectId = (await requireProject(input.project)).id;
  }
  if (encryptedIndexMode && !input.readTaggedMemories) {
    throw new TrustBoundaryError('Encrypted session recovery requires caller-gated source reads');
  }
  const results = encryptedIndexMode
    ? await readEncryptedSessionSources({
      sessionId: input.sessionId,
      project: input.project,
      user: input.user,
      teamId: input.teamId,
      query,
      limit: Math.max(limit * 10, 100),
      readTaggedMemories: input.readTaggedMemories!,
    })
    : await squishSearch({
      query,
      project: input.project,
      user: input.user,
      teamId: input.teamId,
      tags: [sessionIdTag(input.sessionId)],
      limit,
      includeConsolidatedSources: true,
    });
  const targetTag = sessionIdTag(input.sessionId);
  const ranked = encryptedIndexMode ? results : results.filter((memory) => memory.tags.includes(targetTag));
  let tagged = ranked;
  if (!encryptedIndexMode && (input.readTaggedMemories || !isStrictTrustPolicy())) {
    const { db, schema } = await (await import('../lib/db-client.js')).getDbClient();
    const escapedTag = targetTag.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
    const conditions = [
      sql`${schema.memories.tags} LIKE ${`%${escapedTag}%`} ESCAPE '!'`,
      eq(schema.memories.status, 'active'),
      eq(schema.memories.isActive, true),
    ];
    const now = new Date();
    if ((db as { $clientType?: string }).$clientType === 'postgres') {
      conditions.push(
        or(isNull(schema.memories.validFrom), lte(schema.memories.validFrom, now))!,
        or(isNull(schema.memories.validTo), gt(schema.memories.validTo, now))!,
        or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, now))!,
      );
    } else {
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const epochSeconds = (column: 'valid_from' | 'valid_to' | 'expires_at') =>
        sql.raw(sqlEpochSeconds(`memories.${column}`));
      conditions.push(
        sql`(${schema.memories.validFrom} IS NULL OR ${epochSeconds('valid_from')} <= ${nowSeconds})`,
        sql`(${schema.memories.validTo} IS NULL OR ${epochSeconds('valid_to')} > ${nowSeconds})`,
        sql`(${schema.memories.expiresAt} IS NULL OR ${epochSeconds('expires_at')} > ${nowSeconds})`,
      );
    }
    if (recoveryProjectId !== undefined) conditions.push(eq(schema.memories.projectId, recoveryProjectId));
    const pageSize = Math.max(50, Math.min(500, limit * 4));
    const authorized: typeof ranked = [];
    let offset = 0;
    while (true) {
      const rows: Array<{ id: string; tags: unknown }> = await db.select({
        id: schema.memories.id,
        tags: schema.memories.tags,
      })
        .from(schema.memories)
        .where(and(...conditions))
        .orderBy(desc(schema.memories.createdAt), desc(schema.memories.id))
        .limit(pageSize)
        .offset(offset);
      if (rows.length === 0) break;
      // Strict ACL sanitization deliberately strips unsigned tags from returned
      // memories. Validate the exact selector against the persisted tag column
      // before the caller-gated read, then trust only the authorized IDs below.
      const exactTagIds = new Set(rows.filter((row) => {
        let tags: unknown = row.tags;
        if (typeof tags === 'string') {
          try { tags = JSON.parse(tags); } catch { return false; }
        }
        return Array.isArray(tags) && tags.includes(targetTag);
      }).map((row) => row.id));
      const pageIds = exactTagIds;
      const visible = input.readTaggedMemories
        ? await input.readTaggedMemories([...pageIds])
        : ranked.filter((memory) => pageIds.has(memory.id));
      authorized.push(...visible
        .filter((memory) => pageIds.has(memory.id))
        .map((memory) => ({
          ...memory,
          createdAt: memory.createdAt instanceof Date ? memory.createdAt.toISOString() : memory.createdAt ?? null,
          similarity: 0,
        })));
      offset += rows.length;
      if (authorized.length >= limit || rows.length < pageSize) break;
    }
    const rankedById = new Map(ranked.map((memory) => [memory.id, memory.similarity]));
    tagged = authorized
      .map((memory) => ({
        ...memory,
        similarity: rankedById.get(memory.id) ?? memory.similarity,
      }))
      .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0));
  }
  // The source scope, ACL, or lifecycle can change while a caller-authorized
  // exact-ID read is pending. Recheck the live source row even when the
  // encrypted private index supplied the initial authorization snapshot.
  if (tagged.length > 0) {
    const activeIds = await readActiveMemoryIds(tagged.map((memory) => memory.id), {
      projectId: recoveryProjectId,
      user: input.user,
    });
    tagged = tagged.filter((memory) => activeIds.has(memory.id));
  }
  let projectContext: NonNullable<CapturedSessionRecovery['projectContext']> = [];
  if (input.includeProjectContext === true && input.project) {
    const { requireProject } = await import('../projects.js');
    const selectedProject = await requireProject(input.project);
    const sessionIds = new Set(tagged.map((memory) => memory.id));
    const isDurableProjectCandidate = (memory: SearchResult) =>
      (!isStrictTrustPolicy() || memory.projectId === selectedProject.id)
      && !sessionIds.has(memory.id)
      && !memory.tags.some((tag) => tag.startsWith(CHUNK_PREFIX) || tag.startsWith(SESSION_PREFIX));
    let contextMatches = await squishSearch({
      query,
      project: input.project,
      user: input.user,
      teamId: input.teamId,
      limit: Math.min(20, limit),
      includeConsolidatedSources: true,
    });
    let candidates = contextMatches.filter(isDurableProjectCandidate);
    if (candidates.length === 0 && input.readTaggedMemories && isStrictTrustPolicy()) {
      const [{ buildAutoAclContext, buildStrictMemoryCandidateFilter }, { keywordSearch }] = await Promise.all([
        import('../acl/read-gate.js'),
        import('../memory/keyword-search.js'),
      ]);
      const acl = await buildAutoAclContext(input.user, input.teamId ? [input.teamId] : undefined);
      if (!acl) throw new Error('Strict project-context retrieval requires an authenticated ACL context');
      const candidateFilter = await buildStrictMemoryCandidateFilter(acl);
      contextMatches = await keywordSearch({
        query,
        project: input.project,
        user: input.user,
        teamId: input.teamId,
        includeConsolidatedSources: true,
      }, Math.min(20, limit), undefined, candidateFilter);
      candidates = contextMatches.filter(isDurableProjectCandidate);
    }
    const candidateIds = candidates.slice(0, 3).map((memory) => memory.id);
    const candidateIdSet = new Set(candidateIds);
    const authorizedContext = input.readTaggedMemories
      ? await input.readTaggedMemories(candidateIds)
      : candidates.slice(0, 3);
    const eligibleContext = authorizedContext
      .filter((memory) => candidateIdSet.has(memory.id)
        && !memory.tags.some((tag) => tag.startsWith(CHUNK_PREFIX) || tag.startsWith(SESSION_PREFIX)));
    const activeContextIds = await readActiveMemoryIds(eligibleContext.map((memory) => memory.id), {
      projectId: selectedProject.id,
      user: input.user,
    });
    projectContext = eligibleContext
      .filter((memory) => activeContextIds.has(memory.id))
      .slice(0, 3)
      .map((memory) => ({
        id: memory.id,
        type: memory.type,
        content: memory.content.slice(0, 320),
        createdAt: memory.createdAt instanceof Date ? memory.createdAt.toISOString() : memory.createdAt ?? null,
        ...(memory.content.length > 320 ? { contentTruncated: true } : {}),
      }));
    const contextBudgetTokens = budgetTokens >= 512
      ? Math.min(256, Math.floor(budgetTokens / 4))
      : 0;
    while (projectContext.length > 0 && estimateJsonTokens(projectContext) > contextBudgetTokens) {
      const last = projectContext.at(-1)!;
      if (projectContext.length > 1) {
        projectContext.pop();
      } else if (last.content.length > 0) {
        last.content = last.content.slice(0, Math.floor(last.content.length / 2));
        last.contentTruncated = true;
      } else {
        projectContext = [];
      }
    }
  }
  const progressive = input.progressiveTree === true || input.expandNodeId !== undefined;
  if (progressive && input.expandNodeId !== undefined && tagged.length === 0) {
    throw new Error('Summary tree node is stale or unavailable');
  }
  if (progressive && tagged.length > 0 && budgetTokens < MIN_PROGRESSIVE_RECOVERY_BUDGET) {
    throw new Error(`Progressive session recovery requires at least ${MIN_PROGRESSIVE_RECOVERY_BUDGET} tokens`);
  }
  let tree: CapturedSessionRecovery['tree'];
  if (progressive && tagged.length > 0) {
    const { buildProgressiveTemporalSummaryTree } = await import('./progressive-tree.js');
    const sources = tagged.map((memory) => ({
      id: memory.id,
      // Session chunk timestamps describe when the source event occurred. The
      // database createdAt is only capture/write time and can differ during
      // imports or delayed host-session ingestion.
      createdAt: typeof memory.metadata?.timestamp === 'string'
        ? memory.metadata.timestamp
        : memory.createdAt ?? null,
      content: memory.content,
    }));
    const buildTree = (treeBudget: number) =>
      buildProgressiveTemporalSummaryTree(sources, treeBudget, input.expandNodeId);
    const contextTokens = estimateJsonTokens(projectContext);
    let treeBudget = Math.max(128, budgetTokens - 128 - contextTokens);
    tree = buildTree(treeBudget);
    const responseDraft = () => ({
      ok: true,
      sessionId: input.sessionId,
      query,
      budgetTokens,
      tokenEstimate: tree!.estimatedTokens + 32,
      omittedCount: tree!.sourceCount - tree!.detailSourceCount,
      evidence: [] as unknown[],
      ...(projectContext.length > 0 ? { projectContext } : {}),
      tree,
      version: '2.2.0',
    });
    const responseTokens = () => estimateJsonTokens(responseDraft());
    while (responseTokens() > budgetTokens && treeBudget > 128) {
      treeBudget = Math.max(128, treeBudget - Math.max(8, responseTokens() - budgetTokens));
      tree = buildTree(treeBudget);
    }
    while (responseTokens() > budgetTokens) {
      const itemIndex = tree!.items.findIndex((item) => item.preview.length > 0
        || (item.kind === 'source' && Boolean(item.text)));
      if (itemIndex < 0) break;
      const item = tree!.items[itemIndex]!;
      const excessChars = Math.max(1, (responseTokens() - budgetTokens) * 4);
      const items = [...tree!.items];
      if (item.preview.length > 0) {
        items[itemIndex] = { ...item, preview: item.preview.slice(0, Math.max(0, item.preview.length - excessChars)) };
      } else if (item.kind === 'source' && item.text) {
        // Bound only this response excerpt; the canonical captured source remains unchanged.
        items[itemIndex] = {
          ...item,
          text: item.text.slice(0, Math.max(0, item.text.length - excessChars)),
          textTruncated: true,
        };
      }
      const updatedTree: Omit<NonNullable<CapturedSessionRecovery['tree']>, 'estimatedTokens'> = {
        version: tree!.version,
        rootId: tree!.rootId,
        sourceCount: tree!.sourceCount,
        detailSourceCount: tree!.detailSourceCount,
        budgetTokens: tree!.budgetTokens,
        ...(tree!.expandedNodeId ? { expandedNodeId: tree!.expandedNodeId } : {}),
        items,
      };
      tree = { ...updatedTree, estimatedTokens: estimateJsonTokens(updatedTree) };
    }
    if (responseTokens() > budgetTokens) {
      throw new Error('Progressive session recovery metadata exceeds its token budget');
    }
    tree = { ...tree, estimatedTokens: responseTokens() };
  }
  const evidence: CapturedSessionRecovery['evidence'] = [];
  let tokenEstimate = 0;
  const estimatedEnvelopeTokens = (items: CapturedSessionRecovery['evidence'], tokens: number) =>
    estimateJsonTokens({ ok: true, sessionId: input.sessionId, query, budgetTokens, tokenEstimate: tokens + 32, omittedCount: tagged.length - items.length, evidence: items, projectContext, version: '2.2.0' });
  for (const memory of progressive ? [] : tagged) {
    const entry = {
      id: memory.id,
      type: memory.type,
      content: memory.content,
      createdAt: memory.createdAt ?? null,
    };
    const cost = Math.ceil((JSON.stringify(entry).length + 2) / 4);
    evidence.push(entry);
    if (estimatedEnvelopeTokens(evidence, tokenEstimate + cost) <= budgetTokens && tokenEstimate + cost <= payloadBudget) {
      tokenEstimate += cost;
      continue;
    }
    evidence.pop();

    let low = 0;
    let high = entry.content.length;
    let accepted: typeof entry | null = null;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...entry, content: entry.content.slice(0, middle) };
      const candidateCost = Math.ceil((JSON.stringify(candidate).length + 2) / 4);
      evidence.push(candidate);
      const fits = estimatedEnvelopeTokens(evidence, tokenEstimate + candidateCost) <= budgetTokens && tokenEstimate + candidateCost <= payloadBudget;
      evidence.pop();
      if (fits) {
        low = middle;
        accepted = candidate;
      } else {
        high = middle - 1;
      }
    }
    if (accepted && low > 0) {
      evidence.push(accepted);
      tokenEstimate += Math.ceil((JSON.stringify(accepted).length + 2) / 4);
    }
    break;
  }
  return {
    sessionId: input.sessionId,
    query,
    budgetTokens,
    tokenEstimate: tree?.estimatedTokens ?? estimatedEnvelopeTokens(evidence, tokenEstimate),
    omittedCount: tree ? tree.sourceCount - tree.detailSourceCount : tagged.length - evidence.length,
    evidence,
    ...(projectContext.length > 0 ? { projectContext } : {}),
    ...(tree ? { tree } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;

export interface SearchChunksInput {
  query: string;
  limit?: number;
  project?: string;
  repo_path?: string;
  chunk_type?: ChunkType;
  /** Default 'all'. One of: opencode, claude-code, codex, all. */
  source?: import('./agent-stores/types.js').SessionSource;
  /** Optional override for opencode.db path. */
  opencode_db_path?: string;
  /** 'text' (default, fast) | 'deep' (all parts, slower). */
  depth?: 'text' | 'deep';
  scan_budget_sessions?: number;
  scan_timeout_ms?: number;
}

function clampLimit(n: number, max: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  if (n > max) return max;
  return Math.floor(n);
}

/**
 * Status of the opencode.db sidecar + source DB. CLI uses this to
 * tell the user "OpenCode history: 6,724 sessions available" so
 * the pull direction is visible.
 */
export function getOpenCodeStatus(input: { db_path?: string } = {}) {
  return opencodeDbStatus({ dbPath: input.db_path });
}

/**
 * Resolve the list of agent names to query for a given source.
 * `all` expands to every registered agent; a specific name returns
 * just that one.
 */
function resolveSources(source: import('./agent-stores/types.js').SessionSource): AgentName[] {
  if (source === 'all') return availableAgentStores();
  return [source];
}

function unavailableReasonCode(reason?: string): NonNullable<SessionSearchDiagnostics['availability']>['reasonCode'] {
  if (reason === 'availability_check_failed') return 'availability_check_failed';
  if (/disabled/i.test(reason ?? '')) return 'disabled';
  if (/not found/i.test(reason ?? '')) return 'not_found';
  if (/failed to open/i.test(reason ?? '')) return 'open_failed';
  return 'unavailable';
}

async function readAgentStore<T>(
  agent: AgentName,
  operation: string,
  read: () => Promise<T>,
  fallback: T,
  onFailure?: () => void,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    onFailure?.();
    logger.warn(`[sessions] ${agent} ${operation} failed; continuing with available sources`, {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return fallback;
  }
}

async function readAgentStoreBeforeDeadline<T>(
  agent: AgentName,
  operation: string,
  read: () => Promise<T>,
  fallback: T,
  deadlineMs: number,
  onFailure?: () => void,
): Promise<{ value: T; timedOut: boolean }> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    onFailure?.();
    return { value: fallback, timedOut: true };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('session-search-timeout');
  const result = await Promise.race([
    readAgentStore(agent, operation, read, fallback, onFailure),
    new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result === timedOut
    ? { value: fallback, timedOut: true }
    : { value: result, timedOut: false };
}

/**
 * Wraps a `Chunk` from an agent store into a `ChunkResult` with
 * a synthesized score (1 / rank-in-its-source) and a `why` line.
 * Different agents use different scoring scales; we just rank
 * within each source and let the merge step interleave.
 */
function chunkToResult(rank: number, chunk: Chunk, agent: AgentName): ChunkResult {
  return {
    chunk,
    score: 1 / (rank + 1),
    memory_id: `${agent}:${chunk.session_id}:${chunk.agent_session_id}`,
    why: `agent:${agent} - ${whyLine(chunk.content, chunk) || `matched in ${chunk.type} text`}`,
  };
}

export interface SearchChunksDetailedResult {
  results: ChunkResult[];
  diagnostics: Partial<Record<AgentName, SessionSearchDiagnostics>>;
}

export async function searchChunksDetailed(input: SearchChunksInput): Promise<SearchChunksDetailedResult> {
  requireRawSessionHistoryAllowed();
  const limit = clampLimit(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const source: import('./agent-stores/types.js').SessionSource = input.source ?? 'all';
  const sources = resolveSources(source);

  const out: ChunkResult[] = [];
  const diagnostics: Partial<Record<AgentName, SessionSearchDiagnostics>> = {};
  const maxSessions = input.scan_budget_sessions ?? 5_000;
  const deadlineMs = Date.now() + Math.max(100, Math.min(input.scan_timeout_ms ?? 7_000, 30_000));

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const name = sources[sourceIndex]!;
    const store = getAgentStore(name);
    const sourceOptions = name === 'opencode' ? { opencode_db_path: input.opencode_db_path } : undefined;
    const availability = await readAgentStoreBeforeDeadline(name, 'availability check',
      () => store.available(sourceOptions),
      { ok: false, reason: 'availability_check_failed' }, deadlineMs);
    const available = availability.value;
    if (!available.ok) {
      diagnostics[name] = {
        mode: 'unavailable',
        scannedSessions: 0,
        oversizedSessions: 0,
        fileSizeLimitBytes: 5 * 1024 * 1024,
        truncated: availability.timedOut,
        ...(availability.timedOut ? { reason: 'time_limit' as const } : {}),
        truncationReasons: availability.timedOut ? ['time_limit'] : [],
        availability: {
          status: 'unavailable',
          reasonCode: availability.timedOut ? 'timeout' : unavailableReasonCode(available.reason),
        },
      };
      continue;
    }

    const sourcesRemaining = sources.length - sourceIndex;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      const budget = createSessionSearchBudget(maxSessions, 100);
      markSessionSearchTruncated(budget, 'time_limit');
      diagnostics[name] = {
        mode: name === 'opencode' ? 'session_scan' : 'transcript_scan',
        scannedSessions: 0,
        oversizedSessions: 0,
        fileSizeLimitBytes: budget.maxTranscriptBytes,
        truncated: true,
        reason: 'time_limit',
        truncationReasons: ['time_limit'],
      };
      continue;
    }
    const sourceTimeoutMs = Math.max(100, Math.floor(remainingMs / sourcesRemaining));
    const budget = createSessionSearchBudget(maxSessions, sourceTimeoutMs);
    const sourceLimit = input.chunk_type ? MAX_LIMIT : limit;

    // A typed search uses the adapter's full bounded result window so hits
    // behind other chunk types can survive filtering before cross-source rank.
    const search = await readAgentStoreBeforeDeadline(name, 'search', () => store.searchSessions({
      query: input.query,
      limit: sourceLimit,
      depth: input.depth,
      directory_glob: input.repo_path ?? input.project,
      opencode_db_path: input.opencode_db_path,
      scanBudget: budget,
    }), [], deadlineMs, () => {
      markSessionSearchTruncated(budget, 'source_error');
    });
    const chunks = search.value;
    if (search.timedOut) markSessionSearchTruncated(budget, 'time_limit');
    if (Date.now() >= deadlineMs && !budget.truncationReasons.includes('time_limit')) {
      budget.truncated = true;
      if (!budget.reason) budget.reason = 'time_limit';
      budget.truncationReasons.push('time_limit');
    }
    diagnostics[name] = {
      mode: budget.mode ?? (name === 'opencode' ? 'session_scan' : 'transcript_scan'),
      scannedSessions: budget.scannedSessions,
      oversizedSessions: budget.oversizedSessions,
      fileSizeLimitBytes: budget.maxTranscriptBytes,
      truncated: budget.truncated,
      ...(budget.reason ? { reason: budget.reason } : {}),
      ...(budget.scopeError ? { scopeError: budget.scopeError } : {}),
      truncationReasons: budget.truncationReasons,
    };
    scheduleSessionCachePrune(name);

    const rankedChunks = input.chunk_type
      ? chunks.filter((chunk) => chunk.type === input.chunk_type).slice(0, limit)
      : chunks;
    for (let rank = 0; rank < rankedChunks.length; rank++) {
      out.push(chunkToResult(rank, rankedChunks[rank]!, name));
    }
  }

  out.sort((a, b) => b.score - a.score);
  return { results: out.slice(0, limit), diagnostics };
}

export async function searchChunks(input: SearchChunksInput): Promise<ChunkResult[]> {
  const result = await searchChunksDetailed(input);
  return result.results;
}

/* ------------------------------------------------------------------ */
/* Session groupings                                                   */
/* ------------------------------------------------------------------ */

export async function getSessionChunks(
  sessionId: string,
  opts: { source?: import('./agent-stores/types.js').SessionSource; opencode_db_path?: string } = {}
): Promise<SessionGroup | null> {
  requireRawSessionHistoryAllowed();
  const source: import('./agent-stores/types.js').SessionSource = opts.source ?? 'all';
  const sources = resolveSources(source);

  for (const name of sources) {
    const store = getAgentStore(name);
    const storeInput = name === 'opencode' ? { opencode_db_path: opts.opencode_db_path } : undefined;
    const available = await store.available(storeInput).catch(() => ({ ok: false as const }));
    if (!available.ok) continue;
    const result = await store.getSession(sessionId, storeInput).catch(() => null);
    scheduleSessionCachePrune(name);
    if (result) {
      return { ...result.group, chunks: result.chunks };
    }
  }
  return null;
}

export interface ListSessionsInput {
  limit?: number;
  project?: string;
  source?: import('./agent-stores/types.js').SessionSource;
  opencode_db_path?: string;
  /** Directory glob to filter opencode sessions (case-insensitive substring). */
  directory_glob?: string;
}

export interface ListSessionsResult {
  sessions: SessionGroup[];
  /** Per-agent counts of how many sessions came back from each store. */
  sources: Record<AgentName, number>;
  /** Convenience: the opencode-specific status (or null if not requested). */
  opencode: ReturnType<typeof opencodeDbStatus>;
}

/**
 * Public list: iterates the registered agent stores and merges
 * their session groups, sorted by recency. Each store is queried
 * with `directory_glob` so the opencode side respects the filter
 * at the SQL level (rather than post-filtering in JS).
 */
export async function listSessions(input: ListSessionsInput = {}): Promise<ListSessionsResult> {
  requireRawSessionHistoryAllowed();
  const limit = input.limit ?? 20;
  const source: import('./agent-stores/types.js').SessionSource = input.source ?? 'all';
  const sources = resolveSources(source);
  const groups: SessionGroup[] = [];
  const counts: Record<AgentName, number> = {
    'opencode': 0,
    'claude-code': 0,
    'codex': 0,
    'gemini': 0,
  };

  for (const name of sources) {
    const store = getAgentStore(name);
    const available = await store.available().catch(() => ({ ok: false as const }));
    if (!available.ok) continue;
    const list = await readAgentStore(name, 'list', () => store.listSessions({
      limit,
      directory_glob: input.directory_glob,
    }), []);
    scheduleSessionCachePrune(name);
    for (const g of list) {
      groups.push(g);
      counts[name] += 1;
    }
  }

  const merged = Array.from(groups.values())
    .sort((a, b) => {
      const ae = a.ended_at ?? a.started_at;
      const be = b.ended_at ?? b.started_at;
      return be.localeCompare(ae);
    })
    .slice(0, limit);

  return {
    sessions: merged,
    sources: counts,
    opencode: opencodeDbStatus(),
  };
}

/* ------------------------------------------------------------------ */
/* Related                                                             */
/* ------------------------------------------------------------------ */

export interface FindRelatedInput {
  repo_path: string;
  files?: string[];
  limit?: number;
  source?: import('./agent-stores/types.js').SessionSource;
  opencode_db_path?: string;
}

export interface RelatedResult {
  session: SessionGroup;
  score: number;
  matching_chunks: Chunk[];
  reason: string;
}

/**
 * Find past sessions related to a directory (and optional file
 * paths). Iterates the registered agent stores. Each store returns
 * `{ group, score, reason }` per the `AgentSessionStore` interface;
 * the public surface enriches the result with the matching chunks
 * (by calling `getSession` on each group).
 */
export async function findRelatedSessions(input: FindRelatedInput): Promise<RelatedResult[]> {
  requireRawSessionHistoryAllowed();
  const limit = input.limit ?? 5;
  const source: import('./agent-stores/types.js').SessionSource = input.source ?? 'all';
  const sources = resolveSources(source);

  const perSession = new Map<string, { session: SessionGroup; score: number; reason: string; chunks: Chunk[] }>();

  for (const name of sources) {
    const store = getAgentStore(name);
    const available = await store.available().catch(() => ({ ok: false as const }));
    if (!available.ok) continue;
    const results = await readAgentStore(name, 'related-session lookup', () => store.findRelatedSessions({
      repo_path: input.repo_path,
      files: input.files,
      limit: Math.max(limit, 20),
    }), []);
    scheduleSessionCachePrune(name);
    for (const r of results) {
      const existing = perSession.get(r.group.session_id);
      if (existing) {
        existing.score += r.score + 1; // boost when multiple agents agree
        if (existing.reason === '' || existing.reason !== r.reason) {
          existing.reason = `${existing.reason} + ${r.reason}`;
        }
        continue;
      }
      perSession.set(r.group.session_id, {
        session: r.group,
        score: r.score,
        reason: r.reason,
        chunks: [],
      });
    }
  }

  // Pull chunks for the top sessions. Cheap if the agent has an
  // indexed store (opencode.db is in-process; sub-millisecond).
  const topIds = Array.from(perSession.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => p.session.session_id);

  await Promise.all(
    topIds.map(async (id) => {
      const entry = perSession.get(id);
      if (!entry) return;
      for (const name of sources) {
        const store = getAgentStore(name);
        const detail = await store.getSession(id).catch(() => null);
        if (detail) {
          entry.chunks = detail.chunks;
          return;
        }
      }
    })
  );

  const out: RelatedResult[] = [];
  for (const entry of perSession.values()) {
    out.push({
      session: entry.session,
      score: entry.score,
      matching_chunks: entry.chunks,
      reason: entry.reason,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}