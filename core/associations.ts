/**
 * Memory Association Graph (Waypoint Graph)
 * Tracks co-occurrence and relationships between memories
 */

import { eq, and, or, desc, inArray, sql } from 'drizzle-orm';
import { getDbClient } from './lib/db-client.js';
import { logger } from './logger.js';

export type AssociationType = 'co_occurred' | 'supersedes' | 'contradicts' | 'supports' | 'relates_to' | 'duplicate' | 'merged' | 'updates' | 'extends' | 'derives';

/**
 * Create or update an association between two memories
 */
/**
 * Confidence tags for associations (inspired by Graphify's tagging system)
 * - EXTRACTED: Found directly from data (co-occurrence, explicit user link)
 * - INFERRED: Reasonable inference (LLM-extracted, entity overlap)
 * - AMBIGUOUS: Uncertain relationship
 */
export type AssociationConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export async function createAssociation(
  fromMemoryId: string,
  toMemoryId: string,
  type: AssociationType,
  weight: number = 1,
  confidence?: { tag: AssociationConfidence; score: number }
): Promise<void> {
  // Safety: reject self-links
  if (fromMemoryId === toMemoryId) {
    logger.debug(`[Associations] Rejected self-link for memory ${fromMemoryId}`);
    return;
  }

  try {
    const { db, schema } = await getDbClient();

    // Safety: cap fan-out at 50 associations per memory
    const existingCount = await (db as any)
      .select({ count: sql<number>`count(*)` })
      .from(schema.memoryAssociations)
      .where(eq(schema.memoryAssociations.fromMemoryId, fromMemoryId));

    if ((existingCount[0]?.count ?? 0) >= 50) {
      logger.debug(`[Associations] Fan-out cap reached for memory ${fromMemoryId}, skipping`);
      return;
    }

    // Check if association already exists
    const existing = await (db as any)
      .select()
      .from(schema.memoryAssociations)
      .where(
        and(
          eq(schema.memoryAssociations.fromMemoryId, fromMemoryId),
          eq(schema.memoryAssociations.toMemoryId, toMemoryId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update weight and coactivation count
      await (db as any)
        .update(schema.memoryAssociations)
        .set({
          weight: existing[0].weight + weight,
          coactivationCount: existing[0].coactivationCount + 1,
          lastCoactivatedAt: new Date(),
        })
        .where(eq(schema.memoryAssociations.id, existing[0].id));
    } else {
      // Create new association
      const values: any = {
        fromMemoryId,
        toMemoryId,
        associationType: type,
        weight,
        coactivationCount: 1,
        lastCoactivatedAt: new Date(),
      };
      // Add confidence metadata if provided (Graphify-inspired tagging)
      if (confidence) {
        values.metadata = JSON.stringify({
          confidence: confidence.tag,
          confidence_score: confidence.score,
        });
      }
      await (db as any).insert(schema.memoryAssociations).values(values);
    }
  } catch (error) {
    logger.error('Error creating association', error);
  }
}

/**
 * Auto-link memories that share entities
 * Called after storing a memory to link it to related memories
 */
export async function autoLinkByEntities(
  newMemoryId: string,
  entityNames: string[],
  projectId: string
): Promise<number> {
  if (entityNames.length === 0) return 0;

  try {
    const { db, schema } = await getDbClient();

    // Find existing memories that contain any of these entity names
    // Use simple LIKE query for matching
    const conditions = entityNames.slice(0, 5).map(name =>
      sql<boolean>`LOWER(m.content) LIKE ${'%' + name + '%'}`
    );

    const existing = await (db as any)
      .select({
        id: schema.memories.id,
        content: schema.memories.content
      })
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.projectId, projectId),
          sql`(${conditions.join(' OR ')})`,
          sql`id != ${newMemoryId}`
        )
      )
      .limit(10);

    // Create associations for matching memories
    let linked = 0;
    for (const mem of existing) {
      try {
        await createAssociation(newMemoryId, mem.id, 'relates_to', 0.5, { tag: 'EXTRACTED', score: 1.0 });
        linked++;
      } catch (e) {
        // Skip duplicates
      }
    }

    return linked;
  } catch (error) {
    logger.error('Error auto-linking by entities', error);
    return 0;
  }
}
export async function trackCoactivation(memoryIds: string[]): Promise<void> {
  if (memoryIds.length < 2) return;

  try {
    const { db, schema } = await getDbClient();
    const now = new Date();

    // Generate all pairs
    const pairs: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < memoryIds.length; i++) {
      for (let j = i + 1; j < memoryIds.length; j++) {
        pairs.push({ from: memoryIds[i], to: memoryIds[j] });
        pairs.push({ from: memoryIds[j], to: memoryIds[i] }); // Bidirectional
      }
    }

    if (pairs.length === 0) return;

    // Batch check existing associations with single SELECT
    const pairIds = pairs.map(p => ({ from: p.from, to: p.to }));

    // Check which pairs already exist
    const existingPairs = await (db as any)
      .select({ fromId: schema.memoryAssociations.fromMemoryId, toId: schema.memoryAssociations.toMemoryId })
      .from(schema.memoryAssociations)
      .where(
        or(
          ...pairIds.map((p: any) =>
            and(
              eq(schema.memoryAssociations.fromMemoryId, p.from),
              eq(schema.memoryAssociations.toMemoryId, p.to)
            )
          )
        )
      );

    const existingMap = new Set(
      existingPairs.map((p: any) => `${p.fromId}:${p.toId}`)
    );

    // Separate into new pairs and existing pairs
    const newPairs: any[] = [];
    const existingPairsToUpdate: string[] = [];

    for (const pair of pairs) {
      const key = `${pair.from}:${pair.to}`;
      if (existingMap.has(key)) {
        existingPairsToUpdate.push(key);
      } else {
        newPairs.push({
          fromMemoryId: pair.from,
          toMemoryId: pair.to,
          associationType: 'co_occurred',
          weight: 1,
          coactivationCount: 1,
          lastCoactivatedAt: now,
        });
      }
    }

    // Bulk insert new associations
    if (newPairs.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < newPairs.length; i += BATCH_SIZE) {
        const batch = newPairs.slice(i, i + BATCH_SIZE);
        try {
          // For PostgreSQL with ON CONFLICT support
          if ((db as any).insert && (db as any).onConflict) {
            await (db as any)
              .insert(schema.memoryAssociations)
              .values(batch)
                .onConflict({
                 target: [schema.memoryAssociations.fromMemoryId, schema.memoryAssociations.toMemoryId],
                    set: {
                   weight: sql.raw('EXCLUDED.weight'),
                   coactivationCount: sql.raw('EXCLUDED.coactivation_count'),
                   lastCoactivatedAt: now,
                 },
               })
              .catch(() => {
                // Fallback for SQLite
                return (db as any).insert(schema.memoryAssociations).values(batch);
              });
          } else {
            // Direct insert for SQLite
            await (db as any).insert(schema.memoryAssociations).values(batch);
          }
        } catch (error) {
          logger.error('Error inserting batch of associations', { batchSize: batch.length, error });
        }
      }
    }

    // Bulk update existing associations
    if (existingPairsToUpdate.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < existingPairsToUpdate.length; i += BATCH_SIZE) {
        const batch = existingPairsToUpdate.slice(i, i + BATCH_SIZE);

        // Extract from/to pairs for this batch
        const batchPairs = batch.map(key => {
          const [from, to] = key.split(':');
          return { from, to };
        });

        try {
          for (const pair of batchPairs) {
            await (db as any)
              .update(schema.memoryAssociations)
              .set({
                weight: sql`${schema.memoryAssociations.weight} + 1`,
                coactivationCount: sql`${schema.memoryAssociations.coactivationCount} + 1`,
                lastCoactivatedAt: now,
              })
              .where(
                and(
                  eq(schema.memoryAssociations.fromMemoryId, pair.from),
                  eq(schema.memoryAssociations.toMemoryId, pair.to)
                )
              );
          }
        } catch (error) {
          logger.error('Error updating batch of associations', { batchSize: batch.length, error });
        }
      }
    }

    logger.debug('Coactivation tracked', {
      totalPairs: pairs.length,
      newAssociations: newPairs.length,
      updatedAssociations: existingPairsToUpdate.length,
    });
  } catch (error) {
    logger.error('Error tracking coactivation', error);
  }
}

/**
 * Get related memories via the association graph
 */
export async function getRelatedMemories(
  memoryId: string,
  limit: number = 10
): Promise<any[]> {
  try {
    const { db, schema } = await getDbClient();

    // Get all associated memories, sorted by weight
    const associations = await (db as any)
      .select()
      .from(schema.memoryAssociations)
      .where(
        or(
          eq(schema.memoryAssociations.fromMemoryId, memoryId),
          eq(schema.memoryAssociations.toMemoryId, memoryId)
        )
      )
      .orderBy(desc(schema.memoryAssociations.weight))
      .limit(limit);

    const relatedIds = associations.map((a: any) =>
      a.fromMemoryId === memoryId ? a.toMemoryId : a.fromMemoryId
    );

    if (relatedIds.length === 0) return [];

    // Fetch the actual memories
    return await (db as any)
      .select()
      .from(schema.memories)
      .where(inArray(schema.memories.id, relatedIds));
  } catch (error) {
    logger.error('Error getting related memories', error);
    return [];
  }
}



/**
 * Prune weak associations (weight < threshold)
 */
export async function pruneWeakAssociations(weightThreshold: number = 5): Promise<number> {
  try {
    const { db, schema } = await getDbClient();

    const result = await (db as any)
      .delete(schema.memoryAssociations)
      .where(schema.memoryAssociations.weight as any <= weightThreshold);

    return result?.rowCount || 0;
  } catch (error) {
    logger.error('Error pruning weak associations', error);
    return 0;
  }
}

/**
 * Prune associations that are BOTH weak AND old (dual criteria).
 * More aggressive than weight-only pruning — removes stale low-value links.
 */
export async function pruneStaleAssociations(
  maxWeight: number = 2,
  maxAgeDays: number = 90
): Promise<number> {
  try {
    const { db, schema } = await getDbClient();

    const cutoff = Math.floor((Date.now() - maxAgeDays * 86400000) / 1000);

    const result = await (db as any)
      .delete(schema.memoryAssociations)
      .where(
        and(
          sql`${schema.memoryAssociations.weight} <= ${maxWeight}`,
          sql`${schema.memoryAssociations.createdAt} < ${cutoff}`
        )
      );

    return result?.rowCount || 0;
  } catch (error) {
    logger.error('Error pruning stale associations', error);
    return 0;
  }
}

/**
 * Get association statistics
 */
export async function getAssociationStats(): Promise<{
  totalAssociations: number;
  byType: Record<string, number>;
  avgWeight: number;
  maxWeight: number;
}> {
  try {
    const { db, schema } = await getDbClient();

    const associations = await (db as any)
      .select()
      .from(schema.memoryAssociations);

    const stats = {
      totalAssociations: associations.length,
      byType: {} as Record<string, number>,
      avgWeight: 0,
      maxWeight: 0,
    };

    let totalWeight = 0;

    for (const assoc of associations) {
      stats.byType[assoc.associationType] = (stats.byType[assoc.associationType] || 0) + 1;
      totalWeight += assoc.weight;
      if (assoc.weight > stats.maxWeight) stats.maxWeight = assoc.weight;
    }

    stats.avgWeight = associations.length > 0 ? totalWeight / associations.length : 0;

    return stats;
  } catch (error) {
    logger.error('Error getting association stats', error);
    return {
      totalAssociations: 0,
      byType: {},
      avgWeight: 0,
      maxWeight: 0,
    };
  }
}


