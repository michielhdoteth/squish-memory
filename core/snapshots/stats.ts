/**
 * Snapshot Statistics
 * Analytics and statistics for snapshot operations
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';

export async function getSnapshotStats(memoryId?: string): Promise<{
  totalSnapshots: number;
  byType: Record<string, number>;
  oldestSnapshot: Date | null;
  newestSnapshot: Date | null;
}> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    const where = memoryId ? eq(schema.memorySnapshots.memoryId, memoryId) : undefined;

    const snapshots = await (db as any)
      .select()
      .from(schema.memorySnapshots)
      .where(where);

    const stats = {
      totalSnapshots: snapshots.length,
      byType: {
        before_update: 0,
        after_update: 0,
        periodic: 0,
      } as Record<string, number>,
      oldestSnapshot: null as Date | null,
      newestSnapshot: null as Date | null,
    };

    let oldest: Date | null = null;
    let newest: Date | null = null;

    for (const snap of snapshots) {
      // Snapshot types are an open set (before_update, after_update, periodic,
      // correction...); seeding only the known ones made an unknown type
      // count as NaN.
      stats.byType[snap.snapshotType] = (stats.byType[snap.snapshotType] ?? 0) + 1;

      const date = new Date(snap.createdAt);
      if (!oldest || date < oldest) oldest = date;
      if (!newest || date > newest) newest = date;
    }

    stats.oldestSnapshot = oldest;
    stats.newestSnapshot = newest;

    return stats;
  } catch (error) {
    logger.error('Error getting snapshot stats', error);
    return {
      totalSnapshots: 0,
      byType: {},
      oldestSnapshot: null,
      newestSnapshot: null,
    };
  }
}