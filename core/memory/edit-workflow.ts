/**
 * Edit Proposal Workflow - staged content edits for memories.
 *
 * Agents (the only operators - Squish is a passive memory runtime) propose
 * content changes; the runtime runs conflict detection and stores the proposal
 * with conflict warnings; the proposing agent previews the diff and applies it
 * atomically. Every approved edit leaves a memory_snapshots undo row so the
 * prior content is always recoverable, and an optimistic-lock check rejects
 * proposals written against content that has since changed.
 *
 * Approval/correction paths feed the reinforcement loop (memory confirm) so
 * corrected content ranks higher and the superseded claim decays.
 */

import { createHash, randomUUID } from 'crypto';
import { eq, and, sql, lt, or, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient, runInTransaction } from '../storage/database.js';
import { detectConflicts as detectTypedConflicts } from './conflict-detector.js';
import { logger } from '../logger.js';
import { deserializeMetadata, toSqliteJson } from '../../core/memory/serialization.js';
import { signMemoryProvenance, verifyMemoryProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { evictMemoryRuntimeState } from './runtime-cache-lifecycle.js';
import { isGeneratedContextEcho } from './context-echo.js';
import { config } from '../../config.js';
import { decrypt, encrypt, encryptBound } from '../security/encrypt.js';

export interface EditProposal {
  id: string;
  memoryId: string;
  currentContent: string;
  proposedContent: string;
  reason: string;
  conflictWarnings: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  version: number;
  createdAt: Date;
  reviewedAt?: Date;
  reviewNotes?: string;
}

export interface EditProposalAction {
  ok: boolean;
  error?: 'not_found' | 'not_pending' | 'stale_content' | 'database_unavailable' | 'invalid_provenance' | 'provenance_signing_unavailable' | 'generated_context' | 'encrypted_memory_unsupported';
  detail?: string;
  proposal?: EditProposal;
  priorContent?: string;
  priorValidFrom?: string | null;
  priorValidTo?: string | null;
  priorRecordedAt?: string | null;
  priorExpiresAt?: string | null;
  snapshotId?: string;
}

const DEFAULT_PROPOSAL_TTL_DAYS = 14;
const sqliteEditTransactionQueues = new WeakMap<object, Promise<void>>();

function isEncryptedMemory(memory: Record<string, unknown>): boolean {
  return Boolean(memory.isEncrypted ?? memory.is_encrypted);
}

function assertEditWorkflowTrusted(): void {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Memory edit workflows are withheld under strict trust until caller-bound ACL and provenance handling is available');
  }
}

interface ProjectionRevision {
  id: string;
  metadata: unknown;
}

function serializeRevisionMetadata(raw: any, metadata: Record<string, unknown>): unknown {
  return typeof raw?.prepare === 'function' ? toSqliteJson(metadata) : metadata;
}

async function withEditTransaction<T>(db: any, work: (tx: any) => Promise<T>): Promise<T> {
  const raw = db.$client ?? db;
  if (typeof raw.prepare !== 'function' && typeof raw.query === 'function' && typeof db.transaction === 'function') {
    return db.transaction(work);
  }
  if (typeof raw.prepare !== 'function') return runInTransaction(db, work);

  const previous = sqliteEditTransactionQueues.get(raw) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  sqliteEditTransactionQueues.set(raw, current);
  await previous;
  try {
    return await runInTransaction(db, work);
  } finally {
    release();
    if (sqliteEditTransactionQueues.get(raw) === current) sqliteEditTransactionQueues.delete(raw);
  }
}

function revisionMetadata(
  previousContent: string,
  nextContent: string,
  projectId: string | null,
  type: string,
  value: unknown,
  scope: { ownerId: string | null; teamId: string | null; sourceMemoryId: string | null },
): { ok: true; metadata: Record<string, unknown> } | { ok: false; error: 'invalid_provenance' | 'provenance_signing_unavailable' } {
  const decoded = deserializeMetadata(value as string | Record<string, unknown> | null);
  if (value !== null && value !== undefined && decoded === null) return { ok: false, error: 'invalid_provenance' };
  const metadata = decoded ?? {};
  const signedRecord = { content: previousContent, projectId, type, metadata, ...scope };
  const signature = metadata.__squishProvenance;
  if (signature === undefined) return { ok: true, metadata };
  if (!verifyMemoryProvenance(signedRecord)) {
    return { ok: false, error: 'invalid_provenance' };
  }
  try {
    const replacement = signMemoryProvenance({ ...signedRecord, content: nextContent });
    if (!replacement) return { ok: false, error: 'provenance_signing_unavailable' };
    return { ok: true, metadata: { ...metadata, __squishProvenance: replacement } };
  } catch {
    return { ok: false, error: 'provenance_signing_unavailable' };
  }
}

/** Prepare memory and knowledge projection metadata before committing a content revision. */
async function prepareContentRevision(
  db: any,
  schema: any,
  memory: any,
  nextContent: string,
): Promise<
  | { ok: true; memoryMetadata: unknown; projections: ProjectionRevision[] }
  | { ok: false; error: 'invalid_provenance' | 'provenance_signing_unavailable' | 'database_unavailable' }
> {
  const scope = {
    ownerId: memory.userId ?? null,
    teamId: memory.teamId ?? null,
    sourceMemoryId: memory.id,
  };
  const memoryMetadata = revisionMetadata(memory.content, nextContent, memory.projectId ?? null, memory.type ?? 'note', memory.metadata, scope);
  if (!memoryMetadata.ok) return memoryMetadata;

  const raw = db.$client ?? db;
  let rows: Array<ProjectionRevision & { content: string; project_id: string | null; knowledge_type: string }>;
  if (typeof raw.prepare === 'function') {
    rows = raw.prepare(`
      SELECT id, metadata, content, project_id, knowledge_type
      FROM knowledge
      WHERE knowledge_kind = 'memory'
        AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)
        AND project_id IS ?
    `).all(memory.id, memory.id, memory.projectId ?? null);
  } else if (typeof raw.query === 'function') {
    const result = await raw.query(`
      SELECT id, metadata, content, project_id, knowledge_type
      FROM knowledge
      WHERE knowledge_kind = $1 AND (id = $2 OR metadata->>'sourceMemoryId' = $2)
        AND project_id IS NOT DISTINCT FROM $3
    `, ['memory', memory.id, memory.projectId ?? null]);
    rows = result.rows;
  } else {
    return { ok: false, error: 'database_unavailable' as const };
  }
  const projections: ProjectionRevision[] = [];
  for (const row of rows) {
    const revised = revisionMetadata(row.content, nextContent, row.project_id ?? null, row.knowledge_type ?? 'note', row.metadata, scope);
    if (!revised.ok) return revised;
    projections.push({ id: row.id, metadata: serializeRevisionMetadata(raw, revised.metadata) });
  }
  return { ok: true, memoryMetadata: serializeRevisionMetadata(raw, memoryMetadata.metadata), projections };
}

async function updateContentRevision(
  db: any,
  schema: any,
  memoryId: string,
  expectedContent: string,
  content: string,
  now: Date,
  revision: { memoryMetadata: unknown; projections: ProjectionRevision[] },
): Promise<void> {
  const updated = await (db as any)
    .update(schema.memories)
    .set({
      content,
      metadata: revision.memoryMetadata,
      embeddingJson: null,
      embedding: null,
      embeddingBlob: null,
      embeddingModel: null,
      embeddingDim: null,
      recordedAt: now,
      version: sql`${schema.memories.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(schema.memories.id, memoryId), eq(schema.memories.content, expectedContent)))
    .returning({ id: schema.memories.id });
  if (updated.length === 0) throw new StaleMemoryContentError();
  for (const projection of revision.projections) {
    await (db as any)
      .update(schema.knowledge)
      .set({
        content,
        metadata: projection.metadata,
        embeddingJson: null,
        embedding: null,
        embeddingBlob: null,
        embeddingModel: null,
        embeddingDim: null,
        recordedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.knowledge.id, projection.id));
  }
  await updateCaptureReceiptContent(db, schema, memoryId, content);
  await invalidateSourceDerivedProjections(db, schema, memoryId, now);
}

class StaleMemoryContentError extends Error {
  constructor() {
    super('Memory content changed while the correction was being prepared');
    this.name = 'StaleMemoryContentError';
  }
}

/** Keep an explicit host-capture receipt aligned with its corrected source. */
async function updateCaptureReceiptContent(db: any, schema: any, memoryId: string, content: string): Promise<void> {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const raw = db.$client ?? db;
  if (typeof raw.prepare === 'function') {
    const table = raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_capture_receipts'").get();
    if (!table) return;
    raw.prepare('UPDATE memory_capture_receipts SET content_hash=? WHERE memory_id=?').run(contentHash, memoryId);
    return;
  }
  if (schema.memoryCaptureReceipts) {
    const receipts = schema.memoryCaptureReceipts;
    await db.update(receipts).set({ contentHash }).where(eq(receipts.memoryId, memoryId));
  }
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  const decoded = deserializeMetadata(value as string | Record<string, unknown> | null);
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
}

function timestampDate(value: Date | number | null | undefined, fallback: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  return fallback;
}

function temporalSnapshotTimestamp(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number') date = new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  else date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Cannot record invalid temporal state in correction history');
  return date.toISOString();
}

function priorTemporalState(memory: { validFrom?: Date | number | string | null; validTo?: Date | number | string | null; recordedAt?: Date | number | string | null; expiresAt?: Date | number | string | null }) {
  return {
    priorValidFrom: temporalSnapshotTimestamp(memory.validFrom),
    priorValidTo: temporalSnapshotTimestamp(memory.validTo),
    priorRecordedAt: temporalSnapshotTimestamp(memory.recordedAt),
    priorExpiresAt: temporalSnapshotTimestamp(memory.expiresAt),
  };
}

/**
 * Remove facts and beliefs derived from a source whose content or lifecycle changed.
 * Keep edge retraction history, audit each projection deletion, and requeue
 * analysis for the corrected source and any other source that supported a
 * shared belief so independently valid evidence can rebuild it.
 */
export async function invalidateSourceDerivedProjections(
  tx: any,
  schema: any,
  memoryId: string,
  now: Date,
  reason: 'source_corrected' | 'source_expired' | 'source_superseded' = 'source_corrected',
): Promise<void> {
  const [source] = await tx.select({ projectId: schema.memories.projectId })
    .from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  if (!source) return;

  const sourceBeliefEdges = await tx.select({ fromId: schema.knowledgeEdges.fromId })
    .from(schema.knowledgeEdges).where(and(
      eq(schema.knowledgeEdges.fromKind, 'knowledge'),
      eq(schema.knowledgeEdges.toId, memoryId),
      eq(schema.knowledgeEdges.edgeType, 'sourced_from'),
    ));
  const sourceBeliefIds = new Set(sourceBeliefEdges.map((edge: { fromId: string }) => edge.fromId));
  const linkedBeliefIds = [...sourceBeliefIds];
  const sourceProjectCondition = source.projectId === null
    ? isNull(schema.knowledge.projectId)
    : eq(schema.knowledge.projectId, source.projectId);
  const linkedBeliefs = linkedBeliefIds.length === 0 ? [] : await tx.select({
    id: schema.knowledge.id,
    projectId: schema.knowledge.projectId,
    sessionId: schema.knowledge.sessionId,
    knowledgeKind: schema.knowledge.knowledgeKind,
    knowledgeType: schema.knowledge.knowledgeType,
    metadata: schema.knowledge.metadata,
  }).from(schema.knowledge).where(and(
    inArray(schema.knowledge.id, linkedBeliefIds),
    sourceProjectCondition,
    eq(schema.knowledge.knowledgeKind, 'belief'),
  ));
  const sourceMetadataMatch = sql`${schema.knowledge.metadata}->>'sourceMemoryId' = ${memoryId}`;
  const sourceProjections = await tx.select({
    id: schema.knowledge.id,
    projectId: schema.knowledge.projectId,
    sessionId: schema.knowledge.sessionId,
    knowledgeKind: schema.knowledge.knowledgeKind,
    knowledgeType: schema.knowledge.knowledgeType,
    metadata: schema.knowledge.metadata,
  }).from(schema.knowledge).where(and(
    sourceProjectCondition,
    or(
      and(eq(schema.knowledge.knowledgeKind, 'belief'), sourceMetadataMatch),
      and(eq(schema.knowledge.knowledgeKind, 'memory'), eq(schema.knowledge.knowledgeType, 'fact'), sourceMetadataMatch),
    ),
  ));
  const derivedById = new Map<string, typeof sourceProjections[number]>();
  for (const row of [...linkedBeliefs, ...sourceProjections]) derivedById.set(row.id, row);
  const derived = [...derivedById.values()].filter((row: {
    id: string;
    knowledgeKind: string;
    knowledgeType: string;
    metadata: unknown;
  }) => {
    const metadata = metadataRecord(row.metadata);
    if (row.knowledgeKind === 'belief') {
      return metadata?.sourceMemoryId === memoryId || sourceBeliefIds.has(row.id);
    }
    const derivation = metadata?.derivation;
    return row.knowledgeKind === 'memory' && row.knowledgeType === 'fact'
      && metadata?.sourceMemoryId === memoryId
      && (derivation && typeof derivation === 'object' && !Array.isArray(derivation)
        && (derivation as Record<string, unknown>).kind === 'extracted_fact'
        || typeof metadata.analysisJobId === 'string');
  });
  if (derived.length === 0) {
    await resetSourceAnalysisJobs(tx, schema, [memoryId], now);
    return;
  }

  const derivedIds = derived.map((row: { id: string }) => row.id);
  const beliefIds = derived.filter((row: { knowledgeKind: string }) => row.knowledgeKind === 'belief')
    .map((row: { id: string }) => row.id);
  const supportingSourceIds = new Set([memoryId]);
  if (beliefIds.length > 0) {
    const supports = await tx.select({ toId: schema.knowledgeEdges.toId, toKind: schema.knowledgeEdges.toKind })
      .from(schema.knowledgeEdges).where(and(
        eq(schema.knowledgeEdges.fromKind, 'knowledge'),
        inArray(schema.knowledgeEdges.fromId, beliefIds),
        eq(schema.knowledgeEdges.edgeType, 'sourced_from'),
      ));
    for (const support of supports as Array<{ toId: string; toKind: string }>) {
      if (support.toKind === 'knowledge' || support.toKind === 'memory') supportingSourceIds.add(support.toId);
    }
  }

  const relatedEdges = await tx.select().from(schema.knowledgeEdges).where(or(
    and(eq(schema.knowledgeEdges.fromKind, 'knowledge'), inArray(schema.knowledgeEdges.fromId, derivedIds)),
    and(eq(schema.knowledgeEdges.toKind, 'knowledge'), inArray(schema.knowledgeEdges.toId, derivedIds)),
  ));
  for (const edge of relatedEdges) {
    if (edge.recordedTo !== null) continue;
    const recordedAt = timestampDate(edge.recordedAt, timestampDate(edge.createdAt, now));
    const recordedTo = new Date(Math.max(now.getTime(), recordedAt.getTime() + 1));
    await tx.update(schema.knowledgeEdges).set({ recordedTo })
      .where(and(eq(schema.knowledgeEdges.id, edge.id), isNull(schema.knowledgeEdges.recordedTo)));
  }

  const { logAuditEntry } = await import('../knowledge/audit.js');
  for (const projection of derived) {
    await tx.delete(schema.knowledge).where(eq(schema.knowledge.id, projection.id));
    await logAuditEntry({
      knowledgeId: projection.id,
      action: 'delete',
      projectId: projection.projectId ?? undefined,
      sessionId: projection.sessionId ?? undefined,
      details: { sourceMemoryId: memoryId, reason },
    }, tx);
  }
  await resetSourceAnalysisJobs(tx, schema, [...supportingSourceIds], now);
}

async function resetSourceAnalysisJobs(tx: any, schema: any, memoryIds: string[], now: Date): Promise<void> {
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  if (uniqueIds.length === 0) return;
  const encryptionColumn = schema.memories.isEncrypted ?? schema.memories.is_encrypted;
  const sourceRows = await tx.select({
    id: schema.memories.id,
    projectId: schema.memories.projectId,
    status: schema.memories.status,
    isActive: schema.memories.isActive,
    ...(encryptionColumn ? { isEncrypted: encryptionColumn } : {}),
    expiresAt: schema.memories.expiresAt,
  }).from(schema.memories).where(inArray(schema.memories.id, uniqueIds));
  const eligible = sourceRows.filter((row: {
    projectId: string | null;
    status: string;
    isActive: boolean | number;
    isEncrypted: boolean | number | null;
    expiresAt: Date | number | null;
  }) => {
    const expiresAt = row.expiresAt === null ? null : timestampDate(row.expiresAt, now).getTime();
    return row.projectId && row.status === 'active' && Boolean(row.isActive) && !Boolean(row.isEncrypted)
      && (expiresAt === null || expiresAt > now.getTime());
  });
  const nowSeconds = Math.floor(now.getTime() / 1000);
  for (const source of eligible) {
    await tx.insert(schema.memoryAnalysisJobs).values({
      id: randomUUID(),
      sourceMemoryId: source.id,
      projectId: source.projectId,
      jobKind: 'analyze_memory',
      status: 'pending',
      attempts: 0,
      availableAt: nowSeconds,
      lockedAt: null,
      lastErrorCode: null,
      updatedAt: nowSeconds,
    }).onConflictDoUpdate({
      target: [schema.memoryAnalysisJobs.sourceMemoryId, schema.memoryAnalysisJobs.jobKind],
      set: {
        status: 'pending',
        attempts: 0,
        availableAt: nowSeconds,
        lockedAt: null,
        lastErrorCode: null,
        updatedAt: nowSeconds,
      },
    });
  }
}

async function loadProposal(db: any, proposalId: string): Promise<any | null> {
  const schema = await getSchema();
  const rows = await (db as any)
    .select()
    .from(schema.memoryEditProposals)
    .where(eq(schema.memoryEditProposals.id, proposalId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stage an edit proposal against a memory. The optimistic-lock anchor is the
 * memory's content at proposal time (read from the DB, not caller-supplied).
 * Conflict warnings are computed immediately so the proposing agent can
 * reconsider before applying.
 */
export async function createEditProposal(
  memoryId: string,
  proposedContent: string,
  reason: string,
  userId?: string
): Promise<EditProposal> {
  assertEditWorkflowTrusted();
  if (isGeneratedContextEcho(proposedContent)) {
    throw new Error('Generated context cannot be stored as an edit proposal');
  }
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const { memoryEditProposals, memories } = schema;

  const memoryRows = await (db as any)
    .select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);
  if (memoryRows.length === 0) {
    throw new Error(`memory not found: ${memoryId}`);
  }
  const memory = memoryRows[0];
  if (isEncryptedMemory(memory)) {
    throw new Error('Edit proposals for encrypted memories are unavailable until encrypted proposal storage is supported');
  }

  const proposalId = randomUUID();
  const now = new Date();
  const currentContent = memory.content;

  await (db as any).insert(memoryEditProposals).values({
    id: proposalId,
    projectId: memory.projectId,
    memoryId,
    currentContent,
    proposedContent,
    reason,
    conflictWarnings: toSqliteJson([]),
    status: 'pending',
    version: 1,
    createdAt: now,
    userId,
  });

  // Conflict detection runs after the insert so a detector failure never
  // loses the proposal - warnings are patched in best-effort.
  let conflicts: string[] = [];
  try {
    const typed = await detectTypedConflicts(memoryId, proposedContent);
    conflicts = typed.map((c) =>
      c.relatedMemoryId ? `${c.type}: ${c.description} (memory ${c.relatedMemoryId})` : `${c.type}: ${c.description}`
    );
  } catch (error) {
    logger.warn(`[EditWorkflow] conflict detection failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  await (db as any)
    .update(memoryEditProposals)
    .set({ conflictWarnings: toSqliteJson(conflicts) })
    .where(eq(memoryEditProposals.id, proposalId));

  return {
    id: proposalId,
    memoryId,
    currentContent,
    proposedContent,
    reason,
    conflictWarnings: conflicts,
    status: 'pending',
    version: 1,
    createdAt: now,
  };
}

/**
 * Apply a pending proposal atomically. Rejects stale proposals: if the
 * memory's content changed since the proposal was staged, the diff the agent
 * previewed no longer matches reality and must be re-staged. Writes a
 * before_update snapshot (undo row) and reinforces the memory (confirm) so
 * the corrected content ranks higher.
 */
export async function approveEditProposal(proposalId: string, reviewNotes?: string): Promise<EditProposalAction> {
  assertEditWorkflowTrusted();
  const nativeDb = await getDb();
  const db = createDatabaseClient(nativeDb);
  if (!db) return { ok: false, error: 'database_unavailable' };
  const schema = await getSchema();
  const { memoryEditProposals, memories, memorySnapshots } = schema;

  const proposal = await loadProposal(db, proposalId);
  if (!proposal) {
    return { ok: false, error: 'not_found', detail: `no edit proposal ${proposalId}` };
  }
  if (proposal.status !== 'pending') {
    return { ok: false, error: 'not_pending', detail: `proposal status is '${proposal.status}'` };
  }
  if (isGeneratedContextEcho(proposal.proposedContent)) {
    return { ok: false, error: 'generated_context', detail: 'generated context cannot replace a stored memory' };
  }

  const memoryRows = await (db as any)
    .select()
    .from(memories)
    .where(eq(memories.id, proposal.memoryId))
    .limit(1);
  if (memoryRows.length === 0) {
    return { ok: false, error: 'not_found', detail: `memory ${proposal.memoryId} no longer exists` };
  }
  const memory = memoryRows[0];
  if (isEncryptedMemory(memory)) {
    return { ok: false, error: 'encrypted_memory_unsupported', detail: 'encrypted memory edits are unavailable until encrypted proposal and snapshot storage is supported' };
  }
  if (memory.content !== proposal.currentContent) {
    return {
      ok: false,
      error: 'stale_content',
      detail: 'memory content changed since this proposal was staged; re-propose against current content',
    };
  }

  const revision = await prepareContentRevision(nativeDb, schema, memory, proposal.proposedContent);
  if (!revision.ok) return { ok: false, error: revision.error };

  const now = new Date();
  const snapshotId = randomUUID();
  const priorTemporal = priorTemporalState(memory);

  try {
    await withEditTransaction(nativeDb, async (tx) => {
      await tx.insert(memorySnapshots).values({
        id: snapshotId,
        memoryId: proposal.memoryId,
        snapshotType: 'before_update',
        content: proposal.currentContent,
        metadata: toSqliteJson({
          proposalId,
          reason: proposal.reason,
          proposedContent: proposal.proposedContent,
          kind: 'edit_proposal',
          ...priorTemporal,
        }),
        diff: toSqliteJson({ from: proposal.currentContent, to: proposal.proposedContent }),
        createdAt: now,
      });

      await updateContentRevision(tx, schema, proposal.memoryId, proposal.currentContent, proposal.proposedContent, now, revision);

      await tx
        .update(memoryEditProposals)
        .set({ status: 'approved', reviewedAt: now, reviewNotes: reviewNotes ?? null })
        .where(eq(memoryEditProposals.id, proposalId));
    });
  } catch (error) {
    if (error instanceof StaleMemoryContentError) {
      return { ok: false, error: 'stale_content', detail: 'memory content changed while the proposal was being approved; re-propose against current content' };
    }
    throw error;
  }

  // The process-local consolidation cluster still holds the pre-edit vector.
  // Evict only after the durable revision commits; maintenance can rebuild it.
  await evictMemoryRuntimeState([proposal.memoryId]);

  // Reinforcement: the agent verified the corrected content - anchor recency
  // and bump retrieval priority. Best-effort; approval already committed.
  try {
    const { applyFeedback } = await import('./reinforcement.js');
    const result = await applyFeedback({
      targetType: 'memory',
      id: proposal.memoryId,
      signal: 'confirm',
      project: memory.projectId ?? undefined,
    });
    if (!result.ok) {
      logger.warn(`[EditWorkflow] post-approval reinforcement skipped: ${result.detail ?? 'unknown reason'}`);
    }
  } catch (error) {
    logger.warn(`[EditWorkflow] post-approval reinforcement failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: true,
    proposal: { ...proposal, status: 'approved', reviewedAt: now, reviewNotes },
    priorContent: proposal.currentContent,
    ...priorTemporal,
    snapshotId,
  };
}

export async function rejectEditProposal(proposalId: string, reviewNotes?: string): Promise<EditProposalAction> {
  assertEditWorkflowTrusted();
  const db = createDatabaseClient(await getDb());
  if (!db) return { ok: false, error: 'database_unavailable' };
  const schema = await getSchema();
  const { memoryEditProposals } = schema;

  const proposal = await loadProposal(db, proposalId);
  if (!proposal) {
    return { ok: false, error: 'not_found', detail: `no edit proposal ${proposalId}` };
  }
  if (proposal.status !== 'pending') {
    return { ok: false, error: 'not_pending', detail: `proposal status is '${proposal.status}'` };
  }

  const now = new Date();
  await (db as any)
    .update(memoryEditProposals)
    .set({ status: 'rejected', reviewedAt: now, reviewNotes: reviewNotes ?? null })
    .where(eq(memoryEditProposals.id, proposalId));

  return { ok: true, proposal: { ...proposal, status: 'rejected', reviewedAt: now, reviewNotes } };
}

/**
 * Direct content correction (operator path): snapshot the prior content as a
 * 'correction' record, apply the new content immediately, and reinforce the
 * memory. This is the learning loop for "the agent had it wrong" - the diff
 * trail plus the confirm signal make the correction outrank the stale claim.
 */
export async function correctMemory(
  memoryId: string,
  content: string,
  reason: string,
  userId?: string
): Promise<EditProposalAction> {
  if (isStrictTrustPolicy()) {
    return correctMemoryStrict(memoryId, content, reason, userId);
  }
  assertEditWorkflowTrusted();
  if (isGeneratedContextEcho(content)) {
    throw new Error('Generated context cannot replace stored memory');
  }
  const nativeDb = await getDb();
  const db = createDatabaseClient(nativeDb);
  if (!db) return { ok: false, error: 'database_unavailable' };
  const schema = await getSchema();
  const { memories, memorySnapshots } = schema;

  const memoryRows = await (db as any)
    .select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);
  if (memoryRows.length === 0) {
    return { ok: false, error: 'not_found', detail: `memory ${memoryId} not found` };
  }
  const memory = memoryRows[0];
  if (isEncryptedMemory(memory)) {
    return { ok: false, error: 'encrypted_memory_unsupported', detail: 'encrypted memory corrections are unavailable until encrypted snapshot storage is supported' };
  }

  const revision = await prepareContentRevision(nativeDb, schema, memory, content);
  if (!revision.ok) return { ok: false, error: revision.error };

  const now = new Date();
  const snapshotId = randomUUID();
  const priorTemporal = priorTemporalState(memory);

  try {
    await withEditTransaction(nativeDb, async (tx) => {
      await tx.insert(memorySnapshots).values({
        id: snapshotId,
        memoryId,
        snapshotType: 'correction',
        content: memory.content,
        metadata: toSqliteJson({ reason, userId: userId ?? null, kind: 'correction', ...priorTemporal }),
        diff: toSqliteJson({ from: memory.content, to: content }),
        createdAt: now,
      });

      await updateContentRevision(tx, schema, memoryId, memory.content, content, now, revision);
    });
  } catch (error) {
    if (error instanceof StaleMemoryContentError) return { ok: false, error: 'stale_content', detail: error.message };
    throw error;
  }

  // Keep transient consolidation geometry aligned with the corrected content.
  await evictMemoryRuntimeState([memoryId]);

  try {
    const { applyFeedback } = await import('./reinforcement.js');
    await applyFeedback({
      targetType: 'memory',
      id: memoryId,
      signal: 'confirm',
      project: memory.projectId ?? undefined,
    });
  } catch (error) {
    logger.warn(`[EditWorkflow] post-correction reinforcement failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ok: true, priorContent: memory.content, ...priorTemporal, snapshotId };
}

function resolveSqlitePersistedIdentity(sqlite: any, identity: string): { id: string } | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity);
  if (config.mode !== 'team' || uuid) {
    const byId = sqlite.prepare('SELECT id FROM users WHERE id=? LIMIT 1').get(identity) as { id: string } | undefined;
    if (byId) return byId;
  }
  const byExternalId = sqlite.prepare('SELECT id FROM users WHERE external_id=? LIMIT 1').get(identity) as { id: string } | undefined;
  if (byExternalId) return byExternalId;
  const byEmail = sqlite.prepare('SELECT id FROM users WHERE email=? LIMIT 2').all(identity) as Array<{ id: string }>;
  return byEmail.length === 1 ? byEmail[0] : undefined;
}

/** Strict corrections are limited to the authenticated owner of a personal,
 * unshared v3-signed memory. Authorization, snapshot, revision, and audit are
 * serialized in one SQLite write transaction. */
async function correctMemoryStrict(memoryId: string, content: string, reason: string, userId?: string): Promise<EditProposalAction> {
  interface SourceRow {
    id: string; content: string; projectId: string | null; type: string; userId: string | null;
    teamId: string | null; metadata: string | null; status: string; isActive: number;
    expiresAt: number | null; isEncrypted: number | boolean | null;
    encryptedContent: string | null; encryptionNonce: string | null;
    validFrom: number | null; validTo: number | null; recordedAt: number | null;
  }
  interface ProjectionRow {
    id: string; content: string; projectId: string | null; type: string; metadata: string | null;
    encryptedContent: string | null; encryptionNonce: string | null;
  }
  const { resolveTrustedCallerId, TrustBoundaryError } = await import('../acl/trust-policy.js');
  const auditEarlyDenial = async (actorId: string, decisionReason: 'caller_mismatch' | 'caller_unbound') => {
    try {
      const { writeTrustAudit } = await import('../acl/trust-audit.js');
      await writeTrustAudit({ actorId, resourceId: memoryId || 'strict-correction', assetType: 'memory', decision: 'deny', reason: decisionReason });
    } catch { /* preserve the authorization failure if audit storage is unavailable */ }
  };
  let callerId: string | null;
  try {
    callerId = resolveTrustedCallerId(userId);
  } catch (error) {
    await auditEarlyDenial(userId?.trim() || 'unbound', 'caller_mismatch');
    throw error;
  }
  if (!callerId) {
    await auditEarlyDenial('unbound', 'caller_unbound');
    throw new TrustBoundaryError('Strict correction requires an authenticated caller');
  }
  const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
  const ownerId = await resolvePersistedUserId(callerId);
  if (!ownerId) {
    await auditEarlyDenial(callerId, 'caller_unbound');
    throw new TrustBoundaryError('Strict correction requires a persisted owner identity');
  }
  const nativeDb = await getDb();
  const sqlite = nativeDb?.$client;
  if (!sqlite?.prepare || !sqlite?.exec) throw new TrustBoundaryError('Strict correction requires SQLite');
  const { signMemoryProvenance, verifyMemoryProvenance } = await import('../acl/provenance.js');
  const snapshotId = randomUUID();
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const deny = (detail: string): never => { throw new TrustBoundaryError(detail); };
    const persistedCaller = resolveSqlitePersistedIdentity(sqlite, callerId);
    if (!persistedCaller || persistedCaller.id !== ownerId) deny('Strict correction caller identity is no longer persisted');
    const row = sqlite.prepare(`SELECT id, content, project_id AS projectId, type, user_id AS userId,
      team_id AS teamId, metadata, status, is_active AS isActive, expires_at AS expiresAt,
      valid_from AS validFrom, valid_to AS validTo, recorded_at AS recordedAt,
      is_encrypted AS isEncrypted, encrypted_content AS encryptedContent, encryption_nonce AS encryptionNonce
      FROM memories WHERE id = ?`).get(memoryId) as SourceRow | undefined;
    if (!row) throw new TrustBoundaryError('Strict correction target is unavailable to this caller');
    if (row.userId !== ownerId || row.teamId || row.status !== 'active' || !row.isActive
      || (row.expiresAt !== null && Number(row.expiresAt) <= Math.floor(Date.now() / 1000))) {
      deny('Strict correction is limited to the authenticated owner of an active personal memory');
    }
    const encrypted = Boolean(row.isEncrypted);
    if (encrypted && (!row.encryptedContent || !row.encryptionNonce)) deny('Strict correction rejected an incomplete encrypted source');
    if (sqlite.prepare("SELECT 1 FROM visibility_rules WHERE asset_type='memory' AND asset_id=? LIMIT 1").get(memoryId)
      || sqlite.prepare('SELECT 1 FROM team_shares WHERE memory_id=? LIMIT 1').get(memoryId)) {
      deny('Strict correction is withheld for memories with explicit sharing rules');
    }
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>; } catch { deny('Strict correction rejected invalid source metadata'); }
    const scope = { ownerId: row.userId, teamId: row.teamId, sourceMemoryId: row.id };
    let priorContent = row.content;
    if (encrypted) {
      try { priorContent = decrypt(row.encryptedContent!, row.encryptionNonce!); }
      catch { deny('Strict correction could not decrypt the encrypted source'); }
    }
    const sourceEnvelope = metadata!.__squishProvenance as { version?: number } | undefined;
    if (sourceEnvelope?.version !== 3 || !verifyMemoryProvenance({ content: priorContent, projectId: row.projectId, type: row.type, ...scope, metadata: metadata! })) {
      deny('Strict correction requires valid v3 source provenance');
    }
    if (isGeneratedContextEcho(content)) deny('Generated context cannot replace stored memory');
    const projections = sqlite.prepare(`SELECT id, content, encrypted_content AS encryptedContent,
      encryption_nonce AS encryptionNonce, project_id AS projectId, knowledge_type AS type, metadata
      FROM knowledge WHERE knowledge_kind='memory'
      AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId')=?
      -- Extracted facts are source-derived rows, not signed canonical projections; invalidate them below.
      AND NOT (knowledge_type='fact' AND (
        COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.derivation.kind'), '')='extracted_fact'
        OR json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.analysisJobId') IS NOT NULL
      ))
      AND project_id IS ?`)
      .all(memoryId, row.projectId) as ProjectionRow[];
    if (projections.length === 0) deny('Strict correction requires at least one canonical memory projection');
    const decodedProjections = projections.map((projection) => {
      if (!encrypted) return projection;
      if (!projection.encryptedContent || !projection.encryptionNonce) deny('Strict correction rejected an incomplete encrypted projection');
      let projectionContent: string;
      try { projectionContent = decrypt(projection.encryptedContent!, projection.encryptionNonce!); }
      catch { deny('Strict correction could not decrypt an encrypted projection'); }
      return { ...projection, content: projectionContent! };
    });
    const sourceSignature = signMemoryProvenance({ content, projectId: row.projectId, type: row.type, ...scope, metadata: metadata! });
    if (sourceSignature?.version !== 3) deny('Strict correction requires an available v3 signing key');
    const nextSourceMetadata = { ...metadata!, __squishProvenance: sourceSignature };
    const nextProjectionMetadata = decodedProjections.map((projection) => {
      let projectionMetadata: Record<string, unknown>;
      try { projectionMetadata = JSON.parse(projection.metadata ?? '{}'); } catch { deny('Strict correction rejected invalid projection metadata'); }
      const envelope = projectionMetadata!.__squishProvenance as { version?: number } | undefined;
      if (envelope?.version !== 3 || !verifyMemoryProvenance({ content: projection.content, projectId: projection.projectId, type: projection.type, ...scope, metadata: projectionMetadata! })) {
        deny('Strict correction requires valid v3 provenance on every projection');
      }
      const signature = signMemoryProvenance({ content, projectId: projection.projectId, type: projection.type, ...scope, metadata: projectionMetadata! });
      if (signature?.version !== 3) deny('Strict correction requires an available v3 signing key');
      return { id: projection.id, metadata: JSON.stringify({ ...projectionMetadata!, __squishProvenance: signature }) };
    });
    const now = Math.floor(Date.now() / 1000);
    const snapshotDiff = { from: priorContent, to: content };
    const snapshotObservedAt = new Date(now * 1000).toISOString();
    const priorTemporal = priorTemporalState(row);
    const snapshotEvidence: Record<string, unknown> = {
      kind: 'correction_snapshot_v3',
      ...priorTemporal,
      sourceId: `sha256:${createHash('sha256').update(JSON.stringify([
        snapshotId, memoryId, 'correction', now, reason, snapshotDiff.from, snapshotDiff.to,
        priorTemporal.priorValidFrom, priorTemporal.priorValidTo, priorTemporal.priorRecordedAt, priorTemporal.priorExpiresAt,
      ])).digest('hex')}`,
      observedAt: snapshotObservedAt,
      reasoning: reason,
    };
    const snapshotSignature = signMemoryProvenance({
      content: priorContent,
      projectId: row.projectId,
      type: 'correction_snapshot',
      ...scope,
      metadata: snapshotEvidence,
    });
    if (snapshotSignature?.version !== 3) deny('Strict correction requires a signed correction snapshot');
    const snapshotMetadata = { ...snapshotEvidence, __squishProvenance: snapshotSignature };
    const sourceNextContent = encrypted ? encrypt(content) : null;
    const snapshotEnvelope = encrypted ? encryptBound(JSON.stringify({ content: priorContent, metadata: snapshotMetadata, diff: snapshotDiff }), {
      format: 'squish-aesgcm-aad-v1', snapshotId, memoryId, projectId: row.projectId ?? '', ownerId,
    }) : null;
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff,
      encrypted_payload, encrypted_nonce, encryption_format, created_at)
      VALUES (?, ?, 'correction', ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshotId, memoryId, encrypted ? '' : priorContent,
        encrypted ? JSON.stringify({ encryptionFormat: 'squish-aesgcm-aad-v1' }) : JSON.stringify(snapshotMetadata),
        encrypted ? null : JSON.stringify(snapshotDiff), snapshotEnvelope?.ciphertext ?? null,
        snapshotEnvelope?.nonce ?? null, snapshotEnvelope ? 'squish-aesgcm-aad-v1' : null, now);
    const updated = sqlite.prepare(`UPDATE memories SET content=?, encrypted_content=COALESCE(?, encrypted_content),
      encryption_nonce=COALESCE(?, encryption_nonce), metadata=?, embedding_json=NULL, embedding=NULL,
      embedding_blob=NULL, embedding_model=NULL, embedding_dim=NULL, recorded_at=?, updated_at=?, version=version+1
      WHERE id=? AND content=? AND user_id=? AND team_id IS NULL AND status='active' AND is_active=1
      AND (expires_at IS NULL OR expires_at>?)`).run(encrypted ? '' : content, sourceNextContent?.ciphertext ?? null,
        sourceNextContent?.nonce ?? null, JSON.stringify(nextSourceMetadata), now, now, memoryId, row.content, ownerId, now);
    const changedRows = Number(updated?.changes ?? updated?.rowsAffected ?? sqlite.prepare('SELECT changes() AS count').get()?.count ?? 0);
    if (changedRows < 1) deny('Strict correction target changed or became unavailable');
    for (let i = 0; i < projections.length; i++) {
      const projectionEncrypted = encrypted ? encrypt(content) : null;
      const result = sqlite.prepare(`UPDATE knowledge SET content=?, encrypted_content=COALESCE(?, encrypted_content),
        encryption_nonce=COALESCE(?, encryption_nonce), metadata=?, embedding_json=NULL, embedding=NULL,
        embedding_blob=NULL, embedding_model=NULL, embedding_dim=NULL, recorded_at=?, updated_at=? WHERE id=? AND content=?`)
        .run(encrypted ? '' : content, projectionEncrypted?.ciphertext ?? null, projectionEncrypted?.nonce ?? null,
          nextProjectionMetadata[i].metadata, now, now, projections[i].id, projections[i].content);
      const projectionChanged = Number(result?.changes ?? result?.rowsAffected ?? sqlite.prepare('SELECT changes() AS count').get()?.count ?? 0);
      if (projectionChanged < 1) deny('Strict correction projection changed during update');
    }
    sqlite.prepare('UPDATE memory_capture_receipts SET content_hash=? WHERE memory_id=?')
      .run(createHash('sha256').update(content).digest('hex'), memoryId);
    await invalidateSourceDerivedProjections(nativeDb, await getSchema(), memoryId, new Date(now * 1000));
    sqlite.exec(`CREATE TABLE IF NOT EXISTS trust_audit_log (
      id TEXT PRIMARY KEY, actor_hash TEXT NOT NULL, resource_hash TEXT NOT NULL,
      asset_type TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
      reason TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS trust_audit_created_idx ON trust_audit_log(created_at);
       CREATE INDEX IF NOT EXISTS trust_audit_resource_idx ON trust_audit_log(resource_hash, created_at);`);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    sqlite.prepare(`INSERT INTO trust_audit_log (id, actor_hash, resource_hash, asset_type, decision, reason, created_at)
      VALUES (?, ?, ?, 'memory', 'allow', 'memory_correct', ?)`).run(randomUUID(), digest(callerId), digest(memoryId), Date.now());
    sqlite.exec('COMMIT');
    await evictMemoryRuntimeState([memoryId]);
    return { ok: true, priorContent, ...priorTemporal, snapshotId };
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* preserve original error */ }
    if (error instanceof TrustBoundaryError) {
      try {
        const { writeTrustAudit } = await import('../acl/trust-audit.js');
        await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'strict_write' });
      } catch { /* preserve the authorization failure if audit storage is unavailable */ }
    }
    throw error;
  }
}

/**
 * Expire pending proposals older than `days` (both edit and merge proposals
 * share the pending/expired lifecycle; merge proposals are handled by their
 * own maintenance path). Returns the number of proposals expired.
 */
export async function expireStaleEditProposals(days: number = DEFAULT_PROPOSAL_TTL_DAYS): Promise<number> {
  assertEditWorkflowTrusted();
  const db = createDatabaseClient(await getDb());
  if (!db) return 0;
  const schema = await getSchema();
  const { memoryEditProposals } = schema;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const expired = await (db as any)
    .update(memoryEditProposals)
    .set({ status: 'expired', reviewedAt: new Date(), reviewNotes: `expired after ${days} days pending` })
    .where(and(eq(memoryEditProposals.status, 'pending'), lt(memoryEditProposals.createdAt, cutoff)))
    .returning({ id: memoryEditProposals.id });

  if (expired.length > 0) {
    logger.info(`[EditWorkflow] expired ${expired.length} stale edit proposals (>${days}d pending)`);
  }
  return expired.length;
}

export async function getEditProposals(filters: {
  memoryId?: string;
  projectId?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  limit?: number;
} = {}): Promise<EditProposal[]> {
  assertEditWorkflowTrusted();
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const { memoryEditProposals } = schema;

  const conditions = [];
  if (filters.memoryId) conditions.push(eq(memoryEditProposals.memoryId, filters.memoryId));
  if (filters.projectId) conditions.push(eq(memoryEditProposals.projectId, filters.projectId));
  if (filters.status) conditions.push(eq(memoryEditProposals.status, filters.status));

  const base = (db as any).select().from(memoryEditProposals);
  const query = conditions.length > 0 ? base.where(and(...conditions)) : base;
  const proposals = await (filters.limit ? query.limit(filters.limit) : query);
  return proposals as EditProposal[];
}

/**
 * Fetch a single proposal by ID (preview path). Returns null when missing.
 */
export async function getEditProposalById(proposalId: string): Promise<EditProposal | null> {
  assertEditWorkflowTrusted();
  const proposal = await loadProposal(createDatabaseClient(await getDb()), proposalId);
  return (proposal as EditProposal) ?? null;
}

/**
 * Simple line-level before/after view for previews. Line-based so it stays
 * deterministic without a diff dependency.
 */
export function diffProposalContent(proposal: EditProposal): {
  removed: string[];
  added: string[];
} {
  const from = proposal.currentContent.split('\n');
  const to = proposal.proposedContent.split('\n');
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    removed: from.filter((l) => !toSet.has(l)),
    added: to.filter((l) => !fromSet.has(l)),
  };
}
