/**
 * Stale Report Command - Read-only staleness report for memories
 *
 * Usage:
 *   squish stale-report [--project-id <id>] [--older-than-days <days>] [--min-importance <0-1>] [--limit <number>] [--json]
 */

import { Command } from 'commander';
import { getClient } from '../client.js';
import { getRemediationForError } from '../errors.js';

export function registerStaleReportCommand(program: Command) {
  program
    .command('stale-report')
    .description('Generate a read-only staleness report for memories')
    .option('--project-id <id>', 'Project ID filter')
    .option('--older-than-days <days>', 'Minimum age in days to include', '30')
    .option('--min-importance <value>', 'Minimum importance threshold (0-1)', '0')
    .option('--limit <number>', 'Max items returned', '200')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }

      try {
        const client = getClient();
        const report = await client.stalenessReport({
          projectId: options.projectId,
          olderThanDays: Number(options.olderThanDays),
          minImportance: Number(options.minImportance),
          limit: Number(options.limit),
        });

        if (options.json) {
          console.log(JSON.stringify(report));
        } else {
          console.log(JSON.stringify(report, null, 2));
        }
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation: getRemediationForError(error) }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${getRemediationForError(error)}`);
        }
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });
}
