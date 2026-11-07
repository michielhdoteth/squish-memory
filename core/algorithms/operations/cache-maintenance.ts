/**
 * Hash cache maintenance - SimHash/MinHash signatures for duplicate detection
 */

import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient } from '../../../core/storage/database.js';
import { eq } from 'drizzle-orm';
import { SimHashFilter, MinHashFilter } from '../detection/hash-filters.js';
import crypto from 'crypto';
import { logger } from '../../../core/logger.js';

function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export async function updateCache(memoryId: string): Promise<boolean> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Load the memory
    const [memory] = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId));

    if (!memory) {
      return false;
    }

    // Generate hashes
    const simhashFilter = new SimHashFilter();
    const minhashFilter = new MinHashFilter();

    const simhash = simhashFilter.generateHash(memory.content);
    const minhash = minhashFilter.generateSignature(memory.content);
    const serializedMinhash = JSON.stringify(minhash);
    const contentHash = hashContent(memory.content);

    // Upsert cache entry
    const now = new Date();

    // Check if entry exists
    const [existing] = await db
      .select()
      .from(schema.memoryHashCache)
      .where(eq(schema.memoryHashCache.memoryId, memoryId));

    if (existing) {
      // Update existing
      await db
        .update(schema.memoryHashCache)
        .set({
          simhash,
          minhash: serializedMinhash,
          contentHash,
          lastUpdated: now,
        })
        .where(eq(schema.memoryHashCache.memoryId, memoryId));
    } else {
      // Create new
      await db.insert(schema.memoryHashCache).values({
        memoryId,
        projectId: memory.projectId,
        simhash,
        minhash: serializedMinhash,
        contentHash,
        lastUpdated: now,
      });
    }

    return true;
  } catch (error) {
    logger.error(`Failed to update hash cache for ${memoryId}`, error);
    return false;
  }
}

export async function rebuildCache(projectId: string): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Get all memories in project
    const memories: any[] = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.projectId, projectId));

    let succeeded = 0;
    let failed = 0;

    for (const memory of memories) {
      const ok = await updateCache(memory.id);
      if (ok) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return {
      processed: memories.length,
      succeeded,
      failed,
    };
  } catch (error) {
    logger.error(`Failed to rebuild hash cache for project ${projectId}`, error);
    return { processed: 0, succeeded: 0, failed: 0 };
  }
}

export async function isStale(memoryId: string): Promise<boolean> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    const [memory] = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId));

    if (!memory) {
      return true;
    }

    const [cacheEntry] = await db
      .select()
      .from(schema.memoryHashCache)
      .where(eq(schema.memoryHashCache.memoryId, memoryId));

    if (!cacheEntry) {
      return true; // No cache entry = stale
    }

    const currentContentHash = hashContent(memory.content);
    return currentContentHash !== cacheEntry.contentHash;
  } catch (error) {
    logger.error('Failed to check hash cache staleness', error);
    return true; // Assume stale on error
  }
}

export async function cleanupOrphaned(projectId: string): Promise<number> {
  try {
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Get all cache entries for project
    const cacheEntries: any[] = await db
      .select()
      .from(schema.memoryHashCache)
      .where(eq(schema.memoryHashCache.projectId, projectId));

    let deleted = 0;

    for (const entry of cacheEntries) {
      // Check if memory exists
      const [memory] = await db
        .select()
        .from(schema.memories)
        .where(eq(schema.memories.id, entry.memoryId));

      if (!memory) {
        // Memory doesn't exist, delete cache entry
        await db
          .delete(schema.memoryHashCache)
          .where(eq(schema.memoryHashCache.memoryId, entry.memoryId));
        deleted++;
      }
    }

    return deleted;
  } catch (error) {
    logger.error('Failed to cleanup orphaned hash cache', error);
    return 0;
  }
}
