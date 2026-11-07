/**
 * Places Module - Spatial memory organization
 * 
 * Provides spatial "places" for memory organization:
 * - Inbox: New memories, unprocessed
 * - Ref: Reference, patterns, research
 * - WIP: Active work, implementations
 * - Sandbox: Experiments, tests
 * - Board: Decisions, planning, roadmap
 * - Sparks: Ideas, future concepts
 * - Archive: Completed, historical
 */

import { randomUUID } from 'crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import { eq, and, isNull, or, desc } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';
import { GLOBAL_PROJECT_PATH } from '../../config.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedPlaceOperation } from './strict-gates.js';
import { closeKnowledgeEdge } from '../knowledge/knowledge-edges.js';

/**
 * Well-known project path for global scope
 * Used for places and rules that are global (not per-project)
 *
 * Defined in config.ts so `normalizeProjectPath()` can leave it alone, and
 * re-exported here because this module is where callers import it from.
 */
export { GLOBAL_PROJECT_PATH };

/**
 * Ensure the global project record exists
 */
export async function ensureGlobalProject(): Promise<{ id: string }> {
  const { getOrCreateProject } = await import('../projects.js');
  const project = await getOrCreateProject(GLOBAL_PROJECT_PATH);
  if (!project) {
    // Fallback: create manually if getOrCreateProject returns null
    const { db, schema } = await getDbClient();
    const id = randomUUID();
    await db.insert(schema.projects).values({
      id,
      name: '__squish_global__',
      path: GLOBAL_PROJECT_PATH,
      metadata: '{}',
    });
    return { id };
  }
  return { id: project.id };
}

// Place types matching the 7 default places
export type PlaceType = 
  | 'inbox' 
  | 'ref' 
  | 'wip' 
  | 'sandbox' 
  | 'board' 
  | 'sparks' 
  | 'archive';

export interface Place {
  id: string;
  projectId: string;
  name: string;
  placeType: PlaceType;
  parentId: string | null;
  sortOrder: number;
  positionX: number;
  positionY: number;
  description: string | null;
  purpose: string | null;
  memoryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaceCreateInput {
  projectId?: string;
  name: string;
  placeType: PlaceType;
  parentId?: string | null;
  sortOrder?: number;
  description?: string;
  purpose?: string;
}

export interface PlaceUpdateInput {
  name?: string;
  description?: string;
  purpose?: string;
  sortOrder?: number;
  positionX?: number;
  positionY?: number;
}

// Default places configuration
export const DEFAULT_PLACES: Omit<PlaceCreateInput, 'projectId'>[] = [
  { name: 'Inbox', placeType: 'inbox', sortOrder: 0, description: 'New memories, unprocessed', purpose: 'Quick inbox for incoming memories' },
  { name: 'Ref', placeType: 'ref', sortOrder: 1, description: 'Reference, patterns, research', purpose: 'Reference knowledge and learned patterns' },
  { name: 'WIP', placeType: 'wip', sortOrder: 2, description: 'Active work, implementations', purpose: 'Active development and recent changes' },
  { name: 'Sandbox', placeType: 'sandbox', sortOrder: 3, description: 'Experiments, tests', purpose: 'Testing and exploration results' },
  { name: 'Board', placeType: 'board', sortOrder: 4, description: 'Decisions, planning, roadmap', purpose: 'Project direction and decisions' },
  { name: 'Sparks', placeType: 'sparks', sortOrder: 5, description: 'Ideas, future concepts', purpose: 'Brainstorming and upcoming plans' },
  { name: 'Archive', placeType: 'archive', sortOrder: 6, description: 'Completed, historical', purpose: 'Reference for completed work' },
];

/**
 * Create a new place.
 * If no projectId provided, uses the global project scope.
 */
export async function createPlace(input: PlaceCreateInput): Promise<Place> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('create', input.projectId ?? 'global');
  const { db, schema } = await getDbClient();
  const id = randomUUID();

  // Default to global project if no projectId
  const resolvedProjectId = input.projectId || (await ensureGlobalProject()).id;

  // Check for duplicate
  const existing = await db.select()
    .from(schema.places)
    .where(and(
      eq(schema.places.projectId, resolvedProjectId),
      eq(schema.places.name, input.name),
      input.parentId
        ? eq(schema.places.parentId, input.parentId)
        : isNull(schema.places.parentId)
    ))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(`Place "${input.name}" already exists`);
  }

  await db.insert(schema.places).values({
    id,
    projectId: resolvedProjectId,
    name: input.name,
    placeType: input.placeType,
    parentId: input.parentId || null,
    sortOrder: input.sortOrder ?? 0,
    positionX: 0,
    positionY: 0,
    description: input.description || null,
    purpose: input.purpose || null,
    memoryCount: 0,
  });

  logger.info(`[Places] Created place: ${input.name} (${input.placeType})`);

  return {
    id,
    projectId: resolvedProjectId,
    name: input.name,
    placeType: input.placeType,
    parentId: input.parentId || null,
    sortOrder: input.sortOrder ?? 0,
    positionX: 0,
    positionY: 0,
    description: input.description || null,
    purpose: input.purpose || null,
    memoryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Get a place by ID
 */
export async function getPlace(id: string): Promise<Place | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('read', id);
  const { db, schema } = await getDbClient();

  const result = await db.select()
    .from(schema.places)
    .where(eq(schema.places.id, id))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    projectId: row.project_id ?? row.projectId ?? null,
    name: row.name,
    placeType: (row.place_type || row.placeType || 'custom') as PlaceType,
    parentId: row.parent_id || row.parentId || null,
    sortOrder: row.sort_order ?? row.sortOrder ?? 0,
    positionX: row.position_x ?? row.positionX ?? 0,
    positionY: row.position_y ?? row.positionY ?? 0,
    description: row.description,
    purpose: row.purpose,
    memoryCount: row.memory_count ?? row.memoryCount ?? 0,
    createdAt: new Date(row.created_at || row.createdAt || Date.now()),
    updatedAt: new Date(row.updated_at || row.updatedAt || Date.now()),
  };
}

/**
 * Get places, optionally filtered by project.
 * If no projectId is provided, returns global places.
 */
export async function getProjectPlaces(projectId?: string): Promise<Place[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('list', projectId ?? 'global');
  const { db, schema } = await getDbClient();

  let results;
  if (projectId) {
    results = await db.select()
      .from(schema.places)
      .where(eq(schema.places.projectId, projectId))
      .orderBy(schema.places.sortOrder);
  } else {
    // Get global places
    const global = await ensureGlobalProject();
    results = await db.select()
      .from(schema.places)
      .where(eq(schema.places.projectId, global.id))
      .orderBy(schema.places.sortOrder);
  }

  return results.map((row: any) => ({
    id: row.id,
    projectId: row.project_id ?? row.projectId ?? null,
    name: row.name,
    placeType: (row.place_type || row.placeType) as PlaceType,
    parentId: row.parent_id || row.parentId,
    sortOrder: row.sort_order ?? row.sortOrder ?? 0,
    positionX: row.position_x ?? row.positionX ?? 0,
    positionY: row.position_y ?? row.positionY ?? 0,
    description: row.description,
    purpose: row.purpose,
    memoryCount: row.memory_count ?? row.memoryCount ?? 0,
    createdAt: new Date(row.created_at || row.createdAt),
    updatedAt: new Date(row.updated_at || row.updatedAt),
  }));
}

/**
 * Get place by type for a project or global scope.
 */
export async function getPlaceByType(projectId: string | undefined, placeType: PlaceType): Promise<Place | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('read_by_type', `${projectId ?? 'global'}:${placeType}`);
  const { db, schema } = await getDbClient();

  // Resolve project ID
  const resolvedProjectId = projectId || (await ensureGlobalProject()).id;

  const result = await db.select()
    .from(schema.places)
    .where(and(
      eq(schema.places.projectId, resolvedProjectId),
      eq(schema.places.placeType, placeType)
    ))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    projectId: row.project_id ?? row.projectId ?? null,
    name: row.name,
    placeType: (row.place_type || row.placeType || 'custom') as PlaceType,
    parentId: row.parent_id || row.parentId || null,
    sortOrder: row.sort_order ?? row.sortOrder ?? 0,
    positionX: row.position_x ?? row.positionX ?? 0,
    positionY: row.position_y ?? row.positionY ?? 0,
    description: row.description,
    purpose: row.purpose,
    memoryCount: row.memory_count ?? row.memoryCount ?? 0,
    createdAt: new Date(row.created_at || row.createdAt || Date.now()),
    updatedAt: new Date(row.updated_at || row.updatedAt || Date.now()),
  };
}

/**
 * Update a place
 */
export async function updatePlace(id: string, input: PlaceUpdateInput): Promise<Place | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('update', id);
  const { db, schema } = await getDbClient();

  const updateData: any = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.purpose !== undefined) updateData.purpose = input.purpose;
  if (input.sortOrder !== undefined) updateData.sortOrder = input.sortOrder;
  if (input.positionX !== undefined) updateData.positionX = input.positionX;
  if (input.positionY !== undefined) updateData.positionY = input.positionY;

  if (Object.keys(updateData).length === 0) {
    return getPlace(id);
  }

  await db.update(schema.places)
    .set(updateData)
    .where(eq(schema.places.id, id));

  return getPlace(id);
}

/**
 * Delete a place
 */
export async function deletePlace(id: string): Promise<boolean> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('delete', id);
  const { db, schema, raw } = await getDbClient();
  const sqlite = raw?.$client;
  if (!sqlite?.prepare || !sqlite?.exec) {
    // Preserve the existing adapter behavior outside the SQLite runtime. The
    // source-backed temporal cleanup below requires SQLite's shared connection.
    await db.delete(schema.places).where(eq(schema.places.id, id));
    logger.info(`[Places] Deleted place: ${id}`);
    return true;
  }

  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const place = sqlite.prepare('SELECT project_id, place_type FROM places WHERE id = ?').get(id) as
      { project_id: string; place_type: string } | undefined;
    if (!place) {
      sqlite.exec('COMMIT');
      return true;
    }

    // Place assignments are temporal edges keyed by place type rather than a
    // foreign key to the catalog row. Close only this project's current edges
    // so removing one project's place cannot change another project's routing.
    const now = Date.now();
    const assignments = sqlite.prepare(`
      SELECT e.id, e.valid_from
      FROM knowledge_edges e
      JOIN memories m ON m.id = e.from_id
      WHERE e.from_kind = 'knowledge' AND e.to_kind = 'place'
        AND e.edge_type = 'placed_in' AND e.to_id = ?
        AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
        AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
        AND (m.project_id = ? OR (m.project_id IS NULL AND EXISTS (
          SELECT 1 FROM projects g WHERE g.id = ? AND g.path = ?
        )))
    `).all(
      place.place_type, now, now, now, now,
      place.project_id, place.project_id, GLOBAL_PROJECT_PATH,
    ) as Array<{ id: string; valid_from: number }>;

    for (const assignment of assignments) {
      const validTo = Math.max(now, assignment.valid_from + 1);
      const closed = await closeKnowledgeEdge(assignment.id, new Date(validTo));
      if (!closed) throw new Error(`Place assignment changed during deletion: ${assignment.id}`);
    }
    sqlite.prepare('DELETE FROM places WHERE id = ?').run(id);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
  logger.info(`[Places] Deleted place: ${id}`);

  return true;
}

/**
 * Initialize 7 default places in the global scope
 * These places are shared across all projects/profiles
 */
export async function initializeGlobalPlaces(): Promise<Place[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('initialize', 'global');
  const global = await ensureGlobalProject();
  return initializeDefaultPlaces(global.id);
}

/**
 * Get places in the global scope
 */
export async function getGlobalPlaces(): Promise<Place[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('list', 'global');
  const global = await ensureGlobalProject();
  return getProjectPlaces(global.id);
}

/**
 * Initialize default 7 places for a project.
 * If no projectId is provided, initializes global places.
 */
export async function initializeDefaultPlaces(projectId?: string): Promise<Place[]> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('initialize', projectId ?? 'global');
  const created: Place[] = [];

  for (const placeConfig of DEFAULT_PLACES) {
    // Check if place of this type already exists
    const existing = await getPlaceByType(projectId, placeConfig.placeType);
    
    if (existing) {
      created.push(existing);
      continue;
    }

    const place = await createPlace({
      projectId,
      name: placeConfig.name,
      placeType: placeConfig.placeType,
      parentId: null,
      sortOrder: placeConfig.sortOrder,
      description: placeConfig.description,
      purpose: placeConfig.purpose,
    });

    created.push(place);
  }

  // Also initialize default rules if none exist
  const { initializeDefaultRules } = await import('./rules.js');
  await initializeDefaultRules(projectId);

  logger.info(`[Places] Initialized ${created.length} default places for project: ${projectId}`);
  return created;
}

/**
 * Get place by loci index
 */
export async function getPlaceByLociIndex(projectId: string | undefined, sortOrder: number): Promise<Place | null> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('read_loci', `${projectId ?? 'global'}:${sortOrder}`);
  const { db, schema } = await getDbClient();

  const resolvedProjectId = projectId || (await ensureGlobalProject()).id;

  const result = await db.select()
    .from(schema.places)
    .where(and(
      eq(schema.places.projectId, resolvedProjectId),
      eq(schema.places.sortOrder, sortOrder)
    ))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    id: row.id,
    projectId: row.project_id ?? row.projectId ?? null,
    name: row.name,
    placeType: (row.place_type || row.placeType || 'custom') as PlaceType,
    parentId: row.parent_id || row.parentId || null,
    sortOrder: row.sort_order ?? row.sortOrder ?? 0,
    positionX: row.position_x ?? row.positionX ?? 0,
    positionY: row.position_y ?? row.positionY ?? 0,
    description: row.description,
    purpose: row.purpose,
    memoryCount: row.memory_count ?? row.memoryCount ?? 0,
    createdAt: new Date(row.created_at || row.createdAt || Date.now()),
    updatedAt: new Date(row.updated_at || row.updatedAt || Date.now()),
  };
}

/**
 * Update memory count for a place.
 * Counts placed_in edges from knowledge_edges for the place's type.
 */
export async function updatePlaceMemoryCount(placeId: string): Promise<void> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('update_count', placeId);
  const { db, schema } = await getDbClient();

  // Resolve the place type and project together to keep counts isolated.
  let placeRow: { place_type: string; project_id: string } | undefined;
  try {
    placeRow = (db as any).$client.prepare(
      'SELECT place_type, project_id FROM places WHERE id = ? LIMIT 1'
    ).get(placeId) as { place_type: string; project_id: string } | undefined;
  } catch {
    // Ignore
  }

  if (!placeRow?.place_type || !placeRow.project_id) {
    logger.warn(`[Places] Could not resolve place type for place ${placeId}`);
    return;
  }

  // Count from knowledge_edges
  let count = 0;
  try {
    const sqlite = (db as any).$client || db;
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const row = sqlite.prepare(
      `SELECT COUNT(DISTINCT e.from_id) as cnt
       FROM knowledge_edges e
       JOIN memories m ON m.id = e.from_id
       WHERE e.from_kind = 'knowledge' AND e.to_id = ?
         AND e.to_kind = 'place' AND e.edge_type = 'placed_in'
         AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
         AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
         AND m.status = 'active' AND m.is_active = 1
          AND ${sqlLifecycleBound('m.valid_from', '<=')}
          AND ${sqlLifecycleBound('m.valid_to', '>')}
          AND ${sqlLifecycleBound('m.expires_at', '>')}
         AND (m.project_id = ? OR (m.project_id IS NULL AND EXISTS (
           SELECT 1 FROM projects g WHERE g.id = ? AND g.path = ?
         )))`
    ).get(
      placeRow.place_type, now, now, now, now, nowSeconds, nowSeconds, nowSeconds,
      placeRow.project_id, placeRow.project_id, GLOBAL_PROJECT_PATH,
    ) as { cnt: number } | undefined;
    count = row?.cnt ?? 0;
  } catch {
    // knowledge_edges table may not exist on very old installs
  }

  await db.update(schema.places)
    .set({ memoryCount: count })
    .where(eq(schema.places.id, placeId));
}

/**
 * Sync all place memory counts - recalculate counts for all places in a project
 * Useful for fixing counts after bulk operations or data recovery
 */
export async function syncAllPlaceMemoryCounts(projectId?: string): Promise<void> {
  if (isStrictTrustPolicy()) await denyUnscopedPlaceOperation('sync_counts', projectId ?? 'global');
  const { db, schema } = await getDbClient();

  const resolvedProjectId = projectId || (await ensureGlobalProject()).id;

  // Get all places for this project
  const allPlaces = await db.select()
    .from(schema.places)
    .where(eq(schema.places.projectId, resolvedProjectId));

  // Update each place's memory count
  for (const place of allPlaces) {
    await updatePlaceMemoryCount(place.id);
  }
  
  logger.info(`[Places] Synced memory counts for ${allPlaces.length} places`);
}

