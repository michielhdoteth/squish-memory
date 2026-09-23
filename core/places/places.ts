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
import { eq, and, isNull, or, desc } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

/**
 * Well-known project path for global scope
 * Used for places and rules that are global (not per-project)
 */
export const GLOBAL_PROJECT_PATH = '__squish_global__';

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
  const { db, schema } = await getDbClient();

  await db.delete(schema.places).where(eq(schema.places.id, id));
  logger.info(`[Places] Deleted place: ${id}`);

  return true;
}

/**
 * Initialize 7 default places in the global scope
 * These places are shared across all projects/profiles
 */
export async function initializeGlobalPlaces(): Promise<Place[]> {
  const global = await ensureGlobalProject();
  return initializeDefaultPlaces(global.id);
}

/**
 * Get places in the global scope
 */
export async function getGlobalPlaces(): Promise<Place[]> {
  const global = await ensureGlobalProject();
  return getProjectPlaces(global.id);
}

/**
 * Initialize default 7 places for a project.
 * If no projectId is provided, initializes global places.
 */
export async function initializeDefaultPlaces(projectId?: string): Promise<Place[]> {
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
  const { db, schema } = await getDbClient();

  // Resolve placeId to placeType
  let placeType: string | null = null;
  try {
    const placeRow = (db as any).$client.prepare(
      'SELECT place_type FROM places WHERE id = ? LIMIT 1'
    ).get(placeId) as { place_type: string } | undefined;
    placeType = placeRow?.place_type ?? null;
  } catch {
    // Ignore
  }

  if (!placeType) {
    logger.warn(`[Places] Could not resolve place type for place ${placeId}`);
    return;
  }

  // Count from knowledge_edges
  let count = 0;
  try {
    const sqlite = (db as any).$client || db;
    const row = sqlite.prepare(
      `SELECT COUNT(*) as cnt FROM knowledge_edges
       WHERE to_id = ? AND to_kind = 'place' AND edge_type = 'placed_in'`
    ).get(placeType) as { cnt: number } | undefined;
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

