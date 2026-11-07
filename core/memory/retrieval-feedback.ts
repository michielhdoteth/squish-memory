/**
 * Retrieval Feedback System
 * 
 * Tracks whether retrieved memories were useful in responses.
 * Strengthens useful paths, prunes stale nodes, tunes edge weights.
 */

import { logger } from '../logger.js';
import { adjustAssociationsForMemory } from '../associations.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetrievalFeedback {
  memoryId: string;
  query: string;
  wasUseful: boolean;
  cited: boolean; // Was the memory cited in the response?
  responseId?: string;
  timestamp: Date;
}

export interface FeedbackStats {
  totalRetrievals: number;
  usefulRetrievals: number;
  citedRetrievals: number;
  usefulnessRate: number;
  citationRate: number;
}

// ─── In-Memory Feedback Buffer ───────────────────────────────────────────────

const feedbackBuffer = new Map<string, RetrievalFeedback[]>();
const invalidatedFeedback = new WeakSet<RetrievalFeedback>();
const inFlightSnapshots = new Set<Map<string, RetrievalFeedback[]>>();
const MAX_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 60000; // 1 minute

let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Record that a memory was retrieved for a query.
 * Call this when a memory appears in search results.
 */
export function recordFeedback(
  memoryId: string,
  query: string,
  options?: { sessionId?: string }
): void {
  if (isStrictTrustPolicy()) return;
  const key = options?.sessionId || 'default';
  const buffer = feedbackBuffer.get(key) || [];

  buffer.push({
    memoryId,
    query,
    wasUseful: false, // Will be updated later
    cited: false,
    timestamp: new Date(),
  });

  // Trim buffer if too large
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
  }

  feedbackBuffer.set(key, buffer);
}

/**
 * Record that a retrieved memory was actually useful.
 * Call this when a memory is cited or referenced in a response.
 */
export function recordUsefulRetrieval(
  memoryId: string,
  query: string,
  options?: { 
    cited?: boolean;
    responseId?: string;
    sessionId?: string;
  }
): void {
  if (isStrictTrustPolicy()) return;
  const key = options?.sessionId || 'default';
  const buffer = feedbackBuffer.get(key) || [];

  // Find the existing retrieval record and update it
  const existing = buffer.find(f => f.memoryId === memoryId && f.query === query && !f.wasUseful);
  if (existing) {
    existing.wasUseful = true;
    existing.cited = options?.cited ?? false;
    existing.responseId = options?.responseId;
  } else {
    // Add a new record
    buffer.push({
      memoryId,
      query,
      wasUseful: true,
      cited: options?.cited ?? false,
      responseId: options?.responseId,
      timestamp: new Date(),
    });
  }

  feedbackBuffer.set(key, buffer);
}

/**
 * Record that a memory was cited in a response.
 * This is stronger feedback than just "useful" - it means the memory
 * was explicitly referenced.
 * Also triggers resurrection reinforcement on the cited memory.
 */
export async function recordCitation(
  memoryId: string,
  responseId: string,
  options?: { sessionId?: string; relevance?: number; answerConfidence?: number }
): Promise<void> {
  if (isStrictTrustPolicy()) return;
  const key = options?.sessionId || 'default';
  const buffer = feedbackBuffer.get(key) || [];

  // Mark all retrievals of this memory as useful
  for (const feedback of buffer) {
    if (feedback.memoryId === memoryId) {
      feedback.wasUseful = true;
      feedback.cited = true;
      feedback.responseId = responseId;
    }
  }

  feedbackBuffer.set(key, buffer);

  // Trigger resurrection reinforcement for cited memory
  try {
    const { reinforceMemory } = await import('./resurrection.js');
    await reinforceMemory({
      memoryId,
      signal: 'successful_use',
      relevance: options?.relevance ?? 0.8,
      answerConfidence: options?.answerConfidence ?? 0.9,
    });
  } catch {
    // Best-effort — don't break feedback flow if resurrection fails
  }
}

/**
 * Get feedback statistics for a specific memory.
 */
export function getRetrievalStats(memoryId: string): FeedbackStats {
  if (isStrictTrustPolicy()) return emptyFeedbackStats();
  let totalRetrievals = 0;
  let usefulRetrievals = 0;
  let citedRetrievals = 0;

  for (const [, buffer] of feedbackBuffer) {
    for (const feedback of buffer) {
      if (feedback.memoryId === memoryId) {
        totalRetrievals++;
        if (feedback.wasUseful) usefulRetrievals++;
        if (feedback.cited) citedRetrievals++;
      }
    }
  }

  return {
    totalRetrievals,
    usefulRetrievals,
    citedRetrievals,
    usefulnessRate: totalRetrievals > 0 ? usefulRetrievals / totalRetrievals : 0,
    citationRate: totalRetrievals > 0 ? citedRetrievals / totalRetrievals : 0,
  };
}

/**
 * Get overall feedback statistics.
 */
export function getOverallFeedbackStats(): FeedbackStats {
  if (isStrictTrustPolicy()) return emptyFeedbackStats();
  let totalRetrievals = 0;
  let usefulRetrievals = 0;
  let citedRetrievals = 0;

  for (const [, buffer] of feedbackBuffer) {
    for (const feedback of buffer) {
      totalRetrievals++;
      if (feedback.wasUseful) usefulRetrievals++;
      if (feedback.cited) citedRetrievals++;
    }
  }

  return {
    totalRetrievals,
    usefulRetrievals,
    citedRetrievals,
    usefulnessRate: totalRetrievals > 0 ? usefulRetrievals / totalRetrievals : 0,
    citationRate: totalRetrievals > 0 ? citedRetrievals / totalRetrievals : 0,
  };
}

/** Remove buffered query/feedback records for memories that were revised or erased. */
export function evictMemoriesFromRetrievalFeedback(memoryIds: readonly string[]): number {
  const ids = new Set(memoryIds);
  if (ids.size === 0) return 0;
  let removed = 0;
  for (const [sessionId, buffer] of feedbackBuffer) {
    const retained = buffer.filter((feedback) => {
      if (!ids.has(feedback.memoryId)) return true;
      if (!invalidatedFeedback.has(feedback)) {
        invalidatedFeedback.add(feedback);
        removed++;
      }
      return false;
    });
    if (retained.length === 0) feedbackBuffer.delete(sessionId);
    else if (retained.length !== buffer.length) feedbackBuffer.set(sessionId, retained);
  }
  for (const snapshot of inFlightSnapshots) {
    for (const buffer of snapshot.values()) {
      for (const feedback of buffer) {
        if (ids.has(feedback.memoryId) && !invalidatedFeedback.has(feedback)) {
          invalidatedFeedback.add(feedback);
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Flush feedback to the database, updating association weights.
 */
export async function flushFeedback(): Promise<{
  strengthened: number;
  weakened: number;
  total: number;
}> {
  if (isStrictTrustPolicy()) {
    feedbackBuffer.clear();
    return { strengthened: 0, weakened: 0, total: 0 };
  }
  // Swap-and-flush: snapshot current buffer, replace with empty map
  // so new writes during flush go to the new map (no lost updates)
  const snapshot = new Map(feedbackBuffer);
  inFlightSnapshots.add(snapshot);
  feedbackBuffer.clear();

  let strengthened = 0;
  let weakened = 0;
  let total = 0;

  for (const [, buffer] of snapshot) {
    for (const feedback of buffer) {
      if (invalidatedFeedback.has(feedback)) continue;
      total++;

      try {
        const updated = await adjustAssociationsForMemory(
          feedback.memoryId,
          feedback.wasUseful ? 1 : -0.5,
          1,
          feedback.wasUseful,
          () => !invalidatedFeedback.has(feedback),
        );
        if (feedback.wasUseful) strengthened += updated;
        else weakened += updated;
      } catch (error) {
        logger.debug('Error updating association weights', {
          memoryId: feedback.memoryId,
          error: error as Error,
        });
      }
    }
  }

  logger.info('Feedback flushed', { strengthened, weakened, total });
  inFlightSnapshots.delete(snapshot);

  return { strengthened, weakened, total };
}

/**
 * Start the periodic feedback flush timer.
 */
export function startFeedbackFlushTimer(): void {
  if (flushTimer) return;

  flushTimer = setInterval(async () => {
    try {
      await flushFeedback();
    } catch (error) {
      logger.error('Error flushing feedback', { error: error as Error });
    }
  }, FLUSH_INTERVAL_MS);

  logger.info('Feedback flush timer started', { intervalMs: FLUSH_INTERVAL_MS });
}

/**
 * Stop the periodic feedback flush timer.
 */
export function stopFeedbackFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
    logger.info('Feedback flush timer stopped');
  }
}

function emptyFeedbackStats(): FeedbackStats {
  return { totalRetrievals: 0, usefulRetrievals: 0, citedRetrievals: 0, usefulnessRate: 0, citationRate: 0 };
}
