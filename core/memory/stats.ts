/**
 * Memory Statistics Module
 * Provides memory usage statistics for CLI and MCP
 */

import { eq, sql, asc, desc } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import { getProjectByPath } from '../../core/projects.js';
import { createDatabaseClient } from '../storage/database.js';
import { getProjectSignalStats } from '../session/working-set.js';
import { logger } from '../logger.js';

export interface MemoryStats {
  totalMemories: number;
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

    // Count by type - get all and count in memory
    const allMemories = await db
      .select({ type: schema.memories.type })
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

    // Links
    // Links are scoped via their associated memories
    // SQLite - get all and filter in memory
    const allLinks = await db
      .select({
        fromProjectId: schema.memories.projectId,
        toProjectId: schema.memories.projectId
      })
      .from(schema.memoryAssociations)
      .innerJoin(schema.memories, eq(schema.memoryAssociations.fromMemoryId, schema.memories.id))
      .where(project ? eq(schema.memories.projectId, project.id) : undefined);
    stats.totalLinks = allLinks.length;

  } catch (error) {
    // Return empty stats on error
    logger.error('Error getting memory stats:', error);
  }

  stats.signal = await getProjectSignalStats(resolvedPath);

  return stats;
}
