/**
 * Decay Engine - Ebbinghaus Power-Law Implementation
 * 
 * Replaces linear decay with Ebbinghaus power-law decay for more accurate
 * memory retention modeling based on the forgetting curve.
 * 
 * Reference: Squish v2.0 Architecture Design, Section 7 - Decay Function
 */

import { ebbinghausRetention, ebbinghausScore, getDefaultDecayParams, DEFAULT_TAU_DAYS, type DecayParams } from './ebbinghaus.js';
import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

/**
 * Memory types and their decay characteristics
 * Based on research from Squish v2.0 architecture:
 * - episodic: β=0.07 (slow decay)
 * - semantic: β=0.02 (very slow)
 * - procedural: β=0.03 (slow)
 * - self-model: β=0.01 (very slow)
 * - introspective: β=0.02 (slow)
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'self-model' | 'introspective' | 'default';

export interface MemoryForDecay {
  id: string;
  score: number;
  memoryType?: string;
  lastDecayAt: Date | string | number;
  createdAt: Date | string | number;
  tau?: number;
  beta?: number;
  /** Memory tier: 'sturdy' = skip decay, 'working' = normal decay, 'long-term' = slow decay, 'fleeting' = faster decay */
  tier?: string;
  /** Whether the memory is pinned (exempt from decay) */
  isPinned?: boolean;
}

export interface DecayEngineStats {
  processed: number;
  updated: number;
  errors: string[];
}

/**
 * Tier decay multipliers (single source of truth for engine + retention mirror):
 * sturdy: 0 (no decay, skipped)
 * long-term: 0.5 (half normal decay via effective-time shrink)
 * working: 1.0 (normal decay)
 * fleeting: 2.0 (twice as fast via score division)
 */
const TIER_MULTIPLIERS: Record<string, number> = {
  'sturdy': 0.0,
  'long-term': 0.5,
  'working': 1.0,
  'fleeting': 2.0,
  // Legacy compatibility
  'hot': 0.0,
  'cold': 1.5,
};

/**
 * Pure, deterministic per-memory decay exactly as updateAllDecayScores applies
 * it: Ebbinghaus score from the last-decay anchor, then tier adjustment
 * (fleeting divides the score by its multiplier; long-term shrinks the
 * effective elapsed time; sturdy/hot are exempt). Exported so the ranking-side
 * retention mirror (core/decay/retention.ts) can be property-tested against
 * the engine's actual behavior.
 *
 * Note: unlike applyEbbinghausDecay (which reads the wall clock through
 * ebbinghausRetention), this function takes `nowMs` explicitly so it is
 * reproducible and injectable in tests. In production updateAllDecayScores
 * passes the same Date.now() snapshot it always used.
 */
export function applyTieredDecay(input: TieredDecayInput, nowMs: number): number {
  const baseScore = input.score || 100;

  // Sturdy tier: skip decay entirely (engine `continue`s -> unchanged score).
  if (input.tier === 'sturdy' || input.tier === 'hot') {
    return Math.max(0, Math.min(100, baseScore));
  }

  const defaults = getDefaultDecayParams(input.memoryType || 'default');
  const tau = input.decayRateDays != null && input.decayRateDays > 0
    ? input.decayRateDays
    : DEFAULT_TAU_DAYS;

  // Anchor: last_decay_at when present, else created_at (engine rule).
  const lastDecayMs = input.lastDecayAtSec != null && Number.isFinite(input.lastDecayAtSec)
    ? input.lastDecayAtSec * 1000
    : (input.createdAtSec ?? 0) * 1000;

  const ageDays = Math.max(0, (nowMs - lastDecayMs) / 86_400_000);

  const multiplier = TIER_MULTIPLIERS[input.tier ?? ''] ?? 1.0;
  // Long-term-style tiers slow decay by shrinking the effective elapsed time;
  // fleeting-style tiers accelerate it by dividing the resulting strength
  // (the engine divides the decayed SCORE by the multiplier - same ratio).
  const effectiveAgeDays = multiplier > 0 && multiplier < 1 ? ageDays * multiplier : ageDays;
  let retention = Math.pow(1 + effectiveAgeDays / tau, -defaults.beta);
  if (multiplier > 1) retention /= multiplier;

  return Math.max(0, Math.min(100, baseScore * retention));
}

/**
 * Input shape for the pure per-memory tiered decay computation.
 * Timestamps are raw epoch SECONDS (or null) to match the stored columns, so
 * callers can feed rows straight from SQL without conversion.
 */
export interface TieredDecayInput {
  score: number;
  memoryType?: string | null;
  tier?: string | null;
  lastDecayAtSec?: number | null;
  createdAtSec?: number | null;
  /** Days; NULL/negative/zero falls back to DEFAULT_TAU_DAYS. */
  decayRateDays?: number | null;
}

/**
 * Apply Ebbinghaus decay to a single memory
 *
 * @param memory - Memory object with required fields
 * @returns New decayed score
 */
export function applyEbbinghausDecay(memory: MemoryForDecay): number {
  // Get decay parameters
  const params: DecayParams = {
    tau: memory.tau ?? getDefaultDecayParams(memory.memoryType || 'default').tau,
    beta: memory.beta ?? getDefaultDecayParams(memory.memoryType || 'default').beta,
    lastDecayAt: new Date(memory.lastDecayAt),
    createdAt: new Date(memory.createdAt)
  };
  
  // Calculate decayed score
  const newScore = ebbinghausScore(memory.score, params);
  
  return newScore;
}

/**
 * Update decay scores for all memories in the database
 * Uses Ebbinghaus power-law decay instead of linear decay
 * 
 * @param projectId - Optional project ID to filter memories
 * @returns Statistics about the decay operation
 */
export async function updateAllDecayScores(projectId?: string): Promise<DecayEngineStats> {
  const stats: DecayEngineStats = {
    processed: 0,
    updated: 0,
    errors: []
  };

  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any)?.$client;

    if (!sqlite) {
      logger.warn('No database client available for decay engine');
      return stats;
    }

    const now = Date.now();
    // Tier multipliers live in TIER_MULTIPLIERS (shared with the retention
    // mirror via applyTieredDecay).

    // SQLite version
    const query = projectId
      ? `SELECT id, relevance_score, type, last_decay_at, created_at, decay_rate, is_pinned, tier
         FROM memories WHERE project_id = ? AND status = 'active' AND (is_pinned IS NULL OR is_pinned = 0)`
      : `SELECT id, relevance_score, type, last_decay_at, created_at, decay_rate, is_pinned, tier
         FROM memories WHERE status = 'active' AND (is_pinned IS NULL OR is_pinned = 0)`;

    const memories = sqlite.prepare(query).all(projectId || null) as any[];
    const updates: { id: string; score: number }[] = [];

    for (const mem of memories) {
      try {
        stats.processed++;

        // Belt-and-suspenders: skip pinned memories
        if (mem.is_pinned) {
          continue;
        }

        let newScore = applyTieredDecay(
          {
            score: mem.relevance_score,
            memoryType: mem.type,
            tier: mem.tier,
            lastDecayAtSec: mem.last_decay_at,
            createdAtSec: mem.created_at,
            decayRateDays: mem.decay_rate,
          },
          now
        );

        // Clamp to [0, 100]
        newScore = Math.max(0, Math.min(100, newScore));

        // Update if score changed significantly (baseline uses the same
        // ||100 fallback the decay math used pre-refactor).
        if (Math.abs(newScore - (mem.relevance_score || 100)) > 0.5) {
          updates.push({ id: mem.id, score: Math.round(newScore) });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push(`Memory ${mem.id}: ${msg}`);
      }
    }

    // Batch update via single CASE/WHEN statement
    if (updates.length > 0) {
      const nowSec = Math.floor(now / 1000);
      const cases = updates.map(u => `WHEN id = ? THEN ?`).join(' ');
      const ids = updates.map(u => u.id);
      const scores = updates.map(u => u.score);
      const params = [...ids.flatMap((id, i) => [id, scores[i]]), ...ids, nowSec, nowSec];

      sqlite.prepare(`
        UPDATE memories
        SET relevance_score = CASE ${cases} END,
            last_decay_at = ?,
            updated_at = ?
        WHERE id IN (${ids.map(() => '?').join(',')})
      `).run(...params);
      stats.updated = updates.length;
    }

    logger.info('Ebbinghaus decay applied', stats);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Decay engine failed', { error: msg });
    stats.errors.push(msg);
  }

  return stats;
}

/**
 * Calculate retention for a memory at a specific time
 * Useful for previewing what the retention will be
 * 
 * @param memory - Memory object
 * @param targetDate - Date to calculate retention for (default: now)
 * @returns Retention value between 0 and 1
 */
export function previewRetention(
  memory: MemoryForDecay,
  targetDate?: Date
): number {
  const target = targetDate || new Date();
  const params: DecayParams = {
    tau: memory.tau ?? getDefaultDecayParams(memory.memoryType || 'default').tau,
    beta: memory.beta ?? getDefaultDecayParams(memory.memoryType || 'default').beta,
    lastDecayAt: new Date(memory.lastDecayAt),
    createdAt: new Date(memory.createdAt)
  };
  
  // Calculate days between lastDecayAt and targetDate
  const lastDecayTime = new Date(memory.lastDecayAt).getTime();
  const targetTime = target.getTime();
  const msPerDay = 1000 * 60 * 60 * 24;
  const t = Math.max(0, (targetTime - lastDecayTime) / msPerDay); // t can't be negative
  
  // Calculate retention with the target t: R(t) = (1 + t/τ)^(-β)
  const retention = Math.pow(1 + t / params.tau, -params.beta);
  
  // Clamp to [0, 1] for safety
  return Math.max(0, Math.min(1, retention));
}

/**
 * Get decay parameters for a memory type
 * Exported for use by other modules
 */
export { getDefaultDecayParams };

export type { DecayParams };
