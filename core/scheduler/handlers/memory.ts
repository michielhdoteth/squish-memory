/** Memory-related job handlers: self_iteration, decay, belief_decay */

import type { JobHandler, JobExecutionContext } from '../types.js';
import { selfIterationHandler } from '../../session/self-iteration-job.js';
import { updateAllDecayScores } from '../../decay/decay-engine.js';

// Self-iteration handler - re-exported directly from the session module
const selfIterationRegistered = selfIterationHandler;

// Decay job handler - uses Ebbinghaus power-law decay engine
// Replaces sector-based decay with Ebbinghaus forgetting curve
const decayHandler: JobHandler = async (context: JobExecutionContext) => {
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

// Knowledge belief decay handler - applies confidence decay to beliefs via unified knowledge table
const beliefDecayHandler: JobHandler = async (context: JobExecutionContext) => {
  const { runDecayCycle } = await import('../../knowledge/decay.js');
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

export function getMemoryHandlers(): Record<string, JobHandler> {
  return {
    self_iteration: selfIterationRegistered,
    decay_maintenance: decayHandler,
    belief_decay: beliefDecayHandler,
  };
}
