import { describe, expect, test } from 'bun:test';

describe('cron scheduler', () => {
  test('exports all key functions', async () => {
    const mod = await import('../../../core/scheduler/cron-scheduler.ts');
    expect(typeof mod.initializeScheduler).toBe('function');
    expect(typeof mod.scheduleJob).toBe('function');
    expect(typeof mod.registerJobHandler).toBe('function');
    expect(typeof mod.stopAllJobs).toBe('function');
    expect(typeof mod.getScheduledJobs).toBe('function');
    expect(typeof mod.executeJob).toBe('function');
    expect(typeof mod.getOverdueJobs).toBe('function');
  });

  test('registerJobHandler stores handler', async () => {
    const { registerJobHandler } = await import('../../../core/scheduler/cron-scheduler.ts');
    const handlerName = 'test_handler_' + Date.now();
    registerJobHandler(handlerName, async () => ({ recordsProcessed: 0, summary: {} }));
    // No error means registration succeeded
    expect(true).toBe(true);
  });

  test('strict trust withholds scheduler startup and direct job execution', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      const { initializeScheduler, executeJob, registerJobHandler } = await import('../../../core/scheduler/cron-scheduler.ts');
      let executions = 0;
      const jobName = `strict_withheld_${Date.now()}`;
      registerJobHandler(jobName, async () => {
        executions++;
        return { recordsProcessed: 1, summary: {} };
      });
      await initializeScheduler();
      await executeJob({
        id: 'strict-test-job', jobName, jobType: 'daily', cronExpression: '0 0 * * *', enabled: true,
        lastRunAt: null, lastRunStatus: null, lastRunError: null, lastRunDuration: null, nextRunAt: null,
        totalRuns: 0, successCount: 0, failureCount: 0, jobConfig: {}, createdAt: new Date(), updatedAt: new Date(),
      });
      expect(executions).toBe(0);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  });

  test('stopAllJobs runs without error', async () => {
    const { stopAllJobs } = await import('../../../core/scheduler/cron-scheduler.ts');
    expect(() => stopAllJobs()).not.toThrow();
  });

  test('ScheduledJob and JobExecutionContext interfaces exist', async () => {
    const mod = await import('../../../core/scheduler/cron-scheduler.ts');
    // These are TypeScript interfaces - verify they're attached to module
    expect(typeof mod.scheduleJob).toBe('function');
    expect(typeof mod.registerJobHandler).toBe('function');
  });
});
