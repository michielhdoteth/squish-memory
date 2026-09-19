/**
 * Reverses/undoes a completed merge and restores original memories.
 *
 * Semantics:
 * - Sources are only restored if they still point at this merge's canonical
 *   memory (mergedIntoId matches). Sources re-merged into a different
 *   canonical are reported in skippedMemoryIds and left untouched.
 * - Source content/tags/metadata are restored from the stored snapshot,
 *   not just merge flags.
 */

import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient, runInTransaction } from '../../../core/storage/database.js';
import { eq, and } from 'drizzle-orm';
import { asArray } from '../utils/json-fields.js';

interface ReverseMergeInput {
  mergeHistoryId: string;
  reason?: string;
}

interface ReverseMergeResponse {
  ok: boolean;
  message: string;
  data?: {
    mergeHistoryId: string;
    canonicalMemoryId: string;
    restoredMemoryIds: string[];
    skippedMemoryIds: string[];
    reversedAt: string;
  };
  error?: string;
}

interface SourceSnapshot {
  id: string;
  type?: string;
  content?: string;
  summary?: string | null;
  tags?: unknown;
  metadata?: unknown;
  createdAt?: Date | string | null;
  embedding?: unknown;
  embeddingJson?: unknown;
}

export async function handleReverseMerge(input: ReverseMergeInput): Promise<ReverseMergeResponse> {
  try {
    const { mergeHistoryId, reason } = input;

    if (!mergeHistoryId) {
      return {
        ok: false,
        message: 'mergeHistoryId is required',
        error: 'mergeHistoryId is required',
      };
    }

    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Step 1: Load merge history record
    const [history] = await db
      .select()
      .from(schema.memoryMergeHistory)
      .where(eq(schema.memoryMergeHistory.id, mergeHistoryId));

    if (!history) {
      return {
        ok: false,
        message: 'Merge history record not found',
        error: `Merge history ${mergeHistoryId} not found`,
      };
    }

    // Check if already reversed
    if (history.isReversed) {
      return {
        ok: false,
        message: 'Merge already reversed',
        error: 'This merge has already been reversed',
      };
    }

    // Step 2: Load canonical memory (needed for userId on the audit record)
    const [canonicalMemory] = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, history.canonicalMemoryId));

    if (!canonicalMemory) {
      return {
        ok: false,
        message: 'Canonical memory not found',
        error: `Canonical memory ${history.canonicalMemoryId} not found`,
      };
    }

    const now = new Date();

    // Step 3: Load source snapshots
    const sourceSnapshot = asArray<SourceSnapshot>(history.sourceMemoriesSnapshot);
    const sourceMemoryIds = asArray<string>(history.sourceMemoryIds);

    if (sourceSnapshot.length === 0) {
      return {
        ok: false,
        message: 'No snapshot data to restore from',
        error: 'Merge history has no source memories snapshot',
      };
    }

    // Step 4: Load current state of each candidate source for the stale check.
    // Only sources that still point at THIS merge's canonical can be restored.
    const candidateIds = sourceSnapshot.map((s) => s.id);
    const currentStates = await db
      .select({ id: schema.memories.id, mergedIntoId: schema.memories.mergedIntoId })
      .from(schema.memories)
      .where(eq(schema.memories.mergedIntoId, history.canonicalMemoryId));
    const restorableIds = new Set(currentStates.map((row: { id: string }) => row.id));

    const skippedMemoryIds: string[] = [];
    for (const id of candidateIds) {
      if (!restorableIds.has(id)) {
        skippedMemoryIds.push(id);
      }
    }

    const restorableSnapshots = sourceSnapshot.filter(
      (snapshotData) => restorableIds.has(snapshotData.id)
    );

    // Steps 5-7: All writes execute atomically in a single transaction
    let restoredMemoryIds: string[] = [];
    await runInTransaction(db, async () => {
      restoredMemoryIds = [];

      // Step 5: Restore each eligible source memory from its snapshot.
      // The mergedIntoId condition is re-checked inside the transaction so a
      // concurrent re-merge between the guard check and the write cannot be
      // silently clobbered; such rows are reported as skipped.
      for (const snapshotData of restorableSnapshots) {
        const updated = await db
          .update(schema.memories)
          .set({
            isMerged: false,
            mergedIntoId: null,
            mergedAt: null,
            isActive: true,
            content: snapshotData.content,
            summary: snapshotData.summary ?? undefined,
            tags: snapshotData.tags as any,
            metadata: snapshotData.metadata as any,
            // Restore embeddings from the snapshot when present; otherwise
            // null them so they regenerate lazily on next access.
            embedding: (snapshotData.embedding ?? null) as any,
            embeddingJson: (snapshotData.embeddingJson ?? null) as any,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.memories.id, snapshotData.id),
              eq(schema.memories.mergedIntoId, history.canonicalMemoryId)
            )
          );

        // Driver-specific affected-row count: better-sqlite3/bun report
        // `changes`, postgres reports `rowCount`
        const affected = (updated as any)?.changes ?? (updated as any)?.rowCount ?? (updated as any)?.rowsAffected;
        if (affected === undefined || Number(affected) > 0) {
          restoredMemoryIds.push(snapshotData.id);
        } else {
          skippedMemoryIds.push(snapshotData.id);
        }
      }

      // Step 6: Deactivate canonical memory
      await db
        .update(schema.memories)
        .set({
          isActive: false,
          updatedAt: now,
        })
        .where(eq(schema.memories.id, history.canonicalMemoryId));

      // Step 7: Update merge history record
      await db
        .update(schema.memoryMergeHistory)
        .set({
          isReversed: true,
          reversedAt: now,
          reversedBy: canonicalMemory.userId,
        })
        .where(eq(schema.memoryMergeHistory.id, mergeHistoryId));
    });

    return {
      ok: true,
      message:
        skippedMemoryIds.length > 0
          ? `Merge reversed. Restored ${restoredMemoryIds.length} memories, skipped ${skippedMemoryIds.length} (stale or missing)${reason ? `: ${reason}` : ''}`
          : `Merge reversed successfully. Restored ${restoredMemoryIds.length} memories${reason ? `: ${reason}` : ''}`,
      data: {
        mergeHistoryId,
        canonicalMemoryId: history.canonicalMemoryId,
        restoredMemoryIds,
        skippedMemoryIds,
        reversedAt: now.toISOString(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Failed to reverse merge',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
