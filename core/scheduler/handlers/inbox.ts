/** Inbox-related job handlers: inbox_triage */

import type { JobHandler, JobExecutionContext } from '../types.js';

// Inbox triage handler - processes inbox memories and moves them to appropriate places
const inboxTriageHandler: JobHandler = async (context: JobExecutionContext) => {
  const { processInboxForAllProjects } = await import('../../places/memory-places.js');
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

export function getInboxHandlers(): Record<string, JobHandler> {
  return {
    inbox_triage: inboxTriageHandler,
  };
}
