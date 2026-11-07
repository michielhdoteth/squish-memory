/**
 * Memory write operations.
 *
 * Handles the complex rememberMemory flow: embedding, importance scoring,
 * belief extraction, graph sync, contradiction resolution, place assignment,
 * and post-capture geometry checks.
 */

import { createHash, randomUUID } from 'crypto';
import { withSqliteTransaction } from '../storage/sqlite-transaction.js';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { config } from '../../config.js';
import { logger } from '../logger.js';
import { getOrCreateProject } from '../../core/projects.js';
import { getEmbedding, embeddingModelFor, activeEmbeddingModel } from '../../core/embeddings.js';
import { enrichContent } from '../retrieval/contextual-enrichment.js';
import { normalizeTags, serializeTags, serializeMetadata } from '../../core/memory/serialization.js';
import { prepareEmbedding } from '../lib/utils.js';
import { validateUuid } from '../lib/validation.js';
import { detectMemorySignals } from './trigger-detector.js';
import { applySupersession, resolveContradictions } from './contradiction-resolver.js';
import { decrypt, encryptWithPrivateIndex } from '../security/encrypt.js';
import { estimateTokens } from '../context/context-window.js';
import { getDbClient } from '../lib/db-client.js';
import { createKnowledge, createKnowledgeEdge } from '../knowledge/store.js';
import type { CreateKnowledgeInput } from '../knowledge/types.js';
import { buildMemoryPolicy, buildVisibilityScopes, serializeVisibilityScopes, recommendMemoryScope } from './policy.js';
import { onMemoryStored } from '../graph/incremental-sync.js';
import { scheduleMentalModelRefresh } from '../knowledge/mental-models.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { findOrCreateCluster, updateClusterStats } from '../clustering/cluster-engine.js';
import { evaluateCluster } from '../clustering/consolidation-check.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { withBusyRetry } from '../../db/busy-retry.js';
import { computeInitialImportance } from './importance.js';
import { normalizeMemoryRecord, getMemory, getOrCreateUser } from './memory-crud.js';
import { isGeneratedContextEcho } from './context-echo.js';
// WS2a: write-time near-duplicate detection + linking (SQUISH_WRITE_DEDUP).
import { runWriteDedupStage } from './write-dedup.js';
import { signMemoryProvenance, verifyMemoryProvenance } from '../acl/provenance.js';
import { resolveTrustedCallerId, isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { listUserTeamIds } from '../../db/team-adapter.js';
import { writeTrustAudit } from '../acl/trust-audit.js';
import { preauthorizeStrictMemoryReadBeforeDecrypt } from '../acl/read-gate.js';
import { writeTeamAuditEvent } from '../acl/team-authorization.js';
import { assertStrictMemoryWriteAtomicity } from '../acl/strict-memory-write.js';
import { emit } from '../event-bus.js';
import type { DrizzleExecutor } from '../storage/database.js';
// Batch 7: every durable write feeds the session working set so wake-up
// summaries reflect real project activity.
import { recordSessionSignal } from '../session/working-set.js';
import { readCodexTranscript } from '../sessions/agent-stores/codex.js';
import { readClaudeTranscript } from '../sessions/agent-stores/claude-code.js';
import { readOpenCodeTranscript } from '../sessions/agent-stores/opencode.js';
import { readGeminiTranscript } from '../sessions/agent-stores/gemini.js';
// Batch 6b: signals-based sector classification (episodic|semantic|procedural|reflective).
import { routeSector } from './sector-router.js';
import type { RememberInput, MemoryRecord, VisibilityScope } from './memory-types.js';
import { normalizeIanaTimeZone } from './temporal-parser.js';
import { normalizeTimestampValue } from '../retrieval/temporal-validity.js';

// ---------------------------------------------------------------------------
// rememberMemory — the main write path
// ---------------------------------------------------------------------------

export async function rememberMemory(input: RememberInput): Promise<MemoryRecord> {
  return rememberMemoryInternal(input);
}

/**
 * Persist a reviewed compaction and link its source within the same storage
 * transaction. The expected source fields fence drafts against edits made
 * after the user reviewed them.
 */
export async function rememberMemoryWithConsolidatedSource(
  input: RememberInput,
  source: ReviewedCompactionSourceGuard,
): Promise<MemoryRecord> {
  return rememberMemoryInternal(input, { reviewedCompactionSource: source });
}

export interface ReviewedCompactionSourceGuard {
  id: string;
  content: string;
  projectId: string | null;
  userId: string | null;
  type: string;
}

interface HostTranscriptAttestation {
  version: 1;
  agent: 'codex' | 'claude-code' | 'opencode' | 'gemini';
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  messageIndex: number;
  sourceFingerprint: string;
}

/** Internal-only writer used after a host adapter rereads a transcript. */
export async function rememberHostTranscriptMessage(
  agent: HostTranscriptAttestation['agent'],
  sessionId: string,
  messageIndex: number,
  sourceFingerprint: string,
  user?: string,
): Promise<MemoryRecord> {
  if (!sessionId || !Number.isInteger(messageIndex) || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new TrustBoundaryError('Transcript capture requires a host session message identity');
  }
  const snapshot = readHostTranscript(agent, sessionId);
  const message = snapshot?.messages.find((candidate) => candidate.messageIndex === messageIndex);
  if (!snapshot || !message || message.sourceFingerprint !== sourceFingerprint || !snapshot.projectPath.trim()) {
    throw new TrustBoundaryError('Host transcript changed before the message could be captured');
  }
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
    throw new TrustBoundaryError('Host transcript message has an unsupported role');
  }
  const attestation: HostTranscriptAttestation = {
    version: 1,
    agent,
    sessionId,
    role: message.role,
    messageIndex,
    sourceFingerprint,
  };
  const captureKey = `host-transcript-v1:${createHash('sha256').update(JSON.stringify([
    agent, sessionId, messageIndex, sourceFingerprint,
  ])).digest('hex')}`;
  return rememberMemoryInternal({
    content: message.content,
    type: 'note',
    tags: [`squish_session:${sessionId}`, `host-transcript:${agent}`],
    project: snapshot.projectPath,
    user,
    source: `session_chunk:${sessionId}`,
    sessionId,
    captureKey,
    metadata: { session_id: sessionId, agent_session_id: sessionId, host_source: agent },
  }, { hostTranscript: attestation });
}

function readHostTranscript(agent: HostTranscriptAttestation['agent'], sessionId: string) {
  switch (agent) {
    case 'codex': return readCodexTranscript(sessionId);
    case 'claude-code': return readClaudeTranscript(sessionId);
    case 'opencode': return readOpenCodeTranscript(sessionId);
    case 'gemini': return readGeminiTranscript(sessionId);
  }
}

export const rememberCodexTranscriptMessage = (
  sessionId: string, messageIndex: number, sourceFingerprint: string, user?: string,
) => rememberHostTranscriptMessage('codex', sessionId, messageIndex, sourceFingerprint, user);

/**
 * Persist a strict memory and its audit event in the same source/projection
 * transaction. This deliberately accepts only a team audit event, not an
 * arbitrary callback on RememberInput.
 */
export async function rememberMemoryWithAudit(
  input: RememberInput,
  auditEvent: Parameters<typeof writeTeamAuditEvent>[0],
  source: StrictPromotionSource,
  requiredTeamRole?: StrictPromotionAuthorization,
): Promise<MemoryRecord> {
  if (!isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Transactional memory audit writes require strict trust');
  }
  return rememberMemoryInternal(input, { auditEvent, source, requiredTeamRole });
}

interface StrictPromotionAuthorization {
  persistedUserId: string;
  teamId: string;
  roles: readonly ('owner' | 'admin')[];
}

interface StrictPromotionSource {
  id: string;
  content: string;
  projectId: string | null;
  type: string;
  ownerId: string;
  expiresAt?: Date | null;
}

interface StrictPromotionCommit {
  auditEvent: Parameters<typeof writeTeamAuditEvent>[0];
  source: StrictPromotionSource;
}

interface MemoryWriteOptions {
  auditEvent?: Parameters<typeof writeTeamAuditEvent>[0];
  source?: StrictPromotionSource;
  requiredTeamRole?: StrictPromotionAuthorization;
  hostTranscript?: HostTranscriptAttestation;
  reviewedCompactionSource?: ReviewedCompactionSourceGuard;
}

class ExistingCaptureReceipt extends Error {
  constructor(readonly memoryId: string) {
    super('Capture event already stored');
    this.name = 'ExistingCaptureReceipt';
  }
}

interface CaptureReceiptMemory {
  memoryId: string;
  contentHash: string;
  projectId: string | null;
  userId: string | null;
  teamId: string | null;
}

async function findCaptureReceipt(
  db: any,
  schema: Record<string, any>,
  raw: any,
  postgresSchema: boolean,
  captureKeyHash: string,
): Promise<CaptureReceiptMemory | null> {
  if (postgresSchema) {
    const receipts = schema.memoryCaptureReceipts;
    if (!receipts) throw new Error('PostgreSQL capture idempotency requires migration 0013_memory_capture_receipts');
    const rows = await db.select({
      memoryId: receipts.memoryId,
      contentHash: receipts.contentHash,
      projectId: schema.memories.projectId,
      userId: schema.memories.userId,
      teamId: schema.memories.teamId,
    }).from(receipts)
      .innerJoin(schema.memories, eq(receipts.memoryId, schema.memories.id))
      .where(eq(receipts.captureKeyHash, captureKeyHash))
      .limit(1);
    const row = rows[0];
    return row ? {
      memoryId: String(row.memoryId),
      contentHash: row.contentHash,
      projectId: row.projectId == null ? null : String(row.projectId),
      userId: row.userId == null ? null : String(row.userId),
      teamId: row.teamId == null ? null : String(row.teamId),
    } : null;
  }

  const row = raw.prepare(`SELECT r.memory_id, r.content_hash, m.project_id, m.user_id, m.team_id
    FROM memory_capture_receipts r JOIN memories m ON m.id = r.memory_id WHERE r.capture_key_hash = ?`)
    .get(captureKeyHash) as { memory_id: string; content_hash: string; project_id: string | null; user_id: string | null; team_id: string | null } | undefined;
  return row ? {
    memoryId: row.memory_id,
    contentHash: row.content_hash,
    projectId: row.project_id,
    userId: row.user_id,
    teamId: row.team_id,
  } : null;
}

function captureReceiptMatches(
  receipt: CaptureReceiptMemory | null,
  contentHash: string,
  projectId: string | null,
  userId: string | null,
  teamId: string | null,
): receipt is CaptureReceiptMemory {
  return receipt !== null && receipt.contentHash === contentHash
    && receipt.projectId === projectId && receipt.userId === userId && receipt.teamId === teamId;
}

async function loadCaptureReplayMemory(memoryId: string, callerId?: string): Promise<MemoryRecord> {
  const { db, schema } = await getDbClient();
  const [row] = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  if (!row) throw new Error('Capture receipt points to a missing memory');
  let content = row.content;
  const encrypted = (row as any).isEncrypted ?? row.is_encrypted;
  const encryptedContent = (row as any).encryptedContent ?? row.encrypted_content;
  const encryptionNonce = (row as any).encryptionNonce ?? row.encryption_nonce;
  if (encrypted) {
    if (!encryptedContent || !encryptionNonce) throw new Error('Encrypted capture replay is missing ciphertext metadata');
    if (isStrictTrustPolicy()) {
      const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
      if (!callerId || !await preauthorizeStrictMemoryReadBeforeDecrypt(memoryId, callerId)) {
        throw new TrustBoundaryError('Capture replay memory is not readable by the authenticated principal');
      }
    }
    content = decrypt(encryptedContent, encryptionNonce);
  }
  const candidate = normalizeMemoryRecord({ ...row, content });
  if (isStrictTrustPolicy()) {
    const { applyAclReadGate, buildAutoAclContext } = await import('../acl/read-gate.js');
    const authorized = await applyAclReadGate([candidate], await buildAutoAclContext(callerId));
    if (authorized.length !== 1) {
      throw new TrustBoundaryError('Capture replay memory is not readable by the authenticated principal');
    }
  }
  return candidate;
}

function normalizeExpiry(value: Date | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const milliseconds = value instanceof Date
    ? value.getTime()
    : Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  if (!Number.isFinite(milliseconds)) throw new Error('Memory expiry must be a valid date or epoch timestamp');
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) throw new Error('Memory expiry must be a valid date or epoch timestamp');
  return date;
}

function isSessionEpisodeCapture(input: RememberInput, tags: string[]): boolean {
  const metadata = input.metadata;
  return tags.some((tag) => tag.startsWith('squish_chunk:'))
    && tags.some((tag) => tag.startsWith('squish_session:'))
    && typeof metadata?.chunk_type === 'string'
    && typeof metadata.agent_session_id === 'string'
    && typeof metadata.session_id === 'string';
}

function isEncryptedSessionChunkCapture(input: RememberInput): boolean {
  const sessionId = input.sessionId?.trim();
  const metadata = input.metadata;
  const tags = normalizeTags(input.tags);
  if (!sessionId || sessionId.length > 256 || input.source !== `session_chunk:${sessionId}`
    || typeof input.captureKey !== 'string' || !input.captureKey.startsWith('session-chunk-v1:')
    || metadata?.session_id !== sessionId || typeof metadata.agent_session_id !== 'string'
    || typeof metadata.chunk_type !== 'string') return false;
  return tags.includes(`squish_chunk:${metadata.chunk_type}`) && tags.includes(`squish_session:${sessionId}`);
}

async function rememberMemoryInternal(
  input: RememberInput,
  options: MemoryWriteOptions = {},
): Promise<MemoryRecord> {
  const sourceTimeZone = input.timeZone ? normalizeIanaTimeZone(input.timeZone) : undefined;
  const strictPromotion = options.auditEvent && options.source
    ? { auditEvent: options.auditEvent, source: options.source, requiredTeamRole: options.requiredTeamRole }
    : undefined;
  let accessUser: string | undefined;
  try {
    accessUser = resolveTrustedCallerId(input.user) ?? undefined;
  } catch (error) {
    if (isStrictTrustPolicy()) {
      await writeTrustAudit({
        actorId: input.user?.trim() || 'unbound',
        resourceId: 'memory-write',
        assetType: 'memory',
        decision: 'deny',
        reason: 'caller_mismatch',
      });
    }
    throw error;
  }
  if (isGeneratedContextEcho(input.content)) {
    throw new Error('Generated context cannot be stored as a new memory');
  }
  const promotionRoleIsCheckedAtomically = Boolean(options.requiredTeamRole && options.auditEvent && options.source);
  if (isStrictTrustPolicy() && input.teamId && !promotionRoleIsCheckedAtomically) {
    const memberTeamIds = await listUserTeamIds(accessUser!);
    if (!memberTeamIds.includes(input.teamId)) {
      await writeTrustAudit({
        actorId: accessUser!,
        resourceId: input.teamId,
        assetType: 'team_memory_write',
        decision: 'deny',
        reason: 'team_membership',
      });
      throw new TrustBoundaryError('Strict trust policy requires persisted team membership before writing team-scoped memory');
    }
  }

  const { db, schema } = await getDbClient();
  const raw = (db as any).$client;
  const postgresSchema = Boolean(schema.knowledgeAuditLog);
  const nativeDb = postgresSchema ? await getDb() : null;
  const reviewedCompactionSource = options.reviewedCompactionSource;
  if (reviewedCompactionSource && postgresSchema
    && typeof (nativeDb as { transaction?: unknown } | null)?.transaction !== 'function') {
    throw new Error('Reviewed compaction requires a transaction-capable database');
  }
  if (reviewedCompactionSource && !postgresSchema && (!raw?.prepare || typeof raw.exec !== 'function')) {
    throw new Error('Reviewed compaction requires an atomic SQLite database');
  }
  const markReviewedCompactionSource = async (executor: DrizzleExecutor, targetId: string): Promise<void> => {
    if (!reviewedCompactionSource) return;
    const source = reviewedCompactionSource;
    const scopeConditions = [
      eq(schema.memories.id, source.id),
      eq(schema.memories.content, source.content),
      source.projectId === null ? isNull(schema.memories.projectId) : eq(schema.memories.projectId, source.projectId),
      source.userId === null ? isNull(schema.memories.userId) : eq(schema.memories.userId, source.userId),
      eq(schema.memories.type, source.type),
      eq(schema.memories.status, 'active'),
      eq(schema.memories.isActive, true),
      eq(schema.memories.isConsolidated, false),
      eq(schema.memories.isProtected, false),
      eq(schema.memories.isPinned, false),
      eq(schema.memories.hasSecrets, false),
      isNull(schema.memories.teamId),
    ];
    const updated = await executor.update(schema.memories).set({
      isConsolidated: true,
      consolidatedInto: targetId,
      consolidatedAt: new Date(),
    }).where(and(...scopeConditions)).returning({ id: schema.memories.id });
    if (updated.length === 1) return;

    const [existing] = await executor.select({
      id: schema.memories.id,
      content: schema.memories.content,
      projectId: schema.memories.projectId,
      userId: schema.memories.userId,
      type: schema.memories.type,
      teamId: schema.memories.teamId,
      isConsolidated: schema.memories.isConsolidated,
      consolidatedInto: schema.memories.consolidatedInto,
    }).from(schema.memories).where(eq(schema.memories.id, source.id)).limit(1);
    if (existing?.content === source.content
      && (existing.projectId ?? null) === source.projectId
      && (existing.userId ?? null) === source.userId
      && existing.type === source.type
      && existing.teamId == null
      && existing.isConsolidated === true
      && existing.consolidatedInto === targetId) return;

    throw new Error('The reviewed compaction source changed or became ineligible; no new memory was committed.');
  };
  const repairExistingReviewedCompactionLink = async (targetId: string): Promise<void> => {
    if (!reviewedCompactionSource) return;
    if (postgresSchema) {
      const transactionDb = nativeDb as { transaction: (callback: (tx: DrizzleExecutor) => Promise<void>) => Promise<void> };
      await transactionDb.transaction(async (tx) => markReviewedCompactionSource(tx, targetId));
      return;
    }
    raw.exec('BEGIN IMMEDIATE');
    try {
      await markReviewedCompactionSource(db, targetId);
      raw.exec('COMMIT');
    } catch (error) {
      try { raw.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };
  try {
    assertStrictMemoryWriteAtomicity(postgresSchema ? nativeDb : raw);
  } catch (error) {
    if (isStrictTrustPolicy()) {
      await writeTrustAudit({
        actorId: accessUser ?? 'unbound',
        resourceId: 'memory-write',
        assetType: 'memory',
        decision: 'deny',
        reason: 'strict_surface',
      });
    }
    throw error;
  }
  if (postgresSchema && strictPromotion && (!strictPromotion.source.ownerId || strictPromotion.source.id !== strictPromotion.auditEvent.targetId)) {
    throw new TrustBoundaryError('Strict PostgreSQL promotion requires an owner-bound source and matching audit target');
  }
  const clientEncryptionEnabled = config.clientEncryptionEnabled;
  if (clientEncryptionEnabled && isStrictTrustPolicy() && postgresSchema) {
    try {
      await writeTrustAudit({
        actorId: accessUser ?? 'unbound',
        resourceId: 'memory-write',
        assetType: 'memory',
        decision: 'deny',
        reason: 'strict_surface',
      });
    } catch {
      throw new TrustBoundaryError('Strict PostgreSQL encrypted capture is denied and its denial audit could not be persisted');
    }
    throw new TrustBoundaryError('Strict client-encrypted capture is supported only by SQLite');
  }
  const encryptedSessionCapture = clientEncryptionEnabled && isEncryptedSessionChunkCapture(input);
  if (encryptedSessionCapture && postgresSchema) {
    throw new TrustBoundaryError('Encrypted host-session capture currently requires SQLite');
  }
  const tags = clientEncryptionEnabled ? [] : normalizeTags(input.tags);
  const sessionEpisodeCapture = encryptedSessionCapture || (!clientEncryptionEnabled && isSessionEpisodeCapture(input, tags));
  const enqueueAnalysis = !sessionEpisodeCapture && (!options.hostTranscript || options.hostTranscript.role === 'user');
  const project = input.project ? await getOrCreateProject(input.project) : null;
  if (input.captureKey !== undefined) {
    if (clientEncryptionEnabled && !encryptedSessionCapture) {
      throw new Error('Encrypted idempotency keys are supported only for validated host-session chunks');
    }
    if (!postgresSchema && (!raw?.prepare || typeof raw.exec !== 'function')) {
      throw new Error('Idempotent host capture requires a transactional database backend');
    }
    if (typeof input.captureKey !== 'string' || input.captureKey.trim().length === 0 || input.captureKey.length > 1024) {
      throw new Error('Capture key must be a non-empty string of at most 1024 characters');
    }
  }
  let persistedOwnerId: string | null = null;
  if (accessUser && schema.users) {
    try {
      persistedOwnerId = (await getOrCreateUser(accessUser, db, schema))?.id ?? null;
    } catch (error) {
      if (isStrictTrustPolicy()) throw new TrustBoundaryError('Strict trust could not resolve the persisted memory owner');
      logger.warn('[User] Failed to resolve memory owner:', { error: String(error) });
    }
  }
  if (isStrictTrustPolicy() && !persistedOwnerId) {
    throw new TrustBoundaryError('Strict trust requires a persisted memory owner before signing');
  }
  const id = randomUUID();
  const privateIndexRequests: Array<{ key: string; namespace: string; value: string }> = [];
  if (clientEncryptionEnabled && input.captureKey !== undefined) {
    privateIndexRequests.push(
      { key: 'captureKeyHash', namespace: 'capture-key', value: input.captureKey.trim() },
      { key: 'captureContentHash', namespace: 'capture-content', value: input.content },
    );
  }
  if (encryptedSessionCapture) {
    const scope = JSON.stringify([input.sessionId, id, project?.id ?? null, persistedOwnerId, input.teamId ?? null]);
    privateIndexRequests.push(
      { key: 'privateSessionToken', namespace: 'session-id', value: input.sessionId! },
      { key: 'privateSessionRecordMac', namespace: 'session-row', value: scope },
    );
  }
  const privatePayload = clientEncryptionEnabled ? encryptWithPrivateIndex(input.content, privateIndexRequests) : null;
  const encryptedPayload = privatePayload ? { ciphertext: privatePayload.ciphertext, nonce: privatePayload.nonce } : null;
  const captureKeyHash = input.captureKey === undefined
    ? null
    : clientEncryptionEnabled
      ? privatePayload?.tokens.captureKeyHash ?? null
      : createHash('sha256').update(input.captureKey.trim()).digest('hex');
  const captureContentHash = captureKeyHash === null
    ? null
    : clientEncryptionEnabled
      ? privatePayload?.tokens.captureContentHash ?? null
      : createHash('sha256').update(input.content).digest('hex');
  const privateSessionIndex = encryptedSessionCapture
    ? {
      sessionToken: privatePayload?.tokens.privateSessionToken,
      recordMac: privatePayload?.tokens.privateSessionRecordMac,
    }
    : null;
  if (privateSessionIndex && (!privateSessionIndex.sessionToken || !privateSessionIndex.recordMac)) {
    throw new TrustBoundaryError('Encrypted session capture could not derive its private identity index');
  }
  if (captureKeyHash && captureContentHash) {
    const existing = await findCaptureReceipt(db, schema, raw, postgresSchema, captureKeyHash);
    if (existing) {
      if (!captureReceiptMatches(existing, captureContentHash, project?.id ?? null, persistedOwnerId, input.teamId ?? null)) {
        throw new Error('Capture key was already used for different content or memory scope');
      }
      await repairExistingReviewedCompactionLink(existing.memoryId);
      return await loadCaptureReplayMemory(existing.memoryId, accessUser);
    }
  }
  // Encrypted content must not be sent to an embedding provider or indexed
  // through a plaintext-derived representation.
  const enriched = clientEncryptionEnabled
    ? { enriched: '' }
    : enrichContent(input.content, { type: input.type, project: input.project, tags });
  const embedding = clientEncryptionEnabled ? null : await getEmbedding(enriched.enriched);
  const signals = clientEncryptionEnabled
    ? {
      explicitTriggers: [],
      implicit: { decision: false, correction: false, preference: false, workflowRule: false, lesson: false,
        note: false, important: false, hack: false, why: false, todo: false, fixme: false },
      suggestedType: input.type ?? 'note', priority: 'normal', confidence: 'certain',
    } as ReturnType<typeof detectMemorySignals>
    : detectMemorySignals(input.content);
  const type = input.type ?? signals.suggestedType;
  // Batch 6b: route sector once from signals (type + tags + content + provenance).
  // An explicit input.sector override wins; default episodic.
  const now = new Date();
  const sector = clientEncryptionEnabled ? 'episodic' : routeSector(
    {
      type,
      tags: clientEncryptionEnabled ? [] : tags,
      content: input.content,
      knowledgeKind: 'memory',
      source: (input.metadata?.source as string | undefined) ?? input.source ?? null,
    },
    (input as { sector?: string | null }).sector ?? null
  );
  // Batch 6b: bi-temporal fields - validFrom defaults to write time unless
  // explicitly provided; recordedAt is always the write time.
  const sourceValidFrom = input.occurredAt ?? input.validFrom;
  const validFromDate = sourceValidFrom ? new Date(sourceValidFrom) : now;
  if (Number.isNaN(validFromDate.getTime())) {
    throw new Error('occurredAt/validFrom must be a valid date');
  }
  const expiresAtDate = normalizeExpiry(input.expiresAt);
  // Team-scoped memories use 'team' scope; everything else defaults to 'project'
  const visibilityScope: VisibilityScope = input.teamId ? 'team' : 'project';
  const policyRecommendation = clientEncryptionEnabled ? null : recommendMemoryScope({
    content: input.content,
    type,
    tags,
    visibilityScope,
    importanceScore: 0,
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    signals,
    teamId: input.teamId,
  });
  const memoryPolicy = clientEncryptionEnabled ? null : buildMemoryPolicy({
    content: input.content,
    type,
    tags,
    visibilityScope,
    importanceScore: 0,
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    signals,
    teamId: input.teamId,
  });
  if (memoryPolicy && policyRecommendation) memoryPolicy.recommendation = policyRecommendation;
  const readWriteScopes = buildVisibilityScopes(visibilityScope, 'user', accessUser, input.teamId);
  const serializedReadScope = serializeVisibilityScopes(readWriteScopes.readScope);
  const serializedWriteScope = serializeVisibilityScopes(readWriteScopes.writeScope);

  const baseValues = {
    id,
    projectId: project?.id ?? null,
    type,
    content: clientEncryptionEnabled ? '' : input.content,
    source: clientEncryptionEnabled ? 'client-encrypted' : input.source ?? 'mcp',
    visibilityScope,
    expiresAt: expiresAtDate,
  };

  // Calculate initial importance score (3-factor pipeline)
  const importance = clientEncryptionEnabled ? { score: 50 } : computeInitialImportance({
    content: input.content,
    type,
    createdAt: new Date().toISOString(),
    accessCount: 0,
    usageCount: 0,
    isPinned: false,
    isProtected: false,
    isImmutable: false,
  });

  // Batch 4: L2-normalized float32 blob (primary) + JSON compat + model stamp
  const embeddingValues = clientEncryptionEnabled
    ? { embedding: null, embeddingBlob: null, embeddingJson: null, embeddingModel: null, embeddingDim: null }
    : prepareEmbedding(embedding, { model: embeddingModelFor(embedding) ?? activeEmbeddingModel() });

  const tokensEstimate = estimateTokens(input.content);

  let tagsValue = serializeTags(tags);
  // Classification reasons for this write, derived from the signals already
  // computed above: explicit trigger labels plus the implicit flags that fired.
  const signalReasons: string[] = [
    ...signals.explicitTriggers,
    ...Object.entries(signals.implicit)
      .filter(([, value]) => value === true)
      .map(([key]) => `implicit:${key}`),
  ];
  const enrichedMetadata: Record<string, unknown> = clientEncryptionEnabled ? {
    sourceMemoryId: id,
    encrypted: true,
  } : {
    ...Object.fromEntries(Object.entries(input.metadata ?? {}).filter(([key]) => key !== 'hostTranscript' && key !== 'sourceTimeZone')),
    ...(sourceTimeZone ? { sourceTimeZone } : {}),
    ...(options.hostTranscript ? { hostTranscript: options.hostTranscript } : {}),
    // The unified knowledge row has its own ID, so retain the source memory ID
    // for idempotent migration/backfill and cross-corpus provenance.
    sourceMemoryId: id,
    // Rich context fields (Agent 4 feedback)
    reasoning: input.reasoning,
    memoryContext: input.memoryContext,
    examples: input.examples,
    exceptions: input.exceptions,
    // Signal-era classification block read by core/memory/explain.ts. Must use
    // the same key ('signal') and classification value ('durable-distilled')
    // the working-set recorder below uses, otherwise every fresh write is
    // misclassified as 'legacy-durable' (DEFECT 3). Declared after the
    // input.metadata spread, so it intentionally overwrites a caller-supplied
    // metadata.signal block (the backfill script merges instead).
    signal: {
      classification: 'durable-distilled',
      reasons: signalReasons,
      capturedAt: now.getTime(),
    },
    memorySignals: {
      explicitTriggers: signals.explicitTriggers,
      implicit: signals.implicit,
      priority: signals.priority,
      requiresConflictCheck: signals.implicit.correction,
    },
    // Session metadata for temporal queries (Task 1)
    sessionMetadata: {
      sessionId: input.sessionId,
      sessionStartTime: input.sessionStartTime,
      toolName: input.toolName,
    },
  };
  if (!clientEncryptionEnabled) enrichedMetadata.memoryPolicy = memoryPolicy;
  const provenance = signMemoryProvenance({
    content: input.content,
    projectId: project?.id ?? null,
    type: type ?? 'note',
    ownerId: persistedOwnerId,
    teamId: input.teamId ?? null,
    sourceMemoryId: id,
    metadata: enrichedMetadata,
  });
  if (isStrictTrustPolicy() && !provenance) {
    try {
      await writeTrustAudit({
        actorId: accessUser ?? 'unbound',
        resourceId: 'memory-write',
        assetType: 'memory',
        decision: 'deny',
        reason: 'strict_surface',
      });
    } catch {
      throw new TrustBoundaryError('Strict trust rejected an unsigned write and its denial audit could not be persisted');
    }
    throw new TrustBoundaryError('Strict trust policy requires SQUISH_PROVENANCE_PRIVATE_KEY and SQUISH_PROVENANCE_KEY_ID for writes');
  }
  if (provenance) enrichedMetadata.__squishProvenance = provenance;
  let metadataValue = serializeMetadata(enrichedMetadata);

  // Prepare fields for insertion, handling optional encryption
  let insertValues: any = {
    ...baseValues,
    tags: tagsValue,
    metadata: metadataValue,
    ...embeddingValues,
    importanceScore: importance.score,
    lastImportanceRecalc: new Date(),
    tokensEstimate,
    createdAt: new Date(),
    status: 'active',
    visibilityScope,
    readScope: serializedReadScope,
    writeScope: serializedWriteScope,
    // Batch 6b: routed sector + bi-temporal fields on every new memory.
    sector,
    validFrom: validFromDate,
    recordedAt: now,
    // Batch 6b: explicit working tier at birth - the column DEFAULT 'hot'
    // made fresh rows permanently decay-exempt until the first tier
    // maintenance pass. Young memories are working-tier by definition;
    // recalculateTiers promotes/demotes from there.
    tier: clientEncryptionEnabled ? 'cold' : 'working',
    // Team memory: link to team if provided
    ...(input.teamId ? { teamId: input.teamId } : {}),
  };

  if (postgresSchema) {
    let normalizedEmbedding: number[] | null = null;
    if (typeof embeddingValues.embeddingJson === 'string') {
      try {
        const parsed: unknown = JSON.parse(embeddingValues.embeddingJson);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'number' && Number.isFinite(value))) {
          normalizedEmbedding = parsed;
        }
      } catch {
        normalizedEmbedding = null;
      }
    }
    const vector = normalizedEmbedding?.length === 1536
      ? `[${normalizedEmbedding.join(',')}]`
      : null;
    insertValues = {
      ...baseValues,
      userId: persistedOwnerId ?? null,
      teamId: input.teamId ?? null,
      summary: null,
      embedding: vector,
      embeddingModel: clientEncryptionEnabled ? null : embeddingValues.embeddingModel,
      tokensEstimate: clientEncryptionEnabled ? 0 : tokensEstimate,
      confidence: importance.score,
      tags: clientEncryptionEnabled ? [] : tags,
      metadata: enrichedMetadata,
      isPrivate: false,
      relevanceScore: importance.score,
      visibilityScope,
      readScope: readWriteScopes.readScope,
      writeScope: readWriteScopes.writeScope,
      triggeredBy: input.toolName ?? null,
      captureReason: clientEncryptionEnabled ? null : input.reasoning ?? null,
      usageCount: 0,
      isActive: true,
      sector,
      tier: clientEncryptionEnabled ? 'cold' : 'hot',
      validFrom: validFromDate,
      recordedAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Add namespace if specified
  if (input.namespaceId && !postgresSchema) {
    insertValues.namespaceId = input.namespaceId;
  }

  if (persistedOwnerId) insertValues.userId = persistedOwnerId;
  if (clientEncryptionEnabled) {
    if (!encryptedPayload) throw new Error('Encrypted memory payload was not prepared');
    if (postgresSchema) {
      insertValues.encryptedContent = encryptedPayload.ciphertext;
      insertValues.encryptionNonce = encryptedPayload.nonce;
      insertValues.isEncrypted = true;
      insertValues.tags = [];
    } else {
      insertValues.encrypted_content = encryptedPayload.ciphertext;
      insertValues.encryption_nonce = encryptedPayload.nonce;
      insertValues.is_encrypted = true;
      insertValues.tags = serializeTags([]);
    }
    insertValues.content = '';
    insertValues.summary = null;
    insertValues.tokensEstimate = 0;
  } else {
    insertValues.content = input.content;
    if (!postgresSchema) insertValues.is_encrypted = false;
  }

  let knowledgeRecordId: string | null = null;

  // Every durable memory gets a knowledge projection, including globally
  // scoped memories. Project isolation is represented by projectId; NULL is
  // the shared global scope used by cross-agent recall.
  const knowledgeInput: CreateKnowledgeInput = {
    sourceMemoryId: id,
    ownerId: persistedOwnerId ?? undefined,
    teamId: input.teamId ?? undefined,
    projectId: project?.id,
    userId: insertValues.userId ?? undefined,
    sessionId: clientEncryptionEnabled ? undefined : input.sessionId ?? undefined,
    knowledgeKind: 'memory',
    knowledgeType: type,
    content: input.content,
    summary: undefined,
    confidence: importance.score / 100,
    tags,
    metadata: { ...enrichedMetadata },
    sector,
    tier: importance.score >= 70 ? 'hot' : 'cold',
    validFrom: validFromDate,
    recordedAt: now,
  };

  try {
  let promotionAclDenyReason: 'acl_rule' | 'private_default' | null = null;
  await withBusyRetry(async () => {
    if (postgresSchema) {
      const transactionDb = nativeDb as { transaction?: (callback: (tx: DrizzleExecutor) => Promise<void>) => Promise<void> } | null;
      if (!transactionDb || typeof transactionDb.transaction !== 'function') {
        throw new Error('PostgreSQL memory capture requires a Drizzle transaction-capable database');
      }
      await transactionDb.transaction(async (tx) => {
        let inheritedPromotionExpiry: Date | null = null;
        if (strictPromotion) {
          const authorization = strictPromotion.requiredTeamRole;
          if (authorization) {
            const [membership] = await tx.select({ role: schema.team_members.role })
              .from(schema.team_members)
              .where(and(
                eq(schema.team_members.teamId, authorization.teamId),
                eq(schema.team_members.userId, authorization.persistedUserId),
              ))
              .limit(1);
            if (!membership || !authorization.roles.includes(membership.role as 'owner' | 'admin')) {
              throw new TrustBoundaryError('Team role was revoked before promotion could commit');
            }
          }
          const { memories: memoryTable } = schema;
          const [source] = await tx.select().from(memoryTable).where(eq(memoryTable.id, strictPromotion.source.id)).for('update');
          const sourceMetadata = source?.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
            ? source.metadata as Record<string, unknown>
            : {};
          const persistedExpiry = source?.expiresAt == null ? null : source.expiresAt.getTime();
          const expectedExpiry = strictPromotion.source.expiresAt == null ? null : strictPromotion.source.expiresAt.getTime();
          const sourceValid = Boolean(source) && source!.content === strictPromotion.source.content &&
            source!.projectId === strictPromotion.source.projectId && source!.type === strictPromotion.source.type &&
            source!.userId === strictPromotion.source.ownerId && source!.teamId === null &&
            source!.status === 'active' && source!.isActive === true &&
            (strictPromotion.source.expiresAt === undefined || persistedExpiry === expectedExpiry) &&
            (!source!.expiresAt || source!.expiresAt.getTime() > Date.now()) &&
            verifyMemoryProvenance({
              content: source!.content,
              projectId: source!.projectId,
              type: source!.type,
              ownerId: source!.userId,
              teamId: source!.teamId,
              sourceMemoryId: typeof sourceMetadata.sourceMemoryId === 'string' ? sourceMetadata.sourceMemoryId : source!.id,
              metadata: sourceMetadata,
            });
          if (!sourceValid) throw new TrustBoundaryError('Promotion source changed or became ineligible before commit');
          if (input.expiresAt === undefined) inheritedPromotionExpiry = source!.expiresAt ?? null;
        }
        await tx.insert(schema.memories).values(insertValues);
        if (captureKeyHash && captureContentHash) {
          const [insertedReceipt] = await tx.insert(schema.memoryCaptureReceipts).values({
            captureKeyHash,
            contentHash: captureContentHash,
            memoryId: id,
          }).onConflictDoNothing({ target: schema.memoryCaptureReceipts.captureKeyHash })
            .returning({ captureKeyHash: schema.memoryCaptureReceipts.captureKeyHash });
          if (!insertedReceipt) {
            const existing = await findCaptureReceipt(tx, schema, raw, true, captureKeyHash);
            if (captureReceiptMatches(existing, captureContentHash, project?.id ?? null, persistedOwnerId, input.teamId ?? null)) {
              throw new ExistingCaptureReceipt(existing.memoryId);
            }
            throw new Error('Capture key was already used for different content or memory scope');
          }
        }
        if (inheritedPromotionExpiry) {
          await tx.update(schema.memories).set({ expiresAt: inheritedPromotionExpiry }).where(eq(schema.memories.id, id));
        }
        if (project?.id && !clientEncryptionEnabled && enqueueAnalysis) {
          await tx.insert(schema.memoryAnalysisJobs).values({
            id: randomUUID(),
            sourceMemoryId: id,
            projectId: project.id,
            jobKind: 'analyze_memory',
            status: 'pending',
          });
        }
        const projection = await createKnowledge(knowledgeInput, tx);
        knowledgeRecordId = projection.id;
        await markReviewedCompactionSource(tx, id);
        if (strictPromotion) await writeTeamAuditEvent(strictPromotion.auditEvent, tx);
      });
    } else if (raw && typeof raw.exec === 'function') {
      // Source, analysis job, projection, and any strict promotion audit share
      // one SQLite transaction so a failed projection cannot leave half a write.
      raw.exec('BEGIN IMMEDIATE');
      try {
        promotionAclDenyReason = null;
        const authorization = strictPromotion?.requiredTeamRole;
        if (authorization) {
          const membership = raw.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ?`)
            .get(authorization.teamId, authorization.persistedUserId) as { role: string } | undefined;
          if (!membership || !authorization.roles.includes(membership.role as 'owner' | 'admin')) {
            throw new TrustBoundaryError('Team role was revoked before promotion could commit');
          }
        }
        if (strictPromotion && accessUser
          && !await preauthorizeStrictMemoryReadBeforeDecrypt(strictPromotion.source.id, accessUser)) {
          const hasVisibilityRules = raw.prepare(`SELECT 1 FROM visibility_rules
            WHERE asset_type = 'memory' AND asset_id = ? LIMIT 1`).get(strictPromotion.source.id);
          promotionAclDenyReason = hasVisibilityRules ? 'acl_rule' : 'private_default';
          throw new TrustBoundaryError('Promotion source is no longer readable by the caller');
        }
        await db.insert(schema.memories).values(insertValues);
        if (captureKeyHash && captureContentHash) {
          const receipt = raw.prepare(`INSERT INTO memory_capture_receipts (capture_key_hash, content_hash, memory_id)
            VALUES (?, ?, ?) ON CONFLICT(capture_key_hash) DO NOTHING`).run(captureKeyHash, captureContentHash, id);
          if (receipt.changes !== 1) {
            const existing = raw.prepare(`SELECT r.memory_id, r.content_hash, m.project_id, m.user_id, m.team_id
              FROM memory_capture_receipts r JOIN memories m ON m.id = r.memory_id WHERE r.capture_key_hash = ?`)
              .get(captureKeyHash) as { memory_id: string; content_hash: string; project_id: string | null; user_id: string | null; team_id: string | null } | undefined;
            if (existing && existing.content_hash === captureContentHash && existing.project_id === (project?.id ?? null)
              && existing.user_id === persistedOwnerId && existing.team_id === (input.teamId ?? null)) {
              throw new ExistingCaptureReceipt(existing.memory_id);
            }
            throw new Error('Capture key was already used for different content or memory scope');
          }
        }
        if (privateSessionIndex) {
          raw.prepare(`INSERT INTO memory_private_session_index
            (session_token, memory_id, project_id, user_id, team_id, record_mac)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(privateSessionIndex.sessionToken, id, project?.id ?? null, persistedOwnerId, input.teamId ?? null,
              privateSessionIndex.recordMac);
        }
        if (project?.id && !clientEncryptionEnabled && enqueueAnalysis) {
          await db.insert(schema.memoryAnalysisJobs).values({
            id: randomUUID(),
            sourceMemoryId: id,
            projectId: project.id,
            jobKind: 'analyze_memory',
            status: 'pending',
          });
        }
        const projection = await createKnowledge(knowledgeInput);
        knowledgeRecordId = projection.id;
        await markReviewedCompactionSource(db, id);
        if (strictPromotion) {
          const source = raw.prepare(`SELECT id, project_id, user_id, team_id, type, content,
            encrypted_content, encryption_nonce, is_encrypted, metadata, status, is_active,
            valid_from, valid_to, expires_at
            FROM memories WHERE id = ?`).get(strictPromotion.source.id) as {
              id: string; project_id: string | null; user_id: string | null; team_id: string | null;
              type: string; content: string; encrypted_content: string | null; encryption_nonce: string | null;
              is_encrypted: number | null; metadata: string | Record<string, unknown> | null;
              status: string | null; is_active: number | null;
              valid_from: number | null; valid_to: number | null; expires_at: number | null;
            } | undefined;
          const nowMs = Date.now();
          const sourceValidFrom = normalizeTimestampValue(source?.valid_from);
          const sourceValidTo = normalizeTimestampValue(source?.valid_to);
          const sourceExpiry = normalizeTimestampValue(source?.expires_at);
          const sourceTemporalStateValid = Boolean(source)
            && (source!.valid_from == null || sourceValidFrom !== null)
            && (source!.valid_to == null || sourceValidTo !== null)
            && (source!.expires_at == null || sourceExpiry !== null)
            && (sourceValidFrom === null || sourceValidFrom <= nowMs)
            && (sourceValidTo === null || sourceValidTo > nowMs)
            && (sourceExpiry === null || sourceExpiry > nowMs);
          let sourceMetadata: Record<string, unknown> = {};
          try {
            const parsed: unknown = typeof source?.metadata === 'string'
              ? JSON.parse(source.metadata)
              : source?.metadata;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              sourceMetadata = parsed as Record<string, unknown>;
            }
          } catch {
            throw new TrustBoundaryError('Promotion source metadata changed before commit');
          }
          let sourceContent = source?.content;
          if (source?.is_encrypted) {
            if (!source.encrypted_content || !source.encryption_nonce) {
              throw new TrustBoundaryError('Promotion source could not be verified before commit');
            }
            try {
              sourceContent = decrypt(source.encrypted_content, source.encryption_nonce);
            } catch {
              throw new TrustBoundaryError('Promotion source could not be verified before commit');
            }
          }
          const unchangedAndVerified = Boolean(source) &&
            source!.id === strictPromotion.source.id &&
            sourceContent === strictPromotion.source.content &&
            source!.project_id === strictPromotion.source.projectId &&
            source!.type === strictPromotion.source.type &&
            source!.user_id === strictPromotion.source.ownerId &&
            source!.team_id === null &&
            source!.status === 'active' &&
            source!.is_active === 1 &&
            sourceTemporalStateValid &&
            (strictPromotion.source.expiresAt === undefined || sourceExpiry === (strictPromotion.source.expiresAt?.getTime() ?? null)) &&
            verifyMemoryProvenance({
              content: sourceContent ?? '',
              projectId: source!.project_id,
              type: source!.type,
              ownerId: source!.user_id,
              teamId: source!.team_id,
              sourceMemoryId: typeof sourceMetadata.sourceMemoryId === 'string'
                ? sourceMetadata.sourceMemoryId
                : source!.id,
              metadata: sourceMetadata,
            });
          if (!unchangedAndVerified) {
            throw new TrustBoundaryError('Promotion source changed or became ineligible before commit');
          }
          if (input.expiresAt === undefined && source!.expires_at !== null) {
            raw.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(source!.expires_at, id);
          }
          await writeTeamAuditEvent(strictPromotion.auditEvent);
        }
        raw.exec('COMMIT');
      } catch (error) {
        try { raw.exec('ROLLBACK'); } catch {}
        if (promotionAclDenyReason && strictPromotion && accessUser) {
          try {
            await writeTrustAudit({
              actorId: accessUser,
              resourceId: strictPromotion.source.id,
              assetType: 'memory',
              decision: 'deny',
              reason: promotionAclDenyReason,
            });
          } catch {
            throw new TrustBoundaryError('Promotion source ACL denial could not be audited');
          }
        }
        throw error;
      }
    } else {
      if (reviewedCompactionSource) {
        throw new Error('Reviewed compaction cannot commit without an atomic database transaction');
      }
      await db.insert(schema.memories).values(insertValues);
      if (project?.id && !clientEncryptionEnabled && enqueueAnalysis) {
        await db.insert(schema.memoryAnalysisJobs).values({
          id: randomUUID(),
          sourceMemoryId: id,
          projectId: project.id,
          jobKind: 'analyze_memory',
          status: 'pending',
        });
      }
      knowledgeRecordId = (await createKnowledge(knowledgeInput)).id;
    }
  }, { label: 'rememberMemory.insert' });
  } catch (error) {
    if (error instanceof ExistingCaptureReceipt) {
      await repairExistingReviewedCompactionLink(error.memoryId);
      return await loadCaptureReplayMemory(error.memoryId, accessUser);
    }
    throw error;
  }

  if (!knowledgeRecordId) throw new Error(`Failed to create canonical memory projection for ${id}`);
  logger.debug(`[Knowledge] Stored memory ${id} in knowledge table`);

  const procedureOutcome = enrichedMetadata.procedureOutcome as {
    procedureKey?: string; result?: 'success' | 'failure'; evidenceId?: string;
  } | undefined;
  const procedureSourceId = typeof enrichedMetadata.sourceId === 'string' ? enrichedMetadata.sourceId.trim() : '';
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && procedureSourceId && procedureOutcome?.procedureKey && procedureOutcome.result && procedureOutcome.evidenceId) {
    try {
      const { linkConflictingProcedureOutcomes } = await import('./procedure-outcomes.js');
      await linkConflictingProcedureOutcomes({
        knowledgeId: knowledgeRecordId,
        projectId: project?.id ?? null,
        userId: insertValues.userId ?? null,
        teamId: insertValues.teamId ?? null,
        outcome: {
          procedureKey: procedureOutcome.procedureKey,
          result: procedureOutcome.result,
          evidenceId: procedureOutcome.evidenceId,
          sourceId: procedureSourceId,
        },
      });
    } catch (error) {
      logger.warn(`[Memory] Could not link conflicting procedure outcomes for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Build graph for this memory (auto-build if enabled). The sync now projects
  // the knowledge edge after extraction, when newly discovered entities exist.
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && config.graphAutoBuild && project?.id) {
     try {
       const syncResult = await onMemoryStored(id, {
         project: input.project,
         knowledgeRecordId: knowledgeRecordId ?? undefined,
       });
       if (knowledgeRecordId) {
         logger.debug(`[Graph] Synced memory ${id}: ${syncResult.entitiesCreated} entities, ${syncResult.relationsCreated} relations${syncResult.dedupRan ? ' (dedup ran)' : ''}`);
       }
     } catch (graphError) {
       logger.debug(`[Graph] Failed to sync memory ${id}: ${graphError}`);
     }
  }

   // Mental-model refresh is fire-and-forget and internally catches failures;
   // it must never add latency or failure modes to the durable memory write.
   if (!clientEncryptionEnabled && !isStrictTrustPolicy() && config.llmEnabled && project?.id) scheduleMentalModelRefresh(project.id);

  // Sync to QMD if enabled (async, don't block)

  // Place APIs have no caller-scoped authorization contract under strict
  // trust. Skip the automatic path instead of generating routine denial
  // audits for every valid strict capture.
  if (!clientEncryptionEnabled && !isStrictTrustPolicy()) await assignMemoryToDefaultPlace(id, project?.id, input.placeType || null, {
    tags: input.tags,
    content: input.content,
    toolName: input.toolName,
    memoryType: type,
  });

  // Create knowledge_edge from knowledge record to primary place
  // This bridges the knowledge table with the place system so that
  // getConnectedPlaces() can traverse cross-system relationships.
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && knowledgeRecordId) {
    try {
      const db = await getDb();
      const schema = await getSchema();
      const [memoryRow] = await (db as any).select({ placeId: schema.memories.placeId })
        .from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
      if (memoryRow?.placeId) {
        await createKnowledgeEdge({
          fromId: knowledgeRecordId,
          fromKind: 'knowledge',
          toId: memoryRow.place_id,
          toKind: 'place',
          edgeType: 'located_in',
        });
      }
    } catch (placeEdgeError) {
      logger.debug(`[Knowledge] Failed to create place edge: ${placeEdgeError}`);
    }
  }

  // Store tags in memory_tags indexed table (v1.5.0)
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && tags.length > 0) {
    try {
      const { storeMemoryTags } = await import('../places/memory-places.js');
      await storeMemoryTags(id, tags, 'heuristic');
    } catch (tagErr) {
      logger.debug(`Failed to store memory tags: ${tagErr}`);
    }
  }

  // Post-capture geometry check (non-blocking, fire-and-forget)
  // Evaluates whether the new memory's cluster is safe to consolidate
  const embeddingForGeo = parseEmbedding(embedding);
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && config.consolidationGeometryAutoConsolidate && embeddingForGeo && embeddingForGeo.length > 0) {
    evaluateAndConsolidate(id, embeddingForGeo, embeddingValues.embeddingModel ?? null).catch((err: Error) =>
      logger.debug('Post-capture geometry check failed', err)
    );
  }

  // WS2a: write-time near-duplicate stage. Runs after the store (and after
  // the contradiction-resolution dispatch above). SQUISH_WRITE_DEDUP default
  // 'off' short-circuits the getter here, so the shipped write path performs
  // no extra reads/writes at all. 'link' adds bidirectional near_duplicate
  // associations + metadata.dedup (non-destructive); 'merge' (explicit
  // opt-in) reuses the existing reversible approve-merge machinery.
  // Best-effort: a stage failure is logged, never propagated.
  if (!clientEncryptionEnabled && !isStrictTrustPolicy() && config.writeDedupMode !== 'off') {
    try {
      const dedupOutcome = await runWriteDedupStage({
        memoryId: id,
        content: input.content,
        projectId: project?.id ?? null,
        projectPath: input.project ?? null,
        teamId: input.teamId ?? null,
      });
      if (dedupOutcome) {
        // Reflect the detection in the returned record too. The stored row is
        // already updated by the stage's own read-modify-write
        // (recordDedupMetadata); re-serializing insertValues' local
        // metadataValue here was dead code after the INSERT captured it.
        enrichedMetadata.dedup = dedupOutcome;
      }
    } catch (dedupErr) {
      logger.debug(`[WriteDedup] stage failed for memory ${id}: ${dedupErr}`);
    }
  }

  const memoryRecord: MemoryRecord = {
  id,
  projectId: project?.id ?? null,
  type,
  content: input.content,
  tags,
  metadata: enrichedMetadata,
  visibilityScope,
  importance: importance.score as number,
  // Return the temporal values written above so callers (including the SDK)
  // can immediately reason about delayed imports without re-reading storage.
  validFrom: validFromDate.toISOString(),
  validTo: null,
  recordedAt: now.toISOString(),
};

  // Batch 7: every squish_remember write is project activity - feed the
  // session working set so wake-up summaries reflect real usage. Awaited
  // (not fire-and-forget) because short-lived CLI processes exit before
  // dangling promises resolve; best-effort, never fails the write.
  // Batch 7 review (M-2): these signals land in the dedicated
  // `memory-write:<project>` pseudo-session and are tagged kind='memory-
  // write' so harness-parsed sessions win wake-up selection.
  if (!clientEncryptionEnabled && input.project && !isStrictTrustPolicy()) {
    try {
      await recordSessionSignal({
        sessionId: input.sessionId ?? `memory-write:${input.project}`,
        projectPath: input.project,
        classification: 'durable-distilled',
        distilledContent: input.content.slice(0, 200),
        toolName: 'squish_remember',
        metadata: {
          activeFiles: extractFilePathSignals(input.content).slice(0, 4),
          kind: input.sessionId ? undefined : 'memory-write',
        },
      });
    } catch {
      /* working-set is best effort */
    }
  }

  // The legacy event carries raw content but has no principal/ACL contract.
  if (!clientEncryptionEnabled && !isStrictTrustPolicy()) {
    emit({
      type: 'memory:stored',
      payload: {
        memoryId: id,
        content: input.content,
        type: type ?? 'note',
        project: input.project,
      },
    });
  }

  // SQLite transactions are connection-scoped. Finish supersession before
  // returning so the next sequential memory write cannot begin while this
  // write's resolver still owns a transaction on the shared connection.
  // PostgreSQL and strict-trust paths remain disabled until their scoped
  // lifecycle contracts are implemented.
  if (!clientEncryptionEnabled && !postgresSchema && !isStrictTrustPolicy()
    && !procedureOutcome && process.env.SQUISH_SKIP_CONTRADICTION !== 'true') {
    try {
      const result = await resolveContradictions(
        input.content, type, project?.id ?? undefined, id, insertValues.createdAt as string,
      );
      if (result.supersededIds.length > 0) {
        await applySupersession(id, result.supersededIds, result.confidence, result.associationType);
      }
    } catch (error) {
      logger.debug(`Contradiction resolution failed: ${error}`);
    }
  }

  return memoryRecord;
}

// ---------------------------------------------------------------------------
// Internal helpers — place assignment & geometry
// ---------------------------------------------------------------------------

/**
 * Extract file path signals from free-form text.
 * Only matches realistic file paths (min 2 segments, each >=2 chars, with extension or common dir patterns).
 * Used by remember-writes to contribute "files touched" signals to the working set.
 */
function extractFilePathSignals(text: string): string[] {
  if (!text) return [];
  // Require: segment/segment with optional subdirectories
  // Each segment: min 2 chars, alphanumeric + hyphens + dots + underscores
  // Optional file extension at end
  const matches = text.match(
    /(?:^|[\s`'"@(,;]|^)([A-Za-z][A-Za-z0-9_-]{1,30}(?:\/[A-Za-z][A-Za-z0-9_._-]{1,30}){1,5}(?:\.[a-zA-Z]{1,10})?)(?:[\s`'"@),;]|$)/g
  );
  if (!matches) return [];
  const seen = new Set<string>();
  for (const m of matches) {
    // Trim whitespace and surrounding chars
    const cleaned = m.replace(/^[\s`'"@(,;]+|[\s`'"@),;]+$/g, '').trim();
    if (cleaned && cleaned.length >= 4) {
      seen.add(cleaned);
      if (seen.size >= 8) break;
    }
  }
  return [...seen];
}

/**
 * Post-capture geometry check and auto-consolidation.
 *
 * Non-blocking fire-and-forget function called after a new memory is stored.
 * Adds the memory to its nearest cluster, updates cluster stats, and
 * evaluates whether the cluster is safe to consolidate.
 *
 * If safe and autoConsolidate is enabled: triggers consolidation.
 * If unsafe and autoSplit is enabled: logs a split recommendation.
 *
 * @param memoryId - ID of the newly created memory
 * @param embedding - Embedding vector of the new memory
 */
async function evaluateAndConsolidate(
  memoryId: string,
  embedding: number[],
  embeddingModel: string | null,
): Promise<void> {
  try {
    // Find or create the nearest cluster for this memory
    const clusterId = await findOrCreateCluster(memoryId, embedding, undefined, embeddingModel);

    // Update cluster geometry stats (centroid, d_bar, d_eff, etc.)
    await updateClusterStats(clusterId);

    // Evaluate whether the cluster is safe to compress
    const decision = await evaluateCluster(clusterId);

    if (decision.safeToCompress && config.consolidationGeometryAutoConsolidate) {
      logger.debug(`Post-capture: cluster ${clusterId} is safe to consolidate ` +
        `(d_bar=${decision.dBar.toFixed(4)}, d_eff=${decision.dEff.toFixed(2)})`);
      // Note: actual consolidation happens in the consolidation engine run.
      // This check just logs readiness; the engine will pick it up.
    } else if (!decision.safeToCompress && config.consolidationGeometryAutoSplit) {
      logger.debug(`Post-capture: cluster ${clusterId} may need splitting ` +
        `(d_bar=${decision.dBar.toFixed(4)}, d_eff=${decision.dEff.toFixed(2)})`);
    }
  } catch (err) {
    // Non-blocking: never fail the memory write
    logger.debug('evaluateAndConsolidate error', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Auto-assign a memory to the global Inbox place by default.
 * Uses global project scope if no projectId provided.
 */
// Scope-aware place initialization cache keyed by global/project scope.
const _cachedPlaceInit = new Map<string, { inboxId: string }>();

async function ensurePlacesInitialized(projectId?: string | null): Promise<{ inboxId: string } | null> {
  const cacheKey = projectId ?? '__global__';
  const cached = _cachedPlaceInit.get(cacheKey);
  if (cached) {
    try {
      const { getPlace } = await import('../places/places.js');
      const existing = await getPlace(cached.inboxId);
      if (existing) return cached;
      _cachedPlaceInit.delete(cacheKey);
    } catch {
      _cachedPlaceInit.delete(cacheKey);
    }
  }
  try {
    const { initializeDefaultPlaces } = await import('../places/places.js');
    const places = await initializeDefaultPlaces(projectId ?? undefined);
    const inboxPlace = places.find(p => p.placeType === 'inbox');
    if (!inboxPlace) return null;
    const init = { inboxId: inboxPlace.id };
    _cachedPlaceInit.set(cacheKey, init);
    return init;
  } catch {
    return null;
  }
}

async function assignMemoryToDefaultPlace(
  memoryId: string, 
  projectId?: string | null, 
  placeType?: string | null,
  options?: {
    tags?: string[];
    content?: string;
    toolName?: string;
    memoryType?: string;
  }
): Promise<void> {
  try {
    const init = await ensurePlacesInitialized(projectId);
    if (!init) return;

    const { ensureGlobalProject } = await import('../places/places.js');
    const resolvedPlaceProjectId = projectId ?? (await ensureGlobalProject()).id;

    // Use findMatchingPlaces() to get ranked candidates
    const { findMatchingPlaces } = await import('../places/rules.js');
    const candidates = await findMatchingPlaces(projectId ?? undefined, {
      toolName: options?.toolName,
      content: options?.content,
      tags: options?.tags,
      memoryType: options?.memoryType,
    });

    // If placeType was explicitly specified and is not the top candidate,
    // make sure it appears as a candidate
    if (placeType && candidates.length > 0 && candidates[0].type !== placeType) {
      // Add explicit placeType as first candidate
      candidates.unshift({
        type: placeType as any,
        weight: 1.0,
        reason: 'explicitly specified',
        source: 'manual',
      });
    } else if (placeType && candidates.length === 0) {
      candidates.push({
        type: placeType as any,
        weight: 1.0,
        reason: 'explicitly specified',
        source: 'manual',
      });
    }

    // Fallback to inbox if no candidates matched
    if (candidates.length === 0) {
      candidates.push({
        type: 'inbox' as any,
        weight: 1.0,
        reason: 'default fallback',
        source: 'heuristic',
      });
    }

    // Store candidates via memory-places module (no-op: memory_places deprecated in v2.0.0)
    const { assignMemoryToPlaces } = await import('../places/memory-places.js');
    await assignMemoryToPlaces(memoryId, candidates, resolvedPlaceProjectId);

    // Set primaryPlace and place_id (legacy alias) on the memory record
    const primaryPlace = candidates[0]?.type ?? placeType ?? 'inbox';
    const client = ((await getDb()) as any).$client || (await getDb());
    try {
      // Resolve placeType to placeId for legacy place_id column
      const placeRow = client.prepare(
        'SELECT id FROM places WHERE project_id = ? AND place_type = ? LIMIT 1'
      ).get(resolvedPlaceProjectId, primaryPlace) as { id: string } | undefined;
      const placeId = placeRow?.id ?? null;

      if (placeId) {
        const stmt = client.prepare(
          'UPDATE memories SET primary_place = ?, place_id = ? WHERE id = ?'
        );
        await withBusyRetry(() => stmt.run(primaryPlace, placeId, memoryId), {
          label: 'placeAssignment.updateWithPlaceId',
        });
      } else {
        const stmt = client.prepare(
          'UPDATE memories SET primary_place = ? WHERE id = ?'
        );
        await withBusyRetry(() => stmt.run(primaryPlace, memoryId), {
          label: 'placeAssignment.update',
        });
      }
    } catch {
      // Fallback to drizzle
      try {
        const sqliteDb = (await getDb()) as any;
        const schemaModule = await getSchema();
        await sqliteDb.update(schemaModule.memories)
          .set({ primaryPlace })
          .where(eq(schemaModule.memories.id, memoryId));
      } catch {
        // Ignore
      }
    }
  } catch (err) {
    // Non-blocking: never fail the memory write
    logger.debug(`assignMemoryToDefaultPlace error: ${err}`);
  }
}
