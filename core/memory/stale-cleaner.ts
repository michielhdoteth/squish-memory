/**
 * Stale Memory Cleaner
 * Deletes memories that are old, low-confidence, and low-importance
 */

import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { lt, or, and, eq, lte, sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { emit } from '../event-bus.js';

export interface StaleMemory {
  id: string;
  content: string;
  type: string;
  createdAt: Date;
  confidenceLevel: string | null;
  importanceScore: number | null;
  isPinned: boolean;
}

export interface StaleMemoryQuery {
  olderThanDays: number;
  confidenceLevels: string[];
  minImportance: number;
  projectId?: string;
}

export async function getStaleMemories(query: StaleMemoryQuery): Promise<StaleMemory[]> {
  const db = await getDb();
  if (!db) return [];
  
  const schema = await getSchema();
  const sqliteDb = db as any;
  
  const cutoffDate = new Date(Date.now() - query.olderThanDays * 24 * 60 * 60 * 1000);
  
  // Build conditions
  const conditions = [
    // Not pinned
    or(
      eq((schema.memories as any).isPinned, false),
      eq((schema.memories as any).isPinned, null)
    ),
    // Older than cutoff
    lt((schema.memories as any).createdAt, cutoffDate),
  ];
  
  // Confidence level filter
  if (query.confidenceLevels.length > 0) {
    conditions.push(
      or(
        ...query.confidenceLevels.map(level => 
          eq((schema.memories as any).confidenceLevel, level)
        )
      )
    );
  }
  
  // Importance filter (below threshold)
  conditions.push(lte((schema.memories as any).importanceScore, query.minImportance));
  
  // Project filter if specified
  if (query.projectId) {
    conditions.push(eq((schema.memories as any).projectId, query.projectId));
  }
  
  try {
    const results = await sqliteDb
      .select({
        id: schema.memories.id,
        content: schema.memories.content,
        type: schema.memories.type,
        createdAt: schema.memories.createdAt,
        confidenceLevel: (schema.memories as any).confidenceLevel,
        importanceScore: (schema.memories as any).importanceScore,
        isPinned: (schema.memories as any).isPinned,
      })
      .from(schema.memories)
      .where(and(...conditions.filter(Boolean)));
    
    return results.map((r: any) => ({
      ...r,
      isPinned: Boolean(r.isPinned),
    }));
  } catch (error) {
    logger.error('[StaleCleaner] Error querying stale memories:', error);
    return [];
  }
}

export async function deleteMemoryPermanently(memoryId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  const schema = await getSchema();
  const sqliteDb = db as any;
  
  try {
    // Delete associated records first
    await sqliteDb.delete(schema.memoryAssociations).where(
      or(
        eq((schema.memoryAssociations as any).fromMemoryId, memoryId),
        eq((schema.memoryAssociations as any).toMemoryId, memoryId)
      )
    ).catch(() => {}); // Ignore if table doesn't exist
    
    // Delete memory tags
    await sqliteDb.delete((schema as any).memoryTags).where(
      eq((schema as any).memoryTags.memoryId, memoryId)
    ).catch(() => {}); // Ignore if table doesn't exist
    
    // Delete the memory itself
    await sqliteDb.delete(schema.memories).where(eq(schema.memories.id, memoryId));

    emit({
      type: 'memory:deleted',
      payload: { memoryId },
    });
  } catch (error) {
    logger.error(`[StaleCleaner] Error deleting memory ${memoryId}:`, error);
    throw error;
  }
}

export async function runAutoClean(options?: Partial<StaleMemoryQuery>): Promise<{
  deleted: number;
  summary: Record<string, unknown>;
}> {
  const defaultOptions: StaleMemoryQuery = {
    olderThanDays: options?.olderThanDays || 30,
    confidenceLevels: options?.confidenceLevels || ['outdated', 'speculative'],
    minImportance: options?.minImportance || 40,
  };
  
  const stale = await getStaleMemories(defaultOptions);
  const idsToDelete = stale.filter(m => !m.isPinned).map(m => m.id);
  
  if (idsToDelete.length > 0) {
    const db = await getDb();
    const schema = await getSchema();
    const sqliteDb = db as any;
    const placeholders = idsToDelete.map(() => '?').join(',');

    // Bulk delete associations
    await sqliteDb.delete(schema.memoryAssociations).where(
      sql`(${(schema.memoryAssociations as any).fromMemoryId} IN (${placeholders})) OR (${(schema.memoryAssociations as any).toMemoryId} IN (${placeholders}))`,
      ...idsToDelete, ...idsToDelete
    ).catch(() => {});

    // Bulk delete tags
    await sqliteDb.delete((schema as any).memoryTags).where(
      sql`${(schema as any).memoryTags.memoryId} IN (${placeholders})`,
      ...idsToDelete
    ).catch(() => {});

    // Bulk delete memories
    await sqliteDb.delete(schema.memories).where(
      sql`${schema.memories.id} IN (${placeholders})`,
      ...idsToDelete
    );

    for (const id of idsToDelete) {
      emit({ type: 'memory:deleted', payload: { memoryId: id } });
    }
  }
  
  return {
    deleted: idsToDelete.length,
    summary: {
      scanned: stale.length,
      skippedPinned: stale.length - idsToDelete.length,
      criteria: defaultOptions,
    },
  };
}
