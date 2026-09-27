import type { JobExecutionContext, JobHandler } from '../types.js';
import { processMemoryAnalysisJobs } from '../../memory/fact-extraction-worker.js';

export function getFactExtractionHandlers(): Record<string, JobHandler> {
  const handler: JobHandler = async (_context: JobExecutionContext) => {
    const result = await processMemoryAnalysisJobs({ limit: 10 });
    return { recordsProcessed: result.projected, summary: result };
  };
  return { memory_fact_extraction: handler };
}
