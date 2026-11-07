/**
 * Executes the approved merge in a single atomic transaction.
 */

import type { Memory, MemoryMergeProposal, MemoryMergeHistory } from '../../../db/drizzle/schema.js';
import { randomUUID } from 'crypto';
import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient, runInTransaction } from '../../../core/storage/database.js';
import { eq, inArray } from 'drizzle-orm';
import { mergeMemories } from '../strategies/merge-strategies.js';
import { estimateTokensSaved } from '../analytics/token-estimator.js';
import { getEmbedding, embeddingModelFor, activeEmbeddingModel } from '../../../core/embeddings.js';
import { encodeEmbeddingBlob } from '../../lib/embedding-codec.js';
import { toSqliteJson, toSqliteTags, deserializeTags, deserializeMetadata } from '../../../core/memory/serialization.js';
import { asArray } from '../utils/json-fields.js';
import { assertMergeWorkflowAvailable } from './strict-trust-guard.js';
import { evictMemoryRuntimeState } from '../../memory/runtime-cache-lifecycle.js';

interface ApproveMergeInput {
  proposalId: string;
  reviewNotes?: string;
}

interface ApproveMergeResponse {
  ok: boolean;
  message: string;
  data?: {
    proposalId: string;
    canonicalMemoryId: string;
    mergedMemoryIds: string[];
    tokensSaved: number;
    mergedAt: string;
    mergeHistoryId?: string;
  };
  error?: string;
}

export async function handleApproveMerge(input: ApproveMergeInput): Promise<ApproveMergeResponse> {
  try {
    assertMergeWorkflowAvailable();
    const { proposalId, reviewNotes } = input;

    if (!proposalId) {
      return {
        ok: false,
        message: 'proposalId is required',
        error: 'proposalId is required',
      };
    }

    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    const [proposal] = await db
      .select()
      .from(schema.memoryMergeProposals)
      .where(eq(schema.memoryMergeProposals.id, proposalId));

    if (!proposal) {
      return {
        ok: false,
        message: 'Proposal not found',
        error: `Proposal ${proposalId} not found`,
      };
    }

    if (proposal.status !== 'pending') {
      return {
        ok: false,
        message: `Proposal is not pending (status: ${proposal.status})`,
        error: `Cannot approve non-pending proposal`,
      };
    }

    // Step 2: Load source memories
    const sourceIds = asArray<string>(proposal.sourceMemoryIds);
    if (sourceIds.length === 0) {
      return {
        ok: false,
        message: 'No source memories found in proposal',
        error: 'Proposal has no source memory IDs',
      };
    }

    const rawSourceMemories: Memory[] = await db
      .select()
      .from(schema.memories)
      .where(inArray(schema.memories.id, sourceIds));

    if (rawSourceMemories.length !== sourceIds.length) {
      return {
        ok: false,
        message: 'Not all source memories could be found',
        error: 'Missing source memories',
      };
    }

    const hasEncryptedSource = rawSourceMemories.some((source) => {
      const row = source as unknown as Record<string, unknown>;
      return Boolean(row.isEncrypted) || Boolean(row.is_encrypted)
        || Boolean(row.encryptedContent) || Boolean(row.encrypted_content);
    });
    if (hasEncryptedSource) {
      return {
        ok: false,
        message: 'Merge proposals cannot include encrypted source memories',
        error: 'encrypted_memory_unsupported',
      };
    }

    // Boundary normalization (DEFECT 1): tags/metadata are TEXT columns typed
    // as string[]/Record. Same treatment as two-stage-detector: parse before
    // mergeMemories/estimateTokensSaved, or the persisted canonical row gets
    // character-mangled tags from mergeTags iterating a JSON string.
    const sourceMemories: Memory[] = rawSourceMemories.map((row) => ({
      ...row,
      tags: deserializeTags(row.tags),
      metadata: deserializeMetadata(row.metadata),
    }));

    // Step 3: Merge memories
    let merged;
    try {
      merged = mergeMemories(sourceMemories);
    } catch (error) {
      return {
        ok: false,
        message: 'Merge strategy failed',
        error: error instanceof Error ? error.message : 'Unknown merge error',
      };
    }

    // Step 4: Calculate token savings
    const tokensSaved = estimateTokensSaved(sourceMemories, merged);

    // Step 5: Generate embedding for merged memory
    let embedding: number[] | null = null;
    try {
      embedding = (await getEmbedding(merged.content)) as number[];
    } catch (err) {
      // Continue without embedding if generation fails
    }

    // Steps 6-9: All writes execute atomically in a single transaction
    const canonicalId = randomUUID();
    const now = new Date();
    let historyId = '';

    // Steps 6-9: All writes execute atomically in a single transaction
    await runInTransaction(db, async () => {
      const transactionClient = (db as {
        $client?: {
          prepare?: (query: string) => {
            all: (...params: string[]) => unknown[];
          };
        };
      }).$client;
      if (typeof transactionClient?.prepare !== 'function') {
        throw new Error('Merge approval requires transactional SQLite lifecycle validation');
      }

      // A proposal can sit pending while a source expires or its valid-time
      // window changes. Recheck from the transaction's SQLite connection
      // before creating the canonical row or changing any source state.
      const lifecycleRows = transactionClient.prepare(`
        SELECT id, status, is_active, is_merged, merged_into_id,
          valid_from, valid_to, expires_at
        FROM memories
        WHERE id IN (${sourceIds.map(() => '?').join(', ')})
      `).all(...sourceIds) as Array<{
        id: string;
        status: string;
        is_active: number;
        is_merged: number;
        merged_into_id: string | null;
        valid_from: number | null;
        valid_to: number | null;
        expires_at: number | null;
      }>;
      const nowMs = now.getTime();
      const timestampMs = (value: number | null): number | null => {
        if (value === null) return null;
        if (!Number.isFinite(value)) return Number.NaN;
        return Math.abs(value) >= 100_000_000_000 ? value : value * 1000;
      };
      const isCurrentlyEligible = (source: typeof lifecycleRows[number]): boolean => {
        const validFrom = timestampMs(source.valid_from);
        const validTo = timestampMs(source.valid_to);
        const expiresAt = timestampMs(source.expires_at);
        return source.status === 'active'
          && source.is_active === 1
          && source.is_merged === 0
          && source.merged_into_id === null
          && (validFrom === null || validFrom <= nowMs)
          && (validTo === null || validTo > nowMs)
          && (expiresAt === null || expiresAt > nowMs);
      };
      if (lifecycleRows.length !== sourceIds.length
        || lifecycleRows.some((source) => !isCurrentlyEligible(source))) {
        throw new Error('Cannot approve merge: one or more source memories are inactive, merged, expired, or outside their valid-time window');
      }

      // Step 6: Create canonical memory
      await db.insert(schema.memories).values({
        id: canonicalId,
        projectId: sourceMemories[0].projectId,
        userId: sourceMemories[0].userId,
        type: sourceMemories[0].type,
        content: merged.content,
        summary: merged.summary,
        // bun:sqlite rejects plain number[] bind parameters; store the
        // float32-LE L2-normalized Buffer (null/empty omitted), matching the
        // blob-first reader contracts (parseEmbedding, decodeCandidateEmbedding).
        embedding: encodeEmbeddingBlob(embedding) ?? undefined,
        embeddingModel: embeddingModelFor(embedding) ?? activeEmbeddingModel(),
        embeddingDim: embedding?.length ?? null,
        tags: toSqliteJson(merged.tags),
        metadata: toSqliteJson(merged.metadata),
        source: 'merge',
        confidence: 85, // Merged confidence slightly lower than source
        isActive: true,
        isCanonical: true,
        mergeSourceIds: toSqliteJson(sourceIds),
        isMergeable: true,
        mergeVersion: 1,
        createdAt: now,
        updatedAt: now,
        isPrivate: sourceMemories[0].isPrivate,
        hasSecrets: sourceMemories.some((m) => m.hasSecrets),
        relevanceScore: Math.round(
          sourceMemories.reduce((sum, m) => sum + (m.relevanceScore || 50), 0) / sourceMemories.length
        ),
        accessCount: 0,
        lastAccessedAt: null,
        expiresAt: null,
      } as any);

      // Step 7: Mark source memories as merged (soft archive)
      for (const sourceMemory of sourceMemories) {
        await db
          .update(schema.memories)
          .set({
            isMerged: true,
            mergedIntoId: canonicalId,
            mergedAt: now,
            isActive: false,
            updatedAt: now,
          })
          .where(eq(schema.memories.id, sourceMemory.id));
      }

      // Step 8: Create merge history record (audit trail)
      historyId = randomUUID();
      await db.insert(schema.memoryMergeHistory).values({
        id: historyId,
        projectId: sourceMemories[0].projectId,
        userId: sourceMemories[0].userId,
        proposalId,
        sourceMemoryIds: toSqliteJson(sourceIds),
        canonicalMemoryId: canonicalId,
        // Snapshot stays in STORAGE format (JSON strings) for tags/metadata:
        // reverse-merge writes these values straight back into the TEXT
        // columns, so they must not be the normalized array/object shapes.
        sourceMemoriesSnapshot: toSqliteJson(sourceMemories.map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          summary: m.summary,
          tags: toSqliteTags(m.tags),
          metadata: toSqliteJson(m.metadata),
          createdAt: m.createdAt,
        }))),
        mergeStrategy: sourceMemories[0].type === 'preference' ? 'latest' : 'union',
        tokensSaved,
        isReversed: false,
        mergedAt: now,
      } as any);

      // Step 9: Update proposal status
      await db
        .update(schema.memoryMergeProposals)
        .set({
          status: 'approved',
          reviewedAt: now,
          reviewNotes: reviewNotes || undefined,
        })
        .where(eq(schema.memoryMergeProposals.id, proposalId));
    });

    // Source rows are now inactive. Remove their vectors and feedback from
    // process-local state only after the database transition commits.
    await evictMemoryRuntimeState(sourceIds);

    return {
      ok: true,
      message: `Merge approved and executed. Created canonical memory ${canonicalId}`,
      data: {
        proposalId,
        canonicalMemoryId: canonicalId,
        mergedMemoryIds: sourceIds,
        tokensSaved,
        mergedAt: now.toISOString(),
        // Undo-log anchor: use with reverse action to restore source memories
        mergeHistoryId: historyId,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Failed to approve merge',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
