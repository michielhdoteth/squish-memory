/**
 * Unified Knowledge Deduplicator
 * 
 * Detects and merges duplicate knowledge across all kinds.
 * Uses Jaccard similarity on content, then merges by superseding the weaker record.
 */

import { logger } from '../logger.js';
import {
  updateKnowledge,
  deleteKnowledge,
  getKnowledgeById,
  listKnowledgeByKind,
} from './store.js';
import type { KnowledgeKind, Knowledge } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Tokenize a string into a set of lowercase words.
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two sets of words.
 * Jaccard(A, B) = |intersection(A, B)| / |union(A, B)|
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set<string>();
  for (const item of setA) {
    if (setB.has(item)) intersection.add(item);
  }
  const union = new Set<string>(setA);
  for (const item of setB) {
    union.add(item);
  }
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Compute text similarity between two knowledge records.
 * Uses content + summary (if available) for better matching.
 */
function computeSimilarity(a: Knowledge, b: Knowledge): number {
  const textA = `${a.content} ${a.summary ?? ''} ${a.title ?? ''}`.trim();
  const textB = `${b.content} ${b.summary ?? ''} ${b.title ?? ''}`.trim();
  
  const wordsA = tokenize(textA);
  const wordsB = tokenize(textB);
  
  return jaccardSimilarity(wordsA, wordsB);
}

/**
 * Merge two knowledge records by superseding the weaker with the stronger.
 */
async function mergeKnowledge(
  keep: Knowledge,
  supersede: Knowledge,
): Promise<void> {
  // Merge tags (Knowledge.tags is a parsed string[] since the read-boundary fix)
  const allTags = new Set<string>();
  for (const tag of keep.tags ?? []) allTags.add(tag);
  for (const tag of supersede.tags ?? []) allTags.add(tag);

  // Merge metadata
  const mergedMetadata = { ...(keep.metadata ?? {}), ...(supersede.metadata ?? {}) };

  // Merge source counts
  const totalSources = keep.sourceCount + supersede.sourceCount;

  // Merge usage stats (for strategies)
  const totalUsage = keep.usageCount + supersede.usageCount;
  const totalSuccess = keep.successCount + supersede.successCount;
  const totalFailure = keep.failureCount + supersede.failureCount;

  // Update the kept record
  await updateKnowledge(keep.id, {
    tags: [...allTags],
    metadata: mergedMetadata,
    sourceCount: totalSources,
    usageCount: totalUsage,
    successCount: totalSuccess,
    failureCount: totalFailure,
    // Keep the higher confidence
    confidence: Math.max(keep.confidence, supersede.confidence),
    importanceScore: Math.max(keep.importanceScore, supersede.importanceScore),
  });

  // Mark the superseded record
  await updateKnowledge(supersede.id, {
    status: 'superseded',
    supersededBy: keep.id,
  });

  logger.debug('Knowledge merged', {
    keepId: keep.id,
    supersedeId: supersede.id,
    kind: keep.knowledgeKind,
    tagsAdded: [...allTags].length,
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Find similar knowledge records to a given input.
 * Returns records with similarity scores above the threshold.
 */
export async function findSimilarKnowledge(
  input: Knowledge,
  threshold: number = 0.3,
): Promise<Array<Knowledge & { similarity: number }>> {
  const existing = await listKnowledgeByKind(input.projectId ?? '', input.knowledgeKind, {
    status: 'active',
    limit: 200,
  });

  const results: Array<Knowledge & { similarity: number }> = [];

  for (const candidate of existing) {
    if (candidate.id === input.id) continue;
    
    const similarity = computeSimilarity(input, candidate);
    if (similarity > threshold) {
      results.push({ ...candidate, similarity });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

/**
 * Batch deduplicate knowledge within a project for a given kind.
 * Finds groups of similar records (similarity > threshold) and merges them,
 * keeping the one with the highest confidence.
 */
export async function deduplicateKnowledge(
  kind: KnowledgeKind,
  projectId?: string,
  threshold: number = 0.5,
): Promise<{ merged: number; kept: string[] }> {
  const knowledge = await listKnowledgeByKind(projectId ?? '', kind, {
    status: 'active',
    limit: 500,
  });

  // Memory knowledge rows are projections of authoritative `memories` rows.
  // This legacy merger only edits knowledge and cannot safely revise the
  // source row, its provenance, indexes, or lifecycle edges.
  if (kind === 'memory') {
    return { merged: 0, kept: knowledge.map((record) => record.id) };
  }

  // Provenance envelopes authenticate evidence and lineage in metadata. A
  // merge changes that metadata and cannot be re-signed without the source
  // owner and signing key, so only unsigned standalone records are eligible.
  const mergeable = knowledge.filter((record) => !Object.hasOwn(record.metadata ?? {}, '__squishProvenance'));

  const processed = new Set<string>();
  const kept: string[] = knowledge
    .filter((record) => Object.hasOwn(record.metadata ?? {}, '__squishProvenance'))
    .map((record) => record.id);
  let merged = 0;

  for (let i = 0; i < mergeable.length; i++) {
    const a = mergeable[i];
    if (processed.has(a.id)) continue;

    // Find all records similar to this one
    const similar: string[] = [];
    for (let j = i + 1; j < mergeable.length; j++) {
      const b = mergeable[j];
      if (processed.has(b.id)) continue;

      const similarity = computeSimilarity(a, b);
      if (similarity > threshold) {
        similar.push(b.id);
      }
    }

    if (similar.length > 0) {
      // Find the record with highest confidence among the group
      const group = [a, ...mergeable.filter((s) => similar.includes(s.id))];
      const best = group.reduce((prev, curr) =>
        (curr.confidence > prev.confidence) ? curr : prev,
      );

      // Merge all others into the best
      const toMerge = group.filter((s) => s.id !== best.id);
      for (const other of toMerge) {
        await mergeKnowledge(best, other);
        merged++;
      }

      kept.push(best.id);
      processed.add(a.id);
      for (const id of similar) processed.add(id);
    } else {
      kept.push(a.id);
      processed.add(a.id);
    }
  }

  if (merged > 0) {
    logger.info('Knowledge deduplication complete', {
      kind,
      projectId,
      merged,
      kept: kept.length,
    });
  }

  return { merged, kept };
}

/**
 * Run deduplication for all knowledge kinds in a project.
 * This is called during the sleep cycle / consolidation.
 */
export async function runDeduplicationCycle(projectId?: string): Promise<{
  memories: { merged: number; kept: string[] };
  beliefs: { merged: number; kept: string[] };
  strategies: { merged: number; kept: string[] };
}> {
  const [memories, beliefs, strategies] = await Promise.all([
    deduplicateKnowledge('memory', projectId),
    deduplicateKnowledge('belief', projectId),
    deduplicateKnowledge('strategy', projectId),
  ]);

  logger.info('Deduplication cycle complete', {
    memories: memories.merged,
    beliefs: beliefs.merged,
    strategies: strategies.merged,
  });

  return { memories, beliefs, strategies };
}
