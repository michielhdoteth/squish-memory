/** Consolidation job handlers: proposal_expiry, weekly_consolidation, deep_maintenance, llm_consolidation */

import type { JobHandler, JobExecutionContext } from '../types.js';

// Expire pending edit proposals left unreviewed past their TTL so staged
// diffs don't linger forever against drifting content.
const proposalExpiryHandler: JobHandler = async (context: JobExecutionContext) => {
  const { expireStaleEditProposals } = await import('../../memory/edit-workflow.js');
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

// Phase 6: Weekly consolidation handler - runs consolidate + inbox
const weeklyConsolidationHandler: JobHandler = async (context: JobExecutionContext) => {
  const { runFullMaintenance } = await import('../../consolidation.js');
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

// Phase 6: Deep maintenance handler - runs full maintenance with LLM
const deepMaintenanceHandler: JobHandler = async (context: JobExecutionContext) => {
  const { config: squishConfig } = await import('../../../config.js');
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

  const { runFullMaintenance } = await import('../../consolidation.js');
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

// LLM Consolidation handler - finds creative cross-connections using LLM
const llmConsolidationHandler: JobHandler = async (context: JobExecutionContext) => {
  const { runLLMConsolidation } = await import('../../consolidation/llm-consolidator.js');
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

export function getConsolidationHandlers(): Record<string, JobHandler> {
  return {
    proposal_expiry: proposalExpiryHandler,
    weekly_consolidation: weeklyConsolidationHandler,
    deep_maintenance: deepMaintenanceHandler,
    llm_consolidation: llmConsolidationHandler,
  };
}
