/**
 * Snapshot Creation Operations
 * Functions for creating different types of memory snapshots
 */

import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { MemoryDiff, calculateDiff } from './comparison.js';
import { toSqliteJson } from '../memory/serialization.js';

function snapshotJson(db: unknown, value: unknown): unknown {
  if (typeof db !== 'object' || db === null) return value;
  const database = db as { $client?: { prepare?: unknown }; prepare?: unknown };
  const client = database.$client ?? database;
  return typeof client.prepare === 'function' ? toSqliteJson(value) : value;
}

// Re-export for convenience
export { MemoryDiff, calculateDiff };

export async function createBeforeSnapshot(memoryId: string): Promise<string> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    const memory = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (memory.length === 0) {
      throw new Error('Memory not found: ' + memoryId);
    }

    const snapshotId = randomUUID();

    await (db as any).insert(schema.memorySnapshots).values({
      id: snapshotId,
      memoryId,
      snapshotType: 'before_update',
      content: memory[0].content,
      metadata: snapshotJson(db, extractMetadata(memory[0])),
      createdAt: new Date(),
    });

    return snapshotId;
  } catch (error) {
    logger.error('Error creating before snapshot', error);
    throw error;
  }
}

export async function createAfterSnapshot(
  memoryId: string,
  beforeSnapshotId: string
): Promise<{ snapshotId: string; diff: MemoryDiff }> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    const memory = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (memory.length === 0) {
      throw new Error('Memory not found');
    }

    const before = await (db as any)
      .select()
      .from(schema.memorySnapshots)
      .where(eq(schema.memorySnapshots.id, beforeSnapshotId))
      .limit(1);

    if (before.length === 0) {
      throw new Error('Before snapshot not found');
    }
    if (before[0].memoryId !== memoryId || before[0].snapshotType !== 'before_update') {
      throw new Error('Before snapshot belongs to a different memory or is not a before-update snapshot');
    }
    const diff = calculateDiff(before[0].content, memory[0].content);
    const snapshotId = randomUUID();

    await (db as any).insert(schema.memorySnapshots).values({
      id: snapshotId,
      memoryId,
      snapshotType: 'after_update',
      content: memory[0].content,
      metadata: snapshotJson(db, extractMetadata(memory[0])),
      diff: snapshotJson(db, diff),
      createdAt: new Date(),
    });

    return { snapshotId, diff };
  } catch (error) {
    logger.error('Error creating after snapshot', error);
    throw error;
  }
}

export async function createPeriodicSnapshot(memoryId: string): Promise<string> {
  try {
    const db = await getDb();
    const schema = await getSchema();

    const memory = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (memory.length === 0) {
      throw new Error('Memory not found');
    }

    const snapshotId = randomUUID();

    await (db as any).insert(schema.memorySnapshots).values({
      id: snapshotId,
      memoryId,
      snapshotType: 'periodic',
      content: memory[0].content,
      metadata: snapshotJson(db, extractMetadata(memory[0])),
      createdAt: new Date(),
    });

    return snapshotId;
  } catch (error) {
    logger.error('Error creating periodic snapshot', error);
    throw error;
  }
}

function extractMetadata(memory: any): Record<string, unknown> {
  return {
    type: memory.type,
    sector: memory.sector,
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    tags: memory.tags,
    agentId: memory.agentId,
  };
}
