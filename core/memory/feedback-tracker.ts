/** Feedback Tracker - Track memory usage in responses for Echo/Fizzle loop */

import { logger } from '../logger.js';
import { config } from '../../config.js';
import { getDb } from '../../db/index.js';
import { memoryFeedback, memories, type MemoryFeedback } from '../../db/drizzle/schema-sqlite.js';
import { eq, and } from 'drizzle-orm';
import { findMemoryRefs, hasMemoryRefs } from './response-analyzer.js';

interface InjectionRecord {
  memoryIds: string[];
  memoryContent: Map<string, string>;
  injectedAt: Date;
}

const injectionTracker = new Map<string, InjectionRecord>();

export async function recordInjection(
  sessionId: string,
  memoryIds: string[],
  memoryContent: Map<string, string>
): Promise<void> {
  if (!config.feedbackTrackingEnabled) return;

  injectionTracker.set(sessionId, {
    memoryIds,
    memoryContent,
    injectedAt: new Date(),
  });

  const db = await getDb();
  if (!db) return;

  try {
    const now = new Date();
    const sqliteDb = db as any;
    for (const memoryId of memoryIds) {
      await sqliteDb.insert(memoryFeedback).values({
        memoryId,
        sessionId,
        wasInjected: true,
        wasReferenced: false,
        referenceCount: 0,
        retrievalPriorityDelta: 0,
        injectedAt: now,
      }).onConflictDoNothing();
    }
    logger.debug(`[FeedbackTracker] Recorded injection of ${memoryIds.length} memories for session ${sessionId}`);
  } catch (error) {
    logger.error('[FeedbackTracker] Failed to record injection:', error);
  }
}

export async function analyzeAndRecordFeedback(
  sessionId: string,
  responseText: string
): Promise<void> {
  if (!config.feedbackTrackingEnabled) return;

  const injection = injectionTracker.get(sessionId);
  if (!injection) {
    logger.debug(`[FeedbackTracker] No injection record for session ${sessionId}`);
    return;
  }

  if (!hasMemoryRefs(responseText)) {
    await applyFizzlePenalty(injection.memoryIds);
    injectionTracker.delete(sessionId);
    return;
  }

  const analysis = findMemoryRefs(
    responseText,
    injection.memoryIds,
    injection.memoryContent
  );

  const db = await getDb();
  if (!db) return;

  try {
    const now = new Date();
    const sqliteDb = db as any;

    for (const memoryId of injection.memoryIds) {
      const wasReferenced = analysis.referencedMemoryIds.includes(memoryId);
      const delta = wasReferenced ? config.feedbackEchoBonus : -config.feedbackFizzlePenalty;

      const existing = await sqliteDb
        .select()
        .from(memoryFeedback)
        .where(and(
          eq(memoryFeedback.memoryId, memoryId),
          eq(memoryFeedback.sessionId, sessionId)
        ))
        .limit(1);

      if (existing.length > 0) {
        await sqliteDb
          .update(memoryFeedback)
          .set({
            wasReferenced,
            referenceCount: wasReferenced ? 1 : 0,
            retrievalPriorityDelta: delta,
            referencedAt: wasReferenced ? now : null,
          })
          .where(eq(memoryFeedback.id, existing[0].id));
      }

      await updateRetrievalPriority(memoryId, delta);
    }

    logger.info(
      `[FeedbackTracker] Feedback recorded: ${analysis.referenceCount} echoes, ${injection.memoryIds.length - analysis.referenceCount} fizzles`
    );

    injectionTracker.delete(sessionId);
  } catch (error) {
    logger.error('[FeedbackTracker] Failed to record feedback:', error);
  }
}

async function applyFizzlePenalty(memoryIds: string[]): Promise<void> {
  try {
    for (const memoryId of memoryIds) {
      await updateRetrievalPriority(memoryId, -config.feedbackFizzlePenalty);
    }
    logger.debug(`[FeedbackTracker] Applied fizzle penalty to ${memoryIds.length} memories`);
  } catch (error) {
    logger.error('[FeedbackTracker] Failed to apply fizzle penalty:', error);
  }
}

export async function updateRetrievalPriority(memoryId: string, delta: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    const sqliteDb = db as any;
    const [memory] = await sqliteDb
      .select({ retrievalPriority: memories.retrievalPriority })
      .from(memories)
      .where(eq(memories.id, memoryId))
      .limit(1);

    if (!memory) return;

    const currentPriority = memory.retrievalPriority ?? 50;
    const newPriority = Math.max(0, Math.min(100, currentPriority + delta));

    await sqliteDb
      .update(memories)
      .set({ retrievalPriority: newPriority })
      .where(eq(memories.id, memoryId));

    logger.debug(`[FeedbackTracker] Updated priority for ${memoryId}: ${currentPriority} -> ${newPriority}`);
  } catch (error) {
    logger.error('[FeedbackTracker] Failed to update retrieval priority:', error);
  }
}

export async function getMemoryFeedbackStats(memoryId: string): Promise<{
  totalInjections: number;
  totalReferences: number;
  echoRate: number;
  averagePriorityDelta: number;
}> {
  const db = await getDb();
  if (!db) {
    return { totalInjections: 0, totalReferences: 0, echoRate: 0, averagePriorityDelta: 0 };
  }

  try {
    const sqliteDb = db as any;
    const records = await sqliteDb
      .select()
      .from(memoryFeedback)
      .where(eq(memoryFeedback.memoryId, memoryId));

    const totalInjections = records.filter((r: MemoryFeedback) => r.wasInjected).length;
    const totalReferences = records.filter((r: MemoryFeedback) => r.wasReferenced).length;
    const echoRate = totalInjections > 0 ? totalReferences / totalInjections : 0;
    const totalDelta = records.reduce((sum: number, r: MemoryFeedback) => sum + (r.retrievalPriorityDelta ?? 0), 0);
    const averagePriorityDelta = records.length > 0 ? totalDelta / records.length : 0;

    return { totalInjections, totalReferences, echoRate, averagePriorityDelta };
  } catch (error) {
    logger.error('[FeedbackTracker] Failed to get feedback stats:', error);
    return { totalInjections: 0, totalReferences: 0, echoRate: 0, averagePriorityDelta: 0 };
  }
}

export function cleanupInjectionTracker(maxAgeMs: number = 3600000): void {
  const now = Date.now();
  for (const [sessionId, injection] of injectionTracker.entries()) {
    if (now - injection.injectedAt.getTime() > maxAgeMs) {
      injectionTracker.delete(sessionId);
    }
  }
}
