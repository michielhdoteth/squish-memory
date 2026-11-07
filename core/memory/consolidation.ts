/**
 * Memory Consolidation System
 * Implements experience replay and memory consolidation with geometry-aware compression.
 *
 * Before consolidating a cluster, the system checks whether it's geometrically safe:
 * - Computes d_bar (mean within-cluster cosine distance)
 * - Computes d_eff (effective dimension via PCA eigenvalue ratio)
 * - If d_bar < theta_prime: consolidation is safe (cluster is tight)
 * - If d_bar >= theta_prime: cluster is too diverse, skip or split
 *
 * Falls back to extractive summary if geometry is disabled.
 */

import { createHash } from 'crypto';
import { eq, inArray, and } from 'drizzle-orm';
import { withSqliteTransaction } from '../storage/sqlite-transaction.js';
import { config } from '../../config.js';
import { createDatabaseClient } from '../storage/database.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { getDbClient } from '../lib/db-client.js';
import { getEmbedding } from '../../core/embeddings.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { getLowImportanceMemories } from './importance.js';
import { rememberMemory } from './memories.js';
import { rememberMemoryWithConsolidatedSource } from './memory-write.js';
import { normalizeMemoryRecord } from './memory-crud.js';
import { logger } from '../logger.js';
import { callLLM } from '../llm/client.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

async function denyStrictConsolidationSurface(resourceId: string, message: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(resourceId, 'memory', message);
  }
}

interface SqliteTransactionBoundary {
  exec: (sql: string) => void;
  inTransaction?: boolean;
}

async function withSqliteTransactionBoundary<T>(sqlite: SqliteTransactionBoundary, operation: () => Promise<T>): Promise<T> {
  return withSqliteTransaction(sqlite, operation);
}

// Geometry-aware consolidation imports
import {
  computeCentroid,
} from '../clustering/geometry.js';

// GAC strategy selector (Layer 3: integration)
import {
  selectGACStrategy,
  findMedoid,
  computeMedoidWithResiduals,
  pruneDiverseCluster,
  type GACDecision,
  type ResidualBudget,
} from '../clustering/gac-strategy.js';

// Cluster engine for persistent clustering
import {
  findOrCreateCluster,
  getClusterMemories,
  updateClusterStats,
  clearClusters,
} from '../clustering/cluster-engine.js';

export interface ConsolidationOptions {
  projectId?: string; // optional — when undefined, consolidates across all projects
  minAge?: number; // days - minimum age for consolidation
  maxImportance?: number; // 0-100 - maximum importance to consolidate
  minClusterSize?: number; // minimum memories in a cluster to consolidate
  similarityThreshold?: number; // 0-1 - minimum similarity to cluster
  limit?: number; // max memories to process
  preConsolidationReduction?: boolean; // NEW: reduce dimensions before clustering
}

export interface ConsolidationResult {
  consolidatedMemoryId: string;
  sourceMemoryIds: string[];
  clusterSize: number;
  summary: string;
  geometrySafe?: boolean;  // Whether geometry check passed
  dBar?: number;           // Mean cosine distance (if geometry checked)
  dEff?: number;           // Effective dimension (if geometry checked)
  gacStrategy?: string;    // GAC strategy used (centroid, medoid-residual, prune)
  gacDecision?: GACDecision; // Full GAC decision object
}

export interface ClusterResult {
  memories: any[];
  similarity: number;
  representativeId: string;
}

export interface ReviewedMemoryCompactionInput {
  sourceMemoryId: string;
  compactedContent: string;
  modelId: string;
  promptVersion: string;
}

export interface ReviewedMemoryCompactionResult {
  memoryId: string;
  sourceMemoryId: string;
  sourceLength: number;
  compactedLength: number;
}

/**
 * Store a user-reviewed local-model rewrite as a derived memory and retain the
 * original as its reversible source. Unreviewed model output is never written.
 */
export async function applyReviewedMemoryCompaction(
  input: ReviewedMemoryCompactionInput,
): Promise<ReviewedMemoryCompactionResult> {
  await denyStrictConsolidationSurface('reviewed_memory_compaction', 'Memory compaction requires caller-scoped source authorization under strict trust');

  const sourceMemoryId = input.sourceMemoryId.trim();
  const compactedContent = input.compactedContent.trim();
  const modelId = input.modelId.trim();
  const promptVersion = input.promptVersion.trim();
  if (!sourceMemoryId || !compactedContent || compactedContent.length > 12_000 || !modelId || !promptVersion) {
    throw new Error('Reviewed compaction input is incomplete or too large.');
  }

  const { db, schema } = await getDbClient();
  const sourceRows = await db.select().from(schema.memories)
    .where(eq(schema.memories.id, sourceMemoryId)).limit(1);
  const sourceState = sourceRows[0];
  if (!sourceState) throw new Error('The source memory no longer exists.');
  const source = normalizeMemoryRecord(sourceState);
  if (!source.content.trim() || compactedContent.length >= Math.ceil(source.content.trim().length * 0.9)) {
    throw new Error('The proposed memory is not shorter enough to compact.');
  }
  if (!sourceState?.isActive) throw new Error('Only active memories can be compacted.');
  if (sourceState.isConsolidated) throw new Error('This memory is already part of a consolidation.');
  if (sourceState.isProtected || sourceState.isPinned || sourceState.hasSecrets) {
    throw new Error('Protected, pinned, or secret-bearing memories cannot be compacted.');
  }
  if (sourceState.teamId) throw new Error('Team-scoped memories need an authorized team consolidation route.');

  const allowedTypes = new Set(['observation', 'fact', 'decision', 'context', 'preference', 'note', 'task']);
  const memoryType = allowedTypes.has(source.type) ? source.type : 'note';
  let projectPath: string | undefined;
  if (source.projectId) {
    const projects = await db.select({ path: schema.projects.path })
      .from(schema.projects)
      .where(eq(schema.projects.id, source.projectId))
      .limit(1);
    projectPath = projects[0]?.path ?? undefined;
  }

  const digest = createHash('sha256').update(`${sourceMemoryId}\n${modelId}\n${promptVersion}\n${compactedContent}`).digest('hex');
  const created = await rememberMemoryWithConsolidatedSource({
    content: compactedContent,
    type: memoryType as 'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note' | 'task',
    tags: source.tags,
    project: projectPath,
    user: sourceState.userId ?? undefined,
    source: 'reviewed-local-model-compaction',
    captureKey: `reviewed-compaction-v1:${digest}`,
    metadata: {
      consolidatedFrom: [sourceMemoryId],
      clusterSize: 1,
      compactionSourceMemoryId: sourceMemoryId,
      compactionModelId: modelId,
      compactionPromptVersion: promptVersion,
      compactionReviewedAt: new Date().toISOString(),
    },
  }, {
    id: sourceMemoryId,
    content: sourceState.content,
    projectId: sourceState.projectId ?? null,
    userId: sourceState.userId ?? null,
    type: sourceState.type,
  });
  return {
    memoryId: created.id,
    sourceMemoryId,
    sourceLength: source.content.length,
    compactedLength: compactedContent.length,
  };
}

/**
 * Main consolidation function - consolidates low-importance old memories
 */
export async function consolidateMemories(
  options: ConsolidationOptions
): Promise<ConsolidationResult[]> {
  await denyStrictConsolidationSurface('consolidation_run', 'Memory consolidation is disabled under strict trust');

  const {
    projectId,
    minAge = 90,
    maxImportance = 30,
    minClusterSize = 3,
    similarityThreshold = 0.7,
    limit = 100,
  } = options;

  // Get low-importance, old memories
  const candidates = await getLowImportanceMemories(projectId, {
    minAge,
    maxImportance,
    limit,
  });

  if (candidates.length < minClusterSize) {
    logger.debug('Not enough memories to consolidate', {
      count: candidates.length,
      minClusterSize,
    });
    return [];
  }

  // Cluster memories using the cluster engine (centroid-based, persistent within run)
  clearClusters(); // fresh state for each maintenance run
  const clusters = await clusterMemoriesWithEngine(candidates, {
    minClusterSize,
    similarityThreshold,
  });

  logger.info(`Found ${clusters.length} memory clusters for consolidation`);

  const results: ConsolidationResult[] = [];

  // Consolidate each cluster
  for (const cluster of clusters) {
    try {
      const result = await consolidateCluster(cluster);
      results.push(result);
    } catch (error) {
      logger.error('Failed to consolidate cluster', error);
    }
  }

  return results;
}

/**
 * Cluster memories using the cluster engine (centroid-based).
 * Uses findOrCreateCluster() which assigns each memory to the nearest existing
 * cluster or creates a new one, based on embedding similarity to centroids.
 */
async function clusterMemoriesWithEngine(
  memories: any[],
  options: {
    minClusterSize?: number;
    similarityThreshold?: number;
  } = {}
): Promise<ClusterResult[]> {
  const { minClusterSize = 3, similarityThreshold = 0.7 } = options;

  // Assign each memory to a cluster via the cluster engine
  for (const memory of memories) {
    const emb = parseEmbedding(memory.embedding) ?? parseEmbedding(memory.embedding_json);
    if (emb) {
      await findOrCreateCluster(memory.id, emb, similarityThreshold, memory.embeddingModel ?? null);
    }
  }

  // Build ClusterResult[] from the engine's clusters
  const allClusterIds = (await import('../clustering/cluster-engine.js')).getAllClusterIds();
  const results: ClusterResult[] = [];

  for (const clusterId of allClusterIds) {
    const memoryIds = await getClusterMemories(clusterId);
    if (memoryIds.length < minClusterSize) continue;

    // Fetch the actual memory objects
    const clusterMemories = memories.filter(m => memoryIds.includes(m.id));
    if (clusterMemories.length < minClusterSize) continue;

    // Use first memory as representative (medoid selection happens in GAC)
    results.push({
      memories: clusterMemories,
      similarity: 0, // computed by GAC later
      representativeId: clusterMemories[0].id,
    });
  }

  return results;
}



/**
 * Extracts embedding vectors from cluster memories.
 * Returns null if no embeddings can be extracted.
 */
function extractClusterEmbeddings(memories: any[]): number[][] | null {
  const vectors: number[][] = [];
  for (const mem of memories) {
    const emb = parseEmbedding(mem.embedding) ?? parseEmbedding(mem.embedding_json);
    if (emb && emb.length > 0) {
      vectors.push(emb);
    }
  }
  return vectors.length >= 2 ? vectors : null;
}



/**
 * Pre-consolidation dimensionality reduction.
 * Randomly reduces dimensions by 50% before clustering for efficiency.
 * Safe per Takeshita et al. (EMNLP 2025) - 50% random removal retains 90%+ performance.
 *
 * @param vectors - Array of embedding vectors
 * @param reductionRatio - Fraction of dimensions to remove (default 0.5)
 * @returns Array of reduced-dimension vectors
 */
export function preConsolidationReduction(vectors: number[][], reductionRatio: number = 0.5): number[][] {
  if (vectors.length === 0) return vectors;
  const d = vectors[0].length;
  const keepDims = Math.max(1, Math.floor(d * (1 - reductionRatio)));

  // Deterministic random selection for reproducibility
  const indices: number[] = [];
  const step = Math.floor(d / keepDims);
  for (let i = 0; i < d && indices.length < keepDims; i += step) {
    indices.push(i);
  }

  return vectors.map(v => indices.map(i => v[i]));
}

/**
 * Consolidate a cluster of memories into a single summary memory.
 *
 * When geometry-aware consolidation (GAC) is enabled:
 * 1. Extract embeddings from cluster memories
 * 2. Call selectGACStrategy to determine optimal strategy
 * 3. Execute the chosen strategy:
 *    - centroid: Use nearest-to-centroid as representative
 *    - medoid-residual: Use medoid, store principal directions in metadata
 *    - prune: Keep top distinct members, consolidate the rest
 * 4. Store full GAC decision in consolidated memory metadata
 *
 * When geometry is disabled: falls back to extractive summary.
 */
async function consolidateCluster(
  cluster: ClusterResult,
  options?: ConsolidationOptions,
): Promise<ConsolidationResult> {
  const { memories } = cluster;
  const sourceMemoryIds = memories.map((m: any) => m.id);

  // Check if geometry-aware consolidation is enabled
  if (config.consolidationGeometryEnabled) {
    const vectors = extractClusterEmbeddings(memories);

    if (vectors) {
      // Use GAC strategy selector for the 3-way decision
      const thetaPrime = config.consolidationGeometryThetaPrime;
      const decision = selectGACStrategy(memories, thetaPrime);

      logger.debug('GAC strategy selected', {
        strategy: decision.strategy,
        dBar: decision.dBar.toFixed(4),
        dEff: decision.dEff.toFixed(2),
        rhoC: decision.rhoC.toFixed(4),
      });

      switch (decision.strategy) {
        case 'centroid': {
          // Tight cluster: use medoid as representative
          const medoid = findMedoid(memories, computeCentroid(vectors));
          const summary = `[Consolidated] ${medoid.content}`;

          const consolidated = await rememberMemory({
            content: summary,
            type: 'context',
            metadata: {
              consolidatedFrom: sourceMemoryIds,
              consolidatedAt: new Date().toISOString(),
              clusterSize: memories.length,
              avgSimilarity: cluster.similarity,
              // GAC metadata
              gacStrategy: decision.strategy,
              gacDBar: decision.dBar,
              gacDEff: decision.dEff,
              gacRhoC: decision.rhoC,
              gacSpreadSafe: decision.spreadSafe,
              gacSpreadUnsafe: decision.spreadUnsafe,
              gacRepresentatives: decision.representatives,
              gacReason: decision.reason,
            },
            tags: ['consolidated', 'geometry-safe', 'gac-centroid'],
          });

          await markConsolidated(consolidated.id, sourceMemoryIds);

          logger.info('GAC centroid consolidation', {
            consolidatedId: consolidated.id,
            sourceCount: memories.length,
            dBar: decision.dBar.toFixed(4),
            dEff: decision.dEff.toFixed(2),
          });

          return {
            consolidatedMemoryId: consolidated.id,
            sourceMemoryIds,
            clusterSize: memories.length,
            summary,
            geometrySafe: true,
            dBar: decision.dBar,
            dEff: decision.dEff,
            gacStrategy: decision.strategy,
            gacDecision: decision,
          };
        }

        case 'medoid-residual': {
          // Borderline cluster: use medoid + residual directions
          const centroid = computeCentroid(vectors);
          const residualRank = Math.min(6, Math.max(1, Math.floor(decision.dEff)));
          const budget: ResidualBudget = computeMedoidWithResiduals(memories, centroid, residualRank);

          // Use the medoid's content as the consolidated summary
          const medoidMemory = memories.find((m: any) => m.id === budget.medoidId) ?? memories[0];
          const summary = `[Consolidated-Medoid] ${medoidMemory.content}`;

          const consolidated = await rememberMemory({
            content: summary,
            type: 'context',
            metadata: {
              consolidatedFrom: sourceMemoryIds,
              consolidatedAt: new Date().toISOString(),
              clusterSize: memories.length,
              avgSimilarity: cluster.similarity,
              // GAC metadata
              gacStrategy: decision.strategy,
              gacDBar: decision.dBar,
              gacDEff: decision.dEff,
              gacRhoC: decision.rhoC,
              gacSpreadSafe: decision.spreadSafe,
              gacSpreadUnsafe: decision.spreadUnsafe,
              gacRepresentatives: decision.representatives,
              gacReason: decision.reason,
              residualBudget: {
                medoidId: budget.medoidId,
                principalDirections: budget.principalDirections.length,
                scalingFactor: budget.scalingFactor,
              },
            },
            tags: ['consolidated', 'geometry-borderline', 'gac-medoid-residual'],
          });

          await markConsolidated(consolidated.id, sourceMemoryIds);

          logger.info('GAC medoid-residual consolidation', {
            consolidatedId: consolidated.id,
            sourceCount: memories.length,
            medoidId: budget.medoidId,
            principalDirections: budget.principalDirections.length,
            dBar: decision.dBar.toFixed(4),
          });

          return {
            consolidatedMemoryId: consolidated.id,
            sourceMemoryIds,
            clusterSize: memories.length,
            summary,
            geometrySafe: true,
            dBar: decision.dBar,
            dEff: decision.dEff,
            gacStrategy: decision.strategy,
            gacDecision: decision,
          };
        }

        case 'prune': {
          // Diverse cluster: keep top distinct members, consolidate the rest
          const kept = pruneDiverseCluster(memories, 0.5);
          const pruned = memories.filter((m: any) => !kept.some((k: any) => k.id === m.id));

          // If nothing was actually pruned, skip
          if (pruned.length === 0) {
            logger.info('GAC prune: no memories pruned, skipping', {
              clusterSize: memories.length,
            });
            return {
              consolidatedMemoryId: '',
              sourceMemoryIds,
              clusterSize: memories.length,
              summary: `[Skipped] prune strategy but no memories to prune`,
              geometrySafe: false,
              dBar: decision.dBar,
              dEff: decision.dEff,
              gacStrategy: decision.strategy,
              gacDecision: decision,
            };
          }

          // Consolidate the pruned memories
          const prunedIds = pruned.map((m: any) => m.id);
          const keptIds = kept.map((m: any) => m.id);

          const summary = `[Consolidated-Pruned] Kept ${kept.length} distinct memories, consolidated ${pruned.length} similar ones`;

          const consolidated = await rememberMemory({
            content: summary,
            type: 'context',
            metadata: {
              consolidatedFrom: prunedIds,
              consolidatedAt: new Date().toISOString(),
              clusterSize: pruned.length,
              avgSimilarity: cluster.similarity,
              // GAC metadata
              gacStrategy: decision.strategy,
              gacDBar: decision.dBar,
              gacDEff: decision.dEff,
              gacRhoC: decision.rhoC,
              gacSpreadSafe: decision.spreadSafe,
              gacSpreadUnsafe: decision.spreadUnsafe,
              gacRepresentatives: decision.representatives,
              gacReason: decision.reason,
              // Prune-specific: which memories were kept
              keptMemoryIds: keptIds,
            },
            tags: ['consolidated', 'geometry-diverse', 'gac-prune'],
          });

          await markConsolidated(consolidated.id, prunedIds);

          logger.info('GAC prune consolidation', {
            consolidatedId: consolidated.id,
            prunedCount: pruned.length,
            keptCount: kept.length,
            dBar: decision.dBar.toFixed(4),
          });

          return {
            consolidatedMemoryId: consolidated.id,
            sourceMemoryIds: prunedIds,
            clusterSize: pruned.length,
            summary,
            geometrySafe: true,
            dBar: decision.dBar,
            dEff: decision.dEff,
            gacStrategy: decision.strategy,
            gacDecision: decision,
          };
        }
      }
    }
  }

  // Fall back to extractive or LLM summary (geometry disabled or no embeddings)
  const summary = await generateClusterSummary(memories);

  // Create consolidated memory
  const consolidated = await rememberMemory({
    content: summary,
    type: 'context',
    metadata: {
      consolidatedFrom: sourceMemoryIds,
      consolidatedAt: new Date().toISOString(),
      clusterSize: memories.length,
      avgSimilarity: cluster.similarity,
    },
    tags: ['consolidated'],
  });

  // Mark originals as consolidated
  await markConsolidated(consolidated.id, sourceMemoryIds);

  logger.info('Consolidated memory cluster', {
    consolidatedId: consolidated.id,
    sourceCount: memories.length,
    sourceIds: sourceMemoryIds,
  });

  return {
    consolidatedMemoryId: consolidated.id,
    sourceMemoryIds,
    clusterSize: memories.length,
    summary,
  };
}

/**
 * Mark memories as consolidated in the database.
 */
async function markConsolidated(
  consolidatedId: string,
  sourceMemoryIds: string[]
): Promise<void> {
  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  await db
    .update(schema.memories)
    .set({
      isConsolidated: 1,
      consolidatedInto: consolidatedId,
      consolidatedAt: new Date(),
    })
    .where(inArray(schema.memories.id, sourceMemoryIds));
}

/**
 * Generate extractive summary from a cluster of memories
 * Uses text processing without requiring an LLM
 * Exported for testing; used internally by generateClusterSummary().
 */
export function generateExtractiveSummary(memories: any[]): string {
  // Group by memory type
  const byType = new Map<string, any[]>();
  for (const m of memories) {
    const type = m.type ?? 'observation';
    if (!byType.has(type)) {
      byType.set(type, []);
    }
    byType.get(type)!.push(m);
  }

  const summaryParts: string[] = [];

  // Add header with count
  summaryParts.push(`Consolidated from ${memories.length} memories:`);

  // Summarize each type
  for (const [type, typeMemories] of byType.entries()) {
    if (typeMemories.length === 1) {
      summaryParts.push(`\n- ${type}: ${truncate(typeMemories[0].content, 100)}`);
    } else {
      summaryParts.push(`\n- ${type}s (${typeMemories.length}):`);
      // Extract key phrases from each memory
      for (const m of typeMemories.slice(0, 3)) {
        summaryParts.push(`  - ${truncate(m.content, 80)}`);
      }
      if (typeMemories.length > 3) {
        summaryParts.push(`  - ...and ${typeMemories.length - 3} more`);
      }
    }
  }

  return summaryParts.join('\n');
}

/**
 * Generate a cluster summary.
 * Uses LLM when available and enabled, falls back to extractive summary.
 * LLM is always optional - never blocks, never throws.
 * Exported for testing; use consolidateCluster() for production.
 */
export async function generateClusterSummary(memories: any[]): Promise<string> {
  const LIMIT = 20; // Limit memories to prevent prompt overflow

  // Try LLM if enabled and we have enough content
  if (config.llmEnabled && memories.length >= 2) {
    try {
      // Slice memories to avoid excessive prompt size
      const slice = memories.slice(0, LIMIT);
      const memTexts = slice
        .map((m, i) => `[${i + 1}] ${truncate(m.content, 500)}`)
        .join('\n\n');

      const prompt = `Summarize these related memories into a single coherent summary that captures the key information:

${memTexts}

Summary:`;

      const llmResult = await callLLM(prompt);
      if (llmResult && llmResult.length > 0) {
        logger.debug('Generated LLM cluster summary', {
          memoryCount: memories.length,
          summaryLength: llmResult.length,
        });
        return llmResult;
      }
    } catch {
      // LLM failed silently - fall through to extractive summary
      logger.debug('LLM cluster summary failed, falling back to extractive');
    }
  }

  // Fallback: extractive summary (always works)
  return generateExtractiveSummary(memories);
}

/**
 * Truncate text to maximum length
 * Exported for testing.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Reverse consolidation - restore original memories
 * This allows undoing consolidation if needed
 */
export async function reverseConsolidation(
  consolidatedMemoryId: string
): Promise<void> {
  await denyStrictConsolidationSurface('consolidation_reverse', 'Reversing memory consolidation is disabled under strict trust');

  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  // Get the consolidated memory
  const consolidated = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, consolidatedMemoryId))
    .limit(1);

  if (consolidated.length === 0) {
    throw new Error(`Consolidated memory not found: ${consolidatedMemoryId}`);
  }

  let metadata = consolidated[0].metadata as unknown;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { metadata = null; }
  }
  const sourceIds = typeof metadata === 'object' && metadata !== null && 'consolidatedFrom' in metadata
    ? (metadata as Record<string, unknown>).consolidatedFrom as string[] | undefined
    : undefined;

  if (!sourceIds || sourceIds.length === 0) {
    throw new Error('No source memories found in consolidated memory metadata');
  }

  const { deleteMemoryPermanently } = await import('./stale-cleaner.js');
  const restoreAndDelete = async () => {
    await db
      .update(schema.memories)
      .set({
        isConsolidated: 0,
        consolidatedInto: null,
        consolidatedAt: null,
      })
      .where(inArray(schema.memories.id, sourceIds));

    // Remove its canonical projection, temporal edges, and indexes through
    // the same lifecycle used by permanent forget before deleting the row.
    await deleteMemoryPermanently(consolidatedMemoryId);
  };

  if (db.$clientType === 'sqlite') {
    await withSqliteTransactionBoundary(db.$client as SqliteTransactionBoundary, restoreAndDelete);
  } else {
    await restoreAndDelete();
  }

  logger.info('Reversed consolidation', {
    consolidatedId: consolidatedMemoryId,
    restoredCount: sourceIds.length,
  });
}

/**
 * Get consolidation statistics for a project
 */
export async function getConsolidationStats(
  projectId: string
): Promise<{
  totalMemories: number;
  consolidatedMemories: number;
  consolidationsCreated: number;
  avgClusterSize: number;
}> {
  await denyStrictConsolidationSurface('consolidation_statistics', 'Unscoped consolidation statistics are disabled under strict trust');

  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  // Get all memories for project
  const memories = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId))
    .all();

  const totalMemories = memories.length;
  const consolidatedMemories = memories.filter((m: any) => m.isConsolidated).length;

  // Get consolidation summaries (memories created by consolidation)
  const consolidations = memories.filter((m: any) => {
    const metadata = m.metadata as any;
    return metadata?.consolidatedFrom && Array.isArray(metadata.consolidatedFrom);
  });

  const consolidationsCreated = consolidations.length;

  // Calculate average cluster size
  let totalClusterSize = 0;
  for (const m of consolidations) {
    const metadata = m.metadata as any;
    totalClusterSize += metadata?.clusterSize || 0;
  }
  const avgClusterSize = consolidationsCreated > 0
    ? totalClusterSize / consolidationsCreated
    : 0;

  return {
    totalMemories,
    consolidatedMemories,
    consolidationsCreated,
    avgClusterSize,
  };
}
