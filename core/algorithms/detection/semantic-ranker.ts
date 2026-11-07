/**
 * Semantic ranking using embeddings (Stage 2 of two-stage detection).
 * Ranks candidates from Stage 1 by semantic similarity using cosine distance.
 */

import type { Memory } from '../../../db/drizzle/schema.js';
import { cosineSimilarity, DimensionMismatchError } from '../../../core/utils/vector-operations.js';
import { embeddingModelFor } from '../../../core/embeddings.js';

export class EmbeddingSpaceMismatchError extends Error {
  constructor(model1: string, model2: string) {
    super(`Cannot compare embeddings from different vector spaces: ${model1} vs ${model2}`);
    this.name = 'EmbeddingSpaceMismatchError';
  }
}

function modelIdentity(memory: Memory, embedding: number[]): string | null {
  return embeddingModelFor(embedding)
    ?? (typeof memory.embeddingModel === 'string' && memory.embeddingModel.length > 0 ? memory.embeddingModel : null);
}

export interface RankedCandidate {
  memoryId1: string;
  memoryId2: string;
  memory1: Memory;
  memory2: Memory;
  cosineSimilarity: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  mergeReason: string;
}

function calculateConfidence(
  memory1: Memory,
  memory2: Memory,
  cosineSim: number
): 'high' | 'medium' | 'low' {
  if (cosineSim >= 0.90) {
    const factors = calculateConfidenceFactors(memory1, memory2);
    if (factors.sameType && factors.tagOverlap > 0.5) {
      return 'high';
    }
    if (factors.sameType || factors.tagOverlap > 0.3) {
      return 'high';
    }
    return 'medium';
  }

  if (cosineSim >= 0.80) {
    const factors = calculateConfidenceFactors(memory1, memory2);
    if (factors.sameType && factors.contentLengthSimilarity > 0.7) {
      return 'medium';
    }
    return 'medium';
  }

  return 'low';
}

interface ConfidenceFactors {
  sameType: boolean;
  tagOverlap: number;
  contentLengthSimilarity: number;
}

function calculateConfidenceFactors(memory1: Memory, memory2: Memory): ConfidenceFactors {
  const sameType = memory1.type === memory2.type;

  const tags1 = new Set(memory1.tags || []);
  const tags2 = new Set(memory2.tags || []);
  const overlap = Array.from(tags1).filter((tag) => tags2.has(tag)).length;
  const union = new Set([...tags1, ...tags2]).size;
  const tagOverlap = union === 0 ? 0 : overlap / union;

  const len1 = memory1.content.length;
  const len2 = memory2.content.length;
  const maxLen = Math.max(len1, len2);
  const minLen = Math.min(len1, len2);
  const contentLengthSimilarity = maxLen === 0 ? 1 : minLen / maxLen;

  return {
    sameType,
    tagOverlap,
    contentLengthSimilarity,
  };
}

function generateMergeReason(
  memory1: Memory,
  memory2: Memory,
  cosineSim: number,
  confidenceLevel: 'high' | 'medium' | 'low'
): string {
  const factors = calculateConfidenceFactors(memory1, memory2);
  const parts: string[] = [];

  parts.push(`Semantic similarity: ${(cosineSim * 100).toFixed(1)}%`);

  if (factors.sameType) {
    parts.push(`Same type (${memory1.type})`);
  } else {
    parts.push(`Different types (${memory1.type} vs ${memory2.type})`);
  }

  if (factors.tagOverlap > 0) {
    parts.push(`${(factors.tagOverlap * 100).toFixed(0)}% tag overlap`);
  }

  const len1 = memory1.content.length;
  const len2 = memory2.content.length;
  const diffPercent = Math.abs(len1 - len2) / Math.max(len1, len2);
  parts.push(`Content length difference: ${(diffPercent * 100).toFixed(0)}%`);

  parts.push(`Confidence: ${confidenceLevel}`);

  return parts.join(' • ');
}

export async function rankCandidates(
  candidates: Array<{ memoryId1: string; memoryId2: string }>,
  memories: Map<string, Memory>,
  embeddings: Map<string, number[]>,
  options: {
    semanticThreshold?: number;
    topK?: number;
  }
): Promise<RankedCandidate[]> {
  const semanticThreshold = options.semanticThreshold ?? 0.85;
  const topK = options.topK ?? 10;

  const rankedCandidates: RankedCandidate[] = [];

  for (const { memoryId1, memoryId2 } of candidates) {
    const memory1 = memories.get(memoryId1);
    const memory2 = memories.get(memoryId2);
    const embedding1 = embeddings.get(memoryId1);
    const embedding2 = embeddings.get(memoryId2);

    if (!memory1 || !memory2 || !embedding1 || !embedding2) {
      continue;
    }

    // Batch 4 mismatch policy: skip mixed-model pairs explicitly (they can
    // never be genuine duplicates across embedding spaces).
    if (embedding1.length !== embedding2.length) continue;
    const model1 = modelIdentity(memory1, embedding1);
    const model2 = modelIdentity(memory2, embedding2);
    if (model1 && model2 && model1 !== model2) continue;

    const similarity = cosineSimilarity(embedding1, embedding2);

    if (similarity < semanticThreshold) {
      continue;
    }

    const confidence = calculateConfidence(memory1, memory2, similarity);
    const mergeReason = generateMergeReason(memory1, memory2, similarity, confidence);

    rankedCandidates.push({
      memoryId1,
      memoryId2,
      memory1,
      memory2,
      cosineSimilarity: similarity,
      confidenceLevel: confidence,
      mergeReason,
    });
  }

  rankedCandidates.sort((a, b) => b.cosineSimilarity - a.cosineSimilarity);

  const selectedByMemory = new Map<string, number>();
  const filtered: RankedCandidate[] = [];

  for (const candidate of rankedCandidates) {
    const count1 = (selectedByMemory.get(candidate.memoryId1) || 0) + 1;
    const count2 = (selectedByMemory.get(candidate.memoryId2) || 0) + 1;

    if (count1 <= topK && count2 <= topK) {
      filtered.push(candidate);
      selectedByMemory.set(candidate.memoryId1, count1);
      selectedByMemory.set(candidate.memoryId2, count2);
    }
  }

  return filtered;
}

export function analyzePair(
  memory1: Memory,
  memory2: Memory,
  embedding1: number[],
  embedding2: number[]
): {
  cosineSimilarity: number;
  confidenceLevel: 'high' | 'medium' | 'low';
  mergeReason: string;
  factors: {
    sameType: boolean;
    tagOverlap: number;
    contentLengthSimilarity: number;
  };
} {
  // Batch 4 mismatch policy: mixed-model pairs are not duplicates.
  if (embedding1.length !== embedding2.length) {
    throw new DimensionMismatchError(embedding1.length, embedding2.length);
  }
  const model1 = modelIdentity(memory1, embedding1);
  const model2 = modelIdentity(memory2, embedding2);
  if (model1 && model2 && model1 !== model2) throw new EmbeddingSpaceMismatchError(model1, model2);
  const similarity = cosineSimilarity(embedding1, embedding2);
  const confidence = calculateConfidence(memory1, memory2, similarity);
  const mergeReason = generateMergeReason(memory1, memory2, similarity, confidence);
  const factors = calculateConfidenceFactors(memory1, memory2);

  return {
    cosineSimilarity: similarity,
    confidenceLevel: confidence,
    mergeReason,
    factors,
  };
}
