/** Job Runner - Maintenance job implementations */

import { randomUUID } from 'node:crypto';
import {
  sqlEpochSeconds
} from '../lib/timestamps.js';
import { logger } from '../logger.js';
import { type JobExecutionContext } from './cron-scheduler.js';
import { pruneWeakAssociations } from '../associations.js';
import { pruneOldSummaries } from '../summarization/cleanup.js';
import { getDb } from '../../db/index.js';
import { memories, memoryFeedback } from '../../db/drizzle/schema-sqlite.js';
import { eq, and, gt, lt } from 'drizzle-orm';
import { evictMemoryRuntimeState } from '../memory/runtime-cache-lifecycle.js';

export async function runNightlyJob(context: JobExecutionContext): Promise<{
  recordsProcessed: number;
  summary: Record<string, unknown>;
}> {
  const summary: Record<string, unknown> = {};
  let recordsProcessed = 0;

  logger.info('[NightlyJob] Starting nightly maintenance');

  // Decay is now handled by the cron scheduler's decay_maintenance job
  // (Ebbinghaus engine in core/decay/decay-engine.ts)

  if (context.config.mergeDuplicates !== false) {
    try {
      const { handleDetectDuplicates } = await import('../algorithms/handlers/detect-duplicates.js');
      const dedupResult = await handleDetectDuplicates({ projectId: context.config.projectId as string | undefined });
      summary.duplicatesDetected = dedupResult?.data?.proposalsCreated ?? 0;
      recordsProcessed += summary.duplicatesDetected as number;
      logger.info(`[NightlyJob] Detected ${summary.duplicatesDetected} potential duplicates for review`);
    } catch (error) {
      logger.error('[NightlyJob] Deduplication failed:', error);
      summary.dedupError = error instanceof Error ? error.message : String(error);
    }
  }

  if (context.config.boostAccessed !== false) {
    try {
      const boostResult = await boostFrequentlyAccessed();
      summary.memoriesBoosted = boostResult;
      recordsProcessed += boostResult;
      logger.info(`[NightlyJob] Boosted ${summary.memoriesBoosted} frequently accessed memories`);
    } catch (error) {
      logger.error('[NightlyJob] Boost failed:', error);
      summary.boostError = error instanceof Error ? error.message : String(error);
    }
  }

  logger.info(`[NightlyJob] Completed: ${recordsProcessed} records processed`);

  return { recordsProcessed, summary };
}

export async function runWeeklyJob(context: JobExecutionContext): Promise<{
  recordsProcessed: number;
  summary: Record<string, unknown>;
}> {
  const summary: Record<string, unknown> = {};
  let recordsProcessed = 0;

  logger.info('[WeeklyJob] Starting weekly maintenance');

  if (context.config.archiveStale !== false) {
    try {
      const archiveResult = await archiveStaleMemories(90);
      summary.memoriesArchived = archiveResult;
      recordsProcessed += archiveResult;
      logger.info(`[WeeklyJob] Archived ${summary.memoriesArchived} stale memories`);
    } catch (error) {
      logger.error('[WeeklyJob] Archive failed:', error);
      summary.archiveError = error instanceof Error ? error.message : String(error);
    }
  }

  if (context.config.pruneAssociations !== false) {
    try {
      const pruneResult = await pruneWeakAssociations();
      summary.associationsPruned = typeof pruneResult === 'number' ? pruneResult : 0;
      recordsProcessed += summary.associationsPruned as number;
      logger.info(`[WeeklyJob] Pruned ${summary.associationsPruned} weak associations`);
    } catch (error) {
      logger.error('[WeeklyJob] Association pruning failed:', error);
      summary.pruneError = error instanceof Error ? error.message : String(error);
    }
  }

  if (context.config.pruneSummaries !== false) {
    try {
      const summaryPruneResult = await pruneOldSummaries(30);
      summary.summariesPruned = typeof summaryPruneResult === 'number' ? summaryPruneResult : 0;
      recordsProcessed += summary.summariesPruned as number;
      logger.info(`[WeeklyJob] Pruned ${summary.summariesPruned} old summaries`);
    } catch (error) {
      logger.error('[WeeklyJob] Summary pruning failed:', error);
      summary.summaryPruneError = error instanceof Error ? error.message : String(error);
    }
  }

  if (context.config.cleanupFeedback !== false) {
    try {
      const feedbackCleanupResult = await cleanupOldFeedbackRecords(30);
      summary.feedbackRecordsCleaned = feedbackCleanupResult;
      recordsProcessed += feedbackCleanupResult;
      logger.info(`[WeeklyJob] Cleaned ${summary.feedbackRecordsCleaned} old feedback records`);
    } catch (error) {
      logger.error('[WeeklyJob] Feedback cleanup failed:', error);
      summary.feedbackError = error instanceof Error ? error.message : String(error);
    }
  }

  logger.info(`[WeeklyJob] Completed: ${recordsProcessed} records processed`);

  return { recordsProcessed, summary };
}

async function boostFrequentlyAccessed(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const sqliteDb = db as any;
  const frequentlyAccessed = await sqliteDb
    .select()
    .from(memories)
    .where(gt(memories.accessCount, 3));

  let boosted = 0;
  for (const memory of frequentlyAccessed) {
    const currentPriority = memory.retrievalPriority ?? 50;
    const newPriority = Math.min(100, currentPriority + 5);

    await sqliteDb
      .update(memories)
      .set({ retrievalPriority: newPriority })
      .where(eq(memories.id, memory.id));

    boosted++;
  }

  return boosted;
}

export async function archiveStaleMemories(daysOld: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const sqliteDb = db as any;
  const raw = sqliteDb.$client;

  if (typeof raw.exec !== 'function' || typeof raw.prepare !== 'function') {
    throw new Error('Memory archive requires transactional SQLite storage');
  }

  const thresholdSeconds = Math.floor((Date.now() - daysOld * 24 * 60 * 60 * 1000) / 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const epochSeconds = (column: 'valid_from' | 'valid_to' | 'expires_at') =>
    sqlEpochSeconds(column);
  const lifecycleEligible = `
    AND (valid_from IS NULL OR ${epochSeconds('valid_from')} <= ?)
    AND (valid_to IS NULL OR ${epochSeconds('valid_to')} > ?)
    AND (expires_at IS NULL OR ${epochSeconds('expires_at')} > ?)`;
  const staleMemories = raw.prepare(`
    SELECT id FROM memories
    WHERE context_status = 'out-of-context' AND status = 'active' AND is_active = 1
      AND last_accessed_at < ? AND importance_score < 30 AND is_protected = 0 AND is_pinned = 0
      ${lifecycleEligible}
  `).all(thresholdSeconds, nowSeconds, nowSeconds, nowSeconds) as Array<{ id: string }>;
  if (staleMemories.length === 0) return 0;
  const archiveSource = raw.prepare(`
    UPDATE memories SET context_status = 'archived', status = 'archived', is_active = 0,
      recorded_at = ?, updated_at = ?
    WHERE id = ? AND context_status = 'out-of-context' AND status = 'active' AND is_active = 1
      AND last_accessed_at < ? AND importance_score < 30 AND is_protected = 0 AND is_pinned = 0
      ${lifecycleEligible}
  `);
  const snapshot = raw.prepare(`
    INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, created_at)
    VALUES (?, ?, 'archive', ?, ?, ?)
  `);
  const archiveProjection = raw.prepare(`
    UPDATE knowledge SET status = 'archived', is_active = 0, recorded_at = ?, updated_at = ?
    WHERE knowledge_kind = 'memory'
      AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)
  `);

  let archived = 0;
  const archivedIds: string[] = [];
  raw.exec('BEGIN IMMEDIATE');
  try {
    for (const candidate of staleMemories) {
      const current = raw.prepare('SELECT content, metadata FROM memories WHERE id = ?').get(candidate.id) as { content: string; metadata: string | null } | undefined;
      if (!current) continue;
      archiveSource.run(nowSeconds, nowSeconds, candidate.id, thresholdSeconds, nowSeconds, nowSeconds, nowSeconds);
      // The candidate scan happens before BEGIN IMMEDIATE. Another runtime can
      // complete this lifecycle transition in that gap; do not publish a
      // second archive snapshot or count a transition this invocation did not
      // perform.
      if (raw.prepare('SELECT changes() AS changed').get()?.changed !== 1) continue;
      const archivedSource = raw.prepare("SELECT status, is_active, context_status FROM memories WHERE id = ?").get(candidate.id) as { status: string; is_active: number; context_status: string } | undefined;
      if (archivedSource?.status !== 'archived' || archivedSource.is_active !== 0 || archivedSource.context_status !== 'archived') continue;
      snapshot.run(randomUUID(), candidate.id, current.content, JSON.stringify({
        lifecycle: 'stale_archive',
        priorStatus: 'active',
        priorContextStatus: 'out-of-context',
        priorMetadata: current.metadata,
      }), nowSeconds);
      const projectionChange = archiveProjection.run(nowSeconds, nowSeconds, candidate.id, candidate.id);
      const projectionState = raw.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'archived' AND is_active = 0 THEN 1 ELSE 0 END) AS archived
        FROM knowledge WHERE knowledge_kind = 'memory'
          AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)`)
        .get(candidate.id, candidate.id) as { total: number; archived: number | null };
      if (projectionChange.changes < 1 || projectionState.total < 1 || projectionState.archived !== projectionState.total) {
        throw new Error(`Cannot archive memory ${candidate.id} without its canonical knowledge projection`);
      }
      archived++;
      archivedIds.push(candidate.id);
    }
    raw.exec('COMMIT');
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }

  if (archived > 0) {
    await evictMemoryRuntimeState(archivedIds);
  }

  return archived;
}

async function cleanupOldFeedbackRecords(daysOld: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const oldThreshold = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const sqliteDb = db as any;

  await sqliteDb
    .delete(memoryFeedback)
    .where(lt(memoryFeedback.createdAt, oldThreshold));

  return 0;
}