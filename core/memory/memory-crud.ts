/**
 * Memory CRUD operations.
 *
 * Core read/write primitives: get, getByIds, recent, confidence updates.
 * Also exports internal helpers (normalizeMemoryRecord, getOrCreateUser) consumed
 * by the write and search sub-modules.
 */

import { randomUUID } from 'crypto';
import {
  sqlEpochSeconds,
  sqlLifecycleBound
} from '../lib/timestamps.js';
import { eq, inArray, sql } from 'drizzle-orm';
import { requireProject } from '../../core/projects.js';
import { logger } from '../logger.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { requireUuid } from '../lib/validation.js';
import { decrypt } from '../security/encrypt.js';
import { getDbClient } from '../lib/db-client.js';
import { deserializeTags, deserializeMetadata } from '../../core/memory/serialization.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../../core/acl/trust-policy.js';
import { denyStrictSurface, writeTrustAudit } from '../../core/acl/trust-audit.js';
import type { MemoryRecord } from './memory-types.js';

export { EncryptedMemoryReadError } from '../security/encrypted-read.js';
import { EncryptedMemoryReadError, readMemoryContent } from '../security/encrypted-read.js';

async function assertUnscopedCrudAvailable(operation: string, resourceId = 'unscoped'): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(resourceId, 'memory', `Direct ${operation} is disabled under strict trust until caller-scoped provenance authorization is implemented`);
  }
}

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
  await assertUnscopedCrudAvailable('score initialization', typeof row.id === 'string' ? row.id : 'memory_score');

  try {
    const { db, schema } = await getDbClient();
    const sqlite = (db as any)?.$client;
    if (!sqlite) return;

    const now = Math.floor(Date.now() / 1000);

    // Compute importance from type + recency + access signals.
    // NOTE: this legacy lazy-score blend is NOT the additive TYPE_WEIGHTS in
    // importance.ts (different concept, same legacy name); renamed here so the
    // two stop reading as one contract.
    const LAZY_SCORE_TYPE_WEIGHTS: Record<string, number> = {
      decision: 85, preference: 80, fact: 65, context: 55,
      observation: 45, note: 40, conversation: 30,
    };
    const typeWeight = LAZY_SCORE_TYPE_WEIGHTS[row.type] ?? 50;

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

export function normalizeMemoryRecord(row: any): MemoryRecord {
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
    await assertUnscopedCrudAvailable('memory read', id);

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

  let content = readMemoryContent(row);
  const decryptedRow = { ...row, content };
	const normalized = normalizeMemoryRecord(decryptedRow);
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
  await assertUnscopedCrudAvailable('batch memory read', 'memory_batch_read');

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

      let content = readMemoryContent(row);
      const decryptedRow = { ...row, content };
      const normalized = normalizeMemoryRecord(decryptedRow);
      // Skip team mode check for batch (simplified - trust the caller)
      memories.push(normalized);
    }

    return memories;
  } catch (error) {
    if (error instanceof EncryptedMemoryReadError) throw error;
    logger.debug(`[Memories] getMemoriesByIds failed: ${error}`);
    return [];
  }
}

export async function setConfidence(id: string, level: 'certain' | 'speculative' | 'outdated'): Promise<boolean> {
  requireUuid(id);
  await assertUnscopedCrudAvailable('confidence update', id);

  try {
    const { db, schema } = await getDbClient();
    await db.update(schema.memories)
			.set({ confidenceLevel: level, updatedAt: new Date() })
			.where(eq(schema.memories.id, id));
		return true;
	} catch (error: any) {
		throw error;
	}
}

export async function getRecent(projectPath: string, limit: number, candidateFilter?: { sql: string; params: string[] }): Promise<MemoryRecord[]> {
  try {
    const strict = isStrictTrustPolicy();
    let effectiveFilter = candidateFilter;
    let acl: import('../../core/acl/read-gate.js').AclContext | null = null;
    let effectiveLimit = limit;
    if (strict) {
      let callerId: string;
      try {
        callerId = resolveTrustedCallerId() ?? '';
      } catch {
        await writeTrustAudit({
          actorId: 'unbound',
          resourceId: 'recent-memory-read',
          assetType: 'memory',
          decision: 'deny',
          reason: 'caller_unbound',
        });
        throw new TrustBoundaryError('Strict recent-memory reads require an authenticated caller');
      }
      if (!callerId) throw new TrustBoundaryError('Strict recent-memory reads require an authenticated caller');
      const { buildAutoAclContext, buildStrictMemoryCandidateFilter } = await import('../../core/acl/read-gate.js');
      acl = await buildAutoAclContext(callerId);
      effectiveFilter = await buildStrictMemoryCandidateFilter({ userId: callerId });
      effectiveLimit = Math.max(0, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 10)));
    }

    const { db } = await getDbClient();
    const sqlite = db.$client as any;
    const project = await requireProject(projectPath);
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Use raw SQL to avoid drizzle column name issues. Recent memories feed
    // agent context directly, so apply the same current-lifecycle boundary as
    // retrieval even when the scheduled expiry transition has not run yet.
    const rows = sqlite.prepare(`
      SELECT m.* FROM memories m
      WHERE project_id = ? 
        AND m.status = 'active' AND m.is_active = 1
        AND ${sqlLifecycleBound('m.expires_at', '>')}
        AND ${sqlLifecycleBound('m.valid_from', '<=')}
        AND ${sqlLifecycleBound('m.valid_to', '>')}
      ${effectiveFilter ? `AND ${effectiveFilter.sql}` : ''}
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(project.id, nowSeconds, nowSeconds, nowSeconds, ...(effectiveFilter?.params ?? []), effectiveLimit);

    const normalized = rows.map((row: any) => normalizeMemoryRecord(row));
    if (!strict) return normalized;
    const { applyAclReadGate } = await import('../../core/acl/read-gate.js');
    return await applyAclReadGate(normalized, acl);
  } catch (error: any) {
    throw error;
  }
}