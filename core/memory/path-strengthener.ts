/**
 * Path Strengthener
 * 
 * Strengthens association paths that led to successful retrievals and
 * weakens paths that led to irrelevant results. This implements the
 * "optimize" concept: the graph develops its own sense of relevance
 * over time based on actual usage patterns.
 * 
 * A customer support agent's graph naturally strengthens paths through
 * product docs and refund policies while letting rarely-queried HR
 * edges decay.
 */

import { logger } from '../logger.js';
import { adjustAssociationsBetweenMemories, createAssociation, pruneMemoryAssociations } from '../associations.js';

export interface PathStrengthResult {
  strengthened: number;
  weakened: number;
  pruned: number;
}

/**
 * Strengthen the association path between memories that were
 * retrieved together and found useful.
 */
export async function strengthenPath(
  memoryIds: string[],
  boostAmount: number = 2
): Promise<number> {
  if (memoryIds.length < 2) return 0;

  let strengthened = 0;

  // Generate all pairs
  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      try {
        const updated = await adjustAssociationsBetweenMemories(memoryIds[i], memoryIds[j], boostAmount, 1, true);
        if (updated === 0) await createAssociation(memoryIds[i], memoryIds[j], 'co_occurred', boostAmount);
        strengthened += updated || 1;
      } catch (error) {
        logger.debug('Error strengthening path', {
          from: memoryIds[i],
          to: memoryIds[j],
          error: error as Error,
        });
      }
    }
  }

  return strengthened;
}

/**
 * Weaken association paths that led to irrelevant results.
 */
export async function weakenPath(
  memoryIds: string[],
  decayAmount: number = 0.5
): Promise<number> {
  if (memoryIds.length < 2) return 0;

  let weakened = 0;

  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      try {
        weakened += await adjustAssociationsBetweenMemories(memoryIds[i], memoryIds[j], -decayAmount, 1);
      } catch (error) {
        logger.debug('Error weakening path', {
          from: memoryIds[i],
          to: memoryIds[j],
          error: error as Error,
        });
      }
    }
  }

  return weakened;
}

/**
 * Prune associations that have decayed below a threshold.
 */
export async function pruneWeakAssociations(
  minWeight: number = 2,
  maxAge: number = 90 // days
): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAge);

  try {
    const pruned = await pruneMemoryAssociations((association) =>
      association.weight < minWeight && (association.lastCoactivatedAt ?? association.createdAt) < cutoffDate
    );
    logger.info('Pruned weak associations', { pruned, minWeight, maxAge });
    return pruned;
  } catch (error) {
    logger.error('Error pruning weak associations', { error: error as Error });
    return 0;
  }
}

/**
 * Run a full optimize cycle: strengthen useful paths, weaken unused ones,
 * prune dead associations, and derive implicit facts.
 */
export async function runPruneCycle(
  options?: {
    minWeight?: number;
    maxAge?: number;
  }
): Promise<PathStrengthResult> {
  const { minWeight = 2, maxAge = 90 } = options || {};

  logger.info('Starting prune cycle', { minWeight, maxAge });

  // Step 1: Prune weak associations
  const pruned = await pruneWeakAssociations(minWeight, maxAge);

  logger.info('Prune cycle completed', { pruned });

  return {
    strengthened: 0, // Strengthening happens via retrieval feedback
    weakened: 0,     // Weakening happens via retrieval feedback
    pruned,
  };
}

