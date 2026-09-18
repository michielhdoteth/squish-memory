/**
 * Memory Tier Classification System - Phase 7
 *
 * Intelligent memory tier system based on access patterns and metadata:
 * - Sturdy: Pinned or frequently accessed, never decays
 * - Long-term: Old, important, recently accessed, slow decay
 * - Working: Recent or young memories, normal behavior
 * - Fleeting: Low importance, old, no recent access, fast decay
 */

import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

export type MemoryTier = 'sturdy' | 'long-term' | 'working' | 'fleeting';

export interface TierCriteria {
  sturdyAccessCount: number;
  sturdyAccessWindow: number;
  longTermAge: number;
  longTermImportance: number;
  fleetingImportance: number;
  fleetingAge: number;
}

const DEFAULT_TIER_CRITERIA: TierCriteria = {
  sturdyAccessCount: 5,
  sturdyAccessWindow: 30,
  longTermAge: 90,
  longTermImportance: 50,
  fleetingImportance: 25,
  fleetingAge: 60,
};

/**
 * Classify a memory into a tier based on its access patterns and metadata.
 *
 * Priority order:
 * 1. isPinned OR high access count in window -> sturdy
 * 2. Low importance, old, no recent access -> fleeting
 * 3. Old, recently accessed, important -> long-term
 * 4. Default (young or recently accessed or fallback) -> working
 */
export function classifyMemoryTier(
  memory: {
    isPinned?: boolean;
    importanceScore?: number;
    accessCount?: number;
    lastAccessedAt?: Date | string | number | null;
    createdAt?: Date | string | number | null;
  },
  criteria: Partial<TierCriteria> = {},
): MemoryTier {
  const c = { ...DEFAULT_TIER_CRITERIA, ...criteria };
  const now = Date.now();
  const msPerDay = 1000 * 60 * 60 * 24;

  // Resolve dates to timestamps (milliseconds)
  const lastAccessed = memory.lastAccessedAt
    ? new Date(memory.lastAccessedAt).getTime()
    : null;
  const createdAt = memory.createdAt
    ? new Date(memory.createdAt).getTime()
    : now;

  const ageDays = Math.max(0, (now - createdAt) / msPerDay);
  const daysSinceLastAccess = lastAccessed
    ? Math.max(0, (now - lastAccessed) / msPerDay)
    : Infinity;

  // 1. Sturdy: Pinned or frequently accessed
  if (memory.isPinned) {
    return 'sturdy';
  }
  if (
    (memory.accessCount ?? 0) >= c.sturdyAccessCount &&
    daysSinceLastAccess <= c.sturdyAccessWindow
  ) {
    return 'sturdy';
  }

  // 2. Fleeting: Low importance, old, no recent access
  if (
    (memory.importanceScore ?? 50) < c.fleetingImportance &&
    ageDays > c.fleetingAge &&
    (lastAccessed === null || daysSinceLastAccess > c.sturdyAccessWindow)
  ) {
    return 'fleeting';
  }

  // 3. Long-term: Old, recently accessed, important
  if (
    ageDays > c.longTermAge &&
    lastAccessed !== null &&
    daysSinceLastAccess <= c.sturdyAccessWindow &&
    (memory.importanceScore ?? 50) >= c.longTermImportance
  ) {
    return 'long-term';
  }

  // 4. Working: Default fallback
  return 'working';
}

/**
 * Recalculate tiers for all active memories.
 * Optionally filtered by project ID.
 */
export async function recalculateTiers(
  projectId?: string,
): Promise<{ updated: number; tiers: Record<MemoryTier, number> }> {
  const result: { updated: number; tiers: Record<MemoryTier, number> } = {
    updated: 0,
    tiers: { sturdy: 0, 'long-term': 0, working: 0, fleeting: 0 },
  };

  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any)?.$client;

    if (!sqlite) {
      logger.warn('No database client available for tier recalculation');
      return result;
    }

    const query = projectId
      ? `SELECT id, is_pinned, importance_score, access_count, last_accessed_at, created_at, tier
         FROM memories WHERE status = 'active' AND project_id = ?`
      : `SELECT id, is_pinned, importance_score, access_count, last_accessed_at, created_at, tier
         FROM memories WHERE status = 'active'`;

    const memories = sqlite.prepare(query).all(projectId || null) as any[];
    const now = Math.floor(Date.now() / 1000);
    const updates: { id: string; tier: string }[] = [];

    for (const mem of memories) {
      const newTier = classifyMemoryTier({
        isPinned: !!mem.is_pinned,
        importanceScore: mem.importance_score,
        accessCount: mem.access_count,
        lastAccessedAt: mem.last_accessed_at ? mem.last_accessed_at * 1000 : null,
        createdAt: mem.created_at ? mem.created_at * 1000 : null,
      });

      if (newTier !== mem.tier) {
        updates.push({ id: mem.id, tier: newTier });
      }
      result.tiers[newTier]++;
    }

    // Batch update via single CASE/WHEN statement
    if (updates.length > 0) {
      const cases = updates.map(() => `WHEN id = ? THEN ?`).join(' ');
      const params = [
        ...updates.flatMap(u => [u.id, u.tier]),
        ...updates.map(u => u.id),
        now,
      ];
      sqlite.prepare(`
        UPDATE memories
        SET tier = CASE ${cases} END, updated_at = ?
        WHERE id IN (${updates.map(() => '?').join(',')})
      `).run(...params);
      result.updated = updates.length;
    }

    logger.info('Tier recalculation complete', {
      updated: result.updated,
      tiers: result.tiers,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Tier recalculation failed', { error: msg });
  }

  return result;
}

/**
 * Promote a memory to sturdy tier.
 * Sets tier = 'sturdy' AND pins the memory for protection.
 */
export async function promoteToSturdy(memoryId: string): Promise<boolean> {
  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any)?.$client;

    if (!sqlite) {
      logger.warn('No database client available for promoteToSturdy');
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    sqlite
      .prepare(
        `UPDATE memories SET tier = 'sturdy', is_pinned = 1, sector = 'semantic', updated_at = ? WHERE id = ?`,
      )
      .run(now, memoryId);

    logger.info(`Promoted memory to sturdy tier: ${memoryId} (sector -> semantic)`);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to promote memory ${memoryId}`, { error: msg });
    return false;
  }
}

/**
 * Get statistics of how many memories are in each tier.
 */
export async function getTierStats(
  projectId?: string,
): Promise<Record<MemoryTier, number>> {
  const stats: Record<MemoryTier, number> = {
    sturdy: 0,
    'long-term': 0,
    working: 0,
    fleeting: 0,
  };

  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any)?.$client;

    if (!sqlite) {
      return stats;
    }

    const query = projectId
      ? `SELECT tier, COUNT(*) as count FROM memories
         WHERE status = 'active' AND project_id = ?
         GROUP BY tier`
      : `SELECT tier, COUNT(*) as count FROM memories
         WHERE status = 'active'
         GROUP BY tier`;

    const rows = sqlite.prepare(query).all(projectId || null) as any[];
    for (const row of rows) {
      const t = row.tier as MemoryTier;
      if (t in stats) stats[t] = Number(row.count);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Failed to get tier stats', { error: msg });
  }

  return stats;
}
