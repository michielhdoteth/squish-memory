/** Shared types for the cron scheduler and job handlers */

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
