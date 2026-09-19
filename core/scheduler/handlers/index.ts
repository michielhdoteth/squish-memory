/** Barrel export for all cron job handler modules */

import type { JobHandler } from '../types.js';
import { getMemoryHandlers } from './memory.js';
import { getMaintenanceHandlers } from './maintenance.js';
import { getConsolidationHandlers } from './consolidation.js';
import { getInboxHandlers } from './inbox.js';

/**
 * Returns all registered job handlers aggregated from every handler module.
 * Each module contributes a name-to-handler mapping; this function merges
 * them into a single map keyed by job name.
 */
export function getAllJobHandlers(): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>();

  const sources = [
    getMemoryHandlers(),
    getMaintenanceHandlers(),
    getConsolidationHandlers(),
    getInboxHandlers(),
  ];

  for (const source of sources) {
    for (const [name, handler] of Object.entries(source)) {
      handlers.set(name, handler);
    }
  }

  return handlers;
}
