/**
 * Memory-Place Assignments — knowledge_edges backend
 *
 * Reads and writes place assignments via the knowledge_edges table:
 *   from_kind='knowledge', to_kind='place', edge_type='placed_in'
 *   to_id stores the placeType string (e.g. 'wip', 'board', 'ref').
 */

import { randomUUID } from 'crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import { getDb } from '../../db/index.js';
import { logger } from '../logger.js';
import { closeKnowledgeEdge, createKnowledgeEdge } from '../knowledge/knowledge-edges.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';
import { denyUnscopedPlaceOperation } from './strict-gates.js';
import { GLOBAL_PROJECT_PATH } from '../../config.js';
import type { PlaceType } from './places.js';
import type { PlaceCandidate } from './rules.js';

// ── helpers ────────────────────────────────────────────────────────────────

/** Resolve a placeId UUID to its placeType string, or pass through if already a type. */
async function resolvePlaceType(placeIdOrType: string): Promise<string | null> {
  const PLACE_TYPES = ['inbox', 'ref', 'wip', 'sandbox', 'board', 'sparks', 'archive'];
  if (PLACE_TYPES.includes(placeIdOrType)) return placeIdOrType;

  try {
    const db = await getDb();
    const sqlite = (db as any).$client || db;
    const row = sqlite.prepare('SELECT place_type FROM places WHERE id = ?').get(placeIdOrType);
    return row?.place_type ?? null;
  } catch {
    return null;
  }
}

function getSqlite() {
  // Synchronous raw access for internal callers that already have the db cached.
  // getDb() is async but the first call initializes; subsequent calls return the
  // cached instance instantly. We return a promise to stay consistent.
  return getDb().then((db: any) => db.$client || db);
}

/**
 * Sync the memory_count column on the places table for a given placeType.
 * Called after each edge insert/delete to keep the denormalized count accurate.
 */
async function syncPlaceMemoryCount(placeType: string): Promise<void> {
  try {
    const sqlite = await getSqlite();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    sqlite.prepare(
      `UPDATE places AS p
       SET memory_count = (
         SELECT COUNT(DISTINCT e.from_id)
         FROM knowledge_edges e
         JOIN memories m ON m.id = e.from_id
         WHERE e.from_kind = 'knowledge' AND e.to_id = p.place_type
           AND e.to_kind = 'place' AND e.edge_type = 'placed_in'
           AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
           AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
           AND m.status = 'active' AND m.is_active = 1
           AND ${sqlLifecycleBound('m.valid_from', '<=')}
           AND ${sqlLifecycleBound('m.valid_to', '>')}
           AND ${sqlLifecycleBound('m.expires_at', '>')}
           AND (m.project_id = p.project_id OR (m.project_id IS NULL AND EXISTS (
             SELECT 1 FROM projects g WHERE g.id = p.project_id AND g.path = ?
           )))
       )
       WHERE p.place_type = ?`
    ).run(now, now, now, now, nowSeconds, nowSeconds, nowSeconds, GLOBAL_PROJECT_PATH, placeType);
  } catch (e) {
    logger.debug(`[MemoryPlaces] syncPlaceMemoryCount failed: ${e}`);
  }
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Assign a memory to a place (auto or manual).
 * Writes an edge: from_id=memoryId, from_kind='knowledge',
 *                  to_id=placeType, to_kind='place', edge_type='placed_in'
 */
export async function assignMemoryToPlace(params: {
  memoryId: string;
  placeId: string;          // placeType string OR place UUID
  isManual?: boolean;
  ruleId?: string;
}): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('assign_memory', params.memoryId);
  const placeType = await resolvePlaceType(params.placeId);
  if (!placeType) {
    logger.warn(`[MemoryPlaces] Could not resolve place: ${params.placeId}`);
    return false;
  }

  try {
    const meta = params.isManual ? { source: 'manual' } : (params.ruleId ? { ruleId: params.ruleId } : undefined);
    await createKnowledgeEdge({
      fromId: params.memoryId,
      fromKind: 'knowledge',
      toId: placeType,
      toKind: 'place',
      edgeType: 'placed_in',
      weight: 1,
      metadata: meta,
    });
    // Keep the denormalized memory_count in sync
    await syncPlaceMemoryCount(placeType);
    return true;
  } catch (e) {
    logger.debug(`[MemoryPlaces] assignMemoryToPlace failed: ${e}`);
    return false;
  }
}

/**
 * Auto-assign a memory based on rules.
 * Evaluates place rules and writes the best match to knowledge_edges.
 */
export async function autoAssignMemory(params: {
  memoryId: string;
  projectId: string;
  toolName?: string;
  content?: string;
  tags?: string[];
  memoryType?: string;
}): Promise<{ assigned: boolean; placeId?: string; placeType?: PlaceType }> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('auto_assign', params.memoryId);
  try {
    const { findMatchingPlaces } = await import('./rules.js');
    const candidates = await findMatchingPlaces(params.projectId, {
      toolName: params.toolName,
      content: params.content,
      tags: params.tags,
      memoryType: params.memoryType,
    });

    if (candidates.length === 0) return { assigned: false };

    const best = candidates[0];
    const success = await assignMemoryToPlace({
      memoryId: params.memoryId,
      placeId: best.type,
    });

    return { assigned: success, placeId: best.type, placeType: best.type };
  } catch (e) {
    logger.debug(`[MemoryPlaces] autoAssignMemory failed: ${e}`);
    return { assigned: false };
  }
}

/**
 * Manually assign a memory to a place.
 */
export async function manualAssignMemory(params: {
  memoryId: string;
  projectId: string;
  placeType: PlaceType;
}): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('manual_assign', params.memoryId);
  return assignMemoryToPlace({
    memoryId: params.memoryId,
    placeId: params.placeType,
    isManual: true,
  });
}

/**
 * Get the placeType a memory is assigned to.
 * Returns the placeType string (e.g. 'wip') or null.
 */
export async function getMemoryPlace(memoryId: string): Promise<string | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('read_assignment', memoryId);
  try {
    const sqlite = await getSqlite();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const row = sqlite.prepare(
      `SELECT e.to_id FROM knowledge_edges e
       JOIN memories m ON m.id = e.from_id
       WHERE e.from_id = ? AND e.from_kind = 'knowledge' AND e.to_kind = 'place' AND e.edge_type = 'placed_in'
         AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
         AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
         AND m.status = 'active' AND m.is_active = 1
          AND ${sqlLifecycleBound('m.valid_from', '<=')}
          AND ${sqlLifecycleBound('m.valid_to', '>')}
          AND ${sqlLifecycleBound('m.expires_at', '>')}
        ORDER BY e.valid_from DESC, e.recorded_at DESC
       LIMIT 1`
    ).get(memoryId, now, now, now, now, nowSeconds, nowSeconds, nowSeconds);
    return row?.to_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Get memory IDs for a place, ordered by newest first.
 * @param placeIdOrType  placeType string (e.g. 'wip') or place UUID (resolved automatically)
 */
export async function getPlaceMemories(placeIdOrType: string, limit: number = 50, offset: number = 0, projectId?: string): Promise<string[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('list_members', placeIdOrType);
  const placeType = await resolvePlaceType(placeIdOrType);
  if (!placeType) return [];

  try {
    const sqlite = await getSqlite();
    const now = Date.now();
    const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50));
    const safeOffset = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
    const projectJoin = 'JOIN memories m ON m.id = e.from_id';
    const projectFilter = projectId
      ? "AND (m.project_id = ? OR (m.project_id IS NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.path = ?)))"
      : '';
    const rows = sqlite.prepare(
      `SELECT e.from_id FROM knowledge_edges e
       ${projectJoin}
       WHERE e.from_kind = 'knowledge' AND e.to_id = ?
         AND e.to_kind = 'place' AND e.edge_type = 'placed_in'
         AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
         AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
         AND m.status = 'active' AND m.is_active = 1
          AND ${sqlLifecycleBound('m.valid_from', '<=')}
          AND ${sqlLifecycleBound('m.valid_to', '>')}
          AND ${sqlLifecycleBound('m.expires_at', '>')}
          ${projectFilter}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ? OFFSET ?`
    ).all(
      placeType, now, now, now, now,
      Math.floor(now / 1000), Math.floor(now / 1000), Math.floor(now / 1000),
      ...(projectId ? [projectId, projectId, GLOBAL_PROJECT_PATH] : []),
      safeLimit, safeOffset,
    );
    return rows.map((r: any) => r.from_id);
  } catch {
    return [];
  }
}

/**
 * Remove current place assignments while preserving their temporal history.
 */
export async function removeMemoryFromPlace(memoryId: string): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('remove_assignment', memoryId);
  try {
    const sqlite = await getSqlite();
    const now = Date.now();
    // Close current assignment versions instead of erasing their history.
    const affected = sqlite.prepare(
      `SELECT id, to_id FROM knowledge_edges
       WHERE from_id = ? AND from_kind = 'knowledge' AND to_kind = 'place' AND edge_type = 'placed_in'
         AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`
    ).all(memoryId, now, now, now, now) as { id: string; to_id: string }[];

    for (const edge of affected) await closeKnowledgeEdge(edge.id, new Date(now));

    // Sync counts for affected places
    for (const row of affected) {
      await syncPlaceMemoryCount(row.to_id);
    }
    return true;
  } catch (e) {
    logger.debug(`[MemoryPlaces] removeMemoryFromPlace failed: ${e}`);
    return false;
  }
}

/**
 * Initialize memory-place for a project (no-op for knowledge_edges backend).
 */
export async function initializeProjectPlaces(_projectId: string): Promise<{
  initialized: number;
  assigned: number;
}> {
  return { initialized: 0, assigned: 0 };
}

/**
 * Process inbox memories — move unprocessed memories through place pipeline.
 */
export async function processInbox(_projectId: string): Promise<{
  processed: number;
  moved: number;
  errors: number;
}> {
  return { processed: 0, moved: 0, errors: 0 };
}

/**
 * Process inbox for all projects.
 */
export async function processInboxForAllProjects(): Promise<{
  totalProcessed: number;
  totalMoved: number;
  totalErrors: number;
}> {
  return { totalProcessed: 0, totalMoved: 0, totalErrors: 0 };
}

/**
 * Assign a memory to multiple places (1:N multi-place routing).
 * Writes one knowledge_edges row per candidate.
 */
export async function assignMemoryToPlaces(
  memoryId: string,
  candidates: PlaceCandidate[],
  _projectId: string
): Promise<void> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('store_tags', memoryId);
  // Place edges have no signed source/caller contract yet. Strict capture may
  // retain its primary-place field, but must not create unverified graph edges.
  if (isStrictTrustPolicy()) return;
  for (const candidate of candidates) {
    try {
      await assignMemoryToPlace({
        memoryId,
        placeId: candidate.type,
      });
    } catch (e) {
      logger.debug(`[MemoryPlaces] Failed to assign ${memoryId} to ${candidate.type}: ${e}`);
    }
  }
}

/**
 * Store normalized tags in memory_tags table.
 *
 * Normalizes tags using tagNormalizer, removes existing tags for the memory,
 * and inserts the new normalized tags.
 * NOTE: This function operates on memory_tags (still in use), not knowledge_edges.
 */
export async function storeMemoryTags(
  memoryId: string,
  tags: string[],
  source: 'heuristic' | 'llm' | 'manual' | 'dream' = 'heuristic'
): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(
      memoryId,
      'memory_tag',
      'Memory tag indexes are disabled under strict trust until caller-scoped authorization is implemented',
    );
  }

  const db = await getDb();
  if (!db) return;
  const sqliteDb = db as any;
  const client = sqliteDb.$client || sqliteDb;

  if (!tags || tags.length === 0) return;

  // Normalize tags using the tag normalizer
  const { tagNormalizer } = await import('./tag-normalizer.js');
  const normalized = tagNormalizer.normalizeTags(tags);

  // Remove existing tags for this memory
  try {
    client.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);
  } catch {
    // Ignore if table doesn't exist
  }

  // Insert normalized tags using raw SQL
  for (const tag of normalized) {
    const id = randomUUID();
    try {
      client.prepare(
        'INSERT OR IGNORE INTO memory_tags (id, memory_id, tag, source) VALUES (?, ?, ?, ?)'
      ).run(id, memoryId, tag, source);
    } catch (e) {
      logger.debug(`[MemoryTags] Failed to insert tag '${tag}': ${e}`);
    }
  }
}
