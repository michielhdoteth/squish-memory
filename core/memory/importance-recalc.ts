/**
 * Importance Score Recalculation
 *
 * Batch recalculates importance_score for all active memories using the
 * SAME 3-factor formula as computeInitialImportance() at write time.
 *
 * This ensures maintenance runs and write-time scoring are consistent —
 * no more overwriting 3-factor v2 scores with a stale 4-factor model.
 */

import { getDbClient } from '../lib/db-client.js';
import { logger } from '../logger.js';
import {
  calculateImportance,
  detectSurprise,
  detectEmotion,
  calculateImportanceV2,
  normalizeImportanceScore,
  denormalizeImportanceScore,
} from './importance.js';

interface RecalcResult {
  updated: number;
  total: number;
  errors: string[];
}

/**
 * Recalculate importance_score for all active memories.
 *
 * Uses the exact same formula as computeInitialImportance() in importance.ts:
 *   1. calculateImportance() → base score (50 + recency + access + type + flags)
 *   2. detectSurprise() → 0.5 (neutral for batch, since we can't compare all pairs)
 *   3. detectEmotion() → keyword-based urgency detection
 *   4. calculateImportanceV2() → base*0.5 + surprise*0.3 + emotion*0.2
 *
 * Only updates if the score differs by more than 1 point (avoids noisy writes).
 */
export async function recalculateImportanceScores(
  projectId?: string
): Promise<RecalcResult> {
  const result: RecalcResult = { updated: 0, total: 0, errors: [] };

  try {
    const { raw } = await getDbClient();
    const sqlite = (raw as any)?.$client;

    if (!sqlite) {
      logger.warn('No database client available for importance recalculation');
      return result;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    const query = projectId
      ? `SELECT id, type, content, created_at, access_count, usage_count,
                importance_score, is_pinned, is_protected, is_immutable
         FROM memories WHERE project_id = ? AND status = 'active'`
      : `SELECT id, type, content, created_at, access_count, usage_count,
                importance_score, is_pinned, is_protected, is_immutable
         FROM memories WHERE status = 'active'`;

    const memories = sqlite.prepare(query).all(projectId || null) as any[];
    result.total = memories.length;
    const updates: { id: string; score: number }[] = [];

    for (const mem of memories) {
      try {
        // Step 1: Calculate base importance (same as write path)
        const base = calculateImportance({
          type: mem.type,
          createdAt: mem.created_at ? new Date(mem.created_at * 1000).toISOString() : new Date().toISOString(),
          accessCount: mem.access_count ?? 0,
          usageCount: mem.usage_count ?? 0,
          isPinned: !!mem.is_pinned,
          isProtected: !!mem.is_protected,
          isImmutable: !!mem.is_immutable,
        });

        // Step 2: Surprise (neutral 0.5 for batch — can't compare all pairs)
        const surprise = 0.5;

        // Step 3: Emotion (keyword detection from content)
        const emotion = detectEmotion(mem.content ?? '');

        // Step 4: V2 formula (same as computeInitialImportance)
        const v2Score = denormalizeImportanceScore(
          calculateImportanceV2({
            baseImportance: normalizeImportanceScore(base.score),
            surprise,
            emotion,
          })
        );

        // Only update if score changed by more than 1 point
        if (Math.abs(v2Score - (mem.importance_score ?? 50)) > 1) {
          updates.push({ id: mem.id, score: v2Score });
        }
      } catch (err) {
        result.errors.push(`Memory ${mem.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Batch update via single CASE/WHEN statement
    if (updates.length > 0) {
      const cases = updates.map(() => `WHEN id = ? THEN ?`).join(' ');
      const params = [
        ...updates.flatMap(u => [u.id, u.score]),
        ...updates.map(u => u.id),
        nowSec, nowSec,
      ];
      sqlite.prepare(`
        UPDATE memories
        SET importance_score = CASE ${cases} END,
            last_importance_recalc = ?,
            updated_at = ?
        WHERE id IN (${updates.map(() => '?').join(',')})
      `).run(...params);
      result.updated = updates.length;
    }

    logger.info('Importance recalculation complete', {
      updated: result.updated,
      total: result.total,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Importance recalculation failed', { error: msg });
    result.errors.push(msg);
  }

  return result;
}
