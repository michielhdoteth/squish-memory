// Memory maintenance orchestration.
//
// Batch 8: the parallel SimHash dedup engine that used to live here was
// deleted after the consolidation bake-off (docs/consolidation-bakeoff.md)
// measured 141 incorrect pairs vs 14 correct on a seeded corpus, and caught
// its auto-merge writing a nonexistent column (orphaned status flips). Dedup
// is owned by core/algorithms (two-stage detector + proposals + history) and
// surfaced via squish_dedup; this module only routes the 'dedup' step there.

/**
 * Options for unified full maintenance run (Phase 6)
 */
export interface FullMaintenanceOptions {
  projectId?: string;
  dryRun?: boolean;
  steps?: ('decay' | 'score' | 'tiers' | 'dedup' | 'stale' | 'superseded-cleanup' | 'consolidate' | 'llm-consolidate' | 'inbox' | 'prune-links')[];
  age?: number; // days threshold
  /** @deprecated No-op since Batch 8: the SimHash LLM second-pass was removed
   * in the consolidation bake-off. Kept for API compatibility; ignored. */
  llmEnabled?: boolean;
}

/**
 * Result of a unified full maintenance run
 */
export interface FullMaintenanceResult {
  ok: boolean;
  steps: Record<string, { ok: boolean; count: number; error?: string }>;
  dryRun: boolean;
}

import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Run all maintenance steps in sequence: dedup -> stale -> consolidate -> inbox.
 * Standard mode (no LLM) by default. LLM auto-detected from config.llmEnabled.
 *
 * Step routing:
 * - dedup        -> core/algorithms detect-duplicates (proposals only; merges
 *                   happen through squish_dedup approve/reject + history)
 * - stale        -> stale-cleaner (auto-clean or dry-run count)
 * - consolidate  -> GAC geometry-aware consolidation (core/memory/consolidation)
 * - inbox        -> places inbox triage
 *
 * This is the unified entry point for `squish clean`.
 */
export async function runFullMaintenance(
  options?: FullMaintenanceOptions
): Promise<FullMaintenanceResult> {
  const {
    projectId,
    dryRun = false,
    steps = ['decay', 'score', 'tiers', 'dedup', 'superseded-cleanup', 'stale', 'consolidate', 'llm-consolidate', 'inbox', 'prune-links'],
    age,
    llmEnabled,
  } = options ?? {};

  const stepResults: Record<string, { ok: boolean; count: number; error?: string }> = {};

  // Resolve effective LLM enabled state without mutating global config
  const effectiveLlmEnabled = llmEnabled !== undefined ? llmEnabled : config.llmEnabled;

  try {
    // --- Step 1: Decay (Ebbinghaus power-law) ---
    if (steps.includes('decay')) {
      try {
        const { updateAllDecayScores } = await import('./decay/decay-engine.js');
        const result = await updateAllDecayScores(projectId);
        stepResults.decay = {
          ok: result.errors.length === 0,
          count: result.updated,
          error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
        };
        logger.info(`[FullMaintenance] decay: ${result.updated}/${result.processed} scores updated`);
      } catch (error: any) {
        stepResults.decay = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] decay step failed:', error);
      }
    }

    // --- Step 2: Importance scoring (recalculate for all memories) ---
    if (steps.includes('score')) {
      try {
        const { recalculateImportanceScores } = await import('./memory/importance-recalc.js');
        const result = await recalculateImportanceScores(projectId);
        stepResults.score = {
          ok: true,
          count: result.updated,
        };
        logger.info(`[FullMaintenance] score: ${result.updated} importance scores recalculated`);
      } catch (error: any) {
        stepResults.score = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] score step failed:', error);
      }
    }

    // --- Step 3: Tier recalculation ---
    if (steps.includes('tiers')) {
      try {
        const { recalculateTiers } = await import('./memory/tiers.js');
        const result = await recalculateTiers(projectId);
        stepResults.tiers = {
          ok: true,
          count: result.updated,
        };
        logger.info(`[FullMaintenance] tiers: ${result.updated} tiers updated, distribution: ${JSON.stringify(result.tiers)}`);
      } catch (error: any) {
        stepResults.tiers = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] tiers step failed:', error);
      }
    }

    // --- Step 4: Dedup (canonical proposal workflow) ---
    if (steps.includes('dedup')) {
      try {
        const { handleDetectDuplicates } = await import('./algorithms/handlers/detect-duplicates.js');

        if (projectId) {
          const result = await handleDetectDuplicates({ projectId });
          stepResults.dedup = {
            ok: result.ok,
            count: result.ok && result.data ? result.data.proposalsCreated : 0,
            error: result.ok ? undefined : String((result as any).error ?? 'detection failed'),
          };
          logger.info(`[FullMaintenance] dedup: ${stepResults.dedup.count} merge proposals created`);
        } else {
          // Scan every project when none specified
          const { getAllProjects } = await import('./projects.js');
          const projects = await getAllProjects();
          let totalProposals = 0;
          for (const project of projects) {
            try {
              const result = await handleDetectDuplicates({ projectId: project.id });
              if (result.ok && result.data) totalProposals += result.data.proposalsCreated;
            } catch (err) {
              logger.error(
                `[FullMaintenance] dedup scan failed for ${project.id}:`,
                err instanceof Error ? err.message : String(err)
              );
            }
          }
          stepResults.dedup = { ok: true, count: totalProposals, error: undefined };
          logger.info(`[FullMaintenance] dedup: ${totalProposals} merge proposals created across ${projects.length} projects`);
        }
      } catch (error: any) {
        stepResults.dedup = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] dedup step failed:', error);
      }
    }

    // --- Step 5: Superseded cleanup ---
    if (steps.includes('superseded-cleanup')) {
      try {
        const { getDbClient } = await import('./lib/db-client.js');
        const client = await getDbClient();
        const sqlite = (client.raw as any)?.$client;
        if (sqlite) {
          const cutoffDays = age ?? 30;
          const cutoffSec = Math.floor(Date.now() / 1000) - cutoffDays * 86400;

          // Find superseded memories older than cutoff, not pinned/protected
          const superseded = sqlite.prepare(`
            SELECT id FROM memories
            WHERE status = 'superseded'
              AND superseded_at IS NOT NULL
              AND superseded_at < ?
              AND is_pinned = 0
              AND is_protected = 0
          `).all(cutoffSec) as any[];

          let deleted = 0;
          if (!dryRun && superseded.length > 0) {
            const ids = superseded.map((m: any) => m.id);
            // Delete associations first
            for (const id of ids) {
              sqlite.prepare('DELETE FROM memory_associations WHERE from_memory_id = ? OR to_memory_id = ?').run(id, id);
            }
            // Delete the memories
            const placeholders = ids.map(() => '?').join(',');
            sqlite.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
            deleted = ids.length;
          }

          stepResults['superseded-cleanup'] = { ok: true, count: dryRun ? superseded.length : deleted };
          logger.info(`[FullMaintenance] superseded-cleanup: ${dryRun ? `${superseded.length} would be deleted` : `${deleted} deleted`}`);
        }
      } catch (error: any) {
        stepResults['superseded-cleanup'] = { ok: false, count: 0, error: error.message || String(error) };
        logger.error('[FullMaintenance] superseded-cleanup step failed:', error);
      }
    }

    // --- Step 6: Stale cleanup ---
    if (steps.includes('stale')) {
      try {
        const { getStaleMemories, runAutoClean } = await import('./memory/stale-cleaner.js');

        if (dryRun) {
          // Dry-run: just count what would be cleaned
          const stale = await getStaleMemories({
            olderThanDays: age ?? 30,
            confidenceLevels: ['outdated', 'speculative'],
            minImportance: 40,
            projectId,
          });
          const unpinnedCount = stale.filter((m: any) => !m.isPinned).length;
          stepResults.stale = {
            ok: true,
            count: unpinnedCount,
            error: undefined,
          };
          logger.info(`[FullMaintenance] stale (dry-run): ${unpinnedCount} memories would be cleaned`);
        } else {
          const result = await runAutoClean({
            olderThanDays: age,
            confidenceLevels: ['outdated', 'speculative'],
            minImportance: 40,
            projectId,
          });
          stepResults.stale = {
            ok: true,
            count: result.deleted,
            error: undefined,
          };
          logger.info(`[FullMaintenance] stale: ${result.deleted} memories cleaned`);
        }
      } catch (error: any) {
        stepResults.stale = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] stale step failed:', error);
      }
    }

    // --- Step 7: Consolidation ---
    if (steps.includes('consolidate')) {
      try {
        const { consolidateMemories } = await import('./memory/consolidation.js');
        const consolidationResults = await consolidateMemories({
          projectId,
          minAge: age,
          maxImportance: 30,
          minClusterSize: 3,
          similarityThreshold: 0.7,
          limit: 100,
        });
        const totalSources = consolidationResults.reduce(
          (sum, r) => sum + (r.clusterSize || 0),
          0
        );
        stepResults.consolidate = {
          ok: true,
          count: totalSources,
          error: undefined,
        };
        logger.info(`[FullMaintenance] consolidate: ${consolidationResults.length} clusters, ${totalSources} sources`);
      } catch (error: any) {
        stepResults.consolidate = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] consolidate step failed:', error);
      }
    }

    // --- Step 8: LLM consolidation (cross-connection discovery) ---
    if (steps.includes('llm-consolidate')) {
      try {
        const { runLLMConsolidation } = await import('./consolidation/llm-consolidator.js');
        const llmResult = await runLLMConsolidation(projectId, { daysBack: 30, llmEnabled: effectiveLlmEnabled });
        stepResults['llm-consolidate'] = {
          ok: true,
          count: llmResult.insightsCreated,
          error: undefined,
        };
        logger.info(`[FullMaintenance] llm-consolidate: ${llmResult.insightsCreated} insights, ${llmResult.edgesCreated} edges, ${llmResult.memoriesProcessed} memories processed`);
      } catch (error: any) {
        stepResults['llm-consolidate'] = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] llm-consolidate step failed:', error);
      }
    }

    // --- Step 9: Inbox triage ---
    if (steps.includes('inbox')) {
      try {
        const { processInboxForAllProjects } = await import('./places/memory-places.js');
        const inboxResult = await processInboxForAllProjects();
        stepResults.inbox = {
          ok: true,
          count: inboxResult.totalMoved,
          error: undefined,
        };
        logger.info(`[FullMaintenance] inbox: ${inboxResult.totalMoved} moved, ${inboxResult.totalErrors} errors`);
      } catch (error: any) {
        stepResults.inbox = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] inbox step failed:', error);
      }
    }

    // --- Step 10: Prune weak associations ---
    if (steps.includes('prune-links')) {
      try {
        const { pruneWeakAssociations, pruneStaleAssociations } = await import('./associations.js');
        // First pass: remove weight-only weak links
        const prunedWeak = await pruneWeakAssociations(5);
        // Second pass: remove stale + weak dual-criteria links
        const prunedStale = await pruneStaleAssociations(2, 90);
        const totalPruned = prunedWeak + prunedStale;
        stepResults['prune-links'] = {
          ok: true,
          count: totalPruned,
        };
        logger.info(`[FullMaintenance] prune-links: ${prunedWeak} weak + ${prunedStale} stale = ${totalPruned} associations removed`);
      } catch (error: any) {
        stepResults['prune-links'] = {
          ok: false,
          count: 0,
          error: error.message || String(error),
        };
        logger.error('[FullMaintenance] prune-links step failed:', error);
      }
    }

    logger.info('[FullMaintenance] completed', { dryRun, steps: Object.keys(stepResults) });

    return {
      ok: true,
      steps: stepResults,
      dryRun,
    };
  } catch (error: any) {
    logger.error('[FullMaintenance] unexpected error:', error);
    return {
      ok: false,
      steps: stepResults,
      dryRun,
    };
  } finally {
    // No global config to restore — llmEnabled passed as parameter
  }
}
