import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient } from '../storage/database.js';
import { MemoryRecord } from './memories.js';

export interface Conflict {
  type: 'contradiction' | 'inconsistency' | 'outdated';
  description: string;
  relatedMemoryId?: string;
}

export async function detectConflicts(memoryId: string, proposedContent: string): Promise<Conflict[]> {
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();
  const { memories } = schema;

  const conflicts: Conflict[] = [];

  // Get current memory
  const currentMemory = await db.select()
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1);

  if (currentMemory.length === 0) return [];

  // Check for temporal contradictions
  if (currentMemory[0].validFrom && currentMemory[0].validTo) {
    const now = new Date();
    if (now < new Date(currentMemory[0].validFrom) || now > new Date(currentMemory[0].validTo)) {
      conflicts.push({
        type: 'inconsistency',
        description: 'Current time is outside validity period',
      });
    }
  }

  // Check for semantic contradictions with other memories. SQLite has no
  // ILIKE; use LIKE on a truncated, escaped needle so the heuristic stays
  // deterministic and dialect-safe.
  const needle = proposedContent.replace(/[%_\\]/g, (c) => `\\${c}`).slice(0, 120);
  const similarMemories = await db.select()
    .from(memories)
    .where(
      and(
        eq(memories.projectId, currentMemory[0].projectId),
        sql`${memories.id} != ${memoryId}`,
        sql`${memories.content} LIKE ${'%' + needle + '%'} ESCAPE '\\'`
      )
    )
    .limit(5);

  for (const memory of similarMemories) {
    if (memory.id !== memoryId) {
      conflicts.push({
        type: 'contradiction',
        description: `Potential contradiction with memory ${memory.id}`,
        relatedMemoryId: memory.id,
      });
    }
  }

  return conflicts;
}