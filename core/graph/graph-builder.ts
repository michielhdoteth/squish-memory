/**
 * Graph Builder
 * 
 * Orchestrates the full pipeline: extract entities and relations from
 * memories and store them in the knowledge graph.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { extractAndStoreRelations, getEntityRelations } from './relationship-extractor.js';
import { extractEntitiesAndRelations } from './llm-entity-extractor.js';
import { publishProjectGraphSnapshot } from './snapshot-publisher.js';
import { deduplicateProjectEntities } from './entity-deduplicator.js';
import { emit } from '../event-bus.js';
import { getMemoryAssociationRows } from '../associations.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';
import { filterGraphSourceMemories } from './memory-lifecycle.js';

export interface GraphBuildStats {
  memoriesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  entitiesDeduplicated: number;
  errors: number;
  durationMs: number;
}

export interface GraphAddStats {
  entitiesCreated: number;
  relationsCreated: number;
  source: 'llm' | 'regex' | 'fallback' | 'none';
}

/**
 * Build or rebuild the entity graph for a project.
 * Processes all memories in the project, extracting entities and relations.
 */
export async function buildGraphForProject(
  projectPath: string,
  options?: {
    clearExisting?: boolean;
    batchSize?: number;
    preferLLM?: boolean;
    deduplicate?: boolean;
  }
): Promise<GraphBuildStats> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('project_graph_build', projectPath);
  const startTime = Date.now();
  const {
    clearExisting = false,
    batchSize = 10,
    preferLLM = true,
    deduplicate = true,
  } = options || {};

  const db = await getDb();
  const schema = await getSchema();

  // Get project
  const projectRows = await (db as any)
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.path, projectPath))
    .limit(1);

  if (projectRows.length === 0) {
    logger.warn('Project not found for graph build', { projectPath });
    return {
      memoriesProcessed: 0,
      entitiesCreated: 0,
      relationsCreated: 0,
      entitiesDeduplicated: 0,
      errors: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const projectId = projectRows[0].id;

  // Get all active memories for the project
  const projectMemories = await (db as any)
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId));
  const memories = await filterGraphSourceMemories((db as any).$client, projectId, projectMemories);

  // Complete extraction before clearing the published graph. This preserves
  // the current graph if a provider/parser fails partway through preflight.
  const stagedExtractions: Awaited<ReturnType<typeof extractEntitiesAndRelations>>[] | null = clearExisting ? [] : null;
  if (stagedExtractions) {
    for (const memory of memories) {
      try {
        stagedExtractions.push(await extractEntitiesAndRelations(memory.content, { preferLLM }));
      } catch (error) {
        logger.error('Graph rebuild extraction failed before publish', {
          memoryId: memory.id,
          error: error as Error,
        });
        throw new Error(`Graph rebuild extraction failed for memory ${memory.id}; existing graph was preserved`, { cause: error });
      }
    }

  }

  const stagedStats = stagedExtractions
    ? await publishProjectGraphSnapshot((db as any).$client, projectId, memories, stagedExtractions)
    : null;

  logger.info('Starting graph build for project', {
    projectId,
    memoryCount: memories.length,
    clearExisting,
  });

  let entitiesCreated = stagedStats?.entitiesCreated ?? 0;
  let relationsCreated = stagedStats?.relationsCreated ?? 0;
  let errors = 0;

  // Process memories in batches
  for (let i = 0; stagedExtractions === null && i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);

    for (const memory of batch) {
      try {
        const result = await extractAndStoreRelations(memory.id, memory.content, projectId, { preferLLM });

        entitiesCreated += result.entities;
        relationsCreated += result.relations;
      } catch (error) {
        logger.error('Error processing memory for graph', {
          memoryId: memory.id,
          error: error as Error,
        });
        errors++;
      }
    }

    logger.debug('Graph build batch progress', {
      processed: Math.min(i + batchSize, memories.length),
      total: memories.length,
    });
  }

  // Deduplicate entities
  let entitiesDeduplicated = 0;
  if (deduplicate) {
    try {
      const dedupResult = await deduplicateProjectEntities(projectId);
      entitiesDeduplicated = dedupResult.merged;
    } catch (error) {
      logger.error('Error during entity deduplication', { error: error as Error });
    }
  }

  const stats: GraphBuildStats = {
    memoriesProcessed: memories.length,
    entitiesCreated,
    relationsCreated,
    entitiesDeduplicated,
    errors,
    durationMs: Date.now() - startTime,
  };

  logger.info('Graph build completed', stats);

  emit({
    type: 'graph:rebuilt',
    payload: {
      project: projectPath,
      stats: {
        memoriesProcessed: stats.memoriesProcessed,
        entitiesCreated: stats.entitiesCreated,
        relationsCreated: stats.relationsCreated,
        entitiesDeduplicated: stats.entitiesDeduplicated,
        errors: stats.errors,
        durationMs: stats.durationMs,
      },
    },
  });

  // Auto-export graph visualization if enabled
  if (config.graphAutoExport) {
    try {
      const { exportGraphVisualization } = await import('./export.js');
      exportGraphVisualization(projectPath).catch((err: Error) =>
        logger.warn('Auto graph export failed', { error: err.message })
      );
    } catch {}
  }

  return stats;
}

/**
 * Add a single memory to the knowledge graph.
 * Used for incremental updates when new memories are stored.
 */
export async function addMemoryToGraph(
  memoryId: string,
  options?: {
    preferLLM?: boolean;
  }
): Promise<GraphAddStats> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('memory_graph_build', memoryId);
  const db = await getDb();
  const schema = await getSchema();

  // Get the memory
  const memories = await (db as any)
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, memoryId))
    .limit(1);

  if (memories.length === 0) {
    return { entitiesCreated: 0, relationsCreated: 0, source: 'none' };
  }

  const memory = memories[0];

  if (!memory.projectId) {
    return { entitiesCreated: 0, relationsCreated: 0, source: 'none' as const };
  }

  if (!(await filterGraphSourceMemories((db as any).$client, memory.projectId, memories)).length) {
    return { entitiesCreated: 0, relationsCreated: 0, source: 'none' as const };
  }

  // Use global config if not explicitly overridden
  const preferLLM = options?.preferLLM ?? config.llmEnabled;

  const result = await extractAndStoreRelations(
    memoryId,
    memory.content,
    memory.projectId,
    { preferLLM }
  );

  return {
    entitiesCreated: result.entities,
    relationsCreated: result.relations,
    source: result.source,
  };
}

/**
 * Get graph statistics for a project.
 */
export async function getGraphStats(projectPath: string): Promise<{
  entityCount: number;
  relationCount: number;
  relationTypes: Record<string, number>;
  avgConnections: number;
}> {
  if (isStrictTrustPolicy()) {
    await denyUnscopedGraphOperation('statistics', projectPath);
  }
  const db = await getDb();
  const schema = await getSchema();

  const projectRows = await (db as any)
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.path, projectPath))
    .limit(1);

  if (projectRows.length === 0) {
    return { entityCount: 0, relationCount: 0, relationTypes: {}, avgConnections: 0 };
  }

  const projectId = projectRows[0].id;

  const entities = await (db as any)
    .select()
    .from(schema.entities)
    .where(eq(schema.entities.projectId, projectId));

  const entityIds = entities.map((e: any): string => e.id);
  const projectRelations = await getEntityRelations(entityIds);

  // Explicit memory<->memory associations (squish_link and co-occurrence
  // auto-links) are canonical graph edges. Scope them through the from-memory row -
  // the same convention core/memory/stats.ts uses for totalLinks - and count
  // them on top of entity relations so relationCount reflects real links
  // (visibility only; retrieval scoring is untouched).
  const projectMemories = await (db as any)
    .select({ id: schema.memories.id })
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId));
  const projectMemoryIds = new Set(projectMemories.map((memory: { id: string }) => memory.id));
  const associations = (await getMemoryAssociationRows())
    .filter((association) => projectMemoryIds.has(association.fromMemoryId));

  // Count by type
  const relationTypes: Record<string, number> = {};
  for (const r of projectRelations) {
    const type = r.relationType || 'unknown';
    relationTypes[type] = (relationTypes[type] || 0) + 1;
  }
  for (const a of associations) {
    const type = a.associationType || 'unknown';
    relationTypes[type] = (relationTypes[type] || 0) + 1;
  }

  const avgConnections = entities.length > 0
    ? (projectRelations.length * 2) / entities.length
    : 0;

  return {
    entityCount: entities.length,
    relationCount: projectRelations.length + associations.length,
    relationTypes,
    avgConnections: Math.round(avgConnections * 100) / 100,
  };
}
