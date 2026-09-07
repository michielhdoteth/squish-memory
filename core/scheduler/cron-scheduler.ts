/** Cron Scheduler - Persistent cron-based job scheduling with fallback support */

import cron from 'node-cron';
import { selfIterationHandler } from '../session/self-iteration-job.js';
import { updateAllDecayScores } from '../decay/decay-engine.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { getDb } from '../../db/index.js';
import { maintenanceJobs, maintenanceJobHistory } from '../../db/drizzle/schema-sqlite.js';
import { eq } from 'drizzle-orm';

export type JobType = 'nightly' | 'weekly' | 'hourly' | 'daily';
export type JobStatus = 'success' | 'failed' | 'skipped';

export interface ScheduledJob {
  id: string;
  jobName: string;
  jobType: JobType;
  cronExpression: string;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  jobConfig: Record<string, unknown>;
}

export interface JobExecutionContext {
  jobId: string;
  jobName: string;
  jobType: JobType;
  config: Record<string, unknown>;
  startedAt: Date;
}

export type JobHandler = (context: JobExecutionContext) => Promise<{ recordsProcessed: number; summary: Record<string, unknown> }>;

const jobHandlers = new Map<string, JobHandler>();
const activeTasks = new Map<string, any>(); // node-cron ScheduledTask type

// Job interval by type (in ms) - used for catch-up detection
const JOB_INTERVALS: Record<JobType, number> = {
  hourly: 60 * 60 * 1000,           // 1 hour
  daily: 24 * 60 * 60 * 1000,      // 24 hours
  nightly: 24 * 60 * 60 * 1000,    // 24 hours (same as daily)
  weekly: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export function registerJobHandler(jobName: string, handler: JobHandler): void {
  jobHandlers.set(jobName, handler);
  logger.info(`[Scheduler] Registered handler for job: ${jobName}`);
}

// Register self-iteration job handler
registerJobHandler('self_iteration', selfIterationHandler);

// Decay job handler - uses Ebbinghaus power-law decay engine
// Replaces sector-based decay with Ebbinghaus forgetting curve
const decayHandler = async (context: JobExecutionContext) => {
  const stats = await updateAllDecayScores();
  return {
    recordsProcessed: stats.updated,
    summary: {
      processed: stats.processed,
      updated: stats.updated,
      errors: stats.errors,
    },
  };
};
registerJobHandler('decay_maintenance', decayHandler);

// Knowledge belief decay handler - applies confidence decay to beliefs via unified knowledge table
const beliefDecayHandler = async (context: JobExecutionContext) => {
  const { runDecayCycle } = await import('../knowledge/decay.js');
  const stats = await runDecayCycle();
  return {
    recordsProcessed: stats.beliefs.decayed + stats.beliefs.deprecated,
    summary: {
      beliefDecayed: stats.beliefs.decayed,
      beliefDeprecated: stats.beliefs.deprecated,
      errors: [],
    },
  };
};
registerJobHandler('belief_decay', beliefDecayHandler);

// Batch 6b: expire memories whose valid_to has passed (bi-temporal lifecycle).
const temporalCleanupHandler = async (context: JobExecutionContext) => {
  const { cleanupExpiredTemporalFacts } = await import('../memory/temporal-facts.js');
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
registerJobHandler('temporal_cleanup', temporalCleanupHandler);

// Expire pending edit proposals left unreviewed past their TTL so staged
// diffs don't linger forever against drifting content.
const proposalExpiryHandler = async (context: JobExecutionContext) => {
  const { expireStaleEditProposals } = await import('../memory/edit-workflow.js');
  const jobConfig = context.config as { days?: number; enabled?: boolean };
  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'proposal expiry disabled' } };
  }
  const expired = await expireStaleEditProposals(jobConfig.days ?? 14);
  return {
    recordsProcessed: expired,
    summary: { expiredProposals: expired, ttlDays: jobConfig.days ?? 14 },
  };
};
registerJobHandler('proposal_expiry', proposalExpiryHandler);

// Auto-clean handler - deletes stale memories automatically
const autoCleanHandler = async (context: JobExecutionContext) => {
  const { getStaleMemories, deleteMemoryPermanently } = await import('../memory/stale-cleaner.js');
  const { getAllProjects } = await import('../projects.js');
  
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
registerJobHandler('auto_clean', autoCleanHandler);

// Inbox triage handler - processes inbox memories and moves them to appropriate places
const inboxTriageHandler = async (context: JobExecutionContext) => {
  const { processInboxForAllProjects } = await import('../places/memory-places.js');
  const result = await processInboxForAllProjects();
  return {
    recordsProcessed: result.totalMoved,
    summary: {
      processed: result.totalProcessed,
      moved: result.totalMoved,
      errors: result.totalErrors,
    },
  };
};
registerJobHandler('inbox_triage', inboxTriageHandler);

// Phase 6: Auto-maintenance handler - runs runFullMaintenance for nightly dry-run
const autoMaintenanceHandler = async (context: JobExecutionContext) => {
  const { runFullMaintenance } = await import('../consolidation.js');
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
registerJobHandler('auto_maintenance', autoMaintenanceHandler);

// Phase 6: Weekly consolidation handler - runs consolidate + inbox
const weeklyConsolidationHandler = async (context: JobExecutionContext) => {
  const { runFullMaintenance } = await import('../consolidation.js');
  const jobConfig = context.config as {
    enabled?: boolean;
    dryRun?: boolean;
    age?: number;
  };

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'weekly consolidation disabled' } };
  }

  const result = await runFullMaintenance({
    dryRun: jobConfig.dryRun !== undefined ? jobConfig.dryRun : false,
    steps: ['consolidate', 'inbox'],
    age: jobConfig.age || 60,
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
registerJobHandler('weekly_consolidation', weeklyConsolidationHandler);

// Phase 6: Deep maintenance handler - runs full maintenance with LLM
const deepMaintenanceHandler = async (context: JobExecutionContext) => {
  const { config: squishConfig } = await import('../../config.js');
  const jobConfig = context.config as {
    enabled?: boolean;
    dryRun?: boolean;
    age?: number;
  };

  // Monthly deep maintenance only runs if LLM is enabled
  if (!squishConfig.llmEnabled) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'LLM not enabled, skipping deep maintenance' } };
  }

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'deep maintenance disabled' } };
  }

  const { runFullMaintenance } = await import('../consolidation.js');
  const result = await runFullMaintenance({
    dryRun: jobConfig.dryRun !== undefined ? jobConfig.dryRun : false,
    steps: ['consolidate', 'inbox'],
    age: jobConfig.age || 90,
    llmEnabled: true,
  });

  const totalCount = Object.values(result.steps).reduce((sum, s) => sum + (s.count || 0), 0);

  return {
    recordsProcessed: totalCount,
    summary: {
      mode: 'deep-maintenance',
      llmEnabled: true,
      steps: Object.keys(result.steps),
      details: result.steps,
    },
  };
};
registerJobHandler('deep_maintenance', deepMaintenanceHandler);

// Tier maintenance handler - recalculates memory tiers based on access patterns
const tierMaintenanceHandler = async (context: JobExecutionContext) => {
  const { recalculateTiers } = await import('../memory/tiers.js');
  const result = await recalculateTiers();
  return {
    recordsProcessed: result.updated,
    summary: {
      updated: result.updated,
      tiers: result.tiers,
    },
  };
};
registerJobHandler('tier_maintenance', tierMaintenanceHandler);

// Dedup maintenance handler - scans for duplicate memories and creates merge
// proposals for review. Executes auto-merges ONLY when SQUISH_DEDUP_AUTO=true,
// above the configured similarity threshold and capped per run. Every executed
// merge is recorded in memory_merge_history (undo log) so reverse works.
const dedupMaintenanceHandler = async (context: JobExecutionContext) => {
  const jobConfig = context.config as {
    enabled?: boolean;
    threshold?: number;
    cap?: number;
  };

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'dedup maintenance disabled' } };
  }

  const { getAllProjects } = await import('../projects.js');
  const { handleDetectDuplicates } = await import('../algorithms/handlers/detect-duplicates.js');

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
      const { getDbClient } = await import('../lib/db-client.js');
      const { eq, desc } = await import('drizzle-orm');
      const { handleApproveMerge } = await import('../algorithms/handlers/approve-merge.js');
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
registerJobHandler('dedup_maintenance', dedupMaintenanceHandler);

// LLM Consolidation handler - finds creative cross-connections using LLM
const llmConsolidationHandler = async (context: JobExecutionContext) => {
  const { runLLMConsolidation } = await import('../consolidation/llm-consolidator.js');
  const jobConfig = context.config as {
    enabled?: boolean;
    maxMemories?: number;
    batchSize?: number;
    projectId?: string;
  };

  if (jobConfig.enabled === false) {
    return { recordsProcessed: 0, summary: { skipped: true, reason: 'llm-consolidation disabled' } };
  }

  const result = await runLLMConsolidation(jobConfig.projectId, {
    maxMemories: jobConfig.maxMemories || 50,
    batchSize: jobConfig.batchSize || 20,
  });

  return {
    recordsProcessed: result.memoriesProcessed,
    summary: {
      insightsCreated: result.insightsCreated,
      edgesCreated: result.edgesCreated,
      memoriesProcessed: result.memoriesProcessed,
      errors: result.errors,
    },
  };
};
registerJobHandler('llm_consolidation', llmConsolidationHandler);

export async function initializeScheduler(): Promise<void> {
  if (!config.cronEnabled) {
    logger.info('[Scheduler] Cron scheduling disabled, using heartbeat fallback');
    return;
  }

  const db = await getDb();
  if (!db) {
    logger.warn('[Scheduler] Database not available, scheduler disabled');
    return;
  }

  try {
    await ensureDefaultJobs(db);

    // Check for missed jobs (catch-up after machine wake from sleep)
    await checkMissedJobs();

    const sqliteDb = db as any;
    const jobs = await sqliteDb
      .select()
      .from(maintenanceJobs)
      .where(eq(maintenanceJobs.enabled, true));

    for (const job of jobs) {
      await scheduleJob(job as unknown as ScheduledJob);
    }

    logger.info(`[Scheduler] Initialized with ${jobs.length} scheduled jobs`);
  } catch (error) {
    logger.error('[Scheduler] Failed to initialize:', error);
  }
}

/**
 * Check for missed jobs and execute catch-up if needed
 * Called on scheduler initialization (including after machine wake from sleep)
 */
async function checkMissedJobs(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    
    const sqliteDb = db as any;
    const jobs = await sqliteDb
      .select()
      .from(maintenanceJobs)
      .where(eq(maintenanceJobs.enabled, true));
    
    const now = Date.now();
    
    for (const job of jobs) {
      const intervalMs = JOB_INTERVALS[job.jobType as JobType];
      if (!intervalMs) continue;
      
      const lastRun = job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0;
      const elapsed = lastRun > 0 ? now - lastRun : intervalMs * 2; // If never run, treat as overdue
      const gracePeriod = intervalMs * 1.5; // 1.5x interval grace
      
      if (elapsed > gracePeriod) {
        logger.info(`[Scheduler] Catch-up needed for ${job.jobName}, elapsed ${Math.round(elapsed / (60 * 60 * 1000))}h (grace: ${Math.round(gracePeriod / (60 * 60 * 1000))}h)`);
        
        // Execute catch-up
        const handler = jobHandlers.get(job.jobName);
        if (handler) {
          try {
            const startedAt = new Date();
            const context: JobExecutionContext = {
              jobId: job.id,
              jobName: job.jobName,
              jobType: job.jobType as JobType,
              config: typeof job.jobConfig === 'string' 
                ? JSON.parse(job.jobConfig) 
                : (job.jobConfig as Record<string, unknown>) ?? {},
              startedAt,
            };
            
            await handler(context);
            
            // Record successful catch-up run
            const completedAt = new Date();
            await sqliteDb
              .update(maintenanceJobs)
              .set({
                lastRunAt: completedAt,
                lastRunStatus: 'success' as const,
                lastRunDuration: completedAt.getTime() - startedAt.getTime(),
              })
              .where(eq(maintenanceJobs.id, job.id));
            
            logger.info(`[Scheduler] Catch-up completed for ${job.jobName}`);
          } catch (catchError) {
            const msg = catchError instanceof Error ? catchError.message : String(catchError);
            logger.error(`[Scheduler] Catch-up failed for ${job.jobName}:`, msg);
            
            await sqliteDb
              .update(maintenanceJobs)
              .set({
                lastRunAt: new Date(),
                lastRunStatus: 'failed' as const,
                lastRunError: msg,
              })
              .where(eq(maintenanceJobs.id, job.id));
          }
        }
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[Scheduler] Error checking missed jobs:', msg);
  }
}

async function ensureDefaultJobs(db: any): Promise<void> {
  const defaultJobs = [
    {
      jobName: 'decay_maintenance',
      jobType: 'hourly' as JobType,
      cronExpression: '0 * * * *', // Run every hour at :00
      enabled: true,
      jobConfig: { applyDecay: true, updateTiers: true, evictOld: true },
    },
    {
      jobName: 'belief_decay',
      jobType: 'daily' as JobType,
      cronExpression: '0 4 * * *', // Run daily at 4 AM
      enabled: true,
      jobConfig: { applyBeliefDecay: true },
    },
    // Batch 6b: bi-temporal lifecycle - expire memories past valid_to
    {
      jobName: 'temporal_cleanup',
      jobType: 'daily' as JobType,
      cronExpression: '15 4 * * *', // Run daily at 4:15 AM (after belief decay)
      enabled: true,
      jobConfig: {},
    },
    {
      jobName: 'self_iteration',
      jobType: 'hourly' as JobType,
      cronExpression: '30 * * * *', // Run every hour at :30
      enabled: true,
      jobConfig: { minMessageCount: 5, maxMessagesToProcess: 50 },
    },
    {
      jobName: 'tier_maintenance',
      jobType: 'daily' as JobType,
      cronExpression: '0 2 * * *', // Run daily at 2 AM
      enabled: true,
      jobConfig: { recalculateTiers: true },
    },
    {
      jobName: 'auto_clean',
      jobType: 'daily' as JobType,
      cronExpression: '0 3 * * *', // Run daily at 3 AM
      enabled: true,
      jobConfig: { 
        enabled: true,
        olderThanDays: 30,
        confidenceLevel: ['outdated', 'speculative'],
        minImportance: 40,
        dryRun: true, // Start with dry-run for safety
      },
    },
    // LLM Consolidation - creative cross-connection finding
    {
      jobName: 'llm_consolidation',
      jobType: 'daily' as JobType,
      cronExpression: '30 3 * * *', // Run daily at 3:30 AM (LLM cross-connection pass; no-op without an LLM provider)
      enabled: true,
      jobConfig: {
        enabled: true,
        maxMemories: 50,
        batchSize: 20,
      },
    },
    {
      jobName: 'inbox_triage',
      jobType: 'daily' as JobType,
      cronExpression: '0 */6 * * *', // Run every 6 hours
      enabled: true,
      jobConfig: {
        enabled: true,
      },
    },
    // Phase 6: Nightly auto-maintenance (dry-run for safety)
    {
      jobName: 'auto_maintenance',
      jobType: 'nightly' as JobType,
      cronExpression: '0 3 * * *', // Nightly at 3 AM
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: true,
        steps: ['dedup', 'stale'],
        age: 30,
      },
    },
    {
      jobName: 'dedup_maintenance',
      jobType: 'nightly' as JobType,
      cronExpression: '45 3 * * *', // Nightly at 3:45 AM (after auto_maintenance)
      enabled: true,
      jobConfig: {
        enabled: true,
        threshold: 0.95,
        cap: 25,
      },
    },
    // Expire edit proposals pending longer than their TTL
    {
      jobName: 'proposal_expiry',
      jobType: 'daily' as JobType,
      cronExpression: '45 4 * * *', // Daily at 4:45 AM (after temporal_cleanup)
      enabled: true,
      jobConfig: {
        enabled: true,
        days: 14,
      },
    },
    // Phase 6: Weekly consolidation
    {
      jobName: 'weekly_consolidation',
      jobType: 'weekly' as JobType,
      cronExpression: '0 4 * * 0', // Weekly at 4 AM Sunday
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: false,
        steps: ['consolidate', 'inbox'],
        age: 60,
      },
    },
    // Phase 6: Monthly deep maintenance (LLM only)
    {
      jobName: 'deep_maintenance',
      jobType: 'weekly' as JobType,
      cronExpression: '0 5 1 * *', // Monthly on 1st at 5 AM
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: false,
        age: 90,
      },
    },
  ];

  for (const job of defaultJobs) {
    let existing;
    try {
      existing = await db
        .select()
        .from(maintenanceJobs)
        .where(eq((maintenanceJobs as any).jobName, job.jobName))
        .limit(1);
    } catch (queryError: any) {
      logger.error(`[Scheduler] Query failed for job ${job.jobName}:`, queryError.message);
      // Try raw SQL fallback
      try {
        const rawDb = (db as any).$client;
        if (rawDb && typeof rawDb.prepare === 'function') {
          existing = rawDb.prepare('SELECT * FROM maintenance_jobs WHERE job_name = ?').all(job.jobName);
        }
      } catch (fallbackError: any) {
        logger.error(`[Scheduler] Fallback query also failed:`, fallbackError.message);
        throw queryError;
      }
    }

    if (existing.length === 0) {
      try {
        await db.insert(maintenanceJobs).values({
          jobName: job.jobName,
          jobType: job.jobType,
          cronExpression: job.cronExpression,
          enabled: job.enabled,
          jobConfig: job.jobConfig,
          totalRuns: 0,
          successCount: 0,
          failureCount: 0,
          lastRunAt: null,
          nextRunAt: null,
          lastRunDuration: null,
          lastRunStatus: null,
          lastRunError: null,
        });
      } catch (insertError: any) {
        // Fallback to raw SQL if drizzle insert fails
        logger.warn(`[Scheduler] Drizzle insert failed, using raw SQL: ${insertError.message}`);
        const rawDb = (db as any).$client;
        if (rawDb && typeof rawDb.prepare === 'function') {
          const stmt = rawDb.prepare(`
            INSERT INTO maintenance_jobs 
            (id, job_name, job_type, cron_expression, enabled, job_config, 
             total_runs, success_count, failure_count, last_run_at, next_run_at, 
             last_run_duration, last_run_status, last_run_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          stmt.run(
            crypto.randomUUID(),
            job.jobName,
            job.jobType,
            job.cronExpression,
            job.enabled ? 1 : 0,
            JSON.stringify(job.jobConfig),
            0, 0, 0,
            null, null, null, null, null
          );
        }
      }
      logger.info(`[Scheduler] Created default job: ${job.jobName}`);

      // Register self-iteration handler
      if (job.jobName === 'self_iteration') {
        registerJobHandler('self_iteration', selfIterationHandler);
      }
    }
  }
}

export async function scheduleJob(job: ScheduledJob): Promise<void> {
  const existingTask = activeTasks.get(job.jobName);
  if (existingTask) {
    existingTask.stop();
    activeTasks.delete(job.jobName);
  }

  if (!job.enabled || !job.cronExpression) {
    logger.debug(`[Scheduler] Job ${job.jobName} is disabled or has no cron expression`);
    return;
  }

  if (!cron.validate(job.cronExpression)) {
    logger.error(`[Scheduler] Invalid cron expression for ${job.jobName}: ${job.cronExpression}`);
    return;
  }

  const task = cron.schedule(job.cronExpression, async () => {
    await executeJob(job);
  }, {
    timezone: 'UTC',
  });

  activeTasks.set(job.jobName, task);

  const nextRun = getNextRunTime(job.cronExpression);
  const db = await getDb();
  if (db) {
    const sqliteDb = db as any;
    await sqliteDb
      .update(maintenanceJobs)
      .set({ nextRunAt: nextRun })
      .where(eq(maintenanceJobs.id, job.id));
  }

  const nextRunStr = nextRun instanceof Date && !isNaN(nextRun.getTime()) ? `, next run: ${nextRun.toISOString()}` : '';
  logger.info(`[Scheduler] Scheduled ${job.jobName} with cron: ${job.cronExpression}${nextRunStr}`);
}

export async function executeJob(job: ScheduledJob): Promise<void> {
  const db = await getDb();
  const handler = jobHandlers.get(job.jobName);

  if (!handler) {
    logger.warn(`[Scheduler] No handler registered for job: ${job.jobName}`);
    return;
  }

  const startedAt = new Date();
  let status: JobStatus = 'success';
  let error: string | null = null;
  let recordsProcessed = 0;
  let summary: Record<string, unknown> = {};

  try {
    logger.info(`[Scheduler] Executing job: ${job.jobName}`);

    const result = await handler({
      jobId: job.id,
      jobName: job.jobName,
      jobType: job.jobType,
      config: job.jobConfig || {},
      startedAt,
    });

    recordsProcessed = result.recordsProcessed;
    summary = result.summary;

    logger.info(`[Scheduler] Job ${job.jobName} completed: ${recordsProcessed} records processed`);
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
    logger.error(`[Scheduler] Job ${job.jobName} failed:`, error);
  }

  const completedAt = new Date();

  if (db) {
    const sqliteDb = db as any;
    const [currentJob] = await sqliteDb
      .select()
      .from(maintenanceJobs)
      .where(eq(maintenanceJobs.id, job.id));

    await sqliteDb
      .update(maintenanceJobs)
      .set({
        lastRunAt: startedAt,
        lastRunStatus: status,
        lastRunError: error,
        lastRunDuration: completedAt.getTime() - startedAt.getTime(),
        totalRuns: (currentJob?.totalRuns ?? 0) + 1,
        successCount: status === 'success' ? (currentJob?.successCount ?? 0) + 1 : currentJob?.successCount,
        failureCount: status === 'failed' ? (currentJob?.failureCount ?? 0) + 1 : currentJob?.failureCount,
        nextRunAt: job.cronExpression ? getNextRunTime(job.cronExpression) : null,
      })
      .where(eq(maintenanceJobs.id, job.id));

    await sqliteDb.insert(maintenanceJobHistory).values({
      jobId: job.id,
      startedAt,
      completedAt,
      duration: completedAt.getTime() - startedAt.getTime(),
      status,
      error,
      recordsProcessed,
      resultSummary: summary,
    });
  }
}

/**
 * Parse a cron field that may contain wildcards, steps, or ranges.
 * Returns a numeric value or NaN if the field is dynamic and can't be reduced to a single number.
 */
function parseCronField(field: string): number {
  // Handle step expressions like */6 -> use the step value
  if (field.includes('/')) {
    return parseInt(field.split('/')[1]);
  }
  return parseInt(field);
}

function getNextRunTime(cronExpression: string): Date | null {
  try {
    const now = new Date();
    const parts = cronExpression.split(' ');
    if (parts.length < 5) return null;

    const minute = parseCronField(parts[0]);
    const hour = parseCronField(parts[1]);

    // Validate that key fields are numbers
    if (isNaN(minute) || isNaN(hour)) return null;

    // Daily jobs: MM HH * * *
    if (parts[2] === '*' && parts[3] === '*' && parts[4] === '*' && parts[1] !== '*') {
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }

    // Hourly jobs: MM * * * *
    if (parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      const next = new Date(now);
      next.setMinutes(minute, 0, 0);
      if (next <= now) next.setHours(next.getHours() + 1);
      return next;
    }

    // Multi-hour jobs: MM */N * * * or similar with step hours
    if (parts[1].includes('/') && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
      const stepHours = parseInt(parts[1].split('/')[1]) || 6;
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      // Advance to next step boundary
      while (next <= now) {
        next.setHours(next.getHours() + stepHours);
      }
      return next;
    }

    // Weekly jobs: MM HH * * D
    if (parts[4] !== '*') {
      const dayOfWeek = parseInt(parts[4]);
      if (isNaN(dayOfWeek)) return null;
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      const daysUntil = (dayOfWeek - next.getDay() + 7) % 7;
      next.setDate(next.getDate() + (daysUntil === 0 && next > now ? 7 : daysUntil));
      return next;
    }

    // Monthly jobs: MM HH D * *
    if (parts[2] !== '*' && parts[3] === '*' && parts[4] === '*') {
      const dayOfMonth = parseInt(parts[2]);
      if (isNaN(dayOfMonth)) return null;
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);
      next.setDate(dayOfMonth);
      if (next <= now) next.setMonth(next.getMonth() + 1);
      return next;
    }

    return null;
  } catch {
    return null;
  }
}

export async function getScheduledJobs(): Promise<ScheduledJob[]> {
  const db = await getDb();
  if (!db) return [];

  const sqliteDb = db as any;
  const jobs = await sqliteDb.select().from(maintenanceJobs);
  return jobs.map((job: typeof maintenanceJobs.$inferSelect) => ({
    id: job.id,
    jobName: job.jobName,
    jobType: job.jobType as JobType,
    cronExpression: job.cronExpression || '',
    enabled: job.enabled ?? true,
    lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null,
    nextRunAt: job.nextRunAt ? new Date(job.nextRunAt) : null,
    jobConfig: (job.jobConfig as Record<string, unknown>) || {},
  }));
}

export async function getOverdueJobs(): Promise<ScheduledJob[]> {
  const db = await getDb();
  if (!db) return [];

  const now = new Date();
  const sqliteDb = db as any;
  const jobs = await sqliteDb.select().from(maintenanceJobs);

  return jobs
    .filter((job: typeof maintenanceJobs.$inferSelect) => {
      if (!job.enabled) return false;
      if (!job.nextRunAt) return true;
      return new Date(job.nextRunAt) < now;
    })
    .map((job: typeof maintenanceJobs.$inferSelect) => ({
      id: job.id,
      jobName: job.jobName,
      jobType: job.jobType as JobType,
      cronExpression: job.cronExpression || '',
      enabled: job.enabled ?? true,
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null,
      nextRunAt: job.nextRunAt ? new Date(job.nextRunAt) : null,
      jobConfig: (job.jobConfig as Record<string, unknown>) || {},
    }));
}

export function stopAllJobs(): void {
  for (const [name, task] of activeTasks) {
    task.stop();
    logger.info(`[Scheduler] Stopped job: ${name}`);
  }
  activeTasks.clear();
}
