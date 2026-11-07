/**
 * Graph Pipeline
 *
 * Orchestration layer that connects the knowledge graph extraction components.
 * Wraps extraction, storage, and deduplication into a unified pipeline with
 * progress tracking, error recovery, and stats aggregation.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { extractAndStoreRelations } from './relationship-extractor.js';
import { extractEntitiesAndRelations } from './llm-entity-extractor.js';
import { publishProjectGraphSnapshot } from './snapshot-publisher.js';
import { deduplicateProjectEntities } from './entity-deduplicator.js';
import { getGraphStats } from './graph-builder.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyUnscopedGraphOperation } from './strict-gates.js';
import { filterGraphSourceMemories } from './memory-lifecycle.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  clearExisting?: boolean;
  batchSize?: number;
  preferLLM?: boolean;
  deduplicate?: boolean;
  maxMemories?: number;
  onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
  phase: 'extract' | 'store' | 'dedup' | 'done';
  processed: number;
  total: number;
  entitiesCreated: number;
  relationsCreated: number;
}

export interface PipelineStats {
  memoriesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  entitiesDeduplicated: number;
  errors: number;
  durationMs: number;
  extractionSource: 'llm' | 'regex' | 'mixed';
}

export interface PipelineResult {
  memoryId: string;
  entitiesCreated: number;
  relationsCreated: number;
  source: 'llm' | 'regex' | 'none';
  durationMs: number;
}

export interface ProjectPipelineStats {
  entityCount: number;
  relationCount: number;
  relationTypes: Record<string, number>;
  avgConnections: number;
  lastPipelineAt: Date | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve project ID from a project path. Returns null if not found.
 */
async function resolveProjectId(projectPath: string): Promise<string | null> {
  const db = await getDb();
  const schema = await getSchema();

  const rows = await (db as any)
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.path, projectPath))
    .limit(1);

  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Derive the dominant extraction source from a set of results.
 */
function deriveExtractionSource(sources: Array<'llm' | 'regex' | 'fallback' | 'none'>): 'llm' | 'regex' | 'mixed' {
  const hasLlm = sources.some(s => s === 'llm');
  const hasRegex = sources.some(s => s === 'regex' || s === 'fallback');

  if (hasLlm && hasRegex) return 'mixed';
  if (hasLlm) return 'llm';
  if (hasRegex) return 'regex';
  return 'regex';
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

/**
 * Process all project memories through the knowledge graph pipeline.
 *
 * Pipeline stages:
 *   1. Extract entities and relations from each memory
 *   2. Store extracted data in the knowledge graph
 *   3. Deduplicate entities
 *   4. Compute pipeline stats
 *   5. Emit enrichment hints (auto-export if configured)
 */
export async function buildProjectGraph(
  projectPath: string,
  options?: PipelineOptions
): Promise<PipelineStats> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('project_graph_pipeline', projectPath);
  const startTime = Date.now();
  const {
    clearExisting = false,
    batchSize = 10,
    preferLLM = config.llmEnabled,
    deduplicate = true,
    maxMemories = 100000,
    onProgress,
  } = options || {};

  logger.info('Graph pipeline started', {
    projectPath,
    clearExisting,
    batchSize,
    preferLLM,
    deduplicate,
  });

  // Resolve project
  const projectId = await resolveProjectId(projectPath);
  if (!projectId) {
    logger.warn('Project not found for graph pipeline', { projectPath });
    return emptyStats(Date.now() - startTime);
  }

  const db = await getDb();
  const schema = await getSchema();

  // Fetch all memories for the project (bounded to prevent OOM)
  const projectMemories = await (db as any)
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId))
    .limit(maxMemories);
  const memories = await filterGraphSourceMemories((db as any).$client, projectId, projectMemories);

  const totalMemories = memories.length;

  // Preflight every extraction before clearing the currently published graph.
  // An extraction failure therefore leaves the old graph available.
  const stagedExtractions: Awaited<ReturnType<typeof extractEntitiesAndRelations>>[] | null = clearExisting ? [] : null;
  let stagedEntityCount = 0;
  let stagedRelationCount = 0;
  if (stagedExtractions) {
    for (let index = 0; index < memories.length; index++) {
      const memory = memories[index];
      try {
        const extraction = await extractEntitiesAndRelations(memory.content, { preferLLM });
        stagedExtractions.push(extraction);
        stagedEntityCount += extraction.entities.length;
        stagedRelationCount += extraction.relations.length;
        onProgress?.({
          phase: 'extract',
          processed: index + 1,
          total: totalMemories,
          entitiesCreated: stagedEntityCount,
          relationsCreated: stagedRelationCount,
        });
      } catch (error) {
        logger.error('Pipeline rebuild extraction failed before publish', {
          memoryId: memory.id,
          error: error as Error,
        });
        throw new Error(`Graph pipeline extraction failed for memory ${memory.id}; existing graph was preserved`, { cause: error });
      }
    }

  }

  const stagedStats = stagedExtractions
    ? await publishProjectGraphSnapshot((db as any).$client, projectId, memories, stagedExtractions)
    : null;

  if (totalMemories === 0) {
    logger.info('No memories to process for graph pipeline', { projectPath });
    return emptyStats(Date.now() - startTime);
  }

  let entitiesCreated = stagedStats?.entitiesCreated ?? 0;
  let relationsCreated = stagedStats?.relationsCreated ?? 0;
  let errors = 0;
  const sources: Array<'llm' | 'regex' | 'fallback' | 'none'> = [];
  if (stagedExtractions) sources.push(...stagedExtractions.map((extraction) => extraction.source));

  // ── Phase: Extract + Store ──────────────────────────────────────────

  for (let i = 0; stagedExtractions === null && i < totalMemories; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);

    for (const memory of batch) {
      const processed = Math.min(i + batchSize, totalMemories);

      onProgress?.({
        phase: 'extract',
        processed,
        total: totalMemories,
        entitiesCreated,
        relationsCreated,
      });

      try {
        const result = await extractAndStoreRelations(memory.id, memory.content, projectId, { preferLLM });

        entitiesCreated += result.entities;
        relationsCreated += result.relations;
        sources.push(result.source);
      } catch (error) {
        logger.error('Pipeline: failed to process memory', {
          memoryId: memory.id,
          error: error as Error,
        });
        errors++;
      }
    }

    logger.debug('Pipeline batch progress', {
      processed: Math.min(i + batchSize, totalMemories),
      total: totalMemories,
      entitiesCreated,
      relationsCreated,
    });
  }

  onProgress?.({
    phase: 'store',
    processed: totalMemories,
    total: totalMemories,
    entitiesCreated,
    relationsCreated,
  });

  // ── Phase: Deduplicate ──────────────────────────────────────────────

  let entitiesDeduplicated = 0;

  if (deduplicate) {
    onProgress?.({
      phase: 'dedup',
      processed: totalMemories,
      total: totalMemories,
      entitiesCreated,
      relationsCreated,
    });

    try {
      const dedupResult = await deduplicateProjectEntities(projectId);
      entitiesDeduplicated = dedupResult.merged;

      logger.info('Pipeline deduplication completed', {
        merged: entitiesDeduplicated,
        totalEntities: dedupResult.totalEntities,
        uniqueEntities: dedupResult.uniqueEntities,
      });
    } catch (error) {
      logger.error('Pipeline: deduplication failed', { error: error as Error });
    }
  }

  // ── Phase: Done ─────────────────────────────────────────────────────

  const durationMs = Date.now() - startTime;
  const extractionSource = deriveExtractionSource(sources);

  const stats: PipelineStats = {
    memoriesProcessed: totalMemories,
    entitiesCreated,
    relationsCreated,
    entitiesDeduplicated,
    errors,
    durationMs,
    extractionSource,
  };

  onProgress?.({
    phase: 'done',
    processed: totalMemories,
    total: totalMemories,
    entitiesCreated,
    relationsCreated,
  });

  logger.info('Graph pipeline completed', stats);

  // Emit enrichment hint: auto-export graph visualization if configured
  if (config.graphAutoExport) {
    try {
      const { exportGraphVisualization } = await import('./export.js');
      exportGraphVisualization(projectPath).catch((err: Error) =>
        logger.warn('Pipeline: auto graph export failed', { error: err.message })
      );
    } catch {
      // export module may not exist; ignore
    }
  }

  return stats;
}

// ─── Single Memory Pipeline ─────────────────────────────────────────────────

/**
 * Process a single memory through the knowledge graph pipeline.
 * Used for incremental updates when new memories are stored.
 */
export async function buildMemoryGraph(
  memoryId: string,
  options?: { preferLLM?: boolean }
): Promise<PipelineResult> {
  if (isStrictTrustPolicy()) await denyUnscopedGraphOperation('memory_graph_pipeline', memoryId);
  const startTime = Date.now();
  const preferLLM = options?.preferLLM ?? config.llmEnabled;

  try {
    const result = await import('./graph-builder.js').then(m =>
      m.addMemoryToGraph(memoryId, { preferLLM })
    );

    const durationMs = Date.now() - startTime;

    const pipelineResult: PipelineResult = {
      memoryId,
      entitiesCreated: result.entitiesCreated,
      relationsCreated: result.relationsCreated,
      source: result.source === 'fallback' ? 'regex' : result.source,
      durationMs,
    };

    logger.debug('Pipeline single memory completed', pipelineResult);

    return pipelineResult;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    logger.error('Pipeline single memory failed', {
      memoryId,
      error: error as Error,
      durationMs,
    });

    return {
      memoryId,
      entitiesCreated: 0,
      relationsCreated: 0,
      source: 'none',
      durationMs,
    };
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/**
 * Get knowledge graph statistics for a project, augmented with
 * the last pipeline timestamp if available.
 */
export async function getGraphPipelineStats(
  projectPath: string
): Promise<ProjectPipelineStats> {
  const baseStats = await getGraphStats(projectPath);

  // Attempt to retrieve last pipeline time from project metadata
  let lastPipelineAt: Date | null = null;

  try {
    const db = await getDb();
    const schema = await getSchema();

    const rows = await (db as any)
      .select({ metadata: schema.projects.metadata })
      .from(schema.projects)
      .where(eq(schema.projects.path, projectPath))
      .limit(1);

    if (rows.length > 0) {
      const metadata = (rows[0].metadata as Record<string, unknown>) || {};
      const raw = metadata.lastPipelineAt ?? metadata.lastCognifyAt;
      if (typeof raw === 'string') {
        const parsed = new Date(raw);
        if (!isNaN(parsed.getTime())) {
          lastPipelineAt = parsed;
        }
      } else if (raw instanceof Date) {
        lastPipelineAt = raw;
      }
    }
  } catch (error) {
    logger.debug('Failed to read lastPipelineAt from project metadata', {
      error: error as Error,
    });
  }

  return {
    ...baseStats,
    lastPipelineAt,
  };
}

// ─── Internal ───────────────────────────────────────────────────────────────

function emptyStats(durationMs: number): PipelineStats {
  return {
    memoriesProcessed: 0,
    entitiesCreated: 0,
    relationsCreated: 0,
    entitiesDeduplicated: 0,
    errors: 0,
    durationMs,
    extractionSource: 'regex',
  };
}
