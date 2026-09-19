/**
 * Memory Resurrection Module
 *
 * Separate from retrieval — retrieval must remain observational (search → rank → return).
 * This module is called AFTER answer generation when usefulness is confirmed.
 *
 * Prevents popularity loops via:
 * - Max reinforcement per event (capped delta)
 * - Cooldown between reinforcements (min 1 hour)
 * - Diminishing returns on successive reinforcements
 * - Contradiction blocks reinforcement
 * - Retrieval alone does NOT trigger reinforcement
 */

import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReinforcementEvent {
  memoryId: string;
  signal: 'successful_use' | 'confirmed' | 'contradicted';
  queryId?: string;
  /** Retrieval relevance score (0-1) */
  relevance: number;
  /** Answer model confidence (0-1) */
  answerConfidence: number;
}

export interface ReinforcementResult {
  memoryId: string;
  previousConfidence: number;
  newConfidence: number;
  previousStability: number;
  newStability: number;
  resurrected: boolean;
  blocked: boolean;
  reason?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum confidence increase per reinforcement event */
const MAX_CONFIDENCE_DELTA = 0.15;

/** Minimum hours between reinforcements for the same memory */
const COOLDOWN_HOURS = 1;

/** Diminishing returns factor: each successive reinforcement is this fraction of the previous */
const DIMINISHING_RETURNS = 0.85;

/** Maximum stability (caps immortal-loop risk) */
const MAX_STABILITY = 1.0;

/** Stability increase per successful use */
const STABILITY_DELTA = 0.05;

/** Confidence blocked by contradiction */
const CONTRADICTION_PENALTY = 0.3;

// ─── Main Function ──────────────────────────────────────────────────────────

export async function reinforceMemory(event: ReinforcementEvent): Promise<ReinforcementResult> {
  const { raw } = await getDbClient();
  const sqlite = (raw as any)?.$client;

  if (!sqlite) {
    logger.warn('No database available for reinforcement');
    return {
      memoryId: event.memoryId,
      previousConfidence: 0,
      newConfidence: 0,
      previousStability: 0,
      newStability: 0,
      resurrected: false,
      blocked: true,
      reason: 'no_database',
    };
  }

  // Read current memory state (importance_score is 0-100 integer; we work in 0.0-1.0)
  const mem = sqlite.prepare(
    'SELECT id, importance_score, stability, last_reinforced_at, usage_count FROM memories WHERE id = ?'
  ).get(event.memoryId) as any;

  if (!mem) {
    return {
      memoryId: event.memoryId,
      previousConfidence: 0,
      newConfidence: 0,
      previousStability: 0,
      newStability: 0,
      resurrected: false,
      blocked: true,
      reason: 'memory_not_found',
    };
  }

  const previousConfidence = (mem.importance_score ?? 50) / 100;
  const previousStability = mem.stability ?? 0.0;
  const lastReinforced = mem.last_reinforced_at ? new Date(mem.last_reinforced_at * 1000) : null;
  const useCount = mem.usage_count ?? 0;

  // --- Cooldown check ---
  if (lastReinforced) {
    const hoursSince = (Date.now() - lastReinforced.getTime()) / (1000 * 60 * 60);
    if (hoursSince < COOLDOWN_HOURS) {
      return {
        memoryId: event.memoryId,
        previousConfidence,
        newConfidence: previousConfidence,
        previousStability,
        newStability: previousStability,
        resurrected: false,
        blocked: true,
        reason: `cooldown (${COOLDOWN_HOURS - hoursSince}h remaining)`,
      };
    }
  }

  // --- Contradiction blocks reinforcement ---
  if (event.signal === 'contradicted') {
    const newConfidence = Math.max(0, previousConfidence - CONTRADICTION_PENALTY);
    const newScore = Math.round(newConfidence * 100);
    sqlite.prepare(
      'UPDATE memories SET importance_score = ?, last_reinforced_at = ?, usage_count = usage_count + 1, updated_at = ? WHERE id = ?'
    ).run(newScore, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), event.memoryId);

    return {
      memoryId: event.memoryId,
      previousConfidence,
      newConfidence,
      previousStability,
      newStability: previousStability,
      resurrected: false,
      blocked: false,
      reason: 'contradicted',
    };
  }

  // --- Diminishing returns ---
  const diminishingFactor = Math.pow(DIMINISHING_RETURNS, useCount);

  // --- Compute deltas ---
  const relevanceBonus = event.relevance * 0.1;
  const confidenceBonus = event.answerConfidence * 0.05;
  const rawDelta = (relevanceBonus + confidenceBonus) * diminishingFactor;
  const confidenceDelta = Math.min(rawDelta, MAX_CONFIDENCE_DELTA);

  const newConfidence = Math.min(1.0, previousConfidence + confidenceDelta);
  const newStability = Math.min(MAX_STABILITY, previousStability + STABILITY_DELTA);

  // --- Check for resurrection ---
  const wasDormant = previousStability < 0.2 && previousConfidence < 0.4;
  const isResurrected = wasDormant && newConfidence > 0.5;

  // --- Apply ---
  const nowSec = Math.floor(Date.now() / 1000);
  const newScore = Math.round(newConfidence * 100);
  sqlite.prepare(
    'UPDATE memories SET importance_score = ?, stability = ?, last_reinforced_at = ?, usage_count = usage_count + 1, updated_at = ? WHERE id = ?'
  ).run(newScore, newStability, nowSec, nowSec, event.memoryId);

  logger.debug('Memory reinforced', {
    memoryId: event.memoryId,
    signal: event.signal,
    confidenceDelta: confidenceDelta.toFixed(4),
    resurrected: isResurrected,
  });

  return {
    memoryId: event.memoryId,
    previousConfidence,
    newConfidence,
    previousStability,
    newStability,
    resurrected: isResurrected,
    blocked: false,
  };
}

/**
 * Batch reinforce multiple memories.
 */
export async function reinforceMemories(events: ReinforcementEvent[]): Promise<ReinforcementResult[]> {
  const results: ReinforcementResult[] = [];
  for (const event of events) {
    results.push(await reinforceMemory(event));
  }
  return results;
}
