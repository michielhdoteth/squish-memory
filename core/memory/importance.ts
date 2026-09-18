/**
 * Importance Scoring System (merged v1 + v2)
 *
 * Single-file importance engine.  Calculates and manages memory importance
 * scores (0-100) using a 3-factor model: base + surprise + emotion.
 *
 * v2 is now the only code-path — the v1/v2 dispatch has been eliminated.
 */

import type { Memory } from '../../db/drizzle/schema.js';
import { eq } from 'drizzle-orm';
import { cosineSimilarity as vectorCosineSimilarity } from '../utils/vector-operations.js';
import { getDbClient } from '../lib/db-client.js';

export interface ImportanceScore {
  score: number; // 0-100
  components: {
    base: number;
    recency: number;
    accessFrequency: number;
    typeWeight: number;
    userFlags: number;
  };
  explanation: string;
}

// ---------------------------------------------------------------------------
// v2 3-factor interfaces
// ---------------------------------------------------------------------------

export interface ImportanceFactors {
  baseImportance: number;    // 0-1 (current system normalized)
  surprise: number;           // 0-1 (unexpectedness)
  emotion: number;            // 0-1 (emotional salience)
}

export interface ImportanceWeights {
  base?: number;
  surprise?: number;
  emotion?: number;
}

// ---------------------------------------------------------------------------
// v2 3-factor functions
// ---------------------------------------------------------------------------

/**
 * 3-factor importance scoring
 * Final = 0.5*base + 0.3*surprise + 0.2*emotion
 * Weights configurable via config
 */
export function calculateImportanceV2(
  factors: ImportanceFactors,
  weights?: ImportanceWeights
): number {
  const w = {
    base: weights?.base ?? 0.5,
    surprise: weights?.surprise ?? 0.3,
    emotion: weights?.emotion ?? 0.2
  };

  const weightSum = w.base + w.surprise + w.emotion;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    console.warn(`Importance weights sum to ${weightSum}, not 1.0`);
  }

  const score = (factors.baseImportance * w.base) +
                (factors.surprise * w.surprise) +
                (factors.emotion * w.emotion);

  return Math.max(0, Math.min(1, score));
}

/**
 * Detect surprise factor — high surprise = content contradicts existing beliefs.
 * Uses keyword-based opposite detection as a lightweight heuristic.
 */
export function detectSurprise(
  newMemory: { content: string; type: string },
  existingMemories: { content: string; type: string }[]
): number {
  if (existingMemories.length === 0) {
    return 0.5; // Neutral surprise for first memory
  }

  const contradictions = existingMemories.filter(existing => {
    return hasOppositeKeywords(newMemory.content, existing.content);
  });

  // 3+ contradictions = max surprise (1.0)
  const surprise = Math.min(1.0, contradictions.length / 3);
  return surprise;
}

/**
 * Detect emotion factor — high emotion = urgent/high-stakes content.
 */
export function detectEmotion(content: string): number {
  const urgentKeywords = ['urgent', 'critical', 'asap', 'emergency', 'broken', 'error', 'fail'];
  const importantKeywords = ['important', 'key', 'crucial', 'decision', 'milestone', 'release'];

  const lower = content.toLowerCase();
  let score = 0;

  if (urgentKeywords.some(k => new RegExp(`\\b${k}\\b`).test(lower))) {
    score += 0.5;
  }

  if (importantKeywords.some(k => new RegExp(`\\b${k}\\b`).test(lower))) {
    score += 0.3;
  }

  return Math.min(1.0, score);
}

/**
 * Check if two strings contain opposite keywords.
 * Internal helper for surprise detection.
 */
function hasOppositeKeywords(content1: string, content2: string): boolean {
  const str1 = content1.toLowerCase();
  const str2 = content2.toLowerCase();

  const opposites = [
    ['yes', 'no'],
    ['true', 'false'],
    ['always', 'never'],
    ['increase', 'decrease'],
    ['up', 'down'],
    ['good', 'bad'],
    ['success', 'failure'],
    ['working', 'broken'],
  ];

  for (const [pos, neg] of opposites) {
    if ((str1.includes(pos) && str2.includes(neg)) ||
        (str1.includes(neg) && str2.includes(pos))) {
      return true;
    }
  }

  return false;
}

/**
 * Convert legacy importance score (0-100) to normalized (0-1)
 */
export function normalizeImportanceScore(score100: number): number {
  return Math.max(0, Math.min(1, score100 / 100));
}

/**
 * Convert normalized importance score (0-1) to legacy (0-100)
 */
export function denormalizeImportanceScore(score1: number): number {
  return Math.round(Math.max(0, Math.min(100, score1 * 100)));
}

/**
 * Compute initial importance for a new memory (sole write-path entry point;
 * absorbs the former core/engines dispatch wrapper).
 *
 * Runs the full 3-factor pipeline: base → normalize → surprise + emotion → v2 → denormalize.
 */
export function computeInitialImportance(memoryInput: {
  content: string;
  type: string;
  createdAt: string;
  accessCount: number;
  usageCount: number;
  isPinned: boolean;
  isProtected: boolean;
  isImmutable: boolean;
}): ImportanceScore {
  const base = calculateImportance(memoryInput);
  const surprise = detectSurprise({ content: memoryInput.content, type: memoryInput.type }, []);
  const emotion = detectEmotion(memoryInput.content);
  const v2Score = denormalizeImportanceScore(
    calculateImportanceV2({
      baseImportance: normalizeImportanceScore(base.score),
      surprise,
      emotion,
    })
  );
  return {
    ...base,
    score: v2Score,
    explanation: `3-factor: base=${normalizeImportanceScore(base.score).toFixed(3)}, emotion=${emotion.toFixed(3)}, surprise=${surprise.toFixed(3)}`,
  };
}

/**
 * Type weights for importance scoring
 * Higher values = more important memory types
 */
const TYPE_WEIGHTS: Record<string, number> = {
  decision: 15,
  fact: 10,
  preference: 8,
  context: 5,
  observation: 0,
};

/**
 * Calculate importance score for a memory
 *
 * Formula: base + recency + accessFrequency + typeWeight + userFlags
 * All values are clamped to 0-100 range
 */
export function calculateImportance(memory: Partial<Memory>): ImportanceScore {
  const components = {
    base: 50, // Neutral starting point
    recency: calculateRecencyComponent(memory),
    accessFrequency: calculateAccessFrequencyComponent(memory),
    typeWeight: calculateTypeWeightComponent(memory),
    userFlags: calculateUserFlagsComponent(memory),
  };

  // Calculate total score (clamped to 0-100)
  const score = Math.min(
    100,
    Math.max(
      0,
      components.base +
        components.recency +
        components.accessFrequency +
        components.typeWeight +
        components.userFlags
    )
  );

  return {
    score,
    components,
    explanation: generateImportanceExplanation(components, memory),
  };
}

/**
 * Calculate recency component (0-30 points)
 * Uses exponential decay based on memory age
 */
function calculateRecencyComponent(memory: Partial<Memory>): number {
  if (!memory.createdAt) return 0;

  const now = Date.now();
  const createdAt = new Date(memory.createdAt).getTime();
  const ageDays = (now - createdAt) / (1000 * 60 * 60 * 24);

  // Decay rate: default 30 days half-life
  const decayRate = memory.importanceDecayRate ?? 30;

  // Exponential decay: 30 * (0.5 ^ (age / halfLife))
  // Maximum 30 points for very recent memories
  const recencyScore = 30 * Math.pow(0.5, ageDays / decayRate);

  return Math.max(0, Math.min(30, recencyScore));
}

/**
 * Calculate access frequency component (0-15 points)
 * More frequently accessed memories are more important
 */
function calculateAccessFrequencyComponent(memory: Partial<Memory>): number {
  const accessCount = memory.accessCount ?? 0;
  const usageCount = memory.usageCount ?? 0;

  // Combined access count (from both fields)
  const totalAccess = accessCount + usageCount;

  // Logarithmic scaling: 15 * log10(totalAccess + 1)
  // This gives diminishing returns for high access counts
  const accessScore = 15 * Math.log10(totalAccess + 1);

  return Math.min(15, accessScore);
}

/**
 * Calculate type weight component (0-15 points)
 * Different memory types have different inherent importance
 */
function calculateTypeWeightComponent(memory: Partial<Memory>): number {
  const type = memory.type ?? 'observation';
  return TYPE_WEIGHTS[type] ?? 0;
}

/**
 * Calculate user flags component (0 or +20 points)
 * Pinned or protected memories get maximum importance
 */
function calculateUserFlagsComponent(memory: Partial<Memory>): number {
  // Pinned memories get maximum boost
  if (memory.isPinned) return 20;

  // Protected memories also get significant boost
  if (memory.isProtected) return 15;

  // Immutable memories are important but not as much
  if (memory.isImmutable) return 10;

  return 0;
}

/**
 * Generate human-readable explanation for importance score
 */
function generateImportanceExplanation(
  components: ImportanceScore['components'],
  memory: Partial<Memory>
): string {
  const parts: string[] = [];

  // Base score
  parts.push(`base: ${components.base}`);

  // Recency
  if (components.recency > 20) {
    parts.push('very recent');
  } else if (components.recency > 10) {
    parts.push('recent');
  } else if (components.recency > 0) {
    parts.push('somewhat recent');
  }

  // Access frequency
  const totalAccess = (memory.accessCount ?? 0) + (memory.usageCount ?? 0);
  if (totalAccess > 10) {
    parts.push('frequently accessed');
  } else if (totalAccess > 3) {
    parts.push('occasionally accessed');
  }

  // Type
  const type = memory.type ?? 'observation';
  if (type !== 'observation') {
    parts.push(`${type} type`);
  }

  // User flags
  if (memory.isPinned) {
    parts.push('pinned by user');
  } else if (memory.isProtected) {
    parts.push('protected');
  }

  return parts.join(', ');
}

/**
 * Update importance score for a memory
 * Used when memory is accessed or modified
 */
export async function updateImportanceScore(
    memoryId: string,
    incrementAccess: boolean = false
  ): Promise<number> {
    const { db, schema } = await getDbClient();

    // Get current memory
  const memories = await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.id, memoryId))
    .limit(1);

  if (memories.length === 0) {
    throw new Error(`Memory not found: ${memoryId}`);
  }

  const memory = memories[0];

  // Calculate new importance score using the merged 3-factor model
  const importance = calculateImportance(memory);
  const finalScore = denormalizeImportanceScore(
    calculateImportanceV2({
      baseImportance: normalizeImportanceScore(importance.score),
      surprise: detectSurprise({ content: memory.content ?? '', type: memory.type ?? 'observation' }, []),
      emotion: detectEmotion(memory.content ?? ''),
    })
  );

  // Update memory with new score
  const updateData: any = {
    importanceScore: finalScore,
    lastImportanceRecalc: new Date(),
  };

  // Increment access count if requested
  if (incrementAccess) {
    updateData.accessCount = (memory.accessCount ?? 0) + 1;
    updateData.lastAccessedAt = new Date();
  }

  await db
    .update(schema.memories)
    .set(updateData)
    .where(eq(schema.memories.id, memoryId));

  return importance.score;
}

/**
 * Get low-importance memories that are candidates for consolidation
 * These are old, rarely accessed memories with low importance scores
 */
export async function getLowImportanceMemories(
    projectId: string | undefined,
    options: {
      minAge?: number; // days
      maxImportance?: number; // 0-100
      limit?: number;
    } = {}
  ): Promise<any[]> {
    const { db, schema } = await getDbClient();

    const {
    minAge = 90, // 90 days old by default
    maxImportance = 30, // importance score below 30
    limit = 100,
  } = options;

  const minAgeTimestamp = new Date(Date.now() - minAge * 24 * 60 * 60 * 1000);

  const memories = projectId
    ? await db.select().from(schema.memories).where(eq(schema.memories.projectId, projectId)).all()
    : await db.select().from(schema.memories).all();

  // Filter by criteria
  return memories
    .filter((m: any) => {
      // Skip pinned/protected/consolidated
      if (m.isPinned || m.isProtected || m.isConsolidated) {
        return false;
      }

      // Check age
      if (m.createdAt) {
        const createdAt = new Date(m.createdAt).getTime();
        if (createdAt > minAgeTimestamp.getTime()) {
          return false;
        }
      }

      // Check importance
      if ((m.importanceScore ?? 50) > maxImportance) {
        return false;
      }

      return true;
    })
    .slice(0, limit);
}

/**
 * Set importance score manually (for user override)
 */
export async function setImportanceScore(
    memoryId: string,
    score: number
  ): Promise<void> {
    if (score < 0 || score > 100) {
      throw new Error('Importance score must be between 0 and 100');
    }

    const { db, schema } = await getDbClient();

    await db
    .update(schema.memories)
    .set({
      importanceScore: Math.round(score),
      lastImportanceRecalc: new Date(),
    })
    .where(eq(schema.memories.id, memoryId));
}

// cosineSimilarity has been removed - import from core/utils/vector-operations.ts directly
