/**
 * Memory Statistics Module
 * Provides memory usage statistics for CLI and MCP
 */

import { eq, and, sql, asc, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import { getProjectByPath } from '../../core/projects.js';
import { createDatabaseClient } from '../storage/database.js';
import { getProjectSignalStats } from '../session/working-set.js';
import { logger } from '../logger.js';
import { getMemoryAssociationRows } from '../associations.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export interface MemoryStats {
  totalMemories: number;
  /**
   * Live durable memories: rows in this project that are still active.
   * Unlike the working-set signal counter (stats.signal.durable), which is
   * an append-only capture count that never decreases on delete/merge/supersede,
   * this is a live row count and can therefore never exceed totalMemories.
   */
  durableMemories?: number;
  byType: Record<string, number>;
  totalNotes: number;
  notesByCategory: Record<string, number>;
  totalLearnings: number;
  learningsByType: Record<string, number>;
  totalLinks: number;
  oldestMemory?: string;
  newestMemory?: string;
  projectPath: string;
  mode: string;
  signal?: {
    captured: number;
    suppressed: number;
    sessionOnly: number;
    durable: number;
    durableWithRaw: number;
    tokensSaved: number;
    placeRouted: number;
    graphEnriched: number;
  };
}

/**
 * Get memory statistics for a project
 */
export async function getMemoryStats(projectPath?: string): Promise<MemoryStats> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface('memory_statistics', 'memory', 'Unscoped memory statistics are disabled under strict trust');
  }

  let db: any;
  try {
    db = createDatabaseClient(await getDb());
  } catch (error) {
    throw new Error(`Database unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  const schema = await getSchema();
  const resolvedPath = projectPath || process.cwd();
  const project = await getProjectByPath(resolvedPath);
  if (!project) {
    // No project registered yet — return empty stats instead of throwing
    return {
      totalMemories: 0,
      durableMemories: 0,
      byType: {},
      totalNotes: 0,
      notesByCategory: {},
      totalLearnings: 0,
      learningsByType: {},
      totalLinks: 0,
      projectPath: resolvedPath,
      mode: 'local',
    };
  }

  const stats: MemoryStats = {
    totalMemories: 0,
    byType: {},
    totalNotes: 0,
    notesByCategory: {},
    totalLearnings: 0,
    learningsByType: {},
    totalLinks: 0,
    projectPath: resolvedPath,
    mode: 'local',
  };

  try {
    // Count total memories
    const countResult = await db
      .select({ count: schema.memories.id })
      .from(schema.memories)
      .where(eq(schema.memories.projectId, project.id));

    stats.totalMemories = countResult.length;

    // Live durable count: still-active memory rows in this project.
    // (signal.durable below is the cumulative capture counter - it inflates
    // past this whenever a memory is deleted or merged away.)
    const durableCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.memories)
      .where(and(eq(schema.memories.projectId, project.id), eq(schema.memories.isActive, true)));

    stats.durableMemories = Number(durableCount[0]?.count ?? 0);

    // Count by type - get all and count in memory
    const allMemories = await db
      .select({ id: schema.memories.id, type: schema.memories.type })
     .from(schema.memories)
     .where(eq(schema.memories.projectId, project.id));

    for (const mem of allMemories) {
      const type = mem.type || 'unknown';
      stats.byType[type] = (stats.byType[type] || 0) + 1;
    }

    // Get oldest and newest
    const oldest = await db
      .select({ createdAt: schema.memories.createdAt })
       .from(schema.memories)
       .where(eq(schema.memories.projectId, project.id))
       .orderBy(asc(schema.memories.createdAt))
      .limit(1);

    const newest = await db
      .select({ createdAt: schema.memories.createdAt })
       .from(schema.memories)
       .where(eq(schema.memories.projectId, project.id))
       .orderBy(desc(schema.memories.createdAt))
      .limit(1);

    if (oldest.length > 0 && oldest[0].createdAt) {
      stats.oldestMemory = oldest[0].createdAt;
    }
    if (newest.length > 0 && newest[0].createdAt) {
      stats.newestMemory = newest[0].createdAt;
    }

    // Learnings
    const allLearnings = await db
      .select({ category: schema.learnings.category, type: schema.learnings.type })
       .from(schema.learnings)
       .where(eq(schema.learnings.projectId, project.id));

    stats.totalNotes = allLearnings.length;
    for (const obs of allLearnings) {
      const cat = obs.category || 'uncategorized';
      stats.notesByCategory[cat] = (stats.notesByCategory[cat] || 0) + 1;
    }

    // Learnings by type
    const learningTypes = ['success', 'failure', 'fix', 'insight'];
    const learningRecords = allLearnings.filter((o: any) => {
      const type = o.type || '';
      return learningTypes.includes(type.toLowerCase());
    });
    stats.totalLearnings = learningRecords.length;
    // Count by type
    for (const obs of learningRecords) {
      const type = (obs as any).type || 'unknown';
      stats.learningsByType[type] = (stats.learningsByType[type] || 0) + 1;
    }

    const projectMemoryIds = new Set<string>(allMemories.map((memory: { id: string }) => memory.id));
    stats.totalLinks = (await getMemoryAssociationRows())
      .filter((association) => projectMemoryIds.has(association.fromMemoryId)).length;

  } catch (error) {
    // Return empty stats on error
    logger.error('Error getting memory stats:', error);
  }

  stats.signal = await getProjectSignalStats(resolvedPath);

  return stats;
}
