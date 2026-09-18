/** Maintenance job handlers: temporal_cleanup, auto_clean, auto_maintenance, tier_maintenance, dedup_maintenance */

import type { JobHandler, JobExecutionContext } from '../types.js';
import { logger } from '../../logger.js';

// Batch 6b: expire memories whose valid_to has passed (bi-temporal lifecycle).
const temporalCleanupHandler: JobHandler = async (context: JobExecutionContext) => {
  const { cleanupExpiredTemporalFacts } = await import('../../memory/temporal-facts.js');
  const jobConfig = context.config as { projectId?: string; enabled?: boolean };
  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'temporal cleanup disabled' } };
  }
  const expiredCount = await cleanupExpiredTemporalFacts(jobConfig.projectId);
  return {
    recordsProcessed: expiredCount,
    summary: { expiredMemories: expiredCount },
  };
};

// Auto-clean handler - deletes stale memories automatically
const autoCleanHandler: JobHandler = async (context: JobExecutionContext) => {
  const { getStaleMemories, deleteMemoryPermanently } = await import('../../memory/stale-cleaner.js');
  const { getAllProjects } = await import('../../projects.js');
  
  const jobConfig = context.config as {
    enabled?: boolean;
    olderThanDays?: number;
    confidenceLevel?: string[];
    minImportance?: number;
    dryRun?: boolean;
  };
  
  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'auto-clean disabled' } };
  }
  
  const olderThanDays = jobConfig.olderThanDays || 30;
  const confidenceLevels = jobConfig.confidenceLevel || ['outdated', 'speculative'];
  const minImportance = jobConfig.minImportance || 40;
  const dryRun = jobConfig.dryRun !== undefined ? jobConfig.dryRun : false; // Default to actual delete for safety
  
  const projects = await getAllProjects();
  let totalStale = 0;
  let totalDeleted = 0;
  
  for (const project of projects) {
    const stale = await getStaleMemories({
      olderThanDays,
      confidenceLevels,
      minImportance,
      projectId: project.id,
    });
    
    totalStale += stale.length;
    
    if (dryRun) {
      logger.info(`[AutoClean] Would delete ${stale.length} stale memories in ${project.path}`);
    } else {
      for (const memory of stale) {
        if (!memory.isPinned) {
          await deleteMemoryPermanently(memory.id);
          totalDeleted++;
        }
      }
      logger.info(`[AutoClean] Deleted ${stale.length} stale memories in ${project.path}`);
    }
  }
  
  return {
    recordsProcessed: dryRun ? totalStale : totalDeleted,
    summary: {
      mode: dryRun ? 'dry-run' : 'deleted',
      projectsScanned: projects.length,
      memoriesAffected: dryRun ? totalStale : totalDeleted,
      criteria: { olderThanDays, confidenceLevels, minImportance },
    },
  };
};

// Phase 6: Auto-maintenance handler - runs runFullMaintenance for nightly dry-run
const autoMaintenanceHandler: JobHandler = async (context: JobExecutionContext) => {
  const { runFullMaintenance } = await import('../../consolidation.js');
  const jobConfig = context.config as {
    enabled?: boolean;
    dryRun?: boolean;
    steps?: string[];
    age?: number;
    llmEnabled?: boolean;
  };

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'auto-maintenance disabled' } };
  }

  const result = await runFullMaintenance({
    dryRun: jobConfig.dryRun !== undefined ? jobConfig.dryRun : true,
    steps: (jobConfig.steps as any) || ['dedup', 'stale'],
    age: jobConfig.age || 30,
    llmEnabled: jobConfig.llmEnabled,
  });

  const totalCount = Object.values(result.steps).reduce((sum, s) => sum + (s.count || 0), 0);

  return {
    recordsProcessed: totalCount,
    summary: {
      mode: result.dryRun ? 'dry-run' : 'completed',
      steps: Object.keys(result.steps),
      details: result.steps,
    },
  };
};

// Tier maintenance handler - recalculates memory tiers based on access patterns
const tierMaintenanceHandler: JobHandler = async (context: JobExecutionContext) => {
  const { recalculateTiers } = await import('../../memory/tiers.js');
  const result = await recalculateTiers();
  return {
    recordsProcessed: result.updated,
    summary: {
      updated: result.updated,
      tiers: result.tiers,
    },
  };
};

// Dedup maintenance handler - scans for duplicate memories and creates merge
// proposals for review. Executes auto-merges ONLY when SQUISH_DEDUP_AUTO=true,
// above the configured similarity threshold and capped per run. Every executed
// merge is recorded in memory_merge_history (undo log) so reverse works.
const dedupMaintenanceHandler: JobHandler = async (context: JobExecutionContext) => {
  const jobConfig = context.config as {
    enabled?: boolean;
    threshold?: number;
    cap?: number;
  };

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'dedup maintenance disabled' } };
  }

  const { getAllProjects } = await import('../../projects.js');
  const { handleDetectDuplicates } = await import('../../algorithms/handlers/detect-duplicates.js');

  const projects = await getAllProjects();
  let totalProposals = 0;
  let scanErrors = 0;

  for (const project of projects) {
    try {
      const result = await handleDetectDuplicates({ projectId: project.id });
      if (result.ok && result.data) {
        totalProposals += result.data.proposalsCreated;
      }
    } catch (err) {
      scanErrors++;
      logger.error(`[Dedup] Scan failed for project ${project.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Auto-merge phase - strictly gated, capped, high-confidence only
  const autoEnabled = process.env.SQUISH_DEDUP_AUTO === 'true';
  const threshold = jobConfig.threshold ?? 0.95;
  const cap = Math.max(1, jobConfig.cap ?? 25);
  let autoApproved = 0;
  let remaining = cap;

  if (autoEnabled && totalProposals >= 0 && remaining > 0) {
    try {
      const { getDbClient } = await import('../../lib/db-client.js');
      const { eq, desc } = await import('drizzle-orm');
      const { handleApproveMerge } = await import('../../algorithms/handlers/approve-merge.js');
      const { db, schema } = await getDbClient();

      const pending = await db
        .select()
        .from(schema.memoryMergeProposals)
        .where(eq(schema.memoryMergeProposals.status, 'pending'))
        .orderBy(desc(schema.memoryMergeProposals.similarityScore));

      for (const proposal of pending) {
        if (remaining <= 0) break;
        const score = parseFloat(String(proposal.similarityScore));
        if (!(score >= threshold)) continue;

        const result = await handleApproveMerge({
          proposalId: proposal.id,
          reviewNotes: `auto-merge (scheduler): similarity=${score.toFixed(3)} >= ${threshold}`,
        });
        if (result.ok) {
          autoApproved++;
          remaining--;
        }
      }
    } catch (err) {
      logger.error('[Dedup] Auto-merge phase failed:', err instanceof Error ? err.message : String(err));
    }
  }

  logger.info(`[Dedup] Maintenance complete: ${totalProposals} new proposals, ${autoApproved} auto-merged (gated=${!autoEnabled})`);

  return {
    recordsProcessed: totalProposals + autoApproved,
    summary: {
      projectsScanned: projects.length,
      proposalsCreated: totalProposals,
      scanErrors,
      autoEnabled,
      threshold,
      cap,
      autoMerged: autoApproved,
    },
  };
};

export function getMaintenanceHandlers(): Record<string, JobHandler> {
  return {
    temporal_cleanup: temporalCleanupHandler,
    auto_clean: autoCleanHandler,
    auto_maintenance: autoMaintenanceHandler,
    tier_maintenance: tierMaintenanceHandler,
    dedup_maintenance: dedupMaintenanceHandler,
  };
}
