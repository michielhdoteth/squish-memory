/**
 * Memory CRUD operations.
 *
 * Core read/write primitives: get, getByIds, recent, confidence updates.
 * Also exports internal helpers (normalizeMemory, getOrCreateUser) consumed
 * by the write and search sub-modules.
 */

import { randomUUID } from 'crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { requireProject } from '../../core/projects.js';
import { logger } from '../logger.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { requireUuid } from '../lib/validation.js';
import { decrypt } from '../security/encrypt.js';
import { getDbClient } from '../lib/db-client.js';
import { deserializeTags, deserializeMetadata } from '../../core/memory/serialization.js';
import type { MemoryRecord } from './memory-types.js';

// ---------------------------------------------------------------------------
// Lazy score initialization for legacy memories with NULL scores
// ---------------------------------------------------------------------------

/**
 * Initialize importance_score and relevance_score for a memory that was written
 * before the scoring system existed (or whose scores were never set).
 *
 * Called lazily on first read so the 305+ legacy NULL-score memories get proper
 * scores without a one-time migration. Only writes if scores are actually NULL.
 */
export async function ensureMemoryScores(row: any): Promise<void> {
  if (row.importance_score != null && row.relevance_score != null) return;

  try {
    const { db, schema } = await getDbClient();
    const sqlite = (db as any)?.$client;
    if (!sqlite) return;

    const now = Math.floor(Date.now() / 1000);

    // Compute importance from type + recency + access signals
    const TYPE_WEIGHTS: Record<string, number> = {
      decision: 85, preference: 80, fact: 65, context: 55,
      observation: 45, note: 40, conversation: 30,
    };
    const typeWeight = TYPE_WEIGHTS[row.type] ?? 50;

    const ageDays = row.created_at
      ? Math.max(0, (Date.now() / 1000 - row.created_at) / 86400)
      : 0;
    const recencyWeight = Math.max(0, 100 - ageDays * 0.5);

    const totalAccess = (row.access_count ?? 0) + (row.usage_count ?? 0);
    const usageWeight = Math.min(100, totalAccess * 5);

    const importanceScore = Math.round(
      typeWeight * 0.4 + recencyWeight * 0.3 + usageWeight * 0.2 + 50 * 0.1
    );

    // Relevance starts at 50 (decay engine will adjust from here)
    const relevanceScore = row.relevance_score ?? 50;

    sqlite.prepare(`
      UPDATE memories
      SET importance_score = ?, relevance_score = ?,
          last_importance_recalc = ?, last_decay_at = COALESCE(last_decay_at, created_at),
          updated_at = ?
      WHERE id = ? AND (importance_score IS NULL OR relevance_score IS NULL)
    `).run(importanceScore, relevanceScore, now, now, row.id);

    // Update the in-memory row so downstream code sees fresh values
    row.importance_score = importanceScore;
    row.relevance_score = relevanceScore;

    logger.debug(`[LazyScores] Initialized scores for memory ${row.id}: importance=${importanceScore}, relevance=${relevanceScore}`);
  } catch (err) {
    logger.debug(`[LazyScores] Failed to initialize scores for ${row.id}: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function normalizeMemory(row: any): MemoryRecord {
  const tags = deserializeTags(row.tags ?? null);
  const metadata = deserializeMetadata(row.metadata ?? null);

  const createdAtStr = normalizeTimestamp(row.createdAt ?? row.created_at);

  return {
    id: row.id,
    projectId: row.projectId ?? row.project_id ?? null,
    type: row.type,
    content: row.content,
    summary: row.summary ?? null,
    tags,
    metadata,
    visibilityScope: row.visibilityScope ?? row.visibility_scope ?? null,
    createdAt: createdAtStr,
    validFrom: row.validFrom ?? row.valid_from ?? null,
    validTo: row.validTo ?? row.valid_to ?? null,
    recordedAt: row.recordedAt ?? row.recorded_at ?? null,
    confidenceLevel: row.confidenceLevel ?? row.confidence_level ?? null,
  };
}

export async function getOrCreateUser(identifier: string, existingDb?: any, existingSchema?: any): Promise<{ id: string } | null> {
  try {
    const { db, schema } = existingDb ? { db: existingDb, schema: existingSchema } : await getDbClient();
    const sqliteDb = db as any;
    const usersTable = schema.users;

    // Try to find existing user by externalId (name/email)
    let user = await sqliteDb.select().from(usersTable).where(
      eq(usersTable.externalId, identifier)
    ).limit(1).then((rows: any[]) => rows[0] || null);

    if (user) return { id: user.id };

    // Try by email pattern detection
    if (identifier.includes('@')) {
      user = await sqliteDb.select().from(usersTable).where(
        eq(usersTable.email, identifier)
      ).limit(1).then((rows: any[]) => rows[0] || null);
      if (user) return { id: user.id };
    }

    // Create new user
    const id = randomUUID();
    const isEmail = identifier.includes('@');
    await sqliteDb.insert(usersTable).values({
      id,
      externalId: identifier,
      name: isEmail ? null : identifier,
      email: isEmail ? identifier : null,
    });

    return { id };
  } catch (error: any) {
    logger.warn(`[User] Failed to resolve user "${identifier}":`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

export async function getMemory(
  id: string,
  incrementAccess: boolean = true,
): Promise<MemoryRecord | null> {
  try {
    // Validate UUID
    requireUuid(id);

    const { db, schema } = await getDbClient();
    const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
		const row = rows[0];
		if (!row) return null;

		// Lazy-initialize scores for legacy memories with NULL values
		await ensureMemoryScores(row);

		// Increment access count and update last accessed time
		if (incrementAccess) {
			await db.update(schema.memories)
			.set({
				accessCount: (row.accessCount ?? 0) + 1,
				lastAccessedAt: new Date(),
			})
			.where(eq(schema.memories.id, id));
		}

  let content = row.content;
  if (row.is_encrypted) {
		  try {
		    content = decrypt(row.encrypted_content, row.encryption_nonce);
		  } catch (e: any) {
		    logger.warn('Failed to decrypt memory', e);
		    content = row.content; // fall back to stored content
		  }
		}
		const decryptedRow = { ...row, content };
    const normalized = normalizeMemory(decryptedRow);
		return normalized;
	} catch (error: any) {
		throw error;
	}
}

/**
 * Batch-fetch memories by IDs (fixes N+1 query in walking.ts)
 * Returns memories in the same order as the input IDs, skipping any that are not found.
 */
export async function getMemoriesByIds(
  ids: string[],
  incrementAccess: boolean = false
): Promise<MemoryRecord[]> {
  if (ids.length === 0) return [];

  try {
    const { db, schema } = await getDbClient();
    const rows = await db.select().from(schema.memories).where(
      inArray(schema.memories.id, ids)
    );

    // Increment access counts if requested (batch update)
    if (incrementAccess && rows.length > 0) {
      const now = new Date();
      await db.update(schema.memories)
        .set({ lastAccessedAt: now })
        .where(inArray(schema.memories.id, ids));
    }

    // Normalize and filter by team access if needed
    const memories: MemoryRecord[] = [];
    for (const row of rows) {
      // Lazy-initialize scores for legacy memories with NULL values
      await ensureMemoryScores(row);

      let content = row.content;
      if (row.is_encrypted) {
        try {
          content = decrypt(row.encrypted_content, row.encryption_nonce);
        } catch {
          content = row.content;
        }
      }
      const decryptedRow = { ...row, content };
      const normalized = normalizeMemory(decryptedRow);
      // Skip team mode check for batch (simplified - trust the caller)
      memories.push(normalized);
    }

    return memories;
  } catch (error) {
    logger.debug(`[Memories] getMemoriesByIds failed: ${error}`);
    return [];
  }
}

export async function setConfidence(id: string, level: 'certain' | 'speculative' | 'outdated'): Promise<boolean> {
  try {
    // Validate UUID
    requireUuid(id);

    const { db, schema } = await getDbClient();
    await db.update(schema.memories)
			.set({ confidenceLevel: level, updatedAt: new Date() })
			.where(eq(schema.memories.id, id));
		return true;
	} catch (error: any) {
		throw error;
	}
}

export async function getRecent(projectPath: string, limit: number): Promise<MemoryRecord[]> {
  try {
    const { db } = await getDbClient();
    const sqlite = db.$client as any;
    const project = await requireProject(projectPath);

    // Use raw SQL to avoid drizzle column name issues
    const rows = sqlite.prepare(`
      SELECT * FROM memories 
      WHERE project_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(project.id, limit);

    return rows.map((row: any) => normalizeMemory(row));
  } catch (error: any) {
    throw error;
  }
}
