/**
 * Memory-Place Assignments — knowledge_edges backend
 *
 * Reads and writes place assignments via the knowledge_edges table:
 *   from_kind='knowledge', to_kind='place', edge_type='placed_in'
 *   to_id stores the placeType string (e.g. 'wip', 'board', 'ref').
 */

import { randomUUID } from 'crypto';
import { getDb } from '../../db/index.js';
import { logger } from '../logger.js';
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
    const row = sqlite.prepare(
      `SELECT COUNT(*) as cnt FROM knowledge_edges
       WHERE to_id = ? AND to_kind = 'place' AND edge_type = 'placed_in'`
    ).get(placeType) as { cnt: number };
    sqlite.prepare(
      `UPDATE places SET memory_count = ? WHERE place_type = ?`
    ).run(row.cnt, placeType);
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
  const placeType = await resolvePlaceType(params.placeId);
  if (!placeType) {
    logger.warn(`[MemoryPlaces] Could not resolve place: ${params.placeId}`);
    return false;
  }

  try {
    const sqlite = await getSqlite();
    const id = randomUUID();
    const meta = params.isManual ? JSON.stringify({ source: 'manual' }) : (params.ruleId ? JSON.stringify({ ruleId: params.ruleId }) : null);
    sqlite.prepare(
      `INSERT OR IGNORE INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at)
       VALUES (?, ?, 'knowledge', ?, 'place', 'placed_in', 1.0, ?, ?)`
    ).run(id, params.memoryId, placeType, meta, Math.floor(Date.now() / 1000));
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
  try {
    const sqlite = await getSqlite();
    const row = sqlite.prepare(
      `SELECT to_id FROM knowledge_edges
       WHERE from_id = ? AND from_kind = 'knowledge' AND edge_type = 'placed_in'
       ORDER BY rowid DESC
       LIMIT 1`
    ).get(memoryId);
    return row?.to_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Get memory IDs for a place, ordered by newest first.
 * @param placeIdOrType  placeType string (e.g. 'wip') or place UUID (resolved automatically)
 */
export async function getPlaceMemories(placeIdOrType: string, limit: number = 50): Promise<string[]> {
  const placeType = await resolvePlaceType(placeIdOrType);
  if (!placeType) return [];

  try {
    const sqlite = await getSqlite();
    const rows = sqlite.prepare(
      `SELECT from_id FROM knowledge_edges
       WHERE to_id = ? AND to_kind = 'place' AND edge_type = 'placed_in'
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(placeType, limit);
    return rows.map((r: any) => r.from_id);
  } catch {
    return [];
  }
}

/**
 * Remove a memory from all places (deletes all placed_in edges).
 */
export async function removeMemoryFromPlace(memoryId: string): Promise<boolean> {
  try {
    const sqlite = await getSqlite();
    // Find affected placeTypes before deleting so we can sync counts
    const affected = sqlite.prepare(
      `SELECT DISTINCT to_id FROM knowledge_edges
       WHERE from_id = ? AND from_kind = 'knowledge' AND edge_type = 'placed_in'`
    ).all(memoryId) as { to_id: string }[];

    sqlite.prepare(
      `DELETE FROM knowledge_edges
       WHERE from_id = ? AND from_kind = 'knowledge' AND edge_type = 'placed_in'`
    ).run(memoryId);

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
