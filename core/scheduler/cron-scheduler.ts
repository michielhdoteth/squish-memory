/** Cron Scheduler - Persistent cron-based job scheduling with fallback support */

import cron from 'node-cron';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import { getDb } from '../../db/index.js';
import { maintenanceJobs, maintenanceJobHistory } from '../../db/drizzle/schema-sqlite.js';
import { eq } from 'drizzle-orm';
import { getAllJobHandlers } from './handlers/index.js';

// Re-export types for external consumers
export type { JobType, JobStatus, JobHandler, ScheduledJob, JobExecutionContext } from './types.js';
import type { JobType, JobStatus, JobHandler, ScheduledJob, JobExecutionContext } from './types.js';

const jobHandlers = new Map<string, JobHandler>();
const activeTasks = new Map<string, any>(); // node-cron ScheduledTask type
let shuttingDown = false;
const inFlightJobs = new Map<string, Promise<void>>();
const runningJobs = new Set<string>(); // Per-job lock to prevent concurrent execution

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

// Register all job handlers from extracted modules
for (const [name, handler] of getAllJobHandlers()) {
  registerJobHandler(name, handler);
}

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
      if (lastRun === 0) continue; // Never run yet -- not missed, let cron schedule it normally

      const elapsed = now - lastRun;
      const gracePeriod = intervalMs * 1.5; // 1.5x interval grace

      if (elapsed > gracePeriod) {
        logger.info(`[Scheduler] Catch-up needed for ${job.jobName}, elapsed ${Math.round(elapsed / (60 * 60 * 1000))}h (grace: ${Math.round(gracePeriod / (60 * 60 * 1000))}h)`);
        
        // Random jitter (0-30s) to prevent multiple instances from firing simultaneously
        const jitterMs = Math.floor(Math.random() * 30000);
        if (jitterMs > 0) {
          logger.debug(`[Scheduler] Catch-up jitter for ${job.jobName}: ${jitterMs}ms`);
          await new Promise(resolve => setTimeout(resolve, jitterMs));
        }

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
    // === UNIFIED MAINTENANCE ===
    // Nightly: decay → score → tiers → dedup → prune-links → stale (dry-run)
    {
      jobName: 'auto_maintenance',
      jobType: 'nightly' as JobType,
      cronExpression: '0 3 * * *', // Nightly at 3 AM
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: false,
        steps: ['decay', 'score', 'tiers', 'dedup', 'prune-links', 'stale'],
        age: 30,
      },
    },
    // Weekly: full lifecycle + consolidation + inbox
    {
      jobName: 'weekly_consolidation',
      jobType: 'weekly' as JobType,
      cronExpression: '0 4 * * 0', // Weekly at 4 AM Sunday
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: false,
        steps: ['decay', 'score', 'tiers', 'dedup', 'prune-links', 'stale', 'consolidate', 'inbox'],
        age: 60,
      },
    },
    // Monthly: full lifecycle + LLM cross-connections
    {
      jobName: 'deep_maintenance',
      jobType: 'weekly' as JobType,
      cronExpression: '0 5 1 * *', // Monthly on 1st at 5 AM
      enabled: true,
      jobConfig: {
        enabled: true,
        dryRun: false,
        steps: ['decay', 'score', 'tiers', 'dedup', 'prune-links', 'stale', 'consolidate', 'inbox'],
        age: 90,
      },
    },

    // === SPECIALIZED JOBS (not covered by unified pipeline) ===
    // Self-iteration: extract facts from ended conversations
    {
      jobName: 'self_iteration',
      jobType: 'hourly' as JobType,
      cronExpression: '30 * * * *', // Every hour at :30
      enabled: true,
      jobConfig: { minMessageCount: 5, maxMessagesToProcess: 50 },
    },
    // Knowledge decay: belief/strategy confidence decay (different table from memories)
    {
      jobName: 'belief_decay',
      jobType: 'daily' as JobType,
      cronExpression: '0 4 * * *', // Daily at 4 AM
      enabled: true,
      jobConfig: { applyBeliefDecay: true },
    },
    // Temporal cleanup: expire memories past valid_to
    {
      jobName: 'temporal_cleanup',
      jobType: 'daily' as JobType,
      cronExpression: '15 4 * * *', // Daily at 4:15 AM
      enabled: true,
      jobConfig: {},
    },
    // Proposal expiry: expire stale edit proposals
    {
      jobName: 'proposal_expiry',
      jobType: 'daily' as JobType,
      cronExpression: '45 4 * * *', // Daily at 4:45 AM
      enabled: true,
      jobConfig: { enabled: true, days: 14 },
    },
    // Dedup maintenance: detect + auto-merge high-confidence duplicates
    {
      jobName: 'dedup_maintenance',
      jobType: 'nightly' as JobType,
      cronExpression: '45 3 * * *', // Nightly at 3:45 AM (after auto_maintenance)
      enabled: true,
      jobConfig: { enabled: true, threshold: 0.95, cap: 25 },
    },
    // LLM consolidation: creative cross-connection finding
    {
      jobName: 'llm_consolidation',
      jobType: 'daily' as JobType,
      cronExpression: '30 3 * * *', // Daily at 3:30 AM
      enabled: true,
      jobConfig: { enabled: true, maxMemories: 50, batchSize: 20 },
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

interface JobResult {
  status: JobStatus;
  error: string | null;
  recordsProcessed: number;
  summary: Record<string, unknown>;
}

/**
 * Core job execution body, separated for in-flight tracking.
 */
async function executeJobBody(
  handler: JobHandler,
  job: ScheduledJob,
  startedAt: Date,
  db: any
): Promise<JobResult> {
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

  return { status, error, recordsProcessed, summary };
}

export async function executeJob(job: ScheduledJob): Promise<void> {
  // Reject new jobs once shutdown is requested
  if (shuttingDown) {
    logger.info(`[Scheduler] Skipping job ${job.jobName} -- shutting down`);
    return;
  }

  // Per-job lock: skip if this job is already in-flight
  if (runningJobs.has(job.jobName)) {
    logger.debug(`[Scheduler] Skipping ${job.jobName} -- already in progress`);
    return;
  }

  const db = await getDb();
  const handler = jobHandlers.get(job.jobName);

  if (!handler) {
    logger.warn(`[Scheduler] No handler registered for job: ${job.jobName}`);
    return;
  }

  runningJobs.add(job.jobName);

  const startedAt = new Date();
  let status: JobStatus = 'success';
  let error: string | null = null;
  let recordsProcessed = 0;
  let summary: Record<string, unknown> = {};

  // Track in-flight job for shutdown grace period
  const jobKey = job.jobName;
  const jobPromise = executeJobBody(handler, job, startedAt, db)
    .then(result => {
      status = result.status;
      error = result.error;
      recordsProcessed = result.recordsProcessed;
      summary = result.summary;
    })
    .finally(() => {
      runningJobs.delete(job.jobName);
      inFlightJobs.delete(jobKey);
    });

  inFlightJobs.set(jobKey, jobPromise);
  await jobPromise;
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

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Graceful shutdown: stops the cron trigger, rejects new jobs, and waits
 * for all in-flight jobs to finish (with a 30-second timeout).
 *
 * @returns true if all jobs completed, false if the timeout was reached.
 */
export async function shutdown(): Promise<boolean> {
  logger.info('[Scheduler] Shutdown initiated');
  shuttingDown = true;

  // 1. Stop all cron triggers so no new jobs fire
  stopAllJobs();

  // 2. Wait for in-flight jobs with a hard timeout
  const pending = Array.from(inFlightJobs.values());
  if (pending.length === 0) {
    logger.info('[Scheduler] No in-flight jobs -- shutdown complete');
    return true;
  }

  logger.info(`[Scheduler] Waiting for ${pending.length} in-flight job(s)...`);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Shutdown timeout exceeded')), SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([Promise.allSettled(pending), timeoutPromise]);
    logger.info('[Scheduler] All in-flight jobs completed');
    return true;
  } catch {
    logger.warn(`[Scheduler] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms -- proceeding anyway`);
    return false;
  }
}
