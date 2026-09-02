/**
 * Background Worker
 * Handles association pruning and summary cleanup on a timer.
 *
 * Decay, consolidation, dedup, and other maintenance tasks are handled by
 * the cron scheduler (core/scheduler/cron-scheduler.ts) as the single
 * source of truth for scheduling. This worker only covers pruning, which
 * has no dedicated cron job.
 */

import { config } from '../config.js';
import { pruneWeakAssociations, getAssociationStats } from './associations.js';
import { pruneOldSummaries } from './summarization.js';
import { logger } from './logger.js';

interface WorkerConfig {
  pruningInterval: number;
  associationPruningThreshold: number;
  summaryPruningAge: number;
}

const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  pruningInterval: 7 * 24 * 60 * 60 * 1000,
  associationPruningThreshold: 5,
  summaryPruningAge: 30,
};

class SquishWorker {
  private pruningTimer?: NodeJS.Timeout;
  private config: WorkerConfig;
  private isRunning: boolean = false;
  private stats = {
    pruningRuns: 0,
    lastAssociation: null as any,
  };

  constructor(customConfig: Partial<WorkerConfig> = {}) {
    this.config = { ...DEFAULT_WORKER_CONFIG, ...customConfig };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Worker already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting background worker (pruning only)');

    this.schedulePruning();

    logger.info('Background worker started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.pruningTimer) clearInterval(this.pruningTimer);

    logger.info('Background worker stopped');
  }

  private schedulePruning(): void {
    this.runPruning().catch((err) => {
      logger.error('Initial pruning failed:', err);
    });

    this.pruningTimer = setInterval(() => {
      this.runPruning().catch((err) => {
        logger.error('Scheduled pruning failed:', err);
      });
    }, this.config.pruningInterval);
  }

  private async runPruning(): Promise<void> {
    try {
      this.stats.pruningRuns++;

      const prunedAssociations = await pruneWeakAssociations(
        this.config.associationPruningThreshold
      );

      const assocStats = await getAssociationStats();
      this.stats.lastAssociation = {
        timestamp: new Date().toISOString(),
        pruned: prunedAssociations,
        ...assocStats,
      };

      const prunedSummaries = await pruneOldSummaries(this.config.summaryPruningAge);

      logger.info('Pruning completed', {
        associationsPruned: prunedAssociations,
        summariesPruned: prunedSummaries,
      });
    } catch (error) {
      logger.error('Pruning error:', error);
    }
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      stats: this.stats,
      config: this.config,
    };
  }

  async forcePruning(): Promise<any> {
    return await this.runPruning();
  }
}

let globalWorker: SquishWorker | null = null;

export function getWorker(customConfig?: Partial<WorkerConfig>): SquishWorker {
  if (!globalWorker) {
    globalWorker = new SquishWorker(customConfig);
  }
  return globalWorker;
}

export async function startWorker(): Promise<void> {
  const worker = getWorker();
  await worker.start();
}

export async function stopWorker(): Promise<void> {
  if (globalWorker) {
    await globalWorker.stop();
  }
}

export function getWorkerStats() {
  if (!globalWorker) {
    return null;
  }
  return globalWorker.getStats();
}

export async function forcePruning(): Promise<any> {
  const worker = getWorker();
  return await worker.forcePruning();
}

export type { WorkerConfig };
export { SquishWorker };
