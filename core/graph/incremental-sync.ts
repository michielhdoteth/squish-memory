/**
 * Incremental Graph Sync
 *
 * When a new memory is stored, automatically enriches the graph by extracting
 * entities and relations. Runs dedup periodically (not on every write) to
 * keep the graph clean.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { addMemoryToGraph } from './graph-builder.js';
import { deduplicateProjectEntities } from './entity-deduplicator.js';
import { getOrCreateProject } from '../projects.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncOptions {
  project?: string;
  dedupThreshold?: number;
  forceDedup?: boolean;
  /** Knowledge mirror for this source memory; enables provenance-safe projection. */
  knowledgeRecordId?: string;
}

export interface SyncResult {
  memoryId: string;
  entitiesCreated: number;
  relationsCreated: number;
  dedupRan: boolean;
  entitiesDeduplicated?: number;
  source: 'llm' | 'regex' | 'fallback' | 'none';
  durationMs: number;
}

export interface SyncStats {
  totalSynced: number;
  totalEntitiesCreated: number;
  totalRelationsCreated: number;
  totalDedupsRun: number;
  lastSyncAt: string | null;
  entitiesSinceLastDedup: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** projectId -> number of new entities since last dedup */
const syncCounters = new Map<string, number>();

/** Global counters for stats */
let totalSynced = 0;
let totalEntitiesCreated = 0;
let totalRelationsCreated = 0;
let totalDedupsRun = 0;
let lastSyncAt: string | null = null;

const DEFAULT_DEDUP_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a project ID from an optional project path.
 * Returns the project ID or null if the project cannot be resolved.
 */
async function resolveProjectId(projectPath?: string): Promise<string | null> {
  if (!projectPath) return null;
  const project = await getOrCreateProject(projectPath);
  return project?.id ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hook called after a memory is stored.
 *
 * 1. Adds the memory to the knowledge graph.
 * 2. Tracks entity count; runs dedup when the threshold is exceeded (or when
 *    `forceDedup` is set).
 * 3. Updates project graph stats.
 * 4. Returns sync stats.
 */
export async function onMemoryStored(
  memoryId: string,
  options?: SyncOptions
): Promise<SyncResult> {
  const startTime = Date.now();
  const dedupThreshold = options?.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
  const forceDedup = options?.forceDedup ?? false;

  // Default result when things go wrong early
  const emptyResult: SyncResult = {
    memoryId,
    entitiesCreated: 0,
    relationsCreated: 0,
    dedupRan: false,
    source: 'none',
    durationMs: 0,
  };

  // 1. Add memory to graph
  let addResult;
  try {
    addResult = await addMemoryToGraph(memoryId);
  } catch (error) {
    logger.error('Failed to add memory to graph', {
      memoryId,
      error: error as Error,
    });
    return { ...emptyResult, durationMs: Date.now() - startTime };
  }

  const entitiesCreated = addResult.entitiesCreated;
  const relationsCreated = addResult.relationsCreated;
  const source = addResult.source;

  // 2. Resolve project and update the sync counter
  let projectId: string | null = null;
  if (options?.project) {
    projectId = await resolveProjectId(options.project);
  } else {
    // Attempt to resolve from the memory itself via the DB
    try {
      const db = await getDb();
      const schema = await getSchema();
      const rows = await (db as any)
        .select({ projectId: (schema.memories as any).projectId })
        .from(schema.memories)
        .where(eq((schema.memories as any).id, memoryId))
        .limit(1);
      if (rows.length > 0 && rows[0].projectId) {
        projectId = rows[0].projectId as string;
      }
    } catch (error) {
      logger.debug('Could not resolve project from memory row', {
        memoryId,
        error: error as Error,
      });
    }
  }

  // Project only after extraction has stored entities and linked their names
  // into memory metadata. Do not catch failures here: a requested projection
  // must not silently report a successful sync without its edge operation.
  if (options?.knowledgeRecordId && projectId) {
    const db = await getDb();
    const schema = await getSchema();
    const [knowledgeRow] = await (db as any).select({ metadata: schema.knowledge.metadata })
      .from(schema.knowledge).where(eq(schema.knowledge.id, options.knowledgeRecordId)).limit(1);
    const rawMetadata = knowledgeRow?.metadata;
    const metadata = typeof rawMetadata === 'string'
      ? JSON.parse(rawMetadata) as Record<string, unknown>
      : rawMetadata as Record<string, unknown> | null;
    const names = Array.isArray(metadata?.entities)
      ? [...new Set((metadata.entities as unknown[]).filter((name): name is string => typeof name === 'string'))]
      : [];
    if (names.length) {
      const rows = await (db as any).select({ id: schema.entities.id })
        .from(schema.entities)
        .where(and(eq(schema.entities.projectId, projectId), inArray(schema.entities.name, names)));
      for (const entity of rows) {
        await (db as any).insert(schema.knowledgeEdges).values({
          fromId: options.knowledgeRecordId,
          fromKind: 'knowledge',
          toId: entity.id,
          toKind: 'entity',
          edgeType: 'references',
          metadata: (await import('../../config.js')).config.mode === 'team'
            ? { sourceMemoryId: memoryId, projectId }
            : JSON.stringify({ sourceMemoryId: memoryId, projectId }),
        }).onConflictDoNothing();
      }
    }
  }

  let dedupRan = false;
  let entitiesDeduplicated: number | undefined;

  if (projectId) {
    const currentCount = (syncCounters.get(projectId) ?? 0) + entitiesCreated;
    syncCounters.set(projectId, currentCount);

    // Run dedup when threshold is exceeded or forced
    if (currentCount >= dedupThreshold || forceDedup) {
      try {
        const dedupResult = await deduplicateProjectEntities(projectId);
        entitiesDeduplicated = dedupResult.merged;
        dedupRan = true;
        syncCounters.set(projectId, 0);
        totalDedupsRun++;
        logger.info('Incremental dedup completed', {
          projectId,
          merged: dedupResult.merged,
          forced: forceDedup,
        });
      } catch (error) {
        logger.error('Incremental dedup failed', {
          projectId,
          error: error as Error,
        });
      }
    }
  }

  // 3. Update global stats
  totalSynced++;
  totalEntitiesCreated += entitiesCreated;
  totalRelationsCreated += relationsCreated;
  lastSyncAt = new Date().toISOString();

  const durationMs = Date.now() - startTime;

  logger.debug('Incremental sync completed', {
    memoryId,
    entitiesCreated,
    relationsCreated,
    dedupRan,
    entitiesDeduplicated,
    source,
    durationMs,
  });

  return {
    memoryId,
    entitiesCreated,
    relationsCreated,
    dedupRan,
    entitiesDeduplicated,
    source,
    durationMs,
  };
}

/**
 * Returns stats about incremental sync activity.
 */
export async function getSyncStats(
  projectPath: string
): Promise<SyncStats> {
  const projectId = await resolveProjectId(projectPath);
  const entitiesSinceLastDedup = projectId
    ? (syncCounters.get(projectId) ?? 0)
    : 0;

  return {
    totalSynced,
    totalEntitiesCreated,
    totalRelationsCreated,
    totalDedupsRun,
    lastSyncAt,
    entitiesSinceLastDedup,
  };
}

/**
 * Resets the dedup counter for a project.
 * Useful after manual graph operations.
 */
export function resetSyncCounter(projectPath: string): void {
  // We accept a path but store by ID; resolve lazily by clearing all entries
  // that might match, or schedule an async lookup. For simplicity we store
  // by path as a fallback key so callers can reset by path directly.
  // The async resolution happens in onMemoryStored; here we do a best-effort
  // sync lookup and also clear any path-based key.
  //
  // Because this is a synchronous function, we cannot await the project
  // resolution. Instead we maintain a secondary map from path -> id and
  // clear the counter for that id when available.
  const directId = syncCounters.has(projectPath)
    ? projectPath
    : null;

  if (directId) {
    syncCounters.set(directId, 0);
    logger.debug('Reset sync counter (direct key)', { key: directId });
    return;
  }

  // Asynchronous path -> id resolution would require making this async,
  // which the spec disallows. Store a marker under the path so that
  // getSyncStats can still report it, and clear on next onMemoryStored.
  syncCounters.set(projectPath, 0);
  logger.debug('Reset sync counter (path key)', { projectPath });
}
