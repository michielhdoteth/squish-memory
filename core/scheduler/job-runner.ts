/** Job Runner - Maintenance job implementations */

import { logger } from '../logger.js';
import { type JobExecutionContext } from './cron-scheduler.js';
import { pruneWeakAssociations } from '../associations.js';
import { pruneOldSummaries } from '../summarization/cleanup.js';
import { getDb } from '../../db/index.js';
import { memories, memoryFeedback } from '../../db/drizzle/schema-sqlite.js';
import { eq, and, gt, lt } from 'drizzle-orm';

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

async function archiveStaleMemories(daysOld: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const staleThreshold = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const sqliteDb = db as any;

  // Single UPDATE — avoids N+1 select-then-update loop
  // First count what we'll archive (for the return value)
  const staleMemories = await sqliteDb
    .select({ id: memories.id })
    .from(memories)
    .where(and(
      lt(memories.lastAccessedAt, staleThreshold),
      lt(memories.importanceScore, 30),
      eq(memories.isProtected, false),
      eq(memories.isPinned, false),
      eq(memories.contextStatus, 'out-of-context'),
    ));

  if (staleMemories.length === 0) return 0;

  const staleIds = staleMemories.map((m: any) => m.id);

  // Batch update all at once using inArray
  const { inArray } = await import('drizzle-orm');
  await sqliteDb
    .update(memories)
    .set({
      contextStatus: 'archived',
      updatedAt: new Date(),
    })
    .where(inArray(memories.id, staleIds));

  return staleIds.length;
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
