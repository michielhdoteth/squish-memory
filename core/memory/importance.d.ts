/**
 * Importance Scoring System (merged v1 + v2)
 *
 * Single-file importance engine.  Calculates and manages memory importance
 * scores (0-100) using a 3-factor model: base + surprise + emotion.
 *
 * v2 is now the only code-path — the v1/v2 dispatch has been eliminated.
 */
import type { Memory } from '../../db/drizzle/schema.js';
export interface ImportanceScore {
    score: number;
    components: {
        base: number;
        recency: number;
        accessFrequency: number;
        typeWeight: number;
        userFlags: number;
    };
    explanation: string;
}
export interface ImportanceFactors {
    baseImportance: number;
    surprise: number;
    emotion: number;
}
export interface ImportanceWeights {
    base?: number;
    surprise?: number;
    emotion?: number;
}
/**
 * 3-factor importance scoring
 * Final = 0.5*base + 0.3*surprise + 0.2*emotion
 * Weights configurable via config
 */
export declare function calculateImportanceV2(factors: ImportanceFactors, weights?: ImportanceWeights): number;
/**
 * Detect surprise factor — high surprise = content contradicts existing beliefs.
 * Uses keyword-based opposite detection as a lightweight heuristic.
 */
export declare function detectSurprise(newMemory: {
    content: string;
    type: string;
}, existingMemories: {
    content: string;
    type: string;
}[]): number;
/**
 * Detect emotion factor — high emotion = urgent/high-stakes content.
 */
export declare function detectEmotion(content: string): number;
/**
 * Convert legacy importance score (0-100) to normalized (0-1)
 */
export declare function normalizeImportanceScore(score100: number): number;
/**
 * Convert normalized importance score (0-1) to legacy (0-100)
 */
export declare function denormalizeImportanceScore(score1: number): number;
/**
 * Compute initial importance for a new memory (sole write-path entry point;
 * absorbs the former core/engines dispatch wrapper).
 *
 * Runs the full 3-factor pipeline: base → normalize → surprise + emotion → v2 → denormalize.
 */
export declare function computeInitialImportance(memoryInput: {
    content: string;
    type: string;
    createdAt: string;
    accessCount: number;
    usageCount: number;
    isPinned: boolean;
    isProtected: boolean;
    isImmutable: boolean;
}): ImportanceScore;
/**
 * Calculate importance score for a memory
 *
 * Formula: base + recency + accessFrequency + typeWeight + userFlags
 * All values are clamped to 0-100 range
 */
export declare function calculateImportance(memory: Partial<Memory>): ImportanceScore;
/**
 * Update importance score for a memory
 * Used when memory is accessed or modified
 */
export declare function updateImportanceScore(memoryId: string, incrementAccess?: boolean): Promise<number>;
/**
 * Get low-importance memories that are candidates for consolidation
 * These are old, rarely accessed memories with low importance scores
 */
export declare function getLowImportanceMemories(projectId: string, options?: {
    minAge?: number;
    maxImportance?: number;
    limit?: number;
}): Promise<any[]>;
/**
 * Set importance score manually (for user override)
 */
export declare function setImportanceScore(memoryId: string, score: number): Promise<void>;
//# sourceMappingURL=importance.d.ts.map