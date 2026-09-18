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

import { randomUUID } from 'crypto';
import { eq, and, sql, lt } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient, runInTransaction } from '../storage/database.js';
import { detectConflicts as detectTypedConflicts } from './conflict-detector.js';
import { logger } from '../logger.js';
import { toSqliteJson } from '../../core/memory/serialization.js';

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
  error?: 'not_found' | 'not_pending' | 'stale_content' | 'database_unavailable';
  detail?: string;
  proposal?: EditProposal;
  priorContent?: string;
  snapshotId?: string;
}

const DEFAULT_PROPOSAL_TTL_DAYS = 14;

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
    .set({ conflictWarnings: conflicts })
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
  const db = createDatabaseClient(await getDb());
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

  const memoryRows = await (db as any)
    .select()
    .from(memories)
    .where(eq(memories.id, proposal.memoryId))
    .limit(1);
  if (memoryRows.length === 0) {
    return { ok: false, error: 'not_found', detail: `memory ${proposal.memoryId} no longer exists` };
  }
  const memory = memoryRows[0];
  if (memory.content !== proposal.currentContent) {
    return {
      ok: false,
      error: 'stale_content',
      detail: 'memory content changed since this proposal was staged; re-propose against current content',
    };
  }

  const now = new Date();
  const snapshotId = randomUUID();

  await runInTransaction(db, async () => {
    await (db as any).insert(memorySnapshots).values({
      id: snapshotId,
      memoryId: proposal.memoryId,
      snapshotType: 'before_update',
      content: proposal.currentContent,
      metadata: toSqliteJson({
        proposalId,
        reason: proposal.reason,
        proposedContent: proposal.proposedContent,
        kind: 'edit_proposal',
      }),
      diff: toSqliteJson({ from: proposal.currentContent, to: proposal.proposedContent }),
      createdAt: now,
    });

    await (db as any)
      .update(memories)
      .set({
        content: proposal.proposedContent,
        version: sql`${memories.version} + 1`,
        updatedAt: now,
      })
      .where(eq(memories.id, proposal.memoryId));

    await (db as any)
      .update(memoryEditProposals)
      .set({ status: 'approved', reviewedAt: now, reviewNotes: reviewNotes ?? null })
      .where(eq(memoryEditProposals.id, proposalId));
  });

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
    snapshotId,
  };
}

export async function rejectEditProposal(proposalId: string, reviewNotes?: string): Promise<EditProposalAction> {
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
  const db = createDatabaseClient(await getDb());
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

  const now = new Date();
  const snapshotId = randomUUID();

  await runInTransaction(db, async () => {
    await (db as any).insert(memorySnapshots).values({
      id: snapshotId,
      memoryId,
      snapshotType: 'correction',
      content: memory.content,
      metadata: { reason, userId: userId ?? null, kind: 'correction' },
      diff: { from: memory.content, to: content },
      createdAt: now,
    });

    await (db as any)
      .update(memories)
      .set({
        content,
        version: sql`${memories.version} + 1`,
        updatedAt: now,
      })
      .where(eq(memories.id, memoryId));
  });

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

  return { ok: true, priorContent: memory.content, snapshotId };
}

/**
 * Expire pending proposals older than `days` (both edit and merge proposals
 * share the pending/expired lifecycle; merge proposals are handled by their
 * own maintenance path). Returns the number of proposals expired.
 */
export async function expireStaleEditProposals(days: number = DEFAULT_PROPOSAL_TTL_DAYS): Promise<number> {
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
