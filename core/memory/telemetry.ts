/**
 * Retrieval Quality Telemetry
 * Tracks memory usage patterns (echo/fizzle) to improve retrieval quality
 * Echo: memory was retrieved and used
 * Fizzle: memory was retrieved but not used
 */

import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';

export interface RetrievalEvent {
  memoryId: string;
  query: string;
  position: number; // Position in results
  score: number;
  wasUsed: boolean; // true = echo, false = fizzle
  sessionId?: string;
  timestamp: Date;
}

export interface RetrievalStats {
  totalRetrievals: number;
  echoes: number;
  fizzles: number;
  echoRate: number;
  avgPosition: number;
  topMemories: string[];
  underperformingMemories: string[];
}

export interface MemoryTelemetry {
  memoryId: string;
  retrievalCount: number;
  echoCount: number;
  fizzleCount: number;
  echoRate: number;
  avgPosition: number;
  lastRetrieved?: Date;
  lastEchoed?: Date;
}

// In-memory cache for recent retrieval events (flushed periodically)
const retrievalEvents: RetrievalEvent[] = [];
const MAX_CACHE_SIZE = 1000;
const FLUSH_INTERVAL_MS = 60_000; // 60 seconds

let flushIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic telemetry flush interval.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
export function startTelemetry(): void {
  if (flushIntervalId !== null) return;
  flushIntervalId = setInterval(() => {
    flushRetrievalEvents().catch(err => {
      logger.error('Periodic telemetry flush failed', err);
    });
  }, FLUSH_INTERVAL_MS);
  logger.debug('[Telemetry] Periodic flush started', { intervalMs: FLUSH_INTERVAL_MS });
}

/**
 * Stop the periodic flush interval and flush any remaining events.
 * Should be called during graceful shutdown.
 */
export async function stopTelemetry(): Promise<void> {
  if (flushIntervalId !== null) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
    logger.debug('[Telemetry] Periodic flush stopped');
  }
  // Drain remaining events before shutdown
  await flushRetrievalEvents();
}

/**
 * Record a retrieval event
 */
export function recordRetrieval(
  memoryId: string,
  query: string,
  position: number,
  score: number,
  sessionId?: string
): void {
  const event: RetrievalEvent = {
    memoryId,
    query,
    position,
    score,
    wasUsed: false, // Initially false, updated when echoed
    sessionId,
    timestamp: new Date(),
  };
  
  // Auto-start periodic flush on first event if not already running
  if (flushIntervalId === null) {
    startTelemetry();
  }

  retrievalEvents.push(event);
  
  // Flush if cache is full
  if (retrievalEvents.length >= MAX_CACHE_SIZE) {
    flushRetrievalEvents().catch(err => {
      logger.error('Failed to flush retrieval events', err);
    });
  }
}

/**
 * Mark a retrieval as "echoed" (memory was actually used)
 */
export function recordEcho(
  memoryId: string,
  sessionId?: string
): void {
  // Find the most recent retrieval for this memory
  const recentIndex = retrievalEvents.findIndex(
    (e, i) => 
      e.memoryId === memoryId && 
      !e.wasUsed &&
      (sessionId ? e.sessionId === sessionId : true)
  );
  
  if (recentIndex !== -1) {
    retrievalEvents[recentIndex].wasUsed = true;
  } else {
    // Add a new echo event if not found in cache
    retrievalEvents.push({
      memoryId,
      query: '',
      position: 0,
      score: 0,
      wasUsed: true,
      sessionId,
      timestamp: new Date(),
    });
  }
  
  // Update memory's echo count directly
  incrementMemoryEcho(memoryId).catch(err => {
    logger.debug('Failed to increment echo count', err);
  });
}

/**
 * Mark retrievals as "fizzled" (memory was not used)
 * Call this at the end of a session for non-echoed retrievals
 */
export function recordFizzle(
  memoryId: string,
  sessionId?: string
): void {
  incrementMemoryFizzle(memoryId).catch(err => {
    logger.debug('Failed to increment fizzle count', err);
  });
}

/**
 * Flush cached retrieval events to database
 */
export async function flushRetrievalEvents(): Promise<void> {
  if (retrievalEvents.length === 0) return;
  
  const events = [...retrievalEvents];
  retrievalEvents.length = 0; // Clear cache
  
  try {
    const db = await getDb();
    const schema = await getSchema();
    
    // Group by memoryId for batch updates
    const byMemory = new Map<string, RetrievalEvent[]>();
    for (const event of events) {
      const existing = byMemory.get(event.memoryId) || [];
      existing.push(event);
      byMemory.set(event.memoryId, existing);
    }
    
    // Update each memory's telemetry
    for (const [memoryId, memEvents] of byMemory.entries()) {
      const echoCount = memEvents.filter(e => e.wasUsed).length;
      const fizzleCount = memEvents.filter(e => !e.wasUsed).length;
      
      // Get current stats
      const memories = await (db as any)
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.id, memoryId))
        .limit(1);
      
      if (memories.length > 0) {
        const current = memories[0];
        const newEchoCount = (current.echoCount || 0) + echoCount;
        const newFizzleCount = (current.fizzleCount || 0) + fizzleCount;
        const newRetrievalCount = (current.retrievalCount || 0) + memEvents.length;
        
        await (db as any)
          .update(schema.memories)
          .set({
            echoCount: newEchoCount,
            fizzleCount: newFizzleCount,
            retrievalCount: newRetrievalCount,
            lastRetrievedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.memories.id, memoryId));
      }
    }
    
    logger.debug('Flushed retrieval events', { count: events.length });
    
  } catch (error) {
    logger.error('Error flushing retrieval events', error);
    // Re-add events to cache on failure
    retrievalEvents.push(...events);
  }
}

/**
 * Increment memory's echo count directly
 */
async function incrementMemoryEcho(memoryId: string): Promise<void> {
  try {
    const db = await getDb();
    const schema = await getSchema();
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);
    
    if (memories.length > 0) {
      const current = memories[0];
      await (db as any)
        .update(schema.memories)
        .set({
          echoCount: (current.echoCount || 0) + 1,
          lastEchoedAt: new Date(),
          coactivationScore: (current.coactivationScore || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.memories.id, memoryId));
    }
  } catch (error) {
    logger.debug('Error incrementing echo count', { error });
  }
}

/**
 * Increment memory's fizzle count directly
 */
async function incrementMemoryFizzle(memoryId: string): Promise<void> {
  try {
    const db = await getDb();
    const schema = await getSchema();
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);
    
    if (memories.length > 0) {
      const current = memories[0];
      await (db as any)
        .update(schema.memories)
        .set({
          fizzleCount: (current.fizzleCount || 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.memories.id, memoryId));
    }
  } catch (error) {
    logger.debug('Error incrementing fizzle count', { error });
  }
}

/**
 * Get telemetry for a specific memory
 */
export async function getMemoryTelemetry(memoryId: string): Promise<MemoryTelemetry | null> {
  try {
    const db = await getDb();
    const schema = await getSchema();
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);
    
    if (memories.length === 0) return null;
    
    const m = memories[0];
    const echoCount = m.echoCount || 0;
    const fizzleCount = m.fizzleCount || 0;
    const total = echoCount + fizzleCount;
    
    return {
      memoryId: m.id,
      retrievalCount: m.retrievalCount || 0,
      echoCount,
      fizzleCount,
      echoRate: total > 0 ? echoCount / total : 0,
      avgPosition: 0, // Would need to calculate from retrieval events
      lastRetrieved: m.lastRetrievedAt,
      lastEchoed: m.lastEchoedAt,
    };
    
  } catch (error) {
    logger.error('Error getting memory telemetry', error);
    return null;
  }
}

/**
 * Get overall retrieval statistics
 */
export async function getRetrievalStats(projectId?: string): Promise<RetrievalStats> {
  try {
    const db = await getDb();
    const schema = await getSchema();
    
    const whereClause = projectId
      ? eq(schema.memories.projectId, projectId)
      : undefined;
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(whereClause)
      .orderBy(desc(schema.memories.retrievalCount))
      .limit(1000);
    
    let totalRetrievals = 0;
    let totalEchoes = 0;
    let totalFizzles = 0;
    const topMemories: string[] = [];
    const underperforming: string[] = [];
    
    for (const m of memories) {
      const echoes = m.echoCount || 0;
      const fizzles = m.fizzleCount || 0;
      const retrievals = m.retrievalCount || 0;
      
      totalRetrievals += retrievals;
      totalEchoes += echoes;
      totalFizzles += fizzles;
      
      // Top performers (high echo rate with sufficient data)
      if (echoes >= 3 && (echoes / (echoes + fizzles)) >= 0.8) {
        topMemories.push(m.id);
      }
      
      // Underperformers (high fizzle rate with sufficient data)
      if (fizzles >= 5 && (fizzles / (echoes + fizzles)) >= 0.7) {
        underperforming.push(m.id);
      }
    }
    
    const echoRate = (totalEchoes + totalFizzles) > 0
      ? totalEchoes / (totalEchoes + totalFizzles)
      : 0;
    
    return {
      totalRetrievals,
      echoes: totalEchoes,
      fizzles: totalFizzles,
      echoRate,
      avgPosition: 0, // Would need more detailed tracking
      topMemories: topMemories.slice(0, 10),
      underperformingMemories: underperforming.slice(0, 10),
    };
    
  } catch (error) {
    logger.error('Error getting retrieval stats', error);
    return {
      totalRetrievals: 0,
      echoes: 0,
      fizzles: 0,
      echoRate: 0,
      avgPosition: 0,
      topMemories: [],
      underperformingMemories: [],
    };
  }
}

/**
 * Adjust retrieval boosting based on echo/fizzle history
 * Returns a boost factor (0.5 - 2.0) for a memory
 */
export function calculateTelemetryBoost(telemetry: MemoryTelemetry | null): number {
  if (!telemetry || telemetry.retrievalCount < 3) {
    return 1.0; // Not enough data
  }
  
  const echoRate = telemetry.echoRate;
  
  // High echo rate = boost
  if (echoRate >= 0.8) {
    return 1.5;
  } else if (echoRate >= 0.6) {
    return 1.2;
  } else if (echoRate >= 0.4) {
    return 1.0;
  } else if (echoRate >= 0.2) {
    return 0.8;
  } else {
    return 0.5; // Low echo rate = penalize
  }
}

/**
 * Periodic cleanup job for telemetry data
 */
export async function cleanupOldTelemetry(daysToKeep: number = 90): Promise<number> {
  // This would typically clean up a dedicated telemetry_events table
  // For now, we just flush the in-memory cache
  await flushRetrievalEvents();
  return 0;
}
