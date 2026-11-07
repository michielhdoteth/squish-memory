/**
 * Three-stage duplicate detection orchestrator.
 * Stage 0: Exact match (content hash-based)
 * Stage 1: Hash-based prefiltering (SimHash + MinHash)
 * Stage 2: Semantic ranking using embeddings
 */

import type { Memory, MemoryType } from '../../../db/drizzle/schema.js';
import { getEmbedding, getBatchEmbeddings, embeddingModelFor } from '../../../core/embeddings.js';
import { SimHashFilter, MinHashFilter, findCandidatePairs } from './hash-filters.js';
import { rankCandidates, analyzePair } from './semantic-ranker.js';
import { eq, and } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDbClient } from '../../../core/lib/db-client.js';
import { deserializeTags, deserializeMetadata } from '../../memory/serialization.js';

export interface MemoryPair {
  memory1: Memory;
  memory2: Memory;
  similarityScore: number;
  detectionMethod: 'exact' | 'simhash' | 'minhash' | 'embedding';
  confidenceLevel: 'high' | 'medium' | 'low';
  mergeReason: string;
}

export interface DetectionResult {
  candidates: MemoryPair[];
  stage0Time: number; // Duration in ms for exact matching
  stage1Time: number; // Duration in ms
  stage2Time: number;
  totalCandidates: number; // Number of candidate pairs found
  filteredCandidates: number; // Final ranked candidates
  statistics: {
    totalMemories: number;
    memoriesByType: Record<MemoryType, number>;
  };
}

export interface DetectionOptions {
  projectId?: string;
  type?: MemoryType;
  threshold?: number; // Semantic similarity (0-1, default 0.85)
  limit?: number; // Max proposals (default 50)
  simhashThreshold?: number; // (default 4)
  minhashThreshold?: number; // (default 0.7)
  stage1Only?: boolean; // Skip stage 2 for testing
  stage0Only?: boolean; // Skip stages 1-2 for testing (exact match only)
}

export async function detectDuplicates(options: DetectionOptions): Promise<DetectionResult> {
  const startTime = Date.now();
  const { db, schema } = await getDbClient();

  let query: any = db.select().from(schema.memories);

  if (options.projectId) {
    query = query.where(eq(schema.memories.projectId, options.projectId));
  }

  if (options.type) {
    query = query.where(eq(schema.memories.type, options.type));
  }

  query = query.where(
    and(
      eq(schema.memories.isMerged, false),
      eq(schema.memories.isMergeable, true),
      eq(schema.memories.isActive, true)
    )
  );

  const rawRows: Memory[] = await query.execute();
  // Boundary normalization: tags/metadata are TEXT columns typed as
  // string[]/Record on the schema. Parse them here so every downstream
  // consumer of these candidate rows - token estimation, pair analysis, and
  // especially mergeMemories (whose mergeTags would otherwise iterate a JSON
  // string character-by-character and persist a corrupted tag array) - sees
  // the shapes its type promises.
  const memories: Memory[] = rawRows.map((row) => ({
    ...row,
    tags: deserializeTags(row.tags),
    metadata: deserializeMetadata(row.metadata),
  }));

  if (memories.length < 2) {
    return {
      candidates: [],
      stage0Time: 0,
      stage1Time: 0,
      stage2Time: 0,
      totalCandidates: 0,
      filteredCandidates: 0,
      statistics: {
        totalMemories: memories.length,
        memoriesByType: countByType(memories),
      },
    };
  }

  const memoriesById = new Map(memories.map((m) => [m.id, m]));
  const contentById = new Map(memories.map((m) => [m.id, m.content]));

  // Stage 0: Exact match using content hash
  const stage0Start = Date.now();
  const stage0Candidates: { memoryId1: string; memoryId2: string }[] = [];
  
  // Group memories by content hash for exact matching
  const contentHashGroups = new Map<string, string[]>();
  for (const memory of memories) {
    const contentHash = crypto.createHash('md5').update(memory.content).digest('hex');
    if (!contentHashGroups.has(contentHash)) {
      contentHashGroups.set(contentHash, []);
    }
    contentHashGroups.get(contentHash)!.push(memory.id);
  }
  
  // Create pairs from each group with same content
  for (const [hash, ids] of contentHashGroups.entries()) {
    if (ids.length >= 2) {
      // Create all unique pairs within this group
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          stage0Candidates.push({ memoryId1: ids[i], memoryId2: ids[j] });
        }
      }
    }
  }
  
  const stage0Time = Date.now() - stage0Start;
  
  // If we only want exact matches for testing, return early
  if (options.stage0Only) {
    const exactMatchCandidates: MemoryPair[] = stage0Candidates.map(pair => ({
      memory1: memoriesById.get(pair.memoryId1)!,
      memory2: memoriesById.get(pair.memoryId2)!,
      similarityScore: 1.0, // Exact match = 1.0 similarity
      detectionMethod: 'exact',
      confidenceLevel: 'high',
      mergeReason: 'Exact content match',
    }));
    
    return {
      candidates: exactMatchCandidates.slice(0, options.limit ?? 50),
      stage0Time,
      stage1Time: 0,
      stage2Time: 0,
      totalCandidates: stage0Candidates.length,
      filteredCandidates: exactMatchCandidates.length,
      statistics: {
        totalMemories: memories.length,
        memoriesByType: countByType(memories),
      },
    };
  }

  const simhashFilter = new SimHashFilter();
  const minhashFilter = new MinHashFilter();

  const allSimhashes = new Map<string, string>();
  const allMinhashes = new Map<string, number[]>();

  for (const memory of memories) {
    allSimhashes.set(memory.id, simhashFilter.generateHash(memory.content));
    allMinhashes.set(memory.id, minhashFilter.generateSignature(memory.content));
  }

  const stage1Start = Date.now();
  const stage1Candidates = findCandidatePairs(contentById, allSimhashes, allMinhashes, {
    simhashThreshold: options.simhashThreshold ?? 4,
    minhashThreshold: options.minhashThreshold ?? 0.7,
  });

  const stage1Time = Date.now() - stage1Start;

  // Combine stage 0 and stage 1 candidates for stage 2 processing
  // We'll prioritize exact matches but also include fuzzy matches for better recall
  const combinedCandidatesForStage2 = [
    ...stage0Candidates, // Exact matches first
    ...stage1Candidates  // Then fuzzy matches
  ];

  // Remove duplicates while preserving order (exact matches first)
  const seenPairs = new Set<string>();
  const uniqueCombinedCandidates = [];
  for (const pair of combinedCandidatesForStage2) {
    const pairKey = `${pair.memoryId1}:${pair.memoryId2}`;
    const reversePairKey = `${pair.memoryId2}:${pair.memoryId1}`;
    if (!seenPairs.has(pairKey) && !seenPairs.has(reversePairKey)) {
      seenPairs.add(pairKey);
      uniqueCombinedCandidates.push(pair);
    }
  }

  if (options.stage1Only) {
    // Process only stage 1 candidates (fuzzy matches) for backward compatibility
    const stage1OnlyCandidates: MemoryPair[] = stage1Candidates.map((pair) => ({
      memory1: memoriesById.get(pair.memoryId1)!,
      memory2: memoriesById.get(pair.memoryId2)!,
      similarityScore: Math.max(
        1 - pair.simhashDistance / 64,
        pair.minhashSimilarity
      ),
      detectionMethod: pair.matched === 'both' ? 'simhash' : pair.matched,
      confidenceLevel: 'low',
      mergeReason: 'Stage 1 candidate (embedding analysis skipped)',
    }));
    
    return {
      candidates: stage1OnlyCandidates.slice(0, options.limit ?? 50),
      stage0Time,
      stage1Time,
      stage2Time: 0,
      totalCandidates: stage1Candidates.length,
      filteredCandidates: stage1OnlyCandidates.length,
      statistics: {
        totalMemories: memories.length,
        memoriesByType: countByType(memories),
      },
    };
  }

  const stage2Start = Date.now();

  const embeddings = new Map<string, number[]>();

  // Separate memories that already have embeddings from those that need generation
  const memoriesWithoutEmbedding = memories.filter((m) => !m.embedding);
  const memoriesWithEmbedding = memories.filter((m) => m.embedding);

  // Add cached embeddings to map
  for (const memory of memoriesWithEmbedding) {
    embeddings.set(memory.id, memory.embedding as unknown as number[]);
  }

  // Generate embeddings for remaining memories in parallel batches
  if (memoriesWithoutEmbedding.length > 0) {
    const contents = memoriesWithoutEmbedding.map((m) => m.content);
    const generatedEmbeddings = await getBatchEmbeddings(contents, 20);

    for (let i = 0; i < memoriesWithoutEmbedding.length; i++) {
      const embedding = generatedEmbeddings[i];
      if (embedding) {
        embeddings.set(memoriesWithoutEmbedding[i].id, embedding);
        const model = embeddingModelFor(embedding);
        if (model) memoriesWithoutEmbedding[i].embeddingModel = model;
      }
    }
  }

  const rankedCandidates = await rankCandidates(
    uniqueCombinedCandidates.map((pair) => ({
      memoryId1: pair.memoryId1,
      memoryId2: pair.memoryId2,
    })),
    memoriesById,
    embeddings,
    {
      semanticThreshold: options.threshold ?? 0.85,
      topK: 10,
    }
  );

  const stage2Time = Date.now() - stage2Start;

  // Build final candidates list with proper scoring and methods
  const finalCandidates: MemoryPair[] = [];
  
  // Add exact matches first (highest confidence)
  for (const pair of stage0Candidates) {
    const memory1 = memoriesById.get(pair.memoryId1);
    const memory2 = memoriesById.get(pair.memoryId2);
    if (memory1 && memory2) {
      finalCandidates.push({
        memory1,
        memory2,
        similarityScore: 1.0, // Exact match
        detectionMethod: 'exact',
        confidenceLevel: 'high',
        mergeReason: 'Exact content match',
      });
    }
  }
  
  // Add semantic matches from stage 2
  for (const ranked of rankedCandidates) {
    finalCandidates.push({
      memory1: ranked.memory1,
      memory2: ranked.memory2,
      similarityScore: ranked.cosineSimilarity,
      detectionMethod: 'embedding',
      confidenceLevel: ranked.confidenceLevel,
      mergeReason: ranked.mergeReason,
    });
  }
  
  // Add fuzzy matches (stage 1) that weren't already covered
  const processedPairs = new Set<string>();
  for (const candidate of finalCandidates) {
    const pairKey1 = `${candidate.memory1.id}:${candidate.memory2.id}`;
    const pairKey2 = `${candidate.memory2.id}:${candidate.memory1.id}`;
    processedPairs.add(pairKey1);
    processedPairs.add(pairKey2);
  }
  
  for (const pair of stage1Candidates) {
    const pairKey = `${pair.memoryId1}:${pair.memoryId2}`;
    const reversePairKey = `${pair.memoryId2}:${pair.memoryId1}`;
    if (!processedPairs.has(pairKey) && !processedPairs.has(reversePairKey)) {
      const memory1 = memoriesById.get(pair.memoryId1);
      const memory2 = memoriesById.get(pair.memoryId2);
      if (memory1 && memory2) {
        finalCandidates.push({
          memory1,
          memory2,
          similarityScore: Math.max(
            1 - pair.simhashDistance / 64,
            pair.minhashSimilarity
          ),
          detectionMethod: pair.matched === 'both' ? 'simhash' : pair.matched,
          confidenceLevel: 'low',
          mergeReason: 'Stage 1 candidate (embedding analysis skipped)',
        });
      }
    }
  }

  const limited = finalCandidates.slice(0, options.limit ?? 50);

  return {
    candidates: limited,
    stage0Time,
    stage1Time,
    stage2Time,
    totalCandidates: stage0Candidates.length + stage1Candidates.length,
    filteredCandidates: finalCandidates.length,
    statistics: {
      totalMemories: memories.length,
      memoriesByType: countByType(memories),
    },
  };
}

export async function analyzeMergePair(
    memoryId1: string,
    memoryId2: string
  ): Promise<{
    memory1: Memory;
    memory2: Memory;
    analysis: ReturnType<typeof analyzePair>;
  } | null> {
    const { db, schema } = await getDbClient();

    const [memory1] = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, memoryId1));

  const [memory2] = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, memoryId2));

  if (!memory1 || !memory2) {
    return null;
  }

  const embedding1 = memory1.embedding || (await getEmbedding(memory1.content)) || [];
  const embedding2 = memory2.embedding || (await getEmbedding(memory2.content)) || [];

  if (!embedding1 || !embedding2 || embedding1.length === 0 || embedding2.length === 0) {
    return null;
  }

  const model1 = embeddingModelFor(embedding1 as number[]) ?? memory1.embeddingModel ?? null;
  const model2 = embeddingModelFor(embedding2 as number[]) ?? memory2.embeddingModel ?? null;
  if (model1 && model2 && model1 !== model2) return null;

  const analysis = analyzePair(
    memory1,
    memory2,
    embedding1 as unknown as number[],
    embedding2 as unknown as number[]
  );

  return {
    memory1,
    memory2,
    analysis,
  };
}

function countByType(memories: Memory[]): Record<MemoryType, number> {
  const counts: Record<MemoryType, number> = {
    observation: 0,
    fact: 0,
    decision: 0,
    context: 0,
    preference: 0,
    reflection: 0,
    note: 0,
  };

  for (const memory of memories) {
    const type = memory.type as MemoryType;
    if (type in counts) {
      counts[type]++;
    }
  }

  return counts;
}

export async function getDetectionStats(projectId: string): Promise<{
  totalMemories: number;
  mergeableMemories: number;
  mergedMemories: number;
  canonicalMemories: number;
  memoriesByType: Record<MemoryType, number>;
}> {
  const { db, schema } = await getDbClient();

  const memories: Memory[] = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId));

  const totalMemories = memories.length;
  const mergedMemories = memories.filter((m) => m.isMerged).length;
  const canonicalMemories = memories.filter((m) => m.isCanonical).length;
  const mergeableMemories = memories.filter((m) => m.isMergeable && !m.isMerged).length;

  return {
    totalMemories,
    mergeableMemories,
    mergedMemories,
    canonicalMemories,
    memoriesByType: countByType(memories),
  };
}
